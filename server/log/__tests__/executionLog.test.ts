import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendLogEvent, clearTicketFingerprints, createLogEvent, shouldSkipLogEmission } from '../executionLog'
import * as ticketsModule from '../../storage/tickets'
import * as atomicAppendModule from '../../io/atomicAppend'

const mockGetTicketPaths = vi.spyOn(ticketsModule, 'getTicketPaths').mockReturnValue({
  projectRoot: '/tmp/test-project',
  executionLogPath: '/tmp/test-execution-log.jsonl',
  debugLogPath: '/tmp/test-execution-log.debug.jsonl',
  aiLogPath: '/tmp/test-execution-log.ai.jsonl',
  worktreePath: '/tmp/test-worktree',
  ticketDir: '/tmp/test-ticket-dir',
  executionSetupDir: '/tmp/test-ticket-dir/.ticket/runtime/execution-setup',
  executionSetupProfilePath: '/tmp/test-ticket-dir/.ticket/runtime/execution-setup-profile.json',
  baseBranch: 'main',
  beadsPath: '/tmp/test-beads.jsonl',
})

const mockAppend = vi.spyOn(atomicAppendModule, 'safeAtomicAppend').mockImplementation((_path, line) => ({
  offset: 0,
  length: Buffer.byteLength(`${line}\n`),
}))

describe('createLogEvent', () => {
  it('preserves a provided timestamp so live and persisted log entries stay aligned', () => {
    const timestamp = '2026-03-13T12:00:00.000Z'

    const event = createLogEvent(
      '1:T-42',
      'info',
      'CODING',
      'Log message',
      { timestamp },
      'system',
      'CODING',
    )

    expect(event.timestamp).toBe(timestamp)
  })
})

