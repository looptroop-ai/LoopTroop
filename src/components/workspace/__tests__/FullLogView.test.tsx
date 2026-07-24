import type { ReactNode, Ref } from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogEntry } from '@/context/LogContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Ticket } from '@/hooks/useTickets'
import { makeRuntimeBead, TEST, type RuntimeBeadInput } from '@/test/factories'
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

const getAllLogsMock = vi.fn(() => [] as LogEntry[])
const getLogsForPhaseMock = vi.fn(() => [] as LogEntry[])
const loadAllLogsMock = vi.fn()
const isLoadingLogScopeMock = vi.fn(() => false)

vi.mock('@/context/useLogContext', () => ({
  useLogs: () => ({
    logsByPhase: {},
    activePhase: null,
    isLoadingLogs: false,
    addLog: vi.fn(),
    addLogRecord: vi.fn(),
    getLogsForPhase: getLogsForPhaseMock,
    getAllLogs: getAllLogsMock,
    setActivePhase: vi.fn(),
    loadAllLogs: loadAllLogsMock,
    isLoadingLogScope: isLoadingLogScopeMock,
    clearLogs: vi.fn(),
  }),
}))

import { FullLogView } from '../FullLogView'

const writeTextMock = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())

function makeLog(id: string, line: string, status: string, overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id,
    entryId: id,
    line,
    source: 'system',
    status,
    timestamp: TEST.timestamp,
    audience: 'all',
    kind: 'milestone',
    streaming: false,
    op: 'append',
    ...overrides,
  }
}

function makeTicket(overrides: Omit<Partial<Ticket>, 'runtime'> & { runtime?: Omit<Partial<Ticket['runtime']>, 'beads'> & { beads?: RuntimeBeadInput[] } } = {}): Ticket {
  const runtimeOverrides = overrides.runtime ?? {}
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
    artifactRoot: `/tmp/${TEST.externalId}`,
    beads: [],
    candidateCommitSha: null,
    preSquashHead: null,
    finalTestStatus: 'pending',
  }

  return {
    id: TEST.ticketId,
    externalId: TEST.externalId,
    projectId: TEST.projectId,
    isDisplayOnlyMock: false,
    title: 'Ticket title',
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
    createdAt: TEST.timestamp,
    updatedAt: TEST.timestamp,
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
    },
    ...overrides,
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
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeTextMock },
  })

  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    },
  })

  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: () => {},
  })
})

beforeEach(() => {
  getAllLogsMock.mockReset()
  getLogsForPhaseMock.mockReset()
  loadAllLogsMock.mockReset()
  isLoadingLogScopeMock.mockReset()
  isLoadingLogScopeMock.mockReturnValue(false)
  writeTextMock.mockClear()
})

