import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { health } from './routes/health'
import { profileRouter } from './routes/profiles'
import { projectRouter } from './routes/projects'
import { ticketRouter } from './routes/tickets'
import { streamRouter } from './routes/stream'
import { modelsRouter } from './routes/models'
import { filesRouter } from './routes/files'
import { beadsRouter } from './routes/beads'
import { promptsRouter } from './routes/prompts'
import { workflowRouter } from './routes/workflow'
import { validateJson } from './middleware/validation'
import { createApiRateLimitMiddleware } from './middleware/rateLimit'
import { createApiAuthMiddleware, API_TOKEN_HEADER } from './middleware/apiAuth'
import { createHostGuardMiddleware, isLoopbackAuthority, requestAuthority } from './middleware/hostGuard'
import {
  BootstrapNonceStore,
  createSessionAuthMiddleware,
  serializeSessionCookie,
  type SessionCredentials,
} from './middleware/sessionAuth'
import { getFrontendOrigin } from '../shared/appConfig'

export interface CreateAppOptions {
  /**
   * `development` keeps the cross-origin allowances the Vite dev server needs on
   * port 5173. `production` serves the built frontend from the same origin, so
   * no CORS headers are emitted at all.
   */
  mode?: 'development' | 'production'
  /** Injected rather than read from the environment so a host can own the secret. */
  apiToken?: string
  /** Enables cookie-based browser sessions and the bootstrap exchange route. */
  credentials?: SessionCredentials
  /**
   * Mints the one-time nonces a browser exchanges for a session. Pass the
   * daemon's own store so `looptroop open` can issue a fresh nonce over HTTP;
   * omitted, the app keeps a private one.
   */
  bootstrapNonces?: BootstrapNonceStore
  /** Reported by /api/health so a client can verify it reached this daemon. */
  instanceId?: string
  /**
   * Mounts an authenticated shutdown endpoint. Omitted, no route exists at all:
   * an embedding host must never have its process stopped through this API.
   */
  onShutdownRequest?: () => void
  /** Defaults to the `dist/client` beside the bundled server. */
  clientDir?: string
}

/**
 * How far above this module the built interface may sit. Exactly the two depths
 * the build produces: `dist/server/index.js` is one level below `dist/`, and
 * `dist/server/cli/daemonProcess.js` is two. Bounded deliberately — an unbounded
 * walk would climb out of the package and could find an unrelated `client`
 * directory somewhere above it.
 */
const CLIENT_SEARCH_DEPTH = 2

/**
 * The built interface, found by walking up from this module rather than from the
 * working directory: a globally installed daemon runs from wherever the user
 * happens to be.
 *
 * `dist/client` sits beside `dist/server`, but this module is inlined into three
 * bundles at two depths, so a fixed `../client` resolves correctly from
 * `dist/server/index.js` and points at a directory that does not exist from
 * `dist/server/cli/daemonProcess.js` — which is the bundle the daemon actually
 * runs. Nothing catches that locally, because the check below finds the built
 * client through the working directory in a checkout; it surfaces only once
 * someone installs the package, as a 404 for the entire interface.
 *
 * Falls back to the sibling directory when no built client is found, so the
 * caller gets the documented default and the existsSync check below declines to
 * mount an interface rather than serving from some directory chosen at random.
 */
export function resolveDefaultClientDir(
  startDir = dirname(fileURLToPath(import.meta.url)),
): string {
  let dir = startDir

  for (let depth = 0; depth < CLIENT_SEARCH_DEPTH; depth += 1) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent

    const candidate = resolve(dir, 'client')
    if (existsSync(resolve(candidate, 'index.html'))) return candidate
  }

  return resolve(startDir, '../client')
}

const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Last-Event-ID',
  // EventSource sends Cache-Control: no-cache on the CORS preflight.
  'Cache-Control',
  'Authorization',
  API_TOKEN_HEADER,
  'X-Action-Id',
  'X-Checklist-Hash',
  'X-Draft-Revision',
  'X-Checklist-Item-Id',
  'X-File-Name',
  'X-Evidence-Id',
]

export function isLocalhostRequest(c: Context): boolean {
  return isLoopbackAuthority(requestAuthority(c))
}

/**
 * Builds the API surface. Pure: no listeners, timers, files, or signal handlers.
 */
