import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { AssistantScope, AssistantStreamEvent } from '@shared/assistant'
import { sanitizeDiagnosticText } from '@shared/errorDiagnostics'
import { AssistantError, assertAssistantSessionScope, closeAssistantSession, createAssistantSession, getAssistantSession, listAssistantSessions, promptAssistant } from '../assistant/sessions'

const scopeSchema = z.object({ ticketId: z.string().min(1).max(200).optional() }).strict()
const messageSchema = scopeSchema.extend({ message: z.string().trim().min(1).max(20_000) })
export const chatRouter = new Hono()

chatRouter.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store')
  await next()
})

chatRouter.onError((error, c) => c.json({ error: sanitizeDiagnosticText(error.message) }, error instanceof AssistantError ? error.status : 503))

function parseScope(value: unknown): AssistantScope {
  const result = scopeSchema.safeParse(value)
  if (!result.success) throw new AssistantError('Choose a valid ticket scope.')
  return result.data
}

async function body(c: Context): Promise<unknown> {
  try { return await c.req.json() }
  catch { throw new AssistantError('Invalid JSON in request body.') }
}

chatRouter.get('/chat/sessions', async c => {
  const query = c.req.query()
  if (Object.keys(query).length === 0) return c.json(await listAssistantSessions())
  if (query.scope === 'dashboard' && Object.keys(query).length === 1) {
    return c.json(await listAssistantSessions({}))
  }
  return c.json(await listAssistantSessions(parseScope(query)))
})

chatRouter.post('/chat/sessions', async c => {
  return c.json(await createAssistantSession(parseScope(await body(c)), c.req.raw.signal), 201)
})

chatRouter.get('/chat/sessions/:id', async c => {
  return c.json(await getAssistantSession(c.req.param('id'), parseScope(c.req.query()), c.req.raw.signal))
})

chatRouter.post('/chat/sessions/:id/close', async c => {
  await closeAssistantSession(c.req.param('id'), parseScope(await body(c)))
  return c.json({ ok: true })
})

chatRouter.post('/chat/sessions/:id/messages', async c => {
  const result = messageSchema.safeParse(await body(c))
  if (!result.success) throw new AssistantError('Enter a message of at most 20,000 characters and a valid chat scope.')
  const { message, ...scope } = result.data
  // Validate scope before opening the stream so a stale ticket cannot receive another ticket's answer.
  assertAssistantSessionScope(c.req.param('id'), scope)
  const response = streamSSE(c, async stream => {
    const controller = new AbortController()
    stream.onAbort(() => controller.abort(new DOMException('Chat disconnected', 'AbortError')))
    const signal = AbortSignal.any([c.req.raw.signal, controller.signal])
    let writes = Promise.resolve()
    const send = (event: AssistantStreamEvent) => {
      writes = writes.then(async () => { if (!signal.aborted) await stream.writeSSE({ data: JSON.stringify(event) }) })
        .catch(error => { controller.abort(error) })
    }
    const heartbeat = setInterval(() => {
      writes = writes.then(async () => { if (!signal.aborted) await stream.write(': heartbeat\n\n') })
        .catch(error => { controller.abort(error) })
    }, 10_000)
    try {
      const session = await promptAssistant(c.req.param('id'), scope, message, signal, text => send({ type: 'delta', text }))
      send({ type: 'done', session })
    } catch (error) {
      if (!signal.aborted) send({ type: 'error', error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)) })
    } finally {
      clearInterval(heartbeat)
      await writes
    }
  })
  response.headers.set('Cache-Control', 'private, no-store')
  return response
})
