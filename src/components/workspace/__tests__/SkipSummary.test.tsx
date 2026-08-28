import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { countSkipEvents, type SkipEvent, type SkipQuestionContext } from '@shared/skipReceipt'
import type { TicketSkips } from '@/hooks/useTicketSkips'
import { SkipSummary } from '../SkipSummary'

function makeEvent(overrides: Partial<SkipEvent> = {}): SkipEvent {
  return {
    receiptId: 'skip-0001',
    actionId: 'action-1',
    parentActionId: null,
    surface: 'interview_question',
    itemId: 'q1',
    itemType: 'interview_question',
    isActionSummary: false,
    resolves: false,
    phase: 'INTERVIEW',
    phaseAttempt: 1,
    ticketStatusBefore: 'INTERVIEW',
    truncatedForPrompt: false,
    skippedAt: '2026-08-28T10:00:00.000Z',
    skippedBy: 'user',
    reason: 'Not relevant to this ticket.',
    supersedes: null,
    superseded: false,
    ...overrides,
  }
}

function makeQuestionContext(overrides: Partial<SkipQuestionContext> = {}): SkipQuestionContext {
  return {
    request_id: 'req_a',
    session_id: 'ses_a',
    member_id: null,
    question_count: 2,
    window_ms: 300_000,
    armed_at: '2026-08-28T10:00:00.000Z',
    deadline_at: '2026-08-28T10:05:00.000Z',
    reset_count: 0,
    stopped_at: null,
    stopped_by: null,
    elapsed_wall_ms: 298_000,
    elapsed_active_ms: 298_000,
    sibling_request_ids: [],
    expiry_reason: 'window_elapsed',
    quorum_impact: null,
    ...overrides,
  }
}

function makeSkips(events: SkipEvent[]): TicketSkips {
  return { ticketId: 'TCK-1', events, counts: countSkipEvents(events) }
}

function renderSkips(events: SkipEvent[]) {
  return render(
    <SkipSummary
      skips={makeSkips(events)}
      isLoading={false}
      isError={false}
      isFetching={false}
      onRetry={vi.fn()}
    />,
  )
}

/** The row a piece of text sits on, so assertions can stay row-local. */
function rowContaining(text: string): HTMLElement {
  const node = screen.getByText(text).closest('div[style]')
  if (!node) throw new Error(`No skip row found for: ${text}`)
  return node as HTMLElement
}

describe('SkipSummary actors', () => {
  it('reads a receipt written before the actor existed as a person', () => {
    // v1 receipts carry no `skipped_by` at all. A person was the only thing
    // that could skip then, so that is what the row means.
    const legacy: Partial<SkipEvent> = makeEvent({ reason: 'Skipped in the old world.' })
    delete legacy.skippedBy

    renderSkips([legacy as SkipEvent])

    const row = rowContaining('Skipped in the old world.')
    expect(within(row).getByText('You')).toBeInTheDocument()
    expect(row.querySelector('[data-actor="user"]')).not.toBeNull()
    expect(screen.queryByText(/unknown/i)).toBeNull()
  })

  it('says the wait ran out, and what the clock did, on a timed-out question', () => {
    renderSkips([
      makeEvent({
        receiptId: 'skip-q-sum',
        actionId: 'action-q',
        surface: 'opencode_question',
        itemType: 'opencode_question_request',
        itemId: null,
        isActionSummary: true,
        skippedBy: 'timeout',
        reason: null,
        questionContext: makeQuestionContext(),
      }),
    ])

    const row = rowContaining('AI question')
    expect(within(row).getByText('The wait ran out')).toBeInTheDocument()
    expect(row.querySelector('[data-actor="timeout"]')).not.toBeNull()
    expect(within(row).getByText(/5 minutes to answer/)).toHaveTextContent('waited 4m 58s')
    // A timeout is an outcome the operator configured, not a failure.
    expect(row.querySelector('.text-destructive')).toBeNull()
  })

  it('names who stopped the clock when someone did', () => {
    renderSkips([
      makeEvent({
        receiptId: 'skip-q-stopped',
        surface: 'opencode_question',
        itemType: 'opencode_question_request',
        itemId: null,
        isActionSummary: true,
        skippedBy: 'user',
        reason: 'Answered it myself instead.',
        questionContext: makeQuestionContext({
          stopped_at: '2026-08-28T10:01:00.000Z',
          stopped_by: 'user',
          elapsed_wall_ms: 90_000,
          elapsed_active_ms: 60_000,
          expiry_reason: 'user_skipped',
        }),
      }),
    ])

    const row = rowContaining('AI question')
    expect(within(row).getByText(/you stopped the clock/)).toHaveTextContent('waited 1m 30s')
  })

  it('files a refusal LoopTroop made under LoopTroop', () => {
    renderSkips([
      makeEvent({
        receiptId: 'skip-q-system',
        surface: 'opencode_question',
        itemType: 'opencode_question_request',
        itemId: null,
        isActionSummary: true,
        skippedBy: 'system',
        reason: 'The daemon restarted and could not re-attach the request.',
        questionContext: makeQuestionContext({ expiry_reason: 'daemon_restart' }),
      }),
    ])

    const row = rowContaining('AI question')
    expect(within(row).getByText('LoopTroop')).toBeInTheDocument()
    expect(row.querySelector('[data-actor="system"]')).not.toBeNull()
  })

  it('keeps one summary row over N children, and states the clock once', () => {
    const context = makeQuestionContext()
    renderSkips([
      makeEvent({
        receiptId: 'skip-q-sum',
        actionId: 'action-q',
        surface: 'opencode_question',
        itemType: 'opencode_question_request',
        itemId: null,
        isActionSummary: true,
        skippedBy: 'timeout',
        reason: null,
        questionContext: context,
      }),
      makeEvent({
        receiptId: 'skip-q-0',
        actionId: 'action-q-0',
        parentActionId: 'action-q',
        surface: 'opencode_question',
        itemType: 'opencode_question',
        itemId: 'req_a:0',
        skippedBy: 'timeout',
        reason: null,
        questionContext: context,
      }),
      makeEvent({
        receiptId: 'skip-q-1',
        actionId: 'action-q-1',
        parentActionId: 'action-q',
        surface: 'opencode_question',
        itemType: 'opencode_question',
        itemId: 'req_a:1',
        skippedBy: 'timeout',
        reason: null,
        questionContext: context,
      }),
    ])

    // One action, two items — not three skips.
    expect(screen.getByText(/1 action/)).toHaveTextContent('2 items skipped')
    expect(screen.getByText('2 items')).toBeInTheDocument()
    expect(screen.getByText('req_a:0')).toBeInTheDocument()
    expect(screen.getByText('req_a:1')).toBeInTheDocument()
    // One clock covered the request, so it is stated once.
    expect(screen.getAllByText(/5 minutes to answer/)).toHaveLength(1)
    // Every row still says who decided.
    expect(screen.getAllByText('The wait ran out')).toHaveLength(3)
  })

  it('leaves non-question rows without a clock', () => {
    renderSkips([makeEvent({ reason: 'Out of scope.' })])

    expect(screen.queryByText(/to answer/)).toBeNull()
    expect(screen.getByText('You')).toBeInTheDocument()
  })
})
