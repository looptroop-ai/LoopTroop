import type { TicketContext, TicketEvent } from '../../machines/types'
import type { DraftResult, MemberOutcome, Vote, VotePresentationOrder } from '../../council/types'
import { CancelledError, VOTING_RUBRIC_PRD } from '../../council/types'
import { conductVoting, selectWinner } from '../../council/voter'
import { getRawAttemptsFromRefinementError, refineDraft } from '../../council/refiner'
import { requireWinnerDraft } from '../../council/draftUtils'
import { checkMemberResponseQuorum, checkQuorum } from '../../council/quorum'
import { draftPRD, buildPrdContextBuilder, buildPrdRefinePrompt } from '../../phases/prd/draft'
import {
  buildPrdRefinedArtifact,
  buildPrdRefinementRetryPrompt,
  type ValidatedPrdRefinement,
  validatePrdRefinementOutput,
} from '../../phases/prd/refined'
import { buildMinimalContext, type TicketState } from '../../opencode/contextBuilder'
import { getTicketPaths, insertPhaseArtifact } from '../../storage/tickets'
import { safeAtomicWrite } from '../../io/atomicWrite'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import * as jsYaml from 'js-yaml'
import { normalizeInterviewDocumentOutput, normalizePrdYamlOutput, getPrdDraftMetrics } from '../../structuredOutput'
import { buildPromptFromTemplate, PROM11, PROM12 } from '../../prompts/index'
import {
  buildPrdUiRefinementDiffArtifact,
  buildPrdUiRefinementDiffArtifactFromChanges,
} from '@shared/refinementDiffArtifacts'
import { clearContextCache } from '../../opencode/contextBuilder'
import { getErrorMessage } from '@shared/typeGuards'

import { adapter, phaseIntermediate } from './state'
import {
  emitPhaseLog,
  emitAiDetail,
  emitOpenCodeSessionLogs,
  emitOpenCodeStreamEvent,
  emitOpenCodePromptLog,
  emitDraftProgressInfoLog,
  createOpenCodeStreamState,
  resolveCouncilRuntimeSettings,
  resolveStructuredRetryRuntimeSettings,
  resolveCouncilMembers,
  loadTicketDirContext,
  formatCouncilResolutionLog,
  formatDraftRoundSummary,
  formatDraftFailureDetail,
  summarizeDraftOutcomes,
  createPendingDrafts,
  upsertCouncilDraftArtifact,
  upsertCouncilVoteArtifact,
  emitCouncilDecisionLogs,
  buildCouncilQuorumErrorWithDiagnostics,
  buildStructuredMetadata,
  mapCouncilStageToStatus,
} from './helpers'
import type { OpenCodeStreamState } from './types'
import { persistUiRefinementDiffArtifact } from '../refinementDiffArtifacts'
import { persistUiArtifactCompanionArtifact } from '../artifactCompanions'
import { withStructuredRetryDiagnosticAttempt } from '@shared/structuredRetryDiagnostics'
import { getStructuredRetryDiagnosticFromError } from '../../lib/structuredRetryDiagnostics'

function requireCanonicalInterviewForPrdDraft(ticketDir: string, ticketExternalId: string): string {
  const interviewPath = resolve(ticketDir, 'interview.yaml')
  if (!existsSync(interviewPath)) {
    throw new Error(`Canonical interview artifact is required before PRD drafting: ${interviewPath}`)
  }

  const interview = readFileSync(interviewPath, 'utf-8')
  const validation = normalizeInterviewDocumentOutput(interview, { ticketId: ticketExternalId })
  if (!validation.ok) {
    throw new Error(`Canonical interview artifact is invalid for PRD drafting: ${validation.error}`)
  }

  return interview
}

function findWinnerFullAnswers(fullAnswers: DraftResult[], winnerId: string): DraftResult | undefined {
  return fullAnswers.find((draft) => draft.memberId === winnerId && draft.outcome === 'completed' && draft.content)
}

export function buildPrdVotePrompt(
  ticketState: TicketState,
  anonymizedDrafts: Array<{ draftId: string; content: string }>,
  rubric: Array<{ category: string; weight: number; description: string }> = VOTING_RUBRIC_PRD,
): Array<{ type: 'text'; content: string }> {
  const voteContext = [
    ...buildMinimalContext('prd_vote', {
      ...ticketState,
      drafts: anonymizedDrafts.map((draft) => draft.content),
    }),
    {
      type: 'text' as const,
      source: 'vote_rubric',
      content: [
        'Detailed scoring rubric:',
        ...rubric.map((item) => `- ${item.category} (${item.weight}pts): ${item.description}`),
        '',
        'Use the exact PROM11 `draft_scores` YAML schema. Keep the exact draft labels, include only rubric integer fields plus `total_score`, and do not add prose or extra keys.',
      ].join('\n'),
    },
  ]
  return [{ type: 'text', content: buildPromptFromTemplate(PROM11, voteContext) }]
}

