import { useCallback, useState, useEffect, useRef } from 'react'
import { useSubmitBatch, useSkipInterview, useTicketUIState, useSaveTicketUIState } from '@/hooks/useTickets'
import { flushTicketUiStateSnapshot } from '@/components/workspace/approvalHooks'
import { INTERVIEW_BATCH_EVENT, parseInterviewBatchEventDetail } from '@/lib/interviewBatchEvents'
import type { PersistedInterviewBatch } from '@shared/interviewSession'
import type { AutosaveStatusState } from '@/components/workspace/AutosaveStatus'

const INTERVIEW_DRAFTS_SCOPE = 'interview-drafts'
const DRAFT_SAVE_DEBOUNCE_MS = 350

export interface PersistedInterviewDrafts {
  draftAnswers: Record<string, Record<string, string>>
  skippedQuestions: Record<string, string[]>
  selectedOptions: Record<string, Record<string, string[]>>
  /**
   * Batch key → question id → reason. Autosaved with the rest of the draft, so a
   * reason typed before a reload is still there after it.
   */
  skipReasons?: Record<string, Record<string, string>>
}

function serializeSkipped(map: Record<string, Set<string>>): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [key, set] of Object.entries(map)) {
    result[key] = [...set]
  }
  return result
}

function deserializeSkipped(map: Record<string, string[]>): Record<string, Set<string>> {
  const result: Record<string, Set<string>> = {}
  for (const [key, arr] of Object.entries(map)) {
    result[key] = new Set(arr)
  }
  return result
}

function removeSkippedSelectedOptions(
  selectedOptions: Record<string, Record<string, string[]>>,
  skippedMap: Record<string, Set<string>>,
): Record<string, Record<string, string[]>> {
  const result: Record<string, Record<string, string[]>> = {}

  for (const [batchKey, batchOptions] of Object.entries(selectedOptions)) {
    const skippedQuestionIds = skippedMap[batchKey]
    if (!skippedQuestionIds || skippedQuestionIds.size === 0) {
      result[batchKey] = batchOptions
      continue
    }

    const filteredBatchOptions = Object.fromEntries(
      Object.entries(batchOptions).filter(([questionId]) => !skippedQuestionIds.has(questionId)),
    )
    result[batchKey] = filteredBatchOptions
  }

  return result
}

export function getBatchKey(batch: PersistedInterviewBatch | null | undefined) {
  if (!batch) return null
  return [batch.source, batch.roundNumber ?? 0, batch.batchNumber].join(':')
}

/**
 * Empty a draft map without forcing a re-render when it is already empty. Deliberately not
 * `setX({})`: that allocates a new object every time, so the reset below would re-render on every
 * mount as well as on the ticket changes it is there for.
 */
function clearMap<T extends Record<string, unknown>>(current: T): T {
  return Object.keys(current).length === 0 ? current : ({} as T)
}

