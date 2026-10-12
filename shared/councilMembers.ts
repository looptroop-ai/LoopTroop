/**
 * Council members as both halves of the app see them: how one member's turn in
 * a round can stand, and what a person may do to one member while the round
 * runs.
 */

import type { WorkflowPhaseId } from './workflowMeta'

/**
 * Every way one council member's turn in a round can stand.
 *
 * `stopped` is a person's doing: they pressed Stop on that model. It is kept
 * apart from `failed` and `timed_out` so a reader of a blocked round can tell a
 * decision from a fault.
 */
export const COUNCIL_MEMBER_OUTCOMES = [
  'pending',
  'completed',
  'timed_out',
  'invalid_output',
  'failed',
  'stopped',
] as const

export type CouncilMemberOutcome = (typeof COUNCIL_MEMBER_OUTCOMES)[number]

export function isCouncilMemberOutcome(value: unknown): value is CouncilMemberOutcome {
  return typeof value === 'string' && (COUNCIL_MEMBER_OUTCOMES as readonly string[]).includes(value)
}

/** The reason a stopped member carries wherever a failure reason is shown. */
export const COUNCIL_MEMBER_STOPPED_ERROR = 'Stopped by you'

/** Statuses where every council model drafts in parallel. */
export const COUNCIL_DRAFTING_CONTROL_PHASES = [
  'COUNCIL_DELIBERATING',
  'DRAFTING_PRD',
  'DRAFTING_BEADS',
] as const satisfies readonly WorkflowPhaseId[]

/** Statuses where every council model votes in parallel. */
export const COUNCIL_VOTING_CONTROL_PHASES = [
  'COUNCIL_VOTING_INTERVIEW',
  'COUNCIL_VOTING_PRD',
  'COUNCIL_VOTING_BEADS',
] as const satisfies readonly WorkflowPhaseId[]

/** Where one council model can be stopped or restarted while the others keep working. */
export const COUNCIL_MEMBER_CONTROL_PHASES = [
  ...COUNCIL_DRAFTING_CONTROL_PHASES,
  ...COUNCIL_VOTING_CONTROL_PHASES,
] as const

export type CouncilMemberControlPhase = (typeof COUNCIL_MEMBER_CONTROL_PHASES)[number]

export function isCouncilMemberControlPhase(phase: unknown): phase is CouncilMemberControlPhase {
  return typeof phase === 'string' && (COUNCIL_MEMBER_CONTROL_PHASES as readonly string[]).includes(phase)
}

export function isCouncilVotingControlPhase(phase: unknown): boolean {
  return typeof phase === 'string' && (COUNCIL_VOTING_CONTROL_PHASES as readonly string[]).includes(phase)
}

/**
 * Where a PRD drafting retry starts.
 *
 * Each model writes the PRD in two parts: Full Answers (Part 1), then the draft
 * (Part 2). Retrying from `full_answers` redoes both. Retrying from `prd_draft`
 * keeps a finished Part 1 and redoes only the draft; with Part 1 unfinished, or
 * thrown away by a stop, it redoes both as well.
 */
export const COUNCIL_MEMBER_RETRY_PARTS = ['full_answers', 'prd_draft'] as const

export type CouncilMemberRetryPart = (typeof COUNCIL_MEMBER_RETRY_PARTS)[number]

/**
 * Why a stop or retry was refused.
 *
 * - `STEP_NOT_RUNNING`: no council round of that status is running for the
 *   ticket. It already finished, or never started.
 * - `UNKNOWN_MEMBER`: the model is not on this round's council.
 * - `MEMBER_FINISHED`: Stop on a model that already finished its turn.
 * - `MEMBER_BUSY`: a stop or retry for that model is already under way.
 * - `STOP_UNCONFIRMED`: the model's turn could not be ended cleanly (OpenCode
 *   did not confirm its session stopped), or its restart could not be
 *   recorded. The round fails once the other models finish, rather than risk
 *   two copies of the model running.
 */
export type CouncilMemberControlErrorCode =
  | 'STEP_NOT_RUNNING'
  | 'UNKNOWN_MEMBER'
  | 'MEMBER_FINISHED'
  | 'MEMBER_BUSY'
  | 'STOP_UNCONFIRMED'

export interface CouncilMemberStopRequest {
  phase: CouncilMemberControlPhase
  memberId: string
}

export interface CouncilMemberRetryRequest extends CouncilMemberStopRequest {
  /** Only read in `DRAFTING_PRD`. Defaults to `prd_draft`. */
  part?: CouncilMemberRetryPart
}

export interface CouncilMemberStopResponse {
  success: true
  phase: CouncilMemberControlPhase
  memberId: string
  /**
   * How the member's turn ended. Usually `stopped`; a model that finished in the
   * moment before the stop landed keeps its own outcome.
   */
  outcome: CouncilMemberOutcome
}

export interface CouncilMemberRetryResponse {
  success: true
  phase: CouncilMemberControlPhase
  memberId: string
}

export interface CouncilMemberControlErrorResponse {
  error: string
  code?: CouncilMemberControlErrorCode
  /** The underlying error's text, or the field errors of a rejected body. */
  details?: string | Record<string, unknown>
}
