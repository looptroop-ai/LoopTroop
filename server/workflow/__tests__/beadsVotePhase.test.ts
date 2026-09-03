import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseUiArtifactCompanionArtifact } from '@shared/artifactCompanions'
import type { Vote } from '../../council/types'
import { VOTING_RUBRIC_BEADS } from '../../council/types'
import { clearProjectDatabaseCache } from '../../db/project'
import { getLatestPhaseArtifact } from '../../storage/tickets'
import { TEST, makePrdYaml } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { buildBeadsContextBuilder } from '../../phases/beads/draft'
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

import { handleBeadsVote, handleMockBeadsVote } from '../phases/beadsPhase'

const repoManager = createTestRepoManager('beads-vote-')

function buildBeadsDraftContent(titleSuffix = ''): string {
  return [
    'beads:',
    '  - id: "project-local-storage-plumbing"',
    `    title: "Project-local storage plumbing${titleSuffix}"`,
    '    prdRefs:',
    '      - "EPIC-1"',
    '      - "US-1-1"',
    '    description: "Store runtime state under the project-local .looptroop directory."',
    '    contextGuidance:',
    '      patterns:',
    '        - "Resolve paths from the project-local ticket directory first."',
    '      anti_patterns:',
    '        - "Do not write runtime data into the app checkout."',
    '    acceptanceCriteria:',
    '      - "Beads output stays isolated to the ticket worktree."',
    '    tests:',
    '      - "Regression test covers ticket workspace path resolution."',
    '    testCommands:',
    '      - "npm run test -- server/routes"',
  ].join('\n')
}

function buildVoteScores(scores: number[]): Vote['scores'] {
  return [
    'Coverage of PRD requirements',
    'Correctness / feasibility of technical approach',
    'Quality and isolation of bead-scoped tests',
    'Minimal complexity / good dependency management',
    'Risks / edge cases addressed',
  ].map((category, index) => ({
    category,
    score: scores[index] ?? 0,
    justification: `Scored ${category}`,
  }))
}

