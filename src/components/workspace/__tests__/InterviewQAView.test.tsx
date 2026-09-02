import { QueryClient } from '@tanstack/react-query'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InterviewSessionView, PersistedInterviewBatch } from '@shared/interviewSession'
import { makeTicket, TEST } from '@/test/factories'
import { createJsonResponse, renderWithProviders as sharedRenderWithProviders } from '@/test/renderHelpers'
import { INTERVIEW_BATCH_EVENT } from '@/lib/interviewBatchEvents'
import { InterviewQAView } from '../InterviewQAView'

let submittedBody: { answers?: Record<string, string>; selectedOptions?: Record<string, string[]>; skipReasons?: Record<string, string> } | null = null
let skippedBody: { answers?: Record<string, string>; skipReasons?: Record<string, string>; bulkSkipReason?: string } | null = null
let savedUiState: { scope?: string; data?: unknown } | null = null
let preSeededDrafts: { draftAnswers: Record<string, Record<string, string>>; skippedQuestions: Record<string, string[]>; selectedOptions?: Record<string, Record<string, string[]>> } | null = null
let interviewData: InterviewSessionView = {
  winnerId: 'openai/gpt-5',
  raw: 'questions:\n  - id: Q01',
  session: null,
  questions: [],
}

// `ticketId` mirrors what `fetchTicketUIState` stamps onto every payload it returns. Consumers gate
// their restore on it, so a fixture without it looks like another ticket's state and is ignored.
function emptyUiState() {
  return { scope: 'interview-drafts', exists: false, data: null, updatedAt: null, ticketId: TEST.ticketId }
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  queryClient.setQueryData(['interview', TEST.ticketId], interviewData)
  queryClient.setQueryData(
    ['ticket-ui-state', TEST.ticketId, 'interview-drafts'],
    preSeededDrafts
      ? { scope: 'interview-drafts', exists: true, data: preSeededDrafts, updatedAt: '2026-03-12T10:10:00.000Z', ticketId: TEST.ticketId }
      : emptyUiState(),
  )

  return sharedRenderWithProviders(ui, { queryClient })
}

function makeBatch(overrides: Partial<PersistedInterviewBatch> = {}): PersistedInterviewBatch {
  return {
    questions: [],
    progress: { current: 3, total: 4 },
    isComplete: false,
    isFinalFreeForm: false,
    aiCommentary: 'Need the remaining implementation details.',
    batchNumber: 2,
    source: 'prom4',
    ...overrides,
  }
}

function makeChoiceBatch(overrides: Partial<PersistedInterviewBatch> = {}): PersistedInterviewBatch {
  return makeBatch({
    questions: [
      {
        id: 'QF01',
        phase: 'Assembly',
        question: 'Which persistence mode should retries use?',
        source: 'prompt_follow_up',
        roundNumber: 1,
        answerType: 'single_choice',
        options: [
          { id: 'memory', label: 'In-memory' },
          { id: 'database', label: 'Database-backed' },
        ],
      },
      {
        id: 'Q03',
        phase: 'Assembly',
        question: 'What retry budget is acceptable?',
        source: 'compiled',
      },
    ],
    ...overrides,
  })
}

