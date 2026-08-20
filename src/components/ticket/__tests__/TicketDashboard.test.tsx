import type { ReactNode, Ref } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '@/hooks/useTickets'
import { queryClient } from '@/lib/queryClient'
import { makeTicket } from '@/test/factories'
import { patchTicketStatusInCache } from '@/hooks/ticketStatusCache'
import { WORKSPACE_PHASE_NAVIGATE_EVENT } from '@/lib/workspaceNavigation'
import { INTERVIEW_BATCH_EVENT } from '@/lib/interviewBatchEvents'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createJsonResponse } from '@/test/renderHelpers'
import { useLogs } from '@/context/useLogContext'

const selectedTicketId = '1:T-42'
const dispatchMock = vi.fn()
const mockSSEState = vi.hoisted(() => ({
  connectionState: 'connected' as 'connecting' | 'connected' | 'reconnecting',
}))
const mockTicketQuery = vi.hoisted(() => ({
  override: null as null | {
    data: Ticket | undefined
    isError?: boolean
    error?: unknown
    refetch?: () => void
    isFetching?: boolean
  },
}))
const useRecoveryAutoReloadMock = vi.hoisted(() => vi.fn())
const saveUiStateMutate = vi.hoisted(() => vi.fn())
let latestSSEOptions: {
  ticketId: string | null
  onEvent?: (event: { type: string; data: Record<string, unknown> }) => void
} | null = null

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

vi.mock('@/context/useUI', () => ({
  useUI: () => ({
    state: { selectedTicketId },
    dispatch: dispatchMock,
  }),
}))

vi.mock('@/hooks/useSSE', () => ({
  useSSE: (options: { ticketId: string | null; onEvent?: (event: { type: string; data: Record<string, unknown> }) => void }) => {
    latestSSEOptions = options
    return { lastEventIdRef: { current: '0' }, connectionState: mockSSEState.connectionState }
  },
}))

vi.mock('@/hooks/useTickets', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTickets')>('@/hooks/useTickets')
  return {
    ...actual,
    useTicket: (id: string | null) => {
      const result = actual.useTicket(id)
      return mockTicketQuery.override ?? result
    },
    useSaveTicketUIState: () => ({ mutate: saveUiStateMutate }),
  }
})

vi.mock('@/hooks/useRecoveryAutoReload', () => ({
  useRecoveryAutoReload: useRecoveryAutoReloadMock,
}))

vi.mock('../DashboardHeader', () => ({
  DashboardHeader: ({ ticket }: { ticket: Ticket }) => <div data-testid="dashboard-header">{ticket.status}</div>,
}))

vi.mock('../ResizeHandle', () => ({
  ResizeHandle: () => <div data-testid="resize-handle" />,
}))

vi.mock('../ActiveWorkspace', () => ({
  ActiveWorkspace: ({
    ticket,
    selectedPhase,
    selectedErrorOccurrenceId,
    fullLogOpen,
  }: {
    ticket: Ticket
    selectedPhase: string
    selectedErrorOccurrenceId?: string | null
    fullLogOpen?: boolean
  }) => {
    const logCtx = useLogs()
    const logs = logCtx?.getLogsForPhase(selectedPhase) ?? []

    return (
      <div data-testid="active-workspace">
        <div>{selectedPhase}</div>
        <div data-testid="workspace-full-log">{fullLogOpen ? 'open' : 'closed'}</div>
        <div data-testid="workspace-error-id">{selectedErrorOccurrenceId ?? ''}</div>
        <div data-testid="workspace-log-count">{logs.length}</div>
        {logs.map((entry) => (
          <div key={entry.entryId}>{entry.line}</div>
        ))}
        {selectedPhase === 'DRAFT' && ticket.status !== 'DRAFT' ? (
          <button type="button">Log — Backlog</button>
        ) : null}
      </div>
    )
  },
}))

