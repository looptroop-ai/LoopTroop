import type { ReactNode, Ref } from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogEntry } from '@/context/LogContext'
import { LogContext } from '@/context/logContextDef'
import type { LogContextValue } from '@/context/logUtils'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Ticket } from '@/hooks/useTickets'
import { makeRuntimeBead, type RuntimeBeadInput } from '@/test/factories'
import { createJsonResponse, createTestQueryClient } from '@/test/renderHelpers'
import { QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({
    children,
    viewportRef,
    className,
  }: {
    children: ReactNode
    viewportRef?: Ref<HTMLDivElement>
    className?: string
  }) => (
    <div className={className}>
      <div ref={viewportRef} data-testid="log-viewport">
        {children}
      </div>
    </div>
  ),
}))

import { PhaseLogPanel } from '../PhaseLogPanel'

const animationFrames = new Map<number, FrameRequestCallback>()
let nextAnimationFrameId = 1
const writeTextMock = vi.fn(() => Promise.resolve())
const scrollToMock = vi.fn(function scrollTo(this: HTMLElement, options?: ScrollToOptions | number) {
  if (typeof options === 'object' && options && typeof options.top === 'number') {
    this.scrollTop = options.top
  }
})
const originalQueueMicrotask = globalThis.queueMicrotask

function flushAnimationFrames() {
  act(() => {
    while (animationFrames.size > 0) {
      const pending = Array.from(animationFrames.entries())
      animationFrames.clear()
      for (const [, callback] of pending) {
        callback(0)
      }
    }
  })
}

function makeLog(id: string, line: string, overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id,
    entryId: id,
    line,
    source: 'system',
    status: 'CODING',
    timestamp: '2026-03-10T10:00:00.000Z',
    audience: 'all',
    kind: 'milestone',
    streaming: false,
    op: 'append',
    ...overrides,
  }
}

function makeTicket(runtimeOverrides: Omit<Partial<Ticket['runtime']>, 'beads'> & { beads?: RuntimeBeadInput[] } = {}): Ticket {
  const defaultRuntime: Ticket['runtime'] = {
    baseBranch: 'main',
    currentBead: 1,
    completedBeads: 0,
    totalBeads: 0,
    percentComplete: 0,
    iterationCount: 0,
    maxIterations: null,
    maxIterationsPerBead: null,
    activeBeadId: null,
    activeBeadIteration: null,
    lastFailedBeadId: null,
    artifactRoot: '/tmp/test',
    beads: [],
    candidateCommitSha: null,
    preSquashHead: null,
    finalTestStatus: 'pending',
  }

  return {
    id: 'ticket-1',
    externalId: 'T-1',
    projectId: 1,
    isDisplayOnlyMock: false,
    title: 'Test ticket',
    description: null,
    priority: 1,
    status: 'CODING',
    xstateSnapshot: null,
    branchName: null,
    currentBead: 1,
    totalBeads: 0,
    percentComplete: 0,
    errorMessage: null,
    lockedMainImplementer: null,
    lockedMainImplementerVariant: null,
    lockedInterviewQuestions: null,
    lockedCoverageFollowUpBudgetPercent: null,
    lockedMaxCoveragePasses: null,
    lockedCouncilMembers: [],
    lockedCouncilMemberVariants: null,
    availableActions: [],
    previousStatus: null,
    reviewCutoffStatus: null,
    startedAt: null,
    plannedDate: null,
    createdAt: '2026-03-10T10:00:00.000Z',
    updatedAt: '2026-03-10T10:00:00.000Z',
    implementationTiming: {
      activeDurationMs: 0,
      startedAt: null,
      lastPlannedBeadFinishedAt: null,
      manualQaFixDurationMs: 0,
      manualQaFixStartedAt: null,
      workspacePreparationDurationMs: 0,
      workspacePreparationStartedAt: null,
      finalTestingDurationMs: 0,
      finalTestingStartedAt: null,
      questionWaitingMs: 0,
    },
    runtime: {
      ...defaultRuntime,
      ...runtimeOverrides,
      beads: runtimeOverrides.beads?.map(makeRuntimeBead) ?? [],
    },
  }
}

function renderWithTooltipProvider(ui: React.ReactElement) {
  const queryClient = createTestQueryClient()
  return render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{children}</TooltipProvider>
      </QueryClientProvider>
    ),
  })
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'queueMicrotask', {
    configurable: true,
    writable: true,
    value: (callback: VoidFunction) => {
      callback()
    },
  })

  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: writeTextMock,
    },
  })

  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => {
      const id = nextAnimationFrameId++
      animationFrames.set(id, callback)
      return id
    },
  })

  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (id: number) => {
      animationFrames.delete(id)
    },
  })

  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return Number((this as HTMLElement).dataset.scrollHeight ?? 600)
    },
  })

  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return Number((this as HTMLElement).dataset.clientHeight ?? 200)
    },
  })

  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return Number((this as HTMLElement).dataset.scrollTop ?? 0)
    },
    set(value: number) {
      ;(this as HTMLElement).dataset.scrollTop = String(value)
    },
  })

  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: scrollToMock,
  })
})

afterAll(() => {
  Object.defineProperty(globalThis, 'queueMicrotask', {
    configurable: true,
    writable: true,
    value: originalQueueMicrotask,
  })
})

beforeEach(() => {
  animationFrames.clear()
  nextAnimationFrameId = 1
  scrollToMock.mockClear()
  writeTextMock.mockClear()
})

