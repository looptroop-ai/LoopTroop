import { buildStructuredMetadata } from './ticketDirContext'
import { emitPhaseLog } from './logEmission'
import { emitAiDetail } from './openCodeStream'
import { formatDurationMs } from './phaseRuntimeSettings'
import type {
  DraftProgressEvent,
  DraftResult,
  DraftStructuredOutputMeta,
  MemberOutcome,
  RawAttempt,
  Vote,
  VotePresentationOrder,
  VoterDetail,
} from '../../council/types'
import { parseCouncilMembers } from '../../council/members'
import { db as appDb } from '../../db/index'
import { profiles } from '../../db/schema'
import type { TicketContext } from '../../machines/types'
import {
  parseLockedCouncilMemberVariants,
  upsertLatestPhaseArtifact,
} from '../../storage/tickets'
import { formatStructuredFailureForLog, type StructuredFailureClass } from '../../lib/structuredOutputRetry'
import {
  attachOpenCodeBlockedErrorDiagnostics,
  buildOutputTruncatedBlockedErrorDiagnostics,
} from '../../opencode/blockedErrorDiagnostics'
import { persistUiArtifactCompanionArtifact } from '../artifactCompanions'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

export function formatDraftRoundSummary(
  label: string,
  elapsedMs: number,
  timeoutMs: number,
  deadlineReached: boolean,
  summary: {
    completed: number
    timedOut: number
    failed: number
    invalidOutput: number
    stopped?: number
  },
) {
  const timing = deadlineReached
    ? `reached configured deadline (${timeoutMs}ms)`
    : `completed in ${formatDurationMs(elapsedMs)}`

  // Only named when it happened, so a round nobody touched logs as it always did.
  const stopped = summary.stopped ? `, stopped=${summary.stopped}` : ''
  return `${label} ${timing}: completed=${summary.completed}, timed_out=${summary.timedOut}, failed=${summary.failed}, invalid_output=${summary.invalidOutput}${stopped}.`
}

export function summarizeDraftOutcomes(drafts: DraftResult[]) {
  return drafts.reduce(
    (summary, draft) => {
      if (draft.outcome === 'completed') summary.completed++
      else if (draft.outcome === 'timed_out') summary.timedOut++
      else if (draft.outcome === 'failed') summary.failed++
      else if (draft.outcome === 'stopped') summary.stopped++
      else summary.invalidOutput++
      return summary
    },
    { completed: 0, timedOut: 0, invalidOutput: 0, failed: 0, stopped: 0 },
  )
}

type StructuredFailureDiagnosticSource = {
  memberId?: string
  voterId?: string
  outcome?: MemberOutcome
  structuredOutput?: DraftStructuredOutputMeta
  rawAttempts?: RawAttempt[]
}

export function buildCouncilQuorumErrorWithDiagnostics(
  message: string,
  sources: StructuredFailureDiagnosticSource[],
): Error {
  const truncatedSource = sources.find((source) =>
    source.outcome !== 'completed'
    && (
      source.structuredOutput?.failureClass === 'output_truncated'
      || source.rawAttempts?.some((attempt) => attempt.failureClass === 'output_truncated')
    ),
  )
  if (!truncatedSource) return new Error(message)
  const modelId = truncatedSource.memberId ?? truncatedSource.voterId

  return attachOpenCodeBlockedErrorDiagnostics(
    new Error(message),
    buildOutputTruncatedBlockedErrorDiagnostics({
      ...(modelId ? { modelId } : {}),
    }),
  )
}

export function formatDraftFailureDetail(
  outcome: DraftResult['outcome'],
  error?: string,
  failureClass?: StructuredFailureClass,
) {
  if (outcome === 'timed_out') return 'timed out'
  if (outcome === 'stopped') return 'stopped by the user'
  if (outcome === 'invalid_output') {
    if (failureClass && error) return `invalid output (${failureClass}: ${error})`
    if (failureClass) return `invalid output (${failureClass})`
    return `invalid output (${error ?? 'malformed response'})`
  }
  if (outcome === 'failed') {
    return formatStructuredFailureForLog(failureClass, error)
  }
  return ''
}

