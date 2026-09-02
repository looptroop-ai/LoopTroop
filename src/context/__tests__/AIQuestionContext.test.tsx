import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIQuestionProvider } from '../AIQuestionContext'
import { UIProvider } from '../UIContext'
import { useAIQuestions } from '../useAIQuestions'
import { makeTicket, TEST } from '@/test/factories'

class MockEventSource {
  onerror: (() => void) | null = null
  addEventListener() {
    return undefined
  }
  close() {
    return undefined
  }
}

function Counts({ ticketId }: { ticketId: string }) {
  const { getPendingCount, getRequestCount } = useAIQuestions()
  return <div>pending:{getPendingCount(ticketId)} requests:{getRequestCount(ticketId)}</div>
}

function buildQuestion(ticketId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'opencode_question',
    ticketId,
    ticketExternalId: TEST.externalId,
    ticketTitle: 'A ticket',
    status: 'CODING',
    phase: 'CODING',
    modelId: TEST.model,
    sessionId: 'session-1234567890',
    requestId: 'question-1',
    questions: [{
      header: 'Choose path',
      question: 'Which implementation path should I use?',
      options: [{ label: 'Small', description: 'Keep the change narrow' }],
      custom: true,
    }],
    timestamp: TEST.timestamp,
    ...overrides,
  }
}

function stubAggregate(body: unknown) {
  vi.stubGlobal('EventSource', MockEventSource)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
}

function renderProvider(tickets: ReturnType<typeof makeTicket>[], children: React.ReactNode) {
  return render(
    <UIProvider>
      <AIQuestionProvider tickets={tickets}>{children}</AIQuestionProvider>
    </UIProvider>,
  )
}

