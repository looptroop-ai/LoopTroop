import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { PhaseTimeline } from '../PhaseTimeline'
import { renderWithProviders } from '@/test/renderHelpers'
import { makeTicket } from '@/test/factories'

describe('PhaseTimeline', () => {
  it('renders phase groups', () => {
    renderWithProviders(<PhaseTimeline currentStatus="DRAFT" />)
    expect(screen.getByText('To Do')).toBeInTheDocument()
    expect(screen.getByText('Discovery')).toBeInTheDocument()
    expect(screen.getByText('Interview')).toBeInTheDocument()
    expect(screen.getByText('Specs (PRD)')).toBeInTheDocument()
    expect(screen.getByText('Blueprint (Beads)')).toBeInTheDocument()
    expect(screen.getByText('Pre-Implementation')).toBeInTheDocument()
    expect(screen.getByText('Implementation')).toBeInTheDocument()
    expect(screen.getByText('Post-Implementation')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.queryByText('Errors')).not.toBeInTheDocument()
  })

  it('shows Draft as active when currentStatus is DRAFT', () => {
    renderWithProviders(<PhaseTimeline currentStatus="DRAFT" />)
    // Planning group should be auto-expanded for DRAFT
    expect(screen.getByText('Backlog')).toBeInTheDocument()
  })

  it('calls onSelectPhase when clicking a past phase', () => {
    const onSelect = vi.fn()
    renderWithProviders(<PhaseTimeline currentStatus="DRAFTING_PRD" onSelectPhase={onSelect} />)
    // Expand To Do group to see Backlog
    fireEvent.click(screen.getByText('To Do'))
    fireEvent.click(screen.getByText('Backlog'))
    expect(onSelect).toHaveBeenCalledWith('DRAFT')
  })

  it('disables future phases', () => {
    renderWithProviders(<PhaseTimeline currentStatus="DRAFT" />)
    // Expand Implementation group to see Coding
    fireEvent.click(screen.getByText('Implementation'))
    const codingBtn = screen.getByText(/Implementing \(Bead \?\/\?\)/).closest('button')
    expect(codingBtn).toBeDisabled()
  })

  it('shows all phase labels', () => {
    renderWithProviders(<PhaseTimeline currentStatus="CODING" />)
    // Interview group phases - expand to see waiting label
    fireEvent.click(screen.getByText('Interview'))
    expect(screen.getByText(/Interviewing/)).toBeInTheDocument()
    // Implementation group is auto-expanded since CODING is active
    expect(screen.getByText(/Implementing \(Bead \?\/\?\)/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Post-Implementation'))
    expect(screen.getByText('Testing Implementation')).toBeInTheDocument()
  })

  it('keeps visited Manual QA phases selectable after the loop returns to coding', () => {
    const onSelect = vi.fn()
    const ticket = makeTicket({
      status: 'CODING',
      visitedStatuses: ['GENERATING_QA_CHECKLIST', 'WAITING_MANUAL_QA'],
      manualQa: {
        activeVersion: 1,
        completedRoundCount: 0,
        latestOutcome: 'failed',
        artifactAvailability: { checklist: true, results: true, coverage: true, summary: true },
      },
    })
    renderWithProviders(<PhaseTimeline currentStatus="CODING" ticket={ticket} onSelectPhase={onSelect} />)

    const postImplementationGroup = screen.getByText('Post-Implementation').closest('button')
    expect(postImplementationGroup).toHaveClass('text-green-600')
    expect(postImplementationGroup).not.toHaveClass('text-primary')
    fireEvent.click(postImplementationGroup!)
    const qaButton = screen.getByText(/^Manual QA$/).closest('button')
    expect(qaButton).not.toBeDisabled()
    fireEvent.click(qaButton!)
    expect(onSelect).toHaveBeenCalledWith('WAITING_MANUAL_QA')
  })

  it('keeps visited Manual QA selectable when a later coding round blocks', () => {
    const onSelect = vi.fn()
    const ticket = makeTicket({
      status: 'BLOCKED_ERROR',
      visitedStatuses: ['GENERATING_QA_CHECKLIST', 'WAITING_MANUAL_QA', 'CODING'],
    })
    renderWithProviders(
      <PhaseTimeline
        currentStatus="BLOCKED_ERROR"
        previousStatus="CODING"
        reviewCutoffStatus="CODING"
        ticket={ticket}
        onSelectPhase={onSelect}
      />,
    )

    fireEvent.click(screen.getByText('Post-Implementation'))
    const qaButton = screen.getByText(/^Manual QA/).closest('button')
    expect(qaButton).not.toBeDisabled()
    fireEvent.click(qaButton!)
    expect(onSelect).toHaveBeenCalledWith('WAITING_MANUAL_QA')
  })

  it('shows persisted bead progress for a historical CODING timeline row', () => {
    const ticket = makeTicket({
      status: 'COMPLETED',
      runtime: {
        ...makeTicket().runtime,
        currentBead: 8,
        completedBeads: 8,
        totalBeads: 8,
      },
    })

    renderWithProviders(
      <PhaseTimeline currentStatus="COMPLETED" ticket={ticket} />,
    )

    fireEvent.click(screen.getByText('Implementation'))

    expect(screen.getByText('Implementing (Bead 8/8)')).toBeInTheDocument()
    expect(screen.queryByText(/Implementing \(Bead \?\/\?\)/)).not.toBeInTheDocument()
  })

  it('shows the ETA range on the active CODING phase', () => {
    const base = makeTicket()
    const ticket = makeTicket({
      status: 'CODING',
      runtime: {
        ...base.runtime,
        currentBead: 4,
        completedBeads: 3,
        totalBeads: 10,
        percentComplete: 30,
        eta: { bestMs: 600000, likelyMs: 900000, worstMs: 1500000, basis: 'current' },
      },
    })

    renderWithProviders(<PhaseTimeline currentStatus="CODING" ticket={ticket} />)

    // Implementation group auto-expands for the active CODING phase; the bead count stays visible
    // beside the compact ETA chip.
    expect(screen.getByText('(4/10, 30%)')).toBeInTheDocument()
    expect(screen.getByText('~15m')).toBeInTheDocument()
  })

  it('does not render an ETA when the ticket has no estimate', () => {
    renderWithProviders(<PhaseTimeline currentStatus="CODING" />)
    expect(screen.queryByText('~15m')).not.toBeInTheDocument()
  })

  it('hides the error phase once a ticket is no longer actively blocked', () => {
    const onSelect = vi.fn()
    renderWithProviders(
      <PhaseTimeline
        currentStatus="CANCELED"
        previousStatus="BLOCKED_ERROR"
        reviewCutoffStatus="CODING"
        onSelectPhase={onSelect}
      />,
    )

    fireEvent.click(screen.getByText('Implementation'))
    fireEvent.click(screen.getByText('Post-Implementation'))

    const codingBtn = screen.getByText(/Implementing \(Bead \?\/\?\)/).closest('button')
    const finalTestBtn = screen.getByText('Testing Implementation').closest('button')

    expect(codingBtn).not.toBeDisabled()
    expect(finalTestBtn).toBeDisabled()
    expect(screen.queryByText('Error (reason)')).not.toBeInTheDocument()

    fireEvent.click(codingBtn!)
    expect(onSelect).toHaveBeenCalledWith('CODING')
  })

  it('keeps ordinary canceled tickets reviewable through their last working phase', () => {
    renderWithProviders(
      <PhaseTimeline
        currentStatus="CANCELED"
        previousStatus="CODING"
        reviewCutoffStatus="CODING"
      />,
    )

    fireEvent.click(screen.getByText('Implementation'))
    fireEvent.click(screen.getByText('Post-Implementation'))

    expect(screen.getByText(/Implementing \(Bead \?\/\?\)/).closest('button')).not.toBeDisabled()
    expect(screen.getByText('Testing Implementation').closest('button')).toBeDisabled()
  })

  it('does not render any spinning indicators for canceled tickets', () => {
    const { container } = renderWithProviders(
      <PhaseTimeline
        currentStatus="CANCELED"
        previousStatus="CODING"
        reviewCutoffStatus="CODING"
      />,
    )

    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('uses static indicators for current needs-input phases', () => {
    const needsInputStatuses = [
      'WAITING_INTERVIEW_ANSWERS',
      'WAITING_INTERVIEW_APPROVAL',
      'WAITING_PRD_APPROVAL',
      'WAITING_BEADS_APPROVAL',
      'WAITING_EXECUTION_SETUP_APPROVAL',
      'WAITING_PR_REVIEW',
    ]

    for (const status of needsInputStatuses) {
      const { container, unmount } = renderWithProviders(<PhaseTimeline currentStatus={status} />)
      expect(container.querySelector('.animate-spin')).toBeNull()
      unmount()
    }
  })

  it('keeps spinning indicators for actively running phases', () => {
    const { container } = renderWithProviders(<PhaseTimeline currentStatus="CODING" />)

    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  it('preserves live BLOCKED_ERROR phase review behavior', () => {
    const onSelect = vi.fn()
    renderWithProviders(
      <PhaseTimeline
        currentStatus="BLOCKED_ERROR"
        previousStatus="CODING"
        reviewCutoffStatus="CODING"
        onSelectPhase={onSelect}
      />,
    )

    // The previous implementation group and the live Errors group both auto-expand.
    const codingBtn = screen.getByText(/Implementing \(Bead \?\/\?\)/).closest('button')
    fireEvent.click(screen.getByText('Post-Implementation'))
    const finalTestBtn = screen.getByText('Testing Implementation').closest('button')
    const blockedErrorBtn = screen.getByText('Error (reason)').closest('button')

    expect(codingBtn).not.toBeDisabled()
    expect(finalTestBtn).toBeDisabled()
    expect(blockedErrorBtn).not.toBeDisabled()

    fireEvent.click(codingBtn!)
    expect(onSelect).toHaveBeenCalledWith('CODING')
  })

  it('shows the running phase as waiting while a model has a question open', () => {
    const ticket = makeTicket({
      status: 'CODING',
      pendingQuestions: { requestCount: 1, questionCount: 2, deadlineAt: null, stoppedAt: null },
    })
    renderWithProviders(<PhaseTimeline currentStatus="CODING" ticket={ticket} />)

    expect(screen.getByText('Implementation').closest('button')).toHaveClass('text-amber-600')
  })

  it('shows the running phase as active when nothing is waiting on you', () => {
    renderWithProviders(<PhaseTimeline currentStatus="CODING" ticket={makeTicket({ status: 'CODING' })} />)

    expect(screen.getByText('Implementation').closest('button')).toHaveClass('text-primary')
  })

  it('renders footer content after the final phase group', () => {
    renderWithProviders(
      <PhaseTimeline
        currentStatus="DRAFT"
        footer={<div>Timeline footer</div>}
      />,
    )

    const doneButton = screen.getByText('Done').closest('button')
    const footer = screen.getByText('Timeline footer')

    expect(doneButton).not.toBeNull()
    expect(doneButton!.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
