import type { OpenCodeAdapter } from '../opencode/adapter'
import type { DraftResult, RawAttempt } from './types'
import type { Message, PromptPart, StreamEvent } from '../opencode/types'
import type { OpenCodeToolPolicy } from '../opencode/toolPolicy'
import { formatPromptText, runOpenCodePrompt, type OpenCodePromptDispatchEvent } from '../workflow/runOpenCodePrompt'
import { buildStructuredRetryPrompt } from '../structuredOutput'
import { COUNCIL_RESPONSE_TIMEOUT_MS } from '../lib/constants'
import { getErrorMessage } from '@shared/typeGuards'
import { classifyStructuredFailureFromError, getStructuredRetryDecision } from '../lib/structuredOutputRetry'
import { normalizeStructuredRetryCount, shouldRetryStructuredOutput } from '../lib/structuredRetryPolicy'
import { appendAcceptedRawAttempt, appendRejectedRawAttempt } from '../lib/structuredRawAttempts'
import {
  attachOpenCodeBlockedErrorDiagnostics,
  buildOutputTruncatedBlockedErrorDiagnostics,
} from '../opencode/blockedErrorDiagnostics'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

export interface RefineDraftResult {
  content: string
  rawAttempts: RawAttempt[]
}

const RAW_ATTEMPTS_ERROR_KEY = '__loopTroopRawAttempts'

export const EMPTY_REFINEMENT_RESPONSE_ERROR = 'Refinement returned an empty response'

export function getRawAttemptsFromRefinementError(error: unknown): RawAttempt[] {
  if (!error || typeof error !== 'object') return []
  const rawAttempts = (error as Record<string, unknown>)[RAW_ATTEMPTS_ERROR_KEY]
  return Array.isArray(rawAttempts) ? rawAttempts.filter(isRawAttemptLike) : []
}

function isRawAttemptLike(value: unknown): value is RawAttempt {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as RawAttempt).attempt === 'number'
    && typeof (value as RawAttempt).stage === 'string'
    && ((value as RawAttempt).outcome === 'rejected' || (value as RawAttempt).outcome === 'accepted')
    && typeof (value as RawAttempt).rawResponse === 'string',
  )
}

function throwWithRawAttempts(error: unknown, rawAttempts: RawAttempt[]): never {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, RAW_ATTEMPTS_ERROR_KEY, {
      configurable: true,
      enumerable: false,
      value: [...rawAttempts],
    })
  }
  throw error
}

