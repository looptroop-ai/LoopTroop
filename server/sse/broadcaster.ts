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

interface StoredSSEClient extends SSEClient {
  scopeId: symbol
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

export interface SSEBroadcasterLike {
  addClient: (ticketId: string, client: SSEClient) => boolean
  removeClient: (ticketId: string, clientId: string) => void
  reserveClient: (ticketId: string, clientId: string, maxPerTicket: number, maxTotal: number) => boolean
  activateClient: (ticketId: string, client: SSEClient) => boolean
  getClientCount: (ticketId: string) => number
  getTotalClientCount: () => number
  getEventsSince: (ticketId: string, lastEventId: string) =>
    | { events: BufferedSSEEvent[]; gap: null }
    | { events: []; gap: 'invalid_cursor' | 'cursor_unavailable' }
}

export interface SSEBroadcasterScope extends SSEBroadcasterLike {
  startAcceptingClients: () => void
  closeAllClients: () => void
  startAutoCleanup: () => void
  stopAutoCleanup: () => void
}

interface ScopeState {
  acceptingClients: boolean
  cleanupActive: boolean
}

class SSEBroadcaster {
  private clients = new Map<string, StoredSSEClient[]>()
  private eventCounter = Date.now()
  private eventBuffer = new Map<string, BufferedSSEEvent[]>()
  private readonly maxBufferSize: number
  private readonly maxBufferBytes: number
  private readonly bufferTtlMs: number
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private readonly defaultScope = Symbol('default-sse-scope')
  private readonly scopes = new Map<symbol, ScopeState>()
  private cleanupOwners = 0

  constructor(options: SSEBroadcasterOptions = {}) {
    this.maxBufferSize = options.maxBufferSize ?? MAX_SSE_BUFFER_SIZE
    this.maxBufferBytes = options.maxBufferBytes ?? MAX_SSE_BUFFER_BYTES
    this.bufferTtlMs = options.bufferTtlMs ?? MAX_SSE_BUFFER_TTL_MS
    this.scopes.set(this.defaultScope, { acceptingClients: true, cleanupActive: false })
  }

  startAutoCleanup(scopeId = this.defaultScope) {
    const scope = this.scopes.get(scopeId)
    if (!scope || scope.cleanupActive) return
    scope.cleanupActive = true
    this.cleanupOwners += 1
    if (this.cleanupInterval) return
    this.cleanupInterval = setInterval(() => this.cleanup(), SSE_BUFFER_CLEANUP_INTERVAL_MS)
    // Allow the Node process to exit even if the interval is still active
    if (this.cleanupInterval && typeof this.cleanupInterval === 'object' && 'unref' in this.cleanupInterval) {
      this.cleanupInterval.unref()
    }
  }

  stopAutoCleanup(scopeId = this.defaultScope) {
    const scope = this.scopes.get(scopeId)
    if (!scope?.cleanupActive) return
    scope.cleanupActive = false
    this.cleanupOwners -= 1
    if (this.cleanupOwners > 0 || !this.cleanupInterval) return
    clearInterval(this.cleanupInterval)
    this.cleanupInterval = null
  }

  createScope(): SSEBroadcasterScope {
    const scopeId = Symbol('runtime-sse-scope')
    this.scopes.set(scopeId, { acceptingClients: true, cleanupActive: false })
    return {
      addClient: (ticketId, client) => this.addClientInScope(scopeId, ticketId, client),
      removeClient: (ticketId, clientId) => this.removeClientInScope(scopeId, ticketId, clientId),
      reserveClient: (ticketId, clientId, maxPerTicket, maxTotal) => this.reserveClientInScope(scopeId, ticketId, clientId, maxPerTicket, maxTotal),
      activateClient: (ticketId, client) => this.activateClientInScope(scopeId, ticketId, client),
      getClientCount: (ticketId) => this.getClientCountInScope(scopeId, ticketId),
      // The total stream cap is process-wide even when admission is scoped to
      // an embedded runtime; otherwise each runtime could independently admit
      // the full global limit.
      getTotalClientCount: () => this.getTotalClientCount(),
      getEventsSince: (ticketId, lastEventId) => this.getEventsSince(ticketId, lastEventId),
      startAcceptingClients: () => this.startAcceptingClients(scopeId),
      closeAllClients: () => this.closeAllClients(scopeId),
      startAutoCleanup: () => this.startAutoCleanup(scopeId),
      stopAutoCleanup: () => this.stopAutoCleanup(scopeId),
    }
  }

  addClient(ticketId: string, client: SSEClient): boolean {
    return this.addClientInScope(this.defaultScope, ticketId, client)
  }

