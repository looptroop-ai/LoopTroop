import { PROFILE_DEFAULTS } from '../../db/defaults'

/**
 * How many coverage follow-up questions a ticket may ask.
 *
 * Zero means zero. The profile schema accepts 0-100, and `Math.max(1, …)`
 * turned a deliberate 0% into one question — so an operator who had switched
 * coverage follow-ups off still got asked. The floor of one is only there so a
 * small positive percentage of a small question count does not round away to
 * nothing, which is a different problem from being turned off.
 *
 * That floor is also why no questions has to be handled separately: a
 * percentage of nothing is nothing, but `Math.max(1, 0)` made it one, so an
 * interview with no questions still budgeted a follow-up.
 */
export function calculateFollowUpLimit(
  totalQuestions: number,
  budgetPercent: number = PROFILE_DEFAULTS.coverageFollowUpBudgetPercent,
): number {
  if (!Number.isFinite(budgetPercent) || budgetPercent <= 0) return 0
  if (!Number.isFinite(totalQuestions) || totalQuestions <= 0) return 0
  return Math.max(1, Math.floor(totalQuestions * (budgetPercent / 100)))
}
