import { QueryClient } from '@tanstack/react-query'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { InterviewSessionView } from '@shared/interviewSession'
import { TEST } from '@/test/factories'
import { renderWithProviders as sharedRenderWithProviders } from '@/test/renderHelpers'
import { InterviewApprovalNavigator } from '../InterviewApprovalNavigator'

function buildInterviewData(): InterviewSessionView {
  return {
    winnerId: 'openai/gpt-5',
    raw: null,
    document: {
      schema_version: 1,
      ticket_id: TEST.externalId,
      artifact: 'interview',
      status: 'draft',
      generated_by: {
        winner_model: 'openai/gpt-5',
        generated_at: '2026-03-17T10:00:00.000Z',
      },
      questions: [
        {
          id: 'Q01',
          phase: 'Foundation',
          prompt: 'What outcome matters most?',
          source: 'compiled',
          follow_up_round: null,
          answer_type: 'free_text',
          options: [],
          answer: {
            skipped: false,
            selected_option_ids: [],
            free_text: 'Protect imports.',
            answered_by: 'user',
            answered_at: '2026-03-17T10:05:00.000Z', skip_reason: null,
          },
        },
        {
          id: 'CF01',
          phase: 'Assembly',
          prompt: 'How should retries be tested?',
          source: 'coverage_follow_up',
          follow_up_round: 1,
          answer_type: 'free_text',
          options: [],
          answer: {
            skipped: true,
            selected_option_ids: [],
            free_text: '',
            answered_by: 'ai_skip',
            answered_at: '', skip_reason: null,
          },
        },
      ],
      follow_up_rounds: [
        {
          round_number: 1,
          source: 'coverage',
          question_ids: ['CF01'],
        },
      ],
      summary: {
        goals: ['Protect imports'],
        constraints: ['No duplicate records'],
        non_goals: ['Bulk reprocessing'],
        final_free_form_answer: '',
      },
      approval: {
        approved_by: '',
        approved_at: '',
      },
    },
    session: null,
    questions: [],
  }
}

function renderWithProviders(ui: React.ReactElement, data: InterviewSessionView) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
    },
  })
  queryClient.setQueryData(['interview', TEST.ticketId], data)

  return sharedRenderWithProviders(ui, { queryClient })
}

describe('InterviewApprovalNavigator', () => {
  it('renders interview result sections and dispatches approval focus events', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    renderWithProviders(<InterviewApprovalNavigator ticketId={TEST.ticketId} />, buildInterviewData())

    await waitFor(() => {
      expect(screen.getByText('Summary')).toBeInTheDocument()
    })

    expect(screen.getByText('Foundation')).toBeInTheDocument()
    expect(screen.getByText('Coverage Follow-ups · Round 1')).toBeInTheDocument()
    expect(screen.getByText('Follow-up Rounds')).toBeInTheDocument()
    fireEvent.click(screen.getByText('How should retries be tested?').closest('button')!)

    const focusEvent = dispatchSpy.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'looptroop:interview-approval-focus') as CustomEvent<{ ticketId: string; anchorId: string }> | undefined

    expect(focusEvent?.detail).toEqual({
      ticketId: TEST.ticketId,
      anchorId: 'interview-question-cf01',
    })
  })

  it('shows phase-specific descriptions for compiled interview sections', async () => {
    const data = buildInterviewData()
    data.document!.questions.splice(1, 0,
      {
        id: 'Q02',
        phase: 'Structure',
        prompt: 'Which workflow boundaries are fixed?',
        source: 'compiled',
        follow_up_round: null,
        answer_type: 'free_text',
        options: [],
        answer: {
          skipped: false,
          selected_option_ids: [],
          free_text: 'Imports stay inside the sync worker.',
          answered_by: 'user',
          answered_at: '2026-03-17T10:06:00.000Z', skip_reason: null,
        },
      },
      {
        id: 'Q03',
        phase: 'Assembly',
        prompt: 'Which integration points need validation?',
        source: 'compiled',
        follow_up_round: null,
        answer_type: 'free_text',
        options: [],
        answer: {
          skipped: false,
          selected_option_ids: [],
          free_text: 'Validate retries and dedupe behavior.',
          answered_by: 'user',
          answered_at: '2026-03-17T10:07:00.000Z', skip_reason: null,
        },
      },
    )

    renderWithProviders(<InterviewApprovalNavigator ticketId={TEST.ticketId} />, data)

    await waitFor(() => {
      expect(screen.getByText('Structure')).toBeInTheDocument()
    })

    expect(screen.getByText('Problem framing, goals, and constraints established in the approved interview.')).toBeInTheDocument()
    expect(screen.getByText('System shape, workflows, and boundaries defined in the approved interview.')).toBeInTheDocument()
    expect(screen.getByText('Implementation details, integrations, and delivery considerations captured in the approved interview.')).toBeInTheDocument()
  })

  it('hides the summary entry when the interview summary has no content', async () => {
    const data = buildInterviewData()
    data.document!.summary = {
      goals: [],
      constraints: [],
      non_goals: [],
      final_free_form_answer: '',
    }

    renderWithProviders(<InterviewApprovalNavigator ticketId={TEST.ticketId} />, data)

    await waitFor(() => {
      expect(screen.getByText('Foundation')).toBeInTheDocument()
    })

    expect(screen.queryByText('Summary')).not.toBeInTheDocument()
    expect(screen.getByText('Coverage Follow-ups · Round 1')).toBeInTheDocument()
  })

  it('keeps answered compiled questions visible alongside remapped coverage follow-ups', async () => {
    const data = buildInterviewData()
    data.document!.questions[1] = {
      id: 'CFU1',
      phase: 'Assembly',
      prompt: 'Which remaining coverage detail still needs a fallback?',
      source: 'coverage_follow_up',
      follow_up_round: 1,
      answer_type: 'free_text',
      options: [],
      answer: {
        skipped: true,
        selected_option_ids: [],
        free_text: '',
        answered_by: 'ai_skip',
        answered_at: '', skip_reason: null,
      },
    }
    data.document!.follow_up_rounds = [{
      round_number: 1,
      source: 'coverage',
      question_ids: ['CFU1'],
    }]

    renderWithProviders(<InterviewApprovalNavigator ticketId={TEST.ticketId} />, data)

    await waitFor(() => {
      expect(screen.getByText('Foundation')).toBeInTheDocument()
    })

    expect(screen.getByText('Coverage Follow-ups · Round 1')).toBeInTheDocument()
    expect(screen.getByText('What outcome matters most?')).toBeInTheDocument()
    expect(screen.getByText('Which remaining coverage detail still needs a fallback?')).toBeInTheDocument()
  })
})
