import type { SSEEventType } from './eventTypes'
import {
  MAX_SSE_BUFFER_BYTES,
  MAX_SSE_BUFFER_SIZE,
  MAX_SSE_BUFFER_TTL_MS,
  SSE_BUFFER_CLEANUP_INTERVAL_MS,
} from '../lib/constants'

interface SSEClient {
  id: string
  send: (event: string, data: string, id: string) => void
  close: () => void
  interval?: ReturnType<typeof setInterval>
}

interface BufferedSSEEvent {
  id: string
  event: string
  data: string
  timestamp: number
  sizeBytes: number
  entryId?: string
  op?: string
  streaming?: boolean
}

interface SSEBroadcasterOptions {
  maxBufferSize?: number
  maxBufferBytes?: number
  bufferTtlMs?: number
}

class SSEBroadcaster {
  private clients = new Map<string, SSEClient[]>()
  private eventCounter = Date.now()
  private eventBuffer = new Map<string, BufferedSSEEvent[]>()
  private readonly maxBufferSize: number
  private readonly maxBufferBytes: number
  private readonly bufferTtlMs: number
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor(options: SSEBroadcasterOptions = {}) {
    this.maxBufferSize = options.maxBufferSize ?? MAX_SSE_BUFFER_SIZE
    this.maxBufferBytes = options.maxBufferBytes ?? MAX_SSE_BUFFER_BYTES
    this.bufferTtlMs = options.bufferTtlMs ?? MAX_SSE_BUFFER_TTL_MS
  }

  startAutoCleanup() {
    if (this.cleanupInterval) return
    this.cleanupInterval = setInterval(() => this.cleanup(), SSE_BUFFER_CLEANUP_INTERVAL_MS)
    // Allow the Node process to exit even if the interval is still active
    if (this.cleanupInterval && typeof this.cleanupInterval === 'object' && 'unref' in this.cleanupInterval) {
      this.cleanupInterval.unref()
    }
  }

  stopAutoCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }

  addClient(ticketId: string, client: SSEClient) {
    const existing = this.clients.get(ticketId) ?? []
    existing.push(client)
    this.clients.set(ticketId, existing)
  }

  removeClient(ticketId: string, clientId: string) {
    const existing = this.clients.get(ticketId)
    if (existing) {
      const filtered = existing.filter(c => c.id !== clientId)
      if (filtered.length === 0) {
        this.clients.delete(ticketId)
      } else {
        this.clients.set(ticketId, filtered)
      }
    }
  }

  broadcast(ticketId: string, event: SSEEventType, data: Record<string, unknown>) {
    const id = String(++this.eventCounter)
    const timestamp = typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString()
    const payload = JSON.stringify({ ...data, timestamp })

    this.bufferEvent(ticketId, {
      id,
      event,
      data: payload,
      timestamp: Date.now(),
      sizeBytes: Buffer.byteLength(payload),
      ...(typeof data.entryId === 'string' ? { entryId: data.entryId } : {}),
      ...(typeof data.op === 'string' ? { op: data.op } : {}),
      ...(typeof data.streaming === 'boolean' ? { streaming: data.streaming } : {}),
    })

    // Broadcast to all connected clients for this ticket
    const clients = this.clients.get(ticketId) ?? []
    for (const client of clients) {
      try {
        client.send(event, payload, id)
      } catch {
        this.removeClient(ticketId, client.id)
      }
    }
  }

  // Replay events since lastEventId
  getEventsSince(ticketId: string, lastEventId: string): { id: string; event: string; data: string }[] {
    const buffer = this.eventBuffer.get(ticketId) ?? []
    const lastId = parseInt(lastEventId, 10)
    if (isNaN(lastId)) return buffer
    return buffer.filter(e => parseInt(e.id, 10) > lastId)
  }

  getClientCount(ticketId: string): number {
    return (this.clients.get(ticketId) ?? []).length
  }

  getTotalClientCount(): number {
    let total = 0
    for (const clients of this.clients.values()) {
      total += clients.length
    }
    return total
  }

  clearTicket(ticketId: string) {
    const clients = this.clients.get(ticketId) ?? []
    for (const client of clients) {
      if (client.interval) {
        clearInterval(client.interval)
      }
      try {
        client.close()
      } catch {
        // Ignore close errors during cleanup.
      }
    }

    this.clients.delete(ticketId)
    this.eventBuffer.delete(ticketId)
  }

  // Cleanup expired buffer entries
  cleanup() {
    const now = Date.now()
    for (const [ticketId, buffer] of this.eventBuffer) {
      const filtered = buffer.filter(e => now - e.timestamp < this.bufferTtlMs)
      this.setOrDeleteBuffer(ticketId, filtered)
    }
  }

  private bufferEvent(ticketId: string, nextEvent: BufferedSSEEvent) {
    const buffer = [...(this.eventBuffer.get(ticketId) ?? [])]

    if (nextEvent.entryId) {
      if (nextEvent.op === 'finalize') {
        this.removeStreamingUpsert(buffer, nextEvent.entryId)
      } else if (nextEvent.op === 'upsert' && nextEvent.streaming) {
        const existingIndex = buffer.findIndex((candidate) =>
          candidate.entryId === nextEvent.entryId
          && candidate.op === 'upsert'
          && candidate.streaming === true,
        )

        if (existingIndex >= 0) {
          buffer[existingIndex] = nextEvent
        } else {
          buffer.push(nextEvent)
        }

        this.trimBuffer(buffer)
        this.setOrDeleteBuffer(ticketId, buffer)
        return
      }
    }

    buffer.push(nextEvent)
    this.trimBuffer(buffer)
    this.setOrDeleteBuffer(ticketId, buffer)
  }

  private removeStreamingUpsert(buffer: BufferedSSEEvent[], entryId: string) {
    const next = buffer.filter((candidate) =>
      !(candidate.entryId === entryId && candidate.op === 'upsert' && candidate.streaming === true),
    )
    buffer.splice(0, buffer.length, ...next)
  }

  private trimBuffer(buffer: BufferedSSEEvent[]) {
    while (buffer.length > this.maxBufferSize) {
      buffer.shift()
    }

    while (buffer.length > 1 && this.getBufferBytes(buffer) > this.maxBufferBytes) {
      buffer.shift()
    }
  }

  private getBufferBytes(buffer: BufferedSSEEvent[]) {
    return buffer.reduce((total, event) => total + event.sizeBytes, 0)
  }

  private setOrDeleteBuffer(ticketId: string, buffer: BufferedSSEEvent[]) {
    if (buffer.length === 0) {
      this.eventBuffer.delete(ticketId)
      return
    }

    this.eventBuffer.set(ticketId, buffer)
  }
}

export const broadcaster = new SSEBroadcaster()
export { SSEBroadcaster }
