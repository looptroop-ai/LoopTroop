import { loadTicketDirContext } from './ticketDirContext'
import { type TicketState } from '../../opencode/contextBuilder'
import type {
  DraftResult,
  MemberOutcome,
} from '../../council/types'
import type { TicketContext } from '../../machines/types'
import {
  getLatestPhaseArtifact,
  getActivePhaseAttempt,
  readTicketFile,
} from '../../storage/tickets'
import { buildPrdContextBuilder } from '../../phases/prd/draft'
import { buildBeadsContextBuilder } from '../../phases/beads/draft'
import type { PhaseIntermediateData } from './types'
import { phaseIntermediate } from './state'
import { getErrorMessage } from '@shared/typeGuards'

function getRecoveredDraftPhase(pipeline: 'interview' | 'prd' | 'beads'): string {
  if (pipeline === 'interview') return 'interview_draft'
  if (pipeline === 'prd') return 'prd_draft'
  return 'beads_draft'
}

function getPipelineDraftStatus(pipeline: 'interview' | 'prd' | 'beads'): string {
  if (pipeline === 'interview') return 'COUNCIL_DELIBERATING'
  if (pipeline === 'prd') return 'DRAFTING_PRD'
  return 'DRAFTING_BEADS'
}

function getPipelineVoteStatus(pipeline: 'interview' | 'prd' | 'beads'): string {
  if (pipeline === 'interview') return 'COUNCIL_VOTING_INTERVIEW'
  if (pipeline === 'prd') return 'COUNCIL_VOTING_PRD'
  return 'COUNCIL_VOTING_BEADS'
}

function recoverPersistedDrafts(
  drafts: unknown,
  memberOutcomes?: Record<string, MemberOutcome>,
): DraftResult[] {
  if (!Array.isArray(drafts)) return []

  return drafts.flatMap((draft) => {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return []
    const record = draft as Record<string, unknown>
    const memberId = typeof record.memberId === 'string' ? record.memberId : ''
    if (!memberId) return []

    const outcome = (
      record.outcome === 'completed'
      || record.outcome === 'pending'
      || record.outcome === 'timed_out'
      || record.outcome === 'invalid_output'
      || record.outcome === 'failed'
    )
      ? record.outcome
      : memberOutcomes?.[memberId] ?? 'pending'

    return [{
      memberId,
      outcome,
      content: typeof record.content === 'string' ? record.content : '',
      duration: 0,
    }]
  })
}

/**
 * Attempt to recover phaseIntermediate data from persisted artifacts after a
 * server restart. Returns true if the data was recovered (or already present).
 */