describe('appendLogEvent', () => {
  beforeEach(() => {
    vi.useRealTimers()
    mockAppend.mockClear()
    mockGetTicketPaths.mockClear()
    clearTicketFingerprints('1:T-42')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not persist streaming upserts to disk', () => {
    appendLogEvent(
      '1:T-42',
      'model_output',
      'CODING',
      'partial content',
      { timestamp: '2026-03-13T12:00:00.000Z' },
      undefined,
      'CODING',
      { op: 'upsert', streaming: true, entryId: 'session:part1' },
    )

    expect(mockAppend).not.toHaveBeenCalled()
  })

  it('keeps AI streaming upserts live-only until a final row is emitted', () => {
    appendLogEvent(
      '1:T-42',
      'model_output',
      'CODING',
      'thinking about the implementation',
      { timestamp: '2026-03-13T12:00:00.000Z' },
      'opencode',
      'CODING',
      {
        audience: 'ai',
        kind: 'reasoning',
        op: 'upsert',
        streaming: true,
        entryId: 'session:thinking',
      },
    )

    expect(mockAppend).not.toHaveBeenCalled()
  })

  it('persists finalize events to disk', () => {

    appendLogEvent(
      '1:T-42',
      'model_output',
      'CODING',
      'final content',
      { timestamp: '2026-03-13T12:00:00.000Z' },
      undefined,
      'CODING',
      { op: 'finalize', entryId: 'session:part1', streaming: false },
    )

    expect(mockAppend).toHaveBeenCalledOnce()
    const written = JSON.parse(mockAppend.mock.calls[0]![1]!)
    expect(written.op).toBe('finalize')
    expect(written.content).toBe('final content')
  })

  it('persists finalized AI rows to both AI detail and normal logs', () => {
    appendLogEvent(
      '1:T-42',
      'model_output',
      'CODING',
      'final model output',
      { timestamp: '2026-03-13T12:00:00.000Z' },
      'opencode',
      'CODING',
      {
        audience: 'ai',
        kind: 'text',
        op: 'finalize',
        entryId: 'session:output',
        streaming: false,
      },
    )

    expect(mockAppend).toHaveBeenCalledTimes(2)
    expect(mockAppend.mock.calls.map((call) => call[0])).toEqual([
      '/tmp/test-execution-log.ai.jsonl',
      '/tmp/test-execution-log.jsonl',
    ])
  })

  it('strips redundant structured fields and internal flags from persisted data', () => {

    appendLogEvent(
      '1:T-42',
      'info',
      'CODING',
      'some log',
      {
        timestamp: '2026-03-13T12:00:00.000Z',
        suppressDebugMirror: true,
        entryId: 'e1',
        sessionId: 's1',
        beadId: 'bead-1',
        beadIteration: 2,
        source: 'opencode',
        modelId: 'm1',
        timeoutMs: 1_200_000,
        deadlineAt: '2026-03-13T12:20:00.000Z',
        timeoutKind: 'council_response',
        streaming: false,
        audience: 'all',
        kind: 'milestone',
        op: 'append',
        customField: 'keep-this',
      },
      'system',
      'CODING',
    )

    expect(mockAppend).toHaveBeenCalledOnce()
    const written = JSON.parse(mockAppend.mock.calls[0]![1]!)
    // Internal flag and redundant timestamp should be gone
    expect(written.data?.suppressDebugMirror).toBeUndefined()
    expect(written.data?.timestamp).toBeUndefined()
    // Structured keys should be gone from data (they're top-level)
    expect(written.data?.entryId).toBeUndefined()
    expect(written.data?.sessionId).toBeUndefined()
    expect(written.data?.beadId).toBeUndefined()
    expect(written.data?.beadIteration).toBeUndefined()
    expect(written.data?.source).toBeUndefined()
    expect(written.data?.timeoutMs).toBeUndefined()
    expect(written.data?.deadlineAt).toBeUndefined()
    expect(written.data?.timeoutKind).toBeUndefined()
    // Custom fields should be preserved
    expect(written.data?.customField).toBe('keep-this')
    // Structured fields should be at top level
    expect(written.entryId).toBe('e1')
    expect(written.sessionId).toBe('s1')
    expect(written.beadId).toBe('bead-1')
    expect(written.beadIteration).toBe(2)
    expect(written.timeoutMs).toBe(1_200_000)
    expect(written.deadlineAt).toBe('2026-03-13T12:20:00.000Z')
    expect(written.timeoutKind).toBe('council_response')
  })

  it('persists normal append events', () => {

    appendLogEvent(
      '1:T-42',
      'info',
      'CODING',
      'Status update',
      { timestamp: '2026-03-13T12:00:00.000Z' },
      'system',
      'CODING',
    )

    expect(mockAppend).toHaveBeenCalledOnce()
    expect(mockAppend.mock.calls[0]?.[0]).toBe('/tmp/test-execution-log.jsonl')
  })

  it('persists direct debug events to the debug log with raw payload fields', () => {
    appendLogEvent(
      '1:T-42',
      'debug',
      'CODING',
      '[DEBUG] raw provider response',
      {
        timestamp: '2026-03-13T12:00:00.000Z',
        source: 'payload-source',
        status: 'payload-status',
        customField: 'keep-this',
      },
      'debug',
      'CODING',
    )

    expect(mockAppend).toHaveBeenCalledOnce()
    expect(mockAppend.mock.calls[0]?.[0]).toBe('/tmp/test-execution-log.debug.jsonl')
    const written = JSON.parse(mockAppend.mock.calls[0]![1]!)
    expect(written.type).toBe('debug')
    expect(written.source).toBe('debug')
    expect(written.data?.source).toBe('payload-source')
    expect(written.data?.status).toBe('payload-status')
    expect(written.data?.customField).toBe('keep-this')
  })

  it('keeps debug rows out of the AI detail log', () => {
    appendLogEvent(
      '1:T-42',
      'debug',
      'CODING',
      '[DEBUG] raw provider response',
      { timestamp: '2026-03-13T12:00:00.000Z' },
      'debug',
      'CODING',
      {
        audience: 'debug',
        kind: 'session',
        op: 'append',
        streaming: false,
      },
    )

    expect(mockAppend).toHaveBeenCalledOnce()
    expect(mockAppend.mock.calls[0]?.[0]).toBe('/tmp/test-execution-log.debug.jsonl')
  })

  it('skips persisting repeated append events with the same fingerprint', () => {
    appendLogEvent(
      '1:T-42',
      'info',
      'CODING',
      '[QUESTION] AI question answered.',
      {
        timestamp: '2026-04-20T10:00:00.000Z',
        fingerprint: 'opencode-question:session-1:req-1:replied',
      },
      'opencode',
      'CODING',
    )

    appendLogEvent(
      '1:T-42',
      'info',
      'CODING',
      '[QUESTION] AI question answered.',
      {
        timestamp: '2026-04-20T10:00:01.000Z',
        fingerprint: 'opencode-question:session-1:req-1:replied',
      },
      'opencode',
      'CODING',
    )

    expect(mockAppend).toHaveBeenCalledOnce()
  })

  it('persists repeated append events when no fingerprint is provided', () => {
    appendLogEvent(
      '1:T-42',
      'info',
      'CODING',
      'Status update',
      { timestamp: '2026-03-13T12:00:00.000Z' },
      'system',
      'CODING',
    )

    appendLogEvent(
      '1:T-42',
      'info',
      'CODING',
      'Status update',
      { timestamp: '2026-03-13T12:00:00.050Z' },
      'system',
      'CODING',
    )

    expect(mockAppend).toHaveBeenCalledTimes(2)
  })

  it('persists repeated AI finalize events when no fingerprint is provided', () => {
    const writeAiResult = (timestamp: string) => appendLogEvent(
      '1:T-42',
      'model_output',
      'CODING',
      'final model output',
      { timestamp },
      'opencode',
      'CODING',
      {
        audience: 'ai',
        kind: 'text',
        op: 'finalize',
        entryId: 'session:output',
        streaming: false,
      },
    )

    writeAiResult('2026-03-13T12:00:00.000Z')
    writeAiResult('2026-03-13T12:00:00.050Z')

    expect(mockAppend).toHaveBeenCalledTimes(4)
    expect(mockAppend.mock.calls.map((call) => call[0])).toEqual([
      '/tmp/test-execution-log.ai.jsonl',
      '/tmp/test-execution-log.jsonl',
      '/tmp/test-execution-log.ai.jsonl',
      '/tmp/test-execution-log.jsonl',
    ])
  })

  it('does not suppress repeated non-fingerprinted emissions', () => {
    expect(shouldSkipLogEmission(
      '1:T-42',
      'info',
      'CODING',
      'Status update',
      { timestamp: '2026-03-13T12:00:00.000Z' },
      'system',
      'CODING',
    )).toBe(false)

    expect(shouldSkipLogEmission(
      '1:T-42',
      'info',
      'CODING',
      'Status update',
      { timestamp: '2026-03-13T12:00:00.200Z' },
      'system',
      'CODING',
    )).toBe(false)
  })

  it('dedupes fingerprinted emissions across the universal emit scope', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-20T10:00:00.000Z'))

    expect(shouldSkipLogEmission(
      '1:T-42',
      'info',
      'CODING',
      '[QUESTION] AI question answered.',
      {
        timestamp: '2026-04-20T10:00:00.000Z',
        fingerprint: 'opencode-question:session-1:req-1:replied',
      },
      'opencode',
      'CODING',
    )).toBe(false)

    vi.setSystemTime(new Date('2026-04-20T10:00:05.000Z'))
    expect(shouldSkipLogEmission(
      '1:T-42',
      'info',
      'CODING',
      '[QUESTION] AI question answered.',
      {
        timestamp: '2026-04-20T10:00:05.000Z',
        fingerprint: 'opencode-question:session-1:req-1:replied',
      },
      'opencode',
      'CODING',
    )).toBe(true)
  })

  it('dedupes fingerprints separately for AI detail and normal channels', () => {
    const writeAiPrompt = () => appendLogEvent(
      '1:T-42',
      'info',
      'CODING',
      '[PROMPT] Prompt #1',
      {
        timestamp: '2026-04-20T10:00:00.000Z',
        fingerprint: 'prompt:session-1:1',
      },
      'opencode',
      'CODING',
      {
        audience: 'ai',
        kind: 'prompt',
        op: 'append',
        streaming: false,
        entryId: 'session-1:prompt:1',
        fingerprint: 'prompt:session-1:1',
      },
    )

    writeAiPrompt()
    writeAiPrompt()

    expect(mockAppend).toHaveBeenCalledTimes(2)
    expect(mockAppend.mock.calls.map((call) => call[0])).toEqual([
      '/tmp/test-execution-log.ai.jsonl',
      '/tmp/test-execution-log.jsonl',
    ])
  })
})