function buildMockPrdDocument(context: TicketContext, variantIndex: number) {
  const variantLabel = variantIndex === 0 ? '' : ` alternative ${variantIndex + 1}`
  const extraScope = variantIndex === 0
    ? []
    : [`Add${variantLabel} council vote telemetry for traceability.`]
  const extraRisk = variantIndex === 0
    ? []
    : [`Alternative ${variantIndex + 1} should still keep mock artifacts deterministic.`]

  return {
    schema_version: 1,
    ticket_id: context.externalId,
    artifact: 'prd',
    status: 'draft',
    source_interview: {
      content_sha256: 'mock-interview-sha256',
    },
    product: {
      problem_statement: variantIndex === 0
        ? `Mock PRD for ${context.title}`
        : `Mock PRD alternative ${variantIndex + 1} for ${context.title}`,
      target_users: ['LoopTroop maintainers'],
    },
    scope: {
      in_scope: [
        'Keep all LoopTroop runtime state inside the project-local .looptroop directory.',
        'Preserve ticket lifecycle metadata and artifacts for restart and inspection.',
        ...extraScope,
      ],
      out_of_scope: [
        'Changes outside the mock workflow path.',
      ],
    },
    technical_requirements: {
      architecture_constraints: [
        'Do not write ticket data into the app checkout.',
        'Keep the workflow deterministic in mock mode for testing.',
      ],
      data_model: [],
      api_contracts: [],
      security_constraints: [],
      performance_constraints: [],
      reliability_constraints: [],
      error_handling_rules: [],
      tooling_assumptions: [],
    },
    epics: [
      {
        id: 'EPIC-1',
        title: 'Persist mock planning artifacts',
        objective: 'Produce a canonical mock PRD artifact that downstream phases can consume.',
        implementation_steps: [
          'Write the refined mock PRD to disk.',
          'Keep the artifact shape aligned with the real PRD schema.',
        ],
        user_stories: [
          {
            id: 'US-1-1',
            title: 'Maintain deterministic mock planning data',
            acceptance_criteria: [
              'The mock PRD matches the canonical PRD schema.',
              'Downstream phases can read the PRD without special-case parsing.',
            ],
            implementation_steps: [
              'Emit canonical YAML fields.',
              'Keep mock-only assumptions explicit inside the artifact.',
            ],
            verification: {
              required_commands: ['npm test'],
            },
          },
          ...(variantIndex === 0
            ? []
            : [
              {
                id: `US-1-${variantIndex + 2}`,
                title: `Differentiate mock alternative ${variantIndex + 1}`,
                acceptance_criteria: [
                  'Each council member sees a distinct but still valid mock PRD draft.',
                ],
                implementation_steps: [
                  'Vary the mock content slightly per council member.',
                ],
                verification: {
                  required_commands: ['npm test'],
                },
              },
            ]),
        ],
      },
    ],
    risks: [
      ...extraRisk,
    ],
    approval: {
      approved_by: '',
      approved_at: '',
    },
  }
}

function buildMockPrdVariantContent(context: TicketContext, variantIndex = 0) {
  return jsYaml.dump(buildMockPrdDocument(context, variantIndex), { lineWidth: 120, noRefs: true }) as string
}

function buildMockPrdDrafts(members: Array<{ modelId: string; name: string }>, context: TicketContext): DraftResult[] {
  return members.map((member, index) => ({
    memberId: member.modelId,
    content: buildMockPrdVariantContent(context, index),
    outcome: 'completed',
    duration: 1,
    draftMetrics: {
      epicCount: 1,
      userStoryCount: index === 0 ? 1 : 2,
    },
  }))
}

function buildMockPrdVoteResult(
  members: Array<{ modelId: string; name: string }>,
  drafts: DraftResult[],
): {
  votes: Vote[]
  voterOutcomes: Record<string, MemberOutcome>
  presentationOrders: Record<string, VotePresentationOrder>
  winnerId: string
  totalScore: number
} {
  const winnerId = drafts[0]?.memberId ?? members[0]?.modelId ?? 'mock-model-1'
  const winnerScorecards = [
    [19, 19, 18, 18, 19],
    [18, 19, 19, 18, 18],
  ]
  const challengerScorecards = [
    [16, 15, 15, 16, 15],
    [15, 16, 15, 15, 16],
  ]

  const votes: Vote[] = []
  const voterOutcomes = members.reduce<Record<string, MemberOutcome>>((acc, member) => {
    acc[member.modelId] = 'completed'
    return acc
  }, {})
  const presentationOrders: Record<string, VotePresentationOrder> = {}

  members.forEach((member, memberIndex) => {
    const orderedDrafts = memberIndex % 2 === 0 ? drafts : [...drafts].reverse()
    presentationOrders[member.modelId] = {
      seed: `mock-seed-prd-${memberIndex + 1}`,
      order: orderedDrafts.map((draft) => draft.memberId),
    }

    orderedDrafts.forEach((draft) => {
      const scoreTemplate = draft.memberId === winnerId
        ? winnerScorecards[memberIndex % winnerScorecards.length]!
        : challengerScorecards[memberIndex % challengerScorecards.length]!
      const scores = VOTING_RUBRIC_PRD.map((criterion, scoreIndex) => ({
        category: criterion.category,
        score: scoreTemplate[scoreIndex] ?? 15,
        justification: draft.memberId === winnerId
          ? `Mock voter ${memberIndex + 1} preferred this PRD on ${criterion.category.toLowerCase()}.`
          : `Mock voter ${memberIndex + 1} found this PRD weaker on ${criterion.category.toLowerCase()}.`,
      }))
      const totalScore = scores.reduce((sum, score) => sum + score.score, 0)
      votes.push({
        voterId: member.modelId,
        draftId: draft.memberId,
        scores,
        totalScore,
      })
    })
  })

  const totalScore = votes
    .filter((vote) => vote.draftId === winnerId)
    .reduce((sum, vote) => sum + vote.totalScore, 0)

  return { votes, voterOutcomes, presentationOrders, winnerId, totalScore }
}