export function tryRecoverPhaseIntermediate(
  ticketId: string,
  context: TicketContext,
  pipeline: 'interview' | 'prd' | 'beads',
  needsVotes: boolean,
): boolean {
  const key = `${ticketId}:${pipeline}`
  if (phaseIntermediate.has(key)) return true

  try {
    const draftStatus = getPipelineDraftStatus(pipeline)
    const draftAttempt = getActivePhaseAttempt(ticketId, draftStatus)
    const artifact = getLatestPhaseArtifact(ticketId, `${pipeline}_drafts`, draftStatus, draftAttempt ?? undefined)
    if (!artifact) return false

    const result = JSON.parse(artifact.content) as {
      drafts?: unknown
      memberOutcomes?: Record<string, MemberOutcome>
      isFinal?: boolean
    }
    const recoveredDrafts = recoverPersistedDrafts(result.drafts, result.memberOutcomes)
    if (result.isFinal !== true || recoveredDrafts.length === 0) return false

    const { worktreePath, ticket, relevantFiles } = loadTicketDirContext(context)

    let contextBuilder: PhaseIntermediateData['contextBuilder']
    let baseTicketState: TicketState | undefined
    if (pipeline === 'interview') {
      const ticketState: TicketState = {
        ticketId: context.externalId,
        title: context.title,
        description: ticket?.description ?? '',
        relevantFiles,
      }
      baseTicketState = ticketState
    } else if (pipeline === 'prd') {
      const fullAnswersArtifact = getLatestPhaseArtifact(ticketId, 'prd_full_answers', draftStatus, draftAttempt ?? undefined)
      const interview = readTicketFile(ticketId, 'interview.yaml') ?? undefined
      let fullAnswers: string[] | undefined
      if (fullAnswersArtifact) {
        try {
          const parsed = JSON.parse(fullAnswersArtifact.content) as {
            drafts?: unknown
            memberOutcomes?: Record<string, MemberOutcome>
          }
          fullAnswers = recoverPersistedDrafts(parsed.drafts, parsed.memberOutcomes)
            .filter((draft) => draft.outcome === 'completed' && Boolean(draft.content))
            .map((draft) => draft.content)
        } catch {
          fullAnswers = undefined
        }
      }
      const ticketState: TicketState = {
        ticketId: context.externalId,
        title: context.title,
        description: ticket?.description ?? '',
        relevantFiles,
        interview,
        fullAnswers,
      }
      contextBuilder = buildPrdContextBuilder(ticketState)
      baseTicketState = ticketState
    } else {
      const prd = readTicketFile(ticketId, 'prd.yaml') ?? undefined
      const ticketState: TicketState = {
        ticketId: context.externalId,
        title: context.title,
        description: ticket?.description ?? '',
        relevantFiles,
        prd,
      }
      contextBuilder = buildBeadsContextBuilder(ticketState)
    }

    const data: PhaseIntermediateData = {
      drafts: recoveredDrafts,
      memberOutcomes: result.memberOutcomes ?? {},
      worktreePath,
      phase: getRecoveredDraftPhase(pipeline),
      ticketState: baseTicketState,
    }
    if (pipeline === 'prd' && baseTicketState?.fullAnswers) {
      const fullAnswersArtifact = getLatestPhaseArtifact(ticketId, 'prd_full_answers', draftStatus, draftAttempt ?? undefined)
      if (fullAnswersArtifact) {
        try {
          const parsed = JSON.parse(fullAnswersArtifact.content) as {
            drafts?: unknown
            memberOutcomes?: Record<string, MemberOutcome>
          }
          data.fullAnswers = recoverPersistedDrafts(parsed.drafts, parsed.memberOutcomes)
        } catch {
          // Ignore malformed persisted full-answers artifact during recovery.
        }
      }
    }
    if (contextBuilder) {
      data.contextBuilder = contextBuilder
    }

    if (needsVotes) {
      const voteStatus = getPipelineVoteStatus(pipeline)
      const voteAttempt = getActivePhaseAttempt(ticketId, voteStatus)
      const voteArtifact = getLatestPhaseArtifact(ticketId, `${pipeline}_votes`, voteStatus, voteAttempt ?? undefined)
      if (!voteArtifact) return false
      const voteResult = JSON.parse(voteArtifact.content) as {
        winnerId?: unknown
        isFinal?: boolean
      }
      if (voteResult.isFinal !== true) return false
      // A corrupt or partial vote artifact used to be assigned unchecked and then
      // blew up inside the refine handler. Fail the recovery instead, so the
      // caller takes its INTERMEDIATE_DATA_LOST retry path.
      const recoveredWinnerId = typeof voteResult.winnerId === 'string' ? voteResult.winnerId.trim() : ''
      const hasCompletedWinnerDraft = recoveredDrafts.some((draft) =>
        draft.memberId === recoveredWinnerId
        && draft.outcome === 'completed'
        // `Boolean(content)` accepted a draft that is nothing but whitespace,
        // and refinement then ran against an empty winning draft.
        && typeof draft.content === 'string'
        && draft.content.trim().length > 0,
      )
      if (!recoveredWinnerId || !hasCompletedWinnerDraft) return false
      data.winnerId = recoveredWinnerId
    }

    phaseIntermediate.set(key, data)
    console.log(`[runner] Recovered ${pipeline} intermediate data from persisted artifact for ticket ${context.externalId}`)
    return true
  } catch (err) {
    console.error(`[runner] Failed to recover ${pipeline} intermediate data for ticket ${context.externalId}: ${getErrorMessage(err)}`)
    return false
  }
}
