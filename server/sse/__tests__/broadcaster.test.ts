import { afterEach, describe, expect, it, vi } from 'vitest'
import { broadcaster, SSEBroadcaster } from '../broadcaster'
import { cleanupStreamClient } from '../../routes/stream'

function markReplayStart(broadcaster: SSEBroadcaster): string {
  const send = vi.fn()
  broadcaster.addClient('1:T-42', { id: 'cursor', send, close: () => undefined })
  broadcaster.broadcast('1:T-42', 'progress', {})
  return send.mock.calls[0]![2] as string
}

describe('SSEBroadcaster', () => {
  afterEach(() => {
    broadcaster.clearTicket('1:T-HEARTBEAT')
    vi.restoreAllMocks()
  })

  it('preserves a provided timestamp in the SSE payload', () => {
    const sent = vi.fn()
    const broadcaster = new SSEBroadcaster()
    const timestamp = '2026-03-13T12:00:00.000Z'

    broadcaster.addClient('1:T-42', {
      id: 'client-1',
      send: sent,
      close: () => undefined,
    })

    broadcaster.broadcast('1:T-42', 'log', {
      type: 'info',
      content: 'Log message',
      timestamp,
    })

    expect(sent).toHaveBeenCalledTimes(1)
    const [, payload] = sent.mock.calls[0] as [string, string, string]
    expect(JSON.parse(payload)).toMatchObject({ timestamp })
  })

  it('keeps only the latest streaming upsert per entry in the replay buffer', () => {
    const broadcaster = new SSEBroadcaster()
    const cursor = markReplayStart(broadcaster)

    broadcaster.broadcast('1:T-42', 'log', {
      entryId: 'session-1:message-1:text',
      op: 'upsert',
      streaming: true,
      content: 'first chunk',
    })
    broadcaster.broadcast('1:T-42', 'log', {
      entryId: 'session-1:message-1:text',
      op: 'upsert',
      streaming: true,
      content: 'second chunk',
    })

    const { events: replay, gap } = broadcaster.getEventsSince('1:T-42', cursor)
    expect(gap).toBeNull()

    expect(replay).toHaveLength(1)
    expect(JSON.parse(replay[0]!.data)).toMatchObject({
      entryId: 'session-1:message-1:text',
      op: 'upsert',
      streaming: true,
      content: 'second chunk',
    })
  })

  it('replaces a buffered streaming upsert with the finalize event for the same entry', () => {
    const broadcaster = new SSEBroadcaster()
    const cursor = markReplayStart(broadcaster)

    broadcaster.broadcast('1:T-42', 'log', {
      entryId: 'session-1:message-1:text',
      op: 'upsert',
      streaming: true,
      content: 'partial text',
    })
    broadcaster.broadcast('1:T-42', 'log', {
      entryId: 'session-1:message-1:text',
      op: 'finalize',
      streaming: false,
      content: 'final text',
    })

    const { events: replay, gap } = broadcaster.getEventsSince('1:T-42', cursor)
    expect(gap).toBeNull()

    expect(replay).toHaveLength(1)
    expect(JSON.parse(replay[0]!.data)).toMatchObject({
      entryId: 'session-1:message-1:text',
      op: 'finalize',
      streaming: false,
      content: 'final text',
    })
  })

  it('drops the oldest replay entries when the per-ticket byte budget is exceeded', () => {
    const broadcaster = new SSEBroadcaster({ maxBufferBytes: 140 })
    const cursor = markReplayStart(broadcaster)

    broadcaster.broadcast('1:T-42', 'log', {
      entryId: 'entry-1',
      op: 'append',
      streaming: false,
      content: 'a'.repeat(40),
    })
    broadcaster.broadcast('1:T-42', 'log', {
      entryId: 'entry-2',
      op: 'append',
      streaming: false,
      content: 'b'.repeat(40),
    })
    broadcaster.broadcast('1:T-42', 'log', {
      entryId: 'entry-3',
      op: 'append',
      streaming: false,
      content: 'c'.repeat(40),
    })

    expect(broadcaster.getEventsSince('1:T-42', cursor)).toEqual({ events: [], gap: 'cursor_unavailable' })
    expect(broadcaster.getEventsSince('1:T-42', String(Number(cursor) + 2)).gap).toBe('cursor_unavailable')
    expect(broadcaster.getEventsSince('1:T-42', String(Number(cursor) + 3))).toEqual({ events: [], gap: null })
  })

  it.each(['-1', '1.5', '9007199254740992', '123456789012345678901', 'invalid', '1x', '1\n', '', '01'])('reports invalid cursor %j without replaying the buffer', (cursor) => {
    const broadcaster = new SSEBroadcaster()
    markReplayStart(broadcaster)
    expect(broadcaster.getEventsSince('1:T-42', cursor)).toEqual({ events: [], gap: 'invalid_cursor' })
  })

  it('reports absent, future, expired, and evicted cursors as gaps', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const broadcaster = new SSEBroadcaster({ maxBufferSize: 1, bufferTtlMs: 100 })
    const cursor = markReplayStart(broadcaster)
    expect(broadcaster.getEventsSince('other-ticket', cursor).gap).toBe('cursor_unavailable')
    expect(broadcaster.getEventsSince('1:T-42', '9007199254740991').gap).toBe('cursor_unavailable')
    expect(broadcaster.getEventsSince('1:T-42', cursor)).toEqual({ events: [], gap: null })
    broadcaster.broadcast('1:T-42', 'progress', {})
    expect(broadcaster.getEventsSince('1:T-42', cursor).gap).toBe('cursor_unavailable')
    clock.mockReturnValue(1_099)
    expect(broadcaster.getEventsSince('1:T-42', String(Number(cursor) + 1)).gap).toBeNull()
    clock.mockReturnValue(1_100)
    expect(broadcaster.getEventsSince('1:T-42', String(Number(cursor) + 1)).gap).toBe('cursor_unavailable')
  })

  it('replays coalesced entries in increasing ID order', () => {
    const broadcaster = new SSEBroadcaster()
    const cursor = markReplayStart(broadcaster)
    broadcaster.broadcast('1:T-42', 'log', { entryId: 'streaming', op: 'upsert', streaming: true })
    broadcaster.broadcast('1:T-42', 'progress', { content: 'between chunks' })
    broadcaster.broadcast('1:T-42', 'log', { entryId: 'streaming', op: 'upsert', streaming: true })
    const replay = broadcaster.getEventsSince('1:T-42', cursor)
    expect(replay.gap).toBeNull()
    expect(replay.events.map(event => event.event)).toEqual(['progress', 'log'])
  })

  it('removes a route client when heartbeat cleanup runs after a write failure', () => {
    const interval = setInterval(() => undefined, 1_000)
    broadcaster.addClient('1:T-HEARTBEAT', {
      id: 'client-heartbeat',
      send: vi.fn(),
      close: vi.fn(),
    })

    cleanupStreamClient('1:T-HEARTBEAT', 'client-heartbeat', interval)

    expect(broadcaster.getClientCount('1:T-HEARTBEAT')).toBe(0)
  })
})
