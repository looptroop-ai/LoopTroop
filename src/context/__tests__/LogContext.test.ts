import { createElement, useEffect } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatLogLine, getServerLogCacheKey, mergeEntriesBatch, mergeEntry, normalizeLogRecord, normalizeStoredEntry, serverLogCache, SERVER_LOG_REFRESH_EVENT } from '@/context/logUtils'
import { LogProvider } from '@/context/LogContext'
import { useLogs } from '@/context/useLogContext'
import { createJsonResponse } from '@/test/renderHelpers'
import { TEST } from '@/test/factories'
import type { LogEntry } from '@/context/logUtils'

let latestLogApi: ReturnType<typeof useLogs> = null

function LogHarness() {
  const logApi = useLogs()
  const loadLogsForPhase = logApi?.loadLogsForPhase
  const logs = logApi?.getLogsForPhase('CODING') ?? []

  useEffect(() => {
    latestLogApi = logApi
  }, [logApi])

  useEffect(() => {
    loadLogsForPhase?.('CODING')
  }, [loadLogsForPhase])

  return createElement('div', { 'data-testid': 'log-count' }, logs.length)
}

function getCodingLogs() {
  return latestLogApi?.getLogsForPhase('CODING') ?? []
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('formatLogLine', () => {
  it('keeps reasoning content unprefixed so the UI can render THINKING tags', () => {
    expect(formatLogLine({
      type: 'model_output',
      kind: 'reasoning',
      content: '**Planning phased question strategy**',
      source: 'model:openai/gpt-5.1-codex',
      audience: 'ai',
    }).line).toBe('**Planning phased question strategy**')
  })

  it('continues to prefix non-reasoning model output with MODEL tags', () => {
    expect(formatLogLine({
      type: 'model_output',
      kind: 'text',
      content: 'phase: discovery',
      source: 'model:openai/gpt-5.1-codex',
      audience: 'ai',
    }).line).toBe('[MODEL] phase: discovery')
  })
})

describe('normalizeStoredEntry', () => {
  it('restores legacy cached AI detail rows that are missing source and audience', () => {
    const restored = normalizeStoredEntry({
      id: 'legacy-ai-row',
      entryId: 'legacy-ai-row',
      line: '[MODEL] cached model output',
      kind: 'text',
      modelId: 'openai/gpt-5.4',
      sessionId: 'session-1',
      streaming: false,
      op: 'append',
    }, 'CODING')

    expect(restored).toMatchObject({
      source: 'model:openai/gpt-5.4',
      audience: 'ai',
      kind: 'text',
      modelId: 'openai/gpt-5.4',
      sessionId: 'session-1',
    })
  })

  it('keeps model-attributed system milestones system-shaped', () => {
    const restored = normalizeStoredEntry({
      id: 'system-model-milestone',
      entryId: 'system-model-milestone',
      line: '[SYS] Coverage verification passed.',
      kind: 'milestone',
      modelId: 'openai/gpt-5.4',
      streaming: false,
      op: 'append',
    }, 'VERIFYING_PRD_COVERAGE')

    expect(restored).toMatchObject({
      source: 'system',
      audience: 'all',
      kind: 'milestone',
      modelId: 'openai/gpt-5.4',
    })
  })

  it('preserves structured prompt timeout metadata from server records and cache', () => {
    const deadlineAt = '2026-05-25T10:20:00.000Z'
    const normalized = normalizeLogRecord({
      type: 'info',
      phase: 'SCANNING_RELEVANT_FILES',
      entryId: 'prompt-timeout-metadata',
      content: '[PROMPT] openai/gpt-5.2 prompt #1',
      source: 'model:openai/gpt-5.2',
      audience: 'ai',
      kind: 'prompt',
      modelId: 'openai/gpt-5.2',
      sessionId: 'ses_timeout_metadata',
      beadId: 'bead-1',
      beadIteration: 3,
      timeoutMs: 1_200_000,
      deadlineAt,
      timeoutKind: 'ai_response',
      streaming: false,
    }, 'SCANNING_RELEVANT_FILES')
    const restored = normalizeStoredEntry(normalized, 'SCANNING_RELEVANT_FILES')

    expect(restored).toMatchObject({
      timeoutMs: 1_200_000,
      deadlineAt,
      timeoutKind: 'ai_response',
      beadId: 'bead-1',
      beadIteration: 3,
    })
  })

  it('preserves runtime model variants from live and restored log records', () => {
    const normalized = normalizeLogRecord({
      type: 'info',
      phase: 'CODING',
      source: 'model:openai/gpt-5.4',
      modelId: 'openai/gpt-5.4',
      data: { variant: 'high' },
      content: '[ASSISTANT] Working',
    }, 'CODING')

    expect(normalized.variant).toBe('high')
    expect(normalizeStoredEntry(normalized, 'CODING').variant).toBe('high')
  })
})

describe('mergeEntriesBatch', () => {
  it('overlays live canonical updates on restored rows without duplicating them', () => {
    const restored = normalizeLogRecord({
      phase: 'CODING', entryId: 'session:message:text', fingerprint: 'canonical-text',
      content: 'restored partial', op: 'upsert', streaming: true,
      timestamp: '2026-03-13T10:00:00.000Z',
    }, 'CODING')
    const live = normalizeLogRecord({
      phase: 'CODING', entryId: 'session:message:text:live', fingerprint: 'canonical-text',
      content: 'live final', op: 'finalize', streaming: false,
      timestamp: '2026-03-13T10:00:02.000Z',
    }, 'CODING')

    expect(mergeEntriesBatch([restored], [live])).toEqual([
      expect.objectContaining({
        entryId: 'session:message:text:live',
        line: expect.stringContaining('live final'),
        timestamp: '2026-03-13T10:00:00.000Z',
        streaming: false,
      }),
    ])
  })
})

describe('LogProvider', () => {
  afterEach(() => {
    latestLogApi = null
    localStorage.clear()
    serverLogCache.clear()
    vi.restoreAllMocks()
  })

  it('fetches only explicitly requested phase scopes', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => createJsonResponse([]))

    render(createElement(
      LogProvider,
      {
        ticketId: '1:T-scope',
        currentStatus: 'CODING',
        visiblePhase: 'CODING',
        children: createElement(LogHarness),
      },
    ))

    await flushMicrotasks()
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/tickets/1%3AT-scope/logs?scope=phase&view=overview&limit=20&phase=CODING')

    act(() => latestLogApi?.loadLogsForPhase?.('DRAFTING_PRD'))

    await flushMicrotasks()
    expect(globalThis.fetch).toHaveBeenLastCalledWith('/api/tickets/1%3AT-scope/logs?scope=phase&view=overview&limit=20&phase=DRAFTING_PRD')
    expect(vi.mocked(globalThis.fetch).mock.calls.every(([url]) => !String(url).includes('tail='))).toBe(true)
  })

  it('requests phase debug logs through the debug channel only when asked', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => createJsonResponse([]))

    render(createElement(
      LogProvider,
      {
        ticketId: '1:T-debug-phase',
        currentStatus: 'CODING',
        children: createElement(LogHarness),
      },
    ))

    await flushMicrotasks()
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/tickets/1%3AT-debug-phase/logs?scope=phase&view=overview&limit=20&phase=CODING')

    await act(async () => {
      latestLogApi?.loadLogsForPhase?.('CODING', { channel: 'debug' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(globalThis.fetch).toHaveBeenLastCalledWith('/api/tickets/1%3AT-debug-phase/logs?scope=phase&view=debug&limit=20&phase=CODING')
  })

  it('requests phase AI detail logs through the AI channel and merges them into the phase bucket', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse([]))
      .mockImplementationOnce(() => createJsonResponse([{
        type: 'model_output',
        phase: 'CODING',
        status: 'CODING',
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'reasoning',
        content: 'Restored thinking row.',
        entryId: 'session-1:thinking',
        op: 'upsert',
        streaming: true,
        timestamp: '2026-03-13T10:00:03.000Z',
      }]))

    render(createElement(
      LogProvider,
      {
        ticketId: '1:T-ai-phase',
        currentStatus: 'CODING',
        children: createElement(LogHarness),
      },
    ))

    await flushMicrotasks()
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/tickets/1%3AT-ai-phase/logs?scope=phase&view=overview&limit=20&phase=CODING')

    await act(async () => {
      latestLogApi?.loadLogsForPhase?.('CODING', { channel: 'ai' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(globalThis.fetch).toHaveBeenLastCalledWith('/api/tickets/1%3AT-ai-phase/logs?scope=phase&view=ai&limit=20&phase=CODING')
    expect(getCodingLogs()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entryId: 'session-1:thinking',
        audience: 'ai',
        streaming: true,
        line: 'Restored thinking row.',
      }),
    ]))
  })

  it('preserves live phaseAttempt values and filters phase logs by attempt', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => createJsonResponse([]))

    render(createElement(
      LogProvider,
      {
        ticketId: '1:T-live-attempt',
        currentStatus: 'PREPARING_EXECUTION_ENV',
        children: createElement(LogHarness),
      },
    ))

    await flushMicrotasks()

    await act(async () => {
      latestLogApi?.addLogRecord('PREPARING_EXECUTION_ENV', {
        type: 'info',
        phase: 'PREPARING_EXECUTION_ENV',
        status: 'PREPARING_EXECUTION_ENV',
        source: 'system',
        audience: 'all',
        kind: 'milestone',
        content: 'Attempt 1 row.',
        entryId: 'attempt-1-row',
        phaseAttempt: 1,
        timestamp: '2026-03-13T10:00:01.000Z',
      })
      latestLogApi?.addLogRecord('PREPARING_EXECUTION_ENV', {
        type: 'info',
        phase: 'PREPARING_EXECUTION_ENV',
        status: 'PREPARING_EXECUTION_ENV',
        source: 'system',
        audience: 'all',
        kind: 'milestone',
        content: 'Attempt 2 row.',
        entryId: 'attempt-2-row',
        phaseAttempt: 2,
        timestamp: '2026-03-13T10:00:02.000Z',
      })
    })

    expect(latestLogApi?.getLogsForPhase('PREPARING_EXECUTION_ENV', { phaseAttempt: 2 })).toEqual([
      expect.objectContaining({
        entryId: 'attempt-2-row',
        phaseAttempt: 2,
      }),
    ])
  })

  it('loads persisted phase logs with phaseAttempt in the URL and scope key', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse([]))
      .mockImplementationOnce(() => createJsonResponse([
        {
          type: 'info',
          phase: 'PREPARING_EXECUTION_ENV',
          status: 'PREPARING_EXECUTION_ENV',
          source: 'system',
          content: 'Attempt 1 persisted row.',
          entryId: 'persisted-attempt-1',
          phaseAttempt: 1,
          timestamp: '2026-03-13T10:00:01.000Z',
        },
        {
          type: 'info',
          phase: 'PREPARING_EXECUTION_ENV',
          status: 'PREPARING_EXECUTION_ENV',
          source: 'system',
          content: 'Attempt 2 persisted row.',
          entryId: 'persisted-attempt-2',
          phaseAttempt: 2,
          timestamp: '2026-03-13T10:00:02.000Z',
        },
      ]))

    render(createElement(
      LogProvider,
      {
        ticketId: '1:T-persisted-attempt',
        currentStatus: 'PREPARING_EXECUTION_ENV',
        children: createElement(LogHarness),
      },
    ))

    await flushMicrotasks()

    await act(async () => {
      latestLogApi?.loadLogsForPhase?.('PREPARING_EXECUTION_ENV', { phaseAttempt: 2 })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(globalThis.fetch).toHaveBeenLastCalledWith('/api/tickets/1%3AT-persisted-attempt/logs?scope=phase&view=overview&limit=20&phase=PREPARING_EXECUTION_ENV&phaseAttempt=2')
    expect(latestLogApi?.getLogsForPhase('PREPARING_EXECUTION_ENV', { phaseAttempt: 2 })).toEqual([
      expect.objectContaining({
        entryId: 'persisted-attempt-2',
        phaseAttempt: 2,
      }),
    ])
  })

  it('ignores debug rows from normal server fetches but keeps live debug rows', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => createJsonResponse([{
      type: 'info',
      phase: 'CODING',
      status: 'CODING',
      source: 'system',
      content: 'Normal server row.',
      entryId: 'normal-row',
      timestamp: '2026-03-13T10:00:01.000Z',
    }, {
      type: 'debug',
      phase: 'CODING',
      status: 'CODING',
      source: 'debug',
      content: 'Legacy mixed debug row.',
      entryId: 'legacy-debug-row',
      timestamp: '2026-03-13T10:00:02.000Z',
    }]))

    try {
      render(createElement(
        LogProvider,
        {
          ticketId: '1:T-debug-filter',
          currentStatus: 'CODING',
          children: createElement(LogHarness),
        },
      ))

      await flushMicrotasks()
      expect(screen.getByTestId('log-count')).toHaveTextContent('1')

      await act(async () => {
        latestLogApi?.addLog('CODING', '[DEBUG] live state_change payload', {
          source: 'debug',
          audience: 'debug',
          kind: 'session',
          entryId: 'live-debug-row',
          timestamp: '2026-03-13T10:00:03.000Z',
        })
        await vi.advanceTimersByTimeAsync(250)
      })

      expect(screen.getByTestId('log-count')).toHaveTextContent('2')
      expect(localStorage.length).toBe(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('renders live SSE log records immediately without creating durable browser snapshots', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => createJsonResponse([]))
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    try {
      render(createElement(
        LogProvider,
        {
          ticketId: '1:T-live-immediate',
          currentStatus: 'CODING',
          children: createElement(LogHarness),
        },
      ))

      await flushMicrotasks()
      localStorage.clear()
      setItemSpy.mockClear()

      await act(async () => {
        latestLogApi?.addLogRecord('CODING', {
          type: 'info',
          phase: 'CODING',
          status: 'CODING',
          source: 'system',
          audience: 'all',
          kind: 'milestone',
          content: 'Live row arrived.',
          entryId: 'log:live-row',
          op: 'append',
          streaming: false,
          timestamp: '2026-03-13T10:00:03.000Z',
        })
      })

      expect(screen.getByTestId('log-count')).toHaveTextContent('2')
      expect(getCodingLogs().map((entry) => entry.entryId)).toContain('log:live-row')
      expect(setItemSpy).not.toHaveBeenCalled()
      expect(localStorage.length).toBe(0)

      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(localStorage.length).toBe(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('keeps streaming AI upserts live-only and replaces them in memory when finalized', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => createJsonResponse([]))
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    try {
      render(createElement(
        LogProvider,
        {
          ticketId: '1:T-streaming',
          currentStatus: 'CODING',
          children: createElement(LogHarness),
        },
      ))

      await flushMicrotasks()
      localStorage.clear()
      setItemSpy.mockClear()

      await act(async () => {
        latestLogApi?.addLogRecord('CODING', {
          type: 'model_output',
          phase: 'CODING',
          status: 'CODING',
          source: 'model:openai/gpt-5-mini',
          audience: 'ai',
          kind: 'text',
          content: 'partial response',
          entryId: 'session-1:message-1:text',
          op: 'upsert',
          streaming: true,
          timestamp: '2026-03-13T10:00:03.000Z',
        })
      })

      expect(screen.getByTestId('log-count')).toHaveTextContent('2')
      expect(getCodingLogs().find((entry) => entry.entryId === 'session-1:message-1:text')?.line).toContain('partial response')
      expect(setItemSpy).not.toHaveBeenCalled()
      expect(localStorage.length).toBe(0)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(localStorage.length).toBe(0)
      setItemSpy.mockClear()

      await act(async () => {
        latestLogApi?.addLogRecord('CODING', {
          type: 'model_output',
          phase: 'CODING',
          status: 'CODING',
          source: 'model:openai/gpt-5-mini',
          audience: 'ai',
          kind: 'text',
          content: 'partial response extended',
          entryId: 'session-1:message-1:text',
          op: 'upsert',
          streaming: true,
          timestamp: '2026-03-13T10:00:03.250Z',
        })
      })

      const streamingRows = getCodingLogs().filter((entry) => entry.entryId === 'session-1:message-1:text')
      expect(screen.getByTestId('log-count')).toHaveTextContent('2')
      expect(streamingRows).toHaveLength(1)
      expect(streamingRows[0]?.line).toContain('partial response extended')
      expect(setItemSpy).not.toHaveBeenCalled()

      await act(async () => {
        latestLogApi?.addLogRecord('CODING', {
          type: 'model_output',
          phase: 'CODING',
          status: 'CODING',
          source: 'model:openai/gpt-5-mini',
          audience: 'ai',
          kind: 'text',
          content: 'final response',
          entryId: 'session-1:message-1:text',
          op: 'finalize',
          streaming: false,
          timestamp: '2026-03-13T10:00:04.000Z',
        })
        await vi.advanceTimersByTimeAsync(500)
      })

      const finalizedRows = getCodingLogs().filter((entry) => entry.entryId === 'session-1:message-1:text')
      expect(finalizedRows).toHaveLength(1)
      expect(finalizedRows[0]?.line).toContain('final response')
      expect(finalizedRows[0]?.streaming).toBe(false)
      expect(localStorage.length).toBe(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('bounds live rows per phase without splitting canonical streaming updates', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => createJsonResponse([]))
    render(createElement(LogProvider, {
      ticketId: '1:T-bounded', currentStatus: 'CODING', children: createElement(LogHarness),
    }))
    await flushMicrotasks()

    await act(async () => {
      for (let index = 0; index < 1_005; index++) {
        latestLogApi?.addLogRecord('CODING', {
          type: 'info', phase: 'CODING', content: `row ${index}`,
          entryId: `row-${index}`, timestamp: new Date(index).toISOString(),
        })
      }
    })

    expect(getCodingLogs()).toHaveLength(1_000)
    expect(getCodingLogs()[0]?.entryId).toBe('row-5')
    expect(localStorage.length).toBe(0)
  })

  it('dedupes SSE-delivered logs against the initial server fetch', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse([{
        type: 'info',
        phase: 'CODING',
        status: 'CODING',
        source: 'system',
        content: 'Polling caught up.',
        entryId: 'log:polling-sync',
        timestamp: '2026-03-13T10:00:01.000Z',
      }]))

    try {
      render(createElement(
        LogProvider,
        {
          ticketId: '1:T-42',
          currentStatus: 'CODING',
          children: createElement(LogHarness),
        },
      ))

      await flushMicrotasks()
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)

      // Simulate SSE delivering the same log entry — should be deduped
      await act(async () => {
        latestLogApi?.addLogRecord('CODING', {
          type: 'info',
          phase: 'CODING',
          status: 'CODING',
          source: 'system',
          content: 'Polling caught up.',
          entryId: 'log:polling-sync',
          timestamp: '2026-03-13T10:00:00.000Z',
        })
        await vi.advanceTimersByTimeAsync(250)
      })

      expect(screen.getByTestId('log-count')).toHaveTextContent('1')

      // Verify no additional fetches happen (polling removed)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('does not replay restored rows into the live store on a recovery refresh', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse([{
        type: 'info',
        phase: 'CODING',
        status: 'CODING',
        source: 'system',
        content: 'Initial log.',
        entryId: 'log:initial',
        timestamp: '2026-03-13T10:00:01.000Z',
      }]))
      .mockImplementationOnce(() => createJsonResponse([{
        type: 'info',
        phase: 'CODING',
        status: 'CODING',
        source: 'system',
        content: 'Initial log.',
        entryId: 'log:initial',
        timestamp: '2026-03-13T10:00:01.000Z',
      }, {
        type: 'info',
        phase: 'CODING',
        status: 'CODING',
        source: 'system',
        content: 'Recovered log.',
        entryId: 'log:recovered',
        timestamp: '2026-03-13T10:00:02.000Z',
      }]))

    render(createElement(
      LogProvider,
      {
        ticketId: '1:T-99',
        currentStatus: 'CODING',
        children: createElement(LogHarness),
      },
    ))

    await flushMicrotasks()
    expect(screen.getByTestId('log-count')).toHaveTextContent('1')

    await act(async () => {
      window.dispatchEvent(new CustomEvent(SERVER_LOG_REFRESH_EVENT, { detail: { ticketId: '1:T-99' } }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('log-count')).toHaveTextContent('1')
  })

  it('drops only the departing ticket from the server log cache when it unmounts', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => createJsonResponse([]))

    // A neighbouring ticket's entry, owned by its own provider. Leaving this ticket must not touch
    // it, or every other open ticket would lose its cache too.
    const otherTicketId = `${TEST.projectId}:${TEST.shortnameB}-1`
    const otherKey = getServerLogCacheKey(otherTicketId, { phase: 'CODING', channel: 'normal' })
    serverLogCache.set(otherKey, [])

    const view = render(createElement(
      LogProvider,
      {
        ticketId: TEST.ticketId,
        currentStatus: 'CODING',
        children: createElement(LogHarness),
      },
    ))

    await flushMicrotasks()
    const fetchCallsWhileMounted = vi.mocked(globalThis.fetch).mock.calls.length
    expect(fetchCallsWhileMounted).toBeGreaterThan(0)
    expect(serverLogCache.size).toBe(fetchCallsWhileMounted + 1)

    view.unmount()

    expect([...serverLogCache.keys()]).toEqual([otherKey])

    // And the point of dropping it: coming back goes to the server instead of replaying the
    // snapshot taken on the way out, which would be missing everything that streamed in between.
    render(createElement(
      LogProvider,
      {
        ticketId: TEST.ticketId,
        currentStatus: 'CODING',
        children: createElement(LogHarness),
      },
    ))

    await flushMicrotasks()
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(fetchCallsWhileMounted)
  })
})