export async function refineDraft(
  adapter: OpenCodeAdapter,
  winnerDraft: DraftResult,
  losingDrafts: DraftResult[],
  contextParts: PromptPart[],
  projectPath: string,
  timeoutMs: number = COUNCIL_RESPONSE_TIMEOUT_MS,
  signal?: AbortSignal,
  onOpenCodeSessionLog?: (entry: {
    stage: 'draft' | 'vote' | 'refine'
    memberId: string
    sessionId: string
    response: string
    messages: Message[]
  }) => void,
  onOpenCodeStreamEvent?: (entry: {
    stage: 'refine'
    memberId: string
    sessionId: string
    event: StreamEvent
  }) => void,
  onOpenCodePromptDispatched?: (entry: {
    stage: 'refine'
    memberId: string
    event: OpenCodePromptDispatchEvent
  }) => void,
  sessionOwnership?: {
    ticketId: string
    // The workflow status the round runs in, not the council stage — the two
    // are both called "phase" in this file and mean different things.
    phase: WorkflowPhaseId
    phaseAttempt?: number
  },
  buildPrompt?: (winnerDraft: DraftResult, losingDrafts: DraftResult[]) => PromptPart[],
  validateResponse?: (content: string) => { normalizedContent?: string },
  schemaReminder?: string,
  buildRetryPrompt?: (params: {
    baseParts: PromptPart[]
    validationError: string
    rawResponse: string
  }) => PromptPart[],
  toolPolicy: OpenCodeToolPolicy = 'default',
  maxStructuredRetries: number = 1,
): Promise<RefineDraftResult> {
  let sessionId = ''
  const refineParts = buildPrompt
    ? buildPrompt(winnerDraft, losingDrafts)
    : [
        ...contextParts,
        {
          type: 'text' as const,
          content: [
            '## Winning Draft',
            winnerDraft.content,
            '',
            '## Alternative Drafts',
            ...losingDrafts.map((d, i) => `### Alternative ${i + 1} (model: ${d.memberId})\n${d.content}`),
          ].join('\n'),
        },
      ]
  let promptParts = refineParts
  const initialInput = formatPromptText(refineParts)
  let attemptCount = 0
  const normalizedMaxStructuredRetries = normalizeStructuredRetryCount(maxStructuredRetries)
  const rawAttempts: RawAttempt[] = []

  while (true) {
    let result: Awaited<ReturnType<typeof runOpenCodePrompt>>
    try {
      result = await runOpenCodePrompt({
        adapter,
        projectPath,
        parts: promptParts,
        signal,
        timeoutMs,
        timeoutKind: 'ai_response',
        model: winnerDraft.memberId,
        toolPolicy,
        ...(sessionOwnership
          ? {
              sessionOwnership: {
                ticketId: sessionOwnership.ticketId,
                phase: sessionOwnership.phase,
                phaseAttempt: sessionOwnership.phaseAttempt ?? 1,
                memberId: winnerDraft.memberId,
              },
            }
          : {}),
        onSessionCreated: (session) => {
          sessionId = session.id
        },
        onStreamEvent: (event) => {
          onOpenCodeStreamEvent?.({
            stage: 'refine',
            memberId: winnerDraft.memberId,
            sessionId,
            event,
          })
        },
        onPromptDispatched: (event) => {
          onOpenCodePromptDispatched?.({
            stage: 'refine',
            memberId: winnerDraft.memberId,
            event,
          })
        },
      })
    } catch (error) {
      appendRejectedRawAttempt(rawAttempts, {
        stage: 'refine',
        initialInput,
        validationError: getErrorMessage(error),
        failureClass: classifyStructuredFailureFromError(error),
      })
      throwWithRawAttempts(error, rawAttempts)
    }
    // Substituting the winner draft for an empty reply made a model that said
    // nothing look like a successful refine with no changes, so the retry never ran.
    const refined = result.response
    const messages: Message[] = result.messages

    onOpenCodeSessionLog?.({
      stage: 'refine',
      memberId: winnerDraft.memberId,
      sessionId: result.session.id,
      response: refined,
      messages,
    })

    const validation = ((): { ok: true; content: string } | { ok: false; error: unknown } => {
      if (!refined.trim()) {
        return { ok: false, error: new Error(EMPTY_REFINEMENT_RESPONSE_ERROR) }
      }
      if (!validateResponse) return { ok: true, content: refined }
      try {
        const validated = validateResponse(refined)
        return { ok: true, content: validated.normalizedContent ?? refined }
      } catch (error) {
        return { ok: false, error }
      }
    })()

    if (validation.ok) {
      appendAcceptedRawAttempt(rawAttempts, {
        stage: 'refine',
        rawResponse: refined,
        initialInput,
      })
      return { content: validation.content, rawAttempts }
    }

    const error = validation.error
    const validationError = getErrorMessage(error)
    const retryDecision = getStructuredRetryDecision(refined, result.responseMeta)
    appendRejectedRawAttempt(rawAttempts, {
      stage: 'refine',
      rawResponse: refined,
      initialInput,
      validationError,
      failureClass: retryDecision.failureClass,
    })
    if (!shouldRetryStructuredOutput(attemptCount, normalizedMaxStructuredRetries)) {
      const enrichedError = (() => {
        if (!(error instanceof Error) || retryDecision.failureClass !== 'output_truncated') return error
        const finishReason = result.responseMeta.latestStepFinishReason
        const tokens = result.responseMeta.latestStepFinishTokens
        return attachOpenCodeBlockedErrorDiagnostics(
          error,
          buildOutputTruncatedBlockedErrorDiagnostics({
            modelId: winnerDraft.memberId,
            sessionId: result.session.id,
            ...(finishReason ? { finishReason } : {}),
            ...(tokens ? { tokens } : {}),
          }),
        )
      })()
      throwWithRawAttempts(enrichedError, rawAttempts)
    }
    attemptCount += 1
    promptParts = buildRetryPrompt?.({
      baseParts: refineParts,
      validationError,
      rawResponse: refined,
    }) ?? buildStructuredRetryPrompt(refineParts, {
      validationError,
      rawResponse: refined,
      schemaReminder,
    })
  }
}
