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
  },
) {
  const timing = deadlineReached
    ? `reached configured deadline (${timeoutMs}ms)`
    : `completed in ${formatDurationMs(elapsedMs)}`

  return `${label} ${timing}: completed=${summary.completed}, timed_out=${summary.timedOut}, failed=${summary.failed}, invalid_output=${summary.invalidOutput}.`
}

export function summarizeDraftOutcomes(drafts: DraftResult[]) {
  return drafts.reduce(
    (summary, draft) => {
      if (draft.outcome === 'completed') summary.completed++
      else if (draft.outcome === 'timed_out') summary.timedOut++
      else if (draft.outcome === 'failed') summary.failed++
      else summary.invalidOutput++
      return summary
    },
    { completed: 0, timedOut: 0, invalidOutput: 0, failed: 0 },
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
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      'error',
      `${label} draft ${detail} for ${entry.memberId}${sessionText}${durationText}.`,
      {
        entryId: `${entry.sessionId ?? `${phase}:${entry.memberId}`}:draft-finished`,
        audience: 'ai',
        kind: 'error',
        op: 'append',
        source: `model:${entry.memberId}`,
        modelId: entry.memberId,
        sessionId: entry.sessionId,
        streaming: false,
      },
    )
  }
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
) {
  upsertLatestPhaseArtifact(ticketId, artifactType, phase, JSON.stringify({
    ...(winnerId ? { winnerId } : {}),
    ...(isFinal ? { isFinal } : { isFinal: false }),
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

  emitPhaseLog(
    ticketId,
    externalId,
    phase,
    'info',
    deadlineReached
      ? `Council response deadline reached after ${timeoutMs}ms. completed_members=${completedMembers.length > 0 ? completedMembers.join(', ') : 'none'}. timed_out_members=${timedOutMembers.length > 0 ? timedOutMembers.join(', ') : 'none'}.`
      : `Council responses settled before the ${timeoutMs}ms deadline. completed_members=${completedMembers.length > 0 ? completedMembers.join(', ') : 'none'}. timed_out_members=${timedOutMembers.length > 0 ? timedOutMembers.join(', ') : 'none'}.`,
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
