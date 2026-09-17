import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InterviewDocument } from '@shared/interviewArtifact'
import { makeTicket, TEST } from '@/test/factories'
import { renderWithProviders } from '@/test/renderHelpers'
import { InterviewApprovalPane } from '../InterviewApprovalPane'

const mockSaveUiState = vi.fn()
const mockClearTicketArtifactsCache = vi.fn()
const INITIAL_CONTENT_HASH = 'a'.repeat(64)
const SAVED_CONTENT_HASH = 'b'.repeat(64)
let persistedUiStateData: unknown = null
let persistedUiStateMeta: Record<string, unknown> = {}
let currentRaw = ''
let currentContentSha256 = INITIAL_CONTENT_HASH

function buildInterviewDocument(answer: string): InterviewDocument {
  return {
    schema_version: 1,
    ticket_id: TEST.externalId,
    artifact: 'interview',
    status: 'draft',
    generated_by: {
      winner_model: 'test-model',
      generated_at: '2026-01-01T00:00:00.000Z',
    },
    questions: [{
      id: 'Q01',
      phase: 'Foundation',
      prompt: 'What matters?',
      source: 'compiled',
      follow_up_round: null,
      answer_type: 'free_text',
      options: [],
      answer: {
        skipped: false,
        selected_option_ids: [],
        free_text: answer,
        answered_by: 'user',
        answered_at: '2026-01-01T00:00:00.000Z',
        skip_reason: null,
      },
    }],
    follow_up_rounds: [],
    summary: { goals: [], constraints: [], non_goals: [], final_free_form_answer: '' },
    approval: { approved_by: '', approved_at: '' },
  }
}

const document = buildInterviewDocument('Test answer.')

vi.mock('@/hooks/useTickets', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useTickets')>('@/hooks/useTickets')
  return {
    ...actual,
    useInterviewQuestions: () => ({
      data: { raw: currentRaw, contentSha256: currentContentSha256, document },
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useTicketUIState: () => ({
      isSuccess: true,
      data: { scope: 'approval_interview', exists: true, data: persistedUiStateData, updatedAt: null, ...persistedUiStateMeta },
    }),
    useSaveTicketUIState: () => ({ mutate: mockSaveUiState, mutateAsync: mockSaveUiState }),
  }
})

vi.mock('@/hooks/useTicketArtifacts', () => ({
  clearTicketArtifactsCache: (...args: unknown[]) => mockClearTicketArtifactsCache(...args),
}))

vi.mock('@/components/editor/YamlEditor', () => ({
  YamlEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="YAML editor" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))

vi.mock('../CollapsiblePhaseLogSection', () => ({
  CollapsiblePhaseLogSection: () => <div data-testid="phase-log-section" />,
}))

describe('InterviewApprovalPane', () => {
  beforeEach(() => {
    currentRaw = JSON.stringify(document)
    currentContentSha256 = INITIAL_CONTENT_HASH
    persistedUiStateData = null
    persistedUiStateMeta = {}
    mockSaveUiState.mockReset()
    mockSaveUiState.mockResolvedValue({ success: true, conflict: false, updatedAt: null })
    mockClearTicketArtifactsCache.mockReset()

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/interview` && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { content?: string }
        currentRaw = body.content ?? currentRaw
        currentContentSha256 = SAVED_CONTENT_HASH
        return Promise.resolve(new Response(JSON.stringify({ raw: currentRaw, content: currentRaw, contentSha256: currentContentSha256, document }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      if (url === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/ui-state` && init?.method === 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({ success: true, conflict: false, updatedAt: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }))
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps a restored dirty YAML draft tied to its original content hash', async () => {
    const originalRaw = currentRaw
    currentRaw = originalRaw.replace('Test answer.', 'Remote answer.')
    currentContentSha256 = SAVED_CONTENT_HASH
    persistedUiStateData = {
      isEditMode: true,
      editTab: 'yaml',
      yamlDraft: originalRaw.replace('Test answer.', 'Local edit based on A.'),
      contentSha256: INITIAL_CONTENT_HASH,
    }

    renderWithProviders(<InterviewApprovalPane ticket={makeTicket({ status: 'WAITING_INTERVIEW_APPROVAL' })} />)
    await screen.findByLabelText('YAML editor')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find((entry) => entry[1]?.method === 'PUT')
      expect(call).toBeDefined()
      expect(JSON.parse(String(call?.[1]?.body)).expectedContentSha256).toBe(INITIAL_CONTENT_HASH)
    })
  })

  it('restores a failed retained flush as recoverable dirty state', async () => {
    persistedUiStateMeta = { flushFailed: true }
    persistedUiStateData = {
      isEditMode: true,
      editTab: 'yaml',
      yamlDraft: currentRaw.replace('Test answer.', 'Retained after leaving.'),
      contentSha256: INITIAL_CONTENT_HASH,
    }

    renderWithProviders(<InterviewApprovalPane ticket={makeTicket({ status: 'WAITING_INTERVIEW_APPROVAL' })} />)
    await screen.findByLabelText('YAML editor')

    await waitFor(() => expect(screen.getByText(/Autosave failed/)).toBeInTheDocument())
    expect(mockSaveUiState).not.toHaveBeenCalled()
  })

  it('keeps later interview YAML edits visible when the earlier save resolves', async () => {
    persistedUiStateData = {
      isEditMode: true,
      editTab: 'yaml',
      yamlDraft: currentRaw.replace('Test answer.', 'First local text.'),
      contentSha256: INITIAL_CONTENT_HASH,
    }
    let release: ((response: Response) => void) | undefined
    const originalFetch = vi.mocked(fetch)
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === `/api/tickets/${encodeURIComponent(TEST.ticketId)}/interview` && init?.method === 'PUT') {
        return new Promise<Response>((resolve) => { release = resolve })
      }
      return originalFetch(input, init)
    })

    renderWithProviders(<InterviewApprovalPane ticket={makeTicket({ status: 'WAITING_INTERVIEW_APPROVAL' })} />)
    const editor = await screen.findByLabelText('YAML editor')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(release).toBeDefined())

    const later = currentRaw.replace('Test answer.', 'Later local text.')
    fireEvent.change(editor, { target: { value: later } })
    release?.(new Response(JSON.stringify({ raw: currentRaw, content: currentRaw, contentSha256: SAVED_CONTENT_HASH, document }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>('YAML editor').value).toContain('Later local text.'))
  })
})