export async function handlePrdDraft(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  const { worktreePath, ticket, ticketDir, relevantFiles } = loadTicketDirContext(context)
  const phase = 'DRAFTING_PRD' as const
  const council = resolveCouncilMembers(context)
  const members = council.members

  const interview = requireCanonicalInterviewForPrdDraft(ticketDir, context.externalId)

  const ticketState: TicketState = {
    ticketId: context.externalId,
    title: context.title,
    description: ticket?.description ?? '',
    relevantFiles,
    interview,
  }
  const ticketContext = buildMinimalContext('prd_draft', ticketState)

  emitPhaseLog(ticketId, context.externalId, phase, 'info',
    formatCouncilResolutionLog(context, council))
  emitPhaseLog(ticketId, context.externalId, phase, 'info',
    `Loaded canonical interview artifact (${interview.length} chars).`)
  emitPhaseLog(ticketId, context.externalId, phase, 'info',
    `PRD council drafting started. Context: ${ticketContext.length} parts, interview=loaded.`)
  const councilSettings = resolveCouncilRuntimeSettings(context)
  emitPhaseLog(ticketId, context.externalId, phase, 'info',
    `PRD draft settings: ai_response_timeout=${councilSettings.draftTimeoutMs}ms, min_council_quorum=${councilSettings.minQuorum}.`)
  emitPhaseLog(ticketId, context.externalId, phase, 'info', `Dispatching PRD draft requests to ${members.length} council members.`)

  if (signal.aborted) throw new CancelledError(ticketId)
  const startedAt = Date.now()
  const streamStates = new Map<string, OpenCodeStreamState>()
  const liveFullAnswers = createPendingDrafts(members)
  const liveDrafts = createPendingDrafts(members)
  upsertCouncilDraftArtifact(ticketId, phase, 'prd_full_answers', liveFullAnswers)
  upsertCouncilDraftArtifact(ticketId, phase, 'prd_drafts', liveDrafts)
  const result = await draftPRD(
    adapter,
    members,
    ticketState,
    worktreePath,
    {
      ...councilSettings,
      maxStructuredRetries: resolveStructuredRetryRuntimeSettings(context).structuredRetryCount,
      ticketId,
      ticketExternalId: context.externalId,
    },
    signal,
    (entry) => {
      const targetStatus = mapCouncilStageToStatus('prd', entry.stage)
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeSessionLogs(
        ticketId,
        context.externalId,
        targetStatus,
        entry.memberId,
        entry.sessionId,
        entry.stage,
        entry.response,
        entry.messages,
        streamState,
      )
    },
    (entry) => {
      const targetStatus = mapCouncilStageToStatus('prd', entry.stage)
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeStreamEvent(
        ticketId,
        context.externalId,
        targetStatus,
        entry.memberId,
        entry.sessionId,
        entry.event,
        streamState,
      )
    },
    (entry) => {
      const targetStatus = mapCouncilStageToStatus('prd', entry.stage)
      emitOpenCodePromptLog(
        ticketId,
        context.externalId,
        targetStatus,
        entry.memberId,
        entry.event,
      )
    },
    (entry) => {
      emitDraftProgressInfoLog(ticketId, context.externalId, phase, 'PRD', entry)
      if (entry.status !== 'finished' || !entry.outcome) return
      const draftIndex = liveDrafts.findIndex(draft => draft.memberId === entry.memberId)
      if (draftIndex < 0) return
      liveDrafts[draftIndex] = {
        ...liveDrafts[draftIndex]!,
        content: entry.content ?? liveDrafts[draftIndex]!.content,
        outcome: entry.outcome,
        duration: entry.duration ?? liveDrafts[draftIndex]!.duration,
        error: entry.error,
        questionCount: entry.questionCount,
        draftMetrics: entry.draftMetrics,
        structuredOutput: entry.structuredOutput,
        ...(typeof entry.rawResponse === 'string' ? { rawResponse: entry.rawResponse } : {}),
        ...(typeof entry.normalizedResponse === 'string' ? { normalizedResponse: entry.normalizedResponse } : {}),
        ...(entry.rawAttempts ? { rawAttempts: entry.rawAttempts } : {}),
        ...(entry.skippedReason ? { skippedReason: entry.skippedReason } : {}),
      }
      if (entry.structuredOutput?.repairWarnings.length) {
        emitPhaseLog(
          ticketId,
          context.externalId,
          phase,
          'info',
          `${entry.memberId} PRD draft normalization applied repairs: ${entry.structuredOutput.repairWarnings.join(' ')}`,
          { source: 'system', modelId: entry.memberId },
        )
      }
      if (entry.structuredOutput?.validationError && entry.structuredOutput.autoRetryCount > 0) {
        emitPhaseLog(
          ticketId,
          context.externalId,
          phase,
          'info',
          `${entry.memberId} PRD draft required ${entry.structuredOutput.autoRetryCount} structured retry attempt(s): ${entry.structuredOutput.validationError}`,
          { source: 'system', modelId: entry.memberId },
        )
      }
      upsertCouncilDraftArtifact(ticketId, phase, 'prd_drafts', liveDrafts)
    },
    (entry) => {
      const fullAnswersIndex = liveFullAnswers.findIndex((draft) => draft.memberId === entry.memberId)
      if (fullAnswersIndex < 0 || !entry.outcome) return
      liveFullAnswers[fullAnswersIndex] = {
        ...liveFullAnswers[fullAnswersIndex]!,
        content: entry.content ?? liveFullAnswers[fullAnswersIndex]!.content,
        outcome: entry.outcome,
        duration: entry.duration ?? liveFullAnswers[fullAnswersIndex]!.duration,
        error: entry.error,
        questionCount: entry.questionCount,
        structuredOutput: entry.structuredOutput,
        ...(typeof entry.rawResponse === 'string' ? { rawResponse: entry.rawResponse } : {}),
        ...(typeof entry.normalizedResponse === 'string' ? { normalizedResponse: entry.normalizedResponse } : {}),
        ...(entry.rawAttempts ? { rawAttempts: entry.rawAttempts } : {}),
        ...(entry.skippedReason ? { skippedReason: entry.skippedReason } : {}),
      }
      if (entry.structuredOutput?.repairWarnings.length) {
        emitPhaseLog(
          ticketId,
          context.externalId,
          phase,
          'info',
          `${entry.memberId} Full Answers normalization applied repairs: ${entry.structuredOutput.repairWarnings.join(' ')}`,
          { source: 'system', modelId: entry.memberId },
        )
      }
      if (entry.structuredOutput?.validationError && entry.structuredOutput.autoRetryCount > 0) {
        emitPhaseLog(
          ticketId,
          context.externalId,
          phase,
          'info',
          `${entry.memberId} Full Answers required ${entry.structuredOutput.autoRetryCount} structured retry attempt(s): ${entry.structuredOutput.validationError}`,
          { source: 'system', modelId: entry.memberId },
        )
      }
      upsertCouncilDraftArtifact(ticketId, phase, 'prd_full_answers', liveFullAnswers)
    },
    (entry) => {
      const stepLabel = entry.step === 'full_answers' ? 'Full Answers' : 'PRD draft'
      if (entry.status === 'started') {
        emitPhaseLog(ticketId, context.externalId, phase, 'info', `${entry.memberId} ${stepLabel} started.`, { source: 'system', modelId: entry.memberId })
        return
      }
      if (entry.status === 'skipped') {
        const skippedMessage = entry.step === 'full_answers'
          ? `${entry.memberId} ${stepLabel} skipped; reusing the approved interview artifact.`
          : `${entry.memberId} ${stepLabel} skipped: ${entry.error ?? 'Full Answers did not pass validation.'}`
        emitPhaseLog(ticketId, context.externalId, phase, 'info', skippedMessage, { source: 'system', modelId: entry.memberId })
        return
      }
      if (entry.status === 'completed') {
        emitPhaseLog(ticketId, context.externalId, phase, 'info', `${entry.memberId} ${stepLabel} completed.`, { source: 'system', modelId: entry.memberId })
        return
      }
      emitPhaseLog(
        ticketId,
        context.externalId,
        phase,
        entry.outcome === 'failed' ? 'error' : 'info',
        `${entry.memberId} ${stepLabel} ${entry.outcome === 'timed_out' ? 'timed out' : 'failed'}${entry.error ? `: ${entry.error}` : '.'}`,
        { source: 'system', modelId: entry.memberId },
      )
    },
  )

  const fullAnswersSummary = summarizeDraftOutcomes(result.fullAnswers)
  emitPhaseLog(
    ticketId,
    context.externalId,
    phase,
    'info',
    formatDraftRoundSummary(
      'Full Answers round',
      Date.now() - startedAt,
      councilSettings.draftTimeoutMs,
      Boolean(result.deadlineReached),
      fullAnswersSummary,
    ),
  )

  const draftSummary = summarizeDraftOutcomes(result.drafts)
  emitPhaseLog(
    ticketId,
    context.externalId,
    phase,
    'info',
    formatDraftRoundSummary(
      'PRD draft round',
      Date.now() - startedAt,
      councilSettings.draftTimeoutMs,
      Boolean(result.deadlineReached),
      draftSummary,
    ),
  )
  const quorum = checkQuorum(result.drafts, councilSettings.minQuorum)
  const nextStatus = quorum.passed ? 'COUNCIL_VOTING_PRD' : 'BLOCKED_ERROR'
  emitCouncilDecisionLogs(
    ticketId,
    context.externalId,
    phase,
    councilSettings.draftTimeoutMs,
    Boolean(result.deadlineReached),
    result.memberOutcomes,
    quorum,
    nextStatus,
  )

  for (const fullAnswers of result.fullAnswers) {
    if (fullAnswers.outcome === 'completed') continue
    const detail = fullAnswers.outcome === 'timed_out'
      ? formatDraftFailureDetail(fullAnswers.outcome, fullAnswers.error, fullAnswers.structuredOutput?.failureClass)
      : fullAnswers.outcome === 'invalid_output' || fullAnswers.outcome === 'failed'
        ? formatDraftFailureDetail(fullAnswers.outcome, fullAnswers.error, fullAnswers.structuredOutput?.failureClass)
        : 'failed'
    emitAiDetail(ticketId, context.externalId, 'DRAFTING_PRD', 'model_output',
      `${fullAnswers.memberId} ${detail}.`,
      {
        entryId: `prd-full-answers-summary:${fullAnswers.memberId}`,
        audience: 'ai',
        kind: 'error',
        op: 'append',
        source: `model:${fullAnswers.memberId}`,
        modelId: fullAnswers.memberId,
        streaming: false,
        outcome: fullAnswers.outcome,
        duration: fullAnswers.duration,
      })
  }

  upsertCouncilDraftArtifact(ticketId, phase, 'prd_full_answers', result.fullAnswers, result.fullAnswerOutcomes, true)
  upsertCouncilDraftArtifact(ticketId, phase, 'prd_drafts', result.drafts, result.memberOutcomes, true)
  emitPhaseLog(
    ticketId,
    context.externalId,
    phase,
    'info',
    `Saved PRD drafting artifacts with ${Object.keys(result.memberOutcomes).length} PRD outcomes and ${Object.keys(result.fullAnswerOutcomes).length} Full Answers outcomes.`,
  )

  if (!quorum.passed) {
    throw buildCouncilQuorumErrorWithDiagnostics(
      `Council quorum not met for prd_draft: ${quorum.message}`,
      result.drafts,
    )
  }

  const nextTicketState: TicketState = {
    ...ticketState,
    fullAnswers: result.fullAnswers
      .filter((draft) => draft.outcome === 'completed' && draft.content)
      .map((draft) => draft.content),
  }

  phaseIntermediate.set(`${ticketId}:prd`, {
    drafts: result.drafts,
    fullAnswers: result.fullAnswers,
    memberOutcomes: result.memberOutcomes,
    contextBuilder: buildPrdContextBuilder(nextTicketState),
    worktreePath,
    phase: result.phase,
    ticketState: nextTicketState,
  })

  sendEvent({ type: 'DRAFTS_READY' })
}

