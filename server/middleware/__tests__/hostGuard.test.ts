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

  function makeApp(): Hono {
    const app = new Hono()
    app.use('/api/*', createHostGuardMiddleware())
    app.get('/api/thing', (c) => c.json({ ok: true }))
    return app
  }

  async function request(headers: Record<string, string>): Promise<Response> {
    return await makeApp().request('http://127.0.0.1:3000/api/thing', { headers })
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

  it('accepts the dev frontend, which is a different loopback port', async () => {
    const response = await request({ Host: 'localhost:3000', Origin: 'http://localhost:5173' })

    expect(response.status).toBe(200)
  })

  it('accepts a same-origin request, which carries no Origin at all', async () => {
    expect((await request({ Host: '127.0.0.1:3000' })).status).toBe(200)
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
