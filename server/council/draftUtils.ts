import type { DraftResult, MemberOutcome } from './types'
import type { StructuredFailureClass } from '../lib/structuredOutputRetry'
import { classifyStructuredFailureFromError } from '../lib/structuredOutputRetry'
import { getErrorMessage } from '@shared/typeGuards'

export const PHASE_DEADLINE_ERROR = 'CouncilPhaseDeadlineReached'
export const AI_RESPONSE_TIMEOUT_ERROR = 'Timeout'

export function isPhaseDeadlineError(error: unknown): boolean {
  return error instanceof Error && error.message === PHASE_DEADLINE_ERROR
}

export function isAiResponseTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === AI_RESPONSE_TIMEOUT_ERROR
}

/**
 * Resolves the draft the refine step is about to rewrite. The winner id comes from
 * the vote scorecard or from a persisted artifact, so a mismatch is recoverable
 * state rather than a programming error — say so instead of refining `undefined`.
 */
export function requireWinnerDraft(
  drafts: DraftResult[],
  winnerId: string,
  label: string,
): DraftResult {
  const winnerDraft = drafts.find((draft) => draft.memberId === winnerId)
  if (!winnerDraft) {
    throw new Error(`${label} winner ${winnerId} has no matching draft — cannot refine`)
  }
  return winnerDraft
}

export function classifyDraftFailure(
  error: unknown,
  options?: {
    content?: string
    failureClass?: StructuredFailureClass
  },
): {
  outcome: MemberOutcome & ('invalid_output' | 'failed')
  errorDetail: string
  failureClass: StructuredFailureClass
} {
  const failureClass = options?.failureClass
    ?? (options?.content?.trim()
      ? 'validation_error'
      : classifyStructuredFailureFromError(error))

  return {
    outcome: failureClass === 'validation_error' ? 'invalid_output' as const : 'failed' as const,
    errorDetail: getErrorMessage(error),
    failureClass,
  }
}
