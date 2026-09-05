import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseUiArtifactCompanionArtifact } from '@shared/artifactCompanions'
import type { DraftResult, Vote } from '../../council/types'
import { clearProjectDatabaseCache } from '../../db/project'
import { getLatestPhaseArtifact } from '../../storage/tickets'
import { TEST, makeInterviewYaml, makePrdYaml } from '../../test/factories'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { phaseIntermediate } from '../phases/state'

const { draftPRDMock, conductVotingMock, selectWinnerMock } = vi.hoisted(() => ({
  draftPRDMock: vi.fn(),
  conductVotingMock: vi.fn(),
  selectWinnerMock: vi.fn(),
}))

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({}),
  isMockOpenCodeMode: () => false,
}))

vi.mock('../../phases/prd/draft', async () => {
  const actual = await vi.importActual<typeof import('../../phases/prd/draft')>('../../phases/prd/draft')
  return {
    ...actual,
    draftPRD: draftPRDMock,
  }
})

vi.mock('../../council/voter', async () => {
  const actual = await vi.importActual<typeof import('../../council/voter')>('../../council/voter')
  return {
    ...actual,
    conductVoting: conductVotingMock,
    selectWinner: selectWinnerMock,
  }
})

import { handleMockPrdDraft, handleMockPrdVote, handlePrdDraft, handlePrdVote } from '../phases/prdPhase'
import { upsertCouncilDraftArtifact } from '../phases/helpers'

const repoManager = createTestRepoManager('prd-draft-')