describe('InterviewQAView', () => {
  beforeEach(() => {
    vi.useRealTimers()
    submittedBody = null
    skippedBody = null
    savedUiState = null
    preSeededDrafts = null
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })

    interviewData = {
      winnerId: 'openai/gpt-5',
      raw: 'questions:\n  - id: Q01',
      questions: [
        {
          id: 'Q01',
          phase: 'Foundation',
          question: 'What outcome matters most?',
          source: 'compiled',
          status: 'answered',
          answer: 'Keep imports idempotent.',
        },
        {
          id: 'Q02',
          phase: 'Structure',
          question: 'Which constraints are fixed?',
          source: 'compiled',
          status: 'skipped',
          answer: '',
        },
        {
          id: 'QF01',
          phase: 'Assembly',
          question: 'How will retries be tested?',
          source: 'prompt_follow_up',
          roundNumber: 1,
          status: 'current',
          answer: null,
        },
        {
          id: 'Q03',
          phase: 'Assembly',
          question: 'What retry budget is acceptable?',
          source: 'compiled',
          status: 'current',
          answer: null,
        },
      ],
      session: {
        schemaVersion: 1,
        winnerId: 'openai/gpt-5',
        maxInitialQuestions: 12,
        maxFollowUps: 2,
        questions: [
          {
            id: 'Q01',
            phase: 'Foundation',
            question: 'What outcome matters most?',
            source: 'compiled',
          },
          {
            id: 'Q02',
            phase: 'Structure',
            question: 'Which constraints are fixed?',
            source: 'compiled',
          },
          {
            id: 'QF01',
            phase: 'Assembly',
            question: 'How will retries be tested?',
            source: 'prompt_follow_up',
            roundNumber: 1,
          },
          {
            id: 'Q03',
            phase: 'Assembly',
            question: 'What retry budget is acceptable?',
            source: 'compiled',
          },
        ],
        answers: {
          Q01: {
            answer: 'Keep imports idempotent.',
            skipped: false,
            answeredAt: '2026-03-12T10:10:00.000Z',
            batchNumber: 1,
          },
          Q02: {
            answer: '',
            skipped: true,
            answeredAt: null,
            batchNumber: 1,
          },
        },
        currentBatch: makeBatch({
          questions: [
            {
              id: 'QF01',
              phase: 'Assembly',
              question: 'How will retries be tested?',
              source: 'prompt_follow_up',
              roundNumber: 1,
            },
            {
              id: 'Q03',
              phase: 'Assembly',
              question: 'What retry budget is acceptable?',
              source: 'compiled',
            },
          ],
        }),
        batchHistory: [
          {
            batchNumber: 1,
            source: 'prom4',
            questionIds: ['Q01', 'Q02'],
            isFinalFreeForm: false,
            submittedAt: '2026-03-12T10:10:00.000Z',
          },
        ],
        followUpRounds: [
          {
            roundNumber: 1,
            source: 'prom4',
            questionIds: ['QF01'],
          },
        ],
        rawFinalYaml: null,
        completedAt: null,
        updatedAt: '2026-03-12T10:10:00.000Z',
      },
    }

    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = String(input)
      if (url.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/answer-batch`)) {
        submittedBody = init?.body ? JSON.parse(String(init.body)) as { answers?: Record<string, string>; selectedOptions?: Record<string, string[]> } : null
        return createJsonResponse(makeBatch())
      }
      if (url.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/skip`)) {
        skippedBody = init?.body ? JSON.parse(String(init.body)) as { answers?: Record<string, string> } : null
        return createJsonResponse({
          message: 'Remaining interview questions skipped',
          ticketId: TEST.ticketId,
          status: 'WAITING_INTERVIEW_APPROVAL',
          state: 'WAITING_INTERVIEW_APPROVAL',
          ticket: {
            ...makeTicket(),
            status: 'WAITING_INTERVIEW_APPROVAL',
          },
        })
      }
      if (url.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/interview`)) {
        return createJsonResponse(interviewData)
      }
      if (url.includes(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/ui-state`)) {
        if (init?.method === 'PUT') {
          savedUiState = init.body ? JSON.parse(String(init.body)) as { scope?: string; data?: unknown } : null
          return createJsonResponse({ success: true, scope: 'interview-drafts', updatedAt: new Date().toISOString() })
        }
        return createJsonResponse(emptyUiState())
      }
      throw new Error(`Unhandled fetch: ${url}`)
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders interview history, restores skip-all actions, and submits batch answers', async () => {
    renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)

    // Wait for data to load and history toggle to appear
    await waitFor(() => {
      expect(screen.getByText(/Interview History/i)).toBeInTheDocument()
    })

    // History is collapsed by default — expand it
    fireEvent.click(screen.getByText(/Interview History/i))

    await waitFor(() => {
      expect(screen.getByText('Keep imports idempotent.')).toBeInTheDocument()
    })

    expect(screen.getByText('What outcome matters most?')).toBeInTheDocument()
    expect(screen.getByText('Skipped')).toBeInTheDocument()
    expect(screen.getByText('PROM4 Follow-up')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /skip all questions/i })).toBeInTheDocument()

    const textareas = screen.getAllByRole('textbox')
    fireEvent.change(textareas[0]!, { target: { value: 'Exercise retries against a flaky upstream fake.' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit batch/i }))
    })

    expect(submittedBody).toEqual({
      answers: {
        QF01: 'Exercise retries against a flaky upstream fake.',
      },
      selectedOptions: {},
      skipReasons: {},
    })
  })

  it('confirms and skips all remaining interview questions while preserving drafted answers', async () => {
    renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)

    await waitFor(() => {
      expect(screen.getByText('How will retries be tested?')).toBeInTheDocument()
    })

    const textareas = screen.getAllByRole('textbox')
    fireEvent.change(textareas[0]!, { target: { value: 'Exercise retries against a flaky upstream fake.' } })

    fireEvent.click(screen.getByRole('button', { name: /skip all questions/i }))

    expect(screen.getByRole('heading', { name: /skip remaining interview questions/i })).toBeInTheDocument()
    expect(screen.getByText(/preserves anything currently typed in this batch/i)).toBeInTheDocument()
    expect(screen.getByText(/answered by AI models at the start of the PRD phase/i)).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /skip to approval/i }))
    })

    expect(skippedBody).toEqual({
      answers: {
        QF01: 'Exercise retries against a flaky upstream fake.',
      },
      selectedOptions: {},
      skipReasons: {},
    })
  })

  it('responds to navigator focus events by revealing and focusing the target question', async () => {
    renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)

    await waitFor(() => {
      expect(screen.getByText('How will retries be tested?')).toBeInTheDocument()
    })

    const textareas = screen.getAllByRole('textbox')
    const targetTextarea = textareas[0] as HTMLTextAreaElement

    await act(async () => {
      window.dispatchEvent(new CustomEvent('looptroop:interview-focus', {
        detail: { ticketId: TEST.ticketId, questionId: 'QF01' },
      }))
    })

    await waitFor(() => {
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled()
      expect(targetTextarea).toHaveFocus()
    })
  })

  it('restores persisted draft answers on mount', async () => {
    const batchKey = 'prom4:0:2'
    preSeededDrafts = {
      draftAnswers: { [batchKey]: { QF01: 'Restored draft answer' } },
      skippedQuestions: {},
    }

    renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)

    await waitFor(() => {
      expect(screen.getByText('How will retries be tested?')).toBeInTheDocument()
    })

    const textareas = screen.getAllByRole('textbox')
    expect((textareas[0] as HTMLTextAreaElement).value).toBe('Restored draft answer')
  })

  it('auto-saves drafts after debounce', async () => {
    renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)

    await waitFor(() => {
      expect(screen.getByText('How will retries be tested?')).toBeInTheDocument()
    })
    expect(screen.getByText(/Autosave on/)).toHaveTextContent('Changes save automatically')

    vi.useFakeTimers()
    try {
      const textareas = screen.getAllByRole('textbox')
      fireEvent.change(textareas[0]!, { target: { value: 'My draft answer' } })

      expect(savedUiState).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(350)
      })

      expect(savedUiState).not.toBeNull()
      expect(screen.getByText(/Autosave on/)).toHaveTextContent(/Last save/)

      const data = savedUiState!.data as { draftAnswers: Record<string, Record<string, string>> }
      expect(data.draftAnswers['prom4:0:2']).toEqual({ QF01: 'My draft answer' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces an interview draft autosave conflict', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = String(input)
      if (url.includes(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/ui-state`)) {
        if (init?.method === 'PUT') {
          return createJsonResponse({
            conflict: true,
            scope: 'interview-drafts',
            updatedAt: '2026-07-20T12:00:00.000Z',
            revision: 2,
            clientRevision: 1,
          }, 409)
        }
        return createJsonResponse(emptyUiState())
      }
      if (url.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/interview`)) return createJsonResponse(interviewData)
      throw new Error(`Unhandled fetch: ${url}`)
    }))

    renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)
    await waitFor(() => {
      expect(screen.getByText('How will retries be tested?')).toBeInTheDocument()
    })

    vi.useFakeTimers()
    try {
      fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Conflicting draft' } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350)
      })
      expect(screen.getByText('Autosave on · Autosave conflict')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears persisted drafts after batch submission', async () => {
    const batchKey = 'prom4:0:2'
    preSeededDrafts = {
      draftAnswers: { [batchKey]: { QF01: 'Pre-filled answer' } },
      skippedQuestions: {},
    }

    renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)

    await waitFor(() => {
      expect((screen.getAllByRole('textbox')[0] as HTMLTextAreaElement).value).toBe('Pre-filled answer')
    })

    vi.useFakeTimers()
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /submit batch/i }))
        await Promise.resolve()
      })

      expect(submittedBody).toEqual({ answers: { QF01: 'Pre-filled answer' }, selectedOptions: {}, skipReasons: {} })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(350)
      })

      expect(savedUiState).not.toBeNull()

      const data = savedUiState!.data as { draftAnswers: Record<string, Record<string, string>> }
      expect(data.draftAnswers[batchKey]).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears choice selections when a question is skipped before submitting', async () => {
    interviewData.session!.currentBatch = makeChoiceBatch()

    renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)

    await waitFor(() => {
      expect(screen.getByText('Which persistence mode should retries use?')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByLabelText('Database-backed'))
    fireEvent.click(screen.getAllByRole('button', { name: /skip question/i })[0]!)
    fireEvent.change(screen.getByPlaceholderText('Type your answer here.'), {
      target: { value: 'Retry twice before falling back.' },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    })

    expect(submittedBody).toEqual({
      answers: {
        QF01: '',
        Q03: 'Retry twice before falling back.',
      },
      selectedOptions: {},
      skipReasons: {},
    })
  })

  it('filters stale selected choice IDs for skipped questions before submit', async () => {
    const batchKey = 'prom4:0:2'
    interviewData.session!.currentBatch = makeChoiceBatch()
    preSeededDrafts = {
      draftAnswers: { [batchKey]: { Q03: 'Retry twice before falling back.' } },
      skippedQuestions: { [batchKey]: ['QF01'] },
      selectedOptions: { [batchKey]: { QF01: ['database'] } },
    }

    renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)

    await waitFor(() => {
      expect(screen.getByText(/This question will be skipped/i)).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    })

    expect(submittedBody).toEqual({
      answers: {
        Q03: 'Retry twice before falling back.',
      },
      selectedOptions: {},
      skipReasons: {},
    })
  })

  it('listens for validated interview batch custom events', async () => {
    interviewData.session!.currentBatch = null
    const streamedBatch = makeBatch({
      questions: [
        {
          id: 'QNEW',
          phase: 'Operations',
          question: 'What deployment target is in scope?',
          source: 'compiled',
        },
      ],
    })

    renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)

    await waitFor(() => {
      expect(screen.getByText(/Waiting for the next interview questions/i)).toBeInTheDocument()
    })

    act(() => {
      window.dispatchEvent(new CustomEvent(INTERVIEW_BATCH_EVENT, {
        detail: {
          type: 'interview_batch',
          ticketId: TEST.ticketId,
          batch: { questions: 'not a batch' },
        },
      }))
    })

    expect(screen.queryByText('What deployment target is in scope?')).not.toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new CustomEvent(INTERVIEW_BATCH_EVENT, {
        detail: {
          type: 'interview_batch',
          ticketId: TEST.ticketId,
          batch: streamedBatch,
        },
      }))
    })

    await waitFor(() => {
      expect(screen.getByText('What deployment target is in scope?')).toBeInTheDocument()
    })
  })

  it('sends a per-question reason for a skipped question and drops it when the skip is undone', async () => {
    renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)

    await waitFor(() => {
      expect(screen.getByText('How will retries be tested?')).toBeInTheDocument()
    })

    fireEvent.click(screen.getAllByRole('button', { name: /skip question/i })[0]!)

    const reasonBox = await screen.findByLabelText(/why skip this/i)
    fireEvent.change(reasonBox, { target: { value: 'Already decided in the design doc.' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    })

    expect(submittedBody?.skipReasons).toEqual({ QF01: 'Already decided in the design doc.' })
  })

  it('discards a reason once the question is un-skipped', async () => {
    renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)

    await waitFor(() => {
      expect(screen.getByText('How will retries be tested?')).toBeInTheDocument()
    })

    fireEvent.click(screen.getAllByRole('button', { name: /skip question/i })[0]!)
    fireEvent.change(await screen.findByLabelText(/why skip this/i), {
      target: { value: 'A reason that stops applying.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /undo skip/i }))

    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Answered after all.' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    })

    expect(submittedBody?.skipReasons).toEqual({})
  })

  it('sends the bulk reason with Skip All', async () => {
    renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)

    await waitFor(() => {
      expect(screen.getByText('How will retries be tested?')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /skip all questions/i }))
    fireEvent.change(await screen.findByLabelText(/why skip the rest/i), {
      target: { value: 'Shipping before the demo.' },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /skip to approval/i }))
    })

    expect(skippedBody?.bulkSkipReason).toBe('Shipping before the demo.')
  })

  /**
   * A failed edit used to go to the console and nowhere else: the editor closed, the
   * rewritten answer was thrown away, and the old one stayed on screen looking saved.
   * The skip-all path beside it has always reported its failures.
   */
  describe('when editing a past answer fails', () => {
    async function openEditorForFirstAnswer() {
      renderWithProviders(<InterviewQAView ticket={makeTicket({ status: 'WAITING_INTERVIEW_ANSWERS' })} />)
      await waitFor(() => {
        expect(screen.getByText(/Interview History/i)).toBeInTheDocument()
      })
      fireEvent.click(screen.getByText(/Interview History/i))
      await waitFor(() => {
        expect(screen.getByText('Keep imports idempotent.')).toBeInTheDocument()
      })
      fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[0]!)
    }

    it('keeps the editor open with the reason and the rewritten text', async () => {
      const originalFetch = globalThis.fetch as typeof fetch
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/edit-answer`)) {
          return new Response(JSON.stringify({ error: 'Interview session is locked' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return originalFetch(input, init)
      }))

      await openEditorForFirstAnswer()
      const editor = screen.getByDisplayValue('Keep imports idempotent.')
      fireEvent.change(editor, { target: { value: 'Keep imports idempotent and ordered.' } })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
      })

      expect(await screen.findByRole('alert')).toHaveTextContent('Interview session is locked')
      expect(screen.getByDisplayValue('Keep imports idempotent and ordered.')).toBeInTheDocument()
    })

    it('closes the editor and clears the error once the edit lands', async () => {
      const originalFetch = globalThis.fetch as typeof fetch
      let shouldFail = true
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/edit-answer`)) {
          if (shouldFail) {
            shouldFail = false
            return new Response(JSON.stringify({ error: 'Interview session is locked' }), {
              status: 409,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          return createJsonResponse({ success: true, questions: [] })
        }
        return originalFetch(input, init)
      }))

      await openEditorForFirstAnswer()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
      })
      expect(await screen.findByRole('alert')).toBeInTheDocument()

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
      })

      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      })
    })
  })
})