vi.mock('../NavigatorPanel', () => ({
  NavigatorPanel: ({
    currentStatus,
    selectedPhase,
    selectedErrorOccurrenceId,
    fullLogOpen,
    onSelectPhase,
    onSelectErrorOccurrence,
    onOpenFullLog,
    contextPhase,
  }: {
    currentStatus: string
    selectedPhase: string
    selectedErrorOccurrenceId?: string | null
    fullLogOpen?: boolean
    onSelectPhase: (phase: string | null) => void
    onSelectErrorOccurrence: (occurrenceId: string | null) => void
    onOpenFullLog?: () => void
    contextPhase: string
  }) => (
    <div>
      <div data-testid="navigator-current">{currentStatus}</div>
      <div data-testid="navigator-selected">{selectedPhase}</div>
      <div data-testid="navigator-error">{selectedErrorOccurrenceId ?? ''}</div>
      <div data-testid="navigator-full-log">{fullLogOpen ? 'open' : 'closed'}</div>
      <div data-testid="navigator-context">{contextPhase}</div>
      <button onClick={() => onSelectPhase('DRAFT')}>Select backlog</button>
      <button onClick={() => onSelectPhase('DRAFTING_PRD')}>Select drafting</button>
      <button onClick={() => onSelectErrorOccurrence('error-1')}>Select error</button>
      <button onClick={onOpenFullLog}>Open full log</button>
      {(selectedPhase !== currentStatus || Boolean(selectedErrorOccurrenceId) || fullLogOpen) && (
        <button onClick={() => onSelectPhase(null)}>Back to live</button>
      )}
    </div>
  ),
}))

import { TicketDashboard } from '../TicketDashboard'

/** Simulate a realistic SSE state_change: patch the cache first (as useSSE does), then fire onEvent. */
function simulateSSE(from: string, to: string) {
  patchTicketStatusInCache(queryClient, selectedTicketId, to)
  latestSSEOptions?.onEvent?.({
    type: 'state_change',
    data: { ticketId: selectedTicketId, from, to },
  })
}

function renderDashboardElement() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TicketDashboard />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

function renderDashboard() {
  return render(renderDashboardElement())
}

beforeAll(() => {
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
  })

  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (handle: number) => window.clearTimeout(handle),
  })
})

beforeEach(() => {
  queryClient.clear()
  dispatchMock.mockReset()
  latestSSEOptions = null
  mockSSEState.connectionState = 'connected'
  mockTicketQuery.override = null
  useRecoveryAutoReloadMock.mockReset()
  saveUiStateMutate.mockReset()
  vi.restoreAllMocks()
})

afterEach(() => {
  queryClient.clear()
  latestSSEOptions = null
  mockSSEState.connectionState = 'connected'
  mockTicketQuery.override = null
  useRecoveryAutoReloadMock.mockReset()
  vi.restoreAllMocks()
})

