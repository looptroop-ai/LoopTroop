import { render, screen, waitFor } from '@testing-library/react'
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
})
