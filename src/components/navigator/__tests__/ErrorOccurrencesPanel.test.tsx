import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeTicket } from '@/test/factories'
import { ErrorOccurrencesPanel } from '../ErrorOccurrencesPanel'

describe('ErrorOccurrencesPanel', () => {
  it('keeps historical errors collapsed by default', () => {
    const ticket = makeTicket({
      status: 'CANCELED',
      errorOccurrences: [
        {
          id: 'error-1',
          occurrenceNumber: 1,
          blockedFromStatus: 'CODING',
          errorMessage: 'First crash',
          errorCodes: [],
          occurredAt: '2026-03-11T10:10:00.000Z',
          resolvedAt: '2026-03-11T10:11:00.000Z',
          resolutionStatus: 'RETRIED',
          resumedToStatus: 'REFINING_PRD',
        },
      ],
      activeErrorOccurrenceId: null,
      hasPastErrors: true,
    })

    render(
      <ErrorOccurrencesPanel
        ticket={ticket}
        selectedErrorOccurrenceId={null}
        onSelectErrorOccurrence={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /errors/i })).toBeInTheDocument()
    expect(screen.queryByText('Error 1: Implementing (Bead ?/?)')).not.toBeInTheDocument()
  })

  it('auto-expands for a live blocked ticket and lists all errors in one section', () => {
    const onSelect = vi.fn()
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      hasPastErrors: true,
      errorOccurrences: [
        {
          id: 'error-1',
          occurrenceNumber: 1,
          blockedFromStatus: 'CODING',
          errorMessage: 'First crash',
          errorCodes: ['E1'],
          occurredAt: '2026-03-11T10:10:00.000Z',
          resolvedAt: '2026-03-11T10:11:00.000Z',
          resolutionStatus: 'RETRIED',
          resumedToStatus: 'REFINING_PRD',
        },
        {
          id: 'error-2',
          occurrenceNumber: 2,
          blockedFromStatus: 'REFINING_PRD',
          errorMessage: 'Second crash',
          errorCodes: ['E2'],
          occurredAt: '2026-03-11T10:15:00.000Z',
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
      activeErrorOccurrenceId: 'error-2',
    })

    render(
      <ErrorOccurrencesPanel
        ticket={ticket}
        selectedErrorOccurrenceId={null}
        onSelectErrorOccurrence={onSelect}
      />,
    )

    expect(screen.getByRole('button', { name: /errors/i })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Error 2: Refining Specs')).toBeInTheDocument()
    expect(screen.getByText('Error 1: Implementing (Bead ?/?)')).toBeInTheDocument()
    expect(screen.queryByText('Current')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /past errors/i })).not.toBeInTheDocument()

    const pastError = screen.getByRole('button', { name: /error 1/i })
    fireEvent.click(pastError)

    expect(onSelect).toHaveBeenCalledWith('error-1')
  })

  it('lets auto-expanded active errors collapse and reopen', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      hasPastErrors: true,
      errorOccurrences: [
        {
          id: 'error-1',
          occurrenceNumber: 1,
          blockedFromStatus: 'REFINING_PRD',
          errorMessage: 'Active crash',
          errorCodes: ['E1'],
          occurredAt: '2026-03-11T10:15:00.000Z',
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
      activeErrorOccurrenceId: 'error-1',
    })

    render(
      <ErrorOccurrencesPanel
        ticket={ticket}
        selectedErrorOccurrenceId={null}
        onSelectErrorOccurrence={vi.fn()}
      />,
    )

    const header = screen.getByRole('button', { name: /errors/i })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /error 1/i })).toBeInTheDocument()

    fireEvent.click(header)

    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /error 1/i })).not.toBeInTheDocument()

    fireEvent.click(header)

    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /error 1/i })).toBeInTheDocument()
  })

  it('keeps active coding bead identifiers out of the compact errors header', () => {
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      hasPastErrors: true,
      activeErrorOccurrenceId: 'error-1',
      errorOccurrences: [
        {
          id: 'error-1',
          occurrenceNumber: 1,
          blockedFromStatus: 'CODING',
          errorMessage: 'Coding failed on a bead with a verbose identifier.',
          errorCodes: [],
          occurredAt: '2026-03-11T10:10:00.000Z',
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
      runtime: {
        ...makeTicket().runtime,
        currentBead: 4,
        totalBeads: 9,
        lastFailedBeadId: 'bead-with-a-very-long-generated-name-that-would-overflow-the-left-panel',
        activeBeadIteration: 4,
      },
    })

    render(
      <ErrorOccurrencesPanel
        ticket={ticket}
        selectedErrorOccurrenceId={null}
        onSelectErrorOccurrence={vi.fn()}
      />,
    )

    const header = screen.getByRole('button', { name: /errors/i })
    expect(header).toHaveTextContent('Errors')
    expect(header).toHaveTextContent('1')
    expect(header).toHaveTextContent('Active')
    expect(header).not.toHaveTextContent('bead-with-a-very-long-generated-name')
    expect(header).not.toHaveTextContent('iter 4')
    expect(screen.getByText('Error 1: Implementing (Bead 4/9)')).toBeInTheDocument()
  })

  it('auto-expands when a resolved occurrence is selected', () => {
    const ticket = makeTicket({
      status: 'CANCELED',
      errorOccurrences: [
        {
          id: 'error-1',
          occurrenceNumber: 1,
          blockedFromStatus: 'CODING',
          errorMessage: 'First crash',
          errorCodes: [],
          occurredAt: '2026-03-11T10:10:00.000Z',
          resolvedAt: '2026-03-11T10:11:00.000Z',
          resolutionStatus: 'RETRIED',
          resumedToStatus: 'REFINING_PRD',
        },
      ],
      activeErrorOccurrenceId: null,
      hasPastErrors: true,
    })

    render(
      <ErrorOccurrencesPanel
        ticket={ticket}
        selectedErrorOccurrenceId="error-1"
        onSelectErrorOccurrence={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /errors/i })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Error 1: Implementing (Bead ?/?)')).toBeInTheDocument()
  })

  it('wraps long status labels and omits milliseconds in the summary subtitle', () => {
    const ticket = makeTicket({
      status: 'CANCELED',
      errorOccurrences: [
        {
          id: 'error-1',
          occurrenceNumber: 1,
          blockedFromStatus: 'CODING',
          errorMessage: 'Workspace setup timed out.',
          errorCodes: [],
          occurredAt: '2026-03-11T10:10:00.456Z',
          resolvedAt: '2026-03-11T10:11:00.789Z',
          resolutionStatus: 'RETRIED',
          resumedToStatus: 'WAITING_EXECUTION_SETUP_APPROVAL',
        },
      ],
      activeErrorOccurrenceId: null,
      hasPastErrors: true,
    })

    render(
      <ErrorOccurrencesPanel
        ticket={ticket}
        selectedErrorOccurrenceId="error-1"
        onSelectErrorOccurrence={vi.fn()}
      />,
    )

    const statusBadge = screen.getByText('Retried to Approving Workspace Setup')
    expect(statusBadge).toHaveClass('max-w-full', 'whitespace-normal', 'break-words')

    const occurrenceRow = screen.getByRole('button', { name: /error 1/i })
    expect(occurrenceRow).not.toHaveTextContent('.456')
    expect(occurrenceRow).not.toHaveTextContent('.789')
  })
})
