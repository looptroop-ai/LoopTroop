import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AIQuestionContext } from '@/context/aiQuestionContextDef'
import type { AiQuestionRequest } from '@/context/aiQuestionContextDef'
import type { AiQuestionTimerState } from '@shared/aiQuestions'
import { createAiQuestionContextStub } from '@/test/aiQuestionContext'
import { PendingQuestionsPanel } from '../PendingQuestionsPanel'

const TICKET_ID = 'proj-1:LOOP-1'

function makeRequest(overrides: Partial<AiQuestionRequest> = {}): AiQuestionRequest {
  return {
    ticketId: TICKET_ID,
    ticketExternalId: 'LOOP-1',
    ticketTitle: 'A ticket',
    status: 'CODING',
    phase: 'CODING',
    modelId: 'anthropic/claude-opus-4',
    sessionId: 'ses_a',
    requestId: 'req_a',
    questions: [{
      header: 'Storage',
      question: 'Which database should I use?',
      options: [
        { label: 'SQLite', description: 'One local file' },
        { label: 'Postgres', description: 'A server' },
      ],
      custom: true,
    }],
    receivedAt: '2026-01-01T00:00:00.000Z',
    submitting: false,
    ...overrides,
  }
}

function makeTimer(overrides: Partial<AiQuestionTimerState> = {}): AiQuestionTimerState {
  return {
    timerKey: 'CODING:1',
    generation: 1,
    windowMs: 300_000,
    armedAt: '2026-01-01T00:00:00.000Z',
    deadlineAt: '2026-01-01T00:05:00.000Z',
    stoppedAt: null,
    stoppedBy: null,
    resetCount: 0,
    revision: 1,
    serverNow: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function renderPanel(overrides: Parameters<typeof createAiQuestionContextStub>[0] = {}) {
  const value = createAiQuestionContextStub(overrides)
  render(
    <AIQuestionContext.Provider value={value}>
      <PendingQuestionsPanel ticketId={TICKET_ID} />
    </AIQuestionContext.Provider>,
  )
  return value
}

describe('PendingQuestionsPanel', () => {
  it('renders nothing when no model is asking', () => {
    const { container } = render(
      <AIQuestionContext.Provider value={createAiQuestionContextStub()}>
        <PendingQuestionsPanel ticketId={TICKET_ID} />
      </AIQuestionContext.Provider>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('names the model in the title when only one is asking', () => {
    renderPanel({
      getTicketRequests: () => [makeRequest()],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
    })
    // One model asking is its name, not a tab strip of one.
    expect(screen.getByText('claude-opus-4')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.getByText('4:00')).toBeInTheDocument()
  })

  it('gives each model a tab and shows the countdown once', () => {
    renderPanel({
      getTicketRequests: () => [
        makeRequest(),
        makeRequest({ sessionId: 'ses_b', requestId: 'req_b', modelId: 'openai/gpt-5' }),
      ],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 120_000,
    })
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    // One clock for the step, so exactly one countdown on screen.
    expect(screen.getAllByText('2:00')).toHaveLength(1)
  })

  it('disambiguates two tabs for the same model', () => {
    renderPanel({
      getTicketRequests: () => [
        makeRequest({ requestId: 'req_aaaa1111' }),
        makeRequest({ sessionId: 'ses_b', requestId: 'req_bbbb2222' }),
      ],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 60_000,
    })
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent ?? '')
    expect(tabs[0]).toContain('1111')
    expect(tabs[1]).toContain('2222')
  })

  it('stops the clock on any engagement, not just the button', () => {
    const stopTimer = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest()],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
      stopTimer,
    })

    fireEvent.focus(screen.getByRole('textbox'))
    expect(stopTimer).toHaveBeenCalledWith(TICKET_ID)

    stopTimer.mockClear()
    fireEvent.click(screen.getByLabelText('SQLite'))
    expect(stopTimer).toHaveBeenCalledWith(TICKET_ID)
  })

  it('says it is waiting for you once the clock is stopped', () => {
    renderPanel({
      getTicketRequests: () => [makeRequest()],
      getTimer: () => makeTimer({ stoppedAt: '2026-01-01T00:01:00.000Z', stoppedBy: 'user' }),
      getRemainingMs: () => null,
    })
    expect(screen.getByText('Waiting for you')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /stop timer/i })).not.toBeInTheDocument()
    expect(screen.getByText(/waits until you answer or skip/i)).toBeInTheDocument()
  })

  it('submits the selected option together with the free text', () => {
    const answerRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest()],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
      answerRequest,
    })

    fireEvent.click(screen.getByLabelText('SQLite'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'in ./data' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))

    // Free text adds to the selection rather than replacing it.
    expect(answerRequest).toHaveBeenCalledWith(TICKET_ID, 'req_a', [['SQLite', 'in ./data']])
  })

  it('will not send until every question in the batch has an answer', () => {
    const answerRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest({
        questions: [
          { header: 'One', question: 'First?', options: [{ label: 'Yes' }] },
          { header: 'Two', question: 'Second?', options: [{ label: 'No' }] },
        ],
      })],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
      answerRequest,
    })

    expect(screen.getByRole('button', { name: 'Send all answers' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Yes'))
    // OpenCode takes every answer in one payload, so a half-filled batch is not
    // sendable — the other question would arrive empty.
    expect(screen.getByRole('button', { name: 'Send all answers' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByLabelText('No'))
    expect(screen.getByRole('button', { name: 'Send all answers' })).toBeEnabled()
  })

  it('asks for a reason before skipping', () => {
    const skipRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest()],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
      skipRequest,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.change(screen.getByLabelText(/skip reason/i), { target: { value: 'Not my call.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Skip this question' }))

    expect(skipRequest).toHaveBeenCalledWith(TICKET_ID, 'req_a', 'Not my call.')
  })

  it('renders the model’s text as plain text', () => {
    renderPanel({
      getTicketRequests: () => [makeRequest({
        questions: [{ header: 'H', question: '<img src=x onerror=alert(1)>', options: [] }],
      })],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
    })
    // The model authors this string; it is never markdown and never innerHTML.
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })

  it('lets a multi-word answer be typed, spaces and all', () => {
    const answerRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest({
        questions: [{ header: 'Port', question: 'Which port?', options: [], custom: true }],
      })],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
      answerRequest,
    })

    const field = screen.getByRole('textbox')
    // Typed a word at a time, the way a person does. The value was previously
    // round-tripped through a trim on every keystroke, so the space was deleted
    // the instant it was typed and the next word ran into the last one.
    fireEvent.change(field, { target: { value: 'use ' } })
    expect(field).toHaveValue('use ')
    fireEvent.change(field, { target: { value: 'use the ' } })
    fireEvent.change(field, { target: { value: 'use the default port' } })
    expect(field).toHaveValue('use the default port')

    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(answerRequest).toHaveBeenCalledWith(TICKET_ID, 'req_a', [['use the default port']])
  })

  it('keeps free text that happens to match an option label', () => {
    const answerRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest()],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
      answerRequest,
    })

    fireEvent.click(screen.getByRole('radio', { name: /SQLite/ }))
    // Deriving the free text as "whatever is not an option label" classified
    // this as a selection and dropped it out of the box as you typed.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Postgres' } })
    expect(screen.getByRole('textbox')).toHaveValue('Postgres')

    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(answerRequest).toHaveBeenCalledWith(TICKET_ID, 'req_a', [['SQLite', 'Postgres']])
  })

  it('does not read the countdown out once a second', () => {
    renderPanel({
      getTicketRequests: () => [makeRequest()],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
    })

    // The number changes every second. Inside a live region a screen reader
    // announces every tick, which buries everything else the panel says.
    const countdown = screen.getByText('4:00')
    expect(countdown.closest('[aria-live]')).toBeNull()
    // What *is* announced is the state, which changes only when it changes.
    expect(screen.getByRole('status')).toHaveTextContent(/the question is refused/i)
  })
})
