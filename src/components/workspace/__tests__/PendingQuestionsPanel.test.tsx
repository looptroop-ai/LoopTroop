import { act, render, screen, fireEvent, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIQuestionContext } from '@/context/aiQuestionContextDef'
import type { AiQuestionRequest } from '@/context/aiQuestionContextDef'
import type { AiQuestionTimerState } from '@shared/aiQuestions'
import { createAiQuestionContextStub } from '@/test/aiQuestionContext'
import {
  clearTicketPersistentState,
  getTicketQuestionsCollapsedStorageKey,
  TICKET_STATE_CLEARED_EVENT,
} from '@/components/ticket/renderedTickets'
import { PendingQuestionsPanel } from '../PendingQuestionsPanel'

const TICKET_ID = 'proj-1:LOOP-1'

afterEach(() => {
  localStorage.clear()
})

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
  const view = render(
    <AIQuestionContext.Provider value={value}>
      <PendingQuestionsPanel ticketId={TICKET_ID} />
    </AIQuestionContext.Provider>,
  )
  return { update: () => view.rerender(
    <AIQuestionContext.Provider value={value}>
      <PendingQuestionsPanel ticketId={TICKET_ID} />
    </AIQuestionContext.Provider>,
  ) }
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

  it('keeps answer and skip actions outside the scrolling question body', () => {
    renderPanel({ getTicketRequests: () => [makeRequest()] })
    const actions = screen.getByRole('group', { name: 'Question actions' })
    const body = document.getElementById('pending-questions-body')

    expect(within(actions).getByRole('button', { name: 'Skip' })).toBeInTheDocument()
    expect(within(actions).getByRole('button', { name: 'Send answer' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Skip all' })).not.toBeInTheDocument()
    expect(body).toBeInTheDocument()
    expect(body).not.toContainElement(actions)

    fireEvent.click(within(actions).getByRole('button', { name: 'Skip' }))
    expect(within(actions).getByRole('button', { name: 'Back' })).toBeInTheDocument()
    expect(within(actions).getByRole('button', { name: 'Skip this question' })).toBeInTheDocument()
    expect(body).not.toContainElement(actions)

    fireEvent.click(screen.getByRole('button', { name: /claude-opus-4/i }))
    expect(screen.queryByRole('group', { name: 'Question actions' })).not.toBeInTheDocument()
  })

  it('skips every pending request across model tabs with the same optional reason', () => {
    const skipRequest = vi.fn()
    const stopTimer = vi.fn()
    renderPanel({
      getTicketRequests: () => [
        makeRequest(),
        makeRequest({
          sessionId: 'ses_b',
          requestId: 'req_b',
          modelId: 'openai/gpt-5',
          questions: [
            { header: 'One', question: 'First?', options: [] },
            { header: 'Two', question: 'Second?', options: [] },
          ],
        }),
      ],
      skipRequest,
      stopTimer,
    })

    expect(screen.getByText('3 waiting')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }))
    expect(stopTimer).toHaveBeenCalledWith(TICKET_ID)
    expect(skipRequest).not.toHaveBeenCalled()
    expect(screen.getByText(/all 3 pending questions in 2 requests/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/skip reason/i), { target: { value: '  Use your judgment.  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Skip all 3 questions' }))

    expect(skipRequest).toHaveBeenCalledTimes(2)
    expect(skipRequest).toHaveBeenNthCalledWith(1, TICKET_ID, 'req_a', 'Use your judgment.')
    expect(skipRequest).toHaveBeenNthCalledWith(2, TICKET_ID, 'req_b', 'Use your judgment.')
  })

  it('offers Skip all for a single multi-question request and rejects it only once', () => {
    const skipRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest({
        questions: [
          { header: 'One', question: 'First?', options: [] },
          { header: 'Two', question: 'Second?', options: [] },
        ],
      })],
      skipRequest,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Skip all 2 questions' }))

    expect(skipRequest).toHaveBeenCalledExactlyOnceWith(TICKET_ID, 'req_a', null)
  })

  it('keeps ordinary Skip scoped to the selected request', () => {
    const skipRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest(), makeRequest({ sessionId: 'ses_b', requestId: 'req_b' })],
      skipRequest,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.click(screen.getByRole('button', { name: 'Skip this question' }))

    expect(skipRequest).toHaveBeenCalledExactlyOnceWith(TICKET_ID, 'req_a', null)
  })

  it('disables Skip all while another request is submitting', () => {
    renderPanel({
      getTicketRequests: () => [
        makeRequest(),
        makeRequest({ sessionId: 'ses_b', requestId: 'req_b', submitting: true }),
      ],
    })

    expect(screen.getByRole('button', { name: 'Skip all' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled()
    expect(screen.getByRole('textbox')).toBeEnabled()
  })

  it('clears a request-specific skip draft when its request resolves elsewhere', () => {
    let requests = [makeRequest(), makeRequest({ sessionId: 'ses_b', requestId: 'req_b' })]
    const skipRequest = vi.fn()
    const view = renderPanel({ getTicketRequests: () => requests, skipRequest })
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.change(screen.getByLabelText(/skip reason/i), { target: { value: 'Only for request A' } })

    requests = requests.slice(1)
    view.update()

    expect(screen.queryByLabelText(/skip reason/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(screen.getByLabelText(/skip reason/i)).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Skip this question' }))
    expect(skipRequest).toHaveBeenCalledExactlyOnceWith(TICKET_ID, 'req_b', null)
  })

  it('starts a later batch without the previous bulk confirmation or reason', () => {
    let requests = [makeRequest(), makeRequest({ sessionId: 'ses_b', requestId: 'req_b' })]
    const view = renderPanel({ getTicketRequests: () => requests })
    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }))
    fireEvent.change(screen.getByLabelText(/skip reason/i), { target: { value: 'For this batch only' } })

    requests = []
    view.update()
    expect(screen.queryByRole('region', { name: 'AI questions' })).not.toBeInTheDocument()
    requests = [makeRequest({ sessionId: 'ses_c', requestId: 'req_c' })]
    view.update()

    expect(screen.queryByLabelText(/skip reason/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument()
  })

  it('keeps the bulk reason while checking another model tab', () => {
    const skipRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest(), makeRequest({
        sessionId: 'ses_b', requestId: 'req_b', modelId: 'openai/gpt-5',
      })],
      skipRequest,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }))
    fireEvent.change(screen.getByLabelText(/skip reason/i), { target: { value: 'Shared reason' } })
    fireEvent.click(screen.getByRole('tab', { name: /gpt-5/i }))

    expect(screen.getByLabelText(/skip reason/i)).toHaveValue('Shared reason')
    fireEvent.click(screen.getByRole('button', { name: 'Skip all 2 questions' }))
    expect(skipRequest).toHaveBeenCalledTimes(2)
    expect(skipRequest).toHaveBeenNthCalledWith(1, TICKET_ID, 'req_a', 'Shared reason')
    expect(skipRequest).toHaveBeenNthCalledWith(2, TICKET_ID, 'req_b', 'Shared reason')
  })

  it('includes questions that arrive before bulk confirmation and clears the completed draft', () => {
    const first = makeRequest()
    const second = makeRequest({ sessionId: 'ses_b', requestId: 'req_b' })
    const later = makeRequest({ sessionId: 'ses_c', requestId: 'req_c' })
    let requests = [first, second]
    const skipRequest = vi.fn()
    const view = renderPanel({ getTicketRequests: () => requests, skipRequest })
    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }))
    fireEvent.change(screen.getByLabelText(/skip reason/i), { target: { value: '   ' } })

    requests = [first, second, later]
    view.update()
    fireEvent.click(screen.getByRole('button', { name: 'Skip all 3 questions' }))
    expect(skipRequest.mock.calls).toEqual([
      [TICKET_ID, 'req_a', null], [TICKET_ID, 'req_b', null], [TICKET_ID, 'req_c', null],
    ])

    requests = [{ ...later, error: 'Later request failed' }]
    view.update()
    expect(screen.getByRole('button', { name: 'Skip all 1 question' })).toBeEnabled()
    expect(screen.getByLabelText(/skip reason/i)).toHaveValue('   ')

    // A new request after confirmation must not inherit the finished draft.
    requests = [makeRequest({ sessionId: 'ses_d', requestId: 'req_d' })]
    view.update()
    expect(screen.queryByLabelText(/skip reason/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument()
  })

  it('shows every bulk failure and keeps the shared reason for retry across tabs', () => {
    const first = makeRequest()
    const second = makeRequest({ sessionId: 'ses_b', requestId: 'req_b', modelId: 'openai/gpt-5' })
    const third = makeRequest({ sessionId: 'ses_c', requestId: 'req_c', modelId: 'google/gemini-2' })
    let requests = [first, second, third]
    const skipRequest = vi.fn()
    const view = renderPanel({ getTicketRequests: () => requests, skipRequest })
    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }))
    fireEvent.change(screen.getByLabelText(/skip reason/i), { target: { value: 'Shared reason' } })
    fireEvent.click(screen.getByRole('button', { name: 'Skip all 3 questions' }))

    requests = [{ ...second, error: 'Second failed' }, { ...third, error: 'Third failed' }]
    view.update()
    const failures = screen.getByRole('alert')
    expect(failures).toHaveTextContent('2 requests failed to skip')
    expect(failures).toHaveTextContent('gpt-5: Second failed')
    expect(failures).toHaveTextContent('gemini-2: Third failed')
    fireEvent.click(screen.getByRole('tab', { name: /gemini-2/i }))
    expect(screen.getByLabelText(/skip reason/i)).toHaveValue('Shared reason')
    fireEvent.click(screen.getByRole('button', { name: 'Skip all 2 questions' }))
    expect(skipRequest.mock.calls.slice(3)).toEqual([
      [TICKET_ID, 'req_b', 'Shared reason'], [TICKET_ID, 'req_c', 'Shared reason'],
    ])
  })

  it('disables bulk confirmation and shortcuts for a submission that starts on another tab', () => {
    const first = makeRequest()
    const second = makeRequest({ sessionId: 'ses_b', requestId: 'req_b' })
    let requests = [first, second]
    const skipRequest = vi.fn()
    const view = renderPanel({ getTicketRequests: () => requests, skipRequest })
    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }))
    requests = [first, { ...second, submitting: true }]
    view.update()

    expect(screen.getByRole('button', { name: 'Skip all 2 questions' })).toBeDisabled()
    expect(screen.getByLabelText(/skip reason/i)).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    fireEvent.keyDown(screen.getByLabelText(/skip reason/i), { key: 'Enter', ctrlKey: true })
    expect(skipRequest).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled()
  })

  it('names the selected batch when confirming ordinary Skip and warns bulk council skips about quorum', () => {
    const skipRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest({ phase: 'DRAFTING_PRD', questions: [
        { header: 'One', question: 'First?', options: [] },
        { header: 'Two', question: 'Second?', options: [] },
      ] }), makeRequest({ sessionId: 'ses_b', requestId: 'req_b', phase: 'DRAFTING_PRD' })],
      skipRequest,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.click(screen.getByRole('button', { name: 'Skip this request (2 questions)' }))
    expect(skipRequest).toHaveBeenCalledExactlyOnceWith(TICKET_ID, 'req_a', null)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }))
    expect(screen.getByText(/below quorum and block the ticket/)).toBeInTheDocument()
  })

  it('clears a cancelled reason before opening a different skip scope', () => {
    renderPanel({
      getTicketRequests: () => [makeRequest(), makeRequest({ sessionId: 'ses_b', requestId: 'req_b' })],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }))
    fireEvent.change(screen.getByLabelText(/skip reason/i), { target: { value: 'Bulk reason' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Skip' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

    expect(screen.getByLabelText(/skip reason/i)).toHaveValue('')
  })

  it('submits answers and confirms skips from their textareas with Ctrl or Cmd+Enter', () => {
    const answerRequest = vi.fn()
    const skipRequest = vi.fn()
    renderPanel({ getTicketRequests: () => [makeRequest()], answerRequest, skipRequest })
    const answer = screen.getByRole('textbox')
    fireEvent.keyDown(answer, { key: 'Enter', ctrlKey: true })
    expect(answerRequest).not.toHaveBeenCalled()
    fireEvent.change(answer, { target: { value: 'Use the default' } })
    fireEvent.keyDown(answer, { key: 'Enter' })
    expect(answerRequest).not.toHaveBeenCalled()
    fireEvent.keyDown(answer, { key: 'Enter', ctrlKey: true })
    expect(answerRequest).toHaveBeenCalledExactlyOnceWith(TICKET_ID, 'req_a', [['Use the default']])

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(answer).toBeDisabled()
    const reason = screen.getByLabelText(/skip reason/i)
    fireEvent.change(reason, { target: { value: 'Let the model decide' } })
    fireEvent.keyDown(reason, { key: 'Enter', metaKey: true })
    expect(skipRequest).toHaveBeenCalledExactlyOnceWith(TICKET_ID, 'req_a', 'Let the model decide')
  })

  it('clears a skip confirmation when collapsing and removes unmounted ARIA references', () => {
    renderPanel({
      getTicketRequests: () => [makeRequest(), makeRequest({ sessionId: 'ses_b', requestId: 'req_b' })],
    })
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveAttribute('aria-controls', 'question-panel-req_a')
    expect(tabs[1]).not.toHaveAttribute('aria-controls')
    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }))
    fireEvent.change(screen.getByLabelText(/skip reason/i), { target: { value: 'Old reason' } })
    const toggle = screen.getByRole('button', { name: 'AI questions' })
    fireEvent.click(toggle)
    expect(toggle).not.toHaveAttribute('aria-controls')
    fireEvent.click(toggle)
    expect(screen.queryByLabelText(/skip reason/i)).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-controls', 'pending-questions-body')
  })

  it('does not let a double-click on Skip all confirm the rejection', () => {
    const skipRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest(), makeRequest({ sessionId: 'ses_b', requestId: 'req_b' })],
      skipRequest,
    })
    const trigger = screen.getByRole('button', { name: 'Skip all' })
    fireEvent.click(trigger, { detail: 1 })
    fireEvent.click(trigger, { detail: 2 })
    expect(skipRequest).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Skip all 2 questions' })).not.toBe(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Skip all 2 questions' }), { detail: 1 })
    expect(skipRequest).toHaveBeenCalledTimes(2)
  })

  it('sends the selected model batch while leaving other model requests alone', () => {
    const answerRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest({ questions: [
        { header: 'One', question: 'First?', options: [{ label: 'Yes' }] },
        { header: 'Two', question: 'Second?', options: [{ label: 'No' }] },
      ] }), makeRequest({ sessionId: 'ses_b', requestId: 'req_b' })],
      answerRequest,
    })
    fireEvent.click(screen.getByLabelText('Yes'))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByLabelText('No'))
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }))
    expect(answerRequest).toHaveBeenCalledExactlyOnceWith(TICKET_ID, 'req_a', [['Yes'], ['No']])
  })

  it('reloads pending questions when the panel mounts after a reconnect', () => {
    const refreshTicket = vi.fn()
    renderPanel({ refreshTicket })

    expect(refreshTicket).toHaveBeenCalledExactlyOnceWith(TICKET_ID)
  })

  it('reopens a mounted collapsed panel on delete without clearing another ticket preference', () => {
    const otherTicketId = 'proj-1:LOOP-2'
    localStorage.setItem(getTicketQuestionsCollapsedStorageKey(TICKET_ID), '1')
    localStorage.setItem(getTicketQuestionsCollapsedStorageKey(otherTicketId), '1')

    renderPanel({
      getTicketRequests: () => [makeRequest()],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
    })
    const toggle = screen.getByRole('button', { name: /claude-opus-4/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    act(() => {
      window.dispatchEvent(new CustomEvent(TICKET_STATE_CLEARED_EVENT, { detail: { ticketId: otherTicketId } }))
    })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    act(() => { clearTicketPersistentState(TICKET_ID) })

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(localStorage.getItem(getTicketQuestionsCollapsedStorageKey(TICKET_ID))).toBeNull()
    expect(localStorage.getItem(getTicketQuestionsCollapsedStorageKey(otherTicketId))).toBe('1')
  })

  it('remembers collapsing and expanding the panel for this ticket', () => {
    renderPanel({ getTicketRequests: () => [makeRequest()] })
    const toggle = screen.getByRole('button', { name: /claude-opus-4/i })
    const key = getTicketQuestionsCollapsedStorageKey(TICKET_ID)

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(localStorage.getItem(key)).toBe('1')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('keeps the panel usable when browser storage is blocked', () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('Storage disabled')
    })
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Storage disabled')
    })
    const removeItem = vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('Storage disabled')
    })

    try {
      renderPanel({ getTicketRequests: () => [makeRequest()] })
      const toggle = screen.getByRole('button', { name: /claude-opus-4/i })
      expect(toggle).toHaveAttribute('aria-expanded', 'true')

      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
      removeItem.mockRestore()
    }
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

  it('refreshes the displayed countdown on its one-second tick', () => {
    vi.useFakeTimers()
    const getRemainingMs = vi.fn().mockReturnValue(240_000)
    const value = createAiQuestionContextStub({
      getTicketRequests: () => [makeRequest()],
      getTimer: () => makeTimer(),
      getRemainingMs,
    })
    const view = render(
      <AIQuestionContext.Provider value={value}>
        <PendingQuestionsPanel ticketId={TICKET_ID} />
      </AIQuestionContext.Provider>,
    )

    try {
      expect(screen.getByText('4:00')).toBeInTheDocument()
      getRemainingMs.mockReturnValue(239_000)
      act(() => { vi.advanceTimersByTime(1_000) })
      expect(screen.getByText('3:59')).toBeInTheDocument()
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
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

  it('uses readable labels when model ids have no provider or are missing', () => {
    renderPanel({
      getTicketRequests: () => [
        makeRequest({ modelId: 'custom-model' }),
        makeRequest({ sessionId: 'ses_b', requestId: 'req_b', modelId: undefined }),
      ],
    })

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'custom-model · 1',
      'OpenCode · 1',
    ])
  })

  it('supports tab arrow, Home, and End navigation and clears a skip reason when switching models', () => {
    const first = makeRequest({
      questions: [
        { header: 'One', question: 'First?', options: [{ label: 'Yes' }] },
        { header: 'Two', question: 'Second?', options: [{ label: 'No' }] },
      ],
    })
    const second = makeRequest({ sessionId: 'ses_b', requestId: 'req_b', modelId: 'openai/gpt-5' })
    const stopTimer = vi.fn()
    renderPanel({ getTicketRequests: () => [first, second], stopTimer })
    const tabs = screen.getAllByRole('tab')

    expect(fireEvent.keyDown(tabs[0]!, { key: 'Enter' })).toBe(true)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.change(screen.getByLabelText(/skip reason/i), { target: { value: 'Only for this request' } })
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' })
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveFocus()
    expect(screen.queryByLabelText(/skip reason/i)).not.toBeInTheDocument()

    fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' })
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' })
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowLeft' })
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tabs[0]!, { key: 'End' })
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tabs[1]!, { key: 'Home' })
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(tabs[1]!)
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(stopTimer).toHaveBeenCalled()
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

  it('submits single-choice free text as an alternative to the selected option', () => {
    const answerRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest()],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
      answerRequest,
    })

    fireEvent.click(screen.getByLabelText('SQLite'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'in ./data' } })
    expect(screen.getByLabelText('SQLite')).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))

    expect(answerRequest).toHaveBeenCalledWith(TICKET_ID, 'req_a', [['in ./data']])
  })

  it('clears single-choice free text when an option is selected', () => {
    const answerRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest()],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
      answerRequest,
    })

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'in ./data' } })
    fireEvent.click(screen.getByLabelText('SQLite'))
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByLabelText('SQLite')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))

    expect(answerRequest).toHaveBeenCalledWith(TICKET_ID, 'req_a', [['SQLite']])
  })

  it('keeps free text additive for multiple-choice answers', () => {
    const answerRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest({
        questions: [{
          header: 'Targets',
          question: 'Which targets?',
          options: [{ label: 'Desktop' }, { label: 'Web' }],
          multiple: true,
          custom: true,
        }],
      })],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
      answerRequest,
    })

    fireEvent.click(screen.getByLabelText('Desktop'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'in ./data' } })
    expect(screen.getByLabelText('Desktop')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))

    expect(answerRequest).toHaveBeenCalledWith(TICKET_ID, 'req_a', [['Desktop', 'in ./data']])
  })

  it('displays option labels and submits option values for single-select answers', () => {
    const answerRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest({
        questions: [{
          header: 'Mode',
          question: 'Which mode?',
          options: [{ label: 'Fast mode', value: 'fast' }],
          custom: false,
        }],
      })],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
      answerRequest,
    })

    fireEvent.click(screen.getByLabelText('Fast mode'))
    expect(screen.getByText('Fast mode')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))

    expect(answerRequest).toHaveBeenCalledWith(TICKET_ID, 'req_a', [['fast']])
  })

  it('submits option values for each selected multiselect answer', () => {
    const answerRequest = vi.fn()
    renderPanel({
      getTicketRequests: () => [makeRequest({
        questions: [{
          header: 'Targets',
          question: 'Which targets?',
          options: [
            { label: 'Desktop', value: 'desktop-app' },
            { label: 'Web', value: 'web-app' },
          ],
          multiple: true,
          custom: false,
        }],
      })],
      getTimer: () => makeTimer(),
      getRemainingMs: () => 240_000,
      answerRequest,
    })

    fireEvent.click(screen.getByLabelText('Desktop'))
    fireEvent.click(screen.getByLabelText('Web'))
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))

    expect(answerRequest).toHaveBeenCalledWith(TICKET_ID, 'req_a', [['desktop-app', 'web-app']])
  })

  it('removes a multiple-choice option when it is selected a second time', () => {
    renderPanel({
      getTicketRequests: () => [makeRequest({
        questions: [{ header: 'Targets', question: 'Which targets?', options: [{ label: 'Desktop' }], multiple: true }],
      })],
    })
    const option = screen.getByRole('checkbox', { name: 'Desktop' })
    const submit = screen.getByRole('button', { name: 'Send answer' })

    fireEvent.click(option)
    expect(option).toBeChecked()
    expect(submit).toBeEnabled()
    fireEvent.click(option)
    expect(option).not.toBeChecked()
    expect(submit).toBeDisabled()
  })

  it('shows request errors and disables answers while submitting', () => {
    renderPanel({
      getTicketRequests: () => [makeRequest({ submitting: true, error: 'Could not send answer.' })],
    })

    expect(screen.getByText('Could not send answer.')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'SQLite' })).toBeDisabled()
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled()
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

    expect(screen.getByRole('button', { name: 'Send answers' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Yes'))
    // OpenCode takes every answer in one payload, so a half-filled batch is not
    // sendable — the other question would arrive empty.
    expect(screen.getByRole('button', { name: 'Send answers' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByLabelText('No'))
    expect(screen.getByRole('button', { name: 'Send answers' })).toBeEnabled()
  })

  it('moves backward between batch questions and can back out of skipping', () => {
    renderPanel({
      getTicketRequests: () => [makeRequest({
        questions: [
          { header: 'One', question: 'First?', options: [{ label: 'Yes' }] },
          { header: 'Two', question: 'Second?', options: [{ label: 'No' }] },
        ],
      })],
    })

    const previous = screen.getByRole('button', { name: 'Previous' })
    const next = screen.getByRole('button', { name: 'Next' })
    expect(previous).toBeDisabled()
    fireEvent.click(next)
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
    expect(next).toBeDisabled()
    expect(previous).toBeEnabled()
    fireEvent.click(previous)
    expect(screen.getByText('1 of 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(screen.getByText(/skipping refuses all 2 questions/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByLabelText(/skip reason/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument()
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

  it('submits an empty skip reason as null', () => {
    const skipRequest = vi.fn()
    renderPanel({ getTicketRequests: () => [makeRequest()], skipRequest })

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.change(screen.getByLabelText(/skip reason/i), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Skip this question' }))

    expect(skipRequest).toHaveBeenCalledWith(TICKET_ID, 'req_a', null)
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

  it('keeps matching single-choice free text distinct from an option', () => {
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
    expect(screen.getByRole('radio', { name: 'SQLite' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: 'Postgres' })).not.toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(answerRequest).toHaveBeenCalledWith(TICKET_ID, 'req_a', [['Postgres']])
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
