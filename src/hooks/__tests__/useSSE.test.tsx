import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryClient } from '@/lib/queryClient'
import { SERVER_LOG_REFRESH_EVENT } from '@/context/logUtils'
import { getTicketArtifactsQueryKey, useTicketArtifacts, type DBartifact } from '../useTicketArtifacts'

vi.mock('@/lib/devApi', () => ({
  getApiUrl: (path: string, options?: { directInDevelopment?: boolean }) =>
    `${options?.directInDevelopment ? 'http://localhost:3000' : 'http://frontend.test'}${path}`,
  waitForDevBackend: vi.fn(async () => undefined),
}))

import { useSSE } from '../useSSE'

type SSEHandler = (event: { type: string; data: Record<string, unknown> }) => void
type MockListener = (event: MessageEvent) => void

class MockEventSource {
  static instances: MockEventSource[] = []

  readonly url: string
  closed = false
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null

  private listeners = new Map<string, Set<MockListener>>()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: MockListener) {
    const bucket = this.listeners.get(type) ?? new Set<MockListener>()
    bucket.add(listener)
    this.listeners.set(type, bucket)
  }

  close() {
    this.closed = true
  }

  emit(type: string, data: Record<string, unknown>, lastEventId: string) {
    if (this.closed) return
    const event = {
      data: JSON.stringify(data),
      lastEventId,
    } as MessageEvent

    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }

  emitOpen() {
    if (this.closed) return
    const event = new Event('open')
    for (const listener of this.listeners.get('open') ?? []) {
      listener(event as MessageEvent)
    }
  }

  emitTransportError() {
    if (this.closed) return
    this.onerror?.call(this as unknown as EventSource, new Event('error'))
  }
}

