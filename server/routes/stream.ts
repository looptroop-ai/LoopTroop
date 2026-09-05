import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { broadcaster } from '../sse/broadcaster'
import { warnIfVerbose } from '../runtime'
import { getTicketByRef } from '../storage/tickets'

const streamRouter = new Hono()
const INITIAL_STREAM_EVENT_ID = '0'
const STREAM_CONNECTED_EVENT = 'connected'
const STREAM_HEARTBEAT_EVENT = 'heartbeat'
const STREAM_HEARTBEAT_INTERVAL_MS = 30_000
export const MAX_SSE_CONNECTIONS_PER_TICKET = 6
export const MAX_SSE_CONNECTIONS_TOTAL = 100

export function cleanupStreamClient(ticketId: string, clientId: string, interval?: ReturnType<typeof setInterval>): void {
  if (interval) {
    clearInterval(interval)
  }
  broadcaster.removeClient(ticketId, clientId)
}

streamRouter.get('/stream', (c) => {
  const ticketId = c.req.query('ticketId')
  if (!ticketId) {
    return c.json({ error: 'ticketId query parameter required' }, 400)
  }
  if (!getTicketByRef(ticketId)) {
    return c.json({ error: 'Ticket not found' }, 404)
  }
  if (broadcaster.getClientCount(ticketId) >= MAX_SSE_CONNECTIONS_PER_TICKET) {
    return c.json({ error: 'Too many streams for this ticket' }, 429)
  }
  if (broadcaster.getTotalClientCount() >= MAX_SSE_CONNECTIONS_TOTAL) {
    return c.json({ error: 'Too many active streams' }, 429)
  }

  const lastEventId = c.req.header('Last-Event-ID') ?? c.req.query('lastEventId')
  // Narrowed string (TypeScript doesn't narrow across async closure boundaries)
  const safeTicketId: string = ticketId

  return streamSSE(c, async (stream) => {
    const clientId = `${safeTicketId}-${Date.now()}-${randomBytes(6).toString('hex')}`
    let resolveStream: () => void = () => {}
    let isCleanedUp = false
    let interval: ReturnType<typeof setInterval> | null = null

    function safeCleanup() {
      if (isCleanedUp) return
      isCleanedUp = true
      cleanupStreamClient(safeTicketId, clientId, interval ?? undefined)
    }

    // Keep connection alive with heartbeat
    interval = setInterval(async () => {
      try {
        await stream.writeSSE({
          event: STREAM_HEARTBEAT_EVENT,
          data: JSON.stringify({ timestamp: new Date().toISOString() }),
        })
      } catch {
        safeCleanup()
      }
    }, STREAM_HEARTBEAT_INTERVAL_MS)

    // Register client with broadcaster
    broadcaster.addClient(safeTicketId, {
      id: clientId,
      send: (event: string, data: string, id: string) => {
        stream.writeSSE({ event, data, id }).catch((err) => {
          warnIfVerbose(`[stream] SSE write failed for client ${clientId}:`, err)
          broadcaster.removeClient(safeTicketId, clientId)
        })
      },
      close: () => {
        // stream cleanup handled by onAbort
      },
      interval,
    })

    try {
      // Send initial connection event
      await stream.writeSSE({
        event: STREAM_CONNECTED_EVENT,
        data: JSON.stringify({ ticketId: safeTicketId, clientId, timestamp: new Date().toISOString() }),
        id: INITIAL_STREAM_EVENT_ID,
      })

      // Replay missed events if reconnecting
      if (lastEventId) {
        const missed = broadcaster.getEventsSince(safeTicketId, lastEventId)
        for (const evt of missed) {
          await stream.writeSSE({ event: evt.event, data: evt.data, id: evt.id })
        }
      }
    } catch (error) {
      safeCleanup()
      throw error
    }

    stream.onAbort(() => {
      safeCleanup()
      resolveStream()
    })

    // Keep stream open until abort resolves the promise
    const streamPromise = new Promise<void>((resolve) => { resolveStream = resolve })
    await streamPromise
  })
})

export { streamRouter }
