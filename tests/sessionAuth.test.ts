import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/app'
import { createSessionCredentials, readCookie, SESSION_COOKIE_NAME, type SessionCredentials } from '../server/middleware/sessionAuth'
import type { Hono } from 'hono'
import { removeTempDir } from '../server/test/tempDir'

/**
 * 2.8 contract: a browser session, a script bearer token, and a one-time
 * bootstrap exchange must all work; the nonce is single-use; and the bootstrap
 * URL fragment never reaches the server.
 */
describe('daemon session auth', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      removeTempDir(dir)
    }
  })

  function makeClientDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-auth-'))
    tempDirs.push(dir)
    return dir
  }

  function makeApp() {
    return createApp({
      mode: 'production',
      credentials: createSessionCredentials(),
      clientDir: makeClientDir(),
    })
  }

  /** Mints a nonce the way `looptroop open` does: over HTTP, with the token. */
  async function issueNonce(app: Hono, credentials: SessionCredentials): Promise<string> {
    const response = await app.request('/api/auth/bootstrap', {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.apiToken}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { nonce: string }
    return body.nonce
  }

  it('rejects a request with no credentials', async () => {
    const response = await makeApp().request('/api/projects')
    expect(response.status).toBe(401)
  })

  it('answers a malformed cookie with the ordinary 401, not a 500', async () => {
    // `decodeURIComponent` on bad percent-encoding threw before authentication
    // could return its normal refusal, so a broken Cookie header told an
    // unauthenticated caller that something had gone wrong inside the daemon.
    const response = await makeApp().request('/api/projects', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=%E0%A4%A` },
    })
    expect(response.status).toBe(401)
  })

  it('reads a malformed cookie as absent rather than throwing', () => {
    // The host guard calls this too, on the request path, so a throw here would
    // 500 before any handler ran.
    expect(readCookie(`${SESSION_COOKIE_NAME}=%zz`, SESSION_COOKIE_NAME)).toBeNull()
    expect(readCookie(`${SESSION_COOKIE_NAME}=%E0%A4%A`, SESSION_COOKIE_NAME)).toBeNull()
    expect(readCookie(`other=%zz; ${SESSION_COOKIE_NAME}=fine`, SESSION_COOKIE_NAME)).toBe('fine')
  })

  it('accepts the bearer API token', async () => {
    const credentials = createSessionCredentials()
    const app = createApp({
      mode: 'production',
      credentials,
      clientDir: makeClientDir(),
    })

    const response = await app.request('/api/projects', {
      headers: { Authorization: `Bearer ${credentials.apiToken}` },
    })
    // Past the middleware is the contract here; this pool has no database, so
    // the handler itself cannot return 200.
    expect(response.status).not.toBe(401)
  })

  it('rejects a wrong bearer token', async () => {
    const response = await makeApp().request('/api/projects', {
      headers: { Authorization: 'Bearer not-the-token' },
    })
    expect(response.status).toBe(401)
  })

  it('exchanges a bootstrap nonce for a session cookie', async () => {
    const credentials = createSessionCredentials()
    const app = createApp({
      mode: 'production',
      credentials,
      clientDir: makeClientDir(),
    })

    const exchange = await app.request('/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: await issueNonce(app, credentials) }),
    })

    expect(exchange.status).toBe(200)
    const setCookie = exchange.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    // Scoped to the API so the static bundle is fetched without a credential.
    expect(setCookie).toContain('Path=/api')
  })

  it('lets the cookie authenticate subsequent requests', async () => {
    const credentials = createSessionCredentials()
    const app = createApp({
      mode: 'production',
      credentials,
      clientDir: makeClientDir(),
    })

    await app.request('/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: await issueNonce(app, credentials) }),
    })
    const sessionCookie = `looptroop_session=${encodeURIComponent(credentials.sessionToken)}`

    // Sec-Fetch-Site is what the browser sends on a request from this daemon's
    // own page, and the host guard now requires it before the cookie counts:
    // otherwise a page on another loopback port, which shares this cookie jar,
    // could make the very same request.
    const response = await app.request('/api/projects', {
      headers: { Cookie: sessionCookie, 'Sec-Fetch-Site': 'same-origin' },
    })

    // Asserted against what the bearer token gets rather than with
    // `not.toBe(401)`. That form was also satisfied by the 403 a refused cookie
    // produces, so it passed whether or not the cookie worked — it went green
    // against a build where cookie auth was entirely broken. Comparing the two
    // credentials says the real thing: the cookie gets as far as the token does.
    const withToken = await app.request('/api/projects', {
      headers: { Authorization: `Bearer ${credentials.apiToken}` },
    })

    expect(response.status).toBe(withToken.status)
    expect(response.status).not.toBe(401)
    expect(response.status).not.toBe(403)
  })

  it('does not let the cookie authenticate a request the browser did not vouch for', async () => {
    const credentials = createSessionCredentials()
    const app = createApp({
      mode: 'production',
      credentials,
      clientDir: makeClientDir(),
    })

    await app.request('/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: await issueNonce(app, credentials) }),
    })

    // The genuine session token, on a request shaped the way a cross-port page's
    // <img> or no-cors fetch is shaped: no Origin, no Sec-Fetch-Site the browser
    // would have set for us. Holding the cookie is not enough.
    const response = await app.request('/api/projects', {
      headers: { Cookie: `looptroop_session=${encodeURIComponent(credentials.sessionToken)}` },
    })

    expect(response.status).toBe(403)
  })

  it('rejects a replayed bootstrap nonce', async () => {
    const credentials = createSessionCredentials()
    const app = createApp({
      mode: 'production',
      credentials,
      clientDir: makeClientDir(),
    })
    const body = JSON.stringify({ nonce: await issueNonce(app, credentials) })

    const first = await app.request('/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    expect(first.status).toBe(200)

    const second = await app.request('/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    expect(second.status).toBe(401)
  })

  it('mints a distinct nonce per request so `open` keeps working', async () => {
    const credentials = createSessionCredentials()
    const app = createApp({
      mode: 'production',
      credentials,
      clientDir: makeClientDir(),
    })

    const first = await issueNonce(app, credentials)
    const second = await issueNonce(app, credentials)
    expect(second).not.toBe(first)

    // Spending the first must not invalidate the second.
    for (const nonce of [first, second]) {
      const exchange = await app.request('/api/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
      })
      expect(exchange.status).toBe(200)
    }
  })

  it('refuses to mint a nonce without a credential', async () => {
    const response = await makeApp().request('/api/auth/bootstrap', { method: 'POST' })
    expect(response.status).toBe(401)
  })

  it('rejects an unknown nonce', async () => {
    const app = makeApp()
    const response = await app.request('/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: 'wrong' }),
    })
    expect(response.status).toBe(401)
  })

  /**
   * How `looptroop open` finds out whether the browser it launched arrived. It
   * cannot be told any other way: no platform reports back from an opener.
   */
  describe('reporting whether a sign-in link was used', () => {
    async function askStatus(app: Hono, credentials: SessionCredentials, nonce: string) {
      return app.request('/api/auth/bootstrap/status', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nonce }),
      })
    }

    it('reports a fresh nonce as pending and a spent one as not', async () => {
      const credentials = createSessionCredentials()
      const app = createApp({ mode: 'production', credentials, clientDir: makeClientDir() })
      const nonce = await issueNonce(app, credentials)

      const before = await askStatus(app, credentials, nonce)
      expect(before.status).toBe(200)
      expect(await before.json()).toEqual({ pending: true })

      await app.request('/api/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
      })

      const after = await askStatus(app, credentials, nonce)
      expect(await after.json()).toEqual({ pending: false })
    })

    it('reports an unknown nonce as not pending rather than failing', async () => {
      const credentials = createSessionCredentials()
      const app = createApp({ mode: 'production', credentials, clientDir: makeClientDir() })

      const response = await askStatus(app, credentials, 'never-issued')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ pending: false })
    })

    it('needs the API token, like minting does', async () => {
      const response = await makeApp().request('/api/auth/bootstrap/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: 'anything' }),
      })
      expect(response.status).toBe(401)
    })
  })

  it('exposes health without credentials for container probes', async () => {
    const response = await makeApp().request('/api/health')
    expect(response.status).toBe(200)
  })

  it('reports the instance id from health so a client can verify which daemon answered', async () => {
    const app = createApp({
      mode: 'production',
      credentials: createSessionCredentials(),
      clientDir: makeClientDir(),
      instanceId: 'instance-under-test',
    })

    const body = await (await app.request('/api/health')).json() as { instanceId?: string }
    expect(body.instanceId).toBe('instance-under-test')
  })

  it('keeps other API routes protected when health is public', async () => {
    const app = makeApp()
    expect((await app.request('/api/health')).status).toBe(200)
    expect((await app.request('/api/projects')).status).toBe(401)
  })
})
