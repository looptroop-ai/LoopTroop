import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { SSEStreamingApi } from 'hono/streaming'
import { initializeDatabase } from '../../db/init'
import { sqlite } from '../../db/index'
import { clearProjectDatabaseCache } from '../../db/project'
import { attachProject } from '../../storage/projects'
import { createTicket } from '../../storage/tickets'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { broadcaster } from '../../sse/broadcaster'
import { MAX_SSE_CONNECTIONS_PER_TICKET, MAX_SSE_CONNECTIONS_TOTAL, streamRouter } from '../stream'

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-stream-route-',
  files: {
    'README.md': '# LoopTroop Stream Route Test\n',
  },
})

function createStreamRouteTicket() {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: 'Stream Route',
    shortname: 'SSE',
  })
  return createTicket({
    projectId: project.id,
    title: 'Stream ticket',
    description: 'Regression coverage for stream validation.',
  })
}

describe('streamRouter', () => {
  const app = new Hono()
  app.route('/api', streamRouter)

  beforeEach(() => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('rejects unknown ticket IDs before opening an SSE stream', async () => {
    const response = await app.request('/api/stream?ticketId=1:SSE-999999')

    expect(response.status).toBe(404)
  })

  it.each(['missing-ticket', '1:SSE-1\n', '1:SSE-1\r', '1:SSE-1/../other', '0:SSE-1', '-1:SSE-1', '1.5:SSE-1', '9007199254740992:SSE-1', '1:SSE-9007199254740992'])('rejects malformed ticket reference %j before lookup', async (ticketId) => {
    const response = await app.request(`/api/stream?ticketId=${encodeURIComponent(ticketId)}`)
    expect(response.status).toBe(400)
  })

  it.each(['1\n', '1\r', '1\0', '1'.repeat(129)])('rejects unsafe cursor %j before opening a stream', async (cursor) => {
    const ticket = createStreamRouteTicket()
    const response = await app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}&lastEventId=${encodeURIComponent(cursor)}`)
    expect(response.status).toBe(400)
    expect(broadcaster.getClientCount(ticket.id)).toBe(0)
  })

  it.each(['-1', '1.5', '9007199254740992', '123456789012345678901', 'invalid', ''])('recovers bounded invalid cursor %j with an explicit gap', async (cursor) => {
    const ticket = createStreamRouteTicket()
    const response = await app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}&lastEventId=${encodeURIComponent(cursor)}`)
    const reader = response.body!.getReader()
    try {
      expect(response.status).toBe(200)
      await reader.read()
      const gap = new TextDecoder().decode((await reader.read()).value)
      expect(gap).toContain('event: replay_gap\n')
      expect(gap).toContain('"reason":"invalid_cursor"')
    } finally {
      await reader.cancel()
      broadcaster.clearTicket(ticket.id)
    }
  })

  it('validates the header cursor and gives it precedence over the query', async () => {
    const ticket = createStreamRouteTicket()
    const response = await app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}&lastEventId=0`, {
      headers: { 'Last-Event-ID': 'invalid' },
    })
    const reader = response.body!.getReader()
    try {
      await reader.read()
      const gap = new TextDecoder().decode((await reader.read()).value)
      expect(gap).toContain('"reason":"invalid_cursor"')
    } finally {
      await reader.cancel()
      broadcaster.clearTicket(ticket.id)
    }
  })

  it('rejects streams over the per-ticket connection cap', async () => {
    const ticket = createStreamRouteTicket()
    for (let index = 0; index < MAX_SSE_CONNECTIONS_PER_TICKET; index += 1) {
      broadcaster.addClient(ticket.id, {
        id: `client-${index}`,
        send: vi.fn(),
        close: vi.fn(),
      })
    }

    const response = await app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}`)

    expect(response.status).toBe(429)
    broadcaster.clearTicket(ticket.id)
  })

  it('reserves per-ticket slots before opening a concurrent burst and releases them on abort', async () => {
    const ticket = createStreamRouteTicket()
    const responses = await Promise.all(Array.from({ length: 10 }, () =>
      app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}`),
    ))

    expect(responses.filter(response => response.status === 200)).toHaveLength(MAX_SSE_CONNECTIONS_PER_TICKET)
    expect(responses.filter(response => response.status === 429)).toHaveLength(4)
    expect(broadcaster.getClientCount(ticket.id)).toBe(MAX_SSE_CONNECTIONS_PER_TICKET)
    expect(broadcaster.getTotalClientCount()).toBe(MAX_SSE_CONNECTIONS_PER_TICKET)

    await Promise.all(responses
      .filter(response => response.status === 200)
      .map(async response => {
        const reader = response.body!.getReader()
        await reader.read()
        await reader.cancel()
      }))

    expect(broadcaster.getClientCount(ticket.id)).toBe(0)
    expect(broadcaster.getTotalClientCount()).toBe(0)
  })

  it('enforces the global stream cap from the same broadcaster registry', async () => {
    const ticket = createStreamRouteTicket()
    const seededTicketIds = Array.from({ length: MAX_SSE_CONNECTIONS_TOTAL }, (_, index) => `seed-${index}`)
    for (const [index, seededTicketId] of seededTicketIds.entries()) {
      broadcaster.addClient(seededTicketId, {
        id: `client-${index}`,
        send: vi.fn(),
        close: vi.fn(),
      })
    }

    try {
      const response = await app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}`)
      expect(response.status).toBe(429)
      expect(await response.json()).toMatchObject({ error: 'Too many active streams' })
      expect(broadcaster.getTotalClientCount()).toBe(MAX_SSE_CONNECTIONS_TOTAL)
    } finally {
      for (const seededTicketId of seededTicketIds) broadcaster.clearTicket(seededTicketId)
      broadcaster.clearTicket(ticket.id)
    }

    expect(broadcaster.getTotalClientCount()).toBe(0)
  })

  it('enforces the global cap for 120 concurrent HTTP streams', async () => {
    const tickets = Array.from({ length: 20 }, () => createStreamRouteTicket())
    const responses = await Promise.all(tickets.flatMap(ticket =>
      Array.from({ length: MAX_SSE_CONNECTIONS_PER_TICKET }, () =>
        app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}`),
      ),
    ))

    expect(responses.filter(response => response.status === 200)).toHaveLength(MAX_SSE_CONNECTIONS_TOTAL)
    expect(responses.filter(response => response.status === 429)).toHaveLength(20)

    try {
      await Promise.all(responses
        .filter(response => response.status === 200)
        .map(async response => {
          const reader = response.body!.getReader()
          await reader.read()
          await reader.cancel()
        }))
    } finally {
      for (const ticket of tickets) broadcaster.clearTicket(ticket.id)
    }

    expect(broadcaster.getTotalClientCount()).toBe(0)
  })

  it('releases a reserved slot when the initial SSE write fails', async () => {
    const ticket = createStreamRouteTicket()
    vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockRejectedValueOnce(new Error('Failed to open stream'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}`)
    await response.body?.cancel()
    await Promise.resolve()

    expect(broadcaster.getClientCount(ticket.id)).toBe(0)
    expect(broadcaster.getTotalClientCount()).toBe(0)
  })

  it('releases a reservation when the request is already aborted before opening', async () => {
    const ticket = createStreamRouteTicket()
    const controller = new AbortController()
    controller.abort()

    const response = await app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}`, { signal: controller.signal })

    expect(response.status).toBe(499)
    expect(broadcaster.getClientCount(ticket.id)).toBe(0)
    expect(broadcaster.getTotalClientCount()).toBe(0)
  })

  it('keeps a deferred reservation counted until the broadcaster client activates', async () => {
    const ticket = createStreamRouteTicket()
    const clientId = 'deferred-open'
    expect(broadcaster.reserveClient(ticket.id, clientId, MAX_SSE_CONNECTIONS_PER_TICKET, MAX_SSE_CONNECTIONS_TOTAL)).toBe(true)
    expect(broadcaster.getClientCount(ticket.id)).toBe(1)

    await Promise.resolve()
    expect(broadcaster.getClientCount(ticket.id)).toBe(1)
    expect(broadcaster.activateClient(ticket.id, {
      id: clientId,
      send: vi.fn(),
      close: vi.fn(),
    })).toBe(true)

    broadcaster.removeClient(ticket.id, clientId)
    expect(broadcaster.getClientCount(ticket.id)).toBe(0)
  })

  it('releases a reservation when opening throws synchronously', async () => {
    const ticket = createStreamRouteTicket()
    vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementationOnce(() => {
      throw new Error('Synchronous open failure')
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}`)
    await response.body?.cancel()
    await Promise.resolve()

    expect(broadcaster.getClientCount(ticket.id)).toBe(0)
    expect(broadcaster.getTotalClientCount()).toBe(0)
  })

  it('signals an unavailable replay cursor, resets the native cursor, and keeps delivering live events', async () => {
    const ticket = createStreamRouteTicket()
    const response = await app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}&lastEventId=9007199254740991`)
    const reader = response.body!.getReader()
    try {
      const connected = new TextDecoder().decode((await reader.read()).value)
      expect(connected).toContain('event: connected\n')
      expect(connected).not.toContain('\nid:')
      const gap = new TextDecoder().decode((await reader.read()).value)
      expect(gap).toContain('event: replay_gap\n')
      expect(gap).toContain(`"ticketId":"${ticket.id}","reason":"cursor_unavailable"`)
      expect(gap).toContain('\nid: \n\n')
      broadcaster.broadcast(ticket.id, 'progress', { content: 'live after gap' })
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('live after gap')
    } finally {
      await reader.cancel()
      broadcaster.clearTicket(ticket.id)
    }
    expect(broadcaster.getClientCount(ticket.id)).toBe(0)
  })

  it('delivers replay before live events published while the handshake is being read', async () => {
    const ticket = createStreamRouteTicket()
    const send = vi.fn()
    broadcaster.addClient(ticket.id, { id: 'capture', send, close: () => undefined })
    broadcaster.broadcast(ticket.id, 'progress', { content: 'seen' })
    const cursor = send.mock.calls[0]![2] as string
    broadcaster.removeClient(ticket.id, 'capture')
    broadcaster.broadcast(ticket.id, 'progress', { content: 'replayed' })
    const response = await app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}&lastEventId=${cursor}`)
    broadcaster.broadcast(ticket.id, 'progress', { content: 'live' })
    const reader = response.body!.getReader()
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: connected\n')
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"content":"replayed"')
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"content":"live"')
    } finally {
      await reader.cancel()
      broadcaster.clearTicket(ticket.id)
    }
  })

  it.each(['reader cancellation', 'live write', 'heartbeat', 'ticket cleanup'])('closes the stream and releases its heartbeat after %s failure or shutdown', async (trigger) => {
    const ticket = createStreamRouteTicket()
    vi.useFakeTimers()
    const response = await app.request(`/api/stream?ticketId=${encodeURIComponent(ticket.id)}`)
    const reader = response.body!.getReader()
    try {
      await reader.read()
      expect(broadcaster.getClientCount(ticket.id)).toBe(1)
      expect(vi.getTimerCount()).toBe(1)
      if (trigger === 'reader cancellation') {
        // Real transport cancellation invokes Hono's abort hook; its write API
        // swallows I/O errors, so rejected-write mocks alone cannot cover this.
        await reader.cancel()
      } else if (trigger === 'ticket cleanup') {
        broadcaster.clearTicket(ticket.id)
      } else {
        vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockRejectedValueOnce(new Error('Disconnected'))
        if (trigger === 'heartbeat') await vi.advanceTimersByTimeAsync(30_000)
        else broadcaster.broadcast(ticket.id, 'progress', { content: 'live' })
      }
      expect((await reader.read()).done).toBe(true)
      expect(broadcaster.getClientCount(ticket.id)).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await reader.cancel()
      broadcaster.clearTicket(ticket.id)
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })
})
