import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '@/hooks/useTickets'
import type { InterviewDocument } from '@shared/interviewArtifact'
import { makeTicket, TEST } from '@/test/factories'
import { createJsonResponse, renderWithProviders } from '@/test/renderHelpers'
import { ApprovalView } from '../ApprovalView'

const mockUseInterviewQuestions = vi.fn()
const mockUseTicketUIState = vi.fn()
const mockSaveUiState = vi.fn()
const mockClearTicketArtifactsCache = vi.fn()
const mockUseTicketArtifacts = vi.fn()

vi.mock('@/hooks/useTickets', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTickets')>('@/hooks/useTickets')
  return {
    ...actual,
    useInterviewQuestions: (...args: unknown[]) => mockUseInterviewQuestions(...args),
    useTicketUIState: (...args: unknown[]) => mockUseTicketUIState(...args),
    useSaveTicketUIState: () => ({ mutate: mockSaveUiState, mutateAsync: mockSaveUiState }),
  }
})

vi.mock('@/hooks/useTicketArtifacts', () => ({
  clearTicketArtifactsCache: (...args: unknown[]) => mockClearTicketArtifactsCache(...args),
  useTicketArtifacts: (...args: unknown[]) => mockUseTicketArtifacts(...args),
}))

vi.mock('../PhaseArtifactsPanel', () => ({
  PhaseArtifactsPanel: ({ prefixElement }: { prefixElement?: React.ReactNode }) => (
    <div data-testid="phase-artifacts-panel">{prefixElement}</div>
  ),
}))

vi.mock('../PrdApprovalPane', () => ({
  PrdApprovalPane: ({ ticket }: { ticket: Ticket }) => <div data-testid="prd-approval-pane">{ticket.id}</div>,
}))

vi.mock('../ExecutionSetupPlanApprovalPane', () => ({
  ExecutionSetupPlanApprovalPane: ({
    ticket,
    logPhaseAttempt,
    logMode,
  }: {
    ticket: Ticket
    logPhaseAttempt?: number
    logMode?: string
  }) => (
    <div
      data-testid="execution-setup-plan-approval-pane"
      data-phase-attempt={logPhaseAttempt ?? 'active'}
      data-log-mode={logMode ?? 'live'}
    >
      {ticket.id}
    </div>
  ),
}))

vi.mock('../PhaseLogPanel', () => ({
  PhaseLogPanel: () => <div data-testid="phase-log-panel" />,
}))

vi.mock('../VerticalResizeHandle', () => ({
  VerticalResizeHandle: () => <div data-testid="resize-handle" />,
}))

vi.mock('../CollapsiblePhaseLogSection', () => ({
  CollapsiblePhaseLogSection: ({
    phaseAttempt,
    logMode,
  }: {
    phaseAttempt?: number
    logMode?: string
  }) => (
    <div
      data-testid="collapsible-log-section"
      data-phase-attempt={phaseAttempt ?? 'active'}
      data-log-mode={logMode ?? 'live'}
    />
  ),
}))

