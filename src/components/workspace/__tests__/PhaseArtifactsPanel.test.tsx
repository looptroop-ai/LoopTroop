import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST } from '@/test/factories'
import { renderWithProviders } from '@/test/renderHelpers'
import {
  buildBeadsDocumentContent,
  buildBeadsDraftCompanionContent,
  buildExecutionSetupProfileArtifactContent,
  buildExecutionSetupReportArtifactContent,
  buildPhaseArtifactsInterviewDocumentContent,
  buildPrdDocumentContent,
  createArtifactFactory,
} from '@/test/workspaceArtifactBuilders'
import { buildUiArtifactCompanionArtifactType } from '@shared/artifactCompanions'
import { PhaseArtifactsPanel } from '../PhaseArtifactsPanel'
import type { DBartifact, TicketArtifactCollectionState } from '@/hooks/useTicketArtifacts'

function successfulArtifactState(artifacts: DBartifact[]): TicketArtifactCollectionState {
  return {
    artifacts,
    status: 'success',
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(async () => undefined),
  }
}

function TestPhaseArtifactsPanel({
  preloadedArtifacts,
  ...props
}: React.ComponentProps<typeof PhaseArtifactsPanel> & { preloadedArtifacts?: DBartifact[] }) {
  return (
    <PhaseArtifactsPanel
      {...props}
      artifactState={preloadedArtifacts === undefined ? undefined : successfulArtifactState(preloadedArtifacts)}
    />
  )
}

/** Find the innermost element whose full textContent (including children) matches exactly. */
function hasExactTextContent(text: string) {
  return (_content: string, element: Element | null) => {
    return element?.textContent === text
      && Array.from(element?.children ?? []).every((child) => child.textContent !== text)
  }
}

function getByTextContent(text: string) {
  return screen.getByText(hasExactTextContent(text))
}

async function expectFirstInspirationTooltip(bodyText: string | string[]) {
  const trigger = document.querySelector('.lucide-lightbulb')?.parentElement as HTMLElement | null
  expect(trigger).not.toBeNull()
  if (!trigger) throw new Error('Expected inspiration tooltip trigger')

  fireEvent.pointerMove(trigger)
  fireEvent.mouseEnter(trigger)

  await waitFor(() => {
    expect(screen.queryAllByText(/Inspired by /i).length).toBeGreaterThan(0)
    for (const text of Array.isArray(bodyText) ? bodyText : [bodyText]) {
      expect(screen.queryAllByText(hasExactTextContent(text)).length).toBeGreaterThan(0)
    }
  })
}

function expectCoverageAttributionUiHidden() {
  expect(document.querySelector('.lucide-lightbulb')).toBeNull()
  expect(screen.queryAllByText('No source recorded')).toHaveLength(0)
}

async function expectDialogClosed() {
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
}

const { makeArtifact, resetArtifactIds } = createArtifactFactory()