export function useBatchSubmit(ticketId: string) {
  const { mutateAsync: submitBatchMutation, isPending: isSubmitting } = useSubmitBatch()
  const { mutateAsync: skipInterviewMutation, isPending: isSkipping } = useSkipInterview()
  const { data: persistedDrafts } = useTicketUIState<PersistedInterviewDrafts>(ticketId, INTERVIEW_DRAFTS_SCOPE)
  const { mutateAsync: saveUiState } = useSaveTicketUIState()

  const [draftAnswers, setDraftAnswers] = useState<Record<string, Record<string, string>>>({})
  const [skippedQuestions, setSkippedQuestions] = useState<Record<string, Set<string>>>({})
  const [batchSelectedOptions, setBatchSelectedOptions] = useState<Record<string, Record<string, string[]>>>({})
  const [batchSkipReasons, setBatchSkipReasons] = useState<Record<string, Record<string, string>>>({})
  const [submittedBatchKey, setSubmittedBatchKey] = useState<string | null>(null)
  const [sseBatch, setSseBatch] = useState<PersistedInterviewBatch | null>(null)
  const [processingError, setProcessingError] = useState<string | null>(null)
  const [draftsRestoreTick, setDraftsRestoreTick] = useState(0)
  const [autosaveState, setAutosaveState] = useState<AutosaveStatusState>('pending')
  const [lastAutosavedAt, setLastAutosavedAt] = useState<Date | null>(null)

  const restoredDraftRef = useRef(false)
  const lastSavedSnapshotRef = useRef('')
  const latestDraftSnapshotRef = useRef<{
    serialized: string
    snapshot: PersistedInterviewDrafts
  } | null>(null)

  useEffect(() => {
    restoredDraftRef.current = false
    lastSavedSnapshotRef.current = ''
    latestDraftSnapshotRef.current = null
    // The in-memory maps are keyed by source/round/batch with no ticket in the key, so two tickets
    // sitting at the same interview position share a key. Emptying them here is what stops a submit
    // on the newly opened ticket from posting the previous ticket's answers — `handleSubmitBatch`
    // and `handleConfirmSkipAll` read these maps directly, without waiting for a restore. It is
    // also what makes the "keep what is on screen" fallback in the restore effect below safe.
    // App.tsx remounts the dashboard per ticket so each ticket already gets a fresh hook; this
    // keeps the guarantee from depending on that.
    setDraftAnswers(clearMap)
    setSkippedQuestions(clearMap)
    setBatchSelectedOptions(clearMap)
    setBatchSkipReasons(clearMap)
    setAutosaveState('pending')
    setLastAutosavedAt(null)
  }, [ticketId])

  // Restore persisted drafts once on mount / ticket change.
  useEffect(() => {
    if (restoredDraftRef.current || !persistedDrafts) return
    // Only ever restore this ticket's own payload. The dashboard is remounted per ticket, but a
    // payload held from the previous ticket while the new query is still in flight would otherwise
    // be applied here and then autosaved onto the ticket now on screen.
    //
    // This fails closed on purpose: an unstamped payload restores nothing, so `restoredDraftRef`
    // stays false and autosave stays off rather than saving over whatever is on disk. Every payload
    // that reaches here through `fetchTicketUIState` carries the id of the ticket it was requested
    // for, so the only way to trip that is to hand the hook a payload from somewhere else.
    if (persistedDrafts.ticketId !== ticketId) return

    const persisted = persistedDrafts.data
    const frame = requestAnimationFrame(() => {
      const persistedSkippedQuestions = persisted?.skippedQuestions
        ? deserializeSkipped(persisted.skippedQuestions)
        : {}
      // An absent collection means "nothing saved for this ticket", so keep what is on screen: the
      // ticket change above emptied these maps, which leaves only answers the user has typed on
      // this ticket while the query was still in flight. The baseline snapshot below still records
      // what is actually on disk, so that typing reads as unsaved and the next autosave stores it.
      setDraftAnswers((current) => persisted?.draftAnswers ?? current)
      setSkippedQuestions((current) => (persisted?.skippedQuestions ? persistedSkippedQuestions : current))
      setBatchSelectedOptions((current) =>
        persisted?.selectedOptions
          ? removeSkippedSelectedOptions(persisted.selectedOptions, persistedSkippedQuestions)
          : current,
      )
      setBatchSkipReasons((current) => persisted?.skipReasons ?? current)

      const snapshot: PersistedInterviewDrafts = {
        draftAnswers: persisted?.draftAnswers ?? {},
        skippedQuestions: persisted?.skippedQuestions ?? {},
        selectedOptions: persisted?.selectedOptions
          ? removeSkippedSelectedOptions(persisted.selectedOptions, persistedSkippedQuestions)
          : {},
        skipReasons: persisted?.skipReasons ?? {},
      }
      lastSavedSnapshotRef.current = JSON.stringify(snapshot)
      latestDraftSnapshotRef.current = {
        serialized: lastSavedSnapshotRef.current,
        snapshot,
      }
      restoredDraftRef.current = true
      setLastAutosavedAt(persistedDrafts.updatedAt ? new Date(persistedDrafts.updatedAt) : null)
      setAutosaveState('saved')
      setDraftsRestoreTick((current) => current + 1)
    })
    return () => cancelAnimationFrame(frame)
  }, [persistedDrafts, ticketId])

  // Interview batch events forwarded from the ticket stream.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = parseInterviewBatchEventDetail((event as CustomEvent<unknown>).detail)
      if (!detail || detail.ticketId !== ticketId) return

      if (detail.type === 'interview_batch') {
        setSseBatch(detail.batch)
        setSubmittedBatchKey(null)
        setProcessingError(null)
        return
      }

      if (detail.type === 'interview_error') {
        setProcessingError(detail.error || 'Failed to process interview batch')
      }
    }

    window.addEventListener(INTERVIEW_BATCH_EVENT, handler)
    return () => window.removeEventListener(INTERVIEW_BATCH_EVENT, handler)
  }, [ticketId])

  // Auto-save drafts with debounce
  useEffect(() => {
    if (!restoredDraftRef.current) return

    const snapshot: PersistedInterviewDrafts = {
      draftAnswers,
      skippedQuestions: serializeSkipped(skippedQuestions),
      selectedOptions: batchSelectedOptions,
      skipReasons: batchSkipReasons,
    }
    const serialized = JSON.stringify(snapshot)
    latestDraftSnapshotRef.current = { serialized, snapshot }
    if (serialized === lastSavedSnapshotRef.current) {
      setAutosaveState('saved')
      return
    }
    setAutosaveState('pending')

    let canceled = false
    const timer = window.setTimeout(() => {
      if (!canceled) setAutosaveState('saving')
      void saveUiState({
        ticketId,
        scope: INTERVIEW_DRAFTS_SCOPE,
        data: snapshot,
      }).then((saved) => {
        if (canceled || latestDraftSnapshotRef.current?.serialized !== serialized) return
        if (saved.conflict) {
          setAutosaveState('conflict')
          return
        }
        lastSavedSnapshotRef.current = serialized
        if (saved.updatedAt) setLastAutosavedAt(new Date(saved.updatedAt))
        setAutosaveState('saved')
      }).catch(() => {
        if (!canceled && latestDraftSnapshotRef.current?.serialized === serialized) setAutosaveState('error')
      })
    }, DRAFT_SAVE_DEBOUNCE_MS)

    return () => {
      canceled = true
      window.clearTimeout(timer)
    }
  }, [draftAnswers, skippedQuestions, batchSelectedOptions, batchSkipReasons, draftsRestoreTick, saveUiState, ticketId])

  useEffect(() => {
    const flushLatest = () => {
      const latest = latestDraftSnapshotRef.current
      if (!restoredDraftRef.current || !latest || latest.serialized === lastSavedSnapshotRef.current) return
      flushTicketUiStateSnapshot(ticketId, INTERVIEW_DRAFTS_SCOPE, latest.snapshot)
    }

    window.addEventListener('pagehide', flushLatest)
    window.addEventListener('beforeunload', flushLatest)
    return () => {
      window.removeEventListener('pagehide', flushLatest)
      window.removeEventListener('beforeunload', flushLatest)
      // Leaving the ticket cancels the 350ms autosave debounce mid-flight, so an answer typed just
      // before the switch would otherwise be dropped with no save and no warning. Flushing here
      // stores it against the ticket it was typed on — `ticketId` is the one this effect captured,
      // not the one now on screen.
      flushLatest()
    }
  }, [ticketId])

  const clearSkipReason = useCallback((currentBatchKey: string, questionId: string) => {
    setBatchSkipReasons((current) => {
      const batchReasons = current[currentBatchKey]
      if (!batchReasons || !(questionId in batchReasons)) return current
      const nextBatchReasons = { ...batchReasons }
      delete nextBatchReasons[questionId]
      return { ...current, [currentBatchKey]: nextBatchReasons }
    })
  }, [])

  const handleBatchAnswer = useCallback((currentBatchKey: string | null, questionId: string, value: string) => {
    if (!currentBatchKey) return
    setDraftAnswers((current) => ({
      ...current,
      [currentBatchKey]: {
        ...(current[currentBatchKey] ?? {}),
        [questionId]: value,
      },
    }))
    if (value.trim()) {
      setSkippedQuestions((current) => {
        const prev = current[currentBatchKey]
        if (!prev?.has(questionId)) return current
        const next = new Set(prev)
        next.delete(questionId)
        return { ...current, [currentBatchKey]: next }
      })
      clearSkipReason(currentBatchKey, questionId)
    }
  }, [clearSkipReason])

  const handleSkipQuestion = useCallback((currentBatchKey: string | null, questionId: string) => {
    if (!currentBatchKey) return
    setDraftAnswers((current) => ({
      ...current,
      [currentBatchKey]: {
        ...(current[currentBatchKey] ?? {}),
        [questionId]: '',
      },
    }))
    setSkippedQuestions((current) => {
      const prev = current[currentBatchKey] ?? new Set<string>()
      const next = new Set(prev)
      next.add(questionId)
      return { ...current, [currentBatchKey]: next }
    })
    setBatchSelectedOptions((current) => {
      const batchOpts = current[currentBatchKey]
      if (!batchOpts || !(questionId in batchOpts)) return current

      const nextBatchOpts = { ...batchOpts }
      delete nextBatchOpts[questionId]

      return {
        ...current,
        [currentBatchKey]: nextBatchOpts,
      }
    })
  }, [])

  const handleSkipReasonChange = useCallback((currentBatchKey: string | null, questionId: string, reason: string) => {
    if (!currentBatchKey) return
    setBatchSkipReasons((current) => ({
      ...current,
      [currentBatchKey]: {
        ...(current[currentBatchKey] ?? {}),
        [questionId]: reason,
      },
    }))
  }, [])

  const handleUnskipQuestion = useCallback((currentBatchKey: string | null, questionId: string) => {
    if (!currentBatchKey) return
    setSkippedQuestions((current) => {
      const prev = current[currentBatchKey]
      if (!prev?.has(questionId)) return current
      const next = new Set(prev)
      next.delete(questionId)
      return { ...current, [currentBatchKey]: next }
    })
    // The reason explained a skip that is no longer happening. Keeping it would
    // let it re-attach if the question were skipped again for a different reason.
    clearSkipReason(currentBatchKey, questionId)
  }, [clearSkipReason])

  const handleOptionToggle = useCallback((currentBatchKey: string | null, questionId: string, optionId: string, isSingleChoice: boolean) => {
    if (!currentBatchKey) return
    setBatchSelectedOptions((current) => {
      const batchOpts = current[currentBatchKey] ?? {}
      const currentSelected = batchOpts[questionId] ?? []
      let nextSelected: string[]
      if (isSingleChoice) {
        nextSelected = currentSelected.includes(optionId) ? [] : [optionId]
      } else {
        nextSelected = currentSelected.includes(optionId)
          ? currentSelected.filter((id) => id !== optionId)
          : [...currentSelected, optionId]
      }
      return {
        ...current,
        [currentBatchKey]: {
          ...batchOpts,
          [questionId]: nextSelected,
        },
      }
    })
    setSkippedQuestions((current) => {
      const prev = current[currentBatchKey]
      if (!prev?.has(questionId)) return current
      const next = new Set(prev)
      next.delete(questionId)
      return { ...current, [currentBatchKey]: next }
    })
    clearSkipReason(currentBatchKey, questionId)
  }, [clearSkipReason])

  const handleSubmitBatch = useCallback(async (
    currentBatch: PersistedInterviewBatch | null,
    currentBatchKey: string | null,
    batchAnswers: Record<string, string>,
  ) => {
    if (!currentBatch || !currentBatchKey) return

    try {
      const skippedQuestionIds = skippedQuestions[currentBatchKey] ?? new Set<string>()
      const selectedOptions = Object.fromEntries(
        Object.entries(batchSelectedOptions[currentBatchKey] ?? {})
          .filter(([questionId]) => !skippedQuestionIds.has(questionId)),
      )
      // Only reasons for questions this batch is actually skipping. The server
      // rejects the rest with a 400, and it is right to.
      const skipReasons = Object.fromEntries(
        Object.entries(batchSkipReasons[currentBatchKey] ?? {})
          .filter(([questionId, reason]) => skippedQuestionIds.has(questionId) && reason.trim().length > 0)
          .map(([questionId, reason]) => [questionId, reason.trim()]),
      )
      await submitBatchMutation({
        ticketId,
        answers: batchAnswers,
        selectedOptions,
        skipReasons,
      })
      setDraftAnswers((current) => {
        if (!(currentBatchKey in current)) return current
        const next = { ...current }
        delete next[currentBatchKey]
        return next
      })
      setSkippedQuestions((current) => {
        if (!(currentBatchKey in current)) return current
        const next = { ...current }
        delete next[currentBatchKey]
        return next
      })
      setBatchSelectedOptions((current) => {
        if (!(currentBatchKey in current)) return current
        const next = { ...current }
        delete next[currentBatchKey]
        return next
      })
      setBatchSkipReasons((current) => {
        if (!(currentBatchKey in current)) return current
        const next = { ...current }
        delete next[currentBatchKey]
        return next
      })
      setSubmittedBatchKey(currentBatchKey)
      setSseBatch(null)
    } catch (err) {
      console.error('Failed to submit interview batch:', err)
      throw err
    }
  }, [submitBatchMutation, batchSelectedOptions, batchSkipReasons, skippedQuestions, ticketId])

  const handleConfirmSkipAll = useCallback(async (
    currentBatch: PersistedInterviewBatch | null,
    currentBatchKey: string | null,
    batchAnswers: Record<string, string>,
    bulkSkipReason?: string,
  ) => {
    if (!currentBatch) return

    try {
      const batchQuestionIds = new Set(currentBatch.questions.map((question) => question.id))
      const skippedQuestionIds = currentBatchKey ? skippedQuestions[currentBatchKey] ?? new Set<string>() : new Set<string>()
      const selectedOptions = Object.fromEntries(
        Object.entries(currentBatchKey ? batchSelectedOptions[currentBatchKey] ?? {} : {})
          .filter(([questionId]) => !skippedQuestionIds.has(questionId)),
      )
      // A reason only rides along for a question in this batch that is going to
      // be skipped. Anything answered here stays answered — Skip All never
      // touches it, so a reason for it would explain nothing.
      const skipReasons = Object.fromEntries(
        Object.entries(currentBatchKey ? batchSkipReasons[currentBatchKey] ?? {} : {})
          .filter(([questionId, reason]) => (
            batchQuestionIds.has(questionId)
            && !((selectedOptions[questionId] ?? []).length > 0)
            && !(batchAnswers[questionId] ?? '').trim()
            && reason.trim().length > 0
          ))
          .map(([questionId, reason]) => [questionId, reason.trim()]),
      )
      await skipInterviewMutation({
        ticketId,
        answers: batchAnswers,
        selectedOptions,
        skipReasons,
        ...(bulkSkipReason?.trim() ? { bulkSkipReason: bulkSkipReason.trim() } : {}),
      })
      setDraftAnswers({})
      setSkippedQuestions({})
      setBatchSelectedOptions({})
      setBatchSkipReasons({})
      const emptySnapshot: PersistedInterviewDrafts = { draftAnswers: {}, skippedQuestions: {}, selectedOptions: {}, skipReasons: {} }
      const serializedEmptySnapshot = JSON.stringify(emptySnapshot)
      latestDraftSnapshotRef.current = { serialized: serializedEmptySnapshot, snapshot: emptySnapshot }
      void saveUiState({ ticketId, scope: INTERVIEW_DRAFTS_SCOPE, data: emptySnapshot })
        .then((saved) => {
          if (latestDraftSnapshotRef.current?.serialized !== serializedEmptySnapshot) return
          if (saved.conflict) {
            setAutosaveState('conflict')
            return
          }
          lastSavedSnapshotRef.current = serializedEmptySnapshot
          if (saved.updatedAt) setLastAutosavedAt(new Date(saved.updatedAt))
          setAutosaveState('saved')
        })
        .catch(() => setAutosaveState('error'))
      setSseBatch(null)
    } catch (err) {
      // Rethrown so the dialog can stay open with the reason still in it. A
      // swallowed failure closed the dialog, cleared the reason, and left the
      // ticket exactly where it was.
      console.error('Failed to skip remaining interview questions:', err)
      throw err
    }
  }, [skipInterviewMutation, batchSelectedOptions, batchSkipReasons, skippedQuestions, saveUiState, ticketId])

  return {
    draftAnswers,
    skippedQuestions,
    batchSelectedOptions,
    batchSkipReasons,
    sseBatch,
    processingError,
    submittedBatchKey,
    isSubmitting,
    isSkipping,
    autosaveState,
    lastAutosavedAt,
    setProcessingError,
    handleBatchAnswer,
    handleOptionToggle,
    handleSkipQuestion,
    handleUnskipQuestion,
    handleSkipReasonChange,
    handleSubmitBatch,
    handleConfirmSkipAll,
  }
}
