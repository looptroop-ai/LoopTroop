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
  /** Defaults to the `dist/client` beside the bundled server. */
  clientDir?: string
}

/**
 * The bundle lives at dist/server/index.js and the interface at dist/client, so
 * the default is resolved from this module rather than the working directory:
 * a globally installed daemon runs from whatever directory the user is in.
 */
function resolveDefaultClientDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../client')
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
  const host = c.req.header('Host')?.trim().toLowerCase()
  if (!host) {
    return false
  }

  const hostname: string = host.startsWith('[')
    ? host.slice(1, host.indexOf(']') === -1 ? host.length : host.indexOf(']'))
    : (host.split(':')[0] ?? host)

  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '::ffff:127.0.0.1'
    || hostname === '::ffff:7f00:1'
    || hostname.startsWith('127.')
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