describe('handlePrdDraft', () => {
  beforeEach(() => {
    resetTestDb()
    phaseIntermediate.clear()
    draftPRDMock.mockReset()
    conductVotingMock.mockReset()
    selectWinnerMock.mockReset()
  })

  afterAll(() => {
    clearProjectDatabaseCache()
    repoManager.cleanup()
  })

  it('fails fast before drafting when the canonical interview artifact is missing', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)
    const sendEvent = vi.fn()

    await expect(handlePrdDraft(ticket.id, context, sendEvent, new AbortController().signal))
      .rejects
      .toThrow('Canonical interview artifact is required before PRD drafting')

    expect(draftPRDMock).not.toHaveBeenCalled()
    expect(getLatestPhaseArtifact(ticket.id, 'prd_drafts', 'DRAFTING_PRD')).toBeUndefined()
  })

  it('persists invalid draft diagnostics without visible artifact content', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const malformedOutput = 'not a valid PRD draft but previously leaked into artifact body'
    const drafts: DraftResult[] = [{
      memberId: TEST.councilMembers[0],
      content: malformedOutput,
      outcome: 'invalid_output',
      duration: 123,
      error: 'PRD draft failed validation',
      rawResponse: malformedOutput,
      rawAttempts: [{
        attempt: 1,
        stage: 'prd_draft',
        outcome: 'rejected',
        rawResponse: malformedOutput,
        validationError: 'PRD draft failed validation',
        failureClass: 'validation_error',
      }],
      structuredOutput: {
        repairApplied: false,
        repairWarnings: [],
        autoRetryCount: 0,
        validationError: 'PRD draft failed validation',
        failureClass: 'validation_error',
      },
    }]

    upsertCouncilDraftArtifact(ticket.id, 'DRAFTING_PRD', 'prd_drafts', drafts, {
      [TEST.councilMembers[0]]: 'invalid_output',
    }, true)

    const coreRow = getLatestPhaseArtifact(ticket.id, 'prd_drafts', 'DRAFTING_PRD')
    const companionRow = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_drafts', 'DRAFTING_PRD')
    expect(coreRow).toBeDefined()
    expect(companionRow).toBeDefined()

    const corePayload = JSON.parse(coreRow!.content) as { drafts?: Array<{ content?: string; outcome?: string }> }
    expect(corePayload.drafts?.[0]).toMatchObject({ outcome: 'invalid_output' })
    expect(corePayload.drafts?.[0]?.content).toBeUndefined()

    const companionPayload = parseUiArtifactCompanionArtifact(companionRow!.content)?.payload as {
      draftDetails?: Array<{ content?: string; rawResponse?: string; rawAttempts?: Array<{ rawResponse?: string }> }>
    } | undefined
    expect(companionPayload?.draftDetails?.[0]?.content).toBeUndefined()
    expect(companionPayload?.draftDetails?.[0]?.rawResponse).toBe(malformedOutput)
    expect(companionPayload?.draftDetails?.[0]?.rawAttempts?.[0]?.rawResponse).toBe(malformedOutput)
  })

  it('persists normalized draft metadata and logs PRD-specific metrics', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    const sendEvent = vi.fn()

    writeFileSync(`${paths.ticketDir}/interview.yaml`, makeInterviewYaml({ ticket_id: ticket.externalId }), 'utf-8')
    writeFileSync(`${paths.ticketDir}/relevant-files.yaml`, 'files:\n  - path: src/main.ts\n', 'utf-8')
    let expectedFullAnswersContent = ''
    let expectedFullAnswersRawResponse = ''
    let expectedPrdContent = ''
    let expectedPrdRawResponse = ''
    draftPRDMock.mockImplementationOnce(async (
      _adapter: unknown,
      _members: unknown,
      ticketState: { ticketId?: string; interview?: string; relevantFiles?: string },
      _projectPath: string,
      options: { ticketId?: string; ticketExternalId?: string },
      _signal: AbortSignal,
      _onOpenCodeSessionLog: unknown,
      _onOpenCodeStreamEvent: unknown,
      _onOpenCodePromptDispatched: unknown,
      onDraftProgress?: (entry: {
        memberId: string
        status: 'session_created' | 'finished'
        sessionId?: string
        outcome?: 'completed'
        duration?: number
        content?: string
        draftMetrics?: { epicCount?: number; userStoryCount?: number }
        rawResponse?: string
        normalizedResponse?: string
        structuredOutput?: {
          repairApplied?: boolean
          repairWarnings?: string[]
          autoRetryCount?: number
          validationError?: string
          retryDiagnostics?: Array<{
            attempt?: number
            validationError?: string
            excerpt?: string
          }>
        }
      }) => void,
      onFullAnswersProgress?: (entry: {
        memberId: string
        status: 'session_created' | 'finished'
        outcome?: 'completed'
        sessionId?: string
        duration?: number
        content?: string
        questionCount?: number
        rawResponse?: string
        normalizedResponse?: string
        structuredOutput?: {
          repairApplied?: boolean
          repairWarnings?: string[]
          autoRetryCount?: number
          validationError?: string
          retryDiagnostics?: Array<{
            attempt?: number
            validationError?: string
            excerpt?: string
          }>
        }
      }) => void,
    ) => {
      expect(ticketState.ticketId).toBe(ticket.externalId)
      expect(ticketState.relevantFiles).toContain('src/main.ts')
      expect(ticketState.interview).toContain('artifact: interview')
      expect(options.ticketId).toBe(ticket.id)
      expect(options.ticketExternalId).toBe(ticket.externalId)

      const fullAnswersContent = makeInterviewYaml({
        ticket_id: ticket.externalId,
        status: 'draft',
        generated_by: { winner_model: TEST.councilMembers[0], generated_at: '2026-03-23T09:10:00.000Z' },
      })

      const content = makePrdYaml({ ticketId: ticket.externalId, storyCount: 2 })
      const fullAnswersRawResponse = fullAnswersContent.replace(TEST.councilMembers[0], 'wrong-model')
      const prdRawResponse = `${content}\n# stale source hash from model`
      expectedFullAnswersContent = fullAnswersContent
      expectedFullAnswersRawResponse = fullAnswersRawResponse
      expectedPrdContent = content
      expectedPrdRawResponse = prdRawResponse

      onFullAnswersProgress?.({
        memberId: TEST.councilMembers[0],
        status: 'session_created',
        sessionId: 'session-full-answers-a',
      })
      onFullAnswersProgress?.({
        memberId: TEST.councilMembers[0],
        status: 'finished',
        sessionId: 'session-full-answers-a',
        outcome: 'completed',
        duration: 95,
        content: fullAnswersContent,
        questionCount: 1,
        rawResponse: fullAnswersRawResponse,
        normalizedResponse: fullAnswersContent,
        structuredOutput: {
          repairApplied: true,
          repairWarnings: ['Canonicalized generated_by.winner_model.'],
          autoRetryCount: 0,
        },
      })
      onFullAnswersProgress?.({
        memberId: TEST.councilMembers[1],
        status: 'finished',
        outcome: 'completed',
        duration: 91,
        content: fullAnswersContent.replace(TEST.councilMembers[0], TEST.councilMembers[1]),
        questionCount: 1,
        structuredOutput: {
          repairApplied: false,
          repairWarnings: [],
          autoRetryCount: 0,
        },
      })
      onDraftProgress?.({
        memberId: TEST.councilMembers[0],
        status: 'session_created',
        sessionId: 'session-prd-a',
      })
      onDraftProgress?.({
        memberId: TEST.councilMembers[0],
        status: 'finished',
        sessionId: 'session-prd-a',
        outcome: 'completed',
        duration: 125,
        content,
        rawResponse: prdRawResponse,
        normalizedResponse: content,
        draftMetrics: {
          epicCount: 1,
          userStoryCount: 2,
        },
        structuredOutput: {
          repairApplied: true,
          repairWarnings: ['Canonicalized source_interview.content_sha256 from the approved Interview Results artifact.'],
          autoRetryCount: 1,
          validationError: 'PRD output is not a YAML/JSON object',
          retryDiagnostics: [
            {
              attempt: 1,
              validationError: 'PRD output is not a YAML/JSON object',
              excerpt: 'I am still thinking through the PRD format.',
            },
          ],
        },
      })
      onDraftProgress?.({
        memberId: TEST.councilMembers[1],
        status: 'finished',
        outcome: 'completed',
        duration: 118,
        content,
        draftMetrics: {
          epicCount: 1,
          userStoryCount: 2,
        },
        structuredOutput: {
          repairApplied: false,
          repairWarnings: [],
          autoRetryCount: 0,
        },
      })

      return {
        phase: 'prd_draft',
        fullAnswers: [
          {
            memberId: TEST.councilMembers[0],
            outcome: 'completed',
            content: fullAnswersContent,
            duration: 95,
            questionCount: 1,
            rawResponse: fullAnswersRawResponse,
            normalizedResponse: fullAnswersContent,
            structuredOutput: {
              repairApplied: true,
              repairWarnings: [`Canonicalized generated_by.winner_model from "wrong-model" to "${TEST.councilMembers[0]}".`],
              autoRetryCount: 0,
            },
          },
          {
            memberId: TEST.councilMembers[1],
            outcome: 'completed',
            content: fullAnswersContent.replace(TEST.councilMembers[0], TEST.councilMembers[1]),
            duration: 91,
            questionCount: 1,
            structuredOutput: {
              repairApplied: false,
              repairWarnings: [],
              autoRetryCount: 0,
            },
          },
        ],
        drafts: [
          {
            memberId: TEST.councilMembers[0],
            outcome: 'completed',
            content,
            duration: 125,
            rawResponse: prdRawResponse,
            normalizedResponse: content,
            draftMetrics: {
              epicCount: 1,
              userStoryCount: 2,
            },
            structuredOutput: {
              repairApplied: true,
              repairWarnings: ['Canonicalized source_interview.content_sha256 from the approved Interview Results artifact.'],
              autoRetryCount: 1,
              validationError: 'PRD output is not a YAML/JSON object',
              retryDiagnostics: [
                {
                  attempt: 1,
                  validationError: 'PRD output is not a YAML/JSON object',
                  excerpt: 'I am still thinking through the PRD format.',
                },
              ],
            },
          },
          {
            memberId: TEST.councilMembers[1],
            outcome: 'completed',
            content,
            duration: 118,
            draftMetrics: {
              epicCount: 1,
              userStoryCount: 2,
            },
            structuredOutput: {
              repairApplied: false,
              repairWarnings: [],
              autoRetryCount: 0,
            },
          },
        ],
        memberOutcomes: {
          [TEST.councilMembers[0]]: 'completed',
          [TEST.councilMembers[1]]: 'completed',
        },
        fullAnswerOutcomes: {
          [TEST.councilMembers[0]]: 'completed',
          [TEST.councilMembers[1]]: 'completed',
        },
        deadlineReached: false,
      }
    })

    await handlePrdDraft(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith({ type: 'DRAFTS_READY' })
    const fullAnswersRow = getLatestPhaseArtifact(ticket.id, 'prd_full_answers', 'DRAFTING_PRD')
    const artifactRow = getLatestPhaseArtifact(ticket.id, 'prd_drafts', 'DRAFTING_PRD')
    const fullAnswersCompanionRow = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_full_answers', 'DRAFTING_PRD')
    const artifactCompanionRow = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_drafts', 'DRAFTING_PRD')
    expect(fullAnswersRow).toBeDefined()
    expect(artifactRow).toBeDefined()
    expect(fullAnswersCompanionRow).toBeDefined()
    expect(artifactCompanionRow).toBeDefined()
    const fullAnswersArtifact = JSON.parse(fullAnswersRow!.content) as {
      drafts?: Array<{
        content?: string
      }>
    }
    const fullAnswersCompanion = parseUiArtifactCompanionArtifact(fullAnswersCompanionRow!.content)?.payload as {
      draftDetails?: Array<{
        questionCount?: number
        rawResponse?: string
        normalizedResponse?: string
      }>
    } | undefined
    const artifactCompanion = parseUiArtifactCompanionArtifact(artifactCompanionRow!.content)?.payload as {
      draftDetails?: Array<{
        draftMetrics?: { epicCount?: number; userStoryCount?: number }
        rawResponse?: string
        normalizedResponse?: string
        structuredOutput?: {
          repairApplied?: boolean
          repairWarnings?: string[]
          autoRetryCount?: number
          validationError?: string
          retryDiagnostics?: Array<{
            attempt?: number
            validationError?: string
            excerpt?: string
          }>
          interventions?: Array<{ category?: string; code?: string }>
        }
      }>
    } | undefined

    expect(fullAnswersArtifact.drafts?.[0]?.content).toContain('answered_by: ai_skip')
    expect(fullAnswersCompanion?.draftDetails?.[0]?.questionCount).toBe(1)
    expect(fullAnswersCompanion?.draftDetails?.[0]?.rawResponse).toBe(expectedFullAnswersRawResponse)
    expect(fullAnswersCompanion?.draftDetails?.[0]?.normalizedResponse).toBe(expectedFullAnswersContent)
    expect(artifactCompanion?.draftDetails?.[0]?.draftMetrics).toEqual({
      epicCount: 1,
      userStoryCount: 2,
    })
    expect(artifactCompanion?.draftDetails?.[0]?.rawResponse).toBe(expectedPrdRawResponse)
    expect(artifactCompanion?.draftDetails?.[0]?.normalizedResponse).toBe(expectedPrdContent)
    expect(artifactCompanion?.draftDetails?.[0]?.structuredOutput).toMatchObject({
      repairApplied: true,
      repairWarnings: ['Canonicalized source_interview.content_sha256 from the approved Interview Results artifact.'],
      autoRetryCount: 1,
      validationError: 'PRD output is not a YAML/JSON object',
    })
    expect(artifactCompanion?.draftDetails?.[0]?.structuredOutput?.retryDiagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        validationError: 'PRD output is not a YAML/JSON object',
        excerpt: 'I am still thinking through the PRD format.',
      }),
    ])
    expect(artifactCompanion?.draftDetails?.[0]?.structuredOutput?.interventions).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'cleanup', code: 'cleanup_content_hash' }),
      expect.objectContaining({ category: 'retry' }),
    ]))
    expect(existsSync(paths.executionLogPath)).toBe(true)
    const executionLog = readFileSync(paths.executionLogPath, 'utf-8')
    expect(executionLog).toContain(`PRD draft session created for ${TEST.councilMembers[0]}: session-prd-a.`)
    expect(executionLog).toContain('Full Answers round completed')
    expect(executionLog).toContain('PRD draft round completed')
    expect(executionLog).toContain('PRD draft normalization applied repairs')
    expect(executionLog).toContain('PRD draft required 1 structured retry attempt(s)')
  })

  it('persists the full mock PRD vote artifact shape', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    const sendEvent = vi.fn()

    writeFileSync(`${paths.ticketDir}/interview.yaml`, makeInterviewYaml({ ticket_id: ticket.externalId }), 'utf-8')

    await handleMockPrdDraft(ticket.id, context, sendEvent)
    await handleMockPrdVote(ticket.id, context, sendEvent)

    const voteRow = getLatestPhaseArtifact(ticket.id, 'prd_votes', 'COUNCIL_VOTING_PRD')
    const voteCompanionRow = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_votes', 'COUNCIL_VOTING_PRD')
    expect(voteRow).toBeDefined()
    expect(voteCompanionRow).toBeDefined()

    const voteArtifact = JSON.parse(voteRow!.content) as {
      winnerId?: string
      isFinal?: boolean
    }
    const voteCompanion = parseUiArtifactCompanionArtifact(voteCompanionRow!.content)?.payload as {
      votes?: Array<{ voterId?: string; draftId?: string; scores?: Array<{ category?: string; score?: number }>; totalScore?: number }>
      voterOutcomes?: Record<string, string>
      presentationOrders?: Record<string, { seed: string; order: string[] }>
      totalScore?: number
    } | undefined

    expect(voteArtifact.isFinal).toBe(true)
    expect(voteArtifact.winnerId).toBeTruthy()
    expect(voteCompanion?.votes).toHaveLength(4)
    expect(voteCompanion?.votes?.every((vote) => vote.scores?.length === 5)).toBe(true)
    expect(Object.keys(voteCompanion?.voterOutcomes ?? {})).toEqual(expect.arrayContaining([...TEST.councilMembers]))
    expect(Object.keys(voteCompanion?.presentationOrders ?? {})).toEqual(expect.arrayContaining([...TEST.councilMembers]))
    expect(voteCompanion?.totalScore).toBeGreaterThan(0)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'DRAFTS_READY' })
    expect(sendEvent).toHaveBeenCalledWith({ type: 'WINNER_SELECTED', winner: voteArtifact.winnerId })
  })

  it('persists live and final PRD vote artifacts with winner metadata and presentation order', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    const sendEvent = vi.fn()
    const draftA = buildMockVoteDraft(TEST.councilMembers[0], 'Alpha')
    const draftB = buildMockVoteDraft(TEST.councilMembers[1], 'Beta')

    phaseIntermediate.set(`${ticket.id}:prd`, {
      drafts: [draftA, draftB],
      memberOutcomes: {
        [draftA.memberId]: draftA.outcome,
        [draftB.memberId]: draftB.outcome,
      },
      worktreePath: paths.worktreePath,
      phase: 'prd_draft',
      ticketState: {
        ticketId: context.externalId,
        title: context.title,
        description: context.title,
        relevantFiles: 'files:\n  - path: src/main.ts',
        interview: makeInterviewYaml({ ticket_id: ticket.externalId }),
      },
    })

    conductVotingMock.mockImplementationOnce(async (
      _adapter: unknown,
      _members: Array<{ modelId: string }>,
      drafts: Array<{ memberId: string; content: string }>,
      contextParts: Array<{ content?: string }>,
      _projectPath: string,
      _phase: string,
      _timeoutMs: number,
      _signal: AbortSignal,
      _onOpenCodeSessionLog: unknown,
      _onOpenCodeStreamEvent: unknown,
      _onOpenCodePromptDispatched: unknown,
      onVoteProgress?: (entry: { memberId: string; outcome: string; votes: Vote[]; rawResponse?: string; normalizedResponse?: string }) => void,
      buildPromptForVoter?: (entry: {
        voter: { modelId: string }
        anonymizedDrafts: Array<{ draftId: string; content: string }>
        rubric: Array<{ category: string; weight: number; description?: string }>
      }) => Array<{ content: string }>,
    ) => {
      expect(contextParts).toEqual([])
      expect(buildPromptForVoter).toBeTypeOf('function')

      const prompt = buildPromptForVoter!({
        voter: { modelId: TEST.councilMembers[0] },
        anonymizedDrafts: drafts.map((draft, index) => ({
          draftId: draft.memberId,
          content: `Draft ${index + 1}:\n${draft.content}`,
        })),
        rubric: [
          { category: 'Coverage of requirements', weight: 20, description: 'PRD fully addresses all Interview Results' },
          { category: 'Correctness / feasibility', weight: 20, description: 'Requirements are technically sound' },
          { category: 'Testability', weight: 20, description: 'Each requirement is specific and verifiable' },
          { category: 'Minimal complexity / good decomposition', weight: 20, description: 'Epics and user stories are well-structured' },
          { category: 'Risks / edge cases addressed', weight: 20, description: 'Error states and failure modes are documented' },
        ],
      })

      const rendered = prompt.map((part) => part.content).join('\n')
      expect(prompt).toHaveLength(1)
      expect(rendered).toContain('You are an impartial judge on an AI Council.')
      expect(rendered).toContain('## Context')
      expect(rendered).toContain('### draft')
      expect(rendered).toContain('Draft 1:')
      expect(rendered).toContain('Draft 2:')
      // Rubric must appear inside ## Context as ### vote_rubric (not as a disconnected trailing part)
      expect(rendered).toContain('### vote_rubric')
      const contextIdx = rendered.indexOf('## Context')
      const rubricIdx = rendered.indexOf('### vote_rubric')
      expect(rubricIdx).toBeGreaterThan(contextIdx)
      expect(rendered).toContain('Use the exact PROM11 `draft_scores` YAML schema')
      expect(rendered).toContain('PRD fully addresses all Interview Results')

      const firstVote: Vote = {
        voterId: TEST.councilMembers[0],
        draftId: TEST.councilMembers[0],
        scores: buildVoteScores([19, 18, 19, 18, 18]),
        totalScore: 92,
      }
      const secondVote: Vote = {
        voterId: TEST.councilMembers[1],
        draftId: TEST.councilMembers[1],
        scores: buildVoteScores([18, 18, 18, 18, 18]),
        totalScore: 90,
      }
      const firstRawResponse = 'draft_scores:\n  Draft 1:\n    total_score: 92'
      const firstNormalizedResponse = 'draft_scores:\n  Draft 1:\n    total_score: 92\n'
      const secondRawResponse = 'draft_scores:\n  Draft 1:\n    total_score: 90'

      onVoteProgress?.({
        memberId: TEST.councilMembers[0],
        outcome: 'completed',
        votes: [firstVote],
        rawResponse: firstRawResponse,
        normalizedResponse: firstNormalizedResponse,
      })
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
          { voterId: TEST.councilMembers[0], rawResponse: firstRawResponse, normalizedResponse: firstNormalizedResponse },
          { voterId: TEST.councilMembers[1], rawResponse: secondRawResponse },
        ],
      }
    })
    selectWinnerMock.mockReturnValueOnce({ winnerId: TEST.councilMembers[0], totalScore: 92 })

    await handlePrdVote(ticket.id, context, sendEvent, new AbortController().signal)

    const voteRow = getLatestPhaseArtifact(ticket.id, 'prd_votes', 'COUNCIL_VOTING_PRD')
    const voteCompanionRow = getLatestPhaseArtifact(ticket.id, 'ui_artifact_companion:prd_votes', 'COUNCIL_VOTING_PRD')
    expect(voteRow).toBeDefined()
    expect(voteCompanionRow).toBeDefined()
    const voteArtifact = JSON.parse(voteRow!.content) as {
      winnerId?: string
      totalScore?: number
      isFinal?: boolean
    }
    const voteCompanion = parseUiArtifactCompanionArtifact(voteCompanionRow!.content)?.payload as {
      votes?: Vote[]
      voterOutcomes?: Record<string, string>
      presentationOrders?: Record<string, { seed: string; order: string[] }>
      voterDetails?: Array<{ voterId?: string; rawResponse?: string; normalizedResponse?: string }>
      winnerId?: string
      totalScore?: number
    } | undefined

    expect(voteArtifact.isFinal).toBe(true)
    expect(voteArtifact.winnerId).toBe(TEST.councilMembers[0])
    expect(voteCompanion?.votes).toHaveLength(2)
    expect(voteCompanion?.voterOutcomes).toEqual({
      [TEST.councilMembers[0]]: 'completed',
      [TEST.councilMembers[1]]: 'completed',
    })
    expect(voteCompanion?.presentationOrders?.[TEST.councilMembers[0]]).toEqual({
      seed: 'seed-alpha',
      order: [TEST.councilMembers[0], TEST.councilMembers[1]],
    })
    expect(voteCompanion?.voterDetails?.[0]?.rawResponse).toBe('draft_scores:\n  Draft 1:\n    total_score: 92')
    expect(voteCompanion?.voterDetails?.[0]?.normalizedResponse).toBe('draft_scores:\n  Draft 1:\n    total_score: 92\n')
    expect(voteCompanion?.voterDetails?.[1]?.rawResponse).toBe('draft_scores:\n  Draft 1:\n    total_score: 90')
    expect(voteCompanion?.winnerId).toBe(TEST.councilMembers[0])
    expect(voteCompanion?.totalScore).toBe(92)
    expect(sendEvent).toHaveBeenCalledWith({ type: 'WINNER_SELECTED', winner: TEST.councilMembers[0] })
  })
})

function buildMockVoteDraft(memberId: string, title: string) {
  return {
    memberId,
    outcome: 'completed' as const,
    duration: 1,
    content: makePrdYaml({ problemStatement: title }),
  }
}

function buildVoteScores(scores: number[]): Vote['scores'] {
  return [
    'Coverage of requirements',
    'Correctness / feasibility',
    'Testability',
    'Minimal complexity / good decomposition',
    'Risks / edge cases addressed',
  ].map((category, index) => ({
    category,
    score: scores[index] ?? 0,
    justification: `Scored ${category}`,
  }))
}
