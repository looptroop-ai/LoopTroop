import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTicket, TEST, type RuntimeBeadInput } from '@/test/factories'
import type { LogContextValue, LogEntry } from '@/context/logUtils'
import type { Ticket } from '@/hooks/useTickets'
import { useLogs } from '@/context/useLogContext'

const mockUseTicketArtifacts = vi.fn()
const mockUseTicketPhaseAttempts = vi.fn()

vi.mock('@/hooks/useTickets', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTickets')>('@/hooks/useTickets')
  return {
    ...actual,
    useTicketAction: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

vi.mock('@/context/useLogContext', () => ({
  useLogs: vi.fn(),
}))

vi.mock('@/hooks/useTicketArtifacts', () => ({
  useTicketArtifacts: (...args: unknown[]) => mockUseTicketArtifacts(...args),
}))

vi.mock('@/hooks/useTicketPhaseAttempts', () => ({
  useTicketPhaseAttempts: (...args: unknown[]) => mockUseTicketPhaseAttempts(...args),
}))

vi.mock('../PhaseArtifactsPanel', () => ({
  PhaseArtifactsPanel: ({
    phase,
    artifactState,
  }: {
    phase: string
    artifactState?: { artifacts?: Array<{ content?: string | null }> }
  }) => (
    <div data-testid="phase-artifacts-panel">
      {phase}:{artifactState?.artifacts?.[0]?.content ?? 'live'}
    </div>
  ),
}))

vi.mock('../CollapsiblePhaseLogSection', () => ({
  CollapsiblePhaseLogSection: ({
    phase,
    phaseAttempt,
    logMode,
  }: {
    phase: string
    phaseAttempt?: number
    logMode?: string
  }) => <div data-testid="collapsible-log-section" data-log-mode={logMode ?? 'live'}>{phase}:{phaseAttempt ?? 'active'}</div>,
}))

vi.mock('../BeadDiffViewer', () => ({
  BeadDiffViewer: ({ beadId }: { beadId: string }) => <div data-testid="bead-diff-viewer">{beadId}</div>,
}))

vi.mock('../VerificationSummaryPanel', () => ({
  VerificationSummaryPanel: () => <div data-testid="verification-summary-panel" />,
}))

import { CodingView } from '../CodingView'

type CodingTestOverrides = Omit<Partial<Ticket>, 'runtime'> & {
  runtime?: Omit<Partial<Ticket['runtime']>, 'beads'> & { beads?: RuntimeBeadInput[] }
}

function renderCoding(overrides: CodingTestOverrides = {}) {
  const baseTicket = makeTicket({ status: 'CODING' })
  const ticket = makeTicket({
    ...baseTicket,
    ...overrides,
    runtime: {
      ...baseTicket.runtime,
      ...(overrides.runtime ?? {}),
    },
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <CodingView ticket={ticket} />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

function makeBeadExecutionArtifact(beadId: string, payload: Record<string, unknown>) {
  return {
    id: 10,
    ticketId: TEST.ticketId,
    phase: 'CODING',
    phaseAttempt: 1,
    artifactType: `bead_execution:${beadId}`,
    filePath: null,
    content: JSON.stringify(payload),
    createdAt: '2026-05-28T10:00:00.000Z',
    updatedAt: '2026-05-28T10:00:00.000Z',
  }
}

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify([]), { status: 200 }),
  )
  mockUseTicketArtifacts.mockReset()
  mockUseTicketArtifacts.mockReturnValue({ artifacts: [], isLoading: false })
  mockUseTicketPhaseAttempts.mockReset()
  mockUseTicketPhaseAttempts.mockReturnValue({ data: [] })
  vi.mocked(useLogs).mockReturnValue(null)
})

afterEach(() => {
  cleanup()
  fetchSpy.mockRestore()
})

describe('CodingView', () => {
  it('stops draining a bead log after a page is refused', async () => {
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/logs?') && url.includes('before=')) {
        return Promise.resolve(new Response('nope', { status: 500 }))
      }
      if (url.includes('/logs?')) {
        return Promise.resolve(new Response(JSON.stringify({
          entries: [],
          olderCursor: 'cursor-older',
          hasOlder: true,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
    })

    renderCoding({
      runtime: { beads: [{ id: 'bead-1', title: 'Logged bead', status: 'done', iteration: 1 }] },
    })
    fireEvent.click(screen.getByRole('button', { name: /Logged bead/ }))

    const olderRequests = () => fetchSpy.mock.calls.filter(([input]: unknown[]) => String(input).includes('before=')).length
    await waitFor(() => expect(olderRequests()).toBe(1))

    // The server refused, and `hasOlder` stays true after a refusal, so nothing but the
    // latch stops the walk restarting. This is a guard rather than a regression pin: the
    // unbounded loop needs the effect to re-run while a page is in flight, which React
    // Query's request dedupe hides here. The deterministic pin for that is the
    // `fetchAllOlder` identity test in `useTicketHistoricalLogs.test.tsx`.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(olderRequests()).toBe(1)
  })

  it('follows a streaming bead log whose row grows without the count changing', async () => {
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: scrollTo,
    })
    const frames: FrameRequestCallback[] = []
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const runFrames = () => {
      const pending = frames.splice(0, frames.length)
      for (const frame of pending) frame(0)
    }

    const makeContext = (line: string): LogContextValue => {
      const logs: LogEntry[] = [{
        id: 'stream-1',
        entryId: 'stream-1',
        line,
        source: 'model:openai/gpt-5.4',
        status: 'CODING',
        audience: 'ai',
        kind: 'text',
        beadId: 'bead-1',
        streaming: true,
        op: 'upsert',
        timestamp: '2026-05-28T10:00:00.000Z',
      }]
      return {
        logsByPhase: { CODING: logs },
        activePhase: 'CODING',
        isLoadingLogs: false,
        addLog: vi.fn(),
        addLogRecord: vi.fn(),
        getLogsForPhase: () => logs,
        getAllLogs: () => logs,
        setActivePhase: vi.fn(),
        clearLogs: vi.fn(),
      }
    }

    const baseTicket = makeTicket({ status: 'CODING' })
    const ticket = makeTicket({
      ...baseTicket,
      runtime: {
        ...baseTicket.runtime,
        beads: [{ id: 'bead-1', title: 'Streaming bead', status: 'in_progress', iteration: 1 }],
      },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // A fresh element each time: re-rendering the identical element object lets React
    // bail out of the subtree, which would make this pass without re-running anything.
    const tree = () => (
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <CodingView ticket={ticket} />
        </TooltipProvider>
      </QueryClientProvider>
    )

    vi.mocked(useLogs).mockReturnValue(makeContext('Thinking'))
    const { rerender } = render(tree())

    fireEvent.click(screen.getByRole('button', { name: /Streaming bead/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Log' }))
    runFrames()
    scrollTo.mockClear()

    // One row, still one row — only longer. Keying the scroll on the row count meant
    // the view sat still while the answer was still arriving.
    vi.mocked(useLogs).mockReturnValue(makeContext('Thinking about the failing test'))
    rerender(tree())
    runFrames()

    expect(screen.getByText(/Thinking about the failing test/)).toBeInTheDocument()
    expect(scrollTo).toHaveBeenCalled()
  })

  it('fetches full bead data even when runtime bead placeholders already exist', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify([
        {
          id: 'bead-1',
          title: 'First',
          status: 'done',
          iteration: 1,
          description: 'Full bead details',
          acceptanceCriteria: ['Keeps bead data current'],
          tests: ['renders fresh details'],
          testCommands: [],
          testCommandReason: 'No appropriate automated command exists for this documentation-only change.',
          contextGuidance: { patterns: ['refresh bead state'], anti_patterns: [] },
          failedIterationNotes: [{ timestamp: TEST.timestamp, iteration: 1, content: 'updated' }],
        },
      ]), { status: 200 }),
    )

    renderCoding({
      runtime: {
        baseBranch: 'main',
        currentBead: 1,
        completedBeads: 0,
        totalBeads: 1,
        percentComplete: 0,
        iterationCount: 0,
        maxIterations: null,
        artifactRoot: '/tmp/test',
        candidateCommitSha: null,
        preSquashHead: null,
        finalTestStatus: 'pending',
        beads: [
          { id: 'bead-1', title: 'First', status: 'pending', iteration: 0 },
        ],
      },
    })

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/tickets/1:TEST-1/beads')
    })

    fireEvent.click(screen.getByRole('button', { name: /First/ }))
    expect(await screen.findByText('No Planned Automated Command')).toBeInTheDocument()
    expect(screen.getByText('No appropriate automated command exists for this documentation-only change.')).toBeInTheDocument()
  })

  it('does not show or fetch bead controls outside the implementing phase', async () => {
    renderCoding({
      status: 'PRE_FLIGHT_CHECK',
      runtime: {
        baseBranch: 'main',
        currentBead: 0,
        completedBeads: 0,
        totalBeads: 2,
        percentComplete: 0,
        iterationCount: 0,
        maxIterations: null,
        artifactRoot: '/tmp/test',
        candidateCommitSha: null,
        preSquashHead: null,
        finalTestStatus: 'pending',
        beads: [
          { id: 'bead-1', title: 'First setup-hidden bead', status: 'pending', iteration: 0 },
          { id: 'bead-2', title: 'Second setup-hidden bead', status: 'pending', iteration: 0 },
        ],
      },
    })

    expect(screen.getByText('Checking Readiness')).toBeTruthy()
    expect(screen.queryByText('First setup-hidden bead')).toBeNull()
    expect(screen.queryByText('Second setup-hidden bead')).toBeNull()
    expect(screen.queryByText('0/2')).toBeNull()

    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(([url]: [string, ...unknown[]]) => url === '/api/files/1:TEST-1/prd')).toBe(true)
    })
    expect(
      fetchSpy.mock.calls.some(([url]: [string, ...unknown[]]) => url === '/api/tickets/1:TEST-1/beads'),
    ).toBe(false)
  })

  it('shows archived versions for non-coding runtime phases and scopes artifacts and logs', () => {
    mockUseTicketPhaseAttempts.mockReturnValue({
      data: [
        {
          ticketId: TEST.ticketId,
          phase: 'PREPARING_EXECUTION_ENV',
          attemptNumber: 2,
          state: 'active',
          archivedReason: null,
          createdAt: '2026-04-29T12:00:00.000Z',
          archivedAt: null,
        },
        {
          ticketId: TEST.ticketId,
          phase: 'PREPARING_EXECUTION_ENV',
          attemptNumber: 1,
          state: 'archived',
          archivedReason: 'manual_retry_after_blocked_error',
          createdAt: '2026-04-29T11:00:00.000Z',
          archivedAt: '2026-04-29T12:00:00.000Z',
        },
      ],
    })
    mockUseTicketArtifacts.mockImplementation((_ticketId?: string, options?: { phaseAttempt?: number }) => ({
      artifacts: options?.phaseAttempt === 1
        ? [{ content: 'archived runtime report' }]
        : [{ content: 'current runtime report' }],
      isLoading: false,
    }))

    renderCoding({ status: 'PREPARING_EXECUTION_ENV' })

    const selector = screen.getByRole('combobox', { name: /version/i })
    expect(selector).toHaveValue('2')
    expect(screen.getByText('Current version (2)')).toBeInTheDocument()
    expect(screen.getByText('Archived version 1')).toBeInTheDocument()
    expect(screen.getByTestId('phase-artifacts-panel')).toHaveTextContent('PREPARING_EXECUTION_ENV:live')
    expect(screen.getByTestId('collapsible-log-section')).toHaveTextContent('PREPARING_EXECUTION_ENV:2')
    expect(screen.getByTestId('collapsible-log-section')).toHaveAttribute('data-log-mode', 'live')

    fireEvent.change(selector, { target: { value: '1' } })

    expect(mockUseTicketArtifacts).toHaveBeenCalledWith(TEST.ticketId, {
      phase: 'PREPARING_EXECUTION_ENV',
      phaseAttempt: 1,
    })
    expect(screen.getByTestId('phase-artifacts-panel')).toHaveTextContent('PREPARING_EXECUTION_ENV:archived runtime report')
    expect(screen.getByTestId('collapsible-log-section')).toHaveTextContent('PREPARING_EXECUTION_ENV:1')
    expect(screen.getByTestId('collapsible-log-section')).toHaveAttribute('data-log-mode', 'snapshot')

    fireEvent.change(selector, { target: { value: '2' } })

    expect(screen.getByTestId('phase-artifacts-panel')).toHaveTextContent('PREPARING_EXECUTION_ENV:live')
    expect(screen.getByTestId('collapsible-log-section')).toHaveTextContent('PREPARING_EXECUTION_ENV:2')
    expect(screen.getByTestId('collapsible-log-section')).toHaveAttribute('data-log-mode', 'live')
  })

  it('hides the phase version selector for CODING because bead retry has separate recovery', () => {
    mockUseTicketPhaseAttempts.mockReturnValue({
      data: [
        {
          ticketId: TEST.ticketId,
          phase: 'CODING',
          attemptNumber: 2,
          state: 'active',
          archivedReason: null,
          createdAt: '2026-04-29T12:00:00.000Z',
          archivedAt: null,
        },
        {
          ticketId: TEST.ticketId,
          phase: 'CODING',
          attemptNumber: 1,
          state: 'archived',
          archivedReason: 'manual_retry_after_blocked_error',
          createdAt: '2026-04-29T11:00:00.000Z',
          archivedAt: '2026-04-29T12:00:00.000Z',
        },
      ],
    })

    renderCoding({ status: 'CODING' })

    expect(screen.queryByRole('combobox', { name: /version/i })).toBeNull()
  })

  it('omits the empty artifact strip during live coding', () => {
    renderCoding({ status: 'CODING' })

    expect(screen.queryByTestId('phase-artifacts-panel')).toBeNull()
    expect(screen.getByTestId('collapsible-log-section')).toHaveTextContent('CODING:active')
  })

  describe('status normalization', () => {
    it('maps server "done" status to completed (green icon)', () => {
      renderCoding({
        runtime: {
          baseBranch: 'main',
          currentBead: 1,
          completedBeads: 1,
          totalBeads: 2,
          percentComplete: 50,
          iterationCount: 0,
          maxIterations: null,
          artifactRoot: '/tmp/test',
          candidateCommitSha: null,
          preSquashHead: null,
          finalTestStatus: 'pending',
          beads: [
            { id: 'bead-1', title: 'First', status: 'done', iteration: 1 },
            { id: 'bead-2', title: 'Second', status: 'pending', iteration: 0 },
          ],
        },
      })

      const buttons = screen.getAllByRole('button')
      const beadBtn = buttons.find((b) => b.textContent?.includes('First'))
      expect(beadBtn).toBeDefined()
      // A "done" bead should render with green (completed) styling, not pending opacity
      expect(beadBtn!.className).toContain('green')
      expect(beadBtn!.className).not.toContain('opacity-70')
    })

    it('maps server "error" status to failed (red icon)', () => {
      renderCoding({
        runtime: {
          baseBranch: 'main',
          currentBead: 0,
          completedBeads: 0,
          totalBeads: 1,
          percentComplete: 0,
          iterationCount: 0,
          maxIterations: null,
          artifactRoot: '/tmp/test',
          candidateCommitSha: null,
          preSquashHead: null,
          finalTestStatus: 'pending',
          beads: [
            { id: 'bead-1', title: 'Broken', status: 'error', iteration: 2 },
          ],
        },
      })

      const buttons = screen.getAllByRole('button')
      const beadBtn = buttons.find((b) => b.textContent?.includes('Broken'))
      expect(beadBtn).toBeDefined()
      expect(beadBtn!.className).toContain('red')
    })
  })

  describe('adaptive grid layout', () => {
    it('renders chips with titles for small bead count (≤15)', () => {
      renderCoding({
        runtime: {
          baseBranch: 'main',
          currentBead: 1,
          completedBeads: 0,
          totalBeads: 3,
          percentComplete: 0,
          iterationCount: 0,
          maxIterations: null,
          artifactRoot: '/tmp/test',
          candidateCommitSha: null,
          preSquashHead: null,
          finalTestStatus: 'pending',
          beads: [
            { id: 'b-1', title: 'Alpha', status: 'done', iteration: 0 },
            { id: 'b-2', title: 'Beta', status: 'in_progress', iteration: 0 },
            { id: 'b-3', title: 'Gamma', status: 'pending', iteration: 0 },
          ],
        },
      })

      // Titles should be visible in chip mode
      expect(screen.getAllByText('Alpha').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('Beta').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('Gamma').length).toBeGreaterThanOrEqual(1)
    })

    it('renders compact numbered grid for large bead count (>15)', () => {
      const beads = Array.from({ length: 20 }, (_, i) => ({
        id: `bead-${i + 1}`,
        title: `Bead number ${i + 1}`,
        status: i < 5 ? 'done' : 'pending',
        iteration: 0,
      }))

      renderCoding({
        runtime: {
          baseBranch: 'main',
          currentBead: 5,
          completedBeads: 5,
          totalBeads: 20,
          percentComplete: 25,
          iterationCount: 0,
          maxIterations: null,
          artifactRoot: '/tmp/test',
          candidateCommitSha: null,
          preSquashHead: null,
          finalTestStatus: 'pending',
          beads,
        },
      })

      // In compact mode, numbered squares are shown instead of titles
      expect(screen.getByText('1')).toBeTruthy()
      expect(screen.getByText('20')).toBeTruthy()
      // Full titles should NOT be directly visible as text content (only as tooltip)
      expect(screen.queryByText('Bead number 1')).toBeNull()
    })

    it('omits redundant bead progress summary', () => {
      renderCoding({
        runtime: {
          baseBranch: 'main',
          currentBead: 2,
          completedBeads: 2,
          totalBeads: 5,
          percentComplete: 40,
          iterationCount: 0,
          maxIterations: null,
          artifactRoot: '/tmp/test',
          candidateCommitSha: null,
          preSquashHead: null,
          finalTestStatus: 'pending',
          beads: [
            { id: 'b-1', title: 'A', status: 'done', iteration: 0 },
            { id: 'b-2', title: 'B', status: 'done', iteration: 0 },
            { id: 'b-3', title: 'C', status: 'in_progress', iteration: 0 },
            { id: 'b-4', title: 'D', status: 'pending', iteration: 0 },
            { id: 'b-5', title: 'E', status: 'pending', iteration: 0 },
          ],
        },
      })

      expect(screen.getByText('Implementing (Bead 2/5)')).toBeTruthy()
      expect(screen.getByText('2/5')).toBeTruthy()
      expect(screen.queryByText('done')).toBeNull()
    })
  })

  it('renders separate structured bead note histories and strips ANSI from machine notes', () => {
    renderCoding({
      runtime: {
        activeBeadId: 'bead-1',
        activeBeadIteration: 2,
        maxIterationsPerBead: 5,
        beads: [
          {
            id: 'bead-1',
            title: 'Retry bead',
            status: 'error',
            iteration: 2,
            failedIterationNotes: [{ timestamp: TEST.timestamp, iteration: 1, content: '\u001b[31mfirst note\u001b[0m' }],
            userRetryNotes: [{ timestamp: TEST.timestamp, iteration: 2, content: 'user note' }],
            finalizationFailureNotes: [{ timestamp: TEST.timestamp, iteration: 2, content: 'finalization note', errorCode: 'COMMIT_FAILED' }],
          },
        ],
      },
    })

    expect(screen.getByText(/Retry bead · Iteration 2\/5/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Retry bead/ }))

    expect(screen.getByText(/first note/)).toBeTruthy()
    expect(screen.getByText('User Retry Notes')).toBeTruthy()
    expect(screen.getByText(/user note/)).toBeTruthy()
    expect(screen.getByText('Finalization Failure Notes')).toBeTruthy()
    expect(screen.getByText(/finalization note/)).toBeTruthy()
    expect(screen.getByText('first note').textContent).toBe('first note')
  })

  it('overlays live runtime retry metadata onto stale fetched bead details', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify([
        {
          id: 'bead-1',
          title: 'Retry bead',
          status: 'in_progress',
          iteration: 1,
          description: 'Full bead details',
        },
      ]), { status: 200 }),
    )

    const baseTicket = makeTicket({
      status: 'CODING',
      runtime: {
        ...makeTicket().runtime,
        totalBeads: 1,
        currentBead: 1,
        activeBeadId: 'bead-1',
        activeBeadIteration: 1,
        beads: [
          { id: 'bead-1', title: 'Retry bead', status: 'in_progress', iteration: 1 },
        ],
      },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <CodingView ticket={baseTicket} />
        </TooltipProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/tickets/1:TEST-1/beads')
    })

    fireEvent.click(screen.getByRole('button', { name: /Retry bead/ }))

    const updatedTicket = makeTicket({
      ...baseTicket,
      runtime: {
        ...baseTicket.runtime,
        activeBeadIteration: 2,
        beads: [
          {
            id: 'bead-1',
            title: 'Retry bead',
            status: 'error',
            iteration: 2,
            failedIterationNotes: [{ timestamp: TEST.timestamp, iteration: 2, content: 'retry note after timeout' }],
          },
        ],
      },
    })

    rerender(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <CodingView ticket={updatedTicket} />
        </TooltipProvider>
      </QueryClientProvider>,
    )

    expect(screen.getByText(/Retry bead · Iteration 2/)).toBeTruthy()
    expect(screen.getAllByText('2x').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/iteration 2/i).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/retry note after timeout/i)).toBeTruthy()
    expect(
      fetchSpy.mock.calls.filter(([url]: [string, ...unknown[]]) => url === '/api/tickets/1:TEST-1/beads'),
    ).toHaveLength(1)
  })

  it('shows the full non-debug bead transcript in the Log tab', () => {
    const beadLogs: LogEntry[] = [
      {
        id: '1',
        entryId: 'cmd-1',
        line: '[CMD] $ git status  →  ok',
        source: 'system',
        status: 'CODING',
        audience: 'all',
        kind: 'milestone',
        beadId: 'bead-1',
        streaming: false,
        op: 'append',
      },
      {
        id: '2',
        entryId: 'prompt-1',
        line: '[PROMPT] openai/gpt-5.4 prompt #1',
        source: 'model:openai/gpt-5.4',
        status: 'CODING',
        audience: 'ai',
        kind: 'prompt',
        modelId: 'openai/gpt-5.4',
        sessionId: 'session-1',
        beadId: 'bead-1',
        streaming: false,
        op: 'append',
      },
      {
        id: '3',
        entryId: 'think-1',
        line: 'Checking the failing test output.',
        source: 'model:openai/gpt-5.4',
        status: 'CODING',
        audience: 'ai',
        kind: 'reasoning',
        modelId: 'openai/gpt-5.4',
        sessionId: 'session-1',
        beadId: 'bead-1',
        streaming: false,
        op: 'finalize',
      },
      {
        id: '4',
        entryId: 'debug-1',
        line: '[DEBUG] hidden debug row',
        source: 'debug',
        status: 'CODING',
        audience: 'debug',
        kind: 'milestone',
        beadId: 'bead-1',
        streaming: false,
        op: 'append',
      },
    ]

    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    })

    const logContext: LogContextValue = {
      logsByPhase: { CODING: beadLogs },
      activePhase: 'CODING',
      isLoadingLogs: false,
      addLog: vi.fn(),
      addLogRecord: vi.fn(),
      getLogsForPhase: vi.fn(() => beadLogs),
      getAllLogs: vi.fn(() => beadLogs),
      setActivePhase: vi.fn(),
      clearLogs: vi.fn(),
    }
    vi.mocked(useLogs).mockReturnValue(logContext)

    renderCoding({
      runtime: {
        beads: [
          { id: 'bead-1', title: 'Logged bead', status: 'done', iteration: 1 },
        ],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /Logged bead/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Log' }))

    // Should show line count and copy button
    expect(screen.getByText('3 entries')).toBeTruthy()
    const copyBtn = screen.getByRole('button', { name: 'Copy bead logs' })
    expect(copyBtn).toBeInTheDocument()

    // Test copy function
    fireEvent.click(copyBtn)
    expect(writeTextMock).toHaveBeenCalled()
    const copiedText = writeTextMock.mock.calls[0]?.[0]
    expect(copiedText).toContain('[CMD] $ git status')
    expect(copiedText).toContain('[PROMPT-openai/gpt-5.4] Prompt #1')

    expect(screen.getByText((content) => content.includes('git status'))).toBeTruthy()
    expect(screen.getByText((content) => content.includes('ok'))).toBeTruthy()
    expect(screen.getByText((content) => content.includes('Prompt #1'))).toBeTruthy()
    expect(screen.getByText(/Checking the failing test output/)).toBeTruthy()
    expect(screen.queryByText(/hidden debug row/)).toBeNull()
  })

  it('loads a completed bead transcript from durable history after it leaves the newest phase page', async () => {
    const historicalEntry = {
      phase: 'CODING',
      status: 'CODING',
      entryId: 'historical-bead-output',
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'model_output',
      content: '[MODEL] historical older output',
      source: 'opencode',
      audience: 'ai',
      kind: 'text',
      beadId: 'bead-1',
      beadIteration: 1,
      streaming: false,
      op: 'finalize',
    }
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/logs?')) {
        return Promise.resolve(new Response(JSON.stringify({
          entries: [historicalEntry],
          olderCursor: null,
          hasOlder: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
    })

    renderCoding({
      runtime: {
        beads: [
          { id: 'bead-1', title: 'Historical bead', status: 'done', iteration: 1 },
        ],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /Historical bead/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Log' }))

    expect(await screen.findByText(/historical older output/)).toBeInTheDocument()
    expect(fetchSpy.mock.calls.some(([url]: [string, ...unknown[]]) =>
      url.includes('/logs?scope=phase&view=ai&limit=20&phase=CODING&beadId=bead-1'),
    )).toBe(true)
  })

  it('shows bead raw tabs in order with tooltips', () => {
    renderCoding({
      runtime: {
        beads: [
          { id: 'bead-1', title: 'Raw tabs bead', status: 'pending', iteration: 0 },
        ],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /Raw tabs bead/ }))

    const detailsTab = screen.getByRole('button', { name: 'Details' })
    const changesTab = screen.getByRole('button', { name: 'Changes' })
    const logTab = screen.getByRole('button', { name: 'Log' })
    const inputTab = screen.getByRole('button', { name: 'Input' })
    const outputTab = screen.getByRole('button', { name: 'Output' })

    expect(detailsTab.compareDocumentPosition(changesTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(changesTab.compareDocumentPosition(logTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(logTab.compareDocumentPosition(inputTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(inputTab.compareDocumentPosition(outputTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(detailsTab.parentElement).toHaveAttribute('title', 'Bead metadata, requirements, dependencies, and notes.')
    expect(changesTab.parentElement).toHaveAttribute('title', 'Captured code diff for this bead. Available after the bead is done or skipped.')
    expect(logTab.parentElement).toHaveAttribute('title', 'Bead-scoped execution transcript.')
    expect(inputTab.parentElement).toHaveAttribute('title', 'Raw initial prompt sent for the selected bead iteration.')
    expect(outputTab.parentElement).toHaveAttribute('title', 'Final model response or diagnostic for the selected bead iteration.')
  })

  it('renders bead raw Input with copy and raw stats from execution attempts', () => {
    const prompt = 'Accepted prompt line 1\nAccepted prompt line 2'
    const response = 'Accepted final output'
    mockUseTicketArtifacts.mockImplementation((_ticketId?: string, options?: { phase?: string }) => ({
      artifacts: options?.phase === 'CODING'
        ? [
            makeBeadExecutionArtifact('bead-1', {
              beadId: 'bead-1',
              success: true,
              iteration: 1,
              output: response,
              errors: [],
              rawAttempts: [
                {
                  attempt: 1,
                  iteration: 1,
                  status: 'accepted',
                  outcome: 'accepted',
                  initialInput: prompt,
                  rawResponse: response,
                  modelOutput: response,
                  modelId: 'openai/gpt-5.4',
                  sessionId: 'session-raw-1',
                },
              ],
            }),
          ]
        : [],
      isLoading: false,
    }))
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    })

    renderCoding({
      runtime: {
        beads: [
          { id: 'bead-1', title: 'Raw input bead', status: 'done', iteration: 1 },
        ],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /Raw input bead/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Input' }))

    expect(screen.getByText((content) => content.includes('Accepted prompt line 1'))).toBeTruthy()
    expect(screen.getByText('2 Lines')).toBeTruthy()
    expect(screen.getByText(`${prompt.length.toLocaleString()} Characters`)).toBeTruthy()
    expect(screen.getByText(/Tokens \(GPT-5 tokenizer\)/)).toBeTruthy()
    expect(screen.getByText('Iteration 1')).toBeTruthy()
    expect(screen.getByText('Model openai/gpt-5.4')).toBeTruthy()
    expect(screen.getByText('Session session-raw-1')).toBeTruthy()

    const copyBtn = screen.getByRole('button', { name: 'Copy bead input' })
    fireEvent.click(copyBtn)
    expect(writeTextMock).toHaveBeenCalledWith(prompt)
  })

  it('keeps Output disabled before raw output or diagnostics exist', () => {
    renderCoding({
      runtime: {
        beads: [
          { id: 'bead-1', title: 'Pending raw bead', status: 'pending', iteration: 0 },
        ],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /Pending raw bead/ }))

    expect(screen.getByRole('button', { name: 'Output' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Input' }))
    expect(screen.getByText('No raw input for this bead yet.')).toBeTruthy()
  })

  it('defaults to the latest meaningful raw output and keeps failed previous versions clickable', () => {
    mockUseTicketArtifacts.mockImplementation((_ticketId?: string, options?: { phase?: string }) => ({
      artifacts: options?.phase === 'CODING'
        ? [
            makeBeadExecutionArtifact('bead-1', {
              beadId: 'bead-1',
              success: true,
              iteration: 2,
              output: 'accepted output',
              errors: [],
              rawAttempts: [
                {
                  attempt: 1,
                  iteration: 1,
                  status: 'failed',
                  outcome: 'failed',
                  initialInput: 'failed input',
                  rawResponse: 'failed output',
                },
                {
                  attempt: 2,
                  iteration: 2,
                  status: 'accepted',
                  outcome: 'accepted',
                  initialInput: 'accepted input',
                  rawResponse: 'accepted output',
                },
              ],
            }),
          ]
        : [],
      isLoading: false,
    }))

    renderCoding({
      runtime: {
        beads: [
          { id: 'bead-1', title: 'Retried raw bead', status: 'done', iteration: 2 },
        ],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /Retried raw bead/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Output' }))

    expect(screen.getByText((content) => content.includes('accepted output'))).toBeTruthy()
    expect(screen.getByRole('button', { name: /Iteration 2/ })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: /Iteration 1/ }))

    expect(screen.getByText((content) => content.includes('failed output'))).toBeTruthy()
    expect(screen.getByRole('button', { name: /Iteration 1/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Output' })).toBeEnabled()
  })

  it('falls back to the current live input while a retry is running and keeps prior log output clickable', () => {
    const beadLogs: LogEntry[] = [
      {
        id: 'session-1-created',
        entryId: 'bead-1:1:created',
        line: '[SYS] Coding session created for bead bead-1 attempt 1 (session=session-1).',
        source: 'system',
        status: 'CODING',
        audience: 'all',
        kind: 'milestone',
        sessionId: 'session-1',
        beadId: 'bead-1',
        beadIteration: 1,
        streaming: false,
        op: 'append',
      },
      {
        id: 'prompt-1',
        entryId: 'session-1:prompt:1',
        line: '[PROMPT] openai/gpt-5.4 prompt #1\nprevious failed input',
        source: 'model:openai/gpt-5.4',
        status: 'CODING',
        audience: 'ai',
        kind: 'prompt',
        modelId: 'openai/gpt-5.4',
        sessionId: 'session-1',
        beadId: 'bead-1',
        beadIteration: 1,
        streaming: false,
        op: 'append',
      },
      {
        id: 'text-1',
        entryId: 'session-1:msg:text',
        line: '[MODEL] previous failed output',
        source: 'model:openai/gpt-5.4',
        status: 'CODING',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
        sessionId: 'session-1',
        beadId: 'bead-1',
        beadIteration: 1,
        streaming: false,
        op: 'finalize',
      },
      {
        id: 'session-2-created',
        entryId: 'bead-1:2:created',
        line: '[SYS] Coding session created for bead bead-1 attempt 2 (session=session-2).',
        source: 'system',
        status: 'CODING',
        audience: 'all',
        kind: 'milestone',
        sessionId: 'session-2',
        beadId: 'bead-1',
        beadIteration: 2,
        streaming: false,
        op: 'append',
      },
      {
        id: 'prompt-2',
        entryId: 'session-2:prompt:1',
        line: '[PROMPT] openai/gpt-5.4 prompt #1\ncurrent retry input',
        source: 'model:openai/gpt-5.4',
        status: 'CODING',
        audience: 'ai',
        kind: 'prompt',
        modelId: 'openai/gpt-5.4',
        sessionId: 'session-2',
        beadId: 'bead-1',
        beadIteration: 2,
        streaming: false,
        op: 'append',
      },
      {
        id: 'late-old-event',
        entryId: 'session-1:late-event',
        line: '[SYS] delayed old event',
        source: 'system',
        status: 'CODING',
        audience: 'all',
        kind: 'milestone',
        sessionId: 'session-1',
        beadId: 'bead-1',
        beadIteration: 1,
        streaming: false,
        op: 'finalize',
      },
    ]
    vi.mocked(useLogs).mockReturnValue({
      logsByPhase: { CODING: beadLogs },
      activePhase: 'CODING',
      isLoadingLogs: false,
      addLog: vi.fn(),
      addLogRecord: vi.fn(),
      getLogsForPhase: vi.fn(() => beadLogs),
      getAllLogs: vi.fn(() => beadLogs),
      setActivePhase: vi.fn(),
      loadLogsForPhase: vi.fn(),
      clearLogs: vi.fn(),
    })

    renderCoding({
      runtime: {
        activeBeadId: 'bead-1',
        activeBeadIteration: 2,
        beads: [
          { id: 'bead-1', title: 'Live retry bead', status: 'in_progress', iteration: 2 },
        ],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /Live retry bead/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Input' }))

    expect(screen.getByText((content) => content.includes('current retry input'))).toBeTruthy()
    expect(screen.getByRole('button', { name: /Iteration 2/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Output' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /Iteration 1/ }))

    expect(screen.getByRole('button', { name: 'Output' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Output' }))
    expect(screen.getByText((content) => content.includes('previous failed output'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Iteration 2/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Log' }))
    expect(screen.getByText((content) => content.includes('current retry input'))).toBeTruthy()
    expect(screen.queryByText((content) => content.includes('previous failed input'))).toBeNull()

    const showAllLogsButton = screen.getByRole('button', { name: 'Show all logs for bead' })
    fireEvent.click(showAllLogsButton)

    expect(showAllLogsButton).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Iteration 1/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /Iteration 2/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText((content) => content.includes('previous failed input'))).toBeTruthy()
    expect(screen.getByText((content) => content.includes('current retry input'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Iteration 1/ }))
    expect(screen.queryByText((content) => content.includes('current retry input'))).toBeNull()
    expect(screen.getByText((content) => content.includes('previous failed input'))).toBeTruthy()
    expect(screen.queryByText((content) => content.includes('delayed old event'))).toBeNull()
  })

  it('uses log-derived output as a fallback when a persisted attempt only has input', () => {
    const beadLogs: LogEntry[] = [
      {
        id: 'text-1',
        entryId: 'session-1:msg:text',
        line: '[MODEL] fallback log output',
        source: 'model:openai/gpt-5.4',
        status: 'CODING',
        audience: 'ai',
        kind: 'text',
        modelId: 'openai/gpt-5.4',
        sessionId: 'session-1',
        beadId: 'bead-1',
        beadIteration: 1,
        streaming: false,
        op: 'finalize',
      },
    ]
    vi.mocked(useLogs).mockReturnValue({
      logsByPhase: { CODING: beadLogs },
      activePhase: 'CODING',
      isLoadingLogs: false,
      addLog: vi.fn(),
      addLogRecord: vi.fn(),
      getLogsForPhase: vi.fn(() => beadLogs),
      getAllLogs: vi.fn(() => beadLogs),
      setActivePhase: vi.fn(),
      loadLogsForPhase: vi.fn(),
      clearLogs: vi.fn(),
    })
    mockUseTicketArtifacts.mockImplementation((_ticketId?: string, options?: { phase?: string }) => ({
      artifacts: options?.phase === 'CODING'
        ? [
            makeBeadExecutionArtifact('bead-1', {
              beadId: 'bead-1',
              success: false,
              iteration: 1,
              output: '',
              errors: [],
              rawAttempts: [
                {
                  attempt: 1,
                  iteration: 1,
                  status: 'failed',
                  outcome: 'failed',
                  initialInput: 'persisted input only',
                },
              ],
            }),
          ]
        : [],
      isLoading: false,
    }))

    renderCoding({
      runtime: {
        beads: [
          { id: 'bead-1', title: 'Fallback raw bead', status: 'error', iteration: 1 },
        ],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /Fallback raw bead/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Output' }))

    expect(screen.getByText((content) => content.includes('fallback log output'))).toBeTruthy()
  })

  it('keeps blocked coding reviews on the interrupted bead progress instead of forcing completion', () => {
    const blockedTicket = makeTicket({
      status: 'BLOCKED_ERROR',
      previousStatus: 'CODING',
      reviewCutoffStatus: 'CODING',
      errorMessage: 'Bead failed after max retries.',
      runtime: {
        ...makeTicket().runtime,
        currentBead: 2,
        totalBeads: 18,
        percentComplete: 11,
        activeBeadId: 'bead-2',
        activeBeadIteration: 5,
        maxIterationsPerBead: 5,
        beads: [
          {
            id: 'bead-2',
            title: 'Add show_matched_attributes to GET query struct',
            status: 'error',
            iteration: 5,
            failedIterationNotes: [{ timestamp: TEST.timestamp, iteration: 5, content: 'retry note' }],
          },
        ],
      },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <CodingView ticket={blockedTicket} readOnly />
        </TooltipProvider>
      </QueryClientProvider>,
    )

    expect(screen.queryByText('Completed Successfully')).toBeNull()
    expect(screen.getByText('Implementing (Bead 2/18)')).toBeTruthy()
    expect(screen.getByText('2/18')).toBeTruthy()
    expect(screen.queryByText('18/18')).toBeNull()
    expect(screen.getByText(/Add show_matched_attributes to GET query struct · Iteration 5\/5/)).toBeTruthy()
  })

  it('keeps completed coding reviews marked complete after coding already advanced past execution', () => {
    const completedCodingTicket = makeTicket({
      status: 'WAITING_PR_REVIEW',
      runtime: {
        ...makeTicket().runtime,
        currentBead: 3,
        totalBeads: 3,
        percentComplete: 100,
      },
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <CodingView ticket={completedCodingTicket} readOnly />
        </TooltipProvider>
      </QueryClientProvider>,
    )

    expect(screen.getByText('Completed Successfully')).toBeTruthy()
    expect(screen.getAllByText('3/3').length).toBeGreaterThanOrEqual(1)
  })

  describe('WAITING_PR_REVIEW', () => {
    it('renders VerificationSummaryPanel when status is WAITING_PR_REVIEW', () => {
      renderCoding({
        status: 'WAITING_PR_REVIEW',
        runtime: {
          baseBranch: 'main',
          currentBead: 3,
          completedBeads: 3,
          totalBeads: 3,
          percentComplete: 100,
          iterationCount: 0,
          maxIterations: null,
          artifactRoot: '/tmp/test',
          candidateCommitSha: 'abc123',
          preSquashHead: 'old789',
          finalTestStatus: 'passed',
          prNumber: 42,
          prUrl: 'https://github.com/test/repo/pull/42',
          prState: 'draft',
          prHeadSha: 'abc123',
          beads: [],
        },
      })

      expect(screen.getByTestId('verification-summary-panel')).toBeTruthy()
    })

    it('does not render VerificationSummaryPanel for CODING status', () => {
      renderCoding({
        status: 'CODING',
        runtime: {
          baseBranch: 'main',
          currentBead: 1,
          completedBeads: 0,
          totalBeads: 3,
          percentComplete: 0,
          iterationCount: 0,
          maxIterations: null,
          artifactRoot: '/tmp/test',
          candidateCommitSha: null,
          preSquashHead: null,
          finalTestStatus: 'pending',
          beads: [],
        },
      })

      expect(screen.queryByTestId('verification-summary-panel')).toBeNull()
    })

    it('does not render VerificationSummaryPanel in readOnly mode', () => {
      const baseTicket = makeTicket({
        status: 'WAITING_PR_REVIEW',
        runtime: {
          baseBranch: 'main',
          currentBead: 3,
          completedBeads: 3,
          totalBeads: 3,
          percentComplete: 100,
          iterationCount: 0,
          maxIterations: null,
          maxIterationsPerBead: null,
          activeBeadId: null,
          activeBeadIteration: null,
          lastFailedBeadId: null,
          artifactRoot: '/tmp/test',
          candidateCommitSha: 'abc123',
          preSquashHead: 'old789',
          finalTestStatus: 'passed',
          prNumber: 42,
          prUrl: 'https://github.com/test/repo/pull/42',
          prState: 'draft',
          prHeadSha: 'abc123',
          beads: [],
        },
      })
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      render(
        <QueryClientProvider client={qc}>
          <TooltipProvider>
            <CodingView ticket={baseTicket} readOnly />
          </TooltipProvider>
        </QueryClientProvider>,
      )

      expect(screen.queryByTestId('verification-summary-panel')).toBeNull()
    })
  })
})
