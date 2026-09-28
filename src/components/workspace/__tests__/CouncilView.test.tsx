import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CouncilView } from '../CouncilView'
import { normalizeTicketResponse } from '@/lib/ticketNormalization'
import { makeTicket, TEST } from '@/test/factories'

const mockUseTicketArtifacts = vi.fn()
const mockUseTicketPhaseAttempts = vi.fn()

function makeArtifact(phase: string, artifactType: string, content: string | null) {
  return {
    id: 1,
    ticketId: TEST.ticketId,
    phase,
    phaseAttempt: 1,
    artifactType,
    filePath: null,
    content,
    createdAt: TEST.timestamp,
    updatedAt: TEST.timestamp,
  }
}

vi.mock('@/hooks/useTicketArtifacts', () => ({
  useTicketArtifactBundle: (...args: unknown[]) => mockUseTicketArtifacts(...args),
}))

vi.mock('@/hooks/useTicketPhaseAttempts', () => ({
  useTicketPhaseAttempts: (...args: unknown[]) => mockUseTicketPhaseAttempts(...args),
}))

vi.mock('../PhaseArtifactsPanel', () => ({
  PhaseArtifactsPanel: ({
    phase,
    ticketId,
    councilMemberCount,
    councilMemberNames,
    artifactState,
  }: {
    phase: string
    ticketId?: string
    councilMemberCount?: number
    councilMemberNames?: string[]
    artifactState?: { artifacts?: Array<{ content?: string | null }> }
  }) => (
    <div data-testid="phase-artifacts-panel">
      {phase}:{ticketId}:{councilMemberCount ?? 0}:{councilMemberNames?.join(',') ?? ''}:{artifactState?.artifacts?.[0]?.content ?? ''}
    </div>
  ),
}))

vi.mock('../CollapsiblePhaseLogSection', () => ({
  CollapsiblePhaseLogSection: ({
    phase,
    phaseAttempt,
    logMode,
  }: {
    phase: string
    phaseAttempt?: number
    logMode?: string
  }) => <div data-testid="phase-log-section" data-log-mode={logMode ?? 'live'}>{phase}:{phaseAttempt ?? 'active'}</div>,
}))