describe('FullLogView', () => {
  it('loads lifecycle AI details only after its panel is opened', async () => {
    getAllLogsMock.mockReturnValue([
      makeLog('ai-1', '[MODEL] Done', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
        variant: 'high',
      }),
    ])
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.includes('/ai-details?')) {
        return createJsonResponse({
          scope: 'lifecycle',
          phase: null,
          phaseAttempt: null,
          modelId: null,
          summary: {
            turns: 1,
            sessions: 1,
            costUsd: 0.02,
            tokens: { total: 200, input: 150, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            timingMs: { total: 2000, average: 2000, longest: 2000 },
            coverage: { costTurns: 1, tokenTurns: 1, timingTurns: 1 },
          },
          updatedAt: null,
        })
      }
      return createJsonResponse({ entries: [], olderCursor: null, hasOlder: false })
    })

    renderWithTooltipProvider(<FullLogView ticket={makeTicket()} />)
    fireEvent.click(screen.getByRole('button', { name: /^AI/ }))
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/ai-details?'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'AI details' }))

    expect(await screen.findByText('$0.02')).toBeInTheDocument()
    expect(screen.getByLabelText('AI details').parentElement).toHaveClass('sticky', 'top-0')
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/ai-details?scope=lifecycle'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    fetchSpy.mockRestore()
  })

  it('shows configured effort on lifecycle model tabs', () => {
    const firstModel = 'openai/gpt-5.4'
    const secondModel = 'anthropic/claude-sonnet-4.6'
    getAllLogsMock.mockReturnValue([
      makeLog('first-ai', '[MODEL] First output', 'CODING', {
        source: `model:${firstModel}`,
        audience: 'ai',
        kind: 'text',
        modelId: firstModel,
        variant: 'medium',
      }),
      makeLog('second-ai', '[MODEL] Second output', 'CODING', {
        source: `model:${secondModel}`,
        audience: 'ai',
        kind: 'text',
        modelId: secondModel,
      }),
    ])

    renderWithTooltipProvider(
      <FullLogView
        ticket={makeTicket({
          lockedMainImplementer: firstModel,
          lockedMainImplementerVariant: 'xhigh',
          lockedCouncilMembers: [secondModel],
          lockedCouncilMemberVariants: null,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show models' }))
    expect(screen.getByTitle(`${firstModel} · Effort: xhigh`)).toBeInTheDocument()
    expect(screen.getByTitle(`${secondModel} · Effort: None (provider default)`)).toBeInTheDocument()
  })

  it('renders empty state when there are no logs', () => {
    getAllLogsMock.mockReturnValue([])
    renderWithTooltipProvider(<FullLogView />)
    expect(screen.getByText(/no log entries yet/i)).toBeTruthy()
  })

  it('shows a first-line indicator while loading older lifecycle logs', async () => {
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
          content: 'Newest lifecycle row.',
          entryId: 'lifecycle-newest',
          timestamp: '2026-03-13T10:00:02.000Z',
        }],
        olderCursor: 'lifecycle-older',
        hasOlder: true,
        totalEntries: 2000,
        totalTextLines: 4821,
      }))
      .mockImplementationOnce(() => olderResponse)

    try {
      renderWithTooltipProvider(<FullLogView ticket={makeTicket()} />)
      expect(await screen.findByText('Newest lifecycle row.')).toBeInTheDocument()
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
        `/api/tickets/${encodeURIComponent(TEST.ticketId)}/logs?scope=lifecycle&view=overview&limit=250&before=lifecycle-older`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )

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

  it('loads all older pages before going to the true top of Full Log', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{
          type: 'info',
          phase: 'CODING',
          status: 'CODING',
          source: 'system',
          content: 'Newest row.',
          entryId: 'newest',
          timestamp: '2026-03-13T10:00:03.000Z',
        }],
        olderCursor: 'middle-cursor',
        hasOlder: true,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{
          type: 'info',
          phase: 'CODING',
          status: 'CODING',
          source: 'system',
          content: 'Middle row.',
          entryId: 'middle',
          timestamp: '2026-03-13T10:00:02.000Z',
        }],
        olderCursor: 'oldest-cursor',
        hasOlder: true,
      }))
      .mockImplementationOnce(() => createJsonResponse({
        entries: [{
          type: 'info',
          phase: 'DRAFT',
          status: 'DRAFT',
          source: 'system',
          content: 'Oldest row.',
          entryId: 'oldest',
          timestamp: '2026-03-13T10:00:01.000Z',
        }],
        olderCursor: null,
        hasOlder: false,
      }))

    try {
      renderWithTooltipProvider(<FullLogView ticket={makeTicket()} />)
      expect(await screen.findByText('Newest row.')).toBeInTheDocument()

      const viewport = screen.getByTestId('log-viewport')
      Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 })
      Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 100 })
      viewport.scrollTop = 400
      viewport.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
        if (typeof options === 'object' && typeof options.top === 'number') viewport.scrollTop = options.top
      })
      fireEvent.scroll(viewport)
      fireEvent.click(await screen.findByRole('button', { name: 'Go to top' }))

      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3))
      await waitFor(() => expect(screen.getByText('Oldest row.')).toBeInTheDocument())
      expect(viewport.scrollTop).toBe(0)
      expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining([
        expect.stringContaining('before=middle-cursor'),
        expect.stringContaining('before=oldest-cursor'),
      ]))
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('reaches the maximum bottom in Full Log', async () => {
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => {})
    getAllLogsMock.mockReturnValue([
      makeLog('first', '[SYS] First', 'DRAFT'),
      makeLog('last', '[SYS] Last', 'CODING'),
    ])
    renderWithTooltipProvider(<FullLogView />)

    const viewport = screen.getByTestId('log-viewport')
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 100 })
    viewport.scrollTop = 400
    fireEvent.scroll(viewport)
    scrollTo.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Back to bottom' }))

    expect(screen.queryByRole('button', { name: 'Back to bottom' })).not.toBeInTheDocument()
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' })
    scrollTo.mockRestore()
  })

  it('shows pending feedback while exporting complete history for Copy all', async () => {
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
          content: 'Visible newest row.',
          entryId: 'visible-newest',
          timestamp: '2026-03-13T10:00:03.000Z',
        }],
        olderCursor: 'older-cursor',
        hasOlder: true,
      })
    })

    try {
      renderWithTooltipProvider(<FullLogView ticket={makeTicket()} />)
      expect(await screen.findByText('Visible newest row.')).toBeInTheDocument()
      const copyButton = screen.getByRole('button', { name: 'Copy all logs' })

      fireEvent.click(copyButton)
      expect(copyButton).toBeDisabled()
      expect(copyButton.querySelector('.animate-spin')).toBeInTheDocument()
      fireEvent.pointerMove(copyButton)
      expect((await screen.findAllByText('Preparing complete log history…')).length).toBeGreaterThan(0)

      resolveExport(new Response('[complete history]', { status: 200 }))
      await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith('[complete history]'))
      await waitFor(() => expect(copyButton).not.toBeDisabled())
      expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes('/logs/export?'))).toHaveLength(1)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('renders the header with "Full Log" title', () => {
    getAllLogsMock.mockReturnValue([])
    renderWithTooltipProvider(<FullLogView />)
    expect(screen.getByText('Full Log')).toBeTruthy()
  })

  it('renders phase delimiters when status changes between entries', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('1', '[SYS] Scanning files', 'SCANNING_RELEVANT_FILES'),
      makeLog('2', '[SYS] Starting council', 'COUNCIL_DELIBERATING'),
      makeLog('3', '[MODEL] Draft output', 'COUNCIL_DELIBERATING'),
    ])
    renderWithTooltipProvider(<FullLogView />)

    expect(screen.getByText('Scanning Relevant Files')).toBeTruthy()
    expect(screen.getByText('Council Drafting Questions')).toBeTruthy()
  })

  it('renders a second delimiter when the same status reappears after another', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('1', '[SYS] First coding run', 'CODING'),
      makeLog('2', '[ERROR] Blocked', 'BLOCKED_ERROR'),
      makeLog('3', '[SYS] Retry coding', 'CODING'),
    ])
    renderWithTooltipProvider(<FullLogView />)

    const codingDelimiters = screen.getAllByText(/Implementing/)
    expect(codingDelimiters).toHaveLength(2)
  })

  it('renders completed beads and the active bead as separate sections in coding runs', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('b1-start', '[SYS] Executing bead bead-1: First bead', 'CODING'),
      makeLog('b1-output', '[MODEL] bead 1 output', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
      }),
      makeLog('b2-start', '[SYS] Executing bead bead-2: Second bead', 'CODING'),
      makeLog('b2-output', '[MODEL] bead 2 output', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
      }),
      makeLog('b3-start', '[SYS] Executing bead bead-3: Third bead', 'CODING'),
      makeLog('b3-output', '[MODEL] bead 3 output', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
      }),
      makeLog('b4-start', '[SYS] Executing bead bead-4: Fourth bead', 'CODING'),
      makeLog('b4-output', '[MODEL] bead 4 output', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
      }),
    ])

    renderWithTooltipProvider(
      <FullLogView
        ticket={makeTicket({
          currentBead: 3,
          totalBeads: 4,
          runtime: {
            currentBead: 3,
            totalBeads: 4,
            activeBeadId: 'bead-3',
            beads: [
              { id: 'bead-1', title: 'First bead', status: 'done', iteration: 1 },
              { id: 'bead-2', title: 'Second bead', status: 'done', iteration: 1 },
              { id: 'bead-3', title: 'Third bead', status: 'in_progress', iteration: 1 },
              { id: 'bead-4', title: 'Fourth bead', status: 'pending', iteration: 0 },
            ],
          },
        })}
      />,
    )

    expect(screen.getByText('Implementing')).toBeTruthy()
    expect(screen.getByText('Bead 1/4')).toBeTruthy()
    expect(screen.getByText('Bead 2/4')).toBeTruthy()
    expect(screen.getByText('Bead 3/4')).toBeTruthy()
    expect(screen.queryByText('Bead 4/4')).toBeNull()
  })

  it('uses the base implementing label in Full Log for coding runs', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('1', '[SYS] Plain coding entry', 'CODING'),
    ])

    renderWithTooltipProvider(
      <FullLogView
        ticket={makeTicket({
          currentBead: 3,
          totalBeads: 4,
          runtime: {
            currentBead: 3,
            totalBeads: 4,
            activeBeadId: 'bead-3',
          },
        })}
      />,
    )

    expect(screen.getByText('Implementing')).toBeTruthy()
    expect(screen.queryByText('Implementing (Bead 3/4)')).toBeNull()
  })

  it('renders all filter tabs', () => {
    getAllLogsMock.mockReturnValue([])
    renderWithTooltipProvider(<FullLogView />)

    for (const tab of ['ALL', 'SYS', 'AI', 'ERROR', 'DEBUG']) {
      expect(screen.getByRole('button', { name: tab })).toBeTruthy()
    }
  })

  it('loads normal lifecycle logs on open and detail channels only when their tabs are selected', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('sys-1', '[SYS] System event', 'CODING'),
      makeLog('ai-1', '[MODEL] First output', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
      }),
      makeLog('ai-2', '[MODEL] Second output', 'DRAFTING_PRD', {
        source: 'model:anthropic/claude-sonnet-4',
        audience: 'ai',
        kind: 'text',
        modelId: 'anthropic/claude-sonnet-4',
      }),
    ])
    renderWithTooltipProvider(<FullLogView />)

    expect(loadAllLogsMock).toHaveBeenCalledWith()
    expect(loadAllLogsMock).not.toHaveBeenCalledWith({ channel: 'debug' })
    expect(loadAllLogsMock).not.toHaveBeenCalledWith({ channel: 'ai' })

    fireEvent.click(screen.getByRole('button', { name: 'AI' }))

    expect(loadAllLogsMock).toHaveBeenLastCalledWith({ channel: 'ai' })
    expect(screen.getByText(/First output/i)).toBeTruthy()
    expect(screen.queryByText(/System event/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'DEBUG' }))

    expect(loadAllLogsMock).toHaveBeenCalledWith({ channel: 'all' })
  })

  it('filters logs when a tab is selected', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('1', '[SYS] System event', 'CODING', { source: 'system', audience: 'all', kind: 'milestone' }),
      makeLog('2', '[ERROR] Something failed', 'CODING', { source: 'error', audience: 'all', kind: 'error' }),
      makeLog('3', '[SYS] Another event', 'CODING', { source: 'system', audience: 'all', kind: 'milestone' }),
    ])
    renderWithTooltipProvider(<FullLogView />)

    fireEvent.click(screen.getByRole('button', { name: 'ERROR' }))
    expect(screen.getByText('1 entry')).toBeTruthy()
  })

  it('shows non-error command chatter in SYS in the full log view', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('probe', '[CMD] $ git rev-parse --abbrev-ref HEAD  →  master', 'DRAFT', {
        source: 'system',
      }),
      makeLog('worktree', '[CMD] $ git worktree add /tmp/wt LTL-5  →  Preparing worktree', 'DRAFT', {
        source: 'system',
      }),
      makeLog('sys', '[SYS] Start requested.', 'DRAFT'),
    ])

    renderWithTooltipProvider(<FullLogView />)

    expect(screen.queryByText(/rev-parse --abbrev-ref HEAD/i)).toBeNull()
    expect(screen.queryByText(/worktree add/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'SYS' }))

    expect(screen.getByText(/rev-parse --abbrev-ref HEAD/i)).toBeTruthy()
    expect(screen.getByText(/worktree add/i)).toBeTruthy()
    expect(screen.getByText(/Start requested/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Show commands' }))
    fireEvent.click(screen.getByRole('button', { name: 'CMD' }))

    expect(screen.getByText(/rev-parse --abbrev-ref HEAD/i)).toBeTruthy()
    expect(screen.getByText(/worktree add/i)).toBeTruthy()
  })

  it('shows real command failures in ALL and ERROR while keeping benign probe misses out of ERROR in the full log view', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('probe-error', '[CMD] $ git symbolic-ref --quiet --short refs/remotes/origin/HEAD  →  origin/HEAD not set', 'DRAFT', {
        source: 'system',
        kind: 'error',
      }),
      makeLog('real-cmd-error', '[CMD] $ git merge --no-edit LTL-5  →  error: merge conflict', 'DRAFT', {
        source: 'error',
        kind: 'error',
      }),
    ])

    renderWithTooltipProvider(<FullLogView />)

    expect(screen.getByText(/merge --no-edit/i)).toBeTruthy()
    expect(screen.queryByText(/origin\/HEAD not set/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'ERROR' }))

    expect(screen.queryByText(/origin\/HEAD not set/i)).toBeNull()
    expect(screen.getByText(/merge --no-edit/i)).toBeTruthy()
  })

  it('keeps staged diff probes out of ERROR even when older logs tagged them as errors', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('probe-error', '[CMD] $ git diff --cached --quiet  →  error: exit code 1', 'CODING', {
        source: 'system',
        kind: 'error',
      }),
      makeLog('real-cmd-error', '[CMD] $ git commit -m test  →  error: author identity unknown', 'CODING', {
        source: 'error',
        kind: 'error',
      }),
    ])

    renderWithTooltipProvider(<FullLogView />)

    expect(screen.getByText(/commit -m test/i)).toBeTruthy()
    expect(screen.queryByText(/diff --cached --quiet/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'ERROR' }))

    expect(screen.getByText(/commit -m test/i)).toBeTruthy()
    expect(screen.queryByText(/diff --cached --quiet/i)).toBeNull()
  })

  it('shows model tabs from the AI tab and filters by selected model', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('1', '[MODEL] First output', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
      }),
      makeLog('2', '[MODEL] Second output', 'DRAFTING_PRD', {
        source: 'model:anthropic/claude-sonnet-4',
        audience: 'ai',
        kind: 'text',
        modelId: 'anthropic/claude-sonnet-4',
      }),
    ])

    renderWithTooltipProvider(<FullLogView />)

    fireEvent.click(screen.getByRole('button', { name: 'Show models' }))
    fireEvent.click(screen.getByRole('button', { name: /gpt-5\.4/i }))

    expect(loadAllLogsMock).toHaveBeenLastCalledWith({ channel: 'ai' })
    expect(screen.getByText('1 entry')).toBeTruthy()
    expect(screen.getByText(/First output/)).toBeTruthy()
    expect(screen.queryByText(/Second output/)).toBeNull()
  })

  it('preserves bead section headers in AI view even when bead-start markers are filtered out', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('b1-start', '[SYS] Executing bead bead-1: First bead', 'CODING'),
      makeLog('b1-output', '[MODEL] bead 1 output', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
      }),
      makeLog('b2-start', '[SYS] Executing bead bead-2: Second bead', 'CODING'),
      makeLog('b2-output', '[MODEL] bead 2 output', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
      }),
    ])

    renderWithTooltipProvider(
      <FullLogView
        ticket={makeTicket({
          currentBead: 2,
          totalBeads: 2,
          runtime: {
            currentBead: 2,
            totalBeads: 2,
            activeBeadId: 'bead-2',
            beads: [
              { id: 'bead-1', title: 'First bead', status: 'done', iteration: 1 },
              { id: 'bead-2', title: 'Second bead', status: 'in_progress', iteration: 1 },
            ],
          },
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'AI > gpt-5.4' }))

    expect(screen.getByText('Bead 1/2')).toBeTruthy()
    expect(screen.getByText('Bead 2/2')).toBeTruthy()
    expect(screen.queryByText(/Executing bead bead-1/i)).toBeNull()
  })

  it('collapses single-model AI tabs into one combined AI model tab', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('1', '[MODEL] First output', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
      }),
    ])

    renderWithTooltipProvider(<FullLogView />)

    expect(screen.getByRole('button', { name: 'AI > gpt-5.4' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show models' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'AI' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'AI > gpt-5.4' }))
    expect(screen.getByText(/First output/)).toBeTruthy()
  })

  it('shows the correct total entry count', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('1', '[SYS] Event 1', 'CODING'),
      makeLog('2', '[SYS] Event 2', 'CODING'),
      makeLog('3', '[SYS] Event 3', 'DRAFTING_PRD'),
    ])
    renderWithTooltipProvider(<FullLogView />)

    expect(screen.getByText('3 entries')).toBeTruthy()
  })

  it('keeps coding preamble entries above the first bead section', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('pre', '[SYS] Preparing coding context', 'CODING'),
      makeLog('b1-start', '[SYS] Executing bead bead-1: First bead', 'CODING'),
      makeLog('b1-output', '[MODEL] bead 1 output', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
      }),
    ])

    renderWithTooltipProvider(
      <FullLogView
        ticket={makeTicket({
          currentBead: 1,
          totalBeads: 2,
          runtime: {
            currentBead: 1,
            totalBeads: 2,
            activeBeadId: 'bead-1',
            beads: [
              { id: 'bead-1', title: 'First bead', status: 'in_progress', iteration: 1 },
              { id: 'bead-2', title: 'Second bead', status: 'pending', iteration: 0 },
            ],
          },
        })}
      />,
    )

    const preambleNode = screen.getByText(/Preparing coding context/i)
    const beadLabelNode = screen.getByText('Bead 1/2')
    expect(Boolean(preambleNode.compareDocumentPosition(beadLabelNode) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  })

  it('keeps separate implementing sections across retry runs', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('b1-start', '[SYS] Executing bead bead-1: First bead', 'CODING'),
      makeLog('b1-output', '[MODEL] bead 1 output', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
      }),
      makeLog('blocked', '[ERROR] Bead failed', 'BLOCKED_ERROR', {
        source: 'error',
        kind: 'error',
      }),
      makeLog('b2-start', '[SYS] Executing bead bead-2: Second bead', 'CODING'),
      makeLog('b2-output', '[MODEL] bead 2 output', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
      }),
    ])

    renderWithTooltipProvider(
      <FullLogView
        ticket={makeTicket({
          status: 'CODING',
          currentBead: 2,
          totalBeads: 2,
          runtime: {
            currentBead: 2,
            totalBeads: 2,
            activeBeadId: 'bead-2',
            beads: [
              { id: 'bead-1', title: 'First bead', status: 'done', iteration: 1 },
              { id: 'bead-2', title: 'Second bead', status: 'in_progress', iteration: 1 },
            ],
          },
        })}
      />,
    )

    expect(screen.getAllByText('Implementing')).toHaveLength(2)
    expect(screen.getByText('Bead 1/2')).toBeTruthy()
    expect(screen.getByText('Bead 2/2')).toBeTruthy()
  })

  it('falls back to an unsplit coding section when no bead-start marker exists', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('plain-1', '[SYS] Running coding without bead marker', 'CODING'),
      makeLog('plain-2', '[MODEL] Plain coding output', 'CODING', {
        source: 'model:openai/gpt-5.4',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
      }),
    ])

    renderWithTooltipProvider(
      <FullLogView
        ticket={makeTicket({
          currentBead: 1,
          totalBeads: 2,
          runtime: {
            currentBead: 1,
            totalBeads: 2,
            activeBeadId: 'bead-1',
          },
        })}
      />,
    )

    expect(screen.getByText('Implementing')).toBeTruthy()
    expect(screen.getByText(/Running coding without bead marker/i)).toBeTruthy()
    expect(screen.queryByText(/^Bead \d+\/\d+$/i)).toBeNull()
  })

  it('renders log entries using LogEntryRow with sequential indices', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('a', '[SYS] First', 'SCANNING_RELEVANT_FILES'),
      makeLog('b', '[SYS] Second', 'COUNCIL_DELIBERATING'),
    ])
    renderWithTooltipProvider(<FullLogView />)

    // LogEntryRow renders index+1 padded to 3 chars
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('includes status name in copy text', async () => {
    getAllLogsMock.mockReturnValue([
      makeLog('1', '[SYS] Start', 'CODING', { timestamp: TEST.timestamp }),
    ])
    renderWithTooltipProvider(<FullLogView />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy all logs' }))
      await Promise.resolve()
    })
    expect(writeTextMock).toHaveBeenCalledTimes(1)
    const copiedText = writeTextMock.mock.calls[0]![0] as string
    expect(copiedText).toContain('[CODING]')
    expect(copiedText).toContain('[SYS] Start')
  })

  it('shows the current activity strip below the toolbar and above the full log body', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('prompt-1', '[PROMPT] openai/gpt-5-codex prompt #1\nImplement bead 2.', 'CODING', {
        source: 'model:openai/gpt-5-codex',
        audience: 'ai',
        kind: 'prompt',
        modelId: 'openai/gpt-5-codex',
        sessionId: 'ses_full_current',
        beadId: 'bead-2',
      }),
    ])

    renderWithTooltipProvider(<FullLogView ticket={makeTicket()} />)

    const strip = screen.getByRole('status', { name: 'Current activity' })
    const viewport = screen.getByTestId('log-viewport')

    expect(strip).toHaveTextContent(/Waiting for first model activity/i)
    expect(strip).toHaveTextContent(/session ses_full_current/i)
    expect(strip).toHaveTextContent(/bead bead-2/i)
    expect(Boolean(strip.compareDocumentPosition(viewport) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  })

  it('does not show stale near-timeout activity from older phases in the full log view', () => {
    getAllLogsMock.mockReturnValue([
      makeLog('prompt-old-prd', '[PROMPT] openai/gpt-5-codex prompt #1\nDraft the PRD.', 'DRAFTING_PRD', {
        source: 'model:openai/gpt-5-codex',
        audience: 'ai',
        kind: 'prompt',
        modelId: 'openai/gpt-5-codex',
        sessionId: 'ses_old_prd',
        timeoutMs: 100_000,
        deadlineAt: '2026-03-10T10:01:40.000Z',
        timeoutKind: 'ai_response',
      }),
    ])

    renderWithTooltipProvider(<FullLogView ticket={makeTicket({ status: 'CODING' })} />)

    expect(screen.queryByRole('status', { name: 'Current activity' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Approaching timeout/i)).not.toBeInTheDocument()
  })
})
