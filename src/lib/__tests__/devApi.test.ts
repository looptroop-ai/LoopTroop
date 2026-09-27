import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('devApi', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('keeps default API URLs on the frontend origin', async () => {
    const { getApiUrl } = await import('../devApi')

    expect(getApiUrl('/api/stream')).toBe(`${window.location.origin}/api/stream`)
    expect(getApiUrl('/api/stream', { directInDevelopment: true })).toBe(`${window.location.origin}/api/stream`)
  })

  it('builds direct backend readiness probe URLs for development', async () => {
    const { __devApiForTests } = await import('../devApi')

    expect(__devApiForTests.getDevReadyProbeUrl('/api/health')).toBe(`${__LOOPTROOP_DEV_BACKEND_ORIGIN__}/api/health`)
  })

  it('uses the direct backend origin only for opted-in development URLs', async () => {
    vi.stubEnv('MODE', 'development')
    const { getApiUrl } = await import('../devApi')

    expect(getApiUrl('/api/stream')).toBe(`${window.location.origin}/api/stream`)
    expect(getApiUrl('/api/stream', { directInDevelopment: true })).toBe(`${__LOOPTROOP_DEV_BACKEND_ORIGIN__}/api/stream`)
  })

  it('leaves API paths relative during server rendering', async () => {
    vi.stubGlobal('window', undefined)
    const { getApiUrl } = await import('../devApi')

    expect(getApiUrl('/api/stream')).toBe('/api/stream')
    expect(getApiUrl('/api/stream', { directInDevelopment: true })).toBe('/api/stream')
  })

  it('reports when the runtime has no native fetch implementation', async () => {
    vi.stubGlobal('window', { fetch: undefined })
    vi.stubGlobal('fetch', undefined)

    await expect(import('../devApi')).rejects.toThrow('Global fetch is not available')
  })

  it('treats a rate-limited health response as proof that the backend is reachable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Too many requests.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const { pingDevBackend } = await import('../devApi')

    await expect(pingDevBackend()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ cache: 'no-store' }))
  })

  it('treats health request failures as an unavailable backend', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    const { pingDevBackend } = await import('../devApi')

    await expect(pingDevBackend()).resolves.toBe(false)
  })

  it('waits for development readiness only for same-origin API fetches', async () => {
    vi.stubEnv('MODE', 'development')
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { installDevApiGuard } = await import('../devApi')

    installDevApiGuard()
    const guardedFetch = window.fetch
    installDevApiGuard()
    expect(window.fetch).toBe(guardedFetch)

    await window.fetch('/api')
    await window.fetch(new URL('/api/items', window.location.origin))
    await window.fetch(new Request(`${window.location.origin}/api/request`))
    await window.fetch('/apiary')
    await window.fetch('https://external.example/api/items')
    await window.fetch({} as RequestInfo)

    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/health')).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledWith('/api', undefined)
    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({ url: `${window.location.origin}/api/request` }), undefined)
    expect(fetchMock).toHaveBeenCalledWith('https://external.example/api/items', undefined)
    expect(fetchMock).toHaveBeenCalledWith({}, undefined)
  })

  it('surfaces a caller abort while the shared readiness check completes', async () => {
    vi.stubEnv('MODE', 'development')
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { waitForDevBackend } = await import('../devApi')
    const controller = new AbortController()
    const reason = new Error('caller stopped waiting')
    const waiting = waitForDevBackend(controller.signal)

    controller.abort(reason)

    await expect(waiting).rejects.toBe(reason)
    await expect(waitForDevBackend()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ cache: 'no-store' }))
  })

  it('uses an abort error fallback when an abort signal has no Error reason or DOMException', async () => {
    vi.stubEnv('MODE', 'development')
    vi.stubGlobal('DOMException', undefined)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    const { waitForDevBackend } = await import('../devApi')
    const alreadyAborted = new AbortController()
    alreadyAborted.abort('caller stopped')

    await expect(waitForDevBackend(alreadyAborted.signal)).rejects.toMatchObject({
      message: 'The operation was aborted.',
    })

    const controller = new AbortController()
    const waiting = waitForDevBackend(controller.signal)
    const rejected = expect(waiting).rejects.toMatchObject({ message: 'The operation was aborted.' })
    controller.abort('caller stopped')
    await rejected
    await expect(waitForDevBackend()).resolves.toBeUndefined()
  })

  it('rejects readiness after the development polling window expires', async () => {
    vi.stubEnv('MODE', 'development')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const { waitForDevBackend } = await import('../devApi')
    const waiting = waitForDevBackend()
    const rejected = expect(waiting).rejects.toThrow('LoopTroop backend did not become ready within 30s')

    await vi.advanceTimersByTimeAsync(30_000)

    await rejected
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ cache: 'no-store' }))
  })
})
