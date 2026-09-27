import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseUiArtifactCompanionArtifact } from '@shared/artifactCompanions'
import { VOTING_RUBRIC, type Vote } from '../../council/types'
import type { conductVoting as ConductVoting } from '../../council/voter'
import { clearProjectDatabaseCache } from '../../db/project'
import { getLatestPhaseArtifact } from '../../storage/tickets'
import { TEST } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import type { TicketContext } from '../../machines/types'
import { phaseIntermediate } from '../phases/state'

const { conductVotingMock, selectWinnerMock } = vi.hoisted(() => ({
  conductVotingMock: vi.fn(),
  selectWinnerMock: vi.fn(),
}))

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({}),
  isMockOpenCodeMode: () => false,
}))

vi.mock('../../council/voter', async () => {
  const actual = await vi.importActual<typeof import('../../council/voter')>('../../council/voter')
  return {
    ...actual,
    conductVoting: conductVotingMock,
    selectWinner: selectWinnerMock,
  }
})

import { handleInterviewVote } from '../phases/interviewPhase'

const repoManager = createTestRepoManager('interview-vote-')

function buildInterviewDraftContent(suffix: string) {
  return [
    'questions:',
    '  - id: Q01',
    '    phase: Foundation',
    `    question: "Which constraints should the implementation preserve${suffix}?"`,
  ].join('\n')
}

function buildVoteScores(totalScore: number): Vote['scores'] {
  return [
    'Coverage of requirements',
    'Correctness / feasibility',
    'Testability',
    'Minimal complexity / good decomposition',
    'Risks / edge cases addressed',
  ].map((category) => ({
    category,
    score: Math.floor(totalScore / 5),
    justification: `Scored ${category}`,
  }))
}

