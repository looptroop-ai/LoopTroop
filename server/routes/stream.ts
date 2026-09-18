import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { broadcaster, type SSEBroadcasterLike } from '../sse/broadcaster'
import { warnIfVerbose } from '../runtime'
import { getTicketByRef } from '../storage/tickets'

const STREAM_CONNECTED_EVENT = 'connected'
const STREAM_HEARTBEAT_EVENT = 'heartbeat'
const STREAM_HEARTBEAT_INTERVAL_MS = 30_000
export const MAX_SSE_CONNECTIONS_PER_TICKET = 6
export const MAX_SSE_CONNECTIONS_TOTAL = 100

export function cleanupStreamClient(
  ticketId: string,
  clientId: string,
  interval?: ReturnType<typeof setInterval>,
  streamBroadcaster: SSEBroadcasterLike = broadcaster,
): void {
  if (interval) {
    clearInterval(interval)
  }
  streamBroadcaster.removeClient(ticketId, clientId)
}

export function createStreamRouter(streamBroadcaster: SSEBroadcasterLike = broadcaster): Hono {
  const streamRouter = new Hono()

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
    const requestSignal = c.req.raw.signal
    if (requestSignal.aborted) return new Response(null, { status: 499 })
    const safeTicketId = ticket.id
    const clientId = `${safeTicketId}-${Date.now()}-${randomBytes(6).toString('hex')}`
    if (!streamBroadcaster.reserveClient(safeTicketId, clientId, MAX_SSE_CONNECTIONS_PER_TICKET, MAX_SSE_CONNECTIONS_TOTAL)) {
      return c.json(
        { error: streamBroadcaster.getClientCount(safeTicketId) >= MAX_SSE_CONNECTIONS_PER_TICKET
          ? 'Too many streams for this ticket'
          : 'Too many active streams' },
        429,
      )
    }

    let abortStream: (() => void) | null = null
    let cleanupReservation: () => void = () => {
      abortStream?.()
      streamBroadcaster.removeClient(safeTicketId, clientId)
    }
    const onRequestAbort = () => {
      cleanupReservation()
    }
    requestSignal.addEventListener('abort', onRequestAbort, { once: true })

    try {
      return streamSSE(c, async (stream) => {
        let resolveStream: () => void = () => {}
        let isCleanedUp = false
        let interval: ReturnType<typeof setInterval> | null = null

        function safeCleanup() {
          if (isCleanedUp) return
          isCleanedUp = true
          // Ticket cleanup can happen while a handshake/replay write is waiting
          // on transport backpressure. Abort that writer before releasing the
          // admission slot; resolving streamPromise alone cannot interrupt the
          // earlier Promise.all(initialWrites).
          abortStream?.()
          cleanupStreamClient(safeTicketId, clientId, interval ?? undefined, streamBroadcaster)
          requestSignal.removeEventListener('abort', onRequestAbort)
          resolveStream()
        }

        const streamPromise = new Promise<void>((resolve) => { resolveStream = resolve })
        try {
          cleanupReservation = safeCleanup
          abortStream = () => stream.abort()
          stream.onAbort(safeCleanup)

          // Queue the handshake and replay before activating the reservation,
          // without yielding between them. Live events then follow replay in the
          // writer rather than overtaking it.
          const initialWrites = [stream.writeSSE({
            event: STREAM_CONNECTED_EVENT,
            data: JSON.stringify({ ticketId: safeTicketId, clientId, timestamp: new Date().toISOString() }),
          })]
          if (lastEventId !== undefined) {
            const replay = streamBroadcaster.getEventsSince(safeTicketId, lastEventId)
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

          if (!streamBroadcaster.activateClient(safeTicketId, {
            id: clientId,
            send: (event: string, data: string, id: string) => {
              stream.writeSSE({ event, data, id }).catch((err) => {
                warnIfVerbose(`[stream] SSE write failed for client ${clientId}:`, err)
                safeCleanup()
              })
            },
            close: safeCleanup,
            interval,
          })) {
            // Activation can lose the reservation to an abort between the
            // synchronous queueing above and this check. Observe every queued
            // write before returning so a transport rejection cannot become an
            // unhandled promise after the reservation has already been cleaned.
            // Do not await here: a canceled transport may leave a write pending,
            // and cleanup must release the reservation immediately.
            void Promise.allSettled(initialWrites)
            safeCleanup()
            return
          }

          await Promise.all(initialWrites)
        } catch (error) {
          safeCleanup()
          throw error
        }

        // Keep stream open until abort, write failure, or ticket cleanup.
        await streamPromise
      })
    } catch (error) {
      cleanupReservation()
      throw error
    }
  })

  return streamRouter
}

export const streamRouter = createStreamRouter()
