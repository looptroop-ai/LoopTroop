import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/app'
import { createSessionCredentials, SESSION_COOKIE_NAME, type SessionCredentials } from '../server/middleware/sessionAuth'
import type { Hono } from 'hono'

/**
 * 2.8 contract: a browser session, a script bearer token, and a one-time
 * bootstrap exchange must all work; the nonce is single-use; and the bootstrap
 * URL fragment never reaches the server.
 */
describe('daemon session auth', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
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

    const response = await app.request('/api/projects', { headers: { Cookie: sessionCookie } })
    expect(response.status).not.toBe(401)
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