export function emitDraftProgressInfoLog(
  ticketId: string,
  ticketExternalId: string,
  phase: WorkflowPhaseId,
  label: string,
  entry: DraftProgressEvent,
) {
  if (entry.status === 'session_created' && entry.sessionId) {
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      'info',
      `${label} draft session created for ${entry.memberId}: ${entry.sessionId}.`,
      {
        entryId: `${entry.sessionId}:created`,
        audience: 'ai',
        kind: 'session',
        op: 'append',
        source: `model:${entry.memberId}`,
        modelId: entry.memberId,
        sessionId: entry.sessionId,
        streaming: false,
      },
    )
    return
  }

  if (entry.status === 'finished' && entry.outcome && entry.outcome !== 'completed') {
    const detail = formatDraftFailureDetail(
      entry.outcome,
      entry.error,
      entry.structuredOutput?.failureClass,
    )
    const durationText = typeof entry.duration === 'number' ? ` after ${formatDurationMs(entry.duration)}` : ''
    const sessionText = entry.sessionId ? ` session=${entry.sessionId}` : ''
    // A stop is a person's decision, not a fault.
    const stopped = entry.outcome === 'stopped'
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      stopped ? 'info' : 'error',
      `${label} draft ${detail} for ${entry.memberId}${sessionText}${durationText}.`,
      {
        entryId: `${entry.sessionId ?? `${phase}:${entry.memberId}`}:draft-finished`,
        audience: 'ai',
        kind: stopped ? 'session' : 'error',
        op: 'append',
        source: `model:${entry.memberId}`,
        modelId: entry.memberId,
        sessionId: entry.sessionId,
        streaming: false,
      },
    )
  }
}

/**
 * Folds one member's progress into a round's live drafts. Returns whether the
 * live artifact changed.
 *
 * A `restarted` member goes back to a bare pending entry: whatever its earlier
 * attempt reported, content and diagnostics alike, belongs to a run that no
 * longer counts. A `finished` entry is likewise the member's whole result, so
 * diagnostics it does not carry are dropped rather than kept from an earlier
 * one: a model stopped during PRD Part 2 must not leave its Part 1 output
 * readable under Raw.
 */
export function applyDraftProgress(liveDrafts: DraftResult[], entry: DraftProgressEvent): boolean {
  const draftIndex = liveDrafts.findIndex((draft) => draft.memberId === entry.memberId)
  if (draftIndex < 0) return false
  if (entry.status === 'restarted') {
    liveDrafts[draftIndex] = { memberId: entry.memberId, content: '', outcome: 'pending', duration: 0 }
    return true
  }
  if (entry.status !== 'finished' || !entry.outcome) return false
  const previous = liveDrafts[draftIndex]!
  liveDrafts[draftIndex] = {
    memberId: previous.memberId,
    content: entry.content ?? previous.content,
    outcome: entry.outcome,
    duration: entry.duration ?? previous.duration,
    error: entry.error,
    questionCount: entry.questionCount,
    ...(entry.draftMetrics ? { draftMetrics: entry.draftMetrics } : {}),
    structuredOutput: entry.structuredOutput,
    ...(typeof entry.rawResponse === 'string' ? { rawResponse: entry.rawResponse } : {}),
    ...(typeof entry.normalizedResponse === 'string' ? { normalizedResponse: entry.normalizedResponse } : {}),
    ...(entry.rawAttempts ? { rawAttempts: entry.rawAttempts } : {}),
    ...(entry.skippedReason ? { skippedReason: entry.skippedReason } : {}),
  }
  return true
}

/** A voting round's live state, as its artifact shows it while voters finish. */
export interface LiveVoteState {
  votes: Vote[]
  voterOutcomes: Record<string, MemberOutcome>
  voterDetails: Map<string, VoterDetail>
}

/**
 * Folds one voter's progress into a round's live vote state.
 *
 * A voter's scorecard replaces whatever it had before, so a restarted voter,
 * reported back as `pending` with no votes, stops counting toward the leader.
 */
export function applyVoteProgress(
  live: LiveVoteState,
  entry: {
    memberId: string
    outcome: MemberOutcome
    votes: Vote[]
    error?: string
    rawResponse?: string
    normalizedResponse?: string
    structuredOutput?: DraftStructuredOutputMeta
    rawAttempts?: RawAttempt[]
  },
): void {
  live.voterOutcomes[entry.memberId] = entry.outcome
  for (let index = live.votes.length - 1; index >= 0; index -= 1) {
    if (live.votes[index]!.voterId === entry.memberId) live.votes.splice(index, 1)
  }
  live.votes.push(...entry.votes)
  if (entry.outcome === 'pending') {
    live.voterDetails.delete(entry.memberId)
    return
  }
  live.voterDetails.set(entry.memberId, {
    voterId: entry.memberId,
    ...(entry.error ? { error: entry.error } : {}),
    ...(typeof entry.rawResponse === 'string' ? { rawResponse: entry.rawResponse } : {}),
    ...(typeof entry.normalizedResponse === 'string' ? { normalizedResponse: entry.normalizedResponse } : {}),
    ...(entry.structuredOutput ? { structuredOutput: entry.structuredOutput } : {}),
    ...(entry.rawAttempts ? { rawAttempts: entry.rawAttempts } : {}),
  })
}

