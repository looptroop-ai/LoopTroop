import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode, Ref } from 'react'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { LogProvider } from '@/context/LogContext'
import { serverLogCache } from '@/context/logUtils'
import { makeTicket } from '@/test/factories'
import { renderWithProviders, createJsonResponse } from '@/test/renderHelpers'
import { PhaseReviewView } from '../PhaseReviewView'

const mockUseTicketArtifactBundle = vi.hoisted(() => vi.fn())

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

vi.mock('@/hooks/useTicketArtifacts', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTicketArtifacts')>('@/hooks/useTicketArtifacts')
  return {
    ...actual,
    useTicketArtifactBundle: (...args: unknown[]) => mockUseTicketArtifactBundle(...args),
  }
})

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
  }

  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserverMock,
  })

  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
  })

  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (handle: number) => window.clearTimeout(handle),
  })

  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
})

beforeEach(() => {
  mockUseTicketArtifactBundle.mockReturnValue({
    artifacts: [],
    status: 'success',
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  })
})

afterEach(() => {
  localStorage.clear()
  serverLogCache.clear()
  vi.restoreAllMocks()
})

describe('PhaseReviewView', () => {
  it('loads a normally completed active attempt through an exact phase scope', async () => {
    const phase = 'COUNCIL_VOTING_INTERVIEW'
    const ticket = makeTicket({ status: 'DRAFTING_PRD' })

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.includes(`/phases/${phase}/attempts`)) {
        return createJsonResponse([{
          ticketId: ticket.id,
          phase,
          attemptNumber: 1,
          state: 'active',
          archivedReason: null,
          createdAt: '2026-08-21T10:00:00.000Z',
          archivedAt: null,
        }])
      }
      if (url.includes('/logs?')) return createJsonResponse({ entries: [], olderCursor: null, hasOlder: false })
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(
      <LogProvider ticketId={ticket.id} currentStatus={ticket.status}>
        <PhaseReviewView phase={phase} ticket={ticket} />
      </LogProvider>,
    )

    await waitFor(() => {
      expect(mockUseTicketArtifactBundle).toHaveBeenCalledWith(ticket.id, expect.arrayContaining([
        { phase, phaseAttempt: 1 },
        { phase: 'COUNCIL_DELIBERATING' },
      ]))
    })
  })

  it.each([
    'COUNCIL_DELIBERATING',
    'COUNCIL_VOTING_INTERVIEW',
    'COMPILING_INTERVIEW',
  ])('starts historical council phase %s logs expanded', (phase) => {
    const ticket = makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.includes('/phases/') && url.endsWith('/attempts')) {
        return createJsonResponse([])
      }
      if (url.includes('/logs?')) {
        return createJsonResponse({ entries: [], olderCursor: null, hasOlder: false })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(
      <LogProvider ticketId={ticket.id} currentStatus={ticket.status}>
        <PhaseReviewView phase={phase} ticket={ticket} />
      </LogProvider>,
    )

    expect(screen.getByRole('button', { name: /^Log$/i })).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps non-council historical review logs collapsed by default', () => {
    const ticket = makeTicket({ status: 'SCANNING_RELEVANT_FILES' })

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.includes('/phases/') && url.endsWith('/attempts')) {
        return createJsonResponse([])
      }
      if (url.includes('/logs?')) {
        return createJsonResponse({ entries: [], olderCursor: null, hasOlder: false })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(
      <LogProvider ticketId={ticket.id} currentStatus={ticket.status}>
        <PhaseReviewView phase="PRE_FLIGHT_CHECK" ticket={ticket} />
      </LogProvider>,
    )

    expect(screen.getByRole('button', { name: /^Log$/i })).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows a nonblank drafting surface, version selector, artifacts, and expanded log', async () => {
    const ticket = makeTicket({ status: 'GENERATING_EXECUTION_SETUP_PLAN' })

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(ticket.id)}/phases/GENERATING_EXECUTION_SETUP_PLAN/attempts`) {
        return createJsonResponse([
          {
            ticketId: ticket.id,
            phase: 'GENERATING_EXECUTION_SETUP_PLAN',
            attemptNumber: 2,
            state: 'active',
            archivedReason: null,
            createdAt: '2026-03-25T10:20:00.000Z',
            archivedAt: null,
          },
          {
            ticketId: ticket.id,
            phase: 'GENERATING_EXECUTION_SETUP_PLAN',
            attemptNumber: 1,
            state: 'archived',
            archivedReason: 'regenerated',
            createdAt: '2026-03-25T10:00:00.000Z',
            archivedAt: '2026-03-25T10:19:00.000Z',
          },
        ])
      }
      if (url.startsWith(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?`)) {
        return createJsonResponse({ entries: [], olderCursor: null, hasOlder: false })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(
      <LogProvider ticketId={ticket.id} currentStatus={ticket.status}>
        <PhaseReviewView phase="GENERATING_EXECUTION_SETUP_PLAN" ticket={ticket} />
      </LogProvider>,
    )

    expect(screen.getByText('Drafting the workspace setup plan')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Workspace Setup Plan' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generation Report' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Log$/i })).toHaveAttribute('aria-expanded', 'true')

    expect(await screen.findByText('Current version (2)')).toBeInTheDocument()
    expect(screen.getByText('Archived version 1')).toBeInTheDocument()
  })

  it('shows projected draft logs when revisiting backlog after start', async () => {
    const ticket = makeTicket({
      status: 'SCANNING_RELEVANT_FILES',
      description: 'Add a planning gate before the interview starts.',
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?`)) {
        return createJsonResponse({
          entries: [{
            entryId: 'draft-log-1',
            phase: 'DRAFT',
            status: 'DRAFT',
            content: '[SYS] Start requested.',
            source: 'system',
            timestamp: '2026-03-10T10:00:00.000Z',
            audience: 'all',
            kind: 'milestone',
            streaming: false,
            op: 'append',
          }],
          olderCursor: null,
          hasOlder: false,
        })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(
      <LogProvider ticketId={ticket.id} currentStatus={ticket.status}>
        <PhaseReviewView phase="DRAFT" ticket={ticket} />
      </LogProvider>,
    )

    expect(screen.getByText('Description')).toBeInTheDocument()
    expect(screen.getByText('Add a planning gate before the interview starts.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Log$/i })).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText(/Start requested\./i)).toBeInTheDocument()
    })
  })

  it('keeps the backlog log viewer visible when no draft logs exist yet', async () => {
    const ticket = makeTicket({
      status: 'SCANNING_RELEVANT_FILES',
      description: 'Add a planning gate before the interview starts.',
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?`)) {
        return createJsonResponse({ entries: [], olderCursor: null, hasOlder: false })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(
      <LogProvider ticketId={ticket.id} currentStatus={ticket.status}>
        <PhaseReviewView phase="DRAFT" ticket={ticket} />
      </LogProvider>,
    )

    expect(screen.getByRole('button', { name: /^Log$/i })).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByText(/No log entries yet\. Logs will stream here during execution\./i)).toBeInTheDocument()
    })
  })

  it('allows toggling description between markdown (default) and raw views when in backlog', async () => {
    const ticket = makeTicket({
      status: 'SCANNING_RELEVANT_FILES',
      description: 'Add a planning gate before the interview starts.',
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.startsWith(`/api/tickets/${encodeURIComponent(ticket.id)}/logs?`)) {
        return createJsonResponse({ entries: [], olderCursor: null, hasOlder: false })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderWithProviders(
      <LogProvider ticketId={ticket.id} currentStatus={ticket.status}>
        <PhaseReviewView phase="DRAFT" ticket={ticket} />
      </LogProvider>,
    )

    // Markdown view (default)
    expect(screen.getByRole('tab', { name: /Markdown/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Raw/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Markdown/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: 'Copy description' })).not.toBeInTheDocument()

    // Click Raw
    const rawTab = screen.getByRole('tab', { name: /Raw/i })
    fireEvent.click(rawTab)
    expect(screen.getByRole('tab', { name: /Raw/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Markdown/i })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('button', { name: 'Copy description' })).toBeInTheDocument()
  })
})
