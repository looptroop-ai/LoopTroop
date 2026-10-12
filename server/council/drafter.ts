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
import { forgetMemberAnswered, wasMemberAnswered } from '../workflow/questionWindows'
import { COUNCIL_RESPONSE_TIMEOUT_MS } from '../lib/constants'
import { PHASE_DEADLINE_ERROR, armAttemptDeadline, isPhaseDeadlineError, isAiResponseTimeoutError, classifyDraftFailure } from './draftUtils'
import { isAbortError } from '../lib/abort'
import { buildStructuredRetryPrompt } from '../structuredOutput'
import { getStructuredRetryDecision } from '../lib/structuredOutputRetry'
import { resolveStructuredRetryDiagnostic } from '../lib/structuredRetryDiagnostics'
import { normalizeStructuredRetryCount } from '../lib/structuredRetryPolicy'
import { appendAcceptedRawAttempt, appendRejectedRawAttempt } from '../lib/structuredRawAttempts'
import { getErrorMessage } from '@shared/typeGuards'
import { COUNCIL_MEMBER_STOPPED_ERROR } from '@shared/councilMembers'
import type { WorkflowPhaseId } from '@shared/workflowMeta'
import { SessionManager } from '../opencode/sessionManager'
import { shouldPreserveSessionForContinuation } from '../opencode/sessionContinuation'
import { stopCutShortCouncilSession } from './sessionStop'
import { CouncilMemberInterruptedError, openCouncilRound, type CouncilMemberAttempt } from './memberControl'

