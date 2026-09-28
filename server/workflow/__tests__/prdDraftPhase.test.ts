import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { parseUiArtifactCompanionArtifact } from '@shared/artifactCompanions'
import type { DraftResult, Vote } from '../../council/types'
import type { conductVoting as ConductVoting } from '../../council/voter'
import type { draftPRD as DraftPrd } from '../../phases/prd/draft'
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

import {
  handleMockPrdDraft,
  handleMockPrdRefine,
  handleMockPrdVote,
  handlePrdDraft,
  handlePrdVote,
} from '../phases/prdPhase'
import { upsertCouncilDraftArtifact } from '../phases/helpers'

const repoManager = createTestRepoManager('prd-draft-')

describe('handlePrdDraft', () => {
  it.each(['missing', 'invalid', 'escaping'] as const)('keeps optional %s interview handling safe when rebuilding vote context', async (kind) => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    phaseIntermediate.set(`${ticket.id}:prd`, {
      drafts: [], memberOutcomes: {}, worktreePath: paths.worktreePath, phase: 'prd_draft',
    })
    if (kind === 'invalid') writeFileSync(`${paths.ticketDir}/interview.yaml`, 'invalid interview')
    if (kind === 'escaping') symlinkSync(repoManager.createRepo(), `${paths.ticketDir}/interview.yaml`, 'junction')
    const controller = new AbortController()
    controller.abort()
    // Stop before model work. Optional input reaches cancellation; an unsafe
    // input must be rejected while building context, never silently discarded.
    await expect(handlePrdVote(ticket.id, context, vi.fn(), controller.signal)).rejects.toThrow(
      kind === 'escaping' ? 'escapes root' : /cancel/i,
    )
    expect(conductVotingMock).not.toHaveBeenCalled()
  })
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

  it('rejects an invalid canonical interview before dispatching PRD drafts', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    writeFileSync(`${paths.ticketDir}/interview.yaml`, 'not a canonical interview document', 'utf-8')

    await expect(handlePrdDraft(ticket.id, context, vi.fn(), new AbortController().signal))
      .rejects
      .toThrow('Canonical interview artifact is invalid for PRD drafting')

    expect(draftPRDMock).not.toHaveBeenCalled()
  })

  it('forwards draft callbacks and preserves failure details for finished members', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    const sendEvent = vi.fn()
    const interviewContent = makeInterviewYaml({ ticket_id: ticket.externalId })
    const prdContent = makePrdYaml({ ticketId: ticket.externalId })
    writeFileSync(`${paths.ticketDir}/interview.yaml`, interviewContent, 'utf-8')

    draftPRDMock.mockImplementationOnce(async (
      _adapter: unknown,
      _members: unknown,
      _ticketState: unknown,
      _projectPath: unknown,
      _options: unknown,
      _signal: unknown,
      onOpenCodeSessionLog?: Parameters<typeof DraftPrd>[6],
      onOpenCodeStreamEvent?: Parameters<typeof DraftPrd>[7],
      onOpenCodePromptDispatched?: Parameters<typeof DraftPrd>[8],
      onDraftProgress?: Parameters<typeof DraftPrd>[9],
      onFullAnswersProgress?: Parameters<typeof DraftPrd>[10],
      onStepEvent?: Parameters<typeof DraftPrd>[11],
    ) => {
      const memberId = TEST.councilMembers[0]
      onOpenCodeSessionLog?.({
        stage: 'draft', memberId, sessionId: 'prd-session', response: 'draft response', messages: [],
      })
      onOpenCodeStreamEvent?.({
        stage: 'draft',
        memberId,
        sessionId: 'prd-session',
        event: { type: 'text', sessionId: 'prd-session', text: 'draft token', streaming: false, complete: true },
      })
      onOpenCodePromptDispatched?.({
        stage: 'draft',
        memberId,
        event: {
          session: { id: 'prd-session' },
          parts: [{ type: 'text', content: 'draft prompt' }],
          promptText: 'draft prompt',
          promptNumber: 1,
          timeoutKind: 'ai_response',
        },
      })

      onDraftProgress?.({ memberId, status: 'session_created', sessionId: 'prd-session' })
      onDraftProgress?.({ memberId: 'unknown-member', status: 'finished', outcome: 'completed' })
      onDraftProgress?.({
        memberId,
        status: 'finished',
        outcome: 'completed',
        content: prdContent,
        duration: 25,
        draftMetrics: { epicCount: 1, userStoryCount: 1 },
        rawResponse: 'raw draft',
        normalizedResponse: prdContent,
        rawAttempts: [{ attempt: 1, stage: 'prd_draft', outcome: 'accepted', rawResponse: 'raw draft' }],
        skippedReason: 'not skipped',
        structuredOutput: {
          repairApplied: true,
          repairWarnings: ['Canonicalized a harmless draft alias.'],
          autoRetryCount: 1,
          validationError: 'The first response used an alias.',
        },
      })
      onFullAnswersProgress?.({ memberId: TEST.councilMembers[1], status: 'session_created', sessionId: 'answers-session' })
      onFullAnswersProgress?.({ memberId: 'unknown-member', status: 'finished', outcome: 'completed' })
      onFullAnswersProgress?.({
        memberId,
        status: 'finished',
        outcome: 'completed',
        content: interviewContent,
        duration: 22,
        questionCount: 1,
        rawResponse: 'raw full answers',
        normalizedResponse: interviewContent,
        structuredOutput: {
          repairApplied: false,
          repairWarnings: [],
          autoRetryCount: 1,
          validationError: 'The first answer omitted a canonical question.',
        },
      })

      onStepEvent?.({ memberId, step: 'full_answers', status: 'started' })
      onStepEvent?.({ memberId, step: 'full_answers', status: 'skipped' })
      onStepEvent?.({ memberId, step: 'prd_draft', status: 'skipped', error: 'Full Answers failed validation' })
      onStepEvent?.({ memberId, step: 'prd_draft', status: 'completed' })
      onStepEvent?.({ memberId, step: 'full_answers', status: 'failed', outcome: 'timed_out', error: 'deadline reached' })
      onStepEvent?.({ memberId, step: 'prd_draft', status: 'failed', outcome: 'failed' })

      return {
        phase: 'prd_draft',
        fullAnswers: [
          { memberId, outcome: 'completed', content: interviewContent, duration: 22, questionCount: 1 },
          { memberId: TEST.councilMembers[1], outcome: 'timed_out', content: '', duration: 30, error: 'deadline reached' },
        ],
        drafts: TEST.councilMembers.map((member) => ({
          memberId: member,
          outcome: 'completed',
          content: prdContent,
          duration: 25,
        })),
        memberOutcomes: Object.fromEntries(TEST.councilMembers.map((member) => [member, 'completed'])),
        fullAnswerOutcomes: {
          [memberId]: 'completed',
          [TEST.councilMembers[1]]: 'timed_out',
        },
        deadlineReached: true,
      }
    })

    await handlePrdDraft(ticket.id, context, sendEvent, new AbortController().signal)

    expect(sendEvent).toHaveBeenCalledWith({ type: 'DRAFTS_READY' })
    expect(phaseIntermediate.get(`${ticket.id}:prd`)).toMatchObject({
      fullAnswers: expect.arrayContaining([expect.objectContaining({ memberId: TEST.councilMembers[0], outcome: 'completed' })]),
      drafts: expect.arrayContaining([expect.objectContaining({ memberId: TEST.councilMembers[0], content: prdContent })]),
    })
    expect(readFileSync(paths.executionLogPath, 'utf-8')).toContain('Full Answers timed out')
    expect(readFileSync(paths.executionLogPath, 'utf-8')).toContain('PRD draft completed.')
    expect(readFileSync(paths.executionLogPath, 'utf-8')).toContain('Full Answers skipped; reusing the approved interview artifact.')
  })

  it('blocks PRD drafting when completed drafts do not meet the configured quorum', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    writeFileSync(`${paths.ticketDir}/interview.yaml`, makeInterviewYaml({ ticket_id: ticket.externalId }), 'utf-8')
    draftPRDMock.mockResolvedValueOnce({
      phase: 'prd_draft',
      fullAnswers: [],
      drafts: TEST.councilMembers.map((member) => ({
        memberId: member,
        outcome: 'invalid_output',
        content: '',
        duration: 0,
        error: 'invalid draft',
      })),
      memberOutcomes: Object.fromEntries(TEST.councilMembers.map((member) => [member, 'invalid_output'])),
      fullAnswerOutcomes: {},
      deadlineReached: false,
    })

    await expect(handlePrdDraft(ticket.id, context, vi.fn(), new AbortController().signal))
      .rejects
      .toThrow(/Council quorum not met for prd_draft/)

    expect(getLatestPhaseArtifact(ticket.id, 'prd_drafts', 'DRAFTING_PRD')).toBeDefined()
    expect(phaseIntermediate.get(`${ticket.id}:prd`)).toBeUndefined()
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

  it('rejects PRD voting when the phase has no draft state', async () => {
    const { ticket, context } = await createInitializedTestTicket(repoManager)

    await expect(handlePrdVote(ticket.id, context, vi.fn(), new AbortController().signal))
      .rejects
      .toThrow('No PRD drafts found — cannot vote')

    expect(conductVotingMock).not.toHaveBeenCalled()
  })

  it('marks a failed PRD vote artifact final when voter quorum is not met', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    const drafts = TEST.councilMembers.map((member) => buildMockVoteDraft(member, member))
    phaseIntermediate.set(`${ticket.id}:prd`, {
      drafts,
      memberOutcomes: Object.fromEntries(TEST.councilMembers.map((member) => [member, 'completed'])),
      worktreePath: paths.worktreePath,
      phase: 'prd_draft',
    })
    conductVotingMock.mockResolvedValueOnce({
      votes: [],
      memberOutcomes: Object.fromEntries(TEST.councilMembers.map((member) => [member, 'failed'])),
      deadlineReached: true,
      presentationOrders: {},
      voterDetails: TEST.councilMembers.map((voterId) => ({ voterId, error: 'model unavailable' })),
    })

    await expect(handlePrdVote(ticket.id, context, vi.fn(), new AbortController().signal))
      .rejects
      .toThrow(/PRD voting quorum not met/)

    const voteRow = getLatestPhaseArtifact(ticket.id, 'prd_votes', 'COUNCIL_VOTING_PRD')
    expect(JSON.parse(voteRow!.content)).toMatchObject({ isFinal: true })
  })

  it('rejects an empty vote list even when the voter outcome quorum passed', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    phaseIntermediate.set(`${ticket.id}:prd`, {
      drafts: TEST.councilMembers.map((member) => buildMockVoteDraft(member, member)),
      memberOutcomes: Object.fromEntries(TEST.councilMembers.map((member) => [member, 'completed'])),
      worktreePath: paths.worktreePath,
      phase: 'prd_draft',
    })
    conductVotingMock.mockResolvedValueOnce({
      votes: [],
      memberOutcomes: Object.fromEntries(TEST.councilMembers.map((member) => [member, 'completed'])),
      deadlineReached: false,
      presentationOrders: {},
      voterDetails: [],
    })

    await expect(handlePrdVote(ticket.id, context, vi.fn(), new AbortController().signal))
      .rejects
      .toThrow('PRD voting failed: no valid vote responses received')
    expect(selectWinnerMock).not.toHaveBeenCalled()
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
    await handleMockPrdRefine(ticket.id, context, sendEvent)

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
    expect(sendEvent).toHaveBeenCalledWith({ type: 'REFINED' })
    expect(getLatestPhaseArtifact(ticket.id, 'prd_refined', 'REFINING_PRD')).toBeDefined()
    expect(readFileSync(`${paths.ticketDir}/prd.yaml`, 'utf-8')).toContain('artifact: prd')
  })

  it('persists live and final PRD vote artifacts with winner metadata and presentation order', async () => {
    const { ticket, context, paths } = await createInitializedTestTicket(repoManager)
    const sendEvent = vi.fn()
    const draftA = buildMockVoteDraft(TEST.councilMembers[0], 'Alpha')
    const draftB = buildMockVoteDraft(TEST.councilMembers[1], 'Beta')
    writeFileSync(`${paths.ticketDir}/interview.yaml`, makeInterviewYaml({ ticket_id: ticket.externalId }), 'utf-8')

    phaseIntermediate.set(`${ticket.id}:prd`, {
      drafts: [draftA, draftB],
      memberOutcomes: {
        [draftA.memberId]: draftA.outcome,
        [draftB.memberId]: draftB.outcome,
      },
      worktreePath: paths.worktreePath,
      phase: 'prd_draft',
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
      onOpenCodeSessionLog?: Parameters<typeof ConductVoting>[8],
      onOpenCodeStreamEvent?: Parameters<typeof ConductVoting>[9],
      onOpenCodePromptDispatched?: Parameters<typeof ConductVoting>[10],
      onVoteProgress?: (entry: { memberId: string; outcome: string; votes: Vote[]; rawResponse?: string; normalizedResponse?: string }) => void,
      buildPromptForVoter?: (entry: {
        voter: { modelId: string }
        anonymizedDrafts: Array<{ draftId: string; content: string }>
        rubric: Array<{ category: string; weight: number; description?: string }>
      }) => Array<{ content: string }>,
    ) => {
      expect(contextParts).toEqual([])
      expect(buildPromptForVoter).toBeTypeOf('function')

      const voterId = TEST.councilMembers[0]
      onOpenCodeSessionLog?.({
        stage: 'vote', memberId: voterId, sessionId: 'prd-vote-session', response: 'vote response', messages: [],
      })
      onOpenCodeStreamEvent?.({
        stage: 'vote',
        memberId: voterId,
        sessionId: 'prd-vote-session',
        event: { type: 'text', sessionId: 'prd-vote-session', text: 'vote token', streaming: false, complete: true },
      })
      onOpenCodePromptDispatched?.({
        stage: 'vote',
        memberId: voterId,
        event: {
          session: { id: 'prd-vote-session' },
          parts: [{ type: 'text', content: 'vote prompt' }],
          promptText: 'vote prompt',
          promptNumber: 1,
          timeoutKind: 'ai_response',
        },
      })

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
      expect(rendered).toContain('artifact: interview')
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