describe('beads voting workflow', () => {
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

  it('votes on beads with PROM21 context, live artifact updates, and structured output metadata', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager, {
      title: 'Harden beads voting',
      description: 'Keep the architecture vote parity strict.',
    })
    const sendEvent = vi.fn()
    const ticketState = {
      ticketId: context.externalId,
      title: context.title,
      description: context.title,
      relevantFiles: [
        'file_count: 1',
        'files:',
        '  - path: server/workflow/phases/beadsPhase.ts',
        '    rationale: Beads vote prompt needs the phase implementation context.',
        '    relevance: high',
        '    likely_action: read',
        '    content_preview: |',
        '      export function buildBeadsVotePrompt(...)',
      ].join('\n'),
      prd: makePrdYaml({
        ticketId: context.externalId,
        problemStatement: 'Harden beads voting parity.',
        storyCount: 2,
      }),
    }

    phaseIntermediate.set(`${ticket.id}:beads`, {
      drafts: [
        {
          memberId: TEST.councilMembers[0],
          outcome: 'completed',
          duration: 11,
          content: buildBeadsDraftContent(),
        },
        {
          memberId: TEST.councilMembers[1],
          outcome: 'completed',
          duration: 12,
          content: buildBeadsDraftContent(' (alternative)'),
        },
      ],
      memberOutcomes: {
        [TEST.councilMembers[0]]: 'completed',
        [TEST.councilMembers[1]]: 'completed',
      },
      contextBuilder: buildBeadsContextBuilder(ticketState),
      worktreePath: paths.worktreePath,
      phase: 'beads_draft',
      ticketState,
    })

    conductVotingMock.mockImplementationOnce(async (
      _adapter: unknown,
      _members: Array<{ modelId: string }>,
      drafts: Array<{ memberId: string; content: string }>,
      contextParts: Array<{ content?: string }>,
      _projectPath: string,
      phase: string,
      _timeoutMs: number,
      _signal: AbortSignal,
      _onOpenCodeSessionLog: unknown,
      _onOpenCodeStreamEvent: unknown,
      _onOpenCodePromptDispatched: unknown,
      onVoteProgress?: (entry: {
        memberId: string
        outcome: string
        votes: Vote[]
        error?: string
        structuredOutput?: {
          repairApplied: boolean
          repairWarnings: string[]
          autoRetryCount: number
          validationError?: string
          retryDiagnostics?: Array<{
            attempt?: number
            validationError?: string
            target?: string
            excerpt?: string
          }>
        }
        rawResponse?: string
        normalizedResponse?: string
      }) => void,
      buildPromptForVoter?: (entry: {
        voter: { modelId: string }
        anonymizedDrafts: Array<{ draftId: string; content: string }>
        rubric: Array<{ category: string; weight: number; description: string }>
      }) => Array<{ type: 'text'; content: string }>,
    ) => {
      expect(phase).toBe('beads_draft')
      expect(contextParts).toEqual([])
      expect(buildPromptForVoter).toBeTypeOf('function')

      const prompt = buildPromptForVoter!({
        voter: { modelId: TEST.councilMembers[0] },
        anonymizedDrafts: [
          { draftId: drafts[0]!.memberId, content: `Draft 1:\n${drafts[0]!.content}` },
          { draftId: drafts[1]!.memberId, content: `Draft 2:\n${drafts[1]!.content}` },
        ],
        rubric: VOTING_RUBRIC_BEADS,
      })

      expect(prompt).toHaveLength(1)
      const rendered = prompt.map((part) => part.content).join('\n')
      expect(rendered).toContain('### ticket_details')
      expect(rendered).toContain('### relevant_files')
      expect(rendered).toContain('### prd')
      expect(rendered).toContain('### draft')
      expect(rendered).toContain('### vote_rubric')
      expect(rendered).toContain('Drafts are presented in randomized order per evaluator')
      expect(rendered).toContain('compare each draft against the final PRD')
      expect(rendered).toContain('Use the exact PROM21 `draft_scores` YAML schema')
      expect(rendered).toContain('Draft 1:')
      expect(rendered).toContain('Draft 2:')

      const firstVote: Vote = {
        voterId: TEST.councilMembers[0],
        draftId: TEST.councilMembers[0],
        scores: buildVoteScores([19, 18, 19, 18, 18]),
        totalScore: 92,
      }
      const secondVote: Vote = {
        voterId: TEST.councilMembers[0],
        draftId: TEST.councilMembers[1],
        scores: buildVoteScores([16, 15, 15, 16, 15]),
        totalScore: 77,
      }
      const thirdVote: Vote = {
        voterId: TEST.councilMembers[1],
        draftId: TEST.councilMembers[0],
        scores: buildVoteScores([18, 19, 19, 18, 18]),
        totalScore: 92,
      }
      const fourthVote: Vote = {
        voterId: TEST.councilMembers[1],
        draftId: TEST.councilMembers[1],
        scores: buildVoteScores([15, 16, 15, 15, 16]),
        totalScore: 77,
      }
      const firstRawResponse = 'draft_scores:\n  Draft 1:\n    total_score: 92'
      const firstNormalizedResponse = 'draft_scores:\n  Draft 1:\n    total_score: 92\n'
      const secondRawResponse = 'draft_scores:\n  Draft 1:\n    total_score: 92\n  Draft 2:\n    total_score: 77'

      onVoteProgress?.({
        memberId: TEST.councilMembers[0],
        outcome: 'completed',
        votes: [firstVote, secondVote],
        rawResponse: firstRawResponse,
        normalizedResponse: firstNormalizedResponse,
        structuredOutput: {
          repairApplied: true,
          repairWarnings: ['Normalized beads vote scorecard indentation.'],
          autoRetryCount: 1,
          validationError: 'Vote scorecard output required a structured retry',
          retryDiagnostics: [
            {
              attempt: 1,
              validationError: 'Vote scorecard output required a structured retry',
              target: 'Draft 2',
              excerpt: 'Draft 2: score: pending',
            },
          ],
        },
      })
      const liveVoteCompanionRow = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:beads_votes', 'COUNCIL_VOTING_BEADS')
      expect(liveVoteCompanionRow).toBeDefined()
      const liveVoteCompanion = parseUiArtifactCompanionArtifact(liveVoteCompanionRow!.content)?.payload as {
        votes?: Vote[]
        voterOutcomes?: Record<string, string>
        voterDetails?: Array<{
          voterId?: string
          structuredOutput?: {
            repairApplied?: boolean
            repairWarnings?: string[]
            autoRetryCount?: number
            validationError?: string
            retryDiagnostics?: Array<{
              attempt?: number
              validationError?: string
              target?: string
              excerpt?: string
            }>
          }
          rawResponse?: string
          normalizedResponse?: string
        }>
      } | undefined
      expect(liveVoteCompanion?.votes).toHaveLength(2)
      expect(liveVoteCompanion?.voterOutcomes).toEqual({
        [TEST.councilMembers[0]]: 'completed',
        [TEST.councilMembers[1]]: 'pending',
      })
      expect(liveVoteCompanion?.voterDetails?.[0]?.structuredOutput).toMatchObject({
        repairApplied: true,
        autoRetryCount: 1,
        validationError: 'Vote scorecard output required a structured retry',
      })
      expect(liveVoteCompanion?.voterDetails?.[0]?.rawResponse).toBe(firstRawResponse)
      expect(liveVoteCompanion?.voterDetails?.[0]?.normalizedResponse).toBe(firstNormalizedResponse)
      expect(liveVoteCompanion?.voterDetails?.[0]?.structuredOutput?.retryDiagnostics).toEqual([
        expect.objectContaining({
          attempt: 1,
          validationError: 'Vote scorecard output required a structured retry',
          target: 'Draft 2',
          excerpt: 'Draft 2: score: pending',
        }),
      ])

      onVoteProgress?.({
        memberId: TEST.councilMembers[1],
        outcome: 'completed',
        votes: [thirdVote, fourthVote],
        rawResponse: secondRawResponse,
        structuredOutput: {
          repairApplied: false,
          repairWarnings: [],
          autoRetryCount: 0,
        },
      })

      return {
        votes: [firstVote, secondVote, thirdVote, fourthVote],
        memberOutcomes: {
          [TEST.councilMembers[0]]: 'completed',
          [TEST.councilMembers[1]]: 'completed',
        },
        deadlineReached: false,
        presentationOrders: {
          [TEST.councilMembers[0]]: {
            seed: 'seed-alpha',
            order: [TEST.councilMembers[0], TEST.councilMembers[1]],
          },
          [TEST.councilMembers[1]]: {
            seed: 'seed-beta',
            order: [TEST.councilMembers[1], TEST.councilMembers[0]],
          },
        },
        voterDetails: [
          {
            voterId: TEST.councilMembers[0],
            structuredOutput: {
              repairApplied: true,
              repairWarnings: ['Normalized beads vote scorecard indentation.'],
              autoRetryCount: 1,
              validationError: 'Vote scorecard output required a structured retry',
              retryDiagnostics: [
                {
                  attempt: 1,
                  validationError: 'Vote scorecard output required a structured retry',
                  target: 'Draft 2',
                  excerpt: 'Draft 2: score: pending',
                },
              ],
            },
            rawResponse: firstRawResponse,
            normalizedResponse: firstNormalizedResponse,
          },
          {
            voterId: TEST.councilMembers[1],
            rawResponse: secondRawResponse,
            structuredOutput: {
              repairApplied: false,
              repairWarnings: [],
              autoRetryCount: 0,
            },
          },
        ],
      }
    })
    selectWinnerMock.mockReturnValueOnce({ winnerId: TEST.councilMembers[0], totalScore: 184 })

    await handleBeadsVote(ticket.id, context, sendEvent, new AbortController().signal)

    const voteRow = getLatestPhaseArtifact(ticket.id, 'beads_votes', 'COUNCIL_VOTING_BEADS')
    const voteCompanionRow = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:beads_votes', 'COUNCIL_VOTING_BEADS')
    const voteArtifact = JSON.parse(voteRow!.content) as {
      winnerId?: string
      isFinal?: boolean
    }
    const voteCompanion = parseUiArtifactCompanionArtifact(voteCompanionRow!.content)?.payload as {
      votes?: Vote[]
      voterOutcomes?: Record<string, string>
      presentationOrders?: Record<string, { seed: string; order: string[] }>
      voterDetails?: Array<{
        voterId?: string
        structuredOutput?: {
          repairApplied?: boolean
          repairWarnings?: string[]
          autoRetryCount?: number
          validationError?: string
          retryDiagnostics?: Array<{
            attempt?: number
            validationError?: string
            target?: string
            excerpt?: string
          }>
        }
        rawResponse?: string
        normalizedResponse?: string
      }>
      drafts?: Array<{ memberId?: string; outcome?: string; content?: string }>
      winnerId?: string
      totalScore?: number
    } | undefined

    expect(voteArtifact.isFinal).toBe(true)
    expect(voteArtifact.winnerId).toBe(TEST.councilMembers[0])
    expect(voteCompanion?.votes).toHaveLength(4)
    expect(voteCompanion?.voterOutcomes).toEqual({
      [TEST.councilMembers[0]]: 'completed',
      [TEST.councilMembers[1]]: 'completed',
    })
    expect(voteCompanion?.presentationOrders?.[TEST.councilMembers[0]]).toEqual({
      seed: 'seed-alpha',
      order: [TEST.councilMembers[0], TEST.councilMembers[1]],
    })
    expect(voteCompanion?.presentationOrders?.[TEST.councilMembers[1]]).toEqual({
      seed: 'seed-beta',
      order: [TEST.councilMembers[1], TEST.councilMembers[0]],
    })
    expect(voteCompanion?.voterDetails?.[0]?.structuredOutput).toMatchObject({
      repairApplied: true,
      autoRetryCount: 1,
      validationError: 'Vote scorecard output required a structured retry',
    })
    expect(voteCompanion?.voterDetails?.[0]?.rawResponse).toBe('draft_scores:\n  Draft 1:\n    total_score: 92')
    expect(voteCompanion?.voterDetails?.[0]?.normalizedResponse).toBe('draft_scores:\n  Draft 1:\n    total_score: 92\n')
    expect(voteCompanion?.voterDetails?.[1]?.rawResponse).toBe('draft_scores:\n  Draft 1:\n    total_score: 92\n  Draft 2:\n    total_score: 77')
    expect(voteCompanion?.voterDetails?.[0]?.structuredOutput?.retryDiagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        validationError: 'Vote scorecard output required a structured retry',
        target: 'Draft 2',
        excerpt: 'Draft 2: score: pending',
      }),
    ])
    expect(voteCompanion?.winnerId).toBe(TEST.councilMembers[0])
    expect(voteCompanion?.totalScore).toBe(184)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'WINNER_SELECTED', winner: TEST.councilMembers[0] })

    const intermediate = phaseIntermediate.get(`${ticket.id}:beads`)
    expect(intermediate?.winnerId).toBe(TEST.councilMembers[0])
    expect(intermediate?.votes).toHaveLength(4)
    expect(intermediate?.presentationOrders?.[TEST.councilMembers[1]]?.order).toEqual([
      TEST.councilMembers[1],
      TEST.councilMembers[0],
    ])
    expect(voteCompanion?.drafts?.every((draft) => draft.content?.startsWith('beads:'))).toBe(true)
  })

  it('persists mock beads votes with canonical bead drafts and realistic vote scores', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager, {
      title: 'Mock beads parity',
      description: 'Keep mock beads voting structured.',
    })
    const sendEvent = vi.fn()
    selectWinnerMock.mockReturnValueOnce({ winnerId: TEST.councilMembers[0], totalScore: 184 })

    await handleMockBeadsVote(ticket.id, context, sendEvent)

    const voteRow = getLatestPhaseArtifact(ticket.id, 'beads_votes', 'COUNCIL_VOTING_BEADS')
    const voteCompanionRow = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:beads_votes', 'COUNCIL_VOTING_BEADS')
    const voteArtifact = JSON.parse(voteRow!.content) as {
      winnerId?: string
      isFinal?: boolean
    }
    const voteCompanion = parseUiArtifactCompanionArtifact(voteCompanionRow!.content)?.payload as {
      votes?: Vote[]
      presentationOrders?: Record<string, { seed: string; order: string[] }>
      voterOutcomes?: Record<string, string>
      drafts?: Array<{ memberId?: string; outcome?: string; content?: string }>
      totalScore?: number
    } | undefined

    expect(voteArtifact.isFinal).toBe(true)
    expect(voteArtifact.winnerId).toBe(TEST.councilMembers[0])
    expect(voteCompanion?.votes).toHaveLength(4)
    expect(voteCompanion?.totalScore).toBe(184)
    expect(voteCompanion?.presentationOrders?.[TEST.councilMembers[0]]?.order).toEqual([
      TEST.councilMembers[0],
      TEST.councilMembers[1],
    ])
    expect(voteCompanion?.presentationOrders?.[TEST.councilMembers[1]]?.order).toEqual([
      TEST.councilMembers[1],
      TEST.councilMembers[0],
    ])
    expect(voteCompanion?.voterOutcomes).toEqual({
      [TEST.councilMembers[0]]: 'completed',
      [TEST.councilMembers[1]]: 'completed',
    })
    expect(voteCompanion?.drafts?.[0]?.content).toContain('beads:')
    expect(voteCompanion?.drafts?.[0]?.content).toContain('contextGuidance:')
    expect(sendEvent).toHaveBeenCalledWith({ type: 'WINNER_SELECTED', winner: TEST.councilMembers[0] })
  })
})