function unconfirmedDraftStopError(sessionId?: string): Error {
  return new Error(sessionId
    ? `Could not confirm abort of OpenCode session ${sessionId}`
    : 'Could not confirm abort of an OpenCode session that was still being created')
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

/** One member's attempt, with the session it reported under. */
interface DraftAttemptResult {
  draft: DraftResult
  sessionId: string | undefined
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
  // One budget for the round, shared by every member's first run. It is a
  // budget rather than a bare deadline so a question wait can hold it: the
  // round's own `Promise.race` timer never saw the prompt timer, so without this
  // a member blocked on a question would still lose its round to a timeout.
  const createBudget = () => createWorkBudget({
    ...(runtimeOptions?.ticketId ? { ticketId: runtimeOptions.ticketId } : {}),
    ...(timeout > 0 ? { totalMs: timeout } : {}),
    scope: 'council_member',
  })
  const budget = createBudget()
  const ownershipScope = runtimeOptions?.ticketId && runtimeOptions.phase
    ? {
        ticketId: runtimeOptions.ticketId,
        phase: runtimeOptions.phase,
        phaseAttempt: runtimeOptions.phaseAttempt ?? 1,
      }
    : null
  const sessionManager = ownershipScope ? new SessionManager(adapter) : null

  function recordResult(draft: DraftResult, sessionId?: string) {
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
  }

  const round = openCouncilRound<DraftAttemptResult>({
    ticketId: ownershipScope?.ticketId,
    phase: ownershipScope?.phase,
    memberIds: members.map((member) => member.modelId),
    signal,
    outcomeOf: (attempt) => attempt.draft.outcome,
    onSettled: (_memberId, attempt) => recordResult(attempt.draft, attempt.sessionId),
    onRestart: (memberId) => {
      results.delete(memberId)
      // The restarted draft starts without the answer the old one was given.
      if (ownershipScope) {
        forgetMemberAnswered(ownershipScope.ticketId, ownershipScope.phase, ownershipScope.phaseAttempt, memberId)
      }
      onDraftProgress?.({ memberId, status: 'restarted' })
    },
    // The live view must stop showing a member working once it has left the
    // round on an error; the round fails when the others settle.
    onFailed: (memberId, error) => recordResult({
      memberId,
      content: '',
      outcome: 'failed',
      duration: 0,
      error: getErrorMessage(error),
    }),
  })

  const draftMember = async (member: CouncilMember, attempt: CouncilMemberAttempt): Promise<DraftAttemptResult> => {
    // A restart is a fresh chance, so it gets the full timeout on its own clock
    // rather than whatever the round's shared one has left.
    const attemptBudget = attempt.number === 1 ? budget : createBudget()
    const startTime = Date.now()
    let sessionId: string | undefined
    let content = ''
    let validation: DraftValidationResult | undefined
    let lastValidationError: string | undefined
    let attemptCount = 0
    let closed = false
    let promptReturned = false
    const memberAbortController = new AbortController()
    const memberSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      memberAbortController.signal,
      attempt.signal,
    ])
    let resolveExecutionSettled: () => void = () => undefined
    const executionSettled = new Promise<void>((resolve) => {
      resolveExecutionSettled = resolve
    })
    let resolveSessionReady: () => void = () => undefined
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

    /** What this attempt saw before it ended, carried on every non-success draft. */
    const buildEvidence = () => ({
      questionCount: validation?.questionCount,
      draftMetrics: validation?.draftMetrics,
      ...(typeof rawResponse === 'string' ? { rawResponse } : {}),
      ...(typeof normalizedResponse === 'string' ? { normalizedResponse } : {}),
      ...(rawAttempts.length > 0 ? { rawAttempts: [...rawAttempts] } : {}),
    })

    const markTimedOut = () => {
      if (closed) return
      closed = true
      memberAbortController.abort()
    }

    const executeDraft = (async (): Promise<DraftResult> => {
      if (signal?.aborted) throw new CancelledError()
      let promptParts = contextParts
      const initialInput = formatPromptText(contextParts)
      let result: Awaited<ReturnType<typeof runOpenCodePrompt>> | undefined
      const maxStructuredRetries = normalizeStructuredRetryCount(runtimeOptions?.maxStructuredRetries)

      while (true) {
        if (attemptBudget.expired()) {
          throw new Error(PHASE_DEADLINE_ERROR)
        }

        promptReturned = false
        result = await runOpenCodePrompt({
          adapter,
          projectPath,
          parts: promptParts,
          signal: memberSignal,
          workBudget: attemptBudget,
          timeoutKind: 'ai_response',
          model: member.modelId,
          variant: member.variant,
          toolPolicy: runtimeOptions?.toolPolicy,
          ...(ownershipScope
            ? {
                sessionOwnership: {
                  ...ownershipScope,
                  memberId: member.modelId,
                  // A restart must not pick its abandoned predecessor back up.
                  ...(attempt.number > 1 ? { forceFresh: true } : {}),
                },
              }
            : {}),
          onSessionCreated: (session) => {
            sessionId = session.id
            resolveSessionReady()
            if (closed) {
              throw new Error(`OpenCode session ${session.id} was created after the member's council turn ended`)
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

        if (closed || memberSignal.aborted) {
          if (signal?.aborted && !closed) throw new CancelledError()
          const interruption = attempt.interruption()
          if (interruption) throw new CouncilMemberInterruptedError(interruption)
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

      return {
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
    })()
      .finally(() => {
        resolveExecutionSettled()
      })

    const ensureSessionStopped = async (): Promise<boolean> => {
      const memberScope = ownershipScope
        ? { phaseAttempt: ownershipScope.phaseAttempt, memberId: member.modelId }
        : null
      const stop = await stopCutShortCouncilSession({
        adapter,
        sessionManager,
        role: 'drafter',
        promptReturned,
        findSessionId: () => sessionId ?? (
          ownershipScope && memberScope
            ? sessionManager?.getOwnedActiveSession(ownershipScope.ticketId, ownershipScope.phase, memberScope)?.sessionId
            : undefined
        ),
        sessionReady,
        executionSettled,
        hasUnresolvedOwnership: () => Boolean(
          ownershipScope && memberScope
          && sessionManager?.hasUnresolvedSessionOwnershipForScope(ownershipScope.ticketId, ownershipScope.phase, memberScope),
        ),
      })
      if (stop.sessionId) sessionId = stop.sessionId
      return stop.stopped
    }

    const deadline = armAttemptDeadline(attemptBudget, () => closed, markTimedOut)

    try {
      const draft = await Promise.race([
        executeDraft,
        attempt.interrupted,
        ...(deadline.promise ? [deadline.promise] : []),
      ])
      return { draft, sessionId }
    } catch (err) {
      const callerCancelled = signal?.aborted || (isAbortError(err) && signal?.aborted)
      if (callerCancelled || err instanceof CancelledError) {
        const stopped = await ensureSessionStopped()
        if (!stopped) throw unconfirmedDraftStopError(sessionId)
        throw new CancelledError()
      }

      // A person's stop or restart wins over whatever reached the race first:
      // a deadline landing in the same moment still reads as the stop they asked
      // for, and a restart discards this attempt either way. Nothing the model
      // wrote is kept, earlier rejected attempts included.
      if (attempt.interruption()) {
        closed = true
        memberAbortController.abort()
        const stopped = await ensureSessionStopped()
        if (!stopped) throw unconfirmedDraftStopError(sessionId)
        return {
          draft: {
            memberId: member.modelId,
            content: '',
            outcome: 'stopped',
            duration: Date.now() - startTime,
            error: COUNCIL_MEMBER_STOPPED_ERROR,
          },
          sessionId,
        }
      }

      const duration = Date.now() - startTime
      if (isPhaseDeadlineError(err) || isAiResponseTimeoutError(err) || closed) {
        const stopped = await ensureSessionStopped()
        if (!stopped) throw unconfirmedDraftStopError(sessionId)
        return {
          draft: {
            memberId: member.modelId,
            content: '',
            outcome: 'timed_out',
            duration: timeout,
            error: `AI response timeout reached after ${timeout}ms`,
            structuredOutput: buildStructuredOutput(),
            ...buildEvidence(),
          },
          sessionId,
        }
      }

      const preserveForContinuation = sessionId && ownershipScope
        ? shouldPreserveSessionForContinuation({
            error: err,
            sessionId,
            modelId: member.modelId,
            sessionOwnership: {
              ...ownershipScope,
              memberId: member.modelId,
            },
            signal: memberSignal,
          })
        : false
      if (!preserveForContinuation) {
        const stopped = await ensureSessionStopped()
        if (!stopped) throw unconfirmedDraftStopError(sessionId)
      }

      const {
        outcome,
        errorDetail,
        failureClass,
      } = classifyDraftFailure(err, { content, failureClass: lastFailureClass })
      return {
        draft: {
          memberId: member.modelId,
          content: '',
          outcome,
          duration,
          error: errorDetail,
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
          ...buildEvidence(),
        },
        sessionId,
      }
    } finally {
      deadline.dispose()
      if (attemptBudget !== budget) attemptBudget.release()
    }
  }

  const promises = members.map((member) => round.run(member.modelId, (attempt) => draftMember(member, attempt)))
  const settled = await Promise.allSettled(promises)
  round.close()
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
    // From the outcomes that stand: a member that timed out and was then
    // restarted to a result did not leave the round at its deadline.
    deadlineReached: drafts.some((draft) => draft.outcome === 'timed_out'),
  }
}