describe('CouncilView', () => {
  beforeEach(() => {
    mockUseTicketArtifacts.mockReturnValue({
      artifacts: [],
      isLoading: true,
    })
    mockUseTicketPhaseAttempts.mockReturnValue({ data: [] })
  })

  it('renders no source comments as visible text', () => {
    // A `//` line placed among JSX children is *text*, not a comment, and React
    // paints it. Nothing else here would notice: every assertion looks for text
    // that should be present, and this one is about text that should not.
    const { container } = render(<CouncilView phase="DRAFTING_PRD" ticket={makeTicket({ status: 'DRAFTING_PRD' })} />)

    expect(container.textContent ?? '').not.toMatch(/\/\/\s/)
  })

  it('keeps the live council view visible while artifacts are still loading', () => {
    mockUseTicketArtifacts.mockReturnValue({ artifacts: undefined, isLoading: true })

    render(<CouncilView phase="DRAFTING_PRD" ticket={makeTicket({ status: 'DRAFTING_PRD' })} />)

    expect(screen.getByText('AI Council — PRD Drafting')).toBeInTheDocument()
    expect(screen.getByText('Each council model is independently generating a prd draft.')).toBeInTheDocument()
    expect(screen.getByTestId('phase-artifacts-panel')).toHaveTextContent(`DRAFTING_PRD:${TEST.ticketId}:2:${TEST.councilMembers.join(',')}`)
    expect(screen.getByTestId('phase-log-section')).toHaveTextContent('DRAFTING_PRD')
    expect(screen.queryByText('Loading phase data…')).not.toBeInTheDocument()
  })

  it('renders with an empty council fallback when the server sent no roster', () => {
    const partialTicket = normalizeTicketResponse({
      ...makeTicket({ status: 'COUNCIL_VOTING_INTERVIEW' }),
      lockedCouncilMembers: null,
    })

    render(<CouncilView phase="COUNCIL_VOTING_INTERVIEW" ticket={partialTicket} />)

    expect(screen.getByText('AI Council — Interview Voting')).toBeInTheDocument()
    expect(screen.getByTestId('phase-artifacts-panel')).toHaveTextContent(`COUNCIL_VOTING_INTERVIEW:${TEST.ticketId}:3::`)
  })

  it('shows archived live-phase versions as soon as a fresh active attempt exists', () => {
    mockUseTicketPhaseAttempts.mockReturnValue({
      data: [
        {
          ticketId: TEST.ticketId,
          phase: 'DRAFTING_PRD',
          attemptNumber: 2,
          state: 'active',
          archivedReason: null,
          createdAt: '2026-04-29T12:00:00.000Z',
          archivedAt: null,
        },
        {
          ticketId: TEST.ticketId,
          phase: 'DRAFTING_PRD',
          attemptNumber: 1,
          state: 'archived',
          archivedReason: 'interview_edit_restart',
          createdAt: '2026-04-29T11:00:00.000Z',
          archivedAt: '2026-04-29T12:00:00.000Z',
        },
      ],
    })
    mockUseTicketArtifacts.mockImplementation((_ticketId: string, scopes?: Array<{ phaseAttempt?: number }>) => ({
      artifacts: scopes?.some((scope) => scope.phaseAttempt === 1)
        ? [{ content: 'archived-prd-draft' }]
        : [{ content: 'current-prd-draft' }],
      isLoading: false,
    }))

    render(<CouncilView phase="DRAFTING_PRD" ticket={makeTicket({ status: 'DRAFTING_PRD' })} />)

    const selector = screen.getByRole('combobox', { name: /version/i })
    expect(selector).toHaveValue('2')
    expect(screen.getByText('Current version (2)')).toBeInTheDocument()
    expect(screen.getByText('Archived version 1')).toBeInTheDocument()
    expect(screen.getByTestId('phase-artifacts-panel')).toHaveTextContent('current-prd-draft')
    expect(screen.getByTestId('phase-log-section')).toHaveTextContent('DRAFTING_PRD:2')
    expect(screen.getByTestId('phase-log-section')).toHaveAttribute('data-log-mode', 'live')

    fireEvent.change(selector, { target: { value: '1' } })

    expect(mockUseTicketArtifacts).toHaveBeenCalledWith(TEST.ticketId, [{
      phase: 'DRAFTING_PRD',
      phaseAttempt: 1,
    }])
    expect(screen.getByTestId('phase-artifacts-panel')).toHaveTextContent('archived-prd-draft')
    expect(screen.getByTestId('phase-log-section')).toHaveTextContent('DRAFTING_PRD:1')
    expect(screen.getByTestId('phase-log-section')).toHaveAttribute('data-log-mode', 'snapshot')
  })

  it('shows live vote completion and the selected winner from voting artifacts', () => {
    mockUseTicketArtifacts.mockReturnValue({
      artifacts: [makeArtifact(
        'COUNCIL_VOTING_PRD',
        'prd_votes',
        JSON.stringify({
          votes: [
            { voterId: 'openai/gpt-5.2', draftId: 'openai/gpt-5.2', totalScore: 16 },
            { voterId: 'openai/gpt-5.4', draftId: 'openai/gpt-5.4', totalScore: 19 },
          ],
          voterOutcomes: {
            'openai/gpt-5.2': 'completed',
            'openai/gpt-5.4': 'pending',
            'openai/gpt-5.1': 'failed',
          },
          winnerId: ' openai/gpt-5.2 ',
        }),
      )],
      isLoading: false,
    })

    render(<CouncilView phase="COUNCIL_VOTING_PRD" ticket={makeTicket({ status: 'COUNCIL_VOTING_PRD' })} />)

    expect(screen.getByText(/1\/3 complete/)).toBeInTheDocument()
    expect(screen.getByText(/Winner: gpt-5\.2 · 16 pts/)).toBeInTheDocument()
  })

  it('shows the highest valid score as leader while ignoring incomplete vote rows', () => {
    mockUseTicketArtifacts.mockReturnValue({
      artifacts: [makeArtifact(
        'COUNCIL_VOTING_BEADS',
        'beads_votes',
        JSON.stringify({
          votes: [
            { voterId: 'unattributed-voter', draftId: '', totalScore: 100 },
            { voterId: 'openai/gpt-5.2', draftId: 'openai/gpt-5.2', totalScore: 'not-a-score' },
            { voterId: 'openai/gpt-5.2', draftId: 'openai/gpt-5.2', totalScore: 18 },
            { voterId: 'google/gemini-3-pro', draftId: 'google/gemini-3-pro', totalScore: 24 },
          ],
        }),
      )],
      isLoading: false,
    })

    render(<CouncilView phase="COUNCIL_VOTING_BEADS" ticket={makeTicket({ status: 'COUNCIL_VOTING_BEADS' })} />)

    expect(screen.getByText(/3\/3 complete/)).toBeInTheDocument()
    expect(screen.getByText(/Leading: gemini-3-pro · 24 pts/)).toBeInTheDocument()
  })

  it('does not summarize malformed or not-yet-populated voting artifacts', () => {
    const voteArtifact = makeArtifact('COUNCIL_VOTING_INTERVIEW', 'interview_votes', '{')
    mockUseTicketArtifacts.mockReturnValue({ artifacts: [voteArtifact], isLoading: false })

    const { rerender } = render(
      <CouncilView phase="COUNCIL_VOTING_INTERVIEW" ticket={makeTicket({ status: 'COUNCIL_VOTING_INTERVIEW' })} />,
    )

    expect(screen.queryByText(/complete ·/)).not.toBeInTheDocument()

    mockUseTicketArtifacts.mockReturnValue({
      artifacts: [{ ...voteArtifact, content: JSON.stringify({ drafts: [] }) }],
      isLoading: false,
    })
    rerender(<CouncilView phase="COUNCIL_VOTING_INTERVIEW" ticket={makeTicket({ status: 'COUNCIL_VOTING_INTERVIEW' })} />)

    expect(screen.queryByText(/complete ·/)).not.toBeInTheDocument()

    mockUseTicketArtifacts.mockReturnValue({
      artifacts: [{ ...voteArtifact, content: JSON.stringify({ status: 'pending' }) }],
      isLoading: false,
    })
    rerender(<CouncilView phase="COUNCIL_VOTING_INTERVIEW" ticket={makeTicket({ status: 'COUNCIL_VOTING_INTERVIEW' })} />)

    expect(screen.queryByText(/complete ·/)).not.toBeInTheDocument()

    mockUseTicketArtifacts.mockReturnValue({
      artifacts: [{ ...voteArtifact, content: null }],
      isLoading: false,
    })
    rerender(<CouncilView phase="COUNCIL_VOTING_INTERVIEW" ticket={makeTicket({ status: 'COUNCIL_VOTING_INTERVIEW' })} />)

    expect(screen.queryByText(/complete ·/)).not.toBeInTheDocument()

    mockUseTicketArtifacts.mockReturnValue({
      artifacts: [{
        ...voteArtifact,
        content: JSON.stringify({
          voterOutcomes: { 'openai/gpt-5.2': 'pending' },
          votes: [],
        }),
      }],
      isLoading: false,
    })
    rerender(<CouncilView phase="COUNCIL_VOTING_INTERVIEW" ticket={makeTicket({ status: 'COUNCIL_VOTING_INTERVIEW' })} />)

    expect(screen.queryByText(/complete ·/)).not.toBeInTheDocument()
  })

  it.each([
    ['SCANNING_RELEVANT_FILES', 'AI Council — Relevant Files Scanning', 'AI is reading relevant source files to build richer context for council deliberation.'],
    ['EXPANDING_BEADS', 'AI Council — Beads Expanding', 'Winning model expands the validated implementation plan into execution-ready bead records.'],
    ['REFINING_PRD', 'AI Council — PRD Refining', 'Winning model incorporates best ideas from other drafts.'],
    ['VERIFYING_INTERVIEW_COVERAGE', 'AI Council — Interview Verifying Coverage', 'Winning model verifies interview covers all requirements.'],
  ])('renders the %s phase label and guidance', (phase, heading, guidance) => {
    render(<CouncilView phase={phase} ticket={makeTicket()} />)

    expect(screen.getByText(heading)).toBeInTheDocument()
    expect(screen.getByText(guidance)).toBeInTheDocument()
  })

  it('offers retry and hides version-scoped content when attempt history is unavailable', () => {
    const refetch = vi.fn().mockResolvedValue(undefined)
    mockUseTicketPhaseAttempts.mockReturnValue({
      data: [],
      isError: true,
      error: new Error('history request failed'),
      refetch,
    })

    render(<CouncilView phase="COUNCIL_VOTING_PRD" ticket={makeTicket({ status: 'COUNCIL_VOTING_PRD' })} />)

    expect(screen.getByRole('alert')).toHaveTextContent('The version history for this phase could not be loaded.')
    expect(screen.queryByTestId('phase-artifacts-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('phase-log-section')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it('pins the active voting attempt while reading its draft phase as a shared source', () => {
    mockUseTicketPhaseAttempts.mockReturnValue({
      data: [{
        ticketId: TEST.ticketId,
        phase: 'COUNCIL_VOTING_PRD',
        attemptNumber: 2,
        state: 'active',
        archivedReason: null,
        createdAt: '2026-04-29T12:00:00.000Z',
        archivedAt: null,
      }],
    })

    render(<CouncilView phase="COUNCIL_VOTING_PRD" ticket={makeTicket({ status: 'COUNCIL_VOTING_PRD' })} />)

    expect(mockUseTicketArtifacts).toHaveBeenCalledWith(TEST.ticketId, [
      { phase: 'COUNCIL_VOTING_PRD', phaseAttempt: 2 },
      { phase: 'DRAFTING_PRD' },
    ])
  })

  it('uses generic labels when a council phase or domain is not recognized', () => {
    const { rerender } = render(<CouncilView phase="COUNCIL_VOTING_CUSTOM" ticket={makeTicket()} />)

    expect(screen.getByText(/AI Council —/)).toHaveTextContent('AI Council — Voting')
    expect(screen.queryByText(/complete ·/)).not.toBeInTheDocument()

    rerender(<CouncilView phase="COUNCIL_CUSTOM_STAGE" ticket={makeTicket()} />)

    expect(screen.getByText(/AI Council —/)).toHaveTextContent('AI Council — Processing')
  })
})