export function createPendingDrafts(members: Array<{ modelId: string }>): DraftResult[] {
  return members.map(member => ({
    memberId: member.modelId,
    content: '',
    outcome: 'pending',
    duration: 0,
  }))
}

export function upsertCouncilDraftArtifact(
  ticketId: string,
  phase: WorkflowPhaseId,
  artifactType: string,
  drafts: DraftResult[],
  memberOutcomes?: Record<string, MemberOutcome>,
  isFinal: boolean = false,
  /** The quorum this round is judged by; the screen warns before a stop breaks it. */
  minQuorum?: number,
) {
  const resolvedOutcomes = memberOutcomes ?? drafts.reduce<Record<string, MemberOutcome>>(
    (acc, draft) => {
      acc[draft.memberId] = draft.outcome
      return acc
    },
    {},
  )

  const persistedDrafts = drafts.map((draft) => ({
    memberId: draft.memberId,
    outcome: draft.outcome,
    ...(draft.outcome === 'completed' && draft.content
      ? { content: draft.content }
      : {}),
  }))

  upsertLatestPhaseArtifact(ticketId, artifactType, phase, JSON.stringify({
    drafts: persistedDrafts,
    memberOutcomes: resolvedOutcomes,
    isFinal,
    ...(typeof minQuorum === 'number' ? { minQuorum } : {}),
  }))

  persistUiArtifactCompanionArtifact(ticketId, phase, artifactType, {
    draftDetails: drafts.map((draft) => ({
      memberId: draft.memberId,
      ...(typeof draft.duration === 'number' ? { duration: draft.duration } : {}),
      ...(draft.error ? { error: draft.error } : {}),
      ...(typeof draft.questionCount === 'number' ? { questionCount: draft.questionCount } : {}),
      ...(draft.draftMetrics ? { draftMetrics: draft.draftMetrics } : {}),
      ...(draft.structuredOutput ? { structuredOutput: buildStructuredMetadata(draft.structuredOutput) } : {}),
      ...(typeof draft.rawResponse === 'string' ? { rawResponse: draft.rawResponse } : {}),
      ...(typeof draft.normalizedResponse === 'string' ? { normalizedResponse: draft.normalizedResponse } : {}),
      ...(draft.rawAttempts && draft.rawAttempts.length > 0 ? { rawAttempts: draft.rawAttempts } : {}),
      ...(draft.skippedReason ? { skippedReason: draft.skippedReason } : {}),
    })),
  })
}

export function upsertCouncilVoteArtifact(
  ticketId: string,
  phase: WorkflowPhaseId,
  artifactType: string,
  drafts: DraftResult[],
  votes: Vote[],
  memberOutcomes: Record<string, MemberOutcome>,
  voterDetails?: Array<{
    voterId: string
    error?: string
    rawResponse?: string
    normalizedResponse?: string
    structuredOutput?: DraftStructuredOutputMeta
    rawAttempts?: RawAttempt[]
  }>,
  presentationOrders?: Record<string, VotePresentationOrder>,
  winnerId?: string,
  totalScore?: number,
  isFinal: boolean = false,
  /** The quorum this round is judged by; the screen warns before a stop breaks it. */
  minQuorum?: number,
) {
  upsertLatestPhaseArtifact(ticketId, artifactType, phase, JSON.stringify({
    ...(winnerId ? { winnerId } : {}),
    ...(isFinal ? { isFinal } : { isFinal: false }),
    ...(typeof minQuorum === 'number' ? { minQuorum } : {}),
  }))

  persistUiArtifactCompanionArtifact(ticketId, phase, artifactType, {
    votes,
    voterOutcomes: memberOutcomes,
    ...(voterDetails && voterDetails.length > 0
      ? {
          voterDetails: voterDetails.map((detail) => ({
            ...detail,
            ...(typeof detail.rawResponse === 'string' ? { rawResponse: detail.rawResponse } : {}),
            ...(typeof detail.normalizedResponse === 'string' ? { normalizedResponse: detail.normalizedResponse } : {}),
            ...(detail.structuredOutput ? { structuredOutput: buildStructuredMetadata(detail.structuredOutput) } : {}),
          })),
        }
      : {}),
    ...(presentationOrders ? { presentationOrders } : {}),
    ...(winnerId ? { winnerId } : {}),
    ...(typeof totalScore === 'number' ? { totalScore } : {}),
    drafts: drafts.map((draft) => ({
      memberId: draft.memberId,
      outcome: draft.outcome,
      ...(draft.outcome === 'completed' && draft.content
        ? { content: draft.content }
        : {}),
    })),
  })
}

