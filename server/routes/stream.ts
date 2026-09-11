import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { broadcaster } from '../sse/broadcaster'
import { warnIfVerbose } from '../runtime'
import { getTicketByRef } from '../storage/tickets'

const streamRouter = new Hono()
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
  const ticketRef = /^([1-9]\d{0,15}):[A-Z0-9]{3,5}-([1-9]\d{0,15})$/.exec(ticketId)
  if (!ticketRef || !Number.isSafeInteger(Number(ticketRef[1])) || !Number.isSafeInteger(Number(ticketRef[2]))) {
    return c.json({ error: 'Invalid ticketId' }, 400)
  }
  const lastEventId = c.req.header('Last-Event-ID') ?? c.req.query('lastEventId')
  // Ordinary bad cursors get a recoverable gap; control bytes and unbounded input
  // are rejected before opening the stream. Never echo the rejected cursor.
  if (lastEventId !== undefined && (lastEventId.length > 128 || [...lastEventId].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) {
    return c.json({ error: 'Invalid lastEventId' }, 400)
  }
  const ticket = getTicketByRef(ticketId)
  if (!ticket) {
    return c.json({ error: 'Ticket not found' }, 404)
  }
  if (broadcaster.getClientCount(ticket.id) >= MAX_SSE_CONNECTIONS_PER_TICKET) {
    return c.json({ error: 'Too many streams for this ticket' }, 429)
  }
  if (broadcaster.getTotalClientCount() >= MAX_SSE_CONNECTIONS_TOTAL) {
    return c.json({ error: 'Too many active streams' }, 429)
  }

  const safeTicketId = ticket.id

  return streamSSE(c, async (stream) => {
    const clientId = `${safeTicketId}-${Date.now()}-${randomBytes(6).toString('hex')}`
    let resolveStream: () => void = () => {}
    let isCleanedUp = false
    let interval: ReturnType<typeof setInterval> | null = null

    function safeCleanup() {
      if (isCleanedUp) return
      isCleanedUp = true
      cleanupStreamClient(safeTicketId, clientId, interval ?? undefined)
      resolveStream()
    }

    const streamPromise = new Promise<void>((resolve) => { resolveStream = resolve })
    stream.onAbort(safeCleanup)

    // Queue the handshake and replay before subscribing, without yielding between
    // them. Live events then follow replay in the writer rather than overtaking it.
    const initialWrites = [stream.writeSSE({
      event: STREAM_CONNECTED_EVENT,
      data: JSON.stringify({ ticketId: safeTicketId, clientId, timestamp: new Date().toISOString() }),
    })]
    if (lastEventId !== undefined) {
      const replay = broadcaster.getEventsSince(safeTicketId, lastEventId)
      if (replay.gap) {
        initialWrites.push(stream.writeSSE({
          event: 'replay_gap',
          data: JSON.stringify({ ticketId: safeTicketId, reason: replay.gap }),
          // Empty id resets the browser's Last-Event-ID as well as our hook's cursor.
          id: '',
        }))
      } else {
        for (const event of replay.events) initialWrites.push(stream.writeSSE(event))
      }
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
          safeCleanup()
        })
      },
      close: safeCleanup,
      interval,
    })

    try {
      await Promise.all(initialWrites)
    } catch (error) {
      safeCleanup()
      throw error
    }

    // Keep stream open until abort, write failure, or ticket cleanup.
    await streamPromise
  })
})

export { streamRouter }