describe('PhaseLogPanel', () => {
  it('shows lazy AI details without changing the visible entry count', async () => {
    const aiLog = makeLog('ai-1', '[MODEL] Done', {
      source: 'model:openai/gpt-5.4',
      audience: 'ai',
      kind: 'text',
      modelId: 'openai/gpt-5.4',
      variant: 'high',
    })
    const payload = {
      scope: 'phase',
      phase: 'CODING',
      phaseAttempt: null,
      modelId: null,
      summary: {
        turns: 1,
        sessions: 1,
        costUsd: 0.01,
        tokens: { total: 100, input: 80, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        timingMs: { total: 1000, average: 1000, longest: 1000 },
        coverage: { costTurns: 1, tokenTurns: 1, timingTurns: 1 },
      },
      updatedAt: null,
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => createJsonResponse(payload))

    renderWithTooltipProvider(
      <PhaseLogPanel phase="CODING" logs={[aiLog]} ticket={makeTicket()} defaultTab="AI" />,
    )

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.getByText('1 entry')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'AI details' }))
    expect(await screen.findByText('$0.01')).toBeInTheDocument()
    expect(screen.getByLabelText('AI details').parentElement).toHaveClass('sticky', 'top-0')
    expect(screen.getByText('1 entry')).toBeInTheDocument()
    fetchSpy.mockRestore()
  })

  it('shows the configured effort for main and council model tabs', () => {
    const mainModel = 'openai/gpt-5.4'
    const councilModel = 'anthropic/claude-sonnet-4.6'
    const logs = [
      makeLog('main-ai', '[MODEL] Main output', {
        status: 'COUNCIL_DELIBERATING',
        source: `model:${mainModel}`,
        audience: 'ai',
        kind: 'text',
        modelId: mainModel,
        variant: 'medium',
      }),
      makeLog('council-ai', '[MODEL] Council output', {
        status: 'COUNCIL_DELIBERATING',
        source: `model:${councilModel}`,
        audience: 'ai',
        kind: 'text',
        modelId: councilModel,
      }),
    ]
    const ticket = {
      ...makeTicket(),
      lockedMainImplementer: mainModel,
      lockedMainImplementerVariant: 'high',
      lockedCouncilMembers: [councilModel],
      lockedCouncilMemberVariants: null,
    }

    renderWithTooltipProvider(
      <PhaseLogPanel phase="COUNCIL_DELIBERATING" logs={logs} ticket={ticket} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show models' }))
    expect(screen.getByTitle(`${mainModel} · Effort: high`)).toBeInTheDocument()
    expect(screen.getByTitle(`${councilModel} · Effort: None (provider default)`)).toBeInTheDocument()
  })

  it('virtualizes large historical row sets', () => {
    const logs = Array.from({ length: 250 }, (_, index) => makeLog(`bulk-${index}`, `[SYS] Bulk row ${index}`))
    renderWithTooltipProvider(<PhaseLogPanel phase="CODING" logs={logs} />)

    expect(screen.getByTestId('virtualized-log-list')).toBeInTheDocument()
    expect(screen.queryAllByText(/Bulk row/).length).toBeLessThan(logs.length)
  })

  it('reveals the initial log page after switching tickets in the same phase', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      return createJsonResponse({
        entries: [{
          phase: 'CODING',
          entryId: url.includes('/ticket-2/') ? 'ticket-2-log' : 'ticket-1-log',
          content: url.includes('/ticket-2/') ? 'Second ticket log.' : 'First ticket log.',
          timestamp: '2026-03-13T10:00:02.000Z',
        }],
        olderCursor: null,
        hasOlder: false,
      })
    })
    try {
      const rendered = renderWithTooltipProvider(<PhaseLogPanel phase="CODING" ticket={makeTicket()} />)
      expect(await screen.findByText('First ticket log.')).toBeInTheDocument()

      const viewport = screen.getByTestId('log-viewport')
      viewport.scrollTop = 0
      fireEvent.scroll(viewport)
      scrollToMock.mockClear()

      rendered.rerender(
        <QueryClientProvider client={createTestQueryClient()}>
          <TooltipProvider>
            <PhaseLogPanel phase="CODING" ticket={{ ...makeTicket(), id: 'ticket-2', externalId: 'T-2' }} />
          </TooltipProvider>
        </QueryClientProvider>,
      )

      expect(await screen.findByText('Second ticket log.')).toBeInTheDocument()
      expect(scrollToMock).toHaveBeenCalledWith(expect.objectContaining({ top: 600, behavior: 'auto' }))
      expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining([
        expect.stringContaining('/api/tickets/ticket-1/logs?'),
        expect.stringContaining('/api/tickets/ticket-2/logs?'),
      ]))
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('shows a first-line indicator while loading older phase logs', async () => {
    let resolveOlder!: (response: Response) => void
    const olderResponse = new Promise<Response>((resolve) => {
      resolveOlder = resolve
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{
          type: 'info',
          phase: 'CODING',
          status: 'CODING',
          source: 'system',
          content: 'Newest phase row.',
          entryId: 'phase-newest',
          timestamp: '2026-03-13T10:00:02.000Z',
        }],
        olderCursor: 'phase-older',
        hasOlder: true,
        totalEntries: 2000,
        totalTextLines: 4821,
      }))
      .mockImplementationOnce(() => olderResponse)

    try {
      renderWithTooltipProvider(<PhaseLogPanel phase="CODING" ticket={makeTicket()} />)
      expect(await screen.findByText('Newest phase row.')).toBeInTheDocument()
      const countTrigger = screen.getByRole('button', { name: '2,000 entries' })
      fireEvent.focus(countTrigger)
      await waitFor(() => {
        expect(screen.getAllByText('1 loaded · 1,999 remaining').length).toBeGreaterThan(0)
        expect(screen.getAllByText('4,821 text lines').length).toBeGreaterThan(0)
        expect(screen.getAllByText('Log Colors Legend').length).toBeGreaterThan(0)
      })

      const viewport = screen.getByTestId('log-viewport')
      viewport.scrollTop = 0
      fireEvent.scroll(viewport)

      expect(await screen.findByRole('status')).toHaveTextContent('Loading remaining logs')
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        '/api/tickets/ticket-1/logs?scope=phase&view=overview&limit=250&phase=CODING&before=phase-older',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )

      viewport.dataset.scrollHeight = '900'
      resolveOlder(new Response(JSON.stringify({
        entries: [{
          type: 'info',
          phase: 'CODING',
          status: 'CODING',
          source: 'system',
          content: 'Older phase row.',
          entryId: 'phase-older-row',
          timestamp: '2026-03-13T10:00:01.000Z',
        }],
        olderCursor: null,
        hasOlder: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      await waitFor(() => expect(screen.queryByText(/Loading remaining logs/)).not.toBeInTheDocument())
      expect(viewport.scrollTop).toBe(300)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('shows pending feedback while exporting complete phase history for Copy all', async () => {
    let resolveExport!: (response: Response) => void
    const exportResponse = new Promise<Response>((resolve) => {
      resolveExport = resolve
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.includes('/logs/export?')) return exportResponse
      return createJsonResponse({
        entries: [{
          type: 'info',
          phase: 'CODING',
          status: 'CODING',
          source: 'system',
          content: 'Visible phase row.',
          entryId: 'visible-phase-row',
          timestamp: '2026-03-13T10:00:03.000Z',
        }],
        olderCursor: 'older-phase-cursor',
        hasOlder: true,
      })
    })

    try {
      renderWithTooltipProvider(<PhaseLogPanel phase="CODING" ticket={makeTicket()} />)
      expect(await screen.findByText('Visible phase row.')).toBeInTheDocument()
      const copyButton = screen.getByRole('button', { name: 'Copy all logs' })

      fireEvent.click(copyButton)
      expect(copyButton).toBeDisabled()
      expect(copyButton.querySelector('.animate-spin')).toBeInTheDocument()

      resolveExport(new Response('[complete phase history]', { status: 200 }))
      await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith('[complete phase history]'))
      await waitFor(() => expect(copyButton).not.toBeDisabled())
      expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes('/logs/export?'))).toHaveLength(1)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('shows the remaining-history indicator above a virtualized phase log', async () => {
    let resolveOlder!: (response: Response) => void
    const olderResponse = new Promise<Response>((resolve) => {
      resolveOlder = resolve
    })
    const entries = Array.from({ length: 201 }, (_, index) => ({
      type: 'info',
      phase: 'CODING',
      status: 'CODING',
      source: 'system',
      content: `Virtual phase row ${index}.`,
      entryId: `virtual-phase-${index}`,
      timestamp: `2026-03-13T10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse({
        entries,
        olderCursor: 'virtual-phase-older',
        hasOlder: true,
      }))
      .mockImplementationOnce(() => olderResponse)

    try {
      renderWithTooltipProvider(<PhaseLogPanel phase="CODING" ticket={makeTicket()} />)
      expect(await screen.findByTestId('virtualized-log-list')).toBeInTheDocument()

      const viewport = screen.getByTestId('log-viewport')
      viewport.scrollTop = 0
      fireEvent.scroll(viewport)

      expect(await screen.findByRole('status')).toHaveTextContent('Loading remaining logs')
      expect(screen.getByTestId('virtualized-log-list')).toBeInTheDocument()

      resolveOlder(new Response(JSON.stringify({
        entries: [],
        olderCursor: null,
        hasOlder: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      await waitFor(() => expect(screen.queryByText(/Loading remaining logs/)).not.toBeInTheDocument())
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('asks for phase debug logs only after the DEBUG tab is selected', () => {
    const loadLogsForPhase = vi.fn()
    const value: LogContextValue = {
      logsByPhase: {},
      activePhase: null,
      isLoadingLogs: false,
      addLog: vi.fn(),
      addLogRecord: vi.fn(),
      getLogsForPhase: vi.fn(() => []),
      getAllLogs: vi.fn(() => []),
      setActivePhase: vi.fn(),
      loadLogsForPhase,
      isLoadingLogScope: vi.fn(() => false),
      clearLogs: vi.fn(),
    }

    renderWithTooltipProvider(
      <LogContext.Provider value={value}>
        <PhaseLogPanel phase="CODING" />
      </LogContext.Provider>,
    )

    expect(loadLogsForPhase).toHaveBeenCalledWith('CODING')
    expect(loadLogsForPhase).not.toHaveBeenCalledWith('CODING', { channel: 'debug' })

    fireEvent.click(screen.getByRole('button', { name: 'DEBUG' }))

    expect(loadLogsForPhase).toHaveBeenCalledWith('CODING', { channel: 'debug' })
  })

  it('keeps active multi-attempt logs live while filtering by phaseAttempt', () => {
    const loadLogsForPhase = vi.fn()
    const getLogsForPhase = vi.fn(() => [
      makeLog('attempt-2-live', '[SYS] Runtime setup is still streaming.', {
        status: 'PREPARING_EXECUTION_ENV',
        phaseAttempt: 2,
      }),
    ])
    const value: LogContextValue = {
      logsByPhase: {},
      activePhase: null,
      isLoadingLogs: false,
      addLog: vi.fn(),
      addLogRecord: vi.fn(),
      getLogsForPhase,
      getAllLogs: vi.fn(() => []),
      setActivePhase: vi.fn(),
      loadLogsForPhase,
      isLoadingLogScope: vi.fn(() => false),
      clearLogs: vi.fn(),
    }

    renderWithTooltipProvider(
      <LogContext.Provider value={value}>
        <PhaseLogPanel phase="PREPARING_EXECUTION_ENV" phaseAttempt={2} />
      </LogContext.Provider>,
    )

    expect(loadLogsForPhase).toHaveBeenCalledWith('PREPARING_EXECUTION_ENV', { phaseAttempt: 2 })
    expect(getLogsForPhase).toHaveBeenCalledWith('PREPARING_EXECUTION_ENV', { phaseAttempt: 2 })
    expect(screen.getByText(/Runtime setup is still streaming/i)).toBeInTheDocument()
  })

  it('loads snapshot attempts directly instead of subscribing to live logs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ entries: [
        {
          type: 'info',
          phase: 'PREPARING_EXECUTION_ENV',
          status: 'PREPARING_EXECUTION_ENV',
          phaseAttempt: 1,
          source: 'system',
          content: 'Archived runtime setup row.',
          entryId: 'archived-runtime-row',
          timestamp: '2026-03-13T10:00:01.000Z',
        },
      ], olderCursor: null, hasOlder: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const loadLogsForPhase = vi.fn()
    const value: LogContextValue = {
      logsByPhase: {},
      activePhase: null,
      isLoadingLogs: false,
      addLog: vi.fn(),
      addLogRecord: vi.fn(),
      getLogsForPhase: vi.fn(() => [
        makeLog('attempt-2-live', '[SYS] Live row should stay out.', {
          status: 'PREPARING_EXECUTION_ENV',
          phaseAttempt: 2,
        }),
      ]),
      getAllLogs: vi.fn(() => []),
      setActivePhase: vi.fn(),
      loadLogsForPhase,
      isLoadingLogScope: vi.fn(() => false),
      clearLogs: vi.fn(),
    }

    try {
      renderWithTooltipProvider(
        <LogContext.Provider value={value}>
          <PhaseLogPanel
            phase="PREPARING_EXECUTION_ENV"
            ticket={makeTicket()}
            phaseAttempt={1}
            logMode="snapshot"
          />
        </LogContext.Provider>,
      )

      await waitFor(() => {
        expect(screen.getByText(/Archived runtime setup row/i)).toBeInTheDocument()
      })
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/tickets/ticket-1/logs?scope=phase&view=overview&limit=20&phase=PREPARING_EXECUTION_ENV&phaseAttempt=1',
        expect.any(Object),
      )
      expect(loadLogsForPhase).not.toHaveBeenCalled()
      expect(screen.queryByText(/Live row should stay out/i)).not.toBeInTheDocument()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('asks for phase AI detail logs when AI or model tabs are selected', () => {
    const loadLogsForPhase = vi.fn()
    const logs = [
      makeLog('sys-1', '[SYS] System event'),
      makeLog('ai-1', '[MODEL] First output', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
        sessionId: 'session-1',
      }),
      makeLog('ai-2', '[MODEL] Second output', {
        source: 'model:anthropic/claude-sonnet-4.6',
        audience: 'ai',
        kind: 'text',
        modelId: 'anthropic/claude-sonnet-4.6',
        sessionId: 'session-2',
      }),
    ]
    const value: LogContextValue = {
      logsByPhase: { CODING: logs },
      activePhase: null,
      isLoadingLogs: false,
      addLog: vi.fn(),
      addLogRecord: vi.fn(),
      getLogsForPhase: vi.fn(() => logs),
      getAllLogs: vi.fn(() => logs),
      setActivePhase: vi.fn(),
      loadLogsForPhase,
      isLoadingLogScope: vi.fn(() => false),
      clearLogs: vi.fn(),
    }

    renderWithTooltipProvider(
      <LogContext.Provider value={value}>
        <PhaseLogPanel phase="CODING" />
      </LogContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'AI' }))

    expect(loadLogsForPhase).toHaveBeenLastCalledWith('CODING', { channel: 'ai' })
    expect(screen.getByText(/First output/i)).toBeInTheDocument()
    expect(screen.queryByText(/System event/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show models' }))
    fireEvent.click(screen.getByTitle('openai/gpt-5.4 · Effort: Not reported'))

    expect(loadLogsForPhase).toHaveBeenLastCalledWith('CODING', { channel: 'ai' })
    expect(screen.getByText(/First output/i)).toBeInTheDocument()
    expect(screen.queryByText(/Second output/i)).not.toBeInTheDocument()
  })

  it('keeps raw model output out of SYS and ERROR after switching through the AI model tab', () => {
    const phase = 'VERIFYING_PRD_COVERAGE'
    const modelId = 'openai/gpt-5.4'
    const logs: LogEntry[] = [
      makeLog('sys-coverage', '[SYS] Coverage verification started using winning model.', {
        status: phase,
        source: 'system',
        audience: 'all',
        kind: 'milestone',
        modelId,
      }),
      makeLog('error-coverage', '[ERROR] Coverage verification failed before parsing.', {
        status: phase,
        source: 'error',
        audience: 'all',
        kind: 'error',
      }),
      makeLog('ai-coverage', [
        '[MODEL] Coverage audit response',
        'The string [ERROR] quoted error token is part of the model answer.',
        '[SYS] quoted system token is also model text.',
        '[CMD] $ npm test is a suggested command, not an executed command.',
      ].join('\n'), {
        status: phase,
        source: `model:${modelId}`,
        audience: 'ai',
        kind: 'text',
        modelId,
        sessionId: 'coverage-session-1',
      }),
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase={phase} logs={logs} defaultTab="SYS" />)

    expect(screen.getByText(/Coverage verification started/i)).toBeInTheDocument()
    expect(screen.queryByText(/quoted error token/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'AI > gpt-5.4' }))

    expect(screen.getByText(/quoted error token/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'SYS' }))

    expect(screen.getByText(/Coverage verification started/i)).toBeInTheDocument()
    expect(screen.queryByText(/quoted error token/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'ERROR' }))

    expect(screen.getByText(/Coverage verification failed before parsing/i)).toBeInTheDocument()
    expect(screen.queryByText(/quoted error token/i)).not.toBeInTheDocument()
  })

  it('shows canonical raw AI output in ALL while suppressing transcript and summary duplicates', () => {
    const logs: LogEntry[] = [
      {
        id: 'sys-1',
        entryId: 'sys-1',
        line: '[SYS] Interview council drafting started.',
        source: 'system',
        status: 'COUNCIL_DELIBERATING',
        timestamp: '2026-03-10T10:00:00.000Z',
        audience: 'all',
        kind: 'milestone',
        streaming: false,
        op: 'append',
      },
      {
        id: 'ai-1',
        entryId: 'ses-1:msg-1:text',
        line: '[MODEL] questions:\n  - id: Q01\n    phase: foundation\n    question: "Confidence in timing?"',
        source: 'model:openai/gpt-5-mini',
        status: 'COUNCIL_DELIBERATING',
        timestamp: '2026-03-10T10:00:01.000Z',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5-mini',
        sessionId: 'ses-1',
        streaming: false,
        op: 'append',
      },
      {
        id: 'ai-2',
        entryId: 'ses-1:transcript-summary',
        line: '[MODEL] [assistant] [2026-03-10T10:00:01.000Z] questions:\n  - id: Q01\n    phase: foundation\n    question: "Confidence in timing?"',
        source: 'model:openai/gpt-5-mini',
        status: 'COUNCIL_DELIBERATING',
        timestamp: '2026-03-10T10:00:01.100Z',
        audience: 'ai',
        kind: 'session',
        modelId: 'openai/gpt-5-mini',
        sessionId: 'ses-1',
        streaming: false,
        op: 'append',
      },
      {
        id: 'ai-3',
        entryId: 'ses-1:questions-preview',
        line: '[MODEL] Questions received from openai/gpt-5-mini (1 total):\n- [foundation] Timing confidence first?',
        source: 'model:openai/gpt-5-mini',
        status: 'COUNCIL_DELIBERATING',
        timestamp: '2026-03-10T10:00:01.200Z',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5-mini',
        sessionId: 'ses-1',
        streaming: false,
        op: 'append',
      },
      {
        id: 'ai-4',
        entryId: 'ses-1:status',
        line: '[MODEL] Session status: running.',
        source: 'model:openai/gpt-5-mini',
        status: 'COUNCIL_DELIBERATING',
        timestamp: '2026-03-10T10:00:01.500Z',
        audience: 'ai',
        kind: 'session',
        modelId: 'openai/gpt-5-mini',
        sessionId: 'ses-1',
        streaming: false,
        op: 'append',
      },
      {
        id: 'debug-1',
        entryId: 'debug-1',
        line: '[DEBUG] raw provider payload',
        source: 'debug',
        status: 'COUNCIL_DELIBERATING',
        timestamp: '2026-03-10T10:00:02.000Z',
        audience: 'debug',
        kind: 'session',
        streaming: false,
        op: 'append',
      },
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="COUNCIL_DELIBERATING" logs={logs} />)

    expect(screen.getByText(/Interview council drafting started/i)).toBeInTheDocument()
    expect(screen.getAllByText(/Confidence in timing\?/i)).toHaveLength(1)
    expect(screen.queryByText(/\[assistant\]/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Questions received from openai\/gpt-5-mini/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Session status: running/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/raw provider payload/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'AI' }))

    expect(screen.getByText(/Session status: running/i)).toBeInTheDocument()
    expect(screen.getAllByText(/Confidence in timing\?/i)).toHaveLength(1)
    expect(screen.queryByText(/\[assistant\]/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Questions received from openai\/gpt-5-mini/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'DEBUG' }))

    expect(screen.getByText(/raw provider payload/i)).toBeInTheDocument()
  })

  it('keeps AI error rows visible when legacy summary entry ids are reused for failures', () => {
    const logs: LogEntry[] = [
      {
        id: 'ai-text',
        entryId: 'ses-9:msg-1:text',
        line: '[MODEL] prd:\n  title: Canonical PRD',
        source: 'model:openai/gpt-5-codex',
        status: 'DRAFTING_PRD',
        timestamp: '2026-03-10T10:00:01.000Z',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5-codex',
        sessionId: 'ses-9',
        streaming: false,
        op: 'append',
      },
      {
        id: 'ai-error',
        entryId: 'prd-full-answers-summary:openai/gpt-5-codex',
        line: '[ERROR] openai/gpt-5-codex failed to produce Full Answers.',
        source: 'model:openai/gpt-5-codex',
        status: 'DRAFTING_PRD',
        timestamp: '2026-03-10T10:00:02.000Z',
        audience: 'ai',
        kind: 'error',
        modelId: 'openai/gpt-5-codex',
        streaming: false,
        op: 'append',
      },
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="DRAFTING_PRD" logs={logs} />)

    expect(screen.getByText(/Canonical PRD/i)).toBeInTheDocument()
    expect(screen.getByText(/failed to produce Full Answers/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'AI' }))

    expect(screen.getByText(/Canonical PRD/i)).toBeInTheDocument()
    expect(screen.getByText(/failed to produce Full Answers/i)).toBeInTheDocument()
  })

  it('shows model-aware MODEL and THINKING tags in aggregated log tabs', () => {
    const logs: LogEntry[] = [
      {
        id: 'ai-summary',
        entryId: 'ai-summary',
        line: '[MODEL] Questions received from openai/gpt-5-codex (2 total):\n- [foundation] What problem are we solving?\n- [structure] Which users should be supported first?',
        source: 'model:openai/gpt-5-codex',
        status: 'COUNCIL_DELIBERATING',
        timestamp: '2026-03-10T10:00:01.000Z',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5-codex',
        streaming: false,
        op: 'append',
      },
      {
        id: 'ai-status',
        entryId: 'ai-status',
        line: '[MODEL] Session status: running.',
        source: 'model:openai/gpt-5-codex',
        status: 'COUNCIL_DELIBERATING',
        timestamp: '2026-03-10T10:00:01.500Z',
        audience: 'ai',
        kind: 'session',
        modelId: 'openai/gpt-5-codex',
        streaming: false,
        op: 'append',
      },
      {
        id: 'ai-thinking',
        entryId: 'ai-thinking',
        line: 'Checking whether the interview coverage is balanced.',
        source: 'model:openai/gpt-5-codex',
        status: 'COUNCIL_DELIBERATING',
        timestamp: '2026-03-10T10:00:02.000Z',
        audience: 'ai',
        kind: 'reasoning',
        modelId: 'openai/gpt-5-codex',
        streaming: false,
        op: 'append',
      },
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="COUNCIL_DELIBERATING" logs={logs} />)

    expect(screen.getByText(/\[OUTPUT-openai\/gpt-5-codex\]/i)).toBeInTheDocument()
    expect(screen.queryByText(/\[THINKING-openai\/gpt-5-codex\]/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'AI' }))

    expect(screen.getAllByText(/\[OUTPUT-openai\/gpt-5-codex\]/i)).toHaveLength(2)
    expect(screen.getByText(/\[THINKING-openai\/gpt-5-codex\]/i)).toBeInTheDocument()
    expect(screen.getByText(/Checking whether the interview coverage is balanced/i)).toBeInTheDocument()
  })

  it('shows the thinking header only once in a truncated streaming preview', () => {
    const reasoningLines = Array.from({ length: 8 }, (_, index) => `Reasoning line ${index + 1}`)
    const logs: LogEntry[] = [
      makeLog('streaming-thinking', reasoningLines.join('\n'), {
        source: 'model:opencode/big-pickle',
        audience: 'ai',
        kind: 'reasoning',
        modelId: 'opencode/big-pickle',
        streaming: true,
        op: 'upsert',
      }),
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="CODING" defaultTab="AI" logs={logs} />)

    expect(screen.getAllByText('[THINKING-opencode/big-pickle]')).toHaveLength(1)
    expect(screen.getByText(/Reasoning line 8/)).toBeInTheDocument()
  })

  it('shows model-aware ERROR tags anywhere an AI error row is visible', () => {
    const logs: LogEntry[] = [
      {
        id: 'ai-error',
        entryId: 'ses-retry:retry:1',
        line: '[ERROR] Session retry #1: <none>',
        source: 'model:opencode/minimax-m2.5-free',
        status: 'DRAFTING_PRD',
        timestamp: '2026-04-07T07:30:44.719Z',
        audience: 'ai',
        kind: 'error',
        modelId: 'opencode/minimax-m2.5-free',
        sessionId: 'ses-retry',
        streaming: false,
        op: 'append',
      },
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="DRAFTING_PRD" logs={logs} />)

    const errorTag = screen.getByText(/\[ERROR-minimax-m2.5-free\]/i)
    expect(errorTag).toBeInTheDocument()
    expect(errorTag).not.toHaveAttribute('title')

    fireEvent.click(screen.getByRole('button', { name: 'AI' }))
    expect(screen.getByText(/\[ERROR-minimax-m2.5-free\]/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'ERROR' }))
    expect(screen.getByText(/\[ERROR-minimax-m2.5-free\]/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show models' }))
    fireEvent.click(screen.getByRole('button', { name: /minimax-m2\.5-free/i }))
    expect(screen.getByText(/\[ERROR-minimax-m2.5-free\]/i)).toBeInTheDocument()
  })

  it('keeps plain ERROR tags for rows without model attribution', () => {
    const logs: LogEntry[] = [
      {
        id: 'plain-error',
        entryId: 'plain-error',
        line: '[ERROR] Something failed before model attribution was available.',
        source: 'error',
        status: 'DRAFTING_PRD',
        timestamp: '2026-04-07T07:30:44.719Z',
        audience: 'all',
        kind: 'error',
        streaming: false,
        op: 'append',
      },
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="DRAFTING_PRD" logs={logs} />)

    expect(screen.getByText('[ERROR]')).toBeInTheDocument()
    expect(screen.queryByText(/\[ERROR-/i)).not.toBeInTheDocument()
  })

  it('includes the full model id when copying a single AI error row', async () => {
    const logs: LogEntry[] = [
      {
        id: 'ai-error',
        entryId: 'ses-retry:retry:1',
        line: '[ERROR] Session retry #1: <none>',
        source: 'model:opencode/minimax-m2.5-free',
        status: 'DRAFTING_PRD',
        timestamp: '2026-04-07T07:30:44.719Z',
        audience: 'ai',
        kind: 'error',
        modelId: 'opencode/minimax-m2.5-free',
        sessionId: 'ses-retry',
        streaming: false,
        op: 'append',
      },
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="DRAFTING_PRD" logs={logs} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy log entry' }))

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        '[2026-04-07T07:30:44.719Z] [ERROR-minimax-m2.5-free] Session retry #1: <none> [model: opencode/minimax-m2.5-free]',
      )
    })
  })

  it('keeps the single-entry copy button beside the sticky More/Less controls for long rows', async () => {
    const logs: LogEntry[] = [
      makeLog(
        'long-entry',
        [
          '[SYS] Long entry started',
          'line 2',
          'line 3',
          'line 4',
          'line 5',
          'line 6',
        ].join('\n'),
      ),
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="CODING" logs={logs} />)

    const copyButton = screen.getByRole('button', { name: 'Copy log entry' })
    const stickyActions = copyButton.closest('[data-log-entry-sticky-actions]')

    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
    expect(stickyActions).toBeInTheDocument()

    fireEvent.click(copyButton)

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith([
        '[2026-03-10T10:00:00.000Z] [SYS] Long entry started',
        'line 2',
        'line 3',
        'line 4',
        'line 5',
        'line 6',
      ].join('\n'))
    })
  })

  it('includes full model ids when copying filtered ERROR logs', async () => {
    const logs: LogEntry[] = [
      {
        id: 'ai-error-1',
        entryId: 'ses-retry-1:retry:1',
        line: '[ERROR] Session retry #1: <none>',
        source: 'model:opencode/minimax-m2.5-free',
        status: 'DRAFTING_PRD',
        timestamp: '2026-04-07T07:30:44.719Z',
        audience: 'ai',
        kind: 'error',
        modelId: 'opencode/minimax-m2.5-free',
        sessionId: 'ses-retry-1',
        streaming: false,
        op: 'append',
      },
      {
        id: 'ai-error-2',
        entryId: 'ses-retry-2:retry:1',
        line: '[ERROR] Session retry #1: rate limited',
        source: 'model:openai/gpt-5-codex',
        status: 'DRAFTING_PRD',
        timestamp: '2026-04-07T07:31:44.719Z',
        audience: 'ai',
        kind: 'error',
        modelId: 'openai/gpt-5-codex',
        sessionId: 'ses-retry-2',
        streaming: false,
        op: 'append',
      },
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="DRAFTING_PRD" logs={logs} />)

    fireEvent.click(screen.getByRole('button', { name: 'ERROR' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy all logs' }))

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith([
        '[2026-04-07T07:30:44.719Z] [ERROR-minimax-m2.5-free] Session retry #1: <none> [model: opencode/minimax-m2.5-free]',
        '[2026-04-07T07:31:44.719Z] [ERROR-gpt-5-codex] Session retry #1: rate limited [model: openai/gpt-5-codex]',
      ].join('\n'))
    })
  })

  it('shows prompt entries in ALL and AI while keeping generic AI session details AI-only', () => {
    const logs: LogEntry[] = [
      {
        id: 'prompt-1',
        entryId: 'prompt-1',
        line: '[PROMPT] openai/gpt-5-mini prompt #1\n## System Role\nYou are an expert product manager.',
        source: 'model:openai/gpt-5-mini',
        status: 'COUNCIL_DELIBERATING',
        timestamp: '2026-03-10T10:00:00.000Z',
        audience: 'ai',
        kind: 'prompt',
        modelId: 'openai/gpt-5-mini',
        sessionId: 'ses-1',
        streaming: false,
        op: 'append',
      },
      {
        id: 'session-1',
        entryId: 'session-1',
        line: '[MODEL] Session status: running.',
        source: 'model:openai/gpt-5-mini',
        status: 'COUNCIL_DELIBERATING',
        timestamp: '2026-03-10T10:00:01.000Z',
        audience: 'ai',
        kind: 'session',
        modelId: 'openai/gpt-5-mini',
        sessionId: 'ses-1',
        streaming: false,
        op: 'append',
      },
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="COUNCIL_DELIBERATING" logs={logs} />)

    expect(screen.getByText('[PROMPT-openai/gpt-5-mini]')).toBeInTheDocument()
    expect(screen.getByText(/Prompt #1/i)).toBeInTheDocument()
    expect(screen.getByText(/You are an expert product manager/i)).toBeInTheDocument()
    expect(screen.queryByText(/Session status: running/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'AI' }))

    expect(screen.getByText('[PROMPT-openai/gpt-5-mini]')).toBeInTheDocument()
    expect(screen.getByText(/Session status: running/i)).toBeInTheDocument()
  })

  it('collapses single-model AI tabs into one combined AI model tab', () => {
    const logs: LogEntry[] = [
      {
        id: 'coding-ai-1',
        entryId: 'coding-ai-1',
        line: '[MODEL] Session status: running.',
        source: 'model:openai/gpt-5.4',
        status: 'CODING',
        timestamp: '2026-03-10T10:00:01.000Z',
        audience: 'ai',
        kind: 'session',
        modelId: 'openai/gpt-5.4',
        streaming: false,
        op: 'append',
      },
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="CODING" logs={logs} />)

    expect(screen.getByRole('button', { name: 'AI > gpt-5.4' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show models' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'AI' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'AI > gpt-5.4' }))

    expect(screen.getByText(/Session status: running/i)).toBeInTheDocument()
  })

  it('shows system rows with modelId in the matching model tab without changing their color class', () => {
    const logs: LogEntry[] = [
      {
        id: 'sys-model-1',
        entryId: 'sys-model-1',
        line: '[SYS] OpenCode vote: openai/gpt-5.4 session=ses-1, messages=2, responseChars=622.',
        source: 'system',
        status: 'COUNCIL_VOTING_PRD',
        timestamp: '2026-03-10T10:00:00.000Z',
        audience: 'all',
        kind: 'milestone',
        modelId: 'openai/gpt-5.4',
        streaming: false,
        op: 'append',
      },
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="COUNCIL_VOTING_PRD" logs={logs} />)

    fireEvent.click(screen.getByRole('button', { name: 'Show models' }))
    fireEvent.click(screen.getByTitle('openai/gpt-5.4 · Effort: Not reported'))

    const line = screen.getByText(/OpenCode vote: openai\/gpt-5\.4 session=ses-1/i)
    const lineContainer = line.closest('.whitespace-pre-wrap') ?? line

    expect(line).toBeInTheDocument()
    expect(lineContainer).toHaveClass('text-foreground')
    expect(lineContainer).not.toHaveClass('text-green-500')
  })

  it('shows Drafting PRD part 1 output in ALL once the final response is received', () => {
    const systemLog = makeLog('sys-1', '[SYS] PRD drafting started.', {
      status: 'DRAFTING_PRD',
      timestamp: '2026-03-10T10:00:00.000Z',
    })
    const streamingAiLog: LogEntry = {
      id: 'ses-7:msg-1:text',
      entryId: 'ses-7:msg-1:text',
      line: '[MODEL] prd:\n  title: Final PRD Title',
      source: 'model:openai/gpt-5-codex',
      status: 'DRAFTING_PRD',
      timestamp: '2026-03-10T10:00:01.000Z',
      audience: 'ai',
      kind: 'text',
      modelId: 'openai/gpt-5-codex',
      sessionId: 'ses-7',
      streaming: true,
      op: 'upsert',
    }
    const appendReceivedAiLog: LogEntry = {
      ...streamingAiLog,
      timestamp: '2026-03-10T10:00:01.500Z',
      streaming: false,
      op: 'append',
    }
    const finalizedAiLog: LogEntry = {
      ...streamingAiLog,
      streaming: false,
      op: 'finalize',
      timestamp: '2026-03-10T10:00:02.000Z',
    }

    const { rerender } = renderWithTooltipProvider(<PhaseLogPanel phase="DRAFTING_PRD" logs={[systemLog, streamingAiLog]} />)

    expect(screen.getByText(/PRD drafting started/i)).toBeInTheDocument()
    expect(screen.queryByText(/Final PRD Title/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'AI' }))

    expect(screen.getByText(/Final PRD Title/i)).toBeInTheDocument()
    expect(screen.getByText('Stream')).toBeInTheDocument()
    expect(screen.getAllByText(/Final PRD Title/i)).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'ALL' }))

    expect(screen.queryByText(/Final PRD Title/i)).not.toBeInTheDocument()

    rerender(<PhaseLogPanel phase="DRAFTING_PRD" logs={[systemLog, appendReceivedAiLog]} />)

    expect(screen.getByText(/Final PRD Title/i)).toBeInTheDocument()
    expect(screen.queryByText('Stream')).not.toBeInTheDocument()
    expect(screen.getAllByText(/Final PRD Title/i)).toHaveLength(1)

    rerender(<PhaseLogPanel phase="DRAFTING_PRD" logs={[systemLog, finalizedAiLog]} />)

    expect(screen.getByText(/Final PRD Title/i)).toBeInTheDocument()
    expect(screen.queryByText('Stream')).not.toBeInTheDocument()
    expect(screen.getAllByText(/Final PRD Title/i)).toHaveLength(1)
  })

  it('does not show a Stream badge for non-text AI status rows even if they are marked streaming', () => {
    const stepLog: LogEntry = {
      id: 'ses-9:step-1',
      entryId: 'ses-9:step-1',
      line: '[SYS] Step started.',
      source: 'model:openai/gpt-5.4',
      status: 'CODING',
      timestamp: '2026-03-10T10:00:00.000Z',
      audience: 'ai',
      kind: 'step',
      modelId: 'openai/gpt-5.4',
      sessionId: 'ses-9',
      streaming: true,
      op: 'append',
    }
    const sessionLog: LogEntry = {
      id: 'ses-9:status',
      entryId: 'ses-9:status',
      line: '[SYS] Session status: busy.',
      source: 'model:openai/gpt-5.4',
      status: 'CODING',
      timestamp: '2026-03-10T10:00:01.000Z',
      audience: 'ai',
      kind: 'session',
      modelId: 'openai/gpt-5.4',
      sessionId: 'ses-9',
      streaming: true,
      op: 'upsert',
    }

    renderWithTooltipProvider(<PhaseLogPanel phase="CODING" logs={[stepLog, sessionLog]} />)

    fireEvent.click(screen.getByRole('button', { name: 'AI > gpt-5.4' }))

    expect(screen.getByText(/Step started/i)).toBeInTheDocument()
    expect(screen.getByText(/Session status: busy/i)).toBeInTheDocument()
    expect(screen.queryByText('Stream')).not.toBeInTheDocument()
  })

  it('pins the viewport to the latest logs by default and follows new visible entries', () => {
    const firstLog = makeLog('log-1', '[SYS] First visible log line')
    const secondLog = makeLog('log-2', '[SYS] Second visible log line', {
      timestamp: '2026-03-10T10:00:01.000Z',
    })

    const { rerender } = renderWithTooltipProvider(<PhaseLogPanel phase="CODING" logs={[firstLog]} />)

    flushAnimationFrames()

    expect(scrollToMock).toHaveBeenCalledTimes(1)
    expect(scrollToMock).toHaveBeenLastCalledWith({ top: 600, behavior: 'auto' })

    scrollToMock.mockClear()

    rerender(<PhaseLogPanel phase="CODING" logs={[firstLog, secondLog]} />)

    flushAnimationFrames()

    expect(scrollToMock).toHaveBeenCalledTimes(1)
    expect(scrollToMock).toHaveBeenLastCalledWith({ top: 600, behavior: 'smooth' })
  })

  it('jumps straight to the latest visible entry when logs arrive after an empty initial render', () => {
    const firstLog = makeLog('log-1', '[SYS] First visible log line')
    const secondLog = makeLog('log-2', '[SYS] Second visible log line', {
      timestamp: '2026-03-10T10:00:01.000Z',
    })

    const { rerender } = renderWithTooltipProvider(<PhaseLogPanel phase="CODING" logs={[]} />)

    flushAnimationFrames()
    scrollToMock.mockClear()

    rerender(<PhaseLogPanel phase="CODING" logs={[firstLog, secondLog]} />)

    flushAnimationFrames()

    expect(scrollToMock).toHaveBeenCalledTimes(1)
    expect(scrollToMock).toHaveBeenLastCalledWith({ top: 600, behavior: 'auto' })
  })

  it('stops auto-scroll after the user scrolls away and resumes once they return to the bottom', () => {
    const firstLog = makeLog('log-1', '[SYS] First visible log line')
    const secondLog = makeLog('log-2', '[SYS] Second visible log line', {
      timestamp: '2026-03-10T10:00:01.000Z',
    })
    const thirdLog = makeLog('log-3', '[SYS] Third visible log line', {
      timestamp: '2026-03-10T10:00:02.000Z',
    })

    const { rerender } = renderWithTooltipProvider(<PhaseLogPanel phase="CODING" logs={[firstLog]} />)

    flushAnimationFrames()
    scrollToMock.mockClear()

    const viewport = screen.getByTestId('log-viewport')
    viewport.scrollTop = 100
    fireEvent.scroll(viewport)

    rerender(<PhaseLogPanel phase="CODING" logs={[firstLog, secondLog]} />)

    flushAnimationFrames()

    expect(scrollToMock).not.toHaveBeenCalled()

    viewport.scrollTop = 360
    fireEvent.scroll(viewport)

    rerender(<PhaseLogPanel phase="CODING" logs={[firstLog, secondLog, thirdLog]} />)

    flushAnimationFrames()

    expect(scrollToMock).toHaveBeenCalledTimes(1)
    expect(scrollToMock).toHaveBeenLastCalledWith({ top: 600, behavior: 'smooth' })
  })

  it('explains that the ALL tab does not include every detailed log', async () => {
    renderWithTooltipProvider(
      <PhaseLogPanel
        phase="CODING"
        logs={[
          makeLog('log-1', '[SYS] System line'),
        ]}
      />,
    )

    const allTab = screen.getByRole('button', { name: 'ALL' })
    fireEvent.focus(allTab)

    await waitFor(() => {
      expect(screen.getAllByText(/does not include absolutely all logs/i).length).toBeGreaterThan(0)
      expect(screen.getAllByText(/check the other tabs for more details/i).length).toBeGreaterThan(0)
    })
  })

  it('shows the log color legend when hovering the entry count', async () => {
    renderWithTooltipProvider(
      <PhaseLogPanel
        phase="CODING"
        logs={[
          makeLog('log-1', '[PROMPT] Prompt line', {
            source: 'model:openai/gpt-5-mini',
            audience: 'ai',
            kind: 'prompt',
          }),
          makeLog('log-2', '[SYS] System line', {
            timestamp: '2026-03-10T10:00:01.000Z',
          }),
        ]}
      />,
    )

    const trigger = screen.getByRole('button', { name: '2 entries' })
    fireEvent.focus(trigger)

    await waitFor(() => {
      const legends = screen.getAllByText('Log Colors Legend')
      expect(legends.length).toBeGreaterThan(0)
      expect(screen.getAllByText('Prompt').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Final output').length).toBeGreaterThan(0)
      expect(screen.getAllByText('All entries loaded').length).toBeGreaterThan(0)
      expect(screen.getAllByText('2 text lines').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Tool call').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Input').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Output').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Runtime').length).toBeGreaterThan(0)
      expect(screen.getAllByText('System').length).toBeGreaterThan(0)
    })
  })

  it('colors OpenCode tool rows distinctly from generic AI events', () => {
    renderWithTooltipProvider(
      <PhaseLogPanel
        phase="CODING"
        defaultTab="AI"
        logs={[
          makeLog('tool-1', '[TOOL] bash completed: npm test\nInput:\n{"command":"npm test"}\nOutput:\npass\nError:\nstderr', {
            source: 'model:openai/gpt-5-mini',
            audience: 'ai',
            kind: 'tool',
            modelId: 'openai/gpt-5-mini',
          }),
        ]}
      />,
    )

    expect(screen.getByText('[TOOL-openai/gpt-5-mini]')).toHaveClass('text-cyan-600')
    expect(screen.getByText('Input:')).toHaveClass('text-sky-700')
    expect(screen.getByText('Output:')).toHaveClass('text-emerald-700')
    expect(screen.getByText('Error:')).toHaveClass('text-rose-700')
  })

  it('makes only safe provider recovery links interactive', () => {
    renderWithTooltipProvider(
      <PhaseLogPanel
        phase="CODING"
        defaultTab="ERROR"
        logs={[
          makeLog(
            'provider-action-safe',
            '[ERROR] Provider recovery required for openai. Suggested action: Check status — https://status.openai.com/.',
            {
              source: 'model:openai/gpt-5-mini',
              audience: 'ai',
              kind: 'error',
              modelId: 'openai/gpt-5-mini',
            },
          ),
          makeLog(
            'provider-action-unsafe',
            '[ERROR] Provider recovery required. Suggested action: Run script — javascript:alert(1)',
            {
              source: 'model:openai/gpt-5-mini',
              audience: 'ai',
              kind: 'error',
              modelId: 'openai/gpt-5-mini',
            },
          ),
        ]}
      />,
    )

    expect(screen.getByRole('link', { name: 'https://status.openai.com/' })).toMatchObject({
      target: '_blank',
      rel: 'noopener noreferrer',
    })
    expect(screen.getByText(/javascript:alert\(1\)/)).toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('separates command stdin stdout and stderr for both legacy and structured command rows', () => {
    renderWithTooltipProvider(
      <PhaseLogPanel
        phase="CODING"
        defaultTab="SYS"
        logs={[
          makeLog('cmd-legacy', '[CMD] $ git commit -m msg  →  STDOUT: abc1234 | STDERR: 1 file changed', {
            status: 'CODING',
            source: 'system',
          }),
          makeLog('cmd-structured', '[CMD] $ gh api graphql\nSTDIN:\n{"query":"{ viewer { login } }"}\nSTDOUT:\n{"data":{"viewer":{"login":"looptroop"}}}\nSTDERR:\nwarning: using cached token', {
            status: 'CODING',
            source: 'system',
          }),
        ]}
      />,
    )

    expect(screen.getByText('STDIN:')).toHaveClass('text-sky-700')
    const stdoutLabels = screen.getAllByText('STDOUT:')
    expect(stdoutLabels[0]).toHaveClass('text-emerald-700')
    expect(stdoutLabels[1]).toHaveClass('text-emerald-700')
    const stderrLabels = screen.getAllByText('STDERR:')
    expect(stderrLabels[0]).toHaveClass('text-rose-700')
    expect(stderrLabels[1]).toHaveClass('text-rose-700')
    expect(screen.getByText('abc1234')).toBeInTheDocument()
    expect(screen.getByText('1 file changed')).toBeInTheDocument()
    expect(screen.getByText('warning: using cached token')).toBeInTheDocument()
  })

  it('promotes all plain command outputs to stdout structured sections', () => {
    renderWithTooltipProvider(
      <PhaseLogPanel
        phase="CREATING_PULL_REQUEST"
        defaultTab="SYS"
        logs={[
          makeLog('cmd-json', '[CMD] $ gh repo view looptroop-ai/pocketbase-master --json nameWithOwner  →  {"nameWithOwner":"looptroop-ai/pocketbase-master"}', {
            status: 'CREATING_PULL_REQUEST',
            source: 'system',
          }),
          makeLog('cmd-version', '[CMD] $ gh --version  →  gh version 2.90.0 (2026-04-16) | https://github.com/cli/cli/releases/tag/v2.90.0', {
            status: 'CREATING_PULL_REQUEST',
            source: 'system',
          }),
          makeLog('cmd-short', '[CMD] $ git rev-parse HEAD  →  7e8c75dfb775861191b78a69b699ef13cd175ee9', {
            status: 'CREATING_PULL_REQUEST',
            source: 'system',
          }),
        ]}
      />,
    )

    const stdoutLabels = screen.getAllByText('STDOUT:')
    expect(stdoutLabels).toHaveLength(3)
    expect(stdoutLabels[0]).toHaveClass('text-emerald-700')
    expect(stdoutLabels[1]).toHaveClass('text-emerald-700')
    expect(stdoutLabels[2]).toHaveClass('text-emerald-700')
    expect(screen.getByText('{"nameWithOwner":"looptroop-ai/pocketbase-master"}')).toBeInTheDocument()
    expect(screen.getByText(/gh version 2\.90\.0/)).toBeInTheDocument()
    expect(screen.getByText(/\$ git rev-parse HEAD/)).toBeInTheDocument()
  })

  it('shows non-error command chatter in SYS while keeping ALL focused on higher-signal entries', () => {
    const logs: LogEntry[] = [
      makeLog('cmd-probe', '[CMD] $ git rev-parse --abbrev-ref HEAD  →  master', {
        status: 'DRAFT',
        source: 'system',
      }),
      makeLog('cmd-worktree', '[CMD] $ git worktree add /tmp/wt LTL-5  →  Preparing worktree', {
        status: 'DRAFT',
        source: 'system',
      }),
      makeLog('sys-1', '[SYS] Start requested.', {
        status: 'DRAFT',
      }),
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="DRAFT" logs={logs} />)

    expect(screen.queryByText(/rev-parse --abbrev-ref HEAD/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/worktree add/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Start requested/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'SYS' }))

    expect(screen.getByText(/rev-parse --abbrev-ref HEAD/i)).toBeInTheDocument()
    expect(screen.getByText(/worktree add/i)).toBeInTheDocument()
    expect(screen.getByText(/Start requested/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show commands' }))
    fireEvent.click(screen.getByRole('button', { name: 'CMD' }))

    expect(screen.getByText(/rev-parse --abbrev-ref HEAD/i)).toBeInTheDocument()
    expect(screen.getByText(/worktree add/i)).toBeInTheDocument()
  })

  it('shows real command failures in ALL and ERROR while keeping benign probe misses out of ERROR', () => {
    const logs: LogEntry[] = [
      makeLog('probe-error', '[CMD] $ git symbolic-ref --quiet --short refs/remotes/origin/HEAD  →  origin/HEAD not set', {
        status: 'DRAFT',
        source: 'system',
        kind: 'error',
      }),
      makeLog('real-cmd-error', '[CMD] $ git merge --no-edit LTL-5  →  error: merge conflict', {
        status: 'DRAFT',
        source: 'error',
        kind: 'error',
      }),
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="DRAFT" logs={logs} />)

    expect(screen.getByText(/merge --no-edit/i)).toBeInTheDocument()
    expect(screen.queryByText(/origin\/HEAD not set/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'ERROR' }))

    expect(screen.queryByText(/origin\/HEAD not set/i)).not.toBeInTheDocument()
    expect(screen.getByText(/merge --no-edit/i)).toBeInTheDocument()
  })

  it('shows the current activity strip below the toolbar and above the phase log body', () => {
    const logs: LogEntry[] = [
      makeLog('prompt-1', '[PROMPT] openai/gpt-5-codex prompt #1\ncontinue please', {
        source: 'model:openai/gpt-5-codex',
        audience: 'ai',
        kind: 'prompt',
        modelId: 'openai/gpt-5-codex',
        sessionId: 'ses_phase_current',
        beadId: 'bead-2',
      }),
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="CODING" logs={logs} />)

    const strip = screen.getByRole('status', { name: 'Current activity' })
    const viewport = screen.getByTestId('log-viewport')

    expect(strip).toHaveTextContent(/Waiting for first model activity/i)
    expect(strip).toHaveTextContent(/session ses_phase_current/i)
    expect(strip).toHaveTextContent(/bead bead-2/i)
    expect(Boolean(strip.compareDocumentPosition(viewport) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  })

  it('does not show stale near-timeout activity when reviewing a past phase', () => {
    const logs: LogEntry[] = [
      makeLog('prompt-past', '[PROMPT] openai/gpt-5-codex prompt #1\nDraft the PRD.', {
        status: 'DRAFTING_PRD',
        source: 'model:openai/gpt-5-codex',
        audience: 'ai',
        kind: 'prompt',
        modelId: 'openai/gpt-5-codex',
        sessionId: 'ses_past_prd',
        timeoutMs: 100_000,
        deadlineAt: '2026-03-10T10:01:40.000Z',
        timeoutKind: 'ai_response',
      }),
    ]

    renderWithTooltipProvider(
      <PhaseLogPanel
        phase="DRAFTING_PRD"
        logs={logs}
        ticket={{ ...makeTicket(), status: 'CODING' }}
      />,
    )

    expect(screen.queryByRole('status', { name: 'Current activity' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Approaching timeout/i)).not.toBeInTheDocument()
  })

  it('shows near-timeout activity while the viewed phase is the live ticket status', () => {
    const logs: LogEntry[] = [
      makeLog('prompt-live', '[PROMPT] openai/gpt-5-codex prompt #1\nDraft the PRD.', {
        status: 'DRAFTING_PRD',
        source: 'model:openai/gpt-5-codex',
        audience: 'ai',
        kind: 'prompt',
        modelId: 'openai/gpt-5-codex',
        sessionId: 'ses_live_prd',
        timeoutMs: 100_000,
        deadlineAt: '2026-03-10T10:01:40.000Z',
        timeoutKind: 'ai_response',
      }),
    ]

    renderWithTooltipProvider(
      <PhaseLogPanel
        phase="DRAFTING_PRD"
        logs={logs}
        ticket={{ ...makeTicket(), status: 'DRAFTING_PRD' }}
      />,
    )

    const strip = screen.getByRole('status', { name: 'Current activity' })

    expect(strip).toHaveTextContent(/Approaching timeout/i)
    expect(strip).toHaveTextContent(/session ses_live_prd/i)
  })

  it('renders bead delimiters in CODING phase', () => {
    const logs: LogEntry[] = [
      makeLog('preamble', '[SYS] Coding started'),
      makeLog('exec-1', '[SYS] Executing bead bead-1: First bead'),
      makeLog('bead-1-a', '[MODEL] Bead 1 output'),
      makeLog('exec-2', '[SYS] Executing bead bead-2: Second bead'),
      makeLog('bead-2-a', '[MODEL] Bead 2 output'),
    ]

    const ticket = makeTicket({
      totalBeads: 2,
      currentBead: 2,
      activeBeadId: 'bead-2',
      beads: [
        { id: 'bead-1', title: 'First bead', status: 'completed', iteration: 1 },
        { id: 'bead-2', title: 'Second bead', status: 'in_progress', iteration: 1 },
      ],
    })

    renderWithTooltipProvider(<PhaseLogPanel phase="CODING" logs={logs} ticket={ticket} />)

    expect(screen.getByText('Bead 1/2')).toBeInTheDocument()
    expect(screen.getByText('Bead 2/2')).toBeInTheDocument()
    expect(screen.getByText('First bead')).toBeInTheDocument()
    expect(screen.getByText('Second bead')).toBeInTheDocument()
  })

  it('does not render bead delimiters in non-CODING phases', () => {
    const logs: LogEntry[] = [
      makeLog('sys-1', '[SYS] PRD drafting started', { status: 'DRAFTING_PRD' }),
      makeLog('ai-1', '[MODEL] PRD output', { status: 'DRAFTING_PRD', source: 'model:openai/gpt-5.4', audience: 'ai', kind: 'text', modelId: 'openai/gpt-5.4' }),
    ]

    renderWithTooltipProvider(<PhaseLogPanel phase="DRAFTING_PRD" logs={logs} />)

    expect(screen.queryByText(/Bead \d+\/\d+/)).not.toBeInTheDocument()
  })

  it('hides bead delimiter when current tab filter removes all entries for that bead', () => {
    const logs: LogEntry[] = [
      makeLog('exec-1', '[SYS] Executing bead bead-1: First bead'),
      makeLog('bead-1-sys', '[SYS] Bead 1 system line'),
      makeLog('exec-2', '[SYS] Executing bead bead-2: Second bead'),
      makeLog('bead-2-ai', '[MODEL] Bead 2 output', { source: 'model:openai/gpt-5.4', audience: 'ai', kind: 'text', modelId: 'openai/gpt-5.4' }),
    ]

    const ticket = makeTicket({
      totalBeads: 2,
      currentBead: 2,
      activeBeadId: 'bead-2',
      beads: [
        { id: 'bead-1', title: 'First bead', status: 'completed', iteration: 1 },
        { id: 'bead-2', title: 'Second bead', status: 'in_progress', iteration: 1 },
      ],
    })

    renderWithTooltipProvider(<PhaseLogPanel phase="CODING" logs={logs} ticket={ticket} defaultTab="AI" />)

    // Bead 1 has no AI entries, so its delimiter should be hidden in the AI tab
    expect(screen.queryByText('Bead 1/2')).not.toBeInTheDocument()
    // Bead 2 has an AI entry, so its delimiter should show
    expect(screen.getByText('Bead 2/2')).toBeInTheDocument()
  })

  it('hides incomplete future beads when runtime data is available', () => {
    const logs: LogEntry[] = [
      makeLog('exec-1', '[SYS] Executing bead bead-1: First bead'),
      makeLog('bead-1-a', '[SYS] Bead 1 done'),
      makeLog('exec-2', '[SYS] Executing bead bead-2: Second bead'),
      makeLog('bead-2-a', '[SYS] Bead 2 in progress'),
      makeLog('exec-3', '[SYS] Executing bead bead-3: Third bead'),
      makeLog('bead-3-a', '[SYS] Bead 3 pending'),
      makeLog('exec-4', '[SYS] Executing bead bead-4: Fourth bead'),
      makeLog('bead-4-a', '[SYS] Bead 4 pending'),
    ]

    const ticket = makeTicket({
      totalBeads: 4,
      currentBead: 2,
      activeBeadId: 'bead-2',
      beads: [
        { id: 'bead-1', title: 'First bead', status: 'completed', iteration: 1 },
        { id: 'bead-2', title: 'Second bead', status: 'in_progress', iteration: 1 },
        { id: 'bead-3', title: 'Third bead', status: 'pending', iteration: 0 },
        { id: 'bead-4', title: 'Fourth bead', status: 'pending', iteration: 0 },
      ],
    })

    renderWithTooltipProvider(<PhaseLogPanel phase="CODING" logs={logs} ticket={ticket} />)

    expect(screen.getByText('Bead 1/4')).toBeInTheDocument()
    expect(screen.getByText('Bead 2/4')).toBeInTheDocument()
    expect(screen.queryByText('Bead 3/4')).not.toBeInTheDocument()
    expect(screen.queryByText('Bead 4/4')).not.toBeInTheDocument()
  })
})
