import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { serve } from '@hono/node-server'
import { createApp } from '../server/app'
import { createSessionCredentials, SESSION_COOKIE_NAME } from '../server/middleware/sessionAuth'

/**
 * The cross-port cookie attack, played out over real sockets.
 *
 * Cookies are scoped by host and never by port, and a "site" ignores the port
 * too — so `SameSite=Strict` considers 127.0.0.1:9999 and 127.0.0.1:3000 the
 * same site, and the browser hands this daemon's session cookie to any other
 * service a user has running on loopback. That is not hypothetical on a
 * developer machine, which is full of them.
 *
 * These tests run a second loopback server that captures the cookie, then have
 * it replay the credential against the daemon in each shape a browser can be
 * made to produce. In-process `app.request()` would exercise the same middleware
 * but prove nothing about the transport, and this is a transport-level claim.
 */
describe('a second loopback service cannot use a captured session cookie', () => {
  const tempDirs: string[] = []
  const servers: Server[] = []

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((done) => server.close(() => done()))
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function makeClientDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-theft-'))
    tempDirs.push(dir)
    return dir
  }

  function addressOf(server: Server): { port: number } {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server is not on a TCP port')
    return { port: address.port }
  }

  /** The daemon, on a kernel-assigned port so concurrent files cannot collide. */
  async function startDaemonServer() {
    const credentials = createSessionCredentials()
    const app = createApp({ mode: 'production', credentials, clientDir: makeClientDir() })

    const server = await new Promise<Server>((ready) => {
      const created = serve(
        { fetch: app.fetch, port: 0, hostname: '127.0.0.1' },
        () => ready(created as unknown as Server),
      ) as unknown as Server
      servers.push(created)
    })

    return { credentials, port: addressOf(server).port }
  }

  /**
   * The other loopback service: some tool the user is running, or one they were
   * talked into running. It records every cookie the browser sends it.
   */
  async function startThief() {
    const captured: string[] = []
    const server = createServer((req, res) => {
      if (req.headers.cookie) captured.push(req.headers.cookie)
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })
    servers.push(server)

    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    return { captured, port: addressOf(server).port }
  }

  /**
   * Mints a real session cookie the way the browser does: `looptroop open`
   * issues a nonce, the page exchanges it, the daemon sets the cookie.
   */
  async function establishSession(port: number, apiToken: string): Promise<string> {
    const bootstrap = await fetch(`http://127.0.0.1:${port}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
    })
    expect(bootstrap.status).toBe(200)
    const { nonce } = await bootstrap.json() as { nonce: string }

    const exchange = await fetch(`http://127.0.0.1:${port}/api/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ nonce }),
    })
    expect(exchange.status).toBe(200)

    const setCookie = exchange.headers.get('set-cookie') ?? ''
    const value = /looptroop_session=([^;]+)/.exec(setCookie)?.[1]
    expect(value, 'the exchange must set a session cookie').toBeTruthy()
    return `${SESSION_COOKIE_NAME}=${value ?? ''}`
  }

  it('captures the cookie the browser would send it, and still cannot spend it', async () => {
    const daemon = await startDaemonServer()
    const thief = await startThief()
    const cookie = await establishSession(daemon.port, daemon.credentials.apiToken)

    // The capture half is real and is not fixable server-side: the browser sends
    // this cookie to the other port because nothing about a cookie is scoped to
    // a port. This asserts the exposure exists rather than pretending it does
    // not — what must not follow is that the captured value works.
    await fetch(`http://127.0.0.1:${thief.port}/api`, { headers: { Cookie: cookie } })
    expect(thief.captured).toHaveLength(1)
    expect(thief.captured[0]).toContain(SESSION_COOKIE_NAME)

    const stolen = thief.captured[0] ?? ''

    // Replayed out of band — curl, or the thief's own server process. No Origin,
    // no Sec-Fetch headers, exactly what used to be waved through as
    // "same-origin, since browsers always send Origin on anything dangerous".
    const bare = await fetch(`http://127.0.0.1:${daemon.port}/api/projects`, {
      headers: { Cookie: stolen },
    })
    expect(bare.status).toBe(403)

    // Replayed the way the thief's *page* would produce it: a cross-port fetch
    // or an <img>, where the browser fills in Sec-Fetch-Site itself and cannot
    // be made to lie, because it is a forbidden header name.
    const fromPage = await fetch(`http://127.0.0.1:${daemon.port}/api/projects`, {
      headers: {
        Cookie: stolen,
        Origin: `http://127.0.0.1:${thief.port}`,
        'Sec-Fetch-Site': 'same-site',
      },
    })
    expect(fromPage.status).toBe(403)

    // And the no-cors variant, which strips Origin but keeps the cookie.
    const noCors = await fetch(`http://127.0.0.1:${daemon.port}/api/projects`, {
      headers: { Cookie: stolen, 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'no-cors' },
    })
    expect(noCors.status).toBe(403)
  })

  it('still serves the daemon own page, which is what the rule must not break', async () => {
    const daemon = await startDaemonServer()
    const cookie = await establishSession(daemon.port, daemon.credentials.apiToken)

    // An <img> preview of manual-QA evidence, an <a download>, a top-level
    // navigation and EventSource all send no Origin — and all of them carry
    // `Sec-Fetch-Site: same-origin`, which is the difference.
    const sameOrigin = await fetch(`http://127.0.0.1:${daemon.port}/api/projects`, {
      headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' },
    })
    expect(sameOrigin.status).not.toBe(403)
    expect(sameOrigin.status).not.toBe(401)

    // And a page-driven XHR, which does send Origin naming this same authority.
    const withOrigin = await fetch(`http://127.0.0.1:${daemon.port}/api/projects`, {
      headers: {
        Cookie: cookie,
        Origin: `http://127.0.0.1:${daemon.port}`,
        'Sec-Fetch-Site': 'same-origin',
      },
    })
    expect(withOrigin.status).not.toBe(403)
    expect(withOrigin.status).not.toBe(401)
  })

  it('leaves scripted callers alone, which hold a token rather than the cookie', async () => {
    const daemon = await startDaemonServer()

    // The CLI, the install smoke tests and the read-only verifier all send no
    // Origin and no Sec-Fetch headers. They are exempt because they present the
    // API token: a caller holding it never needed the browser to vouch for it.
    const scripted = await fetch(`http://127.0.0.1:${daemon.port}/api/projects`, {
      headers: { Authorization: `Bearer ${daemon.credentials.apiToken}` },
    })
    expect(scripted.status).not.toBe(403)
    expect(scripted.status).not.toBe(401)

    // Health stays public, so `looptroop status` and CI keep working.
    const health = await fetch(`http://127.0.0.1:${daemon.port}/api/health`)
    expect(health.status).toBe(200)
  })
})
