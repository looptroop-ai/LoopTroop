import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createHostGuardMiddleware, hostnameFromAuthority, requestAuthority } from '../hostGuard'

/**
 * 2.8 contract: binding to loopback does not make the daemon private to a
 * browser. A page anywhere on the internet can point a name it controls at
 * 127.0.0.1, and the browser will then treat this daemon as that site's own
 * origin — SameSite cookies and CORS both consider it same-site. The Host and
 * Origin headers are what still tell the truth about where a request came from.
 */
describe('host guard', () => {
  const originalAllowRemote = process.env.LOOPTROOP_ALLOW_REMOTE_API

  beforeEach(() => {
    delete process.env.LOOPTROOP_ALLOW_REMOTE_API
  })

  afterEach(() => {
    if (originalAllowRemote === undefined) {
      delete process.env.LOOPTROOP_ALLOW_REMOTE_API
    } else {
      process.env.LOOPTROOP_ALLOW_REMOTE_API = originalAllowRemote
    }
  })

  function makeApp(additionalOrigins?: string[]): Hono {
    const app = new Hono()
    app.use('/api/*', createHostGuardMiddleware(
      additionalOrigins === undefined ? {} : { additionalOrigins },
    ))
    app.get('/api/thing', (c) => c.json({ ok: true }))
    return app
  }

  async function request(headers: Record<string, string>, additionalOrigins?: string[]): Promise<Response> {
    return await makeApp(additionalOrigins).request('http://127.0.0.1:3000/api/thing', { headers })
  }

  it('accepts a request from a loopback host', async () => {
    for (const host of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000', '127.5.5.5']) {
      expect((await request({ Host: host })).status).toBe(200)
    }
  })

  it('rejects a hostname that was rebound to this machine', async () => {
    const response = await request({ Host: 'looptroop.attacker.example:3000' })

    expect(response.status).toBe(403)
    // The URL is loopback; only the Host header exposes the rebinding, which is
    // why it is checked rather than inferred from the connection.
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('loopback') })
  })

  it('rejects a request driven from another origin', async () => {
    const response = await request({ Host: '127.0.0.1:3000', Origin: 'https://attacker.example' })

    expect(response.status).toBe(403)
  })

  it('rejects an opaque origin, which is what a sandboxed frame sends', async () => {
    expect((await request({ Host: '127.0.0.1:3000', Origin: 'null' })).status).toBe(403)
  })

  /**
   * Cookies are not scoped by port, so a page on any other localhost port gets
   * this daemon's session cookie attached to whatever it asks for. Accepting
   * "some loopback origin" would leave every other local port — another dev
   * server, a local tool with an XSS, anything the user was talked into running
   * — able to drive this API. The port is what has to be pinned.
   */
  it('rejects another loopback port, which shares this daemon cookies', async () => {
    const response = await request({ Host: '127.0.0.1:3000', Origin: 'http://127.0.0.1:9999' })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('cross-origin') })
  })

  it('rejects a different loopback name on the same port', async () => {
    // A browser treats these as separate origins, so this daemon does too.
    expect((await request({ Host: '127.0.0.1:3000', Origin: 'http://localhost:3000' })).status).toBe(403)
  })

  it('accepts an origin that matches the authority the request arrived on', async () => {
    for (const [host, origin] of [
      ['127.0.0.1:3000', 'http://127.0.0.1:3000'],
      ['localhost:3000', 'http://localhost:3000'],
      ['[::1]:3000', 'http://[::1]:3000'],
      // No port on either side is port 80 on both.
      ['127.0.0.1', 'http://127.0.0.1'],
    ] as const) {
      expect((await request({ Host: host, Origin: origin })).status).toBe(200)
    }
  })

  it('accepts the dev server only when it is configured as an extra origin', async () => {
    const headers = { Host: 'localhost:3000', Origin: 'http://localhost:5173' }

    expect((await request(headers)).status).toBe(403)
    expect((await request(headers, ['http://localhost:5173'])).status).toBe(200)
  })

  it('never accepts a non-loopback extra origin', async () => {
    // Misconfiguration must not become a way in: the origin still has to be a
    // loopback name, whatever the allowlist says.
    const response = await request(
      { Host: '127.0.0.1:3000', Origin: 'https://attacker.example' },
      ['https://attacker.example'],
    )

    expect(response.status).toBe(403)
  })

  it('accepts a request with no Origin and no cookie, the shape every script sends', async () => {
    expect((await request({ Host: '127.0.0.1:3000' })).status).toBe(200)
  })

  it('accepts a token-bearing request with no Origin, however it names the token', async () => {
    // The CLI, the install smoke tests and the read-only verifier all look like
    // this. A caller holding the API token is not the browser and never needed
    // the browser's word for where it came from.
    const cookie = 'looptroop_session=whatever'

    expect((await request({
      Host: '127.0.0.1:3000',
      Cookie: cookie,
      Authorization: 'Bearer some-token',
    })).status).toBe(200)

    expect((await request({
      Host: '127.0.0.1:3000',
      Cookie: cookie,
      'X-LoopTroop-Token': 'some-token',
    })).status).toBe(200)
  })

  /**
   * The hole this rule exists for.
   *
   * Cookies carry no port scope, so a page on any other 127.0.0.1 port can make
   * the browser send this daemon's session cookie: `<img src>`, a no-cors fetch,
   * a `window.open`. None of those send an Origin header, so before this check
   * the request was indistinguishable from a same-origin GET and was served.
   */
  it('refuses the cookie on a no-Origin request that cannot prove same-origin', async () => {
    const response = await request({ Host: '127.0.0.1:3000', Cookie: 'looptroop_session=stolen' })

    expect(response.status).toBe(403)
    expect((await response.json() as { error: string }).error).toContain('same-origin')
  })

  it('refuses the cookie when the browser says the request came from another port', async () => {
    // What a cross-port loopback page actually produces: Sec-Fetch-Site counts
    // the port, so a sibling on 127.0.0.1:9999 gets `same-site`, not
    // `same-origin`. `cross-site` is the rebound-hostname case.
    for (const site of ['same-site', 'cross-site', 'none']) {
      const response = await request({
        Host: '127.0.0.1:3000',
        Cookie: 'looptroop_session=stolen',
        'Sec-Fetch-Site': site,
      })

      expect(response.status, `Sec-Fetch-Site: ${site}`).toBe(403)
    }
  })

  it('accepts the cookie when the browser vouches for the origin', async () => {
    // The real same-origin cases that send no Origin header: an <img> preview of
    // manual-QA evidence, an <a download>, a top-level navigation, EventSource.
    const response = await request({
      Host: '127.0.0.1:3000',
      Cookie: 'looptroop_session=ours',
      'Sec-Fetch-Site': 'same-origin',
    })

    expect(response.status).toBe(200)
  })

  it('still accepts the cookie from the dev server, which does send an Origin', async () => {
    // Vite runs on another port, so its requests are cross-origin and carry
    // Origin — the allowlist decides them, and the Sec-Fetch-Site rule never
    // sees them.
    const response = await request(
      { Host: '127.0.0.1:3000', Origin: 'http://localhost:5173', Cookie: 'looptroop_session=ours' },
      ['http://localhost:5173'],
    )

    expect(response.status).toBe(200)
  })

  it('steps aside for a deployment that opted into remote access', async () => {
    // The same variable already gates binding to a non-loopback address, and
    // that path demands a token; a host answering by name would otherwise
    // reject every request it received.
    process.env.LOOPTROOP_ALLOW_REMOTE_API = '1'

    const response = await request({ Host: 'looptroop.internal:3000', Origin: 'https://looptroop.internal' })
    expect(response.status).toBe(200)
  })

  it('reads the authority from the URL only when no Host header was sent', async () => {
    const app = new Hono()
    let seen: string | undefined
    app.get('/x', (c) => {
      seen = requestAuthority(c)
      return c.body(null, 204)
    })

    await app.request('http://127.0.0.1:3000/x', { headers: { Host: 'evil.example' } })
    expect(seen).toBe('evil.example')

    await app.request('http://127.0.0.1:3000/x')
    expect(seen).toBe('127.0.0.1:3000')
  })

  it('reduces an authority to its hostname', () => {
    expect(hostnameFromAuthority('127.0.0.1:3000')).toBe('127.0.0.1')
    expect(hostnameFromAuthority('[::1]:3000')).toBe('::1')
    expect(hostnameFromAuthority('::1')).toBe('::1')
    expect(hostnameFromAuthority('LocalHost')).toBe('localhost')
  })
})