describe('TicketDashboard', () => {
  it('persists the needs-input "seen" acknowledgment via the needs_input_attention scope when a waiting ticket is opened', async () => {
    const initialTicket = makeTicket({
      status: 'WAITING_PRD_APPROVAL',
      id: selectedTicketId,
      needsInputSeenSignature: null,
    })

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-header')).toHaveTextContent('WAITING_PRD_APPROVAL')
    })

    await waitFor(() => {
      expect(saveUiStateMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: selectedTicketId,
          scope: 'needs_input_attention',
          data: { seenSignature: expect.stringContaining('WAITING_PRD_APPROVAL|') },
        }),
      )
    })
  })

  it('follows the next live status immediately on SSE transitions even if ticket refetch is still stale', async () => {
    const initialTicket = makeTicket({ status: 'DRAFTING_PRD', id: selectedTicketId })

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-header')).toHaveTextContent('DRAFTING_PRD')
    })

    await waitFor(() => {
      expect(latestSSEOptions?.ticketId).toBe(selectedTicketId)
    })

    await act(async () => {
      latestSSEOptions?.onEvent?.({
        type: 'state_change',
        data: {
          ticketId: selectedTicketId,
          from: 'DRAFTING_PRD',
          to: 'REFINING_PRD',
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-header')).toHaveTextContent('REFINING_PRD')
      expect(screen.getByTestId('navigator-current')).toHaveTextContent('REFINING_PRD')
      expect(screen.getByTestId('navigator-selected')).toHaveTextContent('REFINING_PRD')
    })
  })

  it('follows the interview draft transition immediately on SSE transitions', async () => {
    const initialTicket = makeTicket({ status: 'COUNCIL_DELIBERATING', id: selectedTicketId })

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-header')).toHaveTextContent('COUNCIL_DELIBERATING')
    })

    await waitFor(() => {
      expect(latestSSEOptions?.ticketId).toBe(selectedTicketId)
    })

    await act(async () => {
      latestSSEOptions?.onEvent?.({
        type: 'state_change',
        data: {
          ticketId: selectedTicketId,
          from: 'COUNCIL_DELIBERATING',
          to: 'COUNCIL_VOTING_INTERVIEW',
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-header')).toHaveTextContent('COUNCIL_VOTING_INTERVIEW')
      expect(screen.getByTestId('navigator-current')).toHaveTextContent('COUNCIL_VOTING_INTERVIEW')
      expect(screen.getByTestId('navigator-selected')).toHaveTextContent('COUNCIL_VOTING_INTERVIEW')
    })
  })

  it('shows reconnect feedback without arming a destructive reload', async () => {
    const initialTicket = makeTicket({ status: 'CODING', id: selectedTicketId })
    mockSSEState.connectionState = 'reconnecting'

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const { rerender } = renderDashboard()

    expect(await screen.findByText('Live updates reconnecting...')).toBeInTheDocument()
    expect(
      screen.getByText('LoopTroop is refetching the latest ticket state and will reconnect automatically.'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('live-updates-reconnecting-overlay')).toBeInTheDocument()
    expect(useRecoveryAutoReloadMock).not.toHaveBeenCalledWith('live-updates-reconnect', true)

    mockSSEState.connectionState = 'connected'
    rerender(renderDashboardElement())

    await waitFor(() => {
      expect(useRecoveryAutoReloadMock).toHaveBeenLastCalledWith(`ticket-loading:${selectedTicketId}`, false)
    })
    expect(useRecoveryAutoReloadMock).not.toHaveBeenCalledWith('live-updates-reconnect', false)
  })

  it('arms ticket loading recovery only after the selected ticket rendered once', async () => {
    const initialTicket = makeTicket({ status: 'CODING', id: selectedTicketId })
    mockTicketQuery.override = { data: undefined }

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const { rerender } = renderDashboard()

    expect(await screen.findByText('Loading ticket...')).toBeInTheDocument()
    expect(useRecoveryAutoReloadMock).toHaveBeenCalledWith(`ticket-loading:${selectedTicketId}`, false)

    mockTicketQuery.override = null
    rerender(renderDashboardElement())

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-header')).toHaveTextContent('CODING')
    })

    mockTicketQuery.override = { data: undefined }
    rerender(renderDashboardElement())

    await waitFor(() => {
      expect(useRecoveryAutoReloadMock).toHaveBeenCalledWith(`ticket-loading:${selectedTicketId}`, true)
    })
  })

  /**
   * A failed fetch leaves `ticket` undefined, which is the same state as a
   * pending one. Showing the skeleton for both is what made an unreachable
   * backend read as "still loading".
   */
  it('reports a failed ticket fetch instead of showing the loading skeleton', async () => {
    const refetch = vi.fn()
    mockTicketQuery.override = {
      data: undefined,
      isError: true,
      error: new Error('Failed to fetch ticket (HTTP 503: API token not configured)'),
      refetch,
      isFetching: false,
    }

    renderDashboard()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Ticket unavailable')
    expect(alert).toHaveTextContent('HTTP 503: API token not configured')
    expect(screen.queryByText('Loading ticket...')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('renders SSE log events in the active ticket without reopening it', async () => {
    const initialTicket = makeTicket({ status: 'CODING', id: selectedTicketId })

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()

    await waitFor(() => {
      expect(latestSSEOptions?.ticketId).toBe(selectedTicketId)
      expect(screen.getByTestId('workspace-log-count')).toHaveTextContent('0')
    })

    await act(async () => {
      latestSSEOptions?.onEvent?.({
        type: 'log',
        data: {
          ticketId: selectedTicketId,
          phase: 'CODING',
          status: 'CODING',
          type: 'info',
          source: 'system',
          audience: 'all',
          kind: 'milestone',
          content: 'Live coding log arrived.',
          entryId: 'log:live-coding',
          op: 'append',
          streaming: false,
          timestamp: '2026-05-04T10:00:00.000Z',
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText('[SYS] Live coding log arrived.')).toBeInTheDocument()
      expect(screen.getByTestId('workspace-log-count')).toHaveTextContent('1')
    })
  })

  it('renders app_error SSE events as application log errors', async () => {
    const initialTicket = makeTicket({ status: 'CODING', id: selectedTicketId })

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()

    await waitFor(() => {
      expect(latestSSEOptions?.ticketId).toBe(selectedTicketId)
      expect(screen.getByTestId('workspace-log-count')).toHaveTextContent('0')
    })

    await act(async () => {
      latestSSEOptions?.onEvent?.({
        type: 'app_error',
        data: {
          ticketId: selectedTicketId,
          phase: 'CODING',
          message: 'Final test failed.',
          timestamp: '2026-05-04T10:00:00.000Z',
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText('[ERROR] Final test failed.')).toBeInTheDocument()
      expect(screen.getByTestId('workspace-log-count')).toHaveTextContent('2')
    })
  })

  it('forwards valid interview batch SSE payloads as typed custom events', async () => {
    const initialTicket = makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS', id: selectedTicketId })
    const postMessageSpy = vi.spyOn(window, 'postMessage')
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()

    await waitFor(() => {
      expect(latestSSEOptions?.ticketId).toBe(selectedTicketId)
    })

    const batch = {
      questions: [
        {
          id: 'Q01',
          question: 'Which target matters?',
          phase: 'Scope',
          source: 'compiled',
        },
      ],
      progress: { current: 1, total: 2 },
      isComplete: false,
      isFinalFreeForm: false,
      aiCommentary: 'Pick the highest-signal target.',
      batchNumber: 1,
      source: 'prom4',
    }

    await act(async () => {
      latestSSEOptions?.onEvent?.({
        type: 'needs_input',
        data: {
          type: 'interview_batch',
          ticketId: selectedTicketId,
          batch,
        },
      })
    })

    const customEvent = dispatchSpy.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === INTERVIEW_BATCH_EVENT) as CustomEvent | undefined

    expect(customEvent?.detail).toEqual({
      type: 'interview_batch',
      ticketId: selectedTicketId,
      batch,
    })
    expect(postMessageSpy).not.toHaveBeenCalled()

    dispatchSpy.mockClear()

    await act(async () => {
      latestSSEOptions?.onEvent?.({
        type: 'needs_input',
        data: {
          type: 'interview_batch',
          ticketId: selectedTicketId,
          batch: { questions: 'invalid' },
        },
      })
    })

    expect(dispatchSpy.mock.calls.some(([event]) => event.type === INTERVIEW_BATCH_EVENT)).toBe(false)
  })

  it('keeps a manually selected past phase pinned across live transitions', async () => {
    const initialTicket = makeTicket({ status: 'COUNCIL_VOTING_PRD', id: selectedTicketId })

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-header')).toHaveTextContent('COUNCIL_VOTING_PRD')
    })

    await waitFor(() => {
      expect(latestSSEOptions?.ticketId).toBe(selectedTicketId)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Select drafting' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Back to live' })).toBeInTheDocument()
      expect(screen.getByTestId('navigator-selected')).toHaveTextContent('DRAFTING_PRD')
    })

    await act(async () => {
      latestSSEOptions?.onEvent?.({
        type: 'state_change',
        data: {
          ticketId: selectedTicketId,
          from: 'COUNCIL_VOTING_PRD',
          to: 'REFINING_PRD',
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Back to live' })).toBeInTheDocument()
      expect(screen.getByTestId('navigator-current')).toHaveTextContent('REFINING_PRD')
      expect(screen.getByTestId('navigator-selected')).toHaveTextContent('DRAFTING_PRD')
      expect(screen.getByTestId('dashboard-header')).toHaveTextContent('REFINING_PRD')
    })
  })

  it('releases a stale pin once the selected phase becomes live and follows the next transition', async () => {
    const initialTicket = makeTicket({ status: 'COUNCIL_VOTING_PRD', id: selectedTicketId })

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-header')).toHaveTextContent('COUNCIL_VOTING_PRD')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Select drafting' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Back to live' })).toBeInTheDocument()
      expect(screen.getByTestId('navigator-selected')).toHaveTextContent('DRAFTING_PRD')
    })

    await act(async () => {
      simulateSSE('COUNCIL_VOTING_PRD', 'DRAFTING_PRD')
    })

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-header')).toHaveTextContent('DRAFTING_PRD')
      expect(screen.queryByRole('button', { name: 'Back to live' })).not.toBeInTheDocument()
      expect(screen.getByTestId('navigator-current')).toHaveTextContent('DRAFTING_PRD')
      expect(screen.getByTestId('navigator-selected')).toHaveTextContent('DRAFTING_PRD')
    })

    await act(async () => {
      simulateSSE('DRAFTING_PRD', 'REFINING_PRD')
    })

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-header')).toHaveTextContent('REFINING_PRD')
      expect(screen.queryByRole('button', { name: 'Back to live' })).not.toBeInTheDocument()
      expect(screen.getByTestId('navigator-current')).toHaveTextContent('REFINING_PRD')
      expect(screen.getByTestId('navigator-selected')).toHaveTextContent('REFINING_PRD')
    })
  })

  it('advances past stale livePhase when refetch returns a newer status (fast transition race)', async () => {
    const initialTicket = makeTicket({ status: 'SCANNING_RELEVANT_FILES', id: selectedTicketId })

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        // Simulate the refetch returning a NEWER status than the SSE event
        // (the server already transitioned past SCANNING_RELEVANT_FILES).
        return createJsonResponse(makeTicket({ status: 'COUNCIL_DELIBERATING', id: selectedTicketId }))
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-header')).toHaveTextContent('SCANNING_RELEVANT_FILES')
    })

    await waitFor(() => {
      expect(latestSSEOptions?.ticketId).toBe(selectedTicketId)
    })

    // SSE delivers DRAFT → SCANNING_RELEVANT_FILES (livePhase set).
    await act(async () => {
      latestSSEOptions?.onEvent?.({
        type: 'state_change',
        data: {
          ticketId: selectedTicketId,
          from: 'DRAFT',
          to: 'SCANNING_RELEVANT_FILES',
        },
      })
    })

    // Now simulate the race: a React Query refetch resolves with a NEWER
    // status (COUNCIL_DELIBERATING), leapfrogging the stale livePhase.
    await act(async () => {
      queryClient.setQueryData(['ticket', selectedTicketId], makeTicket({ status: 'COUNCIL_DELIBERATING', id: selectedTicketId }))
    })

    // The useEffect should advance livePhase to match the DB status.
    await waitFor(() => {
      expect(screen.getByTestId('navigator-current')).toHaveTextContent('COUNCIL_DELIBERATING')
      expect(screen.getByTestId('dashboard-header')).toHaveTextContent('COUNCIL_DELIBERATING')
    })
  })

  it('uses monotonic revisions when Manual QA transitions backward to Coding', async () => {
    const initialTicket = makeTicket({
      status: 'WAITING_MANUAL_QA',
      id: selectedTicketId,
      workflowRevision: 10,
    })
    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) return createJsonResponse([])
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) return createJsonResponse([])
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) return createJsonResponse(initialTicket)
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()
    await waitFor(() => expect(latestSSEOptions?.ticketId).toBe(selectedTicketId))

    await act(async () => {
      latestSSEOptions?.onEvent?.({
        type: 'state_change',
        data: {
          ticketId: selectedTicketId,
          from: 'WAITING_MANUAL_QA',
          to: 'CODING',
          workflowRevision: 11,
        },
      })
    })
    expect(screen.getByTestId('dashboard-header')).toHaveTextContent('CODING')

    await act(async () => {
      latestSSEOptions?.onEvent?.({
        type: 'state_change',
        data: {
          ticketId: selectedTicketId,
          from: 'WAITING_MANUAL_QA',
          to: 'INTEGRATING_CHANGES',
          workflowRevision: 10,
        },
      })
    })
    expect(screen.getByTestId('dashboard-header')).toHaveTextContent('CODING')

    await act(async () => {
      queryClient.setQueryData(['ticket', selectedTicketId], {
        ...initialTicket,
        status: 'RUNNING_FINAL_TEST',
        workflowRevision: 12,
      })
    })
    await waitFor(() => expect(screen.getByTestId('dashboard-header')).toHaveTextContent('RUNNING_FINAL_TEST'))
  })

  it('lets users reselect backlog after start and keeps the backlog log viewer visible', async () => {
    const initialTicket = makeTicket({ status: 'DRAFT', id: selectedTicketId })

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(makeTicket({ status: 'SCANNING_RELEVANT_FILES', id: selectedTicketId }))
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByTestId('navigator-current')).toHaveTextContent('DRAFT')
    })

    await act(async () => {
      simulateSSE('DRAFT', 'SCANNING_RELEVANT_FILES')
    })

    await waitFor(() => {
      expect(screen.getByTestId('navigator-current')).toHaveTextContent('SCANNING_RELEVANT_FILES')
      expect(screen.getByTestId('active-workspace')).toHaveTextContent('SCANNING_RELEVANT_FILES')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Select backlog' }))

    await waitFor(() => {
      expect(screen.getByTestId('navigator-current')).toHaveTextContent('SCANNING_RELEVANT_FILES')
      expect(screen.getByTestId('navigator-selected')).toHaveTextContent('DRAFT')
      expect(screen.getByTestId('active-workspace')).toHaveTextContent('DRAFT')
      expect(screen.getByRole('button', { name: 'Log — Backlog' })).toBeInTheDocument()
    })
  })

  it('updates the workspace phase summary when the selected phase changes', async () => {
    const initialTicket = makeTicket({ status: 'DRAFTING_PRD', id: selectedTicketId })

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByText(/drafting competing PRDs\./)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Select backlog' }))

    await waitFor(() => {
      expect(screen.getByText(/The ticket is still in backlog, so nothing is running yet\./)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Back to live' }))

    await waitFor(() => {
      expect(screen.getByText(/drafting competing PRDs\./)).toBeInTheDocument()
    })
  })

  it('leaves full log mode when selecting an error occurrence', async () => {
    const initialTicket = makeTicket({
      status: 'CODING',
      id: selectedTicketId,
      hasPastErrors: true,
      errorOccurrences: [
        {
          id: 'error-1',
          occurrenceNumber: 1,
          blockedFromStatus: 'CODING',
          errorMessage: 'Implementation failed.',
          errorCodes: [],
          occurredAt: '2026-05-04T10:00:00.000Z',
          resolvedAt: '2026-05-04T10:01:00.000Z',
          resolutionStatus: 'RETRIED',
          resumedToStatus: 'CODING',
        },
      ],
    })

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByTestId('workspace-full-log')).toHaveTextContent('closed')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Open full log' }))

    await waitFor(() => {
      expect(screen.getByTestId('navigator-full-log')).toHaveTextContent('open')
      expect(screen.getByTestId('workspace-full-log')).toHaveTextContent('open')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Select error' }))

    await waitFor(() => {
      expect(screen.getByTestId('navigator-full-log')).toHaveTextContent('closed')
      expect(screen.getByTestId('workspace-full-log')).toHaveTextContent('closed')
      expect(screen.getByTestId('workspace-error-id')).toHaveTextContent('error-1')
    })
  })

  it('keeps the workspace summary collapsed while navigating phases on the same ticket', async () => {
    const initialTicket = makeTicket({ status: 'DRAFTING_PRD', id: selectedTicketId })

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByText(/drafting competing PRDs\./)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Council Drafting Specs' }))

    await waitFor(() => {
      expect(screen.queryByText(/drafting competing PRDs\./)).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Select backlog' }))

    await waitFor(() => {
      expect(screen.queryByText(/The ticket is still in backlog, so nothing is running yet\./)).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Back to live' }))

    await waitFor(() => {
      expect(screen.queryByText(/drafting competing PRDs\./)).not.toBeInTheDocument()
    })
  })

  it('switches to interview approval and forwards workspace navigation focus', async () => {
    const initialTicket = makeTicket({ status: 'WAITING_PRD_APPROVAL', id: selectedTicketId })

    queryClient.setQueryData(['ticket', selectedTicketId], initialTicket)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/files/${selectedTicketId}/logs`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}/artifacts`)) {
        return createJsonResponse([])
      }
      if (url.endsWith(`/api/tickets/${selectedTicketId}`)) {
        return createJsonResponse(initialTicket)
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    renderDashboard()

    await waitFor(() => {
      expect(screen.getByTestId('navigator-current')).toHaveTextContent('WAITING_PRD_APPROVAL')
    })

    await act(async () => {
      window.dispatchEvent(new CustomEvent(WORKSPACE_PHASE_NAVIGATE_EVENT, {
        detail: {
          ticketId: selectedTicketId,
          phase: 'WAITING_INTERVIEW_APPROVAL',
          anchorId: 'interview-group-phase-foundation',
        },
      }))
    })

    await waitFor(() => {
      expect(screen.getByTestId('navigator-selected')).toHaveTextContent('WAITING_INTERVIEW_APPROVAL')
      expect(screen.getByTestId('active-workspace')).toHaveTextContent('WAITING_INTERVIEW_APPROVAL')
    })

    const focusEvent = dispatchSpy.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'looptroop:interview-approval-focus') as CustomEvent<{ ticketId: string; anchorId: string }> | undefined

    expect(focusEvent?.detail).toEqual({
      ticketId: selectedTicketId,
      anchorId: 'interview-group-phase-foundation',
    })
  })
})
