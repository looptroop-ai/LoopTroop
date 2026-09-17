import type { OpenCodeAdapter } from '../opencode/adapter'
import type {
  CouncilMember,
  DraftGenerationResult,
  DraftMetrics,
  DraftProgressEvent,
  DraftResult,
  DraftStructuredOutputMeta,
  MemberOutcome,
  RawAttempt,
} from './types'
import { CancelledError } from './types'
import type { Message, PromptPart, StreamEvent } from '../opencode/types'
import type { OpenCodeToolPolicy } from '../opencode/toolPolicy'
import { formatPromptText, runOpenCodePrompt, type OpenCodePromptDispatchEvent } from '../workflow/runOpenCodePrompt'
import { createWorkBudget } from '../workflow/workBudget'
import { wasMemberAnswered } from '../workflow/questionWindows'
import { COUNCIL_RESPONSE_TIMEOUT_MS } from '../lib/constants'
import { PHASE_DEADLINE_ERROR, isPhaseDeadlineError, isAiResponseTimeoutError, classifyDraftFailure } from './draftUtils'
import { isAbortError } from '../lib/abort'
import { buildStructuredRetryPrompt } from '../structuredOutput'
import { getStructuredRetryDecision } from '../lib/structuredOutputRetry'
import { resolveStructuredRetryDiagnostic } from '../lib/structuredRetryDiagnostics'
import { normalizeStructuredRetryCount } from '../lib/structuredRetryPolicy'
import { appendAcceptedRawAttempt, appendRejectedRawAttempt } from '../lib/structuredRawAttempts'
import { getErrorMessage } from '@shared/typeGuards'
import type { WorkflowPhaseId } from '@shared/workflowMeta'
import { SessionManager } from '../opencode/sessionManager'
import { shouldPreserveSessionForContinuation } from '../opencode/sessionContinuation'
import { confirmCouncilSessionStopped } from './sessionStop'

function unconfirmedDraftStopError(sessionId: string): Error {
  return new Error(`Could not confirm abort of OpenCode session ${sessionId}`)
}

interface DraftValidationResult {
  questionCount?: number
  normalizedContent?: string
  repairApplied?: boolean
  repairWarnings?: string[]
  draftMetrics?: DraftMetrics
}

type DraftValidator = (content: string) => DraftValidationResult

interface GenerateDraftsRuntimeOptions {
  ticketId?: string
  /** The workflow status the round runs in, not the council stage. */
  phase?: WorkflowPhaseId
  phaseAttempt?: number
  toolPolicy?: OpenCodeToolPolicy
  onPromptDispatched?: (entry: {
    stage: 'draft'
    memberId: string
    event: OpenCodePromptDispatchEvent
  }) => void
  onDraftResult?: (draft: DraftResult) => void
  maxStructuredRetries?: number
  structuredRetrySchemaReminder?: string
}

function buildMemberOutcomeMap(drafts: DraftResult[]) {
  return drafts.reduce<Record<string, MemberOutcome>>((outcomes, draft) => {
    outcomes[draft.memberId] = draft.outcome
    return outcomes
  }, {})
}

