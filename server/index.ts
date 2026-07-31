import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { startupSequence } from './startup'
import { health } from './routes/health'
import { profileRouter } from './routes/profiles'
import { projectRouter } from './routes/projects'
import { ticketRouter } from './routes/tickets'
import { streamRouter } from './routes/stream'
import { modelsRouter } from './routes/models'
import { filesRouter } from './routes/files'
import { beadsRouter } from './routes/beads'
import { promptsRouter } from './routes/prompts'
import { validateJson } from './middleware/validation'
import { getAllowedBackendHost, getBackendPort, getFrontendOrigin, isLoopbackHost } from '../shared/appConfig'
import { workflowRouter } from './routes/workflow'
import { createApiRateLimitMiddleware } from './middleware/rateLimit'
import { createApiAuthMiddleware, API_TOKEN_HEADER } from './middleware/apiAuth'
import { closeDatabase } from './db/index'
import { clearProjectDatabaseCache } from './db/project'
import { broadcaster } from './sse/broadcaster'

const app = new Hono()
const SHUTDOWN_FORCE_EXIT_MS = 30_000

function isLocalhostRequest(c: Context): boolean {
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

// Global middleware
// Chrome's Private Network Access enforcement requires this header on OPTIONS preflights
// when the browser (localhost:5173) accesses another port (localhost:3000).
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'OPTIONS' && c.req.header('Access-Control-Request-Private-Network') === 'true') {
    c.header('Access-Control-Allow-Private-Network', 'true')
  }
  await next()
})
app.use('/api/*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')

  if (!isLocalhostRequest(c)) {
    c.header('Strict-Transport-Security', 'max-age=31536000')
  }

  await next()
})
app.use('/api/*', cors({
  origin: getFrontendOrigin(),
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  // Cache-Control is required for EventSource (browser sends Cache-Control: no-cache in CORS preflight)
  allowHeaders: [
    'Content-Type',
    'Last-Event-ID',
    'Cache-Control',
    'Authorization',
    API_TOKEN_HEADER,
    'X-Action-Id',
    'X-Checklist-Hash',
    'X-Draft-Revision',
    'X-Checklist-Item-Id',
    'X-File-Name',
    'X-Evidence-Id',
  ],
}))
app.use('/api/*', createApiRateLimitMiddleware())
app.use('/api/*', createApiAuthMiddleware())
app.use('/api/*', validateJson)

// Mount routes
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

const port = getBackendPort()
const hostname = getAllowedBackendHost()
let serverHandle: ReturnType<typeof serve> | null = null
let shutdownStarted = false

async function closeHttpServer(): Promise<void> {
  if (!serverHandle || typeof serverHandle.close !== 'function') return
  await new Promise<void>((resolve) => {
    serverHandle?.close(() => resolve())
  })
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true
  console.log(`[server] Received ${signal}; shutting down LoopTroop backend.`)

  const forceExit = setTimeout(() => {
    console.error('[server] Graceful shutdown timed out; forcing exit.')
    process.exit(1)
  }, SHUTDOWN_FORCE_EXIT_MS)
  forceExit.unref()

  try {
    console.log('[server] Closing HTTP server...')
    await closeHttpServer()
    console.log('[server] Stopping broadcaster auto-cleanup...')
    broadcaster.stopAutoCleanup()
    console.log('[server] Clearing project database cache...')
    clearProjectDatabaseCache()
    console.log('[server] Closing database connections...')
    closeDatabase()
    
    clearTimeout(forceExit)
    console.log('[server] Graceful shutdown completed.')
    process.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[server] Shutdown failed: ${message}`)
    process.exit(1)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

async function startServer(): Promise<void> {
  console.log(`[server] LoopTroop backend starting on ${hostname}:${port}`)
  await startupSequence()
  serverHandle = serve({ fetch: app.fetch, port, hostname })
  console.log(`[server] LoopTroop backend running on http://${hostname}:${port}`)
}

void startServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[server] LoopTroop backend failed to start: ${message}`)
  process.exit(1)
})

export default app
export { app }
export { isLoopbackHost }