describe('useSSE', () => {
  beforeEach(() => {
    queryClient.clear()
    MockEventSource.instances = []

    Object.defineProperty(globalThis, 'EventSource', {
      configurable: true,
      writable: true,
      value: MockEventSource,
    })
  })

  afterEach(() => {
    queryClient.clear()
    MockEventSource.instances = []
    vi.restoreAllMocks()
  })

  it('keeps a single EventSource for the same ticket and dispatches state changes to the latest callback after rerender', async () => {
    const ticketId = '1:T-42'
    const initialTicket = { id: ticketId, status: 'DRAFTING_PRD' }
    const initialList = [initialTicket, { id: '1:T-43', status: 'CODING' }]

    queryClient.setQueryData(['ticket', ticketId], initialTicket)
    queryClient.setQueryData(['tickets'], initialList)

    const firstOnEvent = vi.fn<SSEHandler>()
    const secondOnEvent = vi.fn<SSEHandler>()

    const { rerender, unmount } = renderHook(
      ({ onEvent }: { onEvent: SSEHandler }) => useSSE({ ticketId, onEvent }),
      { initialProps: { onEvent: firstOnEvent } },
    )

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
    })

    const source = MockEventSource.instances[0]!

    rerender({ onEvent: secondOnEvent })

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
      expect(source.closed).toBe(false)
    })

    await act(async () => {
      source.emit('state_change', {
        ticketId,
        from: 'DRAFTING_PRD',
        to: 'REFINING_PRD',
      }, '1')
    })

    await waitFor(() => {
      expect(secondOnEvent).toHaveBeenCalledWith({
        type: 'state_change',
        data: expect.objectContaining({
          ticketId,
          from: 'DRAFTING_PRD',
          to: 'REFINING_PRD',
        }),
      })
    })

    expect(firstOnEvent).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(['ticket', ticketId])).toEqual({
      id: ticketId,
      previousStatus: 'DRAFTING_PRD',
      status: 'REFINING_PRD',
    })
    expect(queryClient.getQueryData(['tickets'])).toEqual([
      { id: ticketId, previousStatus: 'DRAFTING_PRD', status: 'REFINING_PRD' },
      { id: '1:T-43', status: 'CODING' },
    ])

    await act(async () => {
      source.emit('state_change', {
        ticketId,
        from: 'REFINING_PRD',
        to: 'CODING',
      }, '2')
    })

    await waitFor(() => {
      expect(secondOnEvent).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryData(['ticket', ticketId])).toEqual({
        id: ticketId,
        previousStatus: 'REFINING_PRD',
        status: 'CODING',
      })
      expect(queryClient.getQueryData(['tickets'])).toEqual([
        { id: ticketId, previousStatus: 'REFINING_PRD', status: 'CODING' },
        { id: '1:T-43', status: 'CODING' },
      ])
    })

    unmount()

    expect(source.closed).toBe(true)
  })

  it('opens the ticket stream through the same-origin API route', async () => {
    const ticketId = '1:T-42'

    renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
      expect(MockEventSource.instances[0]!.url).toContain('http://frontend.test/api/stream')
      expect(MockEventSource.instances[0]!.url).not.toContain('http://localhost:3000')
    })
  })

  it('keeps loaded historical bodies and invalidates only artifact scopes affected by metadata events', async () => {
    const ticketId = '1:T-42'
    const historicalArtifact: DBartifact = {
      id: 11,
      ticketId,
      phase: 'COUNCIL_VOTING_PRD',
      phaseAttempt: 1,
      artifactType: 'prd_votes',
      filePath: null,
      content: 'historical voting content',
      createdAt: '2026-08-21T10:00:00.000Z',
      updatedAt: '2026-08-21T10:00:00.000Z',
    }
    const broadKey = getTicketArtifactsQueryKey(ticketId)
    const historicalKey = getTicketArtifactsQueryKey(ticketId, {
      phase: historicalArtifact.phase,
      phaseAttempt: historicalArtifact.phaseAttempt,
    })
    queryClient.setQueryData(broadKey, [historicalArtifact])
    queryClient.setQueryData(historicalKey, [historicalArtifact])
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    await act(async () => {
      MockEventSource.instances[0]!.emit('artifact_change', {
        ticketId,
        phase: 'CODING',
        artifactType: 'bead_diff:bead-1',
        artifact: {
          id: 22,
          ticketId,
          phase: 'CODING',
          phaseAttempt: 2,
          artifactType: 'bead_diff:bead-1',
          createdAt: '2026-08-21T11:00:00.000Z',
          updatedAt: '2026-08-21T11:00:00.000Z',
          available: true,
        },
      }, '1')
    })

    expect(queryClient.getQueryData(broadKey)).toEqual([historicalArtifact])
    expect(queryClient.getQueryData(historicalKey)).toEqual([historicalArtifact])
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: broadKey, exact: true })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: getTicketArtifactsQueryKey(ticketId, { phase: 'CODING' }),
      exact: true,
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: getTicketArtifactsQueryKey(ticketId, { phase: 'CODING', phaseAttempt: 2 }),
      exact: true,
    })
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: historicalKey, exact: true })
  })

  it('refetches a mounted successful-empty phase cache when its artifact arrives', async () => {
    const ticketId = '1:T-42'
    const createdArtifact = {
      id: 23,
      ticketId,
      phase: 'COUNCIL_VOTING_PRD',
      phaseAttempt: 1,
      artifactType: 'prd_votes',
      filePath: null,
      content: 'now available',
      createdAt: '2026-08-21T12:00:00.000Z',
      updatedAt: '2026-08-21T12:00:00.000Z',
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([createdArtifact]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => {
      const artifacts = useTicketArtifacts(ticketId, { phase: 'COUNCIL_VOTING_PRD', phaseAttempt: 1 })
      useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() })
      return artifacts
    }, { wrapper })

    await waitFor(() => expect(result.current.artifacts).toEqual([]))
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    await act(async () => {
      MockEventSource.instances[0]!.emit('artifact_change', {
        ticketId,
        phase: createdArtifact.phase,
        artifactType: createdArtifact.artifactType,
        artifact: {
          id: createdArtifact.id,
          ticketId,
          phase: createdArtifact.phase,
          phaseAttempt: createdArtifact.phaseAttempt,
          artifactType: createdArtifact.artifactType,
          createdAt: createdArtifact.createdAt,
          updatedAt: createdArtifact.updatedAt,
          available: true,
        },
      }, '1')
    })

    await waitFor(() => expect(result.current.artifacts?.[0]?.content).toBe('now available'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refreshes interview data when a ticket enters interview approval', async () => {
    const ticketId = '1:T-42'
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
    })

    const source = MockEventSource.instances[0]!

    await act(async () => {
      source.emit('state_change', {
        ticketId,
        from: 'VERIFYING_INTERVIEW_COVERAGE',
        to: 'WAITING_INTERVIEW_APPROVAL',
      }, '1')
    })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['interview', ticketId] })
    })
  })

  it('refreshes Manual QA data when preparation hands the checklist to the user', async () => {
    const ticketId = '1:T-42'
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    await act(async () => {
      MockEventSource.instances[0]!.emit('state_change', {
        ticketId,
        from: 'GENERATING_QA_CHECKLIST',
        to: 'WAITING_MANUAL_QA',
      }, '1')
    })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['manual-qa', ticketId] })
    })
  })

  it('refreshes the bead list when a bead completes', async () => {
    const ticketId = '1:T-42'
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
    })

    const source = MockEventSource.instances[0]!

    await act(async () => {
      source.emit('bead_complete', {
        ticketId,
        beadId: 'bead-2',
        completed: 2,
        total: 5,
      }, '1')
    })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ticket', ticketId] })
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ticket-beads', ticketId] })
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['bead-diff', ticketId, 'bead-2'], exact: true })
    })
  })

  it('refreshes the bead diff when a bead diff artifact arrives', async () => {
    const ticketId = '1:T-42'
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
    })

    const source = MockEventSource.instances[0]!

    await act(async () => {
      source.emit('artifact_change', {
        ticketId,
        artifactType: 'bead_diff:bead-2',
        artifact: {
          id: 17,
          ticketId,
          phase: 'CODING',
          artifactType: 'bead_diff:bead-2',
          filePath: null,
          content: 'diff --git a/file.ts b/file.ts',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }, '1')
    })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['bead-diff', ticketId, 'bead-2'], exact: true })
    })
  })

  it('refreshes Manual QA data when a checklist artifact arrives', async () => {
    const ticketId = '1:T-42'
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    await act(async () => {
      MockEventSource.instances[0]!.emit('artifact_change', {
        ticketId,
        artifactType: 'manual_qa_checklist',
        artifact: {
          id: 18,
          ticketId,
          phase: 'GENERATING_QA_CHECKLIST',
          artifactType: 'manual_qa_checklist',
          filePath: null,
          content: '{"version":1}',
          createdAt: '2026-07-13T00:00:00.000Z',
        },
      }, '1')
    })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['manual-qa', ticketId] })
    })
  })

  it('refreshes ticket runtime when coding bead retry metadata arrives via SSE logs', async () => {
    const ticketId = '1:T-42'
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
    })

    const source = MockEventSource.instances[0]!

    await act(async () => {
      source.emit('log', {
        ticketId,
        phase: 'CODING',
        type: 'info',
        source: 'system',
        beadId: 'bead-1',
        content: 'Reset bead bead-1 to its start snapshot and appended retry notes for attempt 2.',
        streaming: false,
      }, '1')
    })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ticket', ticketId] })
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ticket-beads', ticketId] })
    })
  })

  it('dispatches app-level errors from the app_error SSE event', async () => {
    const ticketId = '1:T-42'
    const onEvent = vi.fn<SSEHandler>()

    renderHook(() => useSSE({ ticketId, onEvent }))

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
    })

    const source = MockEventSource.instances[0]!

    await act(async () => {
      source.emit('app_error', {
        ticketId,
        phase: 'CODING',
        message: 'Final test failed',
      }, '6')
    })

    await waitFor(() => {
      expect(onEvent).toHaveBeenCalledWith({
        type: 'app_error',
        data: expect.objectContaining({
          ticketId,
          phase: 'CODING',
          message: 'Final test failed',
        }),
      })
    })

    expect(localStorage.getItem(`looptroop-sse-last-event-id:${ticketId}`)).toBe('6')
  })

  it('persists the last SSE event id per ticket and resumes from it', async () => {
    const ticketId = '1:T-42'
    const storageKey = `looptroop-sse-last-event-id:${ticketId}`

    const firstRender = renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
    })

    await act(async () => {
      MockEventSource.instances[0]!.emit('progress', { ticketId, content: 'Working' }, '7')
    })

    expect(localStorage.getItem(storageKey)).toBe('7')

    firstRender.unmount()
    MockEventSource.instances = []

    renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
      expect(MockEventSource.instances[0]!.url).toContain('lastEventId=7')
    })
  })

  it('recovers ticket, artifact, interview, setup, bead, and log data when opening after a persisted stream gap', async () => {
    const ticketId = '1:T-42'
    localStorage.setItem(`looptroop-sse-last-event-id:${ticketId}`, '99')

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const logRefreshSpy = vi.fn()
    window.addEventListener(SERVER_LOG_REFRESH_EVENT, logRefreshSpy)

    try {
      renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1)
      })

      await act(async () => {
        MockEventSource.instances[0]!.emitOpen()
      })

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ticket', ticketId] })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tickets'] })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ticket-artifacts', ticketId] })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['interview', ticketId] })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['artifact', ticketId, 'execution-setup-plan'] })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ticket-beads', ticketId] })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['artifact', ticketId, 'beads'] })
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['manual-qa', ticketId] })
        expect(logRefreshSpy).toHaveBeenCalledWith(expect.objectContaining({
          detail: { ticketId },
        }))
      })
    } finally {
      window.removeEventListener(SERVER_LOG_REFRESH_EVENT, logRefreshSpy)
    }
  })

  it('debounces AI details invalidation when model metrics arrive', async () => {
    const ticketId = '1:T-42'
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const onEvent = vi.fn<SSEHandler>()
    renderHook(() => useSSE({ ticketId, onEvent }))

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    await act(async () => {
      MockEventSource.instances[0]!.emit('ai_metrics', {
        ticketId,
        phase: 'CODING',
        modelId: 'openai/gpt-5.4',
      }, '')
      MockEventSource.instances[0]!.emit('ai_metrics', {
        ticketId,
        phase: 'CODING',
        modelId: 'openai/gpt-5.4',
      }, '')
    })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ticket-ai-details', ticketId] })
    })
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'ai_metrics' }))
  })

  it('settles a pending AI details invalidation when the ticket is left, and only once', async () => {
    const ticketId = '1:T-left'
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))

    await act(async () => {
      MockEventSource.instances[0]!.emit('ai_metrics', {
        ticketId,
        phase: 'CODING',
        modelId: 'openai/gpt-5.4',
      }, '')
    })

    const aiDetailsKey = { queryKey: ['ticket-ai-details', ticketId] }
    // Still inside the debounce window: the refresh is owed but has not been paid yet.
    expect(invalidateSpy).not.toHaveBeenCalledWith(aiDetailsKey)

    await act(async () => {
      unmount()
    })

    // Leaving pays it immediately rather than dropping it. Cancelling would be a real loss: the
    // details query holds its data for 30s, so returning inside that window would show the metrics
    // from before the event.
    const callsAfterUnmount = invalidateSpy.mock.calls.filter(
      ([arg]) => JSON.stringify(arg) === JSON.stringify(aiDetailsKey),
    ).length
    expect(callsAfterUnmount).toBe(1)

    // The debounce timer lives in module scope, so it outlives the hook that scheduled it. Waiting
    // past the delay is the only way to tell from outside that the handle was cleared and no second
    // invalidation is queued against a ticket nobody is looking at any more.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })

    const callsAfterDelay = invalidateSpy.mock.calls.filter(
      ([arg]) => JSON.stringify(arg) === JSON.stringify(aiDetailsKey),
    ).length
    expect(callsAfterDelay).toBe(1)
  })

  it('tracks reconnecting state when the live stream drops', async () => {
    const ticketId = '1:T-42'
    const { result } = renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
      expect(result.current.connectionState).toBe('connecting')
    })

    const source = MockEventSource.instances[0]!

    await act(async () => {
      source.emitOpen()
    })

    await waitFor(() => {
      expect(result.current.connectionState).toBe('connected')
    })

    await act(async () => {
      source.emitTransportError()
    })

    await waitFor(() => {
      expect(result.current.connectionState).toBe('reconnecting')
    })
  })

  it('reconciles ticket caches immediately when the SSE transport errors', async () => {
    const ticketId = '1:T-42'
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    renderHook(() => useSSE({ ticketId, onEvent: vi.fn<SSEHandler>() }))

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1)
    })

    const source = MockEventSource.instances[0]!

    await act(async () => {
      source.emitTransportError()
    })

    await waitFor(() => {
      expect(source.closed).toBe(true)
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ticket', ticketId] })
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tickets'] })
    })
  })
})