describe('mergeEntry', () => {
  it('stops streaming when a terminal fallback append arrives for an AI text row', () => {
    const streamingUpsert: LogEntry = {
      id: 'ses-1:msg-1:text',
      entryId: 'ses-1:msg-1:text',
      line: '[MODEL] artifact: interview',
      source: 'model:openai/gpt-5-mini',
      status: 'DRAFTING_PRD',
      timestamp: '2026-03-13T10:00:00.000Z',
      audience: 'ai',
      kind: 'text',
      modelId: 'openai/gpt-5-mini',
      sessionId: 'ses-1',
      streaming: true,
      op: 'upsert',
    }
    const fallbackAppend: LogEntry = {
      ...streamingUpsert,
      timestamp: '2026-03-13T10:00:01.000Z',
      streaming: false,
      op: 'append',
    }

    const merged = mergeEntry([streamingUpsert], fallbackAppend)

    expect(merged).toEqual([
      expect.objectContaining({
        entryId: 'ses-1:msg-1:text',
        op: 'append',
        streaming: false,
        timestamp: '2026-03-13T10:00:01.000Z',
      }),
    ])
  })

  it('dedupes repeated low-value git probe entries with near-identical timestamps', () => {
    const first: LogEntry = {
      id: 'draft:system:2026-03-13T10:00:00.000Z:[CMD] $ git rev-parse --abbrev-ref HEAD  →  master',
      entryId: 'draft:system:2026-03-13T10:00:00.000Z:[CMD] $ git rev-parse --abbrev-ref HEAD  →  master',
      line: '[CMD] $ git rev-parse --abbrev-ref HEAD  →  master',
      source: 'system',
      status: 'DRAFT',
      timestamp: '2026-03-13T10:00:00.000Z',
      audience: 'all',
      kind: 'milestone',
      streaming: false,
      op: 'append',
    }
    const duplicate: LogEntry = {
      ...first,
      id: 'draft:system:2026-03-13T10:00:00.900Z:[CMD] $ git rev-parse --abbrev-ref HEAD  →  master',
      entryId: 'draft:system:2026-03-13T10:00:00.900Z:[CMD] $ git rev-parse --abbrev-ref HEAD  →  master',
      timestamp: '2026-03-13T10:00:00.900Z',
    }

    const merged = mergeEntry([first], duplicate)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe(first)
  })

  it('preserves original start timestamp when a streaming upsert updates an existing entry', () => {
    const firstUpsert: LogEntry = {
      id: 'ses-1:reasoning',
      entryId: 'ses-1:reasoning',
      line: 'Planning the approach...',
      source: 'model:openai/gpt-5.4',
      status: 'CODING',
      timestamp: '2026-03-13T10:00:00.000Z',
      audience: 'ai',
      kind: 'reasoning',
      streaming: true,
      op: 'upsert',
    }
    const laterUpsert: LogEntry = {
      ...firstUpsert,
      line: 'Planning the approach... Step 2: analyze requirements.',
      timestamp: '2026-03-13T10:00:02.500Z',
    }

    const merged = mergeEntry([firstUpsert], laterUpsert)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      entryId: 'ses-1:reasoning',
      line: 'Planning the approach... Step 2: analyze requirements.',
      streaming: true,
      op: 'upsert',
      // Original start timestamp must NOT be overwritten by the streaming update
      timestamp: '2026-03-13T10:00:00.000Z',
    })
  })

  it('preserves original start timestamp when a finalize arrives for a streaming entry', () => {
    const initialUpsert: LogEntry = {
      id: 'ses-1:text',
      entryId: 'ses-1:text',
      line: '[MODEL] Partial model response.',
      source: 'model:openai/gpt-5.4',
      status: 'CODING',
      timestamp: '2026-03-13T10:00:00.000Z',
      audience: 'ai',
      kind: 'text',
      streaming: true,
      op: 'upsert',
    }
    const finalizeEntry: LogEntry = {
      ...initialUpsert,
      line: '[MODEL] Full model response, now complete.',
      timestamp: '2026-03-13T10:00:05.000Z',
      streaming: false,
      op: 'finalize',
    }

    const merged = mergeEntry([initialUpsert], finalizeEntry)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      entryId: 'ses-1:text',
      line: '[MODEL] Full model response, now complete.',
      streaming: false,
      op: 'finalize',
      // Original start timestamp must NOT be replaced by the finalize timestamp
      timestamp: '2026-03-13T10:00:00.000Z',
    })
  })

  it('dedupes append entries with matching fingerprints', () => {
    const first: LogEntry = {
      id: 'entry-1',
      entryId: 'session-1:question:req-1:replied',
      fingerprint: 'opencode-question:session-1:req-1:replied',
      line: '[QUESTION] AI question answered.',
      source: 'model:openai/gpt-5-mini',
      status: 'CODING',
      timestamp: '2026-04-20T10:00:00.000Z',
      audience: 'ai',
      kind: 'session',
      streaming: false,
      op: 'append',
    }
    const duplicate: LogEntry = {
      ...first,
      id: 'entry-2',
      entryId: 'different-entry-id',
      timestamp: '2026-04-20T10:00:01.000Z',
    }

    const merged = mergeEntry([first], duplicate)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe(first)
  })
})
