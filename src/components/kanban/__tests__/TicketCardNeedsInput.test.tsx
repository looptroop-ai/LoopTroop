import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import { UIProvider } from '@/context/UIContext'
import { AIQuestionContext, type AIQuestionContextValue } from '@/context/aiQuestionContextDef'
import { TicketCard } from '../TicketCard'
import { renderWithProviders } from '@/test/renderHelpers'
import { TEST, makeTicket } from '@/test/factories'
import type { Ticket } from '@/hooks/useTickets'
import { clearNeedsInputSeen, getNeedsInputSignature } from '@/lib/needsInputSeen'

const projectColor = '#2563eb'

function renderCard(ticket: Ticket, aiQuestions: AIQuestionContextValue = { getPendingCount: () => 0, openQueue: () => undefined }) {
  return renderWithProviders(
    <AIQuestionContext.Provider value={aiQuestions}>
      <UIProvider>
        <TicketCard
          ticket={ticket}
          projectColor={projectColor}
          projectIcon="T"
          projectName="TestProject"
        />
      </UIProvider>
    </AIQuestionContext.Provider>,
  )
}

function cardFor(ticket: Ticket) {
  return screen.getByLabelText(`Open ticket ${ticket.externalId}`) as HTMLElement
}

describe('TicketCard — ack-aware yellow Needs Input flashing', () => {
  beforeEach(() => {
    clearNeedsInputSeen('1:TEST-1')
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('flashes yellow for an unseen WAITING_PRD_APPROVAL ticket', () => {
    const ticket = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'WAITING_PRD_APPROVAL',
      updatedAt: TEST.timestamp,
      needsInputSeenSignature: null,
    })
    renderCard(ticket)
    const card = cardFor(ticket)
    expect(card.innerHTML).toContain('lt-needs-input-pulse')
    expect(card.innerHTML).toContain('border-amber-500/90')
  })

  it('reverts to the static project color once the wait has been acknowledged', () => {
    const ticket = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'WAITING_PRD_APPROVAL',
      updatedAt: TEST.timestamp,
    })
    const sig = getNeedsInputSignature(ticket)!
    // Server-persisted acknowledgment matches the current wait signature.
    renderCard(makeTicket({ ...ticket, needsInputSeenSignature: sig }))
    const card = cardFor(ticket)
    expect(card.innerHTML).not.toContain('lt-needs-input-pulse')
    expect(card.innerHTML).not.toContain('border-amber-500/90')
  })

  it('keeps red flashing for BLOCKED_ERROR and does not also show yellow', () => {
    const ticket = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'BLOCKED_ERROR',
      updatedAt: TEST.timestamp,
      errorMessage: 'boom',
      errorSeenSignature: null,
    })
    renderCard(ticket)
    const card = cardFor(ticket)
    expect(card.innerHTML).toContain('lt-error-pulse')
    expect(card.innerHTML).not.toContain('lt-needs-input-pulse')
  })

  it('does not flash yellow for non-needs-input statuses (e.g. DRAFT)', () => {
    const ticket = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'DRAFT',
      updatedAt: TEST.timestamp,
    })
    renderCard(ticket)
    const card = cardFor(ticket)
    expect(card.innerHTML).not.toContain('lt-needs-input-pulse')
  })

  it('supersedes the pending-question project-color pulse for needs_input tickets', () => {
    const ticket = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'WAITING_INTERVIEW_ANSWERS',
      updatedAt: TEST.timestamp,
      needsInputSeenSignature: null,
    })
    // Pending AI questions exist, but the card is in needs_input → yellow wins.
    renderCard(ticket, { getPendingCount: () => 3, openQueue: () => undefined })
    const card = cardFor(ticket)
    expect(card.innerHTML).toContain('lt-needs-input-pulse')
    // The project-color pending-question pulse is suppressed in needs_input.
    expect(card.className).not.toContain('bg-primary/5')
  })

  it('still shows the project-color pending-question pulse outside needs_input', () => {
    const ticket = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'CODING',
      updatedAt: TEST.timestamp,
    })
    renderCard(ticket, { getPendingCount: () => 3, openQueue: () => undefined })
    const card = cardFor(ticket)
    expect(card.innerHTML).not.toContain('lt-needs-input-pulse')
  })


  it('re-flashes when the wait reason changes after a prior acknowledgment', () => {
    const first = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'WAITING_PRD_APPROVAL',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    // Acknowledge the first wait.
    const firstSig = getNeedsInputSignature(first)!
    clearNeedsInputSeen(first.id)
    localStorage.setItem(`needs-input-seen-${first.id}`, firstSig)

    // Ticket advances to a new wait (beads approval) with a fresh updatedAt.
    const second = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'WAITING_BEADS_APPROVAL',
      updatedAt: '2026-01-02T00:00:00.000Z',
      needsInputSeenSignature: null,
    })
    renderCard(second)
    const card = cardFor(second)
    expect(card.innerHTML).toContain('lt-needs-input-pulse')
  })
})