export async function generateDrafts(
  adapter: OpenCodeAdapter,
  members: CouncilMember[],
  contextParts: PromptPart[],
  projectPath: string,
  timeout: number = COUNCIL_RESPONSE_TIMEOUT_MS,
  signal?: AbortSignal,
  onOpenCodeSessionLog?: (entry: {
    stage: 'draft' | 'vote' | 'refine'
    memberId: string
    sessionId: string
    response: string
    messages: Message[]
  }) => void,
  onOpenCodeStreamEvent?: (entry: {
    stage: 'draft'
    memberId: string
    sessionId: string
    event: StreamEvent
  }) => void,
  onDraftProgress?: (entry: DraftProgressEvent) => void,
  validateDraft?: DraftValidator,
  runtimeOptions?: GenerateDraftsRuntimeOptions,
): Promise<DraftGenerationResult> {
  const results = new Map<string, DraftResult>()
  const finalizedMembers = new Set<string>()
  // One budget for the round, shared by every member. It is a budget rather than
  // a bare deadline so a question wait can hold it: the round's own
  // `Promise.race` timer never saw the prompt timer, so without this a member
  // blocked on a question would still lose its round to a timeout.
  const budget = createWorkBudget({
    ...(runtimeOptions?.ticketId ? { ticketId: runtimeOptions.ticketId } : {}),
    ...(timeout > 0 ? { totalMs: timeout } : {}),
    scope: 'council_member',
  })
  const sessionManager = runtimeOptions?.ticketId && runtimeOptions.phase
    ? new SessionManager(adapter)
    : null
  let deadlineReached = false

  function recordResult(draft: DraftResult, sessionId?: string): boolean {
    if (finalizedMembers.has(draft.memberId)) return false

    finalizedMembers.add(draft.memberId)
    results.set(draft.memberId, draft)
    runtimeOptions?.onDraftResult?.(draft)
    onDraftProgress?.({
      memberId: draft.memberId,
      status: 'finished',
      sessionId,
      outcome: draft.outcome,
      duration: draft.duration,
      error: draft.error,
      content: draft.content,
      questionCount: draft.questionCount,
      draftMetrics: draft.draftMetrics,
      structuredOutput: draft.structuredOutput,
      ...(typeof draft.rawResponse === 'string' ? { rawResponse: draft.rawResponse } : {}),
      ...(typeof draft.normalizedResponse === 'string' ? { normalizedResponse: draft.normalizedResponse } : {}),
      ...(draft.rawAttempts ? { rawAttempts: draft.rawAttempts } : {}),
      ...(draft.skippedReason ? { skippedReason: draft.skippedReason } : {}),
    })
    return true
  }

  const promises = members.map(async (member): Promise<DraftResult> => {
    const startTime = Date.now()
    let sessionId: string | undefined
    let content = ''
    let validation: DraftValidationResult | undefined
    let lastValidationError: string | undefined
    let attemptCount = 0
    let closed = false
    let promptReturned = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const memberAbortController = new AbortController()
    const memberSignal = signal
      ? AbortSignal.any([signal, memberAbortController.signal])
      : memberAbortController.signal
    let resolveExecutionSettled: () => void = () => {}
    const executionSettled = new Promise<void>((resolve) => {
      resolveExecutionSettled = resolve
    })
    let resolveSessionReady: () => void = () => {}
    const sessionReady = new Promise<void>((resolve) => {
      resolveSessionReady = resolve
    })
    let lastFailureClass: DraftStructuredOutputMeta['failureClass']
    let rawResponse: string | undefined
    let normalizedResponse: string | undefined
    const rawAttempts: RawAttempt[] = []
    const retryDiagnostics: NonNullable<DraftStructuredOutputMeta['retryDiagnostics']> = []

    const buildStructuredOutput = (): DraftStructuredOutputMeta | undefined => {
      if (!validation && attemptCount === 0 && !lastValidationError) return undefined
      return {
        repairApplied: validation?.repairApplied ?? false,
        repairWarnings: validation?.repairWarnings ?? [],
        autoRetryCount: attemptCount,
        ...(lastValidationError ? { validationError: lastValidationError } : {}),
        ...(retryDiagnostics.length > 0 ? { retryDiagnostics: [...retryDiagnostics] } : {}),
        ...(lastFailureClass ? { failureClass: lastFailureClass } : {}),
      }
    }

    const markTimedOut = () => {
      if (closed) return
      closed = true
      deadlineReached = true
      memberAbortController.abort()
    }

    const executeDraft = (async () => {
      if (signal?.aborted) throw new CancelledError()
      let promptParts = contextParts
      const initialInput = formatPromptText(contextParts)
      let result: Awaited<ReturnType<typeof runOpenCodePrompt>> | undefined
      const maxStructuredRetries = normalizeStructuredRetryCount(runtimeOptions?.maxStructuredRetries)

      while (true) {
        if (budget.expired()) {
          throw new Error(PHASE_DEADLINE_ERROR)
        }

        promptReturned = false
        result = await runOpenCodePrompt({
          adapter,
          projectPath,
          parts: promptParts,
          signal: memberSignal,
          workBudget: budget,
          timeoutKind: 'ai_response',
          model: member.modelId,
          variant: member.variant,
          toolPolicy: runtimeOptions?.toolPolicy,
          ...(runtimeOptions?.ticketId && runtimeOptions.phase
            ? {
                sessionOwnership: {
                  ticketId: runtimeOptions.ticketId,
                  phase: runtimeOptions.phase,
                  phaseAttempt: runtimeOptions.phaseAttempt ?? 1,
                  memberId: member.modelId,
                },
              }
            : {}),
          onSessionCreated: (session) => {
            sessionId = session.id
            resolveSessionReady()
            if (closed) {
              throw new Error(`OpenCode session ${session.id} was created after the council deadline`)
            }

            onDraftProgress?.({
              memberId: member.modelId,
              status: 'session_created',
              sessionId,
            })
          },
          onStreamEvent: (event) => {
            if (closed || !sessionId) return
            onOpenCodeStreamEvent?.({
              stage: 'draft',
              memberId: member.modelId,
              sessionId,
              event,
            })
          },
          onPromptDispatched: (event) => {
            if (closed) return
            runtimeOptions?.onPromptDispatched?.({
              stage: 'draft',
              memberId: member.modelId,
              event,
            })
          },
        })

        if (closed || signal?.aborted || memberAbortController.signal.aborted) {
          if (signal?.aborted && !closed) throw new CancelledError()
          throw new Error(PHASE_DEADLINE_ERROR)
        }

        promptReturned = true
        content = result.response
        rawResponse = content

        onOpenCodeSessionLog?.({
          stage: 'draft',
          memberId: member.modelId,
          sessionId: result.session.id,
          response: content,
          messages: result.messages,
        })

        if (!validateDraft) {
          break
        }

        try {
          validation = validateDraft(content)
          const normalizedContent = validation.normalizedContent ?? content
          if (normalizedContent !== content) {
            normalizedResponse = normalizedContent
          }
          appendAcceptedRawAttempt(rawAttempts, {
            stage: 'draft',
            rawResponse: content,
            initialInput,
          })
          content = normalizedContent
          break
        } catch (error) {
          const validationError = getErrorMessage(error)
          lastValidationError = validationError
          const retryDecision = getStructuredRetryDecision(content, result.responseMeta)
          lastFailureClass = retryDecision.failureClass
          const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
            stage: 'draft',
            rawResponse: content,
            initialInput,
            validationError,
            failureClass: retryDecision.failureClass,
          })
          retryDiagnostics.push(resolveStructuredRetryDiagnostic({
            attempt: rawAttempt.attempt,
            rawResponse: content,
            validationError,
            failureClass: retryDecision.failureClass,
            error,
          }))
          if (attemptCount >= maxStructuredRetries) {
            throw error
          }
          attemptCount += 1
          promptParts = retryDecision.useStructuredRetryPrompt
            ? buildStructuredRetryPrompt(contextParts, {
                validationError,
                rawResponse: content,
                schemaReminder: runtimeOptions?.structuredRetrySchemaReminder,
              })
            : contextParts
        }
      }

      if (!validateDraft && rawResponse !== undefined && rawAttempts.length === 0) {
        appendAcceptedRawAttempt(rawAttempts, {
          stage: 'draft',
          rawResponse,
          initialInput,
        })
      }

      const steeredByOperator = wasMemberAnswered(
        runtimeOptions?.ticketId,
        runtimeOptions?.phase,
        runtimeOptions?.phaseAttempt ?? 1,
        member.modelId,
      )

      const draft: DraftResult = {
        memberId: member.modelId,
        outcome: 'completed',
        duration: Date.now() - startTime,
        content,
        ...(steeredByOperator ? { steeredByOperator } : {}),
        questionCount: validation?.questionCount,
        draftMetrics: validation?.draftMetrics,
        structuredOutput: buildStructuredOutput(),
        ...(typeof rawResponse === 'string' ? { rawResponse } : {}),
        ...(typeof normalizedResponse === 'string' ? { normalizedResponse } : {}),
        ...(rawAttempts.length > 0 ? { rawAttempts: [...rawAttempts] } : {}),
      }

      if (!recordResult(draft, sessionId)) {
        return draft
      }

      return draft
    })()
      .finally(() => {
        resolveExecutionSettled()
      })

    const ensureSessionStopped = async (): Promise<boolean> => {
      if (promptReturned) return true
      const findTrackedSession = () => sessionId ?? (
        runtimeOptions?.ticketId && runtimeOptions.phase
          ? sessionManager?.getOwnedActiveSession(runtimeOptions.ticketId, runtimeOptions.phase, {
              phaseAttempt: runtimeOptions.phaseAttempt ?? 1,
              memberId: member.modelId,
            })?.sessionId
          : undefined
      )
      let trackedSessionId = findTrackedSession()
      if (!trackedSessionId) {
        // A prompt can ignore its local abort signal. Give its session-create
        // callback a chance to publish the id, but never wait for the prompt
        // itself before attempting the remote stop.
        await Promise.race([sessionReady, executionSettled])
        trackedSessionId = findTrackedSession()
      }
      if (!trackedSessionId) return true
      sessionId = trackedSessionId
      return confirmCouncilSessionStopped(adapter, sessionManager, trackedSessionId, 'drafter')
    }

    // Re-armed from the budget rather than set once, so a question wait moves it
    // instead of expiring the member who is waiting for the answer. Cleared
    // outright while suspended: a timer re-set from the frozen remaining time
    // would still fire mid-wait.
    let unsubscribeBudget: (() => void) | undefined
    const deadlinePromise = budget.totalMs === undefined
      ? null
      : new Promise<never>((_, reject) => {
        const armRoundTimer = () => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle)
            timeoutHandle = undefined
          }
          if (closed || budget.suspended()) return
          timeoutHandle = setTimeout(() => {
            markTimedOut()
            reject(new Error(PHASE_DEADLINE_ERROR))
          }, Math.max(0, budget.remainingMs() ?? 0))
        }
        unsubscribeBudget = budget.onChange(armRoundTimer)
        armRoundTimer()
      })

    try {
      return deadlinePromise
        ? await Promise.race([executeDraft, deadlinePromise])
        : await executeDraft
    } catch (err) {
      const callerCancelled = signal?.aborted || (isAbortError(err) && signal?.aborted)
      if (callerCancelled || err instanceof CancelledError) {
        const stopped = await ensureSessionStopped()
        if (!stopped && sessionId) throw unconfirmedDraftStopError(sessionId)
        throw new CancelledError()
      }

      const duration = Date.now() - startTime
      if (isPhaseDeadlineError(err) || isAiResponseTimeoutError(err) || closed) {
        const stopped = await ensureSessionStopped()
        if (!stopped && sessionId) throw unconfirmedDraftStopError(sessionId)
        deadlineReached = true
        const draft: DraftResult = {
          memberId: member.modelId,
          content: '',
          outcome: 'timed_out',
          duration: timeout,
          error: `AI response timeout reached after ${timeout}ms`,
          questionCount: validation?.questionCount,
          draftMetrics: validation?.draftMetrics,
          structuredOutput: buildStructuredOutput(),
          ...(typeof rawResponse === 'string' ? { rawResponse } : {}),
          ...(typeof normalizedResponse === 'string' ? { normalizedResponse } : {}),
          ...(rawAttempts.length > 0 ? { rawAttempts: [...rawAttempts] } : {}),
        }
        recordResult(draft, sessionId)
        return draft
      }

      const preserveForContinuation = sessionId && runtimeOptions?.ticketId && runtimeOptions.phase
        ? shouldPreserveSessionForContinuation({
            error: err,
            sessionId,
            modelId: member.modelId,
            sessionOwnership: {
              ticketId: runtimeOptions.ticketId,
              phase: runtimeOptions.phase,
              phaseAttempt: runtimeOptions.phaseAttempt ?? 1,
              memberId: member.modelId,
            },
            signal: memberSignal,
          })
        : false
      if (!preserveForContinuation) {
        const stopped = await ensureSessionStopped()
        if (!stopped && sessionId) throw unconfirmedDraftStopError(sessionId)
      }

      const {
        outcome,
        errorDetail,
        failureClass,
      } = classifyDraftFailure(err, { content, failureClass: lastFailureClass })
      const draft: DraftResult = {
        memberId: member.modelId,
        content: '',
        outcome,
        duration,
        error: errorDetail,
        questionCount: validation?.questionCount,
        draftMetrics: validation?.draftMetrics,
        structuredOutput: buildStructuredOutput() ?? (
          failureClass
            ? {
                repairApplied: false,
                repairWarnings: [],
                autoRetryCount: attemptCount,
                failureClass,
              }
            : undefined
        ),
        ...(typeof rawResponse === 'string' ? { rawResponse } : {}),
        ...(typeof normalizedResponse === 'string' ? { normalizedResponse } : {}),
        ...(rawAttempts.length > 0 ? { rawAttempts: [...rawAttempts] } : {}),
      }
      recordResult(draft, sessionId)
      return draft
    } finally {
      unsubscribeBudget?.()
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
    }
  })

  const settled = await Promise.allSettled(promises)
  budget.release()
  if (signal?.aborted) {
    throw new CancelledError()
  }

  for (const result of settled) {
    if (result.status === 'rejected') {
      throw result.reason
    }
  }

  const drafts = members.map(member => results.get(member.modelId) ?? {
    memberId: member.modelId,
    content: '',
    outcome: 'timed_out' as const,
    duration: timeout,
    error: `AI response timeout reached after ${timeout}ms`,
  })

  return {
    drafts,
    memberOutcomes: buildMemberOutcomeMap(drafts),
    deadlineReached,
  }
}