describe('AIQuestionProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('recovers pending questions without covering the app', async () => {
    const ticket = makeTicket({ status: 'CODING' })
    stubAggregate({ questions: [buildQuestion(ticket.id)], timers: {} })

    renderProvider([ticket], <Counts ticketId={ticket.id} />)

    await waitFor(() => expect(screen.getByText('pending:1 requests:1')).toBeInTheDocument())
    // The old surface was a `fixed inset-0` overlay. Nothing may cover the app.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Which implementation path should I use?')).not.toBeInTheDocument()
  })

  it('counts models and questions separately', async () => {
    const ticket = makeTicket({ status: 'CODING' })
    stubAggregate({
      questions: [
        buildQuestion(ticket.id),
        buildQuestion(ticket.id, {
          sessionId: 'session-2',
          requestId: 'question-2',
          questions: [
            { header: 'A', question: 'First?', options: [] },
            { header: 'B', question: 'Second?', options: [] },
          ],
        }),
      ],
      timers: {},
    })

    renderProvider([ticket], <Counts ticketId={ticket.id} />)

    // Two models asking, three questions between them. The badge and the tab
    // strip mean different things and must not share a number.
    await waitFor(() => expect(screen.getByText('pending:3 requests:2')).toBeInTheDocument())
  })

  it('slides a bar in for a question on a ticket you are not looking at', async () => {
    const ticket = makeTicket({ status: 'CODING' })
    stubAggregate({ questions: [buildQuestion(ticket.id)], timers: {} })

    renderProvider([ticket], <div>board</div>)

    expect(await screen.findByText(`${TEST.externalId} is waiting on a question`)).toBeInTheDocument()
  })

  it('keeps the model name when a request arrives on the timer-update path', async () => {
    const ticket = makeTicket({ status: 'CODING' })
    // The aggregate poll finds nothing; the request is only ever seen inside a
    // timer update, whose rows use the server's `memberId` rather than `modelId`.
    stubAggregate({ questions: [], timers: {} })

    function Model({ ticketId }: { ticketId: string }) {
      const { getTicketRequests, ingestSseEvent } = useAIQuestions()
      return (
        <>
          <button
            type="button"
            onClick={() => ingestSseEvent({
              type: 'opencode_question_updated',
              ticketId,
              ticketExternalId: TEST.externalId,
              ticketTitle: 'A ticket',
              status: 'CODING',
              requests: [{
                ticketId,
                sessionId: 'ses_a',
                requestId: 'req_a',
                memberId: TEST.model,
                phase: 'CODING',
                phaseAttempt: 1,
                questions: [{ header: 'H', question: 'Which?', options: [] }],
                questionCount: 1,
                receivedAt: TEST.timestamp,
                timerKey: 'CODING:1',
              }],
            })}
          >
            ingest
          </button>
          <div>model:{getTicketRequests(ticketId)[0]?.modelId ?? 'none'}</div>
        </>
      )
    }

    renderProvider([ticket], <Model ticketId={ticket.id} />)
    fireEvent.click(await screen.findByRole('button', { name: 'ingest' }))

    // `upsertRequest` never overwrites an existing row, so a name missed here
    // would stay missing for the life of the request.
    await waitFor(() => expect(screen.getByText(`model:${TEST.model}`)).toBeInTheDocument())
  })

  it('corrects the countdown for a browser clock that is wrong', async () => {
    const ticket = makeTicket({ status: 'CODING' })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'))
    // The browser is five minutes ahead of the server. Without skew correction
    // the countdown would read as already expired.
    stubAggregate({
      questions: [buildQuestion(ticket.id)],
      timers: {
        [ticket.id]: {
          timerKey: 'CODING:1',
          windowMs: 300_000,
          armedAt: '2026-01-01T00:00:00.000Z',
          deadlineAt: '2026-01-01T00:05:00.000Z',
          stoppedAt: null,
          stoppedBy: null,
          resetCount: 0,
          revision: 1,
          serverNow: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    function Remaining({ ticketId }: { ticketId: string }) {
      const { getRemainingMs } = useAIQuestions()
      return <div>remaining:{getRemainingMs(ticketId) ?? 'none'}</div>
    }

    renderProvider([ticket], <Remaining ticketId={ticket.id} />)

    await vi.waitFor(() => expect(screen.getByText('remaining:300000')).toBeInTheDocument())
    vi.useRealTimers()
  })

  it('sends Stop again for the next step’s clock on the same ticket', async () => {
    const ticket = makeTicket()
    const question = buildQuestion(ticket.id)
    const first = {
      timerKey: 'CODING:1',
      generation: 1,
      windowMs: 300_000,
      armedAt: TEST.timestamp,
      deadlineAt: new Date(Date.parse(TEST.timestamp) + 300_000).toISOString(),
      stoppedAt: null,
      stoppedBy: null,
      resetCount: 0,
      revision: 4,
      serverNow: TEST.timestamp,
    }
    stubAggregate({ questions: [question], timers: { [ticket.id]: first } })

    function Stopper({ ticketId }: { ticketId: string }) {
      const { stopTimer, ingestSseEvent } = useAIQuestions()
      return (
        <>
          <button onClick={() => stopTimer(ticketId)}>stop</button>
          <button onClick={() => ingestSseEvent({
            type: 'opencode_question_updated',
            ticketId,
            // A different step, so a different clock — and revisions restart at
            // 1 for it, below the 4 the previous clock had reached.
            timer: { ...first, timerKey: 'VERIFYING:1', generation: 9, revision: 1, stoppedAt: null },
            requests: [],
          })}>next-step</button>
        </>
      )
    }

    renderProvider([ticket], <Stopper ticketId={ticket.id} />)
    await waitFor(() => expect(screen.getByText('stop')).toBeInTheDocument())
    const calls = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => String(url).includes('question-timer/stop'))

    fireEvent.click(screen.getByText('stop'))
    await waitFor(() => expect(calls()).toHaveLength(1))
    fireEvent.click(screen.getByText('stop'))
    expect(calls()).toHaveLength(1)

    fireEvent.click(screen.getByText('next-step'))
    fireEvent.click(screen.getByText('stop'))
    // Keyed on the ticket alone, the browser remembered "already stopped" and
    // never sent Stop for the next step's clock at all — so that question would
    // expire under someone who was sitting there answering it.
    await waitFor(() => expect(calls()).toHaveLength(2))
  })

  it('accepts a second clock on the same step, which reuses the timer key', async () => {
    const ticket = makeTicket()
    const question = buildQuestion(ticket.id)
    const first = {
      timerKey: 'CODING:1',
      generation: 4,
      windowMs: 300_000,
      armedAt: TEST.timestamp,
      deadlineAt: new Date(Date.parse(TEST.timestamp) + 300_000).toISOString(),
      stoppedAt: null,
      stoppedBy: null,
      resetCount: 0,
      revision: 5,
      serverNow: TEST.timestamp,
    }
    stubAggregate({ questions: [question], timers: { [ticket.id]: first } })

    function Step({ ticketId }: { ticketId: string }) {
      const { getTimer, stopTimer, ingestSseEvent } = useAIQuestions()
      return (
        <>
          <div>gen:{getTimer(ticketId)?.generation ?? 'none'}</div>
          <button onClick={() => stopTimer(ticketId)}>stop</button>
          <button onClick={() => ingestSseEvent({
            type: 'opencode_question_updated',
            ticketId,
            // The step asked, was answered, and asked again. Same phase and same
            // attempt, so the same timerKey — but a different clock, whose
            // revision starts over below the one the first clock reached.
            timer: { ...first, generation: 5, revision: 1 },
            requests: [],
          })}>ask-again</button>
        </>
      )
    }

    renderProvider([ticket], <Step ticketId={ticket.id} />)
    await waitFor(() => expect(screen.getByText('gen:4')).toBeInTheDocument())
    const calls = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => String(url).includes('question-timer/stop'))

    fireEvent.click(screen.getByText('stop'))
    await waitFor(() => expect(calls()).toHaveLength(1))

    fireEvent.click(screen.getByText('ask-again'))
    // Keyed on timerKey alone, the browser kept showing the clock that had
    // already gone and refused to stop the new one.
    await waitFor(() => expect(screen.getByText('gen:5')).toBeInTheDocument())
    fireEvent.click(screen.getByText('stop'))
    await waitFor(() => expect(calls()).toHaveLength(2))
  })

  it('does not discard a new clock as stale because the old one outranked it', async () => {
    const ticket = makeTicket()
    const question = buildQuestion(ticket.id)
    const old = {
      timerKey: 'CODING:1',
      generation: 1,
      windowMs: 300_000,
      armedAt: TEST.timestamp,
      deadlineAt: new Date(Date.parse(TEST.timestamp) + 60_000).toISOString(),
      stoppedAt: null,
      stoppedBy: null,
      resetCount: 0,
      revision: 6,
      serverNow: TEST.timestamp,
    }
    stubAggregate({ questions: [question], timers: { [ticket.id]: old } })

    function Timer({ ticketId }: { ticketId: string }) {
      const { getTimer, ingestSseEvent } = useAIQuestions()
      return (
        <>
          <div>key:{getTimer(ticketId)?.timerKey ?? 'none'}</div>
          <button onClick={() => ingestSseEvent({
            type: 'opencode_question_updated',
            ticketId,
            timer: { ...old, timerKey: 'VERIFYING:1', generation: 9, revision: 1 },
            requests: [],
          })}>advance</button>
        </>
      )
    }

    renderProvider([ticket], <Timer ticketId={ticket.id} />)
    await waitFor(() => expect(screen.getByText('key:CODING:1')).toBeInTheDocument())

    fireEvent.click(screen.getByText('advance'))
    // Revisions are per clock. Comparing them across clocks threw away the new
    // countdown and left the browser showing one that had already gone.
    await waitFor(() => expect(screen.getByText('key:VERIFYING:1')).toBeInTheDocument())
  })

  it('drops a request the step no longer lists', async () => {
    // `opencode_question_updated` carries the step's whole pending set, so it is
    // also how this client learns a request went away. Only upserting left a
    // request that was dropped without an explicit `resolved` event answerable
    // until the 30-second poll noticed.
    const ticket = makeTicket({ status: 'CODING' })
    stubAggregate({
      questions: [buildQuestion(ticket.id), buildQuestion(ticket.id, { sessionId: 'session-2', requestId: 'question-2' })],
      timers: {},
    })

    function Pruner({ ticketId }: { ticketId: string }) {
      const { getRequestCount, ingestSseEvent } = useAIQuestions()
      return (
        <>
          <div>requests:{getRequestCount(ticketId)}</div>
          <button onClick={() => ingestSseEvent({
            type: 'opencode_question_updated',
            ticketId,
            requests: [{ sessionId: 'session-1234567890', requestId: 'question-1', questions: [{ header: 'H', question: 'Q?', options: [] }] }],
          })}>update</button>
          <button onClick={() => ingestSseEvent({ type: 'opencode_question_updated', ticketId })}>timer-only</button>
        </>
      )
    }

    renderProvider([ticket], <Pruner ticketId={ticket.id} />)
    await waitFor(() => expect(screen.getByText('requests:2')).toBeInTheDocument())

    fireEvent.click(screen.getByText('update'))
    await waitFor(() => expect(screen.getByText('requests:1')).toBeInTheDocument())

    // An update with no `requests` array is not a statement about the set.
    fireEvent.click(screen.getByText('timer-only'))
    await waitFor(() => expect(screen.getByText('requests:1')).toBeInTheDocument())
  })

  it('lets go of a ticket that has finished', async () => {
    // Requests were retained for the life of the tab, so a cancelled ticket kept
    // an answer-and-skip affordance for a step nothing is waiting on.
    const ticket = makeTicket({ status: 'CODING' })
    stubAggregate({ questions: [buildQuestion(ticket.id)], timers: {} })

    const { rerender } = renderProvider([ticket], <Counts ticketId={ticket.id} />)
    await waitFor(() => expect(screen.getByText('pending:1 requests:1')).toBeInTheDocument())

    rerender(
      <UIProvider>
        <AIQuestionProvider tickets={[{ ...ticket, status: 'CANCELED' }]}>
          <Counts ticketId={ticket.id} />
        </AIQuestionProvider>
      </UIProvider>,
    )

    await waitFor(() => expect(screen.getByText('pending:0 requests:0')).toBeInTheDocument())
  })

  it('reports an answer failure with its status instead of [object Object]', async () => {
    // The question routes answer a validation failure with `details` set to a Zod
    // field map. This provider had its own parser, which stringified that object
    // straight into the panel and dropped the status with it.
    const ticket = makeTicket({ status: 'CODING' })
    vi.stubGlobal('EventSource', MockEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/reply')) {
        return new Response(
          JSON.stringify({ error: 'Invalid question reply payload', details: { formErrors: [], fieldErrors: {} } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ questions: [buildQuestion(ticket.id)], timers: {} }), { status: 200 })
    }))

    function Answerer({ ticketId }: { ticketId: string }) {
      const { answerRequest, getTicketRequests } = useAIQuestions()
      const request = getTicketRequests(ticketId)[0]
      return (
        <>
          <div>error:{request?.error ?? 'none'}</div>
          <button onClick={() => answerRequest(ticketId, 'question-1', [['Small']])}>answer</button>
        </>
      )
    }

    renderProvider([ticket], <Answerer ticketId={ticket.id} />)
    await waitFor(() => expect(screen.getByText('error:none')).toBeInTheDocument())

    fireEvent.click(screen.getByText('answer'))

    await waitFor(() => expect(
      screen.getByText('error:Could not send that answer (HTTP 400: Invalid question reply payload)'),
    ).toBeInTheDocument())
  })

  it('does not let a slow per-ticket refresh undo a newer live update', async () => {
    // Round 1 ordered the poll against a newer refresh but not the reverse, and
    // not against SSE at all. A snapshot prunes, so an older one applying last
    // deletes a question that has just arrived.
    const ticket = makeTicket({ status: 'CODING' })
    let releaseRefresh!: (body: unknown) => void
    vi.stubGlobal('EventSource', MockEventSource)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/opencode/questions')) {
        // The per-ticket refresh: held open until the SSE event has landed.
        return new Promise<Response>((resolve) => {
          releaseRefresh = (body) => resolve(new Response(JSON.stringify(body), { status: 200 }))
        })
      }
      return new Response(JSON.stringify({ questions: [], timers: {} }), { status: 200 })
    }))

    function Refresher({ ticketId }: { ticketId: string }) {
      const { getRequestCount, refreshTicket, ingestSseEvent } = useAIQuestions()
      return (
        <>
          <div>requests:{getRequestCount(ticketId)}</div>
          <button onClick={() => refreshTicket(ticketId)}>refresh</button>
          <button onClick={() => ingestSseEvent(buildQuestion(ticketId))}>live</button>
        </>
      )
    }

    renderProvider([ticket], <Refresher ticketId={ticket.id} />)
    await waitFor(() => expect(screen.getByText('requests:0')).toBeInTheDocument())

    fireEvent.click(screen.getByText('refresh'))
    await waitFor(() => expect(releaseRefresh).toBeDefined())

    // The question arrives live while the refresh is still in flight.
    fireEvent.click(screen.getByText('live'))
    await waitFor(() => expect(screen.getByText('requests:1')).toBeInTheDocument())

    // The refresh read the server before that, so its empty view is stale.
    await act(async () => releaseRefresh({ questions: [], timer: null }))

    expect(screen.getByText('requests:1')).toBeInTheDocument()
  })
})