export async function handlePrdVote(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  const intermediate = phaseIntermediate.get(`${ticketId}:prd`)
  if (!intermediate) {
    throw new Error('No PRD drafts found — cannot vote')
  }

  const { members } = resolveCouncilMembers(context)
  const councilSettings = resolveCouncilRuntimeSettings(context)
  const ticketDirContext = loadTicketDirContext(context)
  const voteTicketState = intermediate.ticketState ?? (() => {
    const { ticket, relevantFiles, ticketDir } = ticketDirContext
    let interview: string | undefined
    try {
      interview = requireCanonicalInterviewForPrdDraft(ticketDir, context.externalId)
    } catch {
      interview = undefined
    }
    return {
      ticketId: context.externalId,
      title: context.title,
      description: ticket?.description ?? '',
      relevantFiles,
      interview,
    } satisfies TicketState
  })()
  const streamStates = new Map<string, OpenCodeStreamState>()
  const liveVotes: Vote[] = []
  const liveVoterOutcomes = members.reduce<Record<string, MemberOutcome>>((acc, member) => {
    acc[member.modelId] = 'pending'
    return acc
  }, {})
  const liveVoterDetails = new Map<string, { voterId: string; error?: string; rawResponse?: string; normalizedResponse?: string; structuredOutput?: NonNullable<typeof intermediate.drafts[number]['structuredOutput']>; rawAttempts?: NonNullable<typeof intermediate.drafts[number]['rawAttempts']> }>()

  emitPhaseLog(ticketId, context.externalId, 'COUNCIL_VOTING_PRD', 'info',
    `PRD voting started with ${members.length} council members on ${intermediate.drafts.filter(d => d.outcome === 'completed').length} drafts.`)
  upsertCouncilVoteArtifact(ticketId, 'COUNCIL_VOTING_PRD', 'prd_votes', intermediate.drafts, [], liveVoterOutcomes, [...liveVoterDetails.values()])

  if (signal.aborted) throw new CancelledError(ticketId)
  const voteRun = await conductVoting(
    adapter,
    members,
    intermediate.drafts,
    [],
    intermediate.worktreePath,
    intermediate.phase,
    councilSettings.draftTimeoutMs,
    signal,
    (entry) => {
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeSessionLogs(
        ticketId,
        context.externalId,
        'COUNCIL_VOTING_PRD',
        entry.memberId,
        entry.sessionId,
        entry.stage,
        entry.response,
        entry.messages,
        streamState,
      )
    },
    (entry) => {
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeStreamEvent(
        ticketId,
        context.externalId,
        'COUNCIL_VOTING_PRD',
        entry.memberId,
        entry.sessionId,
        entry.event,
        streamState,
      )
    },
    (entry) => {
      emitOpenCodePromptLog(
        ticketId,
        context.externalId,
        'COUNCIL_VOTING_PRD',
        entry.memberId,
        entry.event,
      )
    },
    (entry) => {
      liveVoterOutcomes[entry.memberId] = entry.outcome
      if (entry.votes.length > 0) liveVotes.push(...entry.votes)
      liveVoterDetails.set(entry.memberId, {
        voterId: entry.memberId,
        ...(entry.error ? { error: entry.error } : {}),
        ...(typeof entry.rawResponse === 'string' ? { rawResponse: entry.rawResponse } : {}),
        ...(typeof entry.normalizedResponse === 'string' ? { normalizedResponse: entry.normalizedResponse } : {}),
        ...(entry.structuredOutput ? { structuredOutput: entry.structuredOutput } : {}),
        ...(entry.rawAttempts ? { rawAttempts: entry.rawAttempts } : {}),
      })
      upsertCouncilVoteArtifact(ticketId, 'COUNCIL_VOTING_PRD', 'prd_votes', intermediate.drafts, liveVotes, liveVoterOutcomes, [...liveVoterDetails.values()])
    },
    ({ anonymizedDrafts, rubric }) => buildPrdVotePrompt(voteTicketState, anonymizedDrafts, rubric),
    {
      ticketId,
      phase: 'COUNCIL_VOTING_PRD',
    },
    PROM11.toolPolicy,
    resolveStructuredRetryRuntimeSettings(context).structuredRetryCount,
  )

  const voteQuorum = checkMemberResponseQuorum(voteRun.memberOutcomes, councilSettings.minQuorum)
  const nextVoteStatus = voteQuorum.passed ? 'REFINING_PRD' : 'BLOCKED_ERROR'
  emitCouncilDecisionLogs(
    ticketId,
    context.externalId,
    'COUNCIL_VOTING_PRD',
    councilSettings.draftTimeoutMs,
    voteRun.deadlineReached,
    voteRun.memberOutcomes,
    voteQuorum,
    nextVoteStatus,
  )

  if (!voteQuorum.passed) {
    upsertCouncilVoteArtifact(
      ticketId,
      'COUNCIL_VOTING_PRD',
      'prd_votes',
      intermediate.drafts,
      voteRun.votes,
      voteRun.memberOutcomes,
      voteRun.voterDetails,
      voteRun.presentationOrders,
      undefined,
      undefined,
      true,
    )
    throw buildCouncilQuorumErrorWithDiagnostics(
      `PRD voting quorum not met: ${voteQuorum.message}`,
      voteRun.voterDetails,
    )
  }

  if (voteRun.votes.length === 0) {
    throw new Error('PRD voting failed: no valid vote responses received')
  }

  const { winnerId, totalScore } = selectWinner(voteRun.votes, members)

  intermediate.votes = voteRun.votes
  intermediate.winnerId = winnerId

  upsertCouncilVoteArtifact(
    ticketId,
    'COUNCIL_VOTING_PRD',
    'prd_votes',
    intermediate.drafts,
    voteRun.votes,
    voteRun.memberOutcomes,
    voteRun.voterDetails,
    voteRun.presentationOrders,
    winnerId,
    totalScore,
    true,
  )
  emitPhaseLog(ticketId, context.externalId, 'COUNCIL_VOTING_PRD', 'info',
    `PRD voting selected winner: ${winnerId} (score: ${totalScore}).`)
  sendEvent({ type: 'WINNER_SELECTED', winner: winnerId })
}