vi.mock('@/components/editor/YamlEditor', () => ({
  YamlEditor: ({
    value,
    onChange,
    className,
  }: {
    value: string
    onChange: (value: string) => void
    className?: string
  }) => (
    <textarea
      aria-label="YAML editor"
      className={className}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

function renderApprovalView(ticket: Ticket, artifactType: 'interview' | 'prd' | 'beads' | 'execution_setup_plan' = 'interview') {
  return renderWithProviders(<ApprovalView ticket={ticket} artifactType={artifactType} />)
}

function buildInterviewDocument(answer: string): InterviewDocument {
  return {
    schema_version: 1,
    ticket_id: TEST.externalId,
    artifact: 'interview',
    status: 'draft',
    generated_by: {
      winner_model: 'openai/gpt-5',
      generated_at: '2026-03-17T10:00:00.000Z',
      canonicalization: 'server_normalized',
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
          free_text: answer,
          answered_by: 'user',
          answered_at: '2026-03-17T10:05:00.000Z', skip_reason: null,
        },
      },
    ],
    follow_up_rounds: [],
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
  }
}

function buildInterviewYaml(answer: string): string {
  return [
    'schema_version: 1',
    `ticket_id: ${TEST.externalId}`,
    'artifact: interview',
    'status: draft',
    'generated_by:',
    '  winner_model: openai/gpt-5',
    '  generated_at: 2026-03-17T10:00:00.000Z',
    'questions:',
    '  - id: Q01',
    '    phase: Foundation',
    '    prompt: What outcome matters most?',
    '    source: compiled',
    '    follow_up_round: null',
    '    answer_type: free_text',
    '    options: []',
    '    answer:',
    '      skipped: false',
    '      selected_option_ids: []',
    `      free_text: ${JSON.stringify(answer)}`,
    '      answered_by: user',
    '      answered_at: 2026-03-17T10:05:00.000Z',
    'follow_up_rounds: []',
    'summary:',
    '  goals: [Protect imports]',
    '  constraints: [No duplicate records]',
    '  non_goals: [Bulk reprocessing]',
    '  final_free_form_answer: ""',
    'approval:',
    '  approved_by: ""',
    '  approved_at: ""',
  ].join('\n')
}

function buildInterviewPayload(answer: string) {
  return {
    winnerId: 'openai/gpt-5',
    raw: buildInterviewYaml(answer),
    document: buildInterviewDocument(answer),
    session: null,
    questions: [],
  }
}

function buildSkippedInterviewPayload() {
  const document = buildInterviewDocument('')
  document.questions = [{
    ...document.questions[0]!,
    answer: {
      skipped: true,
      selected_option_ids: [],
      free_text: '',
      answered_by: 'ai_skip',
      answered_at: '', skip_reason: null,
    },
  }]

  return {
    winnerId: 'openai/gpt-5',
    raw: [
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: openai/gpt-5',
      '  generated_at: 2026-03-17T10:00:00.000Z',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: What outcome matters most?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: ai_skip',
      '      answered_at: ""',
      'follow_up_rounds: []',
      'summary:',
      '  goals: [Protect imports]',
      '  constraints: [No duplicate records]',
      '  non_goals: [Bulk reprocessing]',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n'),
    document,
    session: null,
    questions: [],
  }
}

describe('Interview approval UI', () => {
  let interviewPayload = buildInterviewPayload('Protect the import pipeline.')

  function openFoundationSection() {
    const foundationLabels = screen.getAllByText('Foundation')
    fireEvent.click(foundationLabels[foundationLabels.length - 1]!.closest('button')!)
  }

  function clickHeaderEditButton() {
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/ })[0]!)
  }

  beforeEach(() => {
    interviewPayload = buildInterviewPayload('Protect the import pipeline.')
    mockUseInterviewQuestions.mockImplementation(() => ({
      data: interviewPayload,
      isLoading: false,
    }))
    mockUseTicketUIState.mockReturnValue({
      isSuccess: true,
      data: { scope: 'approval_interview', exists: false, data: null, updatedAt: null },
    })
    mockSaveUiState.mockReset()
    mockClearTicketArtifactsCache.mockReset()
    mockUseTicketArtifacts.mockReset()
    mockUseTicketArtifacts.mockReturnValue({ artifacts: [], isLoading: false })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('opens edit mode on the friendly Answers tab and saves answer-only edits', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`) {
        return createJsonResponse([])
      }
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/interview-answers` && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          questions: Array<{ id: string; answer: { free_text: string } }>
        }
        const nextAnswer = body.questions.find((question) => question.id === 'Q01')?.answer.free_text ?? ''
        interviewPayload = buildInterviewPayload(nextAnswer)
        return createJsonResponse({ success: true, ...interviewPayload })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderApprovalView(makeTicket({ status: 'WAITING_INTERVIEW_APPROVAL' }))

    openFoundationSection()
    expect(screen.getByText('Protect the import pipeline.')).toBeInTheDocument()

    clickHeaderEditButton()

    expect(screen.getByText('Answer-only editor')).toBeInTheDocument()
    expect(screen.getByText(/Draft autosave on/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.queryByLabelText('YAML editor')).not.toBeInTheDocument()
    openFoundationSection()
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Update the recorded answer.')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByPlaceholderText('Update the recorded answer.'), {
      target: { value: 'Protect the import pipeline and keep logs reversible.' },
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/tickets/${encodeURIComponent(TEST.ticketId)}/interview-answers`,
        expect.objectContaining({ method: 'PUT' }),
      )
    })
    expect(mockClearTicketArtifactsCache).toHaveBeenCalledWith(
      expect.anything(),
      TEST.ticketId,
    )
  }, 30_000)

  it('strips selected option IDs from skipped answer drafts before saving', async () => {
    let submittedBody: { questions: Array<{ id: string; answer: { skipped: boolean; selected_option_ids: string[]; free_text: string } }> } | null = null
    mockUseTicketUIState.mockReturnValue({
      isSuccess: true,
      data: {
        scope: 'approval_interview',
        exists: true,
        updatedAt: '2026-03-17T10:20:00.000Z',
        data: {
          isEditMode: true,
          editTab: 'answers',
          answerDrafts: {
            Q01: {
              skipped: true,
              selected_option_ids: ['stale-choice'],
              free_text: 'stale notes',
            },
          },
        },
      },
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`) {
        return createJsonResponse([])
      }
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/interview-answers` && init?.method === 'PUT') {
        submittedBody = JSON.parse(String(init.body)) as typeof submittedBody
        return createJsonResponse({ success: true, ...interviewPayload })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderApprovalView(makeTicket({ status: 'WAITING_INTERVIEW_APPROVAL' }))

    await waitFor(() => {
      expect(screen.getByText('Answer-only editor')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(submittedBody?.questions[0]).toEqual({
        id: 'Q01',
        answer: {
          skip_reason: null,
          skipped: true,
          selected_option_ids: [],
          free_text: '',
        },
      })
    })
  })

  it('explains skipped answers using the actual PRD drafting behavior', async () => {
    interviewPayload = buildSkippedInterviewPayload()

    renderApprovalView(makeTicket({ status: 'WAITING_INTERVIEW_APPROVAL' }))

    const notice = screen.getByRole('note')
    expect(notice).toHaveTextContent('Some interview questions were skipped. That is OK')
    expect(notice).toHaveTextContent('PRD drafting will first create per-model Full Answers artifacts')
    expect(notice).toHaveTextContent('fills only those skipped answers using the ticket details, relevant files, and the rest of the interview')
    expect(notice).toHaveTextContent('edit the interview before approving')
    expect(screen.queryByText(/isApproving/)).not.toBeInTheDocument()
  })

  it('routes PRD approvals to the dedicated pane', async () => {
    renderApprovalView(makeTicket({ status: 'WAITING_PRD_APPROVAL' }), 'prd')

    expect(screen.getByTestId('prd-approval-pane')).toBeInTheDocument()
  })

  it('routes execution setup plan approvals to the dedicated pane', async () => {
    renderApprovalView(makeTicket({ status: 'WAITING_EXECUTION_SETUP_APPROVAL' }), 'execution_setup_plan')

    expect(screen.getByTestId('execution-setup-plan-approval-pane')).toBeInTheDocument()
  })

  it('shows the Interview cascade warning copy after PRD and Beads planning have started', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`) {
        return createJsonResponse([])
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderApprovalView(makeTicket({ status: 'WAITING_BEADS_APPROVAL' }))

    clickHeaderEditButton()

    expect(screen.getByText('Cascading Edit Warning')).toBeInTheDocument()
    expect(screen.getByText('Saving this Interview edit will restart PRD/specs planning and Beads planning from the edited Interview. Previous PRD and Beads versions will be archived and remain available read-only.')).toBeInTheDocument()
    expect(screen.queryByText('Answer-only editor')).not.toBeInTheDocument()
  })

  it('defaults the version selector to the active Interview approval version and routes archived versions to read-only history', async () => {
    mockUseTicketArtifacts.mockImplementation((_ticketId: string, options?: { phaseAttempt?: number }) => ({
      artifacts: options?.phaseAttempt === 1
        ? [
          {
            id: 301,
            ticketId: TEST.ticketId,
            phase: 'WAITING_INTERVIEW_APPROVAL',
            artifactType: 'approval_snapshot:interview',
            filePath: null,
            createdAt: TEST.timestamp,
            content: JSON.stringify({ raw: buildInterviewYaml('Archived approved answer.') }),
          },
        ]
        : [],
      isLoading: false,
    }))

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/phases/WAITING_INTERVIEW_APPROVAL/attempts`) {
        return createJsonResponse([
          {
            ticketId: TEST.ticketId,
            phase: 'WAITING_INTERVIEW_APPROVAL',
            attemptNumber: 1,
            state: 'archived',
            archivedReason: 'superseded_by_edit',
            createdAt: TEST.timestamp,
            archivedAt: TEST.timestamp,
          },
          {
            ticketId: TEST.ticketId,
            phase: 'WAITING_INTERVIEW_APPROVAL',
            attemptNumber: 2,
            state: 'active',
            archivedReason: null,
            createdAt: TEST.timestamp,
            archivedAt: null,
          },
        ])
      }
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`) {
        return createJsonResponse([])
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderApprovalView(makeTicket({ status: 'WAITING_INTERVIEW_APPROVAL' }))

    const selector = await screen.findByRole('combobox', { name: /version/i })
    expect(selector).toHaveValue('2')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByTestId('collapsible-log-section')).toHaveAttribute('data-phase-attempt', '2')
    expect(screen.getByTestId('collapsible-log-section')).toHaveAttribute('data-log-mode', 'live')

    fireEvent.change(selector, { target: { value: '1' } })

    expect(await screen.findByText('This archived attempt is read-only. You can inspect and copy its content, but it can no longer be used by the workflow.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.getByTestId('collapsible-log-section')).toHaveAttribute('data-phase-attempt', '1')
    expect(screen.getByTestId('collapsible-log-section')).toHaveAttribute('data-log-mode', 'snapshot')

    openFoundationSection()
    expect(screen.getByText('Archived approved answer.')).toBeInTheDocument()
    expect(mockUseTicketArtifacts).toHaveBeenCalledWith(TEST.ticketId, expect.objectContaining({ phaseAttempt: 1 }))
  }, 30_000)

  it('lets the interview summary collapse and reopen in approval view', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`) {
        return createJsonResponse([])
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderApprovalView(makeTicket({ status: 'WAITING_INTERVIEW_APPROVAL' }))

    expect(screen.getByText('Final Free-Form Answer')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Interview Summary/i }))
    expect(screen.queryByText('Final Free-Form Answer')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Interview Summary/i }))
    expect(screen.getByText('Final Free-Form Answer')).toBeInTheDocument()
  })

  it('confirms before switching from dirty answer edits to the YAML tab and resets to the last saved artifact', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`) {
        return createJsonResponse([])
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderApprovalView(makeTicket({ status: 'WAITING_INTERVIEW_APPROVAL' }))

    clickHeaderEditButton()
    openFoundationSection()
    fireEvent.change(screen.getByPlaceholderText('Update the recorded answer.'), {
      target: { value: 'Unsaved answer draft.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'YAML' }))

    expect(screen.getByText('Discard unsaved interview edits?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' }))

    const editor = await screen.findByLabelText('YAML editor')
    expect(editor).toHaveValue(buildInterviewYaml('Protect the import pipeline.'))
    expect(screen.queryByDisplayValue('Unsaved answer draft.')).not.toBeInTheDocument()
  }, 30_000)

  it('shows local YAML validation feedback and saves valid YAML edits', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`) {
        return createJsonResponse([])
      }
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/phases/WAITING_INTERVIEW_APPROVAL/attempts`) {
        return createJsonResponse([{
          ticketId: TEST.ticketId,
          phase: 'WAITING_INTERVIEW_APPROVAL',
          attemptNumber: 1,
          state: 'active',
          archivedReason: null,
          createdAt: TEST.timestamp,
          archivedAt: null,
        }])
      }
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/interview` && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { content: string }
        interviewPayload = body.content.includes('Updated from YAML.')
          ? buildInterviewPayload('Updated from YAML.')
          : interviewPayload
        return createJsonResponse({ success: true, ...interviewPayload })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderApprovalView(makeTicket({ status: 'WAITING_INTERVIEW_APPROVAL' }))
    fetchSpy.mockClear()

    clickHeaderEditButton()
    fireEvent.click(screen.getByRole('button', { name: 'YAML' }))

    const editor = await screen.findByLabelText('YAML editor')
    fireEvent.change(editor, { target: { value: 'artifact: interview\nquestions: [' } })

    expect(screen.getByText(/unexpected end of the stream|could not be parsed/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(fetchSpy).not.toHaveBeenCalled()

    fireEvent.change(editor, { target: { value: buildInterviewYaml('Updated from YAML.') } })
    expect(screen.getByText(/YAML looks structurally valid/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    })
    openFoundationSection()
    await waitFor(() => {
      expect(screen.getByText('Updated from YAML.')).toBeInTheDocument()
    })
  }, 30_000)

  it('shows a loading state instead of briefly rendering raw YAML while interview data is refetching', async () => {
    mockUseInterviewQuestions.mockImplementation(() => ({
      data: {
        winnerId: 'openai/gpt-5',
        raw: 'questions:\n  - id: Q01\n    question: Old compiled question',
        document: null,
        session: null,
        questions: [],
      },
      isLoading: false,
      isFetching: true,
    }))

    renderApprovalView(makeTicket({ status: 'WAITING_INTERVIEW_APPROVAL' }))

    expect(screen.getByText('Building the structured approval view.')).toBeInTheDocument()
    expect(screen.queryByText(/schema_version: 1/i)).not.toBeInTheDocument()
  }, 30_000)

  it('uses the shared bead renderer with nested metadata in beads approval view', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/beads`) {
        return createJsonResponse([
          {
            id: 'proj-1-review-approval-metadata',
            title: 'Review approval metadata',
            status: 'pending',
            targetFiles: ['src/components/workspace/ApprovalView.tsx'],
          },
        ])
      }
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`) {
        return createJsonResponse([])
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderApprovalView(makeTicket({ status: 'WAITING_BEADS_APPROVAL' }), 'beads')

    expect(screen.queryByText(/^pending$/i)).not.toBeInTheDocument()

    fireEvent.click((await screen.findByText('Review approval metadata')).closest('button')!)

    expect(screen.getByText('Target Files')).toBeInTheDocument()
    expect(screen.getByText('src/components/workspace/ApprovalView.tsx')).toBeInTheDocument()
    const metadataButton = screen.getByRole('button', { name: /^Metadata$/i })
    expect(metadataButton).toBeInTheDocument()
    expect(screen.queryByText('Issue Type')).not.toBeInTheDocument()

    fireEvent.click(metadataButton)

    expect(screen.getByText('Issue Type')).toBeInTheDocument()
    expect(screen.getByText('Lifecycle')).toBeInTheDocument()
    expect(screen.getByText(/^pending$/i)).toBeInTheDocument()
  }, 30_000)

  it('shows draft autosave status and retains Save in beads edit mode', async () => {
    mockUseTicketUIState.mockReturnValue({
      isSuccess: true,
      data: {
        scope: 'approval_beads',
        exists: true,
        data: { isEditMode: true, editTab: 'structured' },
        updatedAt: TEST.timestamp,
      },
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/beads`) {
        return createJsonResponse([{ id: 'bead-1', title: 'Autosaved bead', status: 'pending' }])
      }
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`) return createJsonResponse([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderApprovalView(makeTicket({ status: 'WAITING_BEADS_APPROVAL' }), 'beads')

    expect(await screen.findByText(/Draft autosave on/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  /**
   * The beads pane restored as soon as the beads themselves arrived, without
   * waiting for the UI-state query. `data` is undefined while that query is in
   * flight *and* when there is no draft, so the pane latched on defaults and
   * discarded the draft that landed a moment later — then autosaved those
   * defaults over it.
   *
   * A failed request counts as fetched, so the gate is `isSuccess`: a UI-state
   * request that errored must not latch the pane either.
   */
  it('waits for the beads draft query to succeed before restoring', async () => {
    mockUseTicketUIState.mockReturnValue({
      isSuccess: false,
      data: undefined,
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/beads`) {
        return createJsonResponse([{ id: 'bead-1', title: 'Autosaved bead', status: 'pending' }])
      }
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`) return createJsonResponse([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const ticket = makeTicket({ status: 'WAITING_BEADS_APPROVAL' })
    const { rerender } = renderApprovalView(ticket, 'beads')

    expect(await screen.findByText('Autosaved bead')).toBeInTheDocument()
    // Not restored, so the autosave stays disarmed and cannot overwrite the
    // draft this pane has not read yet.
    expect(screen.queryByText(/Draft autosave on/)).not.toBeInTheDocument()

    mockUseTicketUIState.mockReturnValue({
      isSuccess: true,
      data: {
        scope: 'approval_beads',
        exists: true,
        data: { isEditMode: true, editTab: 'structured' },
        updatedAt: TEST.timestamp,
      },
    })
    rerender(<ApprovalView ticket={ticket} artifactType="beads" />)

    expect(await screen.findByText(/Draft autosave on/)).toBeInTheDocument()
  })

  it('shows unresolved beads coverage gaps as a collapsible warning during approval', async () => {
    mockUseTicketArtifacts.mockReturnValue({
      artifacts: [
        {
          id: 902,
          ticketId: TEST.ticketId,
          phase: 'WAITING_BEADS_APPROVAL',
          artifactType: 'beads_coverage',
          filePath: null,
          createdAt: '2026-04-03T14:25:00.000Z',
          content: JSON.stringify({
            status: 'gaps',
            summary: 'Coverage gaps remain after the final implementation-plan audit.',
            finalCandidateVersion: 3,
            hasRemainingGaps: true,
            remainingGaps: [
              'Missing a bead that verifies the approval warning behavior when gaps remain.',
            ],
            auditNotes: 'status: gaps\ngaps:\n  - Missing a bead that verifies the approval warning behavior when gaps remain.',
          }),
        },
      ],
      isLoading: false,
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/beads`) {
        return Promise.resolve(
          new Response(JSON.stringify([
            {
              id: 'proj-1-coverage-warning',
              title: 'Render coverage warning state',
            },
          ]), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'X-Content-Sha256': 'a'.repeat(64),
            },
          }),
        )
      }
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`) {
        return createJsonResponse([])
      }
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/coverage/fix-gaps` && init?.method === 'POST') {
        return createJsonResponse({ result: { status: 'gaps', remainingGaps: ['Still missing beads coverage.'] } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderApprovalView(makeTicket({ status: 'WAITING_BEADS_APPROVAL' }), 'beads')

    const warningToggle = await screen.findByRole('button', { name: /Coverage Warning/i })
    expect(warningToggle).toBeInTheDocument()
    expect(warningToggle.closest('.overflow-auto')).not.toBeNull()
    expect(screen.queryByText('Remaining Gaps')).not.toBeInTheDocument()

    fireEvent.click(warningToggle)

    expect(screen.getByText('Coverage gaps remain after the final implementation-plan audit.')).toBeInTheDocument()
    expect(screen.getByText('Implementation Plan v3')).toBeInTheDocument()
    expect(screen.getByText('Missing a bead that verifies the approval warning behavior when gaps remain.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fix gaps with AI' })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Approve with gaps/i })).not.toBeDisabled()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Fix gaps with AI' }))

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/tickets/${encodeURIComponent(TEST.ticketId)}/coverage/fix-gaps`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ domain: 'beads' }),
        }),
      )
    })
    // The fetch having been *called* is not the fetch having settled, and the
    // button stays disabled for as long as the request is in flight. Asserting
    // synchronously here reads whichever render happens to be current.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Approve with gaps/i })).not.toBeDisabled()
    })
  }, 30_000)
})

describe('Read-only approval attempts', () => {
  beforeEach(() => {
    mockUseInterviewQuestions.mockReset()
    mockUseInterviewQuestions.mockImplementation(() => ({ data: undefined, isLoading: false }))
    mockUseTicketUIState.mockReturnValue({
      isSuccess: true,
      data: { scope: 'approval_prd', exists: false, data: null, updatedAt: null },
    })
    mockUseTicketArtifacts.mockReset()
    mockUseTicketArtifacts.mockReturnValue({ artifacts: [], isLoading: false })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('does not ask the interview endpoint about a PRD attempt', async () => {
    // The interview query says nothing about a PRD or a bead plan, so leaving it
    // enabled cost a request per open and surfaced an interview failure on the
    // wrong artifact.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith('/attempts')) return createJsonResponse([])
      if (url === `/api/files/${encodeURIComponent(TEST.ticketId)}/prd`) {
        return createJsonResponse({ content: 'problem: keep it steady' })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderWithProviders(
      <ApprovalView ticket={makeTicket({ status: 'WAITING_PRD_APPROVAL' })} artifactType="prd" readOnly />,
    )

    await waitFor(() => expect(mockUseInterviewQuestions).toHaveBeenCalled())
    expect(mockUseInterviewQuestions).toHaveBeenCalledWith(TEST.ticketId, { enabled: false })
    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/interview'))).toBe(false)
    })
  })

  it('says the PRD request failed instead of drawing an empty artifact', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith('/attempts')) return createJsonResponse([])
      if (url === `/api/files/${encodeURIComponent(TEST.ticketId)}/prd`) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Artifact store unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderWithProviders(
      <ApprovalView ticket={makeTicket({ status: 'WAITING_PRD_APPROVAL' })} artifactType="prd" readOnly />,
    )

    expect(await screen.findByText('This artifact could not be loaded.')).toBeInTheDocument()
    expect(screen.getByText('Failed to load PRD (HTTP 503: Artifact store unavailable)')).toBeInTheDocument()
    expect(screen.queryByText('No PRD artifact available.')).not.toBeInTheDocument()
  })
})

describe('Approval surfaces on a failed request', () => {
  beforeEach(() => {
    mockUseInterviewQuestions.mockReset()
    mockUseInterviewQuestions.mockImplementation(() => ({ data: undefined, isLoading: false }))
    mockUseTicketUIState.mockReturnValue({
      isSuccess: true,
      data: { scope: 'approval_beads', exists: false, data: null, updatedAt: null },
    })
    mockUseTicketArtifacts.mockReset()
    mockUseTicketArtifacts.mockReturnValue({ artifacts: [], isLoading: false })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('says the version history failed instead of showing one attempt', async () => {
    // Resolving to `[]` hid the selector and silently scoped every artifact and
    // log to the live attempt — the wrong version, with nothing saying so.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith('/attempts')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Database is locked' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/beads`) return createJsonResponse([])
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`) return createJsonResponse([])
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderApprovalView(makeTicket({ status: 'WAITING_BEADS_APPROVAL' }), 'beads')

    expect(await screen.findByText('The version history for this phase could not be loaded.')).toBeInTheDocument()
    expect(screen.getByText('Unable to load phase attempts (HTTP 500: Database is locked)')).toBeInTheDocument()
  })

  it('says the beads request failed instead of "no beads artifact available yet"', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith('/attempts')) return createJsonResponse([])
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`) return createJsonResponse([])
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/beads`) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Corrupted JSONL data' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderApprovalView(makeTicket({ status: 'WAITING_BEADS_APPROVAL' }), 'beads')

    expect(await screen.findByText('The beads artifact could not be loaded.')).toBeInTheDocument()
    expect(screen.getByText('Failed to load beads (HTTP 500: Corrupted JSONL data)')).toBeInTheDocument()
    expect(screen.queryByText('No beads artifact available yet.')).not.toBeInTheDocument()
  })

  it('will not approve while the coverage answer is unknown', async () => {
    // Coverage gaps live in the artifacts. A failed request made the warning
    // absent, which reads exactly like "no gaps" — so the button said "Approve"
    // and the operator approved without the question having been answered.
    mockUseTicketArtifacts.mockReturnValue({
      artifacts: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Failed to load ticket artifacts (HTTP 503: busy)'),
      refetch: vi.fn(),
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith('/attempts')) return createJsonResponse([])
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/beads`) {
        // With the content hash present the button would otherwise be enabled,
        // so the assertion below is about coverage and nothing else.
        return Promise.resolve(new Response(
          JSON.stringify([{ id: 'b1', title: 'One', status: 'pending', iteration: 0 }]),
          { status: 200, headers: { 'Content-Type': 'application/json', 'X-Content-Sha256': 'abc' } },
        ))
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    renderApprovalView(makeTicket({ status: 'WAITING_BEADS_APPROVAL' }), 'beads')

    expect(await screen.findByText('Coverage could not be checked, so this plan cannot be approved yet.')).toBeInTheDocument()
    // The beads have to have arrived before the button means anything: an empty
    // list disables it too, which would make this assertion pass for the wrong
    // reason.
    await waitFor(() => expect(screen.queryByText('No beads artifact available yet.')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.queryByText('Loading beads…')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeDisabled()
  })
})
