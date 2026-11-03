import { useCallback, useEffect, useState } from 'react'
import { useTicketPhaseAttempts } from '@/hooks/useTicketPhaseAttempts'
import { useTicketHistoricalLogs } from '@/hooks/useTicketHistoricalLogs'

/** The log route's maximum page size (logHandlers parseQuery accepts 1–500). */
export const ACTIVITY_EVIDENCE_PAGE_SIZE = 500

interface UseCurrentActivityEvidenceOptions {
  ticketId?: string
  phase: string
  enabled: boolean
  requestedAttempt?: number
}

export function useCurrentActivityEvidence({
  ticketId,
  phase,
  enabled,
  requestedAttempt,
}: UseCurrentActivityEvidenceOptions) {
  const attemptScopeKey = enabled && ticketId ? JSON.stringify([ticketId, phase]) : null
  const phaseAttempts = useTicketPhaseAttempts(attemptScopeKey ? ticketId : undefined, attemptScopeKey ? phase : undefined)
  const attemptsSettled = Boolean(attemptScopeKey && phaseAttempts.isSuccess && !phaseAttempts.isFetching)
  const observedAttempt = phaseAttempts.data === undefined
    ? undefined
    : phaseAttempts.data.find(attempt => attempt.state === 'active')?.attemptNumber ?? null

  const [confirmedScopeKey, setConfirmedScopeKey] = useState(attemptScopeKey)
  const [confirmedAttempt, setConfirmedAttempt] = useState<number | null>(null)
  if (confirmedScopeKey !== attemptScopeKey) {
    setConfirmedScopeKey(attemptScopeKey)
    setConfirmedAttempt(null)
  }
  const lastConfirmedAttempt = confirmedScopeKey === attemptScopeKey ? confirmedAttempt : null
  const activePhaseAttempt = attemptsSettled ? observedAttempt ?? undefined : lastConfirmedAttempt ?? undefined

  useEffect(() => {
    if (!attemptsSettled) return
    setConfirmedAttempt(observedAttempt ?? null)
  }, [attemptsSettled, observedAttempt])

  const attemptMatches = requestedAttempt === undefined || requestedAttempt === activePhaseAttempt
  const scopeKey = attemptScopeKey && activePhaseAttempt !== undefined && attemptMatches
    ? JSON.stringify([attemptScopeKey, activePhaseAttempt])
    : null
  const activityEnabled = Boolean(scopeKey && attemptsSettled)
  const activityLogs = useTicketHistoricalLogs(ticketId, {
    scope: 'phase',
    phase,
    phaseAttempt: activePhaseAttempt,
    view: 'activity',
    // The panel always loads the whole phase (fetchAllOlder below), so it asks for
    // the largest page the server allows: every page re-runs the phase's activity
    // query, and fewer, bigger pages finish a long phase in about half the time.
    limit: ACTIVITY_EVIDENCE_PAGE_SIZE,
  }, activityEnabled)

  const [completeEvidence, setCompleteEvidence] = useState<{ scopeKey: string; entries: typeof activityLogs.entries } | null>(null)
  if (completeEvidence && completeEvidence.scopeKey !== scopeKey) {
    setCompleteEvidence(null)
  }

  const fetchAllOlder = activityLogs.fetchAllOlder
  useEffect(() => {
    if (!activityEnabled || !activityLogs.hasOlder || activityLogs.isError) return
    let cancelled = false
    void fetchAllOlder(() => cancelled).catch(() => undefined)
    return () => { cancelled = true }
  }, [activityEnabled, activityLogs.hasOlder, activityLogs.isError, fetchAllOlder])

  useEffect(() => {
    if (!activityEnabled || !scopeKey || !activityLogs.isSuccess || activityLogs.isFetching || activityLogs.hasOlder || activityLogs.isError) return
    setCompleteEvidence({ scopeKey, entries: activityLogs.entries })
  }, [activityEnabled, activityLogs.entries, activityLogs.hasOlder, activityLogs.isError, activityLogs.isFetching, activityLogs.isSuccess, scopeKey])

  const readyEvidence = scopeKey && completeEvidence?.scopeKey === scopeKey ? completeEvidence : null
  const attemptVerificationFailed = Boolean(attemptScopeKey && phaseAttempts.isError)
  const errorTitle = attemptScopeKey && phaseAttempts.isError
    ? 'The current phase attempt could not be verified.'
    : activityEnabled && activityLogs.isError
      ? 'Complete current phase activity could not be loaded.'
      : null
  const error = attemptScopeKey && phaseAttempts.isError
    ? phaseAttempts.error
    : activityEnabled && activityLogs.isError
      ? activityLogs.error
      : undefined
  const refetchAttempts = phaseAttempts.refetch
  const retryHistoricalLogs = activityLogs.retryHistoricalLogs
  const attemptsFailed = phaseAttempts.isError
  const retry = useCallback(() => {
    if (attemptScopeKey && attemptsFailed) {
      void refetchAttempts()
    } else {
      void retryHistoricalLogs().catch(() => undefined)
    }
  }, [attemptScopeKey, attemptsFailed, refetchAttempts, retryHistoricalLogs])

  return {
    entries: attemptVerificationFailed ? [] : readyEvidence?.entries ?? [],
    activePhaseAttempt: ticketId ? activePhaseAttempt : requestedAttempt,
    activeStatus: phase || null,
    enabled: enabled && !attemptVerificationFailed && (!ticketId || readyEvidence !== null),
    error,
    errorTitle,
    retry,
  }
}
