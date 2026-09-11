import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchInstallerUrl } from '../scripts/installer-core.mjs'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('installer request transport', () => {
  it.each(['http://example.com/file', 'http://127.0.0.1/file', 'file:///tmp/archive', 'ftp://example.com/file'])('refuses %s before requesting it', async (url) => {
    vi.stubEnv('LOOPTROOP_INSTALL_API', '')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(fetchInstallerUrl(url)).rejects.toThrow('require HTTPS')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([301, 302, 303, 307, 308])('refuses a %s HTTPS downgrade before fetching it and cancels the redirect body', async (status) => {
    vi.stubEnv('LOOPTROOP_INSTALL_API', 'http://127.0.0.1:8123')
    const response = new Response('redirect', { status, headers: { location: 'http://127.0.0.1:8123/file' } })
    const fetch = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetch)
    await expect(fetchInstallerUrl('https://example.com/file')).rejects.toThrow('require HTTPS')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(response.bodyUsed).toBe(true)
  })

  it.each(['localhost', '127.0.0.1', '[::1]'])('allows same-origin HTTP fixture assets for %s', async (hostname) => {
    const origin = `http://${hostname}:8123`
    vi.stubEnv('LOOPTROOP_INSTALL_API', `${origin}/api`)
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/asset' } }))
      .mockResolvedValueOnce(new Response('asset'))
    vi.stubGlobal('fetch', fetch)
    expect(await (await fetchInstallerUrl(`${origin}/metadata`)).text()).toBe('asset')
    expect(String(fetch.mock.calls[1]?.[0])).toBe(`${origin}/asset`)
  })

  it.each(['http://127.0.0.1:8124/asset', 'http://localhost:8123/asset', 'http://example.com/asset'])('refuses fixture redirects outside their origin: %s', async (location) => {
    vi.stubEnv('LOOPTROOP_INSTALL_API', 'http://127.0.0.1:8123')
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchInstallerUrl('http://127.0.0.1:8123/metadata')).rejects.toThrow('require HTTPS')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not allow a non-loopback API override to enable HTTP', async () => {
    vi.stubEnv('LOOPTROOP_INSTALL_API', 'http://example.com')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(fetchInstallerUrl('http://example.com/metadata')).rejects.toThrow('require HTTPS')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves the stall signal and same-origin authorization, removing authorization when the origin changes', async () => {
    const signal = new AbortController().signal
    const authorizations: (string | null)[] = []
    const locations = ['/same-origin', 'https://cdn.example.com/asset', 'https://example.com/back']
    const fetch = vi.fn(async (_url: URL, options: RequestInit) => {
      expect(options.signal).toBe(signal)
      expect(options.redirect).toBe('manual')
      authorizations.push(new Headers(options.headers).get('authorization'))
      const location = locations.shift()
      return location ? new Response(null, { status: 302, headers: { location } }) : new Response('asset')
    })
    vi.stubGlobal('fetch', fetch)
    const headers = { authorization: 'Bearer secret' }
    expect(await (await fetchInstallerUrl('https://example.com/metadata', { headers, signal })).text()).toBe('asset')
    expect(authorizations).toEqual(['Bearer secret', 'Bearer secret', null, null])
    expect(headers.authorization).toBe('Bearer secret')
  })

  it('stops redirect loops after 20 hops and cancels every intermediate body', async () => {
    const responses: Response[] = []
    const fetch = vi.fn(async () => {
      const response = new Response('redirect', { status: 302, headers: { location: '/loop' } })
      responses.push(response)
      return response
    })
    vi.stubGlobal('fetch', fetch)
    await expect(fetchInstallerUrl('https://example.com/loop')).rejects.toThrow('exceeded 20 redirects')
    expect(fetch).toHaveBeenCalledTimes(21)
    expect(responses.every((response) => response.bodyUsed)).toBe(true)
  })
})
