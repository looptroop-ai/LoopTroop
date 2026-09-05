import { afterEach, describe, expect, it, vi } from 'vitest'
import { broadcaster, SSEBroadcaster } from '../broadcaster'
import { cleanupStreamClient } from '../../routes/stream'

describe('SSEBroadcaster', () => {
  afterEach(() => {
    broadcaster.clearTicket('1:T-HEARTBEAT')
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

    const replay = broadcaster.getEventsSince('1:T-42', '0')

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

    const replay = broadcaster.getEventsSince('1:T-42', '0')

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

    const replay = broadcaster.getEventsSince('1:T-42', '0')
    const replayIds = replay.map((event) => JSON.parse(event.data).entryId)

    expect(replayIds).toEqual(['entry-3'])
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