export async function handlePrdRefine(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  const intermediate = phaseIntermediate.get(`${ticketId}:prd`)
  if (!intermediate || !intermediate.winnerId) {
    throw new Error('No PRD vote results found — cannot refine')
  }

  const winnerDraft = requireWinnerDraft(intermediate.drafts, intermediate.winnerId, 'PRD')
  const losingDrafts = intermediate.drafts.filter(d => d.memberId !== intermediate.winnerId && d.outcome === 'completed')
  const councilSettings = resolveCouncilRuntimeSettings(context)
  const streamStates = new Map<string, OpenCodeStreamState>()
  const paths = getTicketPaths(ticketId)
  if (!paths) {
    throw new Error(`Ticket workspace not initialized: missing ticket paths for ${context.externalId}`)
  }
  const ticketDir = paths.ticketDir
  const winnerFullAnswers = findWinnerFullAnswers(intermediate.fullAnswers ?? [], intermediate.winnerId)
  if (!winnerFullAnswers?.content) {
    throw new Error(`No Full Answers artifact found for PRD winner ${intermediate.winnerId}`)
  }

  // Build ticket state for labeled prompt construction
  const refineTicketState = intermediate.ticketState ?? (() => {
    const { ticket, relevantFiles } = loadTicketDirContext(context)
    return {
      ticketId: context.externalId,
      title: context.title,
      description: ticket?.description ?? '',
      relevantFiles,
    } satisfies TicketState
  })()

  emitPhaseLog(ticketId, context.externalId, 'REFINING_PRD', 'info',
    `PRD refinement started. Winner: ${intermediate.winnerId}, incorporating ideas from ${losingDrafts.length} alternative drafts.`,
    { source: 'system', modelId: intermediate.winnerId })

  if (signal.aborted) throw new CancelledError(ticketId)
  let structuredMeta = buildStructuredMetadata({ autoRetryCount: 0, repairApplied: false, repairWarnings: [] })
  let validatedRefinement: ValidatedPrdRefinement | null = null
  let refinementRun: Awaited<ReturnType<typeof refineDraft>>
  try {
    refinementRun = await refineDraft(
    adapter,
    winnerDraft,
    losingDrafts,
    [], // contextParts unused when buildPrompt is provided
    intermediate.worktreePath,
    councilSettings.draftTimeoutMs,
    signal,
    (entry) => {
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeSessionLogs(
        ticketId,
        context.externalId,
        'REFINING_PRD',
        entry.memberId,
        entry.sessionId,
        entry.stage,
        entry.response,
        entry.messages,
        streamState,
      )
    },
    (entry) => {
      const streamState = streamStates.get(entry.sessionId) ?? createOpenCodeStreamState()
      streamStates.set(entry.sessionId, streamState)
      emitOpenCodeStreamEvent(
        ticketId,
        context.externalId,
        'REFINING_PRD',
        entry.memberId,
        entry.sessionId,
        entry.event,
        streamState,
      )
    },
    (entry) => {
      emitOpenCodePromptLog(
        ticketId,
        context.externalId,
        'REFINING_PRD',
        entry.memberId,
        entry.event,
      )
    },
    {
      ticketId,
      phase: 'REFINING_PRD',
    },
    (activeWinnerDraft, activeLosingDrafts) => buildPrdRefinePrompt(
      refineTicketState,
      activeWinnerDraft,
      activeLosingDrafts,
      intermediate.fullAnswers ?? [],
    ),
    (content) => {
      const losingDraftMeta = losingDrafts.map((d) => ({ memberId: d.memberId }))
      try {
        const result = validatePrdRefinementOutput(content, {
          ticketId: context.externalId,
          interviewContent: winnerFullAnswers.content,
          winnerDraftContent: winnerDraft.content,
          losingDraftMeta,
        })
        validatedRefinement = result
        structuredMeta = buildStructuredMetadata(structuredMeta, {
          repairApplied: result.repairApplied,
          repairWarnings: result.repairWarnings,
          autoRetryCount: structuredMeta.autoRetryCount,
        })
        return { normalizedContent: result.refinedContent }
      } catch (error) {
        const validationError = getErrorMessage(error)
        const retryDiagnostic = withStructuredRetryDiagnosticAttempt(
          getStructuredRetryDiagnosticFromError(error),
          (structuredMeta.autoRetryCount ?? 0) + 1,
        )
        structuredMeta = buildStructuredMetadata(structuredMeta, {
          autoRetryCount: (structuredMeta.autoRetryCount ?? 0) + 1,
          validationError,
          ...(retryDiagnostic ? { retryDiagnostics: [retryDiagnostic] } : {}),
        })
        throw error
      }
    },
    PROM12.outputFormat,
    ({ baseParts, validationError, rawResponse }) => buildPrdRefinementRetryPrompt(baseParts, {
      validationError,
      rawResponse,
    }),
    PROM12.toolPolicy,
    resolveStructuredRetryRuntimeSettings(context).structuredRetryCount,
    )
  } catch (error) {
    const rawAttempts = getRawAttemptsFromRefinementError(error)
    if (rawAttempts.length > 0) {
      insertPhaseArtifact(ticketId, {
        phase: 'REFINING_PRD',
        artifactType: 'prd_refined',
        content: JSON.stringify({
          status: 'failed',
          error: getErrorMessage(error),
          structuredOutput: structuredMeta,
          rawAttempts,
        }),
      })
      persistUiArtifactCompanionArtifact(ticketId, 'REFINING_PRD', 'prd_refined', {
        status: 'failed',
        error: getErrorMessage(error),
        structuredOutput: structuredMeta,
        rawAttempts,
      })
    }
    throw error
  }
  const refinedContent = refinementRun.content

  // Clean up intermediate data
  phaseIntermediate.delete(`${ticketId}:prd`)
  const prdPath = resolve(ticketDir, 'prd.yaml')
  if (!validatedRefinement) {
    throw new Error('PRD refinement completed without a validated artifact')
  }
  const currentValidatedRefinement = validatedRefinement as ValidatedPrdRefinement
  const refinedArtifact = buildPrdRefinedArtifact(
    intermediate.winnerId,
    currentValidatedRefinement.winnerDraftContent,
    currentValidatedRefinement,
    structuredMeta,
  )
  const uiDiffArtifact = currentValidatedRefinement.changes.length > 0
    ? buildPrdUiRefinementDiffArtifactFromChanges({
        winnerId: intermediate.winnerId,
        changes: currentValidatedRefinement.changes,
        winnerDraftContent: currentValidatedRefinement.winnerDraftContent,
        refinedContent: currentValidatedRefinement.refinedContent,
        losingDrafts: losingDrafts.map((draft) => ({ memberId: draft.memberId, content: draft.content })),
      })
    : buildPrdUiRefinementDiffArtifact({
        winnerId: intermediate.winnerId,
        winnerDraftContent: currentValidatedRefinement.winnerDraftContent,
        refinedContent: currentValidatedRefinement.refinedContent,
        losingDrafts: losingDrafts.map((draft) => ({ memberId: draft.memberId, content: draft.content })),
      })

  if (currentValidatedRefinement.repairWarnings.length > 0) {
    emitPhaseLog(
      ticketId,
      context.externalId,
      'REFINING_PRD',
      'info',
      `PRD refinement normalization applied repairs: ${currentValidatedRefinement.repairWarnings.join(' | ')}`,
    )
  }
  if ((structuredMeta.autoRetryCount ?? 0) > 0 && structuredMeta.validationError) {
    emitPhaseLog(
      ticketId,
      context.externalId,
      'REFINING_PRD',
      'info',
      `PRD refinement required ${structuredMeta.autoRetryCount} structured retry attempt(s): ${structuredMeta.validationError}`,
    )
  }

  insertPhaseArtifact(ticketId, {
    phase: 'REFINING_PRD',
    artifactType: 'prd_refined',
    content: JSON.stringify({
      refinedContent: refinedArtifact.refinedContent,
      ...(refinementRun.rawAttempts.length > 0 ? { rawAttempts: refinementRun.rawAttempts } : {}),
    }),
  })
  persistUiArtifactCompanionArtifact(ticketId, 'REFINING_PRD', 'prd_refined', {
    winnerDraftContent: refinedArtifact.winnerDraftContent,
    draftMetrics: refinedArtifact.draftMetrics,
    structuredOutput: refinedArtifact.structuredOutput ?? null,
    ...(refinementRun.rawAttempts.length > 0 ? { rawAttempts: refinementRun.rawAttempts } : {}),
  })

  // Persist winnerId separately for restart resilience (matches interview_winner pattern)
  insertPhaseArtifact(ticketId, {
    phase: 'REFINING_PRD',
    artifactType: 'prd_winner',
    content: JSON.stringify({ winnerId: intermediate.winnerId }),
  })
  persistUiRefinementDiffArtifact(ticketId, 'REFINING_PRD', ticketDir, uiDiffArtifact)

  // Save refined PRD to disk
  safeAtomicWrite(prdPath, refinedContent)
  clearContextCache(context.externalId)

  emitPhaseLog(
    ticketId,
    context.externalId,
    'REFINING_PRD',
    'info',
    `Validated refined PRD from winner ${intermediate.winnerId} (${refinedArtifact.draftMetrics.epicCount} epics, ${refinedArtifact.draftMetrics.userStoryCount} user stories).`,
    { source: 'system', modelId: intermediate.winnerId },
  )
  emitPhaseLog(ticketId, context.externalId, 'REFINING_PRD', 'info',
    `PRD Candidate v1 from winner ${intermediate.winnerId}. Saved to ${prdPath}.`,
    { source: 'system', modelId: intermediate.winnerId })

  sendEvent({ type: 'REFINED' })
}

