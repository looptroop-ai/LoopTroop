import type { TicketPhaseAttempt } from '@/hooks/useTicketPhaseAttempts'

/**
 * Which attempt the selector should show as chosen, or undefined when there is
 * nothing to choose between.
 *
 * Four call sites wrote `selectedAttempt?.attemptNumber ?? attempts[0]!...`,
 * each guarded by its own `attempts.length > 1` a few lines above — so the
 * assertion was true, and true for a reason stated somewhere else. Here the
 * emptiness is handled where it is decided, and the selector renders only when
 * this returns a number.
 */
export function selectedAttemptNumber(
  selected: Pick<TicketPhaseAttempt, 'attemptNumber'> | null | undefined,
  attempts: TicketPhaseAttempt[],
): number | undefined {
  return selected?.attemptNumber ?? attempts[0]?.attemptNumber
}
