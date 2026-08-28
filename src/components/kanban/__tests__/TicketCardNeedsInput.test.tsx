import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import { UIProvider } from '@/context/UIContext'
import { AIQuestionContext, type AIQuestionContextValue } from '@/context/aiQuestionContextDef'
import { TicketCard } from '../TicketCard'
import { renderWithProviders } from '@/test/renderHelpers'
import { createAiQuestionContextStub } from '@/test/aiQuestionContext'
import { TEST, makeTicket } from '@/test/factories'
import type { Ticket } from '@/hooks/useTickets'
import { clearNeedsInputSeen, getNeedsInputSignature } from '@/lib/needsInputSeen'

const projectColor = '#2563eb'

function pendingQuestions(requestCount: number, questionCount: number): Ticket['pendingQuestions'] {
  return { requestCount, questionCount, deadlineAt: null, stoppedAt: null }
}

function renderCard(ticket: Ticket, aiQuestions: AIQuestionContextValue = createAiQuestionContextStub()) {
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
  // The label carries a trailing clause naming the wait, so match its start.
  return screen.getByLabelText(new RegExp(`^Open ticket ${ticket.externalId}(,|$)`)) as HTMLElement
}

describe('TicketCard — ack-aware Needs Input flashing', () => {
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

  it('flashes sky for a pending question on a ticket that is still working', () => {
    const ticket = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'CODING',
      updatedAt: TEST.timestamp,
      needsInputSeenSignature: null,
      pendingQuestions: pendingQuestions(2, 4),
    })
    renderCard(ticket)
    const card = cardFor(ticket)
    expect(card.innerHTML).toContain('lt-question-pulse')
    expect(card.innerHTML).toContain('border-sky-500/90')
    // A question is not a failure and not an approval.
    expect(card.innerHTML).not.toContain('lt-error-pulse')
    expect(card.innerHTML).not.toContain('lt-needs-input-pulse')
  })

  it('counts questions rather than models on the card badge', () => {
    const ticket = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'CODING',
      updatedAt: TEST.timestamp,
      // Three models asking two things each.
      pendingQuestions: pendingQuestions(3, 6),
    })
    renderCard(ticket)
    expect(screen.getByText('AI question 6')).toBeInTheDocument()
  })

  it('lets amber win over sky when the status itself is the wait', () => {
    const ticket = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'WAITING_INTERVIEW_ANSWERS',
      updatedAt: TEST.timestamp,
      needsInputSeenSignature: null,
      pendingQuestions: pendingQuestions(1, 3),
    })
    renderCard(ticket)
    const card = cardFor(ticket)
    expect(card.innerHTML).toContain('lt-needs-input-pulse')
    expect(card.innerHTML).not.toContain('lt-question-pulse')
  })

  it('lets red win over sky when a blocked ticket also has a question open', () => {
    const ticket = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'BLOCKED_ERROR',
      updatedAt: TEST.timestamp,
      errorMessage: 'boom',
      errorSeenSignature: null,
      pendingQuestions: pendingQuestions(1, 1),
    })
    renderCard(ticket)
    const card = cardFor(ticket)
    expect(card.innerHTML).toContain('lt-error-pulse')
    expect(card.innerHTML).not.toContain('lt-question-pulse')
    expect(card.innerHTML).not.toContain('lt-needs-input-pulse')
  })

  it('keeps the pulse off until the polled ticket confirms the question', () => {
    const ticket = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'CODING',
      updatedAt: TEST.timestamp,
    })
    // The live feed is ahead of the ticket list, and the card must not disagree
    // with the column it sits in — which can only see the polled ticket.
    renderCard(ticket, createAiQuestionContextStub({ getPendingCount: () => 3 }))
    const card = cardFor(ticket)
    expect(card.innerHTML).not.toContain('lt-question-pulse')
    expect(card.innerHTML).not.toContain('lt-needs-input-pulse')
    expect(screen.getByText('AI question 3')).toBeInTheDocument()
  })

  it('names the kind of wait in the card label', () => {
    const question = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'CODING',
      updatedAt: TEST.timestamp,
      pendingQuestions: pendingQuestions(2, 4),
    })
    renderCard(question)
    expect(screen.getByLabelText('Open ticket TEST-1, 4 questions waiting for your answer')).toBeInTheDocument()
    cleanup()

    const approval = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'WAITING_PRD_APPROVAL',
      updatedAt: TEST.timestamp,
    })
    renderCard(approval)
    expect(screen.getByLabelText('Open ticket TEST-1, waiting for your input')).toBeInTheDocument()
  })

  it('says "1 question" rather than "1 questions"', () => {
    const ticket = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'CODING',
      updatedAt: TEST.timestamp,
      pendingQuestions: pendingQuestions(1, 1),
    })
    renderCard(ticket)
    expect(screen.getByLabelText('Open ticket TEST-1, 1 question waiting for your answer')).toBeInTheDocument()
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

  it('re-flashes when an acknowledged interview wait turns into an AI question', () => {
    const waiting = makeTicket({
      id: '1:TEST-1',
      externalId: TEST.externalId,
      status: 'WAITING_INTERVIEW_ANSWERS',
      updatedAt: TEST.timestamp,
    })
    const waitingSig = getNeedsInputSignature(waiting)!
    clearNeedsInputSeen(waiting.id)
    localStorage.setItem(`needs-input-seen-${waiting.id}`, waitingSig)

    // Same status, same updatedAt — only the blocker's kind changed.
    const asked = makeTicket({ ...waiting, pendingQuestions: pendingQuestions(1, 2) })
    renderCard(asked)
    const card = cardFor(asked)
    expect(card.innerHTML).toContain('lt-needs-input-pulse')
  })
})
