import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getOpenCodeConnection,
  invalidateOpenCodeConnection,
  OpenCodeConnectionError,
  probeOpenCodeConnection,
} from '../connection'

const BASE_URL = 'http://127.0.0.1:4096'
const envKeys = ['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME'] as const
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  invalidateOpenCodeConnection()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('getOpenCodeConnection', () => {
  it('validates and caches a v2 server using its fixed Basic-auth username', async () => {
    vi.stubEnv('OPENCODE_PASSWORD', 'v2-secret')
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'v1-secret')
    vi.stubEnv('OPENCODE_SERVER_USERNAME', 'custom-v1-user')
    const fetchMock = vi.fn(async () => json({ version: '2.0.15', pid: 812 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getOpenCodeConnection(BASE_URL)).resolves.toEqual({
      protocol: 'v2',
      version: '2.0.15',
      headers: { Authorization: `Basic ${Buffer.from('opencode:v2-secret').toString('base64')}` },
    })
    await getOpenCodeConnection(BASE_URL)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/api/info`, expect.objectContaining({
      redirect: 'manual',
      headers: { Authorization: `Basic ${Buffer.from('opencode:v2-secret').toString('base64')}` },
    }))
  })

  it('verifies v1 with its custom username and legacy password after the v2 auth attempt', async () => {
    vi.stubEnv('OPENCODE_PASSWORD', 'new-v2-password')
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'legacy-v1-password')
    vi.stubEnv('OPENCODE_SERVER_USERNAME', 'custom-v1-user')
    const calls: Array<{ url: string; authorization?: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
      })
      if (String(input).endsWith('/api/info')) return new Response('', { status: 401 })
      return json({ healthy: true, version: '1.18.18' })
    }))

    await expect(getOpenCodeConnection(BASE_URL)).resolves.toEqual({
      protocol: 'v1',
      version: '1.18.18',
      headers: { Authorization: `Basic ${Buffer.from('custom-v1-user:legacy-v1-password').toString('base64')}` },
    })
    expect(calls).toEqual([
      { url: `${BASE_URL}/api/info`, authorization: `Basic ${Buffer.from('opencode:new-v2-password').toString('base64')}` },
      { url: `${BASE_URL}/global/health`, authorization: `Basic ${Buffer.from('custom-v1-user:legacy-v1-password').toString('base64')}` },
    ])
  })

  it('does not treat an unauthorized server as an absent protocol', async () => {
    vi.stubEnv('OPENCODE_PASSWORD', 'bad-secret')
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getOpenCodeConnection(BASE_URL)).rejects.toMatchObject<Partial<OpenCodeConnectionError>>({
      failureKind: 'authentication',
      status: 401,
      canStartManagedServer: false,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects redirects and unrecognized successful responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 302, headers: { location: '/elsewhere' } })))
    await expect(getOpenCodeConnection(BASE_URL)).rejects.toMatchObject({ failureKind: 'unsupported_protocol', status: 302 })

    invalidateOpenCodeConnection()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>up</html>', { status: 200, headers: { 'content-type': 'text/html' } })))
    await expect(getOpenCodeConnection(BASE_URL)).rejects.toMatchObject({ failureKind: 'unsupported_protocol', status: 200 })
  })

  it('accepts v1 only after verifying global health when /api/info serves its HTML UI', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/api/info')
      ? new Response('<html>OpenCode</html>', { headers: { 'content-type': 'text/html' } })
      : json({ healthy: true, version: '1.18.18' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getOpenCodeConnection(BASE_URL)).resolves.toMatchObject({
      protocol: 'v1',
      version: '1.18.18',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('invalidates cached protocol selection explicitly', async () => {
    const fetchMock = vi.fn(async () => json({ version: '2.0.15', pid: 812 }))
    vi.stubGlobal('fetch', fetchMock)

    await getOpenCodeConnection(BASE_URL)
    invalidateOpenCodeConnection(BASE_URL)
    await getOpenCodeConnection(BASE_URL)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keys cached protocol selection by the exact v2 password bytes', async () => {
    vi.stubEnv('OPENCODE_PASSWORD', 'secret')
    const authHeaders: HeadersInit[] = []
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      authHeaders.push(init?.headers ?? {})
      return json({ version: '2.0.15', pid: 812 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await getOpenCodeConnection(BASE_URL)
    vi.stubEnv('OPENCODE_PASSWORD', 'secret ')
    await getOpenCodeConnection(BASE_URL)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new Headers(authHeaders[0]).get('authorization')).toBe(
      `Basic ${Buffer.from('opencode:secret').toString('base64')}`,
    )
    expect(new Headers(authHeaders[1]).get('authorization')).toBe(
      `Basic ${Buffer.from('opencode:secret ').toString('base64')}`,
    )
  })

  it('uses a live request for health probes instead of cached resolution', async () => {
    let available = true
    const fetchMock = vi.fn(async () => available
      ? json({ version: '2.0.15', pid: 812 })
      : json({ code: 'service_starting' }, 503))
    vi.stubGlobal('fetch', fetchMock)
    await getOpenCodeConnection(BASE_URL)

    available = false
    await expect(probeOpenCodeConnection(BASE_URL)).rejects.toMatchObject({
      failureKind: 'network',
      status: 503,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