export function collectMembersByOutcome(
  memberOutcomes: Record<string, MemberOutcome>,
  outcome: MemberOutcome,
) {
  return Object.entries(memberOutcomes)
    .filter(([, memberOutcome]) => memberOutcome === outcome)
    .map(([memberId]) => memberId)
}

export function emitCouncilDecisionLogs(
  ticketId: string,
  externalId: string,
  phase: WorkflowPhaseId,
  timeoutMs: number,
  deadlineReached: boolean,
  memberOutcomes: Record<string, MemberOutcome>,
  quorum: { passed: boolean; message: string },
  nextStatus: string,
) {
  const completedMembers = collectMembersByOutcome(memberOutcomes, 'completed')
  const timedOutMembers = collectMembersByOutcome(memberOutcomes, 'timed_out')
  const stoppedMembers = collectMembersByOutcome(memberOutcomes, 'stopped')
  const stoppedText = stoppedMembers.length > 0 ? ` stopped_members=${stoppedMembers.join(', ')}.` : ''

  emitPhaseLog(
    ticketId,
    externalId,
    phase,
    'info',
    deadlineReached
      ? `Council response deadline reached after ${timeoutMs}ms. completed_members=${completedMembers.length > 0 ? completedMembers.join(', ') : 'none'}. timed_out_members=${timedOutMembers.length > 0 ? timedOutMembers.join(', ') : 'none'}.${stoppedText}`
      : `Council responses settled before the ${timeoutMs}ms deadline. completed_members=${completedMembers.length > 0 ? completedMembers.join(', ') : 'none'}. timed_out_members=${timedOutMembers.length > 0 ? timedOutMembers.join(', ') : 'none'}.${stoppedText}`,
  )
  emitPhaseLog(
    ticketId,
    externalId,
    phase,
    quorum.passed ? 'info' : 'error',
    `Council quorum ${quorum.passed ? 'passed' : 'failed'}: ${quorum.message}.`,
  )
  emitPhaseLog(
    ticketId,
    externalId,
    phase,
    'info',
    `Council transition selected: ${nextStatus}.`,
  )
}

export function resolveCouncilMembers(context: TicketContext): {
  members: Array<{ modelId: string; name: string; variant?: string }>
  source: 'locked_ticket' | 'profile'
} {
  let members: Array<{ modelId: string; name: string; variant?: string }> = []
  let source: 'locked_ticket' | 'profile' = 'profile'

  // Both branches read the same stored column through the same tolerant parser.
  // `buildTicketContextFromTicket` assigns the raw `text` column to this typed
  // field without parsing it, so the string branch is live — and a bare
  // `JSON.parse` on it threw out of council loading on a value nobody had
  // validated. Fixing the profile branch below and not this one left the hazard
  // in place next to a comment describing it.
  const variantMap: Record<string, string> = typeof context.lockedCouncilMemberVariants === 'string'
    ? parseLockedCouncilMemberVariants(context.lockedCouncilMemberVariants) ?? {}
    : (context.lockedCouncilMemberVariants as Record<string, string> | undefined) ?? {}

  if (context.lockedCouncilMembers && context.lockedCouncilMembers.length > 0) {
    members = context.lockedCouncilMembers
      .map(id => ({ modelId: id, name: id.split('/').pop() ?? id, variant: variantMap[id] }))
    source = 'locked_ticket'
  } else {
    const profile = appDb.select().from(profiles).get()
    const configuredMembers = parseCouncilMembers(profile?.councilMembers)
    const profileVariants: Record<string, string> = typeof profile?.councilMemberVariants === 'string'
      ? parseLockedCouncilMemberVariants(profile.councilMemberVariants) ?? {}
      : (profile?.councilMemberVariants as Record<string, string> | undefined) ?? {}
    if (configuredMembers.length > 0) {
      members = configuredMembers
        .map(id => ({ modelId: id, name: id.split('/').pop() ?? id, variant: profileVariants[id] }))
      source = 'profile'
    }
  }

  if (members.length === 0) {
    throw new Error('No valid council members are configured for this ticket')
  }
  return { members, source }
}
