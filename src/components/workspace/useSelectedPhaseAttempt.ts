import { useEffect, useMemo, useState } from 'react'
import { useTicketPhaseAttempts } from '@/hooks/useTicketPhaseAttempts'

/**
 * The attempt a phase surface is showing, and everything derived from it.
 *
 * Three surfaces — council, phase review and approval — repeated the same
 * twenty lines: the query, a manual selection that survives only while it still
 * names a real attempt, the fallback to the active attempt, and the log
 * scope/mode that follow. Keeping three copies in step is what SonarCloud
 * measured; keeping the *selection rule* in step is what actually matters,
 * because a surface that resolves the attempt differently shows a different
 * version of the same phase.
 */
export function useSelectedPhaseAttempt(ticketId?: string, phase?: string) {
  const {
    data: attempts = [],
    isError,
    error,
    refetch,
  } = useTicketPhaseAttempts(ticketId, phase)
  const [manualSelectedAttemptNumber, setManualSelectedAttemptNumber] = useState<number | null>(null)

  // A choice belongs to the phase it was made in. The memo below already
  // ignores a number the current attempts do not contain, but a coincidental
  // match across phases would silently keep it — `CodingView` changes the phase
  // within one mount, which is where that can happen.
  useEffect(() => {
    setManualSelectedAttemptNumber(null)
  }, [phase])

  const selectedAttemptNumber = useMemo(() => {
    if (manualSelectedAttemptNumber != null && attempts.some((attempt) => attempt.attemptNumber === manualSelectedAttemptNumber)) {
      return manualSelectedAttemptNumber
    }
    return (attempts.find((attempt) => attempt.state === 'active') ?? attempts[0])?.attemptNumber ?? null
  }, [attempts, manualSelectedAttemptNumber])

  const selectedAttempt = useMemo(
    () => attempts.find((attempt) => attempt.attemptNumber === selectedAttemptNumber)
      ?? attempts.find((attempt) => attempt.state === 'active')
      ?? attempts[0]
      ?? null,
    [attempts, selectedAttemptNumber],
  )

  const archivedAttemptNumber = selectedAttempt?.state === 'archived' ? selectedAttempt.attemptNumber : undefined

  return {
    attempts,
    selectedAttempt,
    setManualSelectedAttemptNumber,
    archivedAttemptNumber,
    logPhaseAttempt: attempts.length > 1 ? selectedAttempt?.attemptNumber : undefined,
    logMode: (archivedAttemptNumber != null ? 'snapshot' : 'live') as 'snapshot' | 'live',
    isError,
    error,
    refetch,
    /** The history failed and nothing is cached, so the version is unknown. */
    isPhaseVersionUnknown: isError && attempts.length === 0,
  }
}