export function buildMockPrdContent(context: TicketContext) {
  return buildMockPrdVariantContent(context, 0)
}

export async function handleMockPrdDraft(ticketId: string, context: TicketContext, sendEvent: (event: TicketEvent) => void) {
  const paths = getTicketPaths(ticketId)
  if (!paths) throw new Error(`Ticket workspace not initialized: missing ticket paths for ${context.externalId}`)
  const { members } = resolveCouncilMembers(context)
  const interviewPath = resolve(paths.ticketDir, 'interview.yaml')
  const fullAnswersContent = existsSync(interviewPath) ? readFileSync(interviewPath, 'utf-8') : ''
  const fullAnswers = members.map((member) => ({
    memberId: member.modelId,
    outcome: 'completed' as const,
    content: fullAnswersContent,
    duration: 1,
    questionCount: 1,
  }))
  const drafts = buildMockPrdDrafts(members, context)
  insertPhaseArtifact(ticketId, {
    phase: 'DRAFTING_PRD',
    artifactType: 'prd_full_answers',
    content: JSON.stringify({
      drafts: fullAnswers.map((draft) => ({
        memberId: draft.memberId,
        outcome: draft.outcome,
        ...(draft.content ? { content: draft.content } : {}),
      })),
      memberOutcomes: fullAnswers.reduce<Record<string, MemberOutcome>>((acc, draft) => {
        acc[draft.memberId] = draft.outcome
        return acc
      }, {}),
      isFinal: true,
    }),
  })
  persistUiArtifactCompanionArtifact(ticketId, 'DRAFTING_PRD', 'prd_full_answers', {
    draftDetails: fullAnswers.map((draft) => ({
      memberId: draft.memberId,
      ...(typeof draft.duration === 'number' ? { duration: draft.duration } : {}),
      ...(typeof draft.questionCount === 'number' ? { questionCount: draft.questionCount } : {}),
    })),
  })
  insertPhaseArtifact(ticketId, {
    phase: 'DRAFTING_PRD',
    artifactType: 'prd_drafts',
    content: JSON.stringify({
      drafts: drafts.map((draft) => ({
        memberId: draft.memberId,
        outcome: draft.outcome,
        ...(draft.content ? { content: draft.content } : {}),
      })),
      memberOutcomes: drafts.reduce<Record<string, MemberOutcome>>((acc, draft) => {
        acc[draft.memberId] = draft.outcome
        return acc
      }, {}),
      isFinal: true,
    }),
  })
  persistUiArtifactCompanionArtifact(ticketId, 'DRAFTING_PRD', 'prd_drafts', {
    draftDetails: drafts.map((draft) => ({
      memberId: draft.memberId,
      ...(typeof draft.duration === 'number' ? { duration: draft.duration } : {}),
      ...(typeof draft.questionCount === 'number' ? { questionCount: draft.questionCount } : {}),
      ...(draft.draftMetrics ? { draftMetrics: draft.draftMetrics } : {}),
    })),
  })
  emitPhaseLog(ticketId, context.externalId, 'DRAFTING_PRD', 'info', 'Mock PRD drafts ready.')
  sendEvent({ type: 'DRAFTS_READY' })
}