  private addClientInScope(scopeId: symbol, ticketId: string, client: SSEClient): boolean {
    if (!this.scopes.get(scopeId)?.acceptingClients) return false
    const existing = this.clients.get(ticketId) ?? []
    existing.push({ ...client, scopeId })
    this.clients.set(ticketId, existing)
    return true
  }

  reserveClient(ticketId: string, clientId: string, maxPerTicket: number, maxTotal: number): boolean {
    return this.reserveClientInScope(this.defaultScope, ticketId, clientId, maxPerTicket, maxTotal)
  }

  private reserveClientInScope(scopeId: symbol, ticketId: string, clientId: string, maxPerTicket: number, maxTotal: number): boolean {
    if (this.getClientCountInScope(scopeId, ticketId) >= maxPerTicket || this.getTotalClientCount() >= maxTotal) return false
    return this.addClientInScope(scopeId, ticketId, { id: clientId, send: () => undefined, close: () => undefined })
  }

  activateClient(ticketId: string, client: SSEClient): boolean {
    return this.activateClientInScope(this.defaultScope, ticketId, client)
  }

  private activateClientInScope(scopeId: symbol, ticketId: string, client: SSEClient): boolean {
    const existing = this.clients.get(ticketId)
    const index = existing?.findIndex(candidate => candidate.id === client.id && candidate.scopeId === scopeId) ?? -1
    if (!existing || index < 0) return false
    existing[index] = { ...client, scopeId }
    return true
  }

  /** Opens stream admission for a newly started runtime. */
  startAcceptingClients(scopeId = this.defaultScope) {
    const scope = this.scopes.get(scopeId)
    if (scope) scope.acceptingClients = true
  }

  removeClient(ticketId: string, clientId: string) {
    this.removeClientInScope(this.defaultScope, ticketId, clientId)
  }

  private removeClientInScope(scopeId: symbol, ticketId: string, clientId: string) {
    const existing = this.clients.get(ticketId)
    if (existing) {
      const filtered = existing.filter(c => c.id !== clientId || c.scopeId !== scopeId)
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
        this.removeClientInScope(client.scopeId, ticketId, client.id)
      }
    }
  }

  // A missing cursor cannot prove continuity (eviction, coalescing, or daemon restart).
  getEventsSince(ticketId: string, lastEventId: string):
    | { events: BufferedSSEEvent[]; gap: null }
    | { events: []; gap: 'invalid_cursor' | 'cursor_unavailable' } {
    if (!/^(0|[1-9]\d{0,15})$/.test(lastEventId) || !Number.isSafeInteger(Number(lastEventId))) {
      return { events: [], gap: 'invalid_cursor' }
    }
    const buffer = (this.eventBuffer.get(ticketId) ?? [])
      .filter(event => Date.now() - event.timestamp < this.bufferTtlMs)
    if (!buffer.some(event => event.id === lastEventId)) {
      return { events: [], gap: 'cursor_unavailable' }
    }
    return {
      events: buffer.filter(event => Number(event.id) > Number(lastEventId)),
      gap: null,
    }
  }

  getClientCount(ticketId: string): number {
    return this.getClientCountInScope(this.defaultScope, ticketId)
  }

  getTotalClientCount(): number {
    let total = 0
    for (const clients of this.clients.values()) total += clients.length
    return total
  }

  private getClientCountInScope(scopeId: symbol, ticketId: string): number {
    return (this.clients.get(ticketId) ?? []).filter(client => client.scopeId === scopeId).length
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

  /** Closes every live stream without discarding replay buffers. */
  closeAllClients(scopeId?: symbol) {
    if (scopeId === undefined) {
      for (const scope of this.scopes.values()) scope.acceptingClients = false
    } else {
      const scope = this.scopes.get(scopeId)
      if (scope) scope.acceptingClients = false
    }

    for (const [ticketId, clients] of this.clients) {
      const remaining: StoredSSEClient[] = []
      for (const client of clients) {
        if (scopeId !== undefined && client.scopeId !== scopeId) {
          remaining.push(client)
          continue
        }
        if (client.interval) {
          clearInterval(client.interval)
        }
        try {
          client.close()
        } catch {
          // Ignore close errors during runtime shutdown.
        }
      }
      if (remaining.length === 0) this.clients.delete(ticketId)
      else this.clients.set(ticketId, remaining)
    }
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
          buffer.splice(existingIndex, 1)
        }
        // Keep ID order so eviction always removes the oldest event.
        buffer.push(nextEvent)

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