describe('interview voting workflow', () => {
  beforeEach(() => {
    resetTestDb()
    phaseIntermediate.clear()
    conductVotingMock.mockReset()
    selectWinnerMock.mockReset()
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('rejects voting when interview drafts have not been stored', async () => {
    await expect(handleInterviewVote(
      'missing-interview-drafts',
      {} as TicketContext,
      vi.fn(),
      new AbortController().signal,
    )).rejects.toThrow('No interview drafts found — cannot vote')
  })

  it.each([
    { outcome: 'error' as const, expectedError: 'Interview voting quorum not met' },
    { outcome: 'completed' as const, expectedError: 'no valid vote responses received' },
  ])('rejects an empty vote result when voter outcomes are $outcome', async ({ outcome, expectedError }) => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Reject an empty interview vote result',
    })
    phaseIntermediate.set(`${ticket.id}:interview`, {
      drafts: [
        {
          memberId: TEST.councilMembers[0],
          outcome: 'completed',
          duration: 11,
          content: buildInterviewDraftContent('Which constraints are fixed?'),
        },
      ],
      memberOutcomes: { [TEST.councilMembers[0]]: 'completed' },
      worktreePath: paths.worktreePath,
      phase: 'interview_draft',
    })
    conductVotingMock.mockResolvedValueOnce({
      votes: [],
      memberOutcomes: Object.fromEntries(TEST.councilMembers.slice(0, 2).map((memberId) => [memberId, outcome])),
      deadlineReached: false,
      presentationOrders: {},
      voterDetails: [],
    })

    await expect(handleInterviewVote(ticket.id, context, vi.fn(), new AbortController().signal))
      .rejects.toThrow(expectedError)
    expect(selectWinnerMock).not.toHaveBeenCalled()
  })

  it('builds vote prompts from ticket context and emits live OpenCode callbacks', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Build an interview vote prompt from the ticket',
    })
    const sendEvent = vi.fn()
    const drafts = [
      {
        memberId: TEST.councilMembers[0],
        outcome: 'completed' as const,
        duration: 11,
        content: buildInterviewDraftContent('Which constraints are fixed?'),
      },
      {
        memberId: TEST.councilMembers[1],
        outcome: 'completed' as const,
        duration: 12,
        content: buildInterviewDraftContent('Which failure cases matter?'),
      },
    ]
    phaseIntermediate.set(`${ticket.id}:interview`, {
      drafts,
      memberOutcomes: {
        [TEST.councilMembers[0]]: 'completed',
        [TEST.councilMembers[1]]: 'completed',
      },
      worktreePath: paths.worktreePath,
      phase: 'interview_draft',
    })

    const firstVoterId = TEST.councilMembers[0]
    const vote: Vote = {
      voterId: firstVoterId,
      draftId: TEST.councilMembers[0],
      scores: buildVoteScores(90),
      totalScore: 90,
    }
    const structuredOutput = { repairApplied: false, repairWarnings: [], autoRetryCount: 0 }
    conductVotingMock.mockImplementationOnce(async (
      _adapter: Parameters<typeof ConductVoting>[0],
      members: Parameters<typeof ConductVoting>[1],
      voterDrafts: Parameters<typeof ConductVoting>[2],
      contextParts: Parameters<typeof ConductVoting>[3],
      _projectPath: Parameters<typeof ConductVoting>[4],
      _phase: Parameters<typeof ConductVoting>[5],
      _timeoutMs: Parameters<typeof ConductVoting>[6],
      _signal: Parameters<typeof ConductVoting>[7],
      onSessionLog: Parameters<typeof ConductVoting>[8],
      onStreamEvent: Parameters<typeof ConductVoting>[9],
      onPromptDispatched: Parameters<typeof ConductVoting>[10],
      onVoteProgress: Parameters<typeof ConductVoting>[11],
      buildPromptForVoter: Parameters<typeof ConductVoting>[12],
    ) => {
      expect(contextParts).toEqual([])
      onSessionLog?.({
        stage: 'vote',
        memberId: firstVoterId,
        sessionId: 'interview-vote-session',
        response: 'response from interview voter',
        messages: [],
      })
      onStreamEvent?.({
        stage: 'vote',
        memberId: firstVoterId,
        sessionId: 'interview-vote-session',
        event: {
          type: 'text',
          sessionId: 'interview-vote-session',
          text: 'streamed vote response',
          streaming: false,
          complete: true,
        },
      })
      onPromptDispatched?.({
        stage: 'vote',
        memberId: firstVoterId,
        event: {
          session: { id: 'interview-vote-session' },
          parts: [{ type: 'text', content: 'interview vote prompt' }],
          promptText: 'interview vote prompt',
          promptNumber: 1,
          timeoutKind: 'ai_response',
        },
      })
      onVoteProgress?.({
        memberId: firstVoterId,
        outcome: 'completed',
        votes: [vote],
        rawResponse: 'raw vote response',
        normalizedResponse: 'normalized vote response',
        structuredOutput,
      })

      const prompt = buildPromptForVoter?.({
        voter: members[0]!,
        anonymizedDrafts: voterDrafts.map((draft, index) => ({
          draftId: draft.memberId,
          content: `Draft ${index + 1}:\n${draft.content}`,
        })),
        rubric: VOTING_RUBRIC,
      })
      expect(prompt?.map((part) => part.content).join('\n')).toContain(context.title)

      return {
        votes: [vote],
        memberOutcomes: {
          [TEST.councilMembers[0]]: 'completed',
          [TEST.councilMembers[1]]: 'completed',
        },
        deadlineReached: false,
        presentationOrders: {},
        voterDetails: [{
          voterId: firstVoterId,
          rawResponse: 'raw vote response',
          normalizedResponse: 'normalized vote response',
          structuredOutput,
        }],
      }
    })
    selectWinnerMock.mockReturnValueOnce({ winnerId: firstVoterId, totalScore: 90 })

    await handleInterviewVote(ticket.id, context, sendEvent, new AbortController().signal)

    expect(conductVotingMock).toHaveBeenCalledOnce()
    expect(phaseIntermediate.get(`${ticket.id}:interview`)?.winnerId).toBe(firstVoterId)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'WINNER_SELECTED', winner: firstVoterId })
    const voteCompanion = parseUiArtifactCompanionArtifact(
      getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:interview_votes', 'COUNCIL_VOTING_INTERVIEW')!.content,
    )?.payload as { voterDetails?: Array<{ structuredOutput?: typeof structuredOutput }> } | undefined
    expect(voteCompanion?.voterDetails?.[0]?.structuredOutput).toEqual(structuredOutput)
  })

  it('persists raw voter responses in live and final interview vote companions', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Capture interview vote raw output',
    })
    const sendEvent = vi.fn()

    phaseIntermediate.set(`${ticket.id}:interview`, {
      drafts: [
        {
          memberId: TEST.councilMembers[0],
          outcome: 'completed',
          duration: 11,
          content: buildInterviewDraftContent(''),
        },
        {
          memberId: TEST.councilMembers[1],
          outcome: 'completed',
          duration: 12,
          content: buildInterviewDraftContent(' in the alternative draft'),
        },
      ],
      memberOutcomes: {
        [TEST.councilMembers[0]]: 'completed',
        [TEST.councilMembers[1]]: 'completed',
      },
      worktreePath: paths.worktreePath,
      phase: 'interview_draft',
      ticketState: {
        ticketId: context.externalId,
        title: context.title,
        description: context.title,
        relevantFiles: 'files:\n  - path: src/main.ts',
      },
    })

    conductVotingMock.mockImplementationOnce(async (
      _adapter: unknown,
      _members: Array<{ modelId: string }>,
      _drafts: Array<{ memberId: string; content: string }>,
      _contextParts: Array<{ content?: string }>,
      _projectPath: string,
      _phase: string,
      _timeoutMs: number,
      _signal: AbortSignal,
      _onOpenCodeSessionLog: unknown,
      _onOpenCodeStreamEvent: unknown,
      _onOpenCodePromptDispatched: unknown,
      onVoteProgress?: (entry: { memberId: string; outcome: string; votes: Vote[]; rawResponse?: string; normalizedResponse?: string }) => void,
    ) => {
      const firstRawResponse = 'draft_scores:\n  Draft 1:\n    total_score: 91'
      const firstNormalizedResponse = 'draft_scores:\n  Draft 1:\n    total_score: 91\n'
      const secondRawResponse = 'draft_scores:\n  Draft 1:\n    total_score: 89'
      const firstVote: Vote = {
        voterId: TEST.councilMembers[0],
        draftId: TEST.councilMembers[0],
        scores: buildVoteScores(90),
        totalScore: 91,
      }
      const secondVote: Vote = {
        voterId: TEST.councilMembers[1],
        draftId: TEST.councilMembers[1],
        scores: buildVoteScores(85),
        totalScore: 89,
      }

      onVoteProgress?.({
        memberId: TEST.councilMembers[0],
        outcome: 'completed',
        votes: [firstVote],
        rawResponse: firstRawResponse,
        normalizedResponse: firstNormalizedResponse,
      })

      const liveCompanionRow = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:interview_votes', 'COUNCIL_VOTING_INTERVIEW')
      const liveCompanion = parseUiArtifactCompanionArtifact(liveCompanionRow!.content)?.payload as {
        voterDetails?: Array<{ voterId?: string; rawResponse?: string; normalizedResponse?: string }>
      } | undefined
      expect(liveCompanion?.voterDetails?.[0]?.rawResponse).toBe(firstRawResponse)
      expect(liveCompanion?.voterDetails?.[0]?.normalizedResponse).toBe(firstNormalizedResponse)

      onVoteProgress?.({
        memberId: TEST.councilMembers[1],
        outcome: 'completed',
        votes: [secondVote],
        rawResponse: secondRawResponse,
      })

      return {
        votes: [firstVote, secondVote],
        memberOutcomes: {
          [TEST.councilMembers[0]]: 'completed',
          [TEST.councilMembers[1]]: 'completed',
        },
        deadlineReached: false,
        presentationOrders: {},
        voterDetails: [
          { voterId: TEST.councilMembers[0], rawResponse: firstRawResponse, normalizedResponse: firstNormalizedResponse },
          { voterId: TEST.councilMembers[1], rawResponse: secondRawResponse },
        ],
      }
    })
    selectWinnerMock.mockReturnValueOnce({ winnerId: TEST.councilMembers[0], totalScore: 91 })

    await handleInterviewVote(ticket.id, context, sendEvent, new AbortController().signal)

    const voteCompanionRow = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:interview_votes', 'COUNCIL_VOTING_INTERVIEW')
    const voteCompanion = parseUiArtifactCompanionArtifact(voteCompanionRow!.content)?.payload as {
      voterDetails?: Array<{ voterId?: string; rawResponse?: string; normalizedResponse?: string }>
      winnerId?: string
    } | undefined

    expect(voteCompanion?.voterDetails?.[0]?.rawResponse).toBe('draft_scores:\n  Draft 1:\n    total_score: 91')
    expect(voteCompanion?.voterDetails?.[0]?.normalizedResponse).toBe('draft_scores:\n  Draft 1:\n    total_score: 91\n')
    expect(voteCompanion?.voterDetails?.[1]?.rawResponse).toBe('draft_scores:\n  Draft 1:\n    total_score: 89')
    expect(voteCompanion?.winnerId).toBe(TEST.councilMembers[0])
    expect(sendEvent).toHaveBeenCalledWith({ type: 'WINNER_SELECTED', winner: TEST.councilMembers[0] })
  })
})