export async function handleMockPrdVote(ticketId: string, context: TicketContext, sendEvent: (event: TicketEvent) => void) {
  const { members } = resolveCouncilMembers(context)
  const drafts = buildMockPrdDrafts(members, context)
  const voteResult = buildMockPrdVoteResult(members, drafts)
  insertPhaseArtifact(ticketId, {
    phase: 'COUNCIL_VOTING_PRD',
    artifactType: 'prd_votes',
    content: JSON.stringify({
      winnerId: voteResult.winnerId,
      isFinal: true,
    }),
  })
  persistUiArtifactCompanionArtifact(ticketId, 'COUNCIL_VOTING_PRD', 'prd_votes', {
    votes: voteResult.votes,
    voterOutcomes: voteResult.voterOutcomes,
    presentationOrders: voteResult.presentationOrders,
    totalScore: voteResult.totalScore,
  })
  emitPhaseLog(ticketId, context.externalId, 'COUNCIL_VOTING_PRD', 'info', 'Mock PRD winner selected.')
  sendEvent({ type: 'WINNER_SELECTED', winner: voteResult.winnerId })
}

export async function handleMockPrdRefine(ticketId: string, context: TicketContext, sendEvent: (event: TicketEvent) => void) {
  const paths = getTicketPaths(ticketId)
  if (!paths) throw new Error(`Ticket workspace not initialized: missing ticket paths for ${context.externalId}`)
  const { members } = resolveCouncilMembers(context)
  const winnerId = members[0]?.modelId ?? 'mock-model-1'
  const interviewPath = resolve(paths.ticketDir, 'interview.yaml')
  const interviewContent = existsSync(interviewPath) ? readFileSync(interviewPath, 'utf-8') : ''
  const normalizedPrd = normalizePrdYamlOutput(buildMockPrdContent(context), {
    ticketId: context.externalId,
    interviewContent,
  })
  if (!normalizedPrd.ok) {
    throw new Error(`Mock PRD refinement produced invalid PRD: ${normalizedPrd.error}`)
  }
  const refinedArtifact = {
    winnerId,
    refinedContent: normalizedPrd.normalizedContent,
    winnerDraftContent: normalizedPrd.normalizedContent,
    draftMetrics: getPrdDraftMetrics(normalizedPrd.value),
    structuredOutput: buildStructuredMetadata({
      repairApplied: normalizedPrd.repairApplied,
      repairWarnings: normalizedPrd.repairWarnings,
      autoRetryCount: 0,
    }),
  }
  const uiDiffArtifact = buildPrdUiRefinementDiffArtifact({
    winnerId,
    winnerDraftContent: normalizedPrd.normalizedContent,
    refinedContent: normalizedPrd.normalizedContent,
  })
  insertPhaseArtifact(ticketId, {
    phase: 'REFINING_PRD',
    artifactType: 'prd_refined',
    content: JSON.stringify({
      refinedContent: refinedArtifact.refinedContent,
    }),
  })
  persistUiArtifactCompanionArtifact(ticketId, 'REFINING_PRD', 'prd_refined', {
    winnerDraftContent: refinedArtifact.winnerDraftContent,
    draftMetrics: refinedArtifact.draftMetrics,
    structuredOutput: refinedArtifact.structuredOutput ?? null,
  })
  persistUiRefinementDiffArtifact(ticketId, 'REFINING_PRD', paths.ticketDir, uiDiffArtifact)
  safeAtomicWrite(resolve(paths.ticketDir, 'prd.yaml'), normalizedPrd.normalizedContent)
  clearContextCache(context.externalId)
  emitPhaseLog(ticketId, context.externalId, 'REFINING_PRD', 'info', 'Mock PRD written to disk.')
  sendEvent({ type: 'REFINED' })
}