export function createApp(options: CreateAppOptions = {}): Hono {
  const mode = options.mode ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development')
  const app = new Hono()

  if (mode === 'development') {
    // Chrome's Private Network Access enforcement requires this header on
    // OPTIONS preflights when localhost:5173 reaches localhost:3000.
    app.use('/api/*', async (c, next) => {
      if (c.req.method === 'OPTIONS' && c.req.header('Access-Control-Request-Private-Network') === 'true') {
        c.header('Access-Control-Allow-Private-Network', 'true')
      }
      await next()
    })
  }

  app.use('/api/*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'DENY')

    if (!isLocalhostRequest(c)) {
      c.header('Strict-Transport-Security', 'max-age=31536000')
    }

    await next()
  })

  // Before CORS and before any authentication: a request that did not come
  // from this machine is refused whatever credential it carries. In development
  // the Vite server is a genuinely different origin, and the only one.
  app.use('/api/*', createHostGuardMiddleware(
    mode === 'development' ? { additionalOrigins: [getFrontendOrigin()] } : {},
  ))

  if (mode === 'development') {
    app.use('/api/*', cors({
      origin: getFrontendOrigin(),
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowHeaders: CORS_ALLOWED_HEADERS,
      credentials: true,
    }))
  }

  app.use('/api/*', createApiRateLimitMiddleware())
  if (options.credentials) {
    const credentials = options.credentials
    const nonces = options.bootstrapNonces ?? new BootstrapNonceStore()

    // Mounted before the auth middleware: exchanging the nonce is how a browser
    // gets the cookie, so it cannot itself require one.
    app.post('/api/auth/exchange', async (c) => {
      const body = await c.req.json().catch(() => null) as { nonce?: unknown } | null
      const candidate = typeof body?.nonce === 'string' ? body.nonce : ''

      if (!candidate || !nonces.consume(candidate)) {
        return c.json({ error: 'Invalid or expired bootstrap nonce' }, 401)
      }

      c.header('Set-Cookie', serializeSessionCookie(credentials.sessionToken, 12 * 60 * 60))
      return c.json({ ok: true })
    })

    // A container health probe holds no credentials, and the response carries
    // no data worth protecting behind a loopback-only bind. The instance id is
    // here so a client can tell this daemon from an unrelated process that
    // inherited its pid.
    app.get('/api/health', (c) => c.json({ status: 'ok', instanceId: options.instanceId ?? null }))

    app.use('/api/*', createSessionAuthMiddleware({ credentials }))

    // Behind the auth middleware: only a caller that already holds the API
    // token may mint a nonce, which is how `looptroop open` opens a browser
    // without the daemon ever writing a usable secret to its log.
    app.post('/api/auth/bootstrap', (c) => c.json({ nonce: nonces.issue() }))
  } else {
    app.use('/api/*', createApiAuthMiddleware(options.apiToken ? { token: options.apiToken } : {}))
  }

  if (options.onShutdownRequest) {
    const requestShutdown = options.onShutdownRequest

    // Mounted after whichever auth middleware was installed above: stopping the
    // daemon is the most destructive thing this API can do.
    app.post('/api/daemon/shutdown', (c) => {
      // The shutdown runs after this response, not during it: closing the server
      // first would drop the very connection that is being answered. Connection:
      // close then retires the socket, so a keep-alive client cannot hold the
      // server open past its own request.
      setTimeout(requestShutdown, 0)
      c.header('Connection', 'close')
      return c.json({ ok: true }, 202)
    })
  }

  app.use('/api/*', validateJson)

  app.route('/api', health)
  app.route('/api', profileRouter)
  app.route('/api', projectRouter)
  app.route('/api', ticketRouter)
  app.route('/api', streamRouter)
  app.route('/api', modelsRouter)
  app.route('/api', filesRouter)
  app.route('/api', beadsRouter)
  app.route('/api', promptsRouter)
  app.route('/api', workflowRouter)

  // Mounted after the API so a frontend route can never shadow an endpoint.
  if (mode === 'production') {
    const clientDir = options.clientDir ?? resolveDefaultClientDir()
    const indexHtml = resolve(clientDir, 'index.html')

    if (existsSync(indexHtml)) {
      app.use('/*', async (c, next) => {
        await next()
        if (!c.res.ok) return

        if (c.req.path.startsWith('/assets/')) {
          // Asset filenames carry a content hash, so a stale response is impossible.
          c.header('Cache-Control', 'public, max-age=31536000, immutable')
          return
        }

        // The document must be revalidated whichever handler produced it, or a
        // cached copy would keep pointing at asset hashes that no longer exist.
        if (c.res.headers.get('Content-Type')?.startsWith('text/html')) {
          c.header('Cache-Control', 'no-cache')
        }
      })

      app.use('/*', serveStatic({ root: clientDir }))

      // Deep links are client-side routes with no file behind them; the browser
      // must revalidate this document or it would pin an old asset manifest.
      app.get('/*', async (c, next) => {
        // An unmatched endpoint is a 404, not a frontend route.
        if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return next()

        // A missing hashed asset must 404 rather than fall back to HTML, or the
        // browser reports a module MIME-type error instead of the real problem.
        if (c.req.path.startsWith('/assets/')) return next()

        const html = await readFile(indexHtml, 'utf8')
        c.header('Content-Type', 'text/html; charset=utf-8')
        c.header('Cache-Control', 'no-cache')
        return c.body(html)
      })
    }
  }

  return app
}
