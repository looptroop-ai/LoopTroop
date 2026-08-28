import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
            timer: { ...first, timerKey: 'VERIFYING:1', revision: 1, stoppedAt: null },
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

  it('does not discard a new clock as stale because the old one outranked it', async () => {
    const ticket = makeTicket()
    const question = buildQuestion(ticket.id)
    const old = {
      timerKey: 'CODING:1',
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
            timer: { ...old, timerKey: 'VERIFYING:1', revision: 1 },
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
})