describe('PhaseArtifactsPanel', () => {
  beforeEach(() => {
    resetArtifactIds()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows artifact loading and request failures with a working retry action', () => {
    const retry = vi.fn(async () => undefined)
    const { unmount } = renderWithProviders(
      <PhaseArtifactsPanel
        phase="GENERATING_QA_CHECKLIST"
        isCompleted={false}
        artifactState={{
          artifacts: undefined,
          status: 'loading',
          isLoading: true,
          isFetching: true,
          isError: false,
          error: null,
          refetch: retry,
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Manual QA Checklist/i }))
    expect(screen.getByText('Loading artifact')).toBeInTheDocument()

    unmount()
    renderWithProviders(
      <PhaseArtifactsPanel
        phase="GENERATING_QA_CHECKLIST"
        isCompleted={false}
        artifactState={{
          artifacts: undefined,
          status: 'error',
          isLoading: false,
          isFetching: false,
          isError: true,
          error: new Error('Failed to load ticket artifacts (HTTP 503: busy)'),
          refetch: retry,
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Manual QA Checklist/i }))
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 503: busy')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it.each([
    [true, 'This artifact was not produced or is unavailable for this phase version.'],
    [false, 'This artifact is not available yet.'],
  ])('uses a truthful missing-content message when completed is %s', (isCompleted, message) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    renderWithProviders(
      <PhaseArtifactsPanel
        phase="GENERATING_QA_CHECKLIST"
        isCompleted={isCompleted}
        ticketId={TEST.ticketId}
        artifactState={successfulArtifactState([])}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Manual QA Checklist/i }))
    expect(screen.getByRole('dialog')).toHaveTextContent(message)
    expect(screen.queryByText(/will be generated during this phase/i)).not.toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps loaded content visible when a background refresh fails', () => {
    const checklistArtifact = makeArtifact({
      phase: 'GENERATING_QA_CHECKLIST',
      artifactType: 'manual_qa_checklist',
      content: JSON.stringify({ version: 1, summary: 'Previously loaded checklist' }),
    })
    renderWithProviders(
      <PhaseArtifactsPanel
        phase="GENERATING_QA_CHECKLIST"
        isCompleted
        artifactState={{
          ...successfulArtifactState([checklistArtifact]),
          status: 'error',
          isError: true,
          error: new Error('refresh unavailable'),
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Manual QA Checklist/i }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Previously loaded checklist')
    expect(screen.getByRole('alert')).toHaveTextContent('Showing previously loaded content')
  })

  it('adds each bead title and execution priority to completed commit artifacts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 'bead-2', title: 'Second commit', priority: 2 },
        { id: 'bead-1', title: 'First commit', priority: 1 },
      ],
    }))
    const firstDiff = makeArtifact({
      phase: 'CODING',
      artifactType: 'bead_diff:bead-1',
      content: 'diff --git a/src/first.ts b/src/first.ts',
    })
    const secondDiff = makeArtifact({
      phase: 'CODING',
      artifactType: 'bead_diff:bead-2',
      content: 'diff --git a/src/second.ts b/src/second.ts',
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="WAITING_PR_REVIEW"
        isCompleted
        ticketId={TEST.ticketId}
        preloadedArtifacts={[firstDiff, secondDiff]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Bead Commits/i }))
    await waitFor(() => {
      expect(screen.getByText('#1 · bead-1 · First commit')).toBeInTheDocument()
      expect(screen.getByText('#2 · bead-2 · Second commit')).toBeInTheDocument()
    })
  })

  it('opens the generated Manual QA checklist artifact with readable results', () => {
    const checklistArtifact = makeArtifact({
      phase: 'GENERATING_QA_CHECKLIST',
      artifactType: 'manual_qa_checklist',
      content: JSON.stringify({
        version: 1,
        checklist: [
          'schemaVersion: 1',
          'summary: Verify the new checkout behavior.',
          'items:',
          '  - title: Checkout succeeds',
          '    expectedResult: The order is confirmed.',
        ].join('\n'),
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="GENERATING_QA_CHECKLIST"
        isCompleted
        preloadedArtifacts={[checklistArtifact]}
      />,
    )

    expect(screen.getByRole('button', { name: /Manual QA Checklist/i })).toHaveTextContent('v1 · 1 check')
    fireEvent.click(screen.getByRole('button', { name: /Manual QA Checklist/i }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Verify the new checkout behavior.')
    expect(screen.getByRole('dialog')).toHaveTextContent('Checkout succeeds')
    expect(screen.getByRole('dialog')).toHaveTextContent('The order is confirmed.')
  })

  it('shows the Manual QA generation repair trail beside the checklist', () => {
    const checklistArtifact = makeArtifact({
      phase: 'GENERATING_QA_CHECKLIST',
      artifactType: 'manual_qa_checklist',
      content: JSON.stringify({
        version: 1,
        checklist: [
          'items:',
          '  - title: Checkout succeeds',
          '    expectedResult: The order is confirmed.',
        ].join('\n'),
      }),
    })
    // Generation records its retries in a companion row. Until it was read, the
    // checklist and a repaired checklist looked identical.
    const companionArtifact = makeArtifact({
      phase: 'GENERATING_QA_CHECKLIST',
      artifactType: buildUiArtifactCompanionArtifactType('manual_qa_checklist'),
      content: JSON.stringify({
        baseArtifactType: 'manual_qa_checklist',
        generatedAt: '2026-07-14T10:00:00.000Z',
        payload: {
          structuredOutput: {
            repairApplied: true,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'Manual QA parser rejected the model output.',
          },
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="GENERATING_QA_CHECKLIST"
        isCompleted
        preloadedArtifacts={[checklistArtifact, companionArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Manual QA Checklist/i }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Checkout succeeds')
    expect(screen.getByRole('dialog')).toHaveTextContent(/LoopTroop adjusted this artifact/i)
  })

  it('shows the execution setup runtime as one structured artifact with useful chip details', () => {
    const profileArtifact = makeArtifact({
      phase: 'PREPARING_EXECUTION_ENV',
      artifactType: 'execution_setup_profile',
      content: buildExecutionSetupProfileArtifactContent(),
    })
    const reportArtifact = makeArtifact({
      phase: 'PREPARING_EXECUTION_ENV',
      artifactType: 'execution_setup_report',
      content: buildExecutionSetupReportArtifactContent(),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="PREPARING_EXECUTION_ENV"
        isCompleted
        preloadedArtifacts={[profileArtifact, reportArtifact]}
      />,
    )

    expect(screen.getByText('Execution Setup Runtime')).toBeInTheDocument()
    expect(screen.getByText('ready · 1 attempt · 1 root · 1 bootstrap · 1 probe · 1 reusable')).toBeInTheDocument()
    expect(screen.queryByText('Execution Setup Profile')).not.toBeInTheDocument()
    expect(screen.queryByText('Execution Setup Report')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Execution Setup Runtime/i }))
    expect(screen.getAllByText('Runtime profile is ready for coding beads.').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Runtime' })).toBeInTheDocument()
    expect(screen.getByText('Command Audit')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Raw' })).toBeInTheDocument()
  })

  it('collapses interview voting artifacts into a winning draft card plus shared voting details', () => {
    const voteArtifact = makeArtifact({
      phase: 'COUNCIL_VOTING_INTERVIEW',
      artifactType: 'interview_votes',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        drafts: [
          { memberId: 'openai/gpt-5.1-codex', outcome: 'completed', content: 'Draft 1' },
          { memberId: 'openai/gpt-5.1-codex-mini', outcome: 'completed', content: 'Draft 2' },
          { memberId: 'openai/gpt-5.2', outcome: 'completed', content: 'Draft 3' },
          { memberId: 'opencode/big-pickle', outcome: 'completed', content: 'Draft 4' },
        ],
        votes: [
          { voterId: 'openai/gpt-5.1-codex', draftId: 'openai/gpt-5.1-codex', totalScore: 80, scores: [] },
          { voterId: 'openai/gpt-5.1-codex', draftId: 'openai/gpt-5.1-codex-mini', totalScore: 82, scores: [] },
          { voterId: 'openai/gpt-5.1-codex', draftId: 'openai/gpt-5.2', totalScore: 89, scores: [] },
          { voterId: 'openai/gpt-5.1-codex', draftId: 'opencode/big-pickle', totalScore: 78, scores: [] },
          { voterId: 'openai/gpt-5.1-codex-mini', draftId: 'openai/gpt-5.1-codex', totalScore: 81, scores: [] },
          { voterId: 'openai/gpt-5.1-codex-mini', draftId: 'openai/gpt-5.1-codex-mini', totalScore: 83, scores: [] },
          { voterId: 'openai/gpt-5.1-codex-mini', draftId: 'openai/gpt-5.2', totalScore: 90, scores: [] },
          { voterId: 'openai/gpt-5.1-codex-mini', draftId: 'opencode/big-pickle', totalScore: 79, scores: [] },
          { voterId: 'openai/gpt-5.2', draftId: 'openai/gpt-5.1-codex', totalScore: 82, scores: [] },
          { voterId: 'openai/gpt-5.2', draftId: 'openai/gpt-5.1-codex-mini', totalScore: 84, scores: [] },
          { voterId: 'openai/gpt-5.2', draftId: 'openai/gpt-5.2', totalScore: 91, scores: [] },
          { voterId: 'openai/gpt-5.2', draftId: 'opencode/big-pickle', totalScore: 80, scores: [] },
          { voterId: 'opencode/big-pickle', draftId: 'openai/gpt-5.1-codex', totalScore: 79, scores: [] },
          { voterId: 'opencode/big-pickle', draftId: 'openai/gpt-5.1-codex-mini', totalScore: 81, scores: [] },
          { voterId: 'opencode/big-pickle', draftId: 'openai/gpt-5.2', totalScore: 88, scores: [] },
          { voterId: 'opencode/big-pickle', draftId: 'opencode/big-pickle', totalScore: 77, scores: [] },
        ],
        voterOutcomes: {
          'openai/gpt-5.1-codex': 'completed',
          'openai/gpt-5.1-codex-mini': 'completed',
          'openai/gpt-5.2': 'completed',
          'opencode/big-pickle': 'completed',
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="COUNCIL_VOTING_INTERVIEW"
        isCompleted={false}
        councilMemberCount={4}
        councilMemberNames={[
          'openai/gpt-5.1-codex',
          'openai/gpt-5.1-codex-mini',
          'openai/gpt-5.2',
          'opencode/big-pickle',
        ]}
        preloadedArtifacts={[voteArtifact]}
      />,
    )

    expect(screen.getByText('Voting Details')).toBeInTheDocument()
    expect(screen.getByText('Winning Draft')).toBeInTheDocument()
    expect(screen.getByText('winner: gpt-5.2')).toBeInTheDocument()
    expect(screen.getByText('4 voters · 4 drafts')).toBeInTheDocument()
    expect(screen.queryByText('gpt-5.1-codex-mini')).not.toBeInTheDocument()
    expect(screen.queryByText('big-pickle')).not.toBeInTheDocument()

    const [votingButton, winningButton] = screen.getAllByRole('button')
    expect(votingButton).toHaveTextContent('Voting Details')
    expect(winningButton).toHaveTextContent('Winning Draft')
  })

  it('shows compact compiling interview draft chips and a separate final interview artifact', () => {
    const voteArtifact = makeArtifact({
      phase: 'COUNCIL_VOTING_INTERVIEW',
      artifactType: 'interview_votes',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        drafts: [
          { memberId: 'openai/gpt-5.1-codex', outcome: 'completed', content: 'questions:\n  - id: Q01\n    question: "Draft A?"', questionCount: 21 },
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: 'questions:\n  - id: Q01\n    phase: foundation\n    question: "Original winner question?"\n  - id: Q02\n    phase: structure\n    question: "Replacement source question?"\n  - id: Q05\n    phase: assembly\n    question: "Removed winner question?"',
            questionCount: 3,
          },
        ],
      }),
    })

    const compiledArtifact = makeArtifact({
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'interview_compiled',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        refinedContent: 'questions:\n  - id: Q01\n    phase: foundation\n    question: "Refined winner question?"\n  - id: Q03\n    phase: structure\n    question: "Replacement target question?"\n  - id: Q04\n    phase: assembly\n    question: "Added question?"',
        questions: [
          { id: 'Q01', phase: 'Foundation', question: 'Refined winner question?' },
          { id: 'Q03', phase: 'Structure', question: 'Replacement target question?' },
          { id: 'Q04', phase: 'Assembly', question: 'Added question?' },
        ],
        questionCount: 3,
        changes: [
          {
            type: 'modified',
            before: { id: 'Q01', phase: 'Foundation', question: 'Original winner question?' },
            after: { id: 'Q01', phase: 'Foundation', question: 'Refined winner question?' },
          },
          {
            type: 'replaced',
            before: { id: 'Q02', phase: 'Structure', question: 'Replacement source question?' },
            after: { id: 'Q03', phase: 'Structure', question: 'Replacement target question?' },
            inspiration: {
              draftIndex: 0,
              memberId: 'openai/gpt-5.1-codex',
              question: { id: 'Q07', phase: 'Structure', question: 'Alternative draft replacement question?' },
            },
            attributionStatus: 'inspired',
          },
          {
            type: 'added',
            before: null,
            after: { id: 'Q04', phase: 'Assembly', question: 'Added question?' },
            inspiration: null,
            attributionStatus: 'model_unattributed',
          },
          {
            type: 'removed',
            before: { id: 'Q05', phase: 'Assembly', question: 'Removed winner question?' },
            after: null,
            inspiration: null,
            attributionStatus: 'model_unattributed',
          },
        ],
        structuredOutput: {
          repairApplied: true,
          repairWarnings: [
            'Synthesized omitted interview refinement modified change for Q01 by matching id and phase across the winning and final drafts.',
          ],
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="COMPILING_INTERVIEW"
        isCompleted={false}
        councilMemberCount={2}
        councilMemberNames={['openai/gpt-5.1-codex', 'openai/gpt-5.2']}
        preloadedArtifacts={[voteArtifact, compiledArtifact]}
      />,
    )

    expect(screen.getByText('gpt-5.1-codex')).toBeInTheDocument()
    expect(screen.getByText('gpt-5.2')).toBeInTheDocument()
    expect(screen.getByText('proposed 21 questions')).toBeInTheDocument()
    expect(screen.getByText('proposed 3 questions')).toBeInTheDocument()
    expect(screen.getByText('Final Interview Results')).toBeInTheDocument()
    expect(screen.getByText('gpt-5.2 · 3 questions')).toBeInTheDocument()
    expect(screen.queryByText('Winner — refining draft')).not.toBeInTheDocument()
    expect(screen.queryByText('🔄 Refining')).not.toBeInTheDocument()
    expect(screen.queryByText('Interview Draft Diff')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Final Interview Results/i }))
    expect(screen.getByRole('button', { name: /Final Questions/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Diff \(4\)/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Diff \(4\)/i }))
    expect(screen.getByText(/Comparing winning draft from gpt-5.2/i)).toBeInTheDocument()
    expect(getByTextContent('Original winner question?')).toBeInTheDocument()
    expect(getByTextContent('Refined winner question?')).toBeInTheDocument()
    expect(screen.getByText('Modified 1')).toBeInTheDocument()
    expect(screen.getByText('Replaced 1')).toBeInTheDocument()
    expect(screen.getByText('Added 1')).toBeInTheDocument()
    expect(screen.getByText('Removed 1')).toBeInTheDocument()
    expect(screen.getByText('Replaced')).toBeInTheDocument()
    expect(screen.getByText('Auto-detected diff')).toBeInTheDocument()
    expect(screen.getAllByText('No source recorded').length).toBeGreaterThan(0)
    expect(Array.from(document.querySelectorAll('mark')).map((element) => element.textContent)).toEqual(expect.arrayContaining(['Original', 'Refined']))
  })

  it.each([
    {
      phase: 'COMPILING_INTERVIEW' as const,
      votePhase: 'COUNCIL_VOTING_INTERVIEW',
      draftPhase: 'COUNCIL_DELIBERATING',
      voteType: 'interview_votes',
      draftType: 'interview_drafts',
      winnerId: 'openai/gpt-5.2',
      loserId: 'openai/gpt-5.1-codex',
      winnerContent: 'questions:\n  - id: Q01\n    phase: foundation\n    question: "Winning interview question?"',
      loserContent: 'questions:\n  - id: Q01\n    phase: foundation\n    question: "Alternative interview question?"',
      winnerExtra: { questionCount: 1 },
      loserExtra: { questionCount: 1 },
      expectedDetail: 'proposed 1 questions',
    },
    {
      phase: 'REFINING_PRD' as const,
      votePhase: 'COUNCIL_VOTING_PRD',
      draftPhase: 'DRAFTING_PRD',
      voteType: 'prd_votes',
      draftType: 'prd_drafts',
      winnerId: 'openai/gpt-5.2',
      loserId: 'openai/gpt-5.1-codex',
      winnerContent: buildPrdDocumentContent({ epicTitle: 'Winning PRD draft' }),
      loserContent: buildPrdDocumentContent({ epicTitle: 'Alternative PRD draft' }),
      winnerExtra: { draftMetrics: { epicCount: 1, userStoryCount: 1 } },
      loserExtra: { draftMetrics: { epicCount: 1, userStoryCount: 1 } },
      expectedDetail: '1 epics · 1 user stories',
    },
    {
      phase: 'REFINING_BEADS' as const,
      votePhase: 'COUNCIL_VOTING_BEADS',
      draftPhase: 'DRAFTING_BEADS',
      voteType: 'beads_votes',
      draftType: 'beads_drafts',
      winnerId: 'openai/gpt-5.2',
      loserId: 'openai/gpt-5.1-codex',
      winnerContent: buildBeadsDocumentContent([{ id: 'bead-1', title: 'Winning beads draft' }]),
      loserContent: buildBeadsDocumentContent([{ id: 'bead-2', title: 'Alternative beads draft' }]),
      winnerExtra: { draftMetrics: { beadCount: 1, totalTestCount: 2, totalAcceptanceCriteriaCount: 3 } },
      loserExtra: { draftMetrics: { beadCount: 1, totalTestCount: 2, totalAcceptanceCriteriaCount: 3 } },
      expectedDetail: '1 beads · 2 tests · 3 criteria',
    },
  ])('keeps $phase model draft details when the vote artifact stores only the winner', ({
    phase,
    votePhase,
    draftPhase,
    voteType,
    draftType,
    winnerId,
    loserId,
    winnerContent,
    loserContent,
    winnerExtra,
    loserExtra,
    expectedDetail,
  }) => {
    const draftArtifact = makeArtifact({
      phase: draftPhase,
      artifactType: draftType,
      content: JSON.stringify({
        drafts: [
          { memberId: loserId, outcome: 'completed', content: loserContent, ...loserExtra },
          { memberId: winnerId, outcome: 'completed', content: winnerContent, ...winnerExtra },
        ],
        memberOutcomes: {
          [loserId]: 'completed',
          [winnerId]: 'completed',
        },
        isFinal: true,
      }),
    })
    const voteArtifact = makeArtifact({
      phase: votePhase,
      artifactType: voteType,
      content: JSON.stringify({
        winnerId,
        drafts: [
          { memberId: loserId, outcome: 'pending' },
          { memberId: winnerId, outcome: 'pending' },
        ],
        isFinal: true,
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase={phase}
        isCompleted={false}
        councilMemberCount={2}
        councilMemberNames={[loserId, winnerId]}
        preloadedArtifacts={[draftArtifact, voteArtifact]}
      />,
    )

    expect(screen.getAllByText(expectedDetail).length).toBeGreaterThan(0)
    expect(screen.queryAllByText('waiting for response')).toHaveLength(0)
  })

  it('marks the winning interview draft when revisiting the completed drafting phase', () => {
    const draftArtifact = makeArtifact({
      phase: 'COUNCIL_DELIBERATING',
      artifactType: 'interview_drafts',
      content: JSON.stringify({
        drafts: [
          {
            memberId: 'openai/gpt-5.1-codex',
            outcome: 'completed',
            content: 'questions:\n  - id: Q01\n    question: "Alternative question?"',
            questionCount: 1,
          },
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: 'questions:\n  - id: Q01\n    question: "Winning question?"',
            questionCount: 1,
          },
        ],
        memberOutcomes: {
          'openai/gpt-5.1-codex': 'completed',
          'openai/gpt-5.2': 'completed',
        },
        isFinal: true,
      }),
    })
    const voteArtifact = makeArtifact({
      phase: 'COUNCIL_VOTING_INTERVIEW',
      artifactType: 'interview_votes',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        isFinal: true,
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="COUNCIL_DELIBERATING"
        isCompleted
        councilMemberCount={2}
        councilMemberNames={['openai/gpt-5.1-codex', 'openai/gpt-5.2']}
        preloadedArtifacts={[draftArtifact, voteArtifact]}
      />,
    )

    expect(screen.getAllByText('proposed 1 questions')).toHaveLength(2)
    expect(screen.queryAllByText('waiting for response')).toHaveLength(0)
    expect(screen.getByRole('button', { name: /gpt-5\.2/i })).toHaveClass('bg-primary')
  })

  it.each([
    {
      scenario: 'shows chips with pending and completed members',
      drafts: [
        {
          memberId: 'openai/gpt-5.2',
          outcome: 'completed',
          content: [
            'schema_version: 1',
            `ticket_id: ${TEST.externalId}`,
            'artifact: prd',
            'status: draft',
          ].join('\n'),
          draftMetrics: { epicCount: 3, userStoryCount: 9 },
        },
        { memberId: 'openai/gpt-5.1-codex', outcome: 'pending' },
      ],
      councilMemberNames: ['openai/gpt-5.2', 'openai/gpt-5.1-codex'],
      expectedMetrics: ['3 epics · 9 user stories'],
      expectedPending: true,
      expectedParts: true,
      notExpected: [] as string[],
    },
    {
      scenario: 'shows chips with PRD-specific completion metrics',
      drafts: [
        {
          memberId: 'openai/gpt-5.1-codex',
          outcome: 'completed',
          content: `schema_version: 1\nticket_id: ${TEST.externalId}\nartifact: prd\nstatus: draft\n`,
          draftMetrics: { epicCount: 3, userStoryCount: 9 },
        },
        {
          memberId: 'openai/gpt-5.2',
          outcome: 'completed',
          content: `schema_version: 1\nticket_id: ${TEST.externalId}\nartifact: prd\nstatus: draft\n`,
          draftMetrics: { epicCount: 2, userStoryCount: 5 },
        },
      ],
      councilMemberNames: ['openai/gpt-5.1-codex', 'openai/gpt-5.2'],
      expectedMetrics: ['3 epics · 9 user stories', '2 epics · 5 user stories'],
      expectedPending: false,
      expectedParts: false,
      notExpected: ['proposed 3 questions'],
    },
  ])('$scenario', ({ drafts, councilMemberNames, expectedMetrics, expectedPending, expectedParts, notExpected }) => {
    const draftArtifact = makeArtifact({
      phase: 'DRAFTING_PRD',
      artifactType: 'prd_drafts',
      content: JSON.stringify({ drafts }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="DRAFTING_PRD"
        isCompleted={false}
        councilMemberCount={2}
        councilMemberNames={councilMemberNames}
        preloadedArtifacts={[draftArtifact]}
      />,
    )

    for (const name of councilMemberNames) {
      const shortName = name.split('/').pop()!
      expect(screen.queryAllByText(shortName).length).toBeGreaterThan(0)
    }
    for (const metric of expectedMetrics) {
      expect(screen.getByText(metric)).toBeInTheDocument()
    }
    if (expectedPending) {
      expect(screen.queryAllByText('waiting for response').length).toBeGreaterThan(0)
    }
    if (expectedParts) {
      expect(screen.getByText('Part 1')).toBeInTheDocument()
      expect(screen.getByText('Part 2')).toBeInTheDocument()
    }
    for (const text of notExpected) {
      expect(screen.queryByText(text)).not.toBeInTheDocument()
    }
  })

  it('opens Drafting PRD part 1 artifacts with the interview-style full answers viewer', () => {
    const fullAnswersArtifact = makeArtifact({
      phase: 'DRAFTING_PRD',
      artifactType: 'prd_full_answers',
      content: JSON.stringify({
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: buildPhaseArtifactsInterviewDocumentContent(),
            questionCount: 1,
          },
        ],
        memberOutcomes: {
          'openai/gpt-5.2': 'completed',
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="DRAFTING_PRD"
        isCompleted={false}
        councilMemberCount={1}
        councilMemberNames={['openai/gpt-5.2']}
        preloadedArtifacts={[fullAnswersArtifact]}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: /gpt-5\.2/i })[0]!)
    fireEvent.click(screen.getByRole('button', { name: /Foundation/i }))

    expect(screen.getByText('How should skipped answers be completed?')).toBeInTheDocument()
    expect(screen.getByText('Use AI-authored answers and label them clearly.')).toBeInTheDocument()
    expect(screen.getByText(/Answered automatically by AI in Drafting specs status/i)).toBeInTheDocument()
  })

  it('shows the stored full-answer count in the Drafting PRD ticket chips', () => {
    const fullAnswersArtifact = makeArtifact({
      phase: 'DRAFTING_PRD',
      artifactType: 'prd_full_answers',
      content: JSON.stringify({
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: [
              'schema_version: 1',
              `ticket_id: ${TEST.externalId}`,
              'artifact: interview',
              'questions:',
              '  - id: Q01',
              '    prompt: "First preserved question?"',
              '    answer:',
              '      skipped: false',
              '      free_text: "First answer."',
              '  - id: Q02',
              '    prompt: "Second preserved question?"',
              '    answer:',
              '      skipped: false',
              '      free_text: "Second answer."',
            ].join('\n'),
            questionCount: 1,
          },
        ],
        memberOutcomes: {
          'openai/gpt-5.2': 'completed',
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="DRAFTING_PRD"
        isCompleted={false}
        councilMemberCount={1}
        councilMemberNames={['openai/gpt-5.2']}
        preloadedArtifacts={[fullAnswersArtifact]}
      />,
    )

    expect(screen.getByText('1 answers')).toBeInTheDocument()
    expect(screen.queryByText('2 answers')).not.toBeInTheDocument()
  })

  it('opens Drafting PRD part 2 artifacts with the structured PRD viewer', () => {
    const draftArtifact = makeArtifact({
      phase: 'DRAFTING_PRD',
      artifactType: 'prd_drafts',
      content: JSON.stringify({
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: buildPrdDocumentContent(),
            draftMetrics: {
              epicCount: 1,
              userStoryCount: 1,
            },
          },
        ],
        memberOutcomes: {
          'openai/gpt-5.2': 'completed',
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="DRAFTING_PRD"
        isCompleted={false}
        councilMemberCount={1}
        councilMemberNames={['openai/gpt-5.2']}
        preloadedArtifacts={[draftArtifact]}
      />,
    )

    fireEvent.click(screen.getAllByRole('button', { name: /gpt-5\.2/i })[1]!)

    expect(screen.getByText('Epics (1)')).toBeInTheDocument()
    expect(screen.getByText('Restore rich PRD views')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Restore rich PRD views').closest('button')!)

    expect(screen.getByText('Review PRD drafts')).toBeInTheDocument()
  })

  it('shows Full Answers and PRD draft notices separately during Drafting PRD', () => {
    const fullAnswersArtifact = makeArtifact({
      phase: 'DRAFTING_PRD',
      artifactType: 'prd_full_answers',
      content: JSON.stringify({
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: buildPhaseArtifactsInterviewDocumentContent(),
          },
        ],
        memberOutcomes: {
          'openai/gpt-5.2': 'completed',
        },
      }),
    })

    const fullAnswersCompanion = makeArtifact({
      phase: 'DRAFTING_PRD',
      artifactType: 'ui_artifact_companion:prd_full_answers',
      content: JSON.stringify({
        baseArtifactType: 'prd_full_answers',
        generatedAt: '2026-03-30T09:33:08.154Z',
        payload: {
          draftDetails: [
            {
              memberId: 'openai/gpt-5.2',
              structuredOutput: {
                repairApplied: true,
                repairWarnings: [
                  'Canonicalized resolved interview status from "approved" to "draft".',
                  'Cleared approval fields for the AI-generated Full Answers artifact.',
                  'Canonicalized generated_by.winner_model from "openai/gpt-5.4" to "openai/gpt-5.2".',
                ],
              },
            },
          ],
        },
      }),
    })

    const draftArtifact = makeArtifact({
      phase: 'DRAFTING_PRD',
      artifactType: 'prd_drafts',
      content: JSON.stringify({
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: buildPrdDocumentContent(),
          },
        ],
        memberOutcomes: {
          'openai/gpt-5.2': 'completed',
        },
      }),
    })

    const draftCompanion = makeArtifact({
      phase: 'DRAFTING_PRD',
      artifactType: 'ui_artifact_companion:prd_drafts',
      content: JSON.stringify({
        baseArtifactType: 'prd_drafts',
        generatedAt: '2026-03-30T09:33:08.166Z',
        payload: {
          draftDetails: [
            {
              memberId: 'openai/gpt-5.2',
              structuredOutput: {
                repairApplied: true,
                repairWarnings: [
                  'Canonicalized source_interview.content_sha256 from the approved Interview Results artifact.',
                ],
              },
            },
          ],
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="DRAFTING_PRD"
        isCompleted={false}
        councilMemberCount={1}
        councilMemberNames={['openai/gpt-5.2']}
        preloadedArtifacts={[fullAnswersArtifact, fullAnswersCompanion, draftArtifact, draftCompanion]}
      />,
    )

    const modelButtons = screen.getAllByRole('button', { name: /gpt-5\.2/i })
    fireEvent.click(modelButtons[0]!)

    expect(screen.getByText('LoopTroop adjusted these Full Answers.')).toBeInTheDocument()
    expect(screen.getByText('Cleanup 3')).toBeInTheDocument()
    expect(screen.queryByText('LoopTroop adjusted this PRD draft.')).not.toBeInTheDocument()

    fireEvent.click(modelButtons[1]!)

    expect(screen.getByText('LoopTroop adjusted this PRD draft.')).toBeInTheDocument()
    expect(screen.getByText('Cleanup 1')).toBeInTheDocument()
    expect(screen.queryByText('LoopTroop adjusted these Full Answers.')).not.toBeInTheDocument()
  })

  it('keeps Voting on Specs winner artifacts on the winning draft view', () => {
    const voteArtifact = makeArtifact({
      phase: 'COUNCIL_VOTING_PRD',
      artifactType: 'prd_votes',
      content: JSON.stringify({
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: buildPrdDocumentContent({
              epicTitle: 'Winning PRD draft',
              storyTitle: 'Inspect the winning PRD',
            }),
          },
        ],
        votes: [
          {
            voterId: 'openai/gpt-5.2',
            draftId: 'openai/gpt-5.2',
            totalScore: 95,
            scores: [
              { category: 'Coverage of requirements', score: 19 },
              { category: 'Correctness / feasibility', score: 19 },
              { category: 'Testability', score: 19 },
              { category: 'Minimal complexity / good decomposition', score: 19 },
              { category: 'Risks / edge cases addressed', score: 19 },
            ],
          },
        ],
        voterOutcomes: { 'openai/gpt-5.2': 'completed' },
        winnerId: 'openai/gpt-5.2',
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="COUNCIL_VOTING_PRD"
        isCompleted={false}
        councilMemberCount={1}
        councilMemberNames={['openai/gpt-5.2']}
        preloadedArtifacts={[voteArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Winning PRD Draft/i }))
    expect(screen.getByText('Epics (1)')).toBeInTheDocument()
    expect(screen.getByText('Winning PRD draft')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Winning PRD draft').closest('button')!)
    expect(screen.getByText('Inspect the winning PRD')).toBeInTheDocument()
  })

  it('keeps Voting on Specs details on the voting results view', () => {
    const voteArtifact = makeArtifact({
      phase: 'COUNCIL_VOTING_PRD',
      artifactType: 'prd_votes',
      content: JSON.stringify({
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: buildPrdDocumentContent(),
          },
        ],
        votes: [
          {
            voterId: 'openai/gpt-5.2',
            draftId: 'openai/gpt-5.2',
            totalScore: 95,
            scores: [
              { category: 'Coverage of requirements', score: 19 },
              { category: 'Correctness / feasibility', score: 19 },
              { category: 'Testability', score: 19 },
              { category: 'Minimal complexity / good decomposition', score: 19 },
              { category: 'Risks / edge cases addressed', score: 19 },
            ],
          },
        ],
        voterOutcomes: { 'openai/gpt-5.2': 'completed' },
        winnerId: 'openai/gpt-5.2',
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="COUNCIL_VOTING_PRD"
        isCompleted={false}
        councilMemberCount={1}
        councilMemberNames={['openai/gpt-5.2']}
        preloadedArtifacts={[voteArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Voting Details/i }))
    expect(screen.getByText('Rankings')).toBeInTheDocument()
    expect(screen.getByText('Score Breakdown')).toBeInTheDocument()
  })

  it('keeps Voting on Blueprint details on the voting results and winning draft views', () => {
    const voteArtifact = makeArtifact({
      phase: 'COUNCIL_VOTING_BEADS',
      artifactType: 'beads_votes',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        isFinal: true,
      }),
    })

    const voteCompanionArtifact = makeArtifact({
      phase: 'COUNCIL_VOTING_BEADS',
      artifactType: 'ui_artifact_companion:beads_votes',
      content: JSON.stringify({
        baseArtifactType: 'beads_votes',
        generatedAt: '2026-03-30T09:33:08.166Z',
        payload: {
          votes: [
            {
              voterId: 'openai/gpt-5.1-codex',
              draftId: 'openai/gpt-5.2',
              totalScore: 92,
              scores: [
                { category: 'Coverage of requirements', score: 19 },
                { category: 'Correctness / feasibility', score: 18 },
                { category: 'Testability', score: 19 },
                { category: 'Minimal complexity / good decomposition', score: 18 },
                { category: 'Risks / edge cases addressed', score: 18 },
              ],
            },
            {
              voterId: 'openai/gpt-5.2',
              draftId: 'openai/gpt-5.2',
              totalScore: 94,
              scores: [
                { category: 'Coverage of requirements', score: 19 },
                { category: 'Correctness / feasibility', score: 19 },
                { category: 'Testability', score: 19 },
                { category: 'Minimal complexity / good decomposition', score: 18 },
                { category: 'Risks / edge cases addressed', score: 19 },
              ],
            },
          ],
          voterOutcomes: {
            'openai/gpt-5.1-codex': 'completed',
            'openai/gpt-5.2': 'completed',
          },
          voterDetails: [
            {
              voterId: 'openai/gpt-5.1-codex',
              structuredOutput: {
                repairApplied: true,
                repairWarnings: ['Normalized vote scorecard indentation under the wrapper key.'],
              },
            },
            {
              voterId: 'openai/gpt-5.2',
              structuredOutput: {
                repairApplied: false,
                repairWarnings: [],
                autoRetryCount: 1,
                validationError: 'Malformed scorecard',
              },
            },
          ],
          presentationOrders: {
            'openai/gpt-5.1-codex': {
              seed: 'seed-alpha-1234',
              order: ['openai/gpt-5.1-codex', 'openai/gpt-5.2'],
            },
            'openai/gpt-5.2': {
              seed: 'seed-beta-5678',
              order: ['openai/gpt-5.2', 'openai/gpt-5.1-codex'],
            },
          },
          totalScore: 186,
        },
      }),
    })

    const draftArtifact = makeArtifact({
      phase: 'COUNCIL_VOTING_BEADS',
      artifactType: 'beads_drafts',
      content: JSON.stringify({
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: buildBeadsDocumentContent([
              { id: 'bead-1', title: 'Validate architecture votes' },
              { id: 'bead-2', title: 'Surface vote ordering' },
            ]),
          },
          {
            memberId: 'openai/gpt-5.1-codex',
            outcome: 'completed',
            content: buildBeadsDocumentContent([
              { id: 'bead-3', title: 'Alternative architecture path' },
            ]),
          },
        ],
        memberOutcomes: {
          'openai/gpt-5.2': 'completed',
          'openai/gpt-5.1-codex': 'completed',
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="COUNCIL_VOTING_BEADS"
        isCompleted={false}
        councilMemberCount={2}
        councilMemberNames={['openai/gpt-5.1-codex', 'openai/gpt-5.2']}
        preloadedArtifacts={[voteArtifact, voteCompanionArtifact, draftArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Voting Details/i }))
    expect(screen.getByText('Voter Status')).toBeInTheDocument()
    expect(screen.getByText('Rankings')).toBeInTheDocument()
    expect(screen.getByText('Score Breakdown')).toBeInTheDocument()
    expect(screen.getByText('LoopTroop adjusted some vote scorecards.')).toBeInTheDocument()
    expect(screen.getByText(/2 interventions across 2 categories/)).toBeInTheDocument()
    expect(screen.queryByText('Affected Models')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('LoopTroop adjusted some vote scorecards.').closest('button')!)
    expect(screen.getByText('Affected Models')).toBeInTheDocument()
    expect(screen.getByText('Malformed scorecard')).toBeInTheDocument()

    fireEvent.click(screen.getByText(/Voter Details/i).closest('button')!)
    expect(screen.getAllByText('Presentation Order')).toHaveLength(2)
    expect(screen.getByText(/seed seed-alp/i)).toBeInTheDocument()
    expect(screen.getByText(/seed seed-bet/i)).toBeInTheDocument()
    expect(screen.queryByText('LoopTroop adjusted this vote scorecard.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Close/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Winning Beads Draft/i }))
    expect(screen.getByText('2 beads')).toBeInTheDocument()
    expect(screen.getByText('Validate architecture votes')).toBeInTheDocument()
    expect(screen.getByText('Surface vote ordering')).toBeInTheDocument()
  })

  it('keeps later PRD review phases on the structured refined PRD viewer', () => {
    const refinedArtifact = makeArtifact({
      phase: 'REFINING_PRD',
      artifactType: 'prd_refined',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        refinedContent: buildPrdDocumentContent({
          epicTitle: 'Refined PRD review',
          storyTitle: 'Inspect refined PRD sections',
        }),
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="WAITING_PRD_APPROVAL"
        isCompleted={false}
        preloadedArtifacts={[refinedArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /PRD Candidate/i }))

    expect(screen.getByText('Epics (1)')).toBeInTheDocument()
    expect(screen.getByText('Refined PRD review')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Refined PRD review').closest('button')!)

    expect(screen.getByText('Inspect refined PRD sections')).toBeInTheDocument()
  })

  it.each([
    {
      scenario: 'prefers refinedContent when present',
      coverageInputContent: {
        fullAnswers: buildPhaseArtifactsInterviewDocumentContent(),
        prd: buildPrdDocumentContent({
          epicTitle: 'Coverage input PRD',
          storyTitle: 'Inspect coverage input sections',
        }),
        refinedContent: buildPrdDocumentContent({
          epicTitle: 'Coverage input under verification',
          storyTitle: 'Inspect the exact PRD sent to coverage',
        }),
      },
      refinedEpic: 'Refined artifact PRD',
      refinedStory: 'Inspect refined artifact sections',
      expectedEpic: 'Coverage input under verification',
      expectedStory: 'Inspect the exact PRD sent to coverage',
      notExpected: ['Coverage input PRD', 'Refined artifact PRD', 'Inspect refined artifact sections'],
    },
    {
      scenario: 'falls back to prd when refinedContent is absent',
      coverageInputContent: {
        fullAnswers: buildPhaseArtifactsInterviewDocumentContent(),
        prd: buildPrdDocumentContent({
          epicTitle: 'Coverage input PRD only',
          storyTitle: 'Inspect the exact saved PRD',
        }),
      },
      refinedEpic: 'Artifact fallback PRD',
      refinedStory: 'Inspect artifact fallback sections',
      expectedEpic: 'Coverage input PRD only',
      expectedStory: 'Inspect the exact saved PRD',
      notExpected: ['Artifact fallback PRD', 'Inspect artifact fallback sections'],
    },
  ])('$scenario', ({ coverageInputContent, refinedEpic, refinedStory, expectedEpic, expectedStory, notExpected }) => {
    const refinedArtifact = makeArtifact({
      phase: 'REFINING_PRD',
      artifactType: 'prd_refined',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        refinedContent: buildPrdDocumentContent({
          epicTitle: refinedEpic,
          storyTitle: refinedStory,
        }),
      }),
    })

    const coverageInputArtifact = makeArtifact({
      phase: 'VERIFYING_PRD_COVERAGE',
      artifactType: 'prd_coverage_input',
      content: JSON.stringify(coverageInputContent),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="WAITING_PRD_APPROVAL"
        isCompleted={false}
        preloadedArtifacts={[refinedArtifact, coverageInputArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /PRD Candidate/i }))

    fireEvent.click(screen.getByText(expectedEpic).closest('button')!)
    expect(screen.getByText(expectedStory)).toBeInTheDocument()
    for (const text of notExpected) {
      expect(screen.queryByText(text)).not.toBeInTheDocument()
    }
  })

  it('shows only the coverage input artifact and Coverage Report during coverage verification', async () => {
    const coverageVerificationCases = [
      {
        phase: 'VERIFYING_PRD_COVERAGE' as const,
        coverageInputArtifactType: 'prd_coverage_input' as const,
        coverageArtifactType: 'prd_coverage' as const,
        coverageInputContent: {
          candidateVersion: 1,
          refinedContent: buildPrdDocumentContent({
            epicTitle: 'Coverage input candidate',
            storyTitle: 'Inspect the candidate under review',
          }),
        },
        artifactButtonName: /PRD Candidate v1/i,
        hiddenText: '1 beads',
        hiddenModel: /GPT-5\.2/i,
        detailText: 'The PRD version currently being checked.',
        candidateContentText: undefined,
        expectDiffUiHidden: true,
      },
      {
        phase: 'VERIFYING_BEADS_COVERAGE' as const,
        coverageInputArtifactType: 'beads_coverage_input' as const,
        coverageArtifactType: 'beads_coverage' as const,
        coverageInputContent: {
          candidateVersion: 1,
          refinedContent: buildBeadsDocumentContent([
            { id: 'bead-1', title: 'Inspect the implementation plan under review' },
          ]),
        },
        artifactButtonName: /Implementation Plan v1/i,
        hiddenText: undefined,
        hiddenModel: /gpt-5\.2/i,
        detailText: 'The implementation plan version currently being checked.',
        candidateContentText: 'Inspect the implementation plan under review',
        expectDiffUiHidden: false,
      },
    ]

    for (const [index, testCase] of coverageVerificationCases.entries()) {
      if (index > 0) {
        cleanup()
      }

      const coverageInputArtifact = makeArtifact({
        phase: testCase.phase,
        artifactType: testCase.coverageInputArtifactType,
        content: JSON.stringify(testCase.coverageInputContent),
      })

      const coverageArtifact = makeArtifact({
        phase: testCase.phase,
        artifactType: testCase.coverageArtifactType,
        content: JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          hasGaps: true,
          coverageRunNumber: 1,
          maxCoveragePasses: 2,
          limitReached: false,
        }),
      })

      renderWithProviders(
        <TestPhaseArtifactsPanel
          phase={testCase.phase}
          isCompleted={false}
          councilMemberNames={['openai/gpt-5.2']}
          preloadedArtifacts={[coverageInputArtifact, coverageArtifact]}
        />,
      )

      expect(screen.getByRole('button', { name: testCase.artifactButtonName })).toBeInTheDocument()
      const coverageButton = screen.getByRole('button', { name: /Coverage Report/i })
      expect(coverageButton).toBeInTheDocument()
      expect(coverageButton).not.toHaveTextContent(/lines/i)
      if (testCase.hiddenText) {
        expect(screen.queryByText(testCase.hiddenText)).not.toBeInTheDocument()
      }
      expect(screen.queryByText(testCase.hiddenModel)).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: testCase.artifactButtonName }))
      expect(screen.getByText(testCase.detailText)).toBeInTheDocument()
      if (testCase.candidateContentText) {
        expect(screen.getByText(testCase.candidateContentText)).toBeInTheDocument()
      }
      if (testCase.expectDiffUiHidden) {
        expect(screen.queryByRole('button', { name: /^Diff(?: \(\d+\))?$/i })).not.toBeInTheDocument()
        expect(screen.queryByText('LoopTroop adjusted this diff.')).not.toBeInTheDocument()
      }
      fireEvent.click(screen.getByRole('button', { name: /Close/i }))
      await expectDialogClosed()

      fireEvent.click(screen.getByRole('button', { name: /Coverage Report/i }))
      expect(screen.getByText('Shows what each coverage pass found, what changed, and why.')).toBeInTheDocument()
    }
  })

  it('shows expanded plan and expansion diff during Beads expansion', () => {
    const semanticPlanContent = buildBeadsDocumentContent([
      { id: 'bead-1', title: 'Inspect the implementation plan under review' },
    ])
    const expandedBead = {
      id: 'proj-1-inspect-the-implementation-plan-under-review',
      title: 'Inspect the implementation plan under review',
      prdRefs: [TEST.epicId, TEST.storyId],
      description: 'Deliver the expanded execution-ready plan.',
      contextGuidance: {
        patterns: ['Keep expansion-specific fields visible.'],
        anti_patterns: ['Do not show coverage revision diffs here.'],
      },
      acceptanceCriteria: ['Validate inspect the implementation plan under review'],
      tests: ['Test inspect the implementation plan under review'],
      testCommands: ['npm run test:server'],
      priority: 1,
      status: 'pending',
      issueType: 'task',
      externalRef: TEST.externalId,
      labels: [`ticket:${TEST.externalId}`, `story:${TEST.storyId}`],
      dependencies: { blocked_by: [], blocks: [] },
      targetFiles: ['src/components/workspace/ExpandedPlanView.tsx'],
      iteration: 1,
      createdAt: '2026-04-15T10:00:00.000Z',
      updatedAt: '2026-04-15T10:00:00.000Z',
    }
    const expandedContent = JSON.stringify(expandedBead)
    const expandedArtifact = makeArtifact({
      phase: 'EXPANDING_BEADS',
      artifactType: 'beads_expanded',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        semanticPlanContent,
        refinedContent: expandedContent,
        expandedContent: JSON.stringify([{
          id: expandedBead.id,
          issueType: expandedBead.issueType,
          labels: expandedBead.labels,
          dependencies: expandedBead.dependencies,
          targetFiles: expandedBead.targetFiles,
        }]),
        candidateVersion: 2,
      }),
    })
    const coverageArtifact = makeArtifact({
      phase: 'VERIFYING_BEADS_COVERAGE',
      artifactType: 'beads_coverage',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        status: 'clean',
        finalCandidateVersion: 2,
        transitions: [{
          fromVersion: 1,
          toVersion: 2,
          summary: 'Coverage revised the semantic plan.',
          gaps: ['Missing expansion test intent.'],
          auditNotes: 'status: gaps',
          fromContent: buildBeadsDocumentContent([{ id: 'bead-1', title: 'Initial semantic plan' }]),
          toContent: semanticPlanContent,
          gapResolutions: [],
          resolutionNotes: [],
          uiRefinementDiff: null,
        }],
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="EXPANDING_BEADS"
        isCompleted={false}
        preloadedArtifacts={[coverageArtifact, expandedArtifact]}
      />,
    )

    expect(screen.getByRole('button', { name: /Expanded Plan v2/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Implementation Plan v2/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Expanded Plan v2/i }))

    expect(screen.getByText('The execution-ready bead plan produced from the validated implementation plan.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Diff vs Plan/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Diff vs v1/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Inspect the implementation plan under review').closest('button')!)
    expect(screen.getByText('Target Files')).toBeInTheDocument()
    expect(screen.getByText('src/components/workspace/ExpandedPlanView.tsx')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    const rawPre = screen.getByText((_text, element) =>
      element?.tagName === 'PRE'
      && Boolean(element.textContent?.includes('semanticPlanContent')),
    )
    expect(rawPre).toHaveClass('overflow-x-hidden', 'break-all')
    expect(rawPre.closest('[class*="overflow-y-auto"]')).toBeInTheDocument()
    expect(screen.queryByTestId('log-viewport')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Diff vs Plan/i }))

    expect(screen.getByText('Model-Added Execution Fields')).toBeInTheDocument()
    expect(screen.getByText('Runtime Defaults')).toBeInTheDocument()
    expect(screen.getByText('Execution ID')).toBeInTheDocument()
    expect(screen.getByText(expandedBead.id)).toBeInTheDocument()
    expect(screen.getByText('src/components/workspace/ExpandedPlanView.tsx')).toBeInTheDocument()
  })

  it('hides stale PRD diff metadata in approval when coverage did not revise the candidate', () => {
    const refinedArtifact = makeArtifact({
      phase: 'REFINING_PRD',
      artifactType: 'prd_refined',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        winnerDraftContent: buildPrdDocumentContent({
          epicTitle: 'Winner PRD draft',
          storyTitle: 'Inspect winner draft sections',
        }),
        refinedContent: buildPrdDocumentContent({
          epicTitle: 'Initial PRD candidate',
          storyTitle: 'Inspect initial candidate sections',
        }),
        structuredOutput: {
          repairApplied: true,
          repairWarnings: ['Dropped no-op PRD refinement modified change at index 0 because the winning and final records are identical.'],
        },
      }),
    })

    const coverageInputArtifact = makeArtifact({
      phase: 'VERIFYING_PRD_COVERAGE',
      artifactType: 'prd_coverage_input',
      content: JSON.stringify({
        candidateVersion: 1,
        fullAnswers: buildPhaseArtifactsInterviewDocumentContent(),
        prd: buildPrdDocumentContent({
          epicTitle: 'Initial PRD candidate',
          storyTitle: 'Inspect initial candidate sections',
        }),
        refinedContent: buildPrdDocumentContent({
          epicTitle: 'Initial PRD candidate',
          storyTitle: 'Inspect initial candidate sections',
        }),
      }),
    })

    const coverageArtifact = makeArtifact({
      phase: 'VERIFYING_PRD_COVERAGE',
      artifactType: 'prd_coverage',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        hasGaps: false,
        status: 'clean',
        summary: 'No coverage gaps found in PRD Candidate v1.',
        coverageRunNumber: 1,
        maxCoveragePasses: 2,
        limitReached: false,
        finalCandidateVersion: 1,
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="WAITING_PRD_APPROVAL"
        isCompleted={false}
        preloadedArtifacts={[refinedArtifact, coverageInputArtifact, coverageArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /PRD Candidate v1/i }))

    expect(screen.getByText('No coverage gaps found in PRD Candidate v1.')).toBeInTheDocument()
    expect(screen.getByText('Initial PRD candidate')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Diff(?: \(\d+\))?$/i })).not.toBeInTheDocument()
    expect(screen.queryByText('LoopTroop adjusted this diff.')).not.toBeInTheDocument()
    expect(screen.queryByText(/Some saved diff details did not line up with the validated artifact/i)).not.toBeInTheDocument()
  })

  it('prefers the latest coverage revision in approval without exposing a separate coverage report artifact', async () => {
    const refinedArtifact = makeArtifact({
      phase: 'REFINING_PRD',
      artifactType: 'prd_refined',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        refinedContent: buildPrdDocumentContent({
          epicTitle: 'Initial refined PRD',
          storyTitle: 'Inspect the initial candidate',
        }),
      }),
    })

    const coverageInputArtifact = makeArtifact({
      phase: 'VERIFYING_PRD_COVERAGE',
      artifactType: 'ui_artifact_companion:prd_coverage_input',
      content: JSON.stringify({
        baseArtifactType: 'prd_coverage_input',
        generatedAt: '2026-03-25T10:16:31.000Z',
        payload: {
          fullAnswers: buildPhaseArtifactsInterviewDocumentContent(),
          prd: buildPrdDocumentContent({
            epicTitle: 'Audit input candidate',
            storyTitle: 'Inspect the audit input',
          }),
          refinedContent: buildPrdDocumentContent({
            epicTitle: 'Audit input candidate',
            storyTitle: 'Inspect the audit input',
          }),
          candidateVersion: 2,
        },
      }),
    })

    const coverageArtifact = makeArtifact({
      phase: 'VERIFYING_PRD_COVERAGE',
      artifactType: 'prd_coverage',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        hasGaps: false,
        coverageRunNumber: 3,
        maxCoveragePasses: 3,
        limitReached: false,
        finalCandidateVersion: 3,
      }),
    })

    const coverageRevisionArtifact = makeArtifact({
      phase: 'VERIFYING_PRD_COVERAGE',
      artifactType: 'prd_coverage_revision',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        refinedContent: buildPrdDocumentContent({
          epicTitle: 'Coverage revised candidate',
          storyTitle: 'Inspect the revised candidate',
        }),
        candidateVersion: 3,
      }),
    })

    const coverageRevisionCompanionArtifact = makeArtifact({
      phase: 'VERIFYING_PRD_COVERAGE',
      artifactType: 'ui_artifact_companion:prd_coverage_revision',
      content: JSON.stringify({
        baseArtifactType: 'prd_coverage_revision',
        generatedAt: '2026-03-25T10:18:32.000Z',
        payload: {
          winnerId: 'openai/gpt-5.2',
          candidateVersion: 3,
          winnerDraftContent: buildPrdDocumentContent({
            epicTitle: 'Audit input candidate',
            storyTitle: 'Inspect the audit input',
          }),
          refinedContent: buildPrdDocumentContent({
            epicTitle: 'Coverage revised candidate',
            storyTitle: 'Inspect the revised candidate',
          }),
          changes: [
            {
              type: 'modified',
              itemType: 'epic',
              before: { id: 'EPIC-1', label: 'Audit input candidate' },
              after: { id: 'EPIC-1', label: 'Coverage revised candidate' },
              inspiration: null,
              attributionStatus: 'model_unattributed',
            },
          ],
          gapResolutions: [
            {
              gap: 'Missing retry-cap approval behavior.',
              action: 'updated_prd',
              rationale: 'Added explicit approval handling when unresolved gaps remain after the retry cap.',
              affectedItems: [
                { itemType: 'epic', id: 'EPIC-1', label: 'Coverage revised candidate' },
              ],
            },
          ],
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="WAITING_PRD_APPROVAL"
        isCompleted={false}
        preloadedArtifacts={[
          refinedArtifact,
          coverageInputArtifact,
          coverageArtifact,
          coverageRevisionArtifact,
          coverageRevisionCompanionArtifact,
        ]}
      />,
    )

    expect(screen.getByRole('button', { name: /PRD Candidate v3/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Coverage Report/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Coverage Review/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Coverage Changes/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Coverage Resolution Notes/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /PRD Candidate v3/i }))
    expect(screen.getByText('Coverage revised candidate')).toBeInTheDocument()
    expect(screen.queryByText('Audit input candidate')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Diff(?: \(\d+\))?$/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Resolution Notes')).not.toBeInTheDocument()
  })

  it('shows no-source badges in generic refinement diff views', () => {
    const refinedArtifact = makeArtifact({
      phase: 'REFINING_PRD',
      artifactType: 'prd_refined',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        winnerDraftContent: buildPrdDocumentContent({
          epicTitle: 'Original PRD review',
          storyTitle: 'Inspect original PRD sections',
        }),
        refinedContent: buildPrdDocumentContent({
          epicTitle: 'Refined PRD review',
          storyTitle: 'Inspect refined PRD sections',
        }),
        changes: [
          {
            type: 'modified',
            itemType: 'epic',
            before: { id: 'EPIC-1', label: 'Original PRD review' },
            after: { id: 'EPIC-1', label: 'Refined PRD review' },
            inspiration: null,
            attributionStatus: 'model_unattributed',
          },
        ],
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="REFINING_PRD"
        isCompleted={false}
        preloadedArtifacts={[refinedArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /PRD Candidate v1/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i }))

    const leafTextMatcher = (text: string) => (_content: string, node: Element | null) => {
      const hasText = (candidate: Element | null) => candidate?.textContent?.includes(text) ?? false
      if (!hasText(node)) return false
      return Array.from(node?.children ?? []).every((child) => !hasText(child))
    }

    expect(screen.getByText('Modified 2')).toBeInTheDocument()
    expect(screen.getAllByText('No source recorded')).toHaveLength(2)
    expect(screen.getByText(leafTextMatcher('Original PRD review'))).toBeInTheDocument()
    expect(screen.getAllByText(leafTextMatcher('Refined PRD review')).length).toBeGreaterThan(0)
    expect(screen.getAllByText(leafTextMatcher('Inspect refined PRD sections')).length).toBeGreaterThan(0)
  })

  it('hides PRD attribution UI in coverage while keeping system badges', () => {
    const coverageRevisionArtifact = makeArtifact({
      phase: 'VERIFYING_PRD_COVERAGE',
      artifactType: 'prd_coverage_revision',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        candidateVersion: 2,
        winnerDraftContent: buildPrdDocumentContent({
          epicTitle: 'Original PRD review',
          storyTitle: 'Inspect original PRD sections',
        }),
        refinedContent: buildPrdDocumentContent({
          epicTitle: 'Coverage revised PRD review',
          storyTitle: 'Inspect revised PRD sections',
        }),
        uiRefinementDiff: {
          domain: 'prd',
          winnerId: 'openai/gpt-5.2',
          generatedAt: '2026-03-12T11:49:34.000Z',
          entries: [
            {
              key: 'epic:EPIC-1',
              changeType: 'modified',
              itemKind: 'epic',
              label: 'Coverage revised PRD review',
              beforeId: 'EPIC-1',
              afterId: 'EPIC-1',
              beforeText: 'Title: Original PRD review',
              afterText: 'Title: Coverage revised PRD review',
              inspiration: {
                memberId: 'openai/gpt-5-mini',
                sourceId: 'EPIC-9',
                sourceLabel: 'Alternative PRD review',
                sourceText: 'Alternative epic wording from a losing draft.',
              },
              attributionStatus: 'inspired',
            },
            {
              key: 'user_story:US-2',
              changeType: 'added',
              itemKind: 'user_story',
              label: 'Inspect revised PRD sections',
              afterId: 'US-2',
              afterText: 'Title: Inspect revised PRD sections',
              inspiration: null,
              attributionStatus: 'model_unattributed',
            },
            {
              key: 'user_story:US-3',
              changeType: 'removed',
              itemKind: 'user_story',
              label: 'Carry forward missing diff context',
              beforeId: 'US-3',
              beforeText: 'Title: Carry forward missing diff context',
              inspiration: null,
              attributionStatus: 'synthesized_unattributed',
            },
            {
              key: 'user_story:US-4',
              changeType: 'modified',
              itemKind: 'user_story',
              label: 'Clear broken attribution safely',
              beforeId: 'US-4',
              afterId: 'US-4',
              beforeText: 'Title: Clear broken attribution',
              afterText: 'Title: Clear broken attribution safely',
              inspiration: null,
              attributionStatus: 'invalid_unattributed',
            },
          ],
        },
        changes: [
          {
            type: 'modified',
            itemType: 'epic',
            before: { id: 'EPIC-1', label: 'Original PRD review' },
            after: { id: 'EPIC-1', label: 'Coverage revised PRD review' },
            inspiration: {
              memberId: 'openai/gpt-5-mini',
              item: {
                id: 'EPIC-9',
                label: 'Alternative PRD review',
                detail: 'Alternative epic wording from a losing draft.',
              },
            },
            attributionStatus: 'inspired',
          },
          {
            type: 'added',
            itemType: 'user_story',
            before: null,
            after: { id: 'US-2', label: 'Inspect revised PRD sections' },
            inspiration: null,
            attributionStatus: 'model_unattributed',
          },
          {
            type: 'removed',
            itemType: 'user_story',
            before: { id: 'US-3', label: 'Carry forward missing diff context' },
            after: null,
            inspiration: null,
            attributionStatus: 'synthesized_unattributed',
          },
          {
            type: 'modified',
            itemType: 'user_story',
            before: { id: 'US-4', label: 'Clear broken attribution' },
            after: { id: 'US-4', label: 'Clear broken attribution safely' },
            inspiration: null,
            attributionStatus: 'invalid_unattributed',
          },
        ],
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="VERIFYING_PRD_COVERAGE"
        isCompleted={false}
        preloadedArtifacts={[coverageRevisionArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /PRD Candidate v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i }))

    expectCoverageAttributionUiHidden()
    expect(screen.getByText('Auto-detected diff')).toBeInTheDocument()
    expect(screen.getByText('Attribution cleared')).toBeInTheDocument()
    expect(screen.getByText('Coverage revised PRD review')).toBeInTheDocument()
    expect(screen.getByText('Inspect revised PRD sections')).toBeInTheDocument()
  })

  it('hides PRD attribution UI in the coverage report changes tab', async () => {
    const coverageArtifact = makeArtifact({
      phase: 'VERIFYING_PRD_COVERAGE',
      artifactType: 'prd_coverage',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        hasGaps: false,
        status: 'clean',
        summary: 'No remaining coverage gaps found in PRD Candidate v3.',
        coverageRunNumber: 3,
        maxCoveragePasses: 3,
        limitReached: false,
        finalCandidateVersion: 3,
        transitions: [
          {
            fromVersion: 1,
            toVersion: 2,
            summary: 'Coverage found 2 gaps in PRD Candidate v1 and created PRD Candidate v2.',
            gaps: ['Gap A', 'Gap B'],
            auditNotes: 'status: gaps',
            fromContent: buildPrdDocumentContent({
              epicTitle: 'Audit input candidate',
              storyTitle: 'Inspect the audit input',
            }),
            toContent: buildPrdDocumentContent({
              epicTitle: 'Coverage revised candidate',
              storyTitle: 'Inspect the revised candidate',
            }),
            gapResolutions: [
              {
                gap: 'Gap A',
                action: 'updated_prd',
                rationale: 'Resolved gap A.',
                affectedItems: [
                  { itemType: 'epic', id: 'EPIC-1', label: 'Coverage revised candidate' },
                ],
              },
            ],
            resolutionNotes: ['Resolved gap A.'],
            uiRefinementDiff: {
              domain: 'prd',
              winnerId: 'openai/gpt-5.2',
              generatedAt: '2026-03-25T10:18:32.000Z',
              entries: [
                {
                  key: 'EPIC-1:modified:0',
                  changeType: 'modified',
                  itemKind: 'epic',
                  label: 'Coverage revised candidate',
                  beforeId: 'EPIC-1',
                  afterId: 'EPIC-1',
                  beforeText: 'Audit input candidate',
                  afterText: 'Coverage revised candidate',
                  inspiration: {
                    memberId: 'openai/gpt-5-mini',
                    sourceId: 'EPIC-8',
                    sourceLabel: 'Alternative audit wording',
                    sourceText: 'Alternative epic wording from the losing draft.',
                    blocks: [],
                  },
                  attributionStatus: 'inspired',
                },
                {
                  key: 'US-2:added:1',
                  changeType: 'added',
                  itemKind: 'user_story',
                  label: 'Inspect the revised candidate',
                  afterId: 'US-2',
                  afterText: 'Inspect the revised candidate',
                  inspiration: null,
                  attributionStatus: 'model_unattributed',
                },
              ],
            },
          },
          {
            fromVersion: 2,
            toVersion: 3,
            summary: 'Coverage found 1 gap in PRD Candidate v2 and created PRD Candidate v3.',
            gaps: ['Gap C'],
            auditNotes: 'status: gaps',
            fromContent: buildPrdDocumentContent({
              epicTitle: 'Coverage revised candidate',
              storyTitle: 'Inspect the revised candidate',
            }),
            toContent: buildPrdDocumentContent({
              epicTitle: 'Final coverage candidate',
              storyTitle: 'Inspect the final candidate',
            }),
            gapResolutions: [
              {
                gap: 'Gap C',
                action: 'updated_prd',
                rationale: 'Resolved gap C.',
                affectedItems: [
                  { itemType: 'epic', id: 'EPIC-1', label: 'Final coverage candidate' },
                ],
              },
            ],
            resolutionNotes: ['Resolved gap C.'],
            uiRefinementDiff: {
              domain: 'prd',
              winnerId: 'openai/gpt-5.2',
              generatedAt: '2026-03-25T10:20:32.000Z',
              entries: [
                {
                  key: 'EPIC-1:modified:0',
                  changeType: 'modified',
                  itemKind: 'epic',
                  label: 'Final coverage candidate',
                  beforeId: 'EPIC-1',
                  afterId: 'EPIC-1',
                  beforeText: 'Coverage revised candidate',
                  afterText: 'Final coverage candidate',
                  inspiration: null,
                  attributionStatus: 'model_unattributed',
                },
              ],
            },
          },
        ],
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="VERIFYING_PRD_COVERAGE"
        isCompleted={false}
        preloadedArtifacts={[coverageArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Coverage Report/i }))
    expect(screen.getByRole('button', { name: /Latest Check/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /v1 > v2/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /v2 > v3/i })).toBeInTheDocument()
    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.textContent?.trim() ?? '')
        .filter((label) => /^v\d+ > v\d+$/.test(label) || label === 'Latest Check'),
    ).toEqual(['v1 > v2', 'v2 > v3', 'Latest Check'])
    expect(screen.getByText('No open coverage gaps remain for PRD Candidate v3')).toBeInTheDocument()
    expect(screen.queryByText('Coverage Gaps Found in PRD Candidate v1')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /v1 > v2/i }))
    expect(screen.getByText('Coverage Gaps Found in PRD Candidate v1')).toBeInTheDocument()
    expect(screen.getByText('Gap A')).toBeInTheDocument()
    expect(screen.getByText('Gap B')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /v2 > v3/i }))
    expect(screen.getByText('Coverage Gaps Found in PRD Candidate v2')).toBeInTheDocument()
    expect(screen.getByText('Gap C')).toBeInTheDocument()
    expect(screen.queryByText('Gap A')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Diff$/i }))

    await waitFor(() => {
      expect(screen.getByText('Final coverage candidate')).toBeInTheDocument()
    })
    expectCoverageAttributionUiHidden()
    expect(screen.getByText('Final coverage candidate')).toBeInTheDocument()
    expect(screen.queryByText('Coverage revised candidate')).not.toBeInTheDocument()
  })

  it.each([
    { phase: 'VERIFYING_INTERVIEW_COVERAGE' as const },
    { phase: 'WAITING_INTERVIEW_APPROVAL' as const },
  ])('hides interview attribution UI in $phase fallback diff view', ({ phase }) => {
    const voteArtifact = makeArtifact({
      phase: 'COUNCIL_VOTING_INTERVIEW',
      artifactType: 'interview_votes',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: [
              'questions:',
              '  - id: Q01',
              '    phase: foundation',
              '    question: "Original winner question?"',
              '  - id: Q02',
              '    phase: structure',
              '    question: "Replacement source question?"',
            ].join('\n'),
          },
        ],
      }),
    })

    const compiledArtifact = makeArtifact({
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'interview_compiled',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        refinedContent: [
          'questions:',
          '  - id: Q01',
          '    phase: foundation',
          '    question: "Refined winner question?"',
          '  - id: Q03',
          '    phase: structure',
          '    question: "Replacement target question?"',
          '  - id: Q04',
          '    phase: assembly',
          '    question: "Added follow-up question?"',
        ].join('\n'),
      }),
    })

    const winnerArtifact = makeArtifact({
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'interview_winner',
      content: JSON.stringify({ winnerId: 'openai/gpt-5.2' }),
    })

    const uiDiffArtifact = makeArtifact({
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'ui_refinement_diff:interview',
      content: JSON.stringify({
        domain: 'interview',
        winnerId: 'openai/gpt-5.2',
        generatedAt: '2026-03-12T11:49:34.000Z',
        entries: [
          {
            key: 'Q03:replaced:0',
            changeType: 'replaced',
            itemKind: 'question',
            label: 'Q03',
            beforeId: 'Q02',
            afterId: 'Q03',
            beforeText: 'Replacement source question?',
            afterText: 'Replacement target question?',
            inspiration: {
              memberId: 'openai/gpt-5.1-codex',
              sourceId: 'Q07',
              sourceLabel: 'Q07',
              sourceText: 'Alternative draft replacement question?',
            },
            attributionStatus: 'inspired',
          },
          {
            key: 'Q04:added:1',
            changeType: 'added',
            itemKind: 'question',
            label: 'Q04',
            afterId: 'Q04',
            afterText: 'Added follow-up question?',
            inspiration: null,
            attributionStatus: 'model_unattributed',
          },
        ],
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase={phase}
        isCompleted={false}
        preloadedArtifacts={[voteArtifact, compiledArtifact, winnerArtifact, uiDiffArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Interview Results/i }))
    fireEvent.click(screen.getByRole('button', { name: /Diff \(2\)/i }))

    expectCoverageAttributionUiHidden()
    expect(screen.getByText('Q03')).toBeInTheDocument()
    expect(screen.getByText('Q04')).toBeInTheDocument()
    expect(getByTextContent('Replacement target question?')).toBeInTheDocument()
  })

  it('hides Beads attribution UI in coverage', () => {
    const refinedArtifact = makeArtifact({
      phase: 'VERIFYING_BEADS_COVERAGE',
      artifactType: 'beads_refined',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        winnerDraftContent: buildBeadsDocumentContent([
          { id: 'bead-1', title: 'Validate refinement attribution' },
        ]),
        refinedContent: buildBeadsDocumentContent([
          { id: 'bead-1', title: 'Validate refinement attribution safely' },
          { id: 'bead-2', title: 'Surface retry metadata' },
        ]),
        changes: [
          {
            type: 'added',
            itemType: 'bead',
            before: null,
            after: { id: 'bead-2', label: 'Surface retry metadata' },
            inspiration: {
              memberId: 'openai/gpt-5-mini',
              item: {
                id: 'bead-9',
                label: 'Adopt losing-draft telemetry',
                detail: 'Description: Surface retry metadata in the diff viewer.',
              },
            },
            attributionStatus: 'inspired',
          },
          {
            type: 'modified',
            itemType: 'bead',
            before: { id: 'bead-1', label: 'Validate refinement attribution' },
            after: { id: 'bead-1', label: 'Validate refinement attribution safely' },
            inspiration: null,
            attributionStatus: 'model_unattributed',
          },
        ],
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="VERIFYING_BEADS_COVERAGE"
        isCompleted={false}
        preloadedArtifacts={[refinedArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Implementation Plan v1/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i }))

    expectCoverageAttributionUiHidden()
    expect(screen.getByText('Surface retry metadata')).toBeInTheDocument()
    expect(screen.getByText('Validate refinement attribution safely')).toBeInTheDocument()
  })

  it.each([
    { phase: 'VERIFYING_BEADS_COVERAGE' as const },
    { phase: 'WAITING_BEADS_APPROVAL' as const },
  ])('hides stale beads diff in $phase when coverage is reviewing the current plan', ({ phase }) => {
    const refinedArtifact = makeArtifact({
      phase: 'REFINING_BEADS',
      artifactType: 'beads_refined',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        winnerDraftContent: buildBeadsDocumentContent([
          { id: 'bead-1', title: 'Winner bead draft' },
        ]),
        refinedContent: buildBeadsDocumentContent([
          { id: 'bead-1', title: 'Current beads candidate' },
        ]),
        structuredOutput: {
          repairApplied: true,
          repairWarnings: ['Dropped no-op beads refinement modified change at index 0 because the winning and final records are identical.'],
        },
      }),
    })

    const coverageInputArtifact = makeArtifact({
      phase: 'VERIFYING_BEADS_COVERAGE',
      artifactType: 'beads_coverage_input',
      content: JSON.stringify({
        candidateVersion: 1,
        beads: buildBeadsDocumentContent([
          { id: 'bead-1', title: 'Current beads candidate' },
        ]),
        refinedContent: buildBeadsDocumentContent([
          { id: 'bead-1', title: 'Current beads candidate' },
        ]),
      }),
    })

    const coverageArtifact = makeArtifact({
      phase: 'VERIFYING_BEADS_COVERAGE',
      artifactType: 'beads_coverage',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        hasGaps: false,
        status: 'clean',
        summary: 'No coverage gaps found in Implementation Plan v1.',
        coverageRunNumber: 1,
        maxCoveragePasses: 2,
        limitReached: false,
        finalCandidateVersion: 1,
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase={phase}
        isCompleted={false}
        preloadedArtifacts={[refinedArtifact, coverageInputArtifact, coverageArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Implementation Plan v1/i }))

    expect(screen.getByText('No coverage gaps found in Implementation Plan v1.')).toBeInTheDocument()
    expect(screen.getByText('Beads')).toBeInTheDocument()
    expect(screen.queryByText('Prior Context (Beads)')).not.toBeInTheDocument()
    expect(screen.queryByText('Under Verification (Beads)')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Diff(?: \(\d+\))?$/i })).not.toBeInTheDocument()
    expect(screen.queryByText('LoopTroop adjusted this diff.')).not.toBeInTheDocument()
  })

  it.each([
    {
      phase: 'VERIFYING_BEADS_COVERAGE' as const,
      version: 2,
      priorTitle: 'Audit input implementation plan',
      revisedTitle: 'Coverage revised implementation plan',
    },
    {
      phase: 'WAITING_BEADS_APPROVAL' as const,
      version: 3,
      priorTitle: 'Reviewed implementation plan',
      revisedTitle: 'Approved implementation plan',
    },
  ])('defaults revised beads candidates to sections in $phase', ({ phase, version, priorTitle, revisedTitle }) => {
    const refinedArtifact = makeArtifact({
      phase: 'REFINING_BEADS',
      artifactType: 'beads_refined',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        refinedContent: buildBeadsDocumentContent([
          { id: 'bead-1', title: priorTitle },
        ]),
        candidateVersion: version - 1,
      }),
    })

    const coverageInputArtifact = makeArtifact({
      phase: 'VERIFYING_BEADS_COVERAGE',
      artifactType: 'beads_coverage_input',
      content: JSON.stringify({
        beads: buildBeadsDocumentContent([
          { id: 'bead-1', title: priorTitle },
        ]),
        refinedContent: buildBeadsDocumentContent([
          { id: 'bead-1', title: priorTitle },
        ]),
        candidateVersion: version - 1,
      }),
    })

    const coverageRevisionArtifact = makeArtifact({
      phase: 'VERIFYING_BEADS_COVERAGE',
      artifactType: 'beads_coverage_revision',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        candidateVersion: version,
        refinedContent: buildBeadsDocumentContent([
          { id: 'bead-1', title: revisedTitle },
        ]),
      }),
    })

    const coverageRevisionCompanionArtifact = makeArtifact({
      phase: 'VERIFYING_BEADS_COVERAGE',
      artifactType: 'ui_artifact_companion:beads_coverage_revision',
      content: JSON.stringify({
        baseArtifactType: 'beads_coverage_revision',
        generatedAt: '2026-04-04T10:18:32.000Z',
        payload: {
          winnerId: 'openai/gpt-5.2',
          candidateVersion: version,
          winnerDraftContent: buildBeadsDocumentContent([
            { id: 'bead-1', title: priorTitle },
          ]),
          refinedContent: buildBeadsDocumentContent([
            { id: 'bead-1', title: revisedTitle },
          ]),
          changes: [
            {
              type: 'modified',
              itemType: 'bead',
              before: { id: 'bead-1', label: priorTitle },
              after: { id: 'bead-1', label: revisedTitle },
              inspiration: null,
              attributionStatus: 'model_unattributed',
            },
          ],
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase={phase}
        isCompleted={false}
        preloadedArtifacts={[
          refinedArtifact,
          coverageInputArtifact,
          coverageRevisionArtifact,
          coverageRevisionCompanionArtifact,
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Implementation Plan v${version}`, 'i') }))

    expect(screen.getByText('Beads')).toBeInTheDocument()
    expect(screen.queryByText('Prior Context (Beads)')).not.toBeInTheDocument()
    expect(screen.queryByText('Under Verification (Beads)')).not.toBeInTheDocument()
    expect(screen.getByText(revisedTitle)).toBeInTheDocument()
    if (phase === 'VERIFYING_BEADS_COVERAGE') {
      expect(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i })).toBeInTheDocument()
      expect(screen.queryByText('Modified')).not.toBeInTheDocument()
    } else {
      expect(screen.queryByRole('button', { name: /^Diff(?: \(\d+\))?$/i })).not.toBeInTheDocument()
    }
  })

  it.each([
    {
      scenario: 'shows cleanup notice for no-op refinement warnings',
      repairWarnings: [
        'Dropped no-op PRD refinement modified change at index 0 because the winning and final records are identical.',
        'Dropped no-op PRD refinement modified change at index 1 because the winning and final records are identical.',
      ],
      expectedText: 'LoopTroop adjusted this diff.',
      expectedDetail: /Dropped no-op PRD refinement modified change at index 0/i,
      expectedCount: 'Dropped 2',
      notExpected: 'Synthesized 1',
    },
    {
      scenario: 'shows cleanup notice for no-op interview warnings',
      repairWarnings: [
        'Dropped no-op interview refinement modified at index 0 because the question is unchanged across the winning and final drafts.',
      ],
      expectedText: 'LoopTroop adjusted this diff.',
      expectedDetail: /Dropped no-op interview refinement modified at index 0/i,
      expectedCount: 'Dropped 1',
      notExpected: 'Synthesized 1',
    },
    {
      scenario: 'keeps the broader repair notice for non-no-op repairs',
      repairWarnings: [
        'Inferred missing PRD refinement item_type at index 0 as epic.',
      ],
      expectedText: 'LoopTroop adjusted this diff.',
      expectedDetail: /Inferred missing PRD refinement item_type at index 0 as epic/i,
      expectedCount: 'Synthesized 1',
      notExpected: 'Dropped 1',
    },
  ])('$scenario', ({ repairWarnings, expectedText, expectedDetail, expectedCount, notExpected }) => {
    const refinedArtifact = makeArtifact({
      phase: 'REFINING_PRD',
      artifactType: 'prd_refined',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        winnerDraftContent: buildPrdDocumentContent({
          epicTitle: 'Original PRD review',
          storyTitle: 'Inspect original PRD sections',
        }),
        refinedContent: buildPrdDocumentContent({
          epicTitle: 'Refined PRD review',
          storyTitle: 'Inspect refined PRD sections',
        }),
        structuredOutput: {
          repairApplied: true,
          repairWarnings,
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="REFINING_PRD"
        isCompleted={false}
        preloadedArtifacts={[refinedArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /PRD Candidate/i }))

    const noticeButton = screen.getByText(expectedText).closest('button')!
    expect(noticeButton).toBeInTheDocument()
    expect(screen.queryByText(expectedDetail)).not.toBeInTheDocument()
    expect(screen.getByText(expectedCount)).toBeInTheDocument()

    fireEvent.click(noticeButton)

    expect(screen.getByText(expectedDetail)).toBeInTheDocument()
    expect(screen.getByText(expectedCount)).toBeInTheDocument()
    expect(screen.queryByText(notExpected)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i }))
    expect(screen.queryByText(expectedText)).not.toBeInTheDocument()
  })

  it('uses category counts for mixed repair warnings and shows raw technical detail on expand', () => {
    const refinedArtifact = makeArtifact({
      phase: 'REFINING_PRD',
      artifactType: 'prd_refined',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        winnerDraftContent: buildPrdDocumentContent({
          epicTitle: 'Original PRD review',
          storyTitle: 'Inspect original PRD sections',
        }),
        refinedContent: buildPrdDocumentContent({
          epicTitle: 'Refined PRD review',
          storyTitle: 'Inspect refined PRD sections',
        }),
        structuredOutput: {
          repairApplied: true,
          repairWarnings: [
            'Dropped no-op interview refinement modified at index 0 because the question is unchanged across the winning and final drafts.',
            'Inferred missing PRD refinement item_type at index 0 as epic.',
          ],
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="REFINING_PRD"
        isCompleted={false}
        preloadedArtifacts={[refinedArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /PRD Candidate/i }))

    const noticeButton = screen.getByText('LoopTroop adjusted this diff.').closest('button')!
    expect(noticeButton).toBeInTheDocument()
    expect(screen.getByText(/2 interventions across 2 categories/)).toBeInTheDocument()
    expect(screen.getByText('Synthesized 1')).toBeInTheDocument()
    expect(screen.getByText('Dropped 1')).toBeInTheDocument()

    fireEvent.click(noticeButton)

    expect(screen.getByText(/2 interventions across 2 categories/)).toBeInTheDocument()
    expect(screen.getByText('Synthesized 1')).toBeInTheDocument()
    expect(screen.getByText('Dropped 1')).toBeInTheDocument()
    expect(screen.getByText(/Dropped no-op interview refinement modified at index 0/i)).toBeInTheDocument()
    expect(screen.getByText(/Inferred missing PRD refinement item_type at index 0 as epic/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i }))
    expect(screen.queryByText('LoopTroop adjusted this diff.')).not.toBeInTheDocument()
  })

  it('hides the interview diff repair notice when only a bare repair flag is present', () => {
    const voteArtifact = makeArtifact({
      phase: 'COUNCIL_VOTING_INTERVIEW',
      artifactType: 'interview_votes',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: 'questions:\n  - id: Q01\n    phase: foundation\n    question: "Original winner question?"',
          },
        ],
      }),
    })

    const compiledArtifact = makeArtifact({
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'interview_compiled',
      content: JSON.stringify({
        refinedContent: 'questions:\n  - id: Q01\n    phase: foundation\n    question: "Refined winner question?"',
      }),
    })

    const compiledCompanionArtifact = makeArtifact({
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'ui_artifact_companion:interview_compiled',
      content: JSON.stringify({
        baseArtifactType: 'interview_compiled',
        generatedAt: '2026-03-12T11:49:32.000Z',
        payload: {
          winnerId: 'openai/gpt-5.2',
          questions: [{ id: 'Q01', phase: 'Foundation', question: 'Refined winner question?' }],
          questionCount: 1,
          structuredOutput: {
            repairApplied: true,
            repairWarnings: [],
          },
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="WAITING_INTERVIEW_APPROVAL"
        isCompleted={false}
        preloadedArtifacts={[voteArtifact, compiledArtifact, compiledCompanionArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Interview Results/i }))
    fireEvent.click(screen.getByRole('button', { name: /Diff \(1\)/i }))

    expect(screen.queryByText('LoopTroop adjusted this diff.')).not.toBeInTheDocument()
    expect(screen.queryByText(/Some saved diff details did not line up with the validated artifact/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Comparing winning draft from gpt-5.2/i)).toBeInTheDocument()
    expect(screen.getByText('Modified 1')).toBeInTheDocument()
  })

  it('keeps the final interview artifact available while waiting for interview answers', () => {
    const compiledArtifact = makeArtifact({
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'interview_compiled',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        refinedContent: 'questions:\n  - id: Q01\n    question: "Final?"',
        questions: [{ id: 'Q01', phase: 'Foundation', question: 'Final?' }],
        questionCount: 48,
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="WAITING_INTERVIEW_ANSWERS"
        isCompleted={false}
        preloadedArtifacts={[compiledArtifact]}
      />,
    )

    expect(screen.getByText('Interview Answers')).toBeInTheDocument()
    expect(screen.getByText('Final Interview Results')).toBeInTheDocument()
    expect(screen.getByText('gpt-5.2 · 48 questions')).toBeInTheDocument()
    expect(screen.queryByText('Interview Draft Diff')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Final Interview Results/i }))
    expect(screen.getByRole('button', { name: /Final Questions/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Diff(?: \(\d+\))?$/i })).not.toBeInTheDocument()
  })

  it('keeps the final interview diff tab available in later interview review phases', () => {
    const voteArtifact = makeArtifact({
      phase: 'COUNCIL_VOTING_INTERVIEW',
      artifactType: 'interview_votes',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: 'questions:\n  - id: Q01\n    phase: foundation\n    question: "Original winner question?"',
            questionCount: 1,
          },
        ],
      }),
    })

    const compiledArtifact = makeArtifact({
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'interview_compiled',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        refinedContent: 'questions:\n  - id: Q01\n    phase: foundation\n    question: "Refined winner question?"',
        questions: [{ id: 'Q01', phase: 'Foundation', question: 'Refined winner question?' }],
        questionCount: 1,
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="WAITING_INTERVIEW_APPROVAL"
        isCompleted={false}
        preloadedArtifacts={[voteArtifact, compiledArtifact]}
      />,
    )

    expect(screen.getByText('Interview Results')).toBeInTheDocument()
    expect(screen.queryByText('Interview Answers')).not.toBeInTheDocument()
    expect(screen.queryByText('Final Interview Results')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Interview Results/i }))
    expect(screen.getByRole('button', { name: /Final Questions/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Diff \(1\)/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Diff \(1\)/i }))
    expect(screen.getByText(/Comparing winning draft from gpt-5.2/i)).toBeInTheDocument()
    expect(screen.getByText('Modified 1')).toBeInTheDocument()
    expect(getByTextContent('Original winner question?')).toBeInTheDocument()
    expect(getByTextContent('Refined winner question?')).toBeInTheDocument()
  })

  it('restores interview inspiration indicators from the separate ui diff artifact', async () => {
    const voteArtifact = makeArtifact({
      phase: 'COUNCIL_VOTING_INTERVIEW',
      artifactType: 'interview_votes',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: [
              'questions:',
              '  - id: Q02',
              '    phase: structure',
              '    question: "Replacement source question?"',
            ].join('\n'),
          },
        ],
      }),
    })

    const compiledArtifact = makeArtifact({
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'interview_compiled',
      content: JSON.stringify({
        refinedContent: [
          'questions:',
          '  - id: Q03',
          '    phase: structure',
          '    question: "Replacement target question?"',
        ].join('\n'),
      }),
    })

    const compiledCompanionArtifact = makeArtifact({
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'ui_artifact_companion:interview_compiled',
      content: JSON.stringify({
        baseArtifactType: 'interview_compiled',
        generatedAt: '2026-03-12T11:49:32.000Z',
        payload: {
          winnerId: 'openai/gpt-5.2',
          questions: [{ id: 'Q03', phase: 'Structure', question: 'Replacement target question?' }],
          questionCount: 1,
        },
      }),
    })

    const winnerArtifact = makeArtifact({
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'interview_winner',
      content: JSON.stringify({ winnerId: 'openai/gpt-5.2' }),
    })

    const uiDiffArtifact = makeArtifact({
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'ui_refinement_diff:interview',
      content: JSON.stringify({
        domain: 'interview',
        winnerId: 'openai/gpt-5.2',
        generatedAt: '2026-03-12T11:49:34.000Z',
        entries: [
          {
            key: 'Q03:replaced:0',
            changeType: 'replaced',
            itemKind: 'question',
            label: 'Q03',
            beforeId: 'Q02',
            afterId: 'Q03',
            beforeText: 'Replacement source question?',
            afterText: 'Replacement target question?',
            inspiration: {
              memberId: 'openai/gpt-5.1-codex',
              sourceId: 'Q07',
              sourceLabel: 'Q07',
              sourceText: 'Alternative draft replacement question?',
            },
            attributionStatus: 'inspired',
          },
        ],
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="COMPILING_INTERVIEW"
        isCompleted={false}
        preloadedArtifacts={[voteArtifact, compiledArtifact, compiledCompanionArtifact, winnerArtifact, uiDiffArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Final Interview Results/i }))
    fireEvent.click(screen.getByRole('button', { name: /Diff \(1\)/i }))

    expect(screen.queryByText('No source recorded')).not.toBeInTheDocument()
    await expectFirstInspirationTooltip('Alternative draft replacement question?')
  })

  it.each([
    { phase: 'REFINING_PRD' as const, buttonName: /PRD Candidate v1/i },
  ])('shows PRD inspiration tooltip text in $phase', async ({ phase, buttonName }) => {
    const epicText = [
      'Title: Refined PRD review',
      '',
      'Objective: Make PRD artifacts easy to inspect.',
    ].join('\n')
    const storyText = [
      'Title: Expose retry telemetry',
      '',
      'Acceptance Criteria:',
      '- Show retry telemetry in the diff tooltip.',
      '',
      'Implementation Steps:',
      '- Implement retry telemetry rendering.',
      '',
      'Verification Commands:',
      '- npm run test',
    ].join('\n')

    const refinedArtifact = makeArtifact({
      phase: 'REFINING_PRD',
      artifactType: 'prd_refined',
      content: JSON.stringify({
        refinedContent: buildPrdDocumentContent({
          epicTitle: 'Refined PRD review',
          storyTitle: 'Inspect refined PRD sections',
        }),
      }),
    })

    const uiDiffArtifact = makeArtifact({
      phase: 'REFINING_PRD',
      artifactType: 'ui_refinement_diff:prd',
      content: JSON.stringify({
        domain: 'prd',
        winnerId: 'openai/gpt-5.2',
        generatedAt: '2026-03-12T11:49:34.000Z',
        entries: [
          {
            key: 'user_story:US-3',
            changeType: 'added',
            itemKind: 'user_story',
            label: 'Surface retry metadata',
            afterId: 'US-3',
            afterText: 'Title: Surface retry metadata',
            inspiration: {
              memberId: 'openai/gpt-5-mini',
              sourceId: 'US-8',
              sourceLabel: 'Expose retry telemetry',
              sourceText: storyText,
              blocks: [
                {
                  kind: 'epic',
                  id: 'EPIC-1',
                  label: 'Refined PRD review',
                  text: epicText,
                },
                {
                  kind: 'user_story',
                  id: 'US-8',
                  label: 'Expose retry telemetry',
                  text: storyText,
                },
              ],
            },
            attributionStatus: 'inspired',
          },
        ],
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase={phase}
        isCompleted={false}
        preloadedArtifacts={[refinedArtifact, uiDiffArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: buttonName }))
    fireEvent.click(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i }))

    expect(screen.queryByText('No source recorded')).not.toBeInTheDocument()
    expect(screen.getByText('Surface retry metadata')).toBeInTheDocument()
    await expectFirstInspirationTooltip([epicText, storyText])
  })

  it.each([
    { phase: 'REFINING_BEADS' as const, buttonName: /Final Blueprint Draft/i },
  ])('shows Beads inspiration tooltip text in $phase', async ({ phase, buttonName }) => {
    const beadText = [
      'Title: Adopt losing-draft telemetry',
      '',
      'Description: Surface retry metadata in the diff viewer.',
      '',
      'Acceptance Criteria:',
      '- Validate losing-draft telemetry',
      '',
      'Tests:',
      '- Test losing-draft telemetry',
      '',
      'Test Commands:',
      '- npm run test:server',
    ].join('\n')
    const epicText = [
      'Title: Refined PRD review',
      '',
      'Objective: Make PRD artifacts easy to inspect.',
    ].join('\n')
    const storyText = [
      'Title: Inspect refined PRD sections',
      '',
      'Acceptance Criteria:',
      '- Show epics and user stories in the structured view.',
    ].join('\n')

    const refinedArtifact = makeArtifact({
      phase: 'REFINING_BEADS',
      artifactType: 'beads_refined',
      content: JSON.stringify({
        refinedContent: buildBeadsDocumentContent([
          { id: 'bead-1', title: 'Validate refinement attribution' },
          { id: 'bead-2', title: 'Surface retry metadata' },
        ]),
      }),
    })

    const uiDiffArtifact = makeArtifact({
      phase: 'REFINING_BEADS',
      artifactType: 'ui_refinement_diff:beads',
      content: JSON.stringify({
        domain: 'beads',
        winnerId: 'openai/gpt-5.2',
        generatedAt: '2026-03-12T11:49:34.000Z',
        entries: [
          {
            key: 'bead:bead-2',
            changeType: 'added',
            itemKind: 'bead',
            label: 'Surface retry metadata',
            afterId: 'bead-2',
            afterText: 'Title: Surface retry metadata',
            inspiration: {
              memberId: 'openai/gpt-5-mini',
              sourceId: 'bead-9',
              sourceLabel: 'Adopt losing-draft telemetry',
              sourceText: beadText,
              blocks: [
                {
                  kind: 'bead',
                  id: 'bead-9',
                  label: 'Adopt losing-draft telemetry',
                  text: beadText,
                },
                {
                  kind: 'epic',
                  id: 'EPIC-1',
                  label: 'Refined PRD review',
                  text: epicText,
                },
                {
                  kind: 'user_story',
                  id: 'US-1',
                  label: 'Inspect refined PRD sections',
                  text: storyText,
                },
              ],
            },
            attributionStatus: 'inspired',
          },
        ],
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase={phase}
        isCompleted={false}
        preloadedArtifacts={[refinedArtifact, uiDiffArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: buttonName }))
    fireEvent.click(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i }))

    expect(screen.queryByText('No source recorded')).not.toBeInTheDocument()
    expect(screen.getByText('Surface retry metadata')).toBeInTheDocument()
    await expectFirstInspirationTooltip([beadText, epicText, storyText])
  })

  it('falls back to a single legacy tooltip block when inspiration blocks are missing', async () => {
    const sourceText = [
      'Title: Expose retry telemetry',
      '',
      'Acceptance Criteria:',
      '- Show retry telemetry in the diff tooltip.',
    ].join('\n')

    const refinedArtifact = makeArtifact({
      phase: 'REFINING_PRD',
      artifactType: 'prd_refined',
      content: JSON.stringify({
        refinedContent: buildPrdDocumentContent({
          epicTitle: 'Refined PRD review',
          storyTitle: 'Inspect refined PRD sections',
        }),
      }),
    })

    const uiDiffArtifact = makeArtifact({
      phase: 'REFINING_PRD',
      artifactType: 'ui_refinement_diff:prd',
      content: JSON.stringify({
        domain: 'prd',
        winnerId: 'openai/gpt-5.2',
        generatedAt: '2026-03-12T11:49:34.000Z',
        entries: [
          {
            key: 'user_story:US-3',
            changeType: 'added',
            itemKind: 'user_story',
            label: 'Surface retry metadata',
            afterId: 'US-3',
            afterText: 'Title: Surface retry metadata',
            inspiration: {
              memberId: 'openai/gpt-5-mini',
              sourceId: 'US-8',
              sourceLabel: 'Expose retry telemetry',
              sourceText,
            },
            attributionStatus: 'inspired',
          },
        ],
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="REFINING_PRD"
        isCompleted={false}
        preloadedArtifacts={[refinedArtifact, uiDiffArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /PRD Candidate v1/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i }))

    await expectFirstInspirationTooltip(sourceText)
  })

  it('shows beads draft metrics on the council cards during DRAFTING_BEADS', () => {
    const draftArtifact = makeArtifact({
      phase: 'DRAFTING_BEADS',
      artifactType: 'beads_drafts',
      content: JSON.stringify({
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: buildBeadsDocumentContent([
              { id: 'bead-1', title: 'Validate refinement attribution' },
              { id: 'bead-2', title: 'Surface retry metadata' },
            ]),
          },
        ],
        memberOutcomes: {
          'openai/gpt-5.2': 'completed',
        },
        isFinal: true,
      }),
    })

    const companionArtifact = makeArtifact({
      phase: 'DRAFTING_BEADS',
      artifactType: 'ui_artifact_companion:beads_drafts',
      content: buildBeadsDraftCompanionContent(),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="DRAFTING_BEADS"
        isCompleted={false}
        councilMemberCount={1}
        councilMemberNames={['openai/gpt-5.2']}
        preloadedArtifacts={[draftArtifact, companionArtifact]}
      />,
    )

    expect(screen.getByText('2 beads · 5 tests · 6 criteria')).toBeInTheDocument()
    expect(screen.getByText(/Finished/)).toBeInTheDocument()
  })

  it('shows bead counts instead of question counts while live beads drafts are still running', () => {
    const draftArtifact = makeArtifact({
      phase: 'DRAFTING_BEADS',
      artifactType: 'beads_drafts',
      content: JSON.stringify({
        drafts: [
          {
            memberId: 'openai/gpt-5.2',
            outcome: 'completed',
            content: buildBeadsDocumentContent([
              { id: 'bead-1', title: 'Validate refinement attribution' },
              { id: 'bead-2', title: 'Surface retry metadata' },
            ]),
          },
          {
            memberId: 'openai/gpt-5.1-codex',
            outcome: 'pending',
          },
        ],
        memberOutcomes: {
          'openai/gpt-5.2': 'completed',
          'openai/gpt-5.1-codex': 'pending',
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="DRAFTING_BEADS"
        isCompleted={false}
        councilMemberCount={2}
        councilMemberNames={['openai/gpt-5.2', 'openai/gpt-5.1-codex']}
        preloadedArtifacts={[draftArtifact]}
      />,
    )

    expect(screen.getByText('2 beads')).toBeInTheDocument()
    expect(screen.getByText('waiting for response')).toBeInTheDocument()
    expect(screen.queryByText(/proposed \d+ questions/i)).not.toBeInTheDocument()
  })

  it('prefers the canonical interview result in later interview phases when coverage input is available', () => {
    const compiledArtifact = makeArtifact({
      phase: 'COMPILING_INTERVIEW',
      artifactType: 'interview_compiled',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        refinedContent: 'questions:\n  - id: Q01\n    phase: foundation\n    question: "Old compiled question?"',
        questions: [{ id: 'Q01', phase: 'Foundation', question: 'Old compiled question?' }],
        questionCount: 1,
      }),
    })

    const coverageInputArtifact = makeArtifact({
      phase: 'VERIFYING_INTERVIEW_COVERAGE',
      artifactType: 'interview_coverage_input',
      content: JSON.stringify({
        interview: [
          'schema_version: 1',
          `ticket_id: ${TEST.externalId}`,
          'artifact: interview',
          'status: approved',
          'generated_by:',
          '  winner_model: openai/gpt-5.2',
          '  generated_at: 2026-03-12T11:50:31.000Z',
          'questions:',
          '  - id: Q01',
          '    phase: Foundation',
          '    prompt: "Canonical interview question?"',
          '    source: compiled',
          '    answer_type: free_text',
          '    options: []',
          '    answer:',
          '      skipped: false',
          '      selected_option_ids: []',
          '      free_text: "Canonical answer."',
          '      answered_by: user',
          '      answered_at: 2026-03-12T11:50:31.000Z',
          'follow_up_rounds: []',
          'summary:',
          '  goals: [Preserve canonical interview results]',
          '  constraints: [Keep answers visible]',
          '  non_goals: [Show compiled fallback]',
          '  final_free_form_answer: ""',
          'approval:',
          '  approved_by: ""',
          '  approved_at: ""',
        ].join('\n'),
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="WAITING_INTERVIEW_APPROVAL"
        isCompleted={false}
        preloadedArtifacts={[compiledArtifact, coverageInputArtifact]}
      />,
    )

    expect(screen.getByText('1 question')).toBeInTheDocument()
    expect(screen.getByText('Interview Results')).toBeInTheDocument()
    expect(screen.queryByText('Interview Answers')).not.toBeInTheDocument()
    expect(screen.queryByText('Final Interview Results')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Interview Results/i }))
    expect(screen.queryByRole('button', { name: /Final Questions/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Foundation/i }))
    expect(screen.getByText('Canonical interview question?')).toBeInTheDocument()
    expect(screen.getByText('Canonical answer.')).toBeInTheDocument()
    expect(screen.queryByText('Old compiled question?')).not.toBeInTheDocument()
  })

  it('shows a single interview results artifact during coverage verification', () => {
    const coverageInputArtifact = makeArtifact({
      phase: 'VERIFYING_INTERVIEW_COVERAGE',
      artifactType: 'interview_coverage_input',
      content: JSON.stringify({
        interview: [
          'schema_version: 1',
          `ticket_id: ${TEST.externalId}`,
          'artifact: interview',
          'status: approved',
          'generated_by:',
          '  winner_model: openai/gpt-5.2',
          '  generated_at: 2026-03-12T11:50:31.000Z',
          'questions:',
          '  - id: Q01',
          '    phase: Foundation',
          '    prompt: "Coverage interview question?"',
          '    source: compiled',
          '    answer_type: free_text',
          '    options: []',
          '    answer:',
          '      skipped: false',
          '      selected_option_ids: []',
          '      free_text: "Coverage answer."',
          '      answered_by: user',
          '      answered_at: 2026-03-12T11:50:31.000Z',
          'follow_up_rounds: []',
          'summary:',
          '  goals: [Preserve coverage interview results]',
          '  constraints: [Keep answers visible]',
          '  non_goals: [Show raw compiled artifact]',
          '  final_free_form_answer: ""',
          'approval:',
          '  approved_by: ""',
          '  approved_at: ""',
        ].join('\n'),
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="VERIFYING_INTERVIEW_COVERAGE"
        isCompleted={false}
        preloadedArtifacts={[coverageInputArtifact]}
      />,
    )

    expect(screen.getByText('Interview Results')).toBeInTheDocument()
    expect(screen.queryByText('Interview Answers')).not.toBeInTheDocument()
    expect(screen.queryByText('Final Interview Results')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Interview Results/i }))
    fireEvent.click(screen.getByRole('button', { name: /Foundation/i }))
    expect(screen.getByText('Coverage interview question?')).toBeInTheDocument()
    expect(screen.getByText('Coverage answer.')).toBeInTheDocument()
  })

  it('renders interview coverage summaries and follow-up questions before raw audit output', () => {
    const coverageArtifact = makeArtifact({
      phase: 'VERIFYING_INTERVIEW_COVERAGE',
      artifactType: 'interview_coverage',
      content: JSON.stringify({
        winnerId: 'openai/gpt-5.2',
        response: 'status: gaps\nfollow_up_questions:\n  - id: FU01\n    question: "Which fallback should be used?"\n',
        hasGaps: true,
        coverageRunNumber: 2,
        maxCoveragePasses: 2,
        limitReached: true,
        terminationReason: 'coverage_pass_limit_reached',
        followUpBudgetPercent: 20,
        followUpBudgetTotal: 10,
        followUpBudgetUsed: 10,
        followUpBudgetRemaining: 0,
        parsed: {
          status: 'gaps',
          gaps: ['Missing fallback behavior for skipped answers.'],
          followUpQuestions: [
            {
              id: 'FU01',
              question: 'Which fallback should be used?',
              phase: 'Assembly',
              priority: 'high',
              rationale: 'Close the final interview gap before PRD generation.',
            },
          ],
        },
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="VERIFYING_INTERVIEW_COVERAGE"
        isCompleted={false}
        preloadedArtifacts={[coverageArtifact]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /gpt-5\.2/i }))
    expect(screen.getByText('Coverage review found gaps')).toBeInTheDocument()
    expect(screen.getByText(/Coverage review of the compiled interview/i)).toBeInTheDocument()
    expect(screen.getByText('This pass found 1 gap between the compiled interview and the submitted answers.')).toBeInTheDocument()
    expect(screen.getByText('Retry cap reached; moving to approval with unresolved gaps.')).toBeInTheDocument()
    expect(screen.getByText('Follow-up budget: 10/10 used (20%) · 0 remaining')).toBeInTheDocument()
    expect(screen.getByText('Open Coverage Gaps')).toBeInTheDocument()
    expect(screen.getByText('Missing fallback behavior for skipped answers.')).toBeInTheDocument()
    expect(screen.getByText('Which fallback should be used?')).toBeInTheDocument()
    expect(screen.getByText('Close the final interview gap before PRD generation.')).toBeInTheDocument()
  })

  it('shows pull request metadata directly on the Creating Pull Request artifact and opens the structured report', () => {
    const pullRequestArtifact = makeArtifact({
      phase: 'CREATING_PULL_REQUEST',
      artifactType: 'pull_request_report',
      content: JSON.stringify({
        status: 'passed',
        completedAt: '2026-04-10T15:58:47.116Z',
        baseBranch: 'master',
        headBranch: 'POBA-9',
        candidateCommitSha: 'c2708197a117389f594e4f6f8cc4262bf9d3bd6d',
        prNumber: 42,
        prUrl: 'https://github.com/looptroop-ai/pocketbase-master/pull/42',
        prState: 'draft',
        prHeadSha: 'c2708197a117389f594e4f6f8cc4262bf9d3bd6d',
        title: 'POBA-9: t13',
        body: '## Summary\n- Adds the scoped theme regression test.',
        message: 'Draft pull request ready at https://github.com/looptroop-ai/pocketbase-master/pull/42.',
      }),
    })

    renderWithProviders(
      <TestPhaseArtifactsPanel
        phase="CREATING_PULL_REQUEST"
        isCompleted={true}
        preloadedArtifacts={[pullRequestArtifact]}
      />,
    )

    expect(screen.getByText('Pull Request Report')).toBeInTheDocument()
    expect(screen.getByText('#42 · draft')).toBeInTheDocument()
    expect(screen.queryByText(/https:\/\/github\.com\/looptroop-ai\/pocketbase-master\/pull\/42/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Pull Request Report/i }))
    expect(screen.getByRole('link', { name: /open draft pr in github/i })).toHaveAttribute(
      'href',
      'https://github.com/looptroop-ai/pocketbase-master/pull/42',
    )
    expect(screen.getByText('Adds the scoped theme regression test.')).toBeInTheDocument()
  })
})
