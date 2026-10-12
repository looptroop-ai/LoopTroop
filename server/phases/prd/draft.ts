import type { OpenCodeAdapter } from '../../opencode/adapter'
import type {
  CouncilMember,
  DraftPhaseResult,
  DraftProgressEvent,
  DraftResult,
  DraftStructuredOutputMeta,
  MemberOutcome,
  RawAttempt,
} from '../../council/types'
import { CancelledError } from '../../council/types'
import { armAttemptDeadline, classifyDraftFailure, isPhaseDeadlineError, PHASE_DEADLINE_ERROR } from '../../council/draftUtils'
import { isAbortError } from '../../lib/abort'
import { buildMinimalContext, clearContextCache, type TicketState } from '../../opencode/contextBuilder'
import type { OpenCodeToolPolicy } from '../../opencode/toolPolicy'
import type { Message, PromptPart, Session, StreamEvent } from '../../opencode/types'
import { SessionManager } from '../../opencode/sessionManager'
import { stopCutShortCouncilSession } from '../../council/sessionStop'
import {
  CouncilMemberInterruptedError,
  openCouncilRound,
  type CouncilMemberAttempt,
} from '../../council/memberControl'
import { COUNCIL_MEMBER_STOPPED_ERROR, type CouncilMemberRetryPart } from '@shared/councilMembers'
import { buildPromptFromTemplate, PROM10a, PROM10b, PROM11, PROM12 } from '../../prompts/index'
import type { OpenCodePromptDispatchEvent } from '../../workflow/runOpenCodePrompt'
import { formatPromptText, runOpenCodePrompt, runOpenCodeSessionPrompt } from '../../workflow/runOpenCodePrompt'
import { createWorkBudget, type WorkBudget } from '../../workflow/workBudget'
import { buildStructuredRetryPrompt, normalizeInterviewDocumentOutput } from '../../structuredOutput'
import { buildYamlDocument } from '../../structuredOutput/yamlUtils'
import { SKIP_REASON_PROMPT_MAX_LENGTH, truncateSkipReason } from '@shared/skipReceipt'
import { getStructuredRetryDecision } from '../../lib/structuredOutputRetry'
import { validatePrdDraft, validateResolvedInterview } from './validation'
import type { InterviewDocument } from '@shared/interviewArtifact'
import * as jsYaml from 'js-yaml'
import { resolveStructuredRetryDiagnostic } from '../../lib/structuredRetryDiagnostics'
import { normalizeStructuredRetryCount, shouldRetryStructuredOutput } from '../../lib/structuredRetryPolicy'
import { appendAcceptedRawAttempt, appendRejectedRawAttempt } from '../../lib/structuredRawAttempts'
import { getErrorMessage } from '@shared/typeGuards'

interface StepValidationResult {
  questionCount?: number
  draftMetrics?: DraftResult['draftMetrics']
  normalizedContent?: string
  repairApplied?: boolean
  repairWarnings?: string[]
}

interface StructuredStepSuccess {
  session: Session
  content: string
  rawResponse: string
  normalizedResponse?: string
  questionCount?: number
  draftMetrics?: DraftResult['draftMetrics']
  structuredOutput: DraftStructuredOutputMeta
  rawAttempts: RawAttempt[]
}

type PrdDraftSubstep = 'full_answers' | 'prd_draft'

const PRD_DRAFT_SKIPPED_AFTER_FULL_ANSWERS_ERROR = 'PRD draft not started because Full Answers did not pass validation'

class StructuredStepError extends Error {
  constructor(
    message: string,
    readonly content: string,
    readonly structuredOutput: DraftStructuredOutputMeta,
    readonly questionCount?: number,
    readonly draftMetrics?: DraftResult['draftMetrics'],
    readonly rawAttempts?: RawAttempt[],
  ) {
    super(message)
    this.name = 'StructuredStepError'
  }
}

async function stopPrdSession(
  adapter: OpenCodeAdapter,
  sessionManager: SessionManager | null,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  const stopped = sessionManager
    ? await sessionManager.abortAndAbandonSession(sessionId)
    : await adapter.abortSession(sessionId).catch((error) => {
        console.warn(`[prd] Failed to abort OpenCode session ${sessionId}:`, error)
        return false
      })
  if (!stopped) {
    if (signal?.aborted) throw new CancelledError()
    throw new Error(`Could not confirm abort of OpenCode session ${sessionId}`)
  }
}

/** What one member's attempt leaves: its Full Answers and its PRD draft. */
interface PrdMemberResult {
  fullAnswers: DraftResult
  prd: DraftResult
}

export interface PrdDraftPhaseResult extends DraftPhaseResult {
  fullAnswers: DraftResult[]
  fullAnswerOutcomes: Record<string, MemberOutcome>
}

export interface PrdDraftStepEvent {
  memberId: string
  step: PrdDraftSubstep
  status: 'started' | 'completed' | 'skipped' | 'failed'
  outcome?: MemberOutcome
  duration?: number
  error?: string
}

/** Build a context builder that returns PROM11 (vote) or PROM12 (refine) context. */
export function buildPrdContextBuilder(ticketState: TicketState) {
  return (step: 'vote' | 'refine'): PromptPart[] => {
    const template = step === 'vote' ? PROM11 : PROM12
    const contextPhase = step === 'vote' ? 'prd_vote' : 'prd_refine'
    return [{ type: 'text', content: buildPromptFromTemplate(template, buildMinimalContext(contextPhase, ticketState)) }]
  }
}

/** Build labeled prompt parts for PROM12 refinement. Labels Full Answers and drafts per-model. */
export function buildPrdRefinePrompt(
  ticketState: TicketState,
  winnerDraft: DraftResult,
  losingDrafts: DraftResult[],
  allFullAnswers: DraftResult[],
): PromptPart[] {
  const labeledFullAnswers = allFullAnswers
    .filter(fa => fa.outcome === 'completed' && fa.content)
    .map(fa => {
      const isWinner = fa.memberId === winnerDraft.memberId
      return [
        `## Full Answers — ${fa.memberId}${isWinner ? ' (Winner)' : ' (Alternative)'}`,
        fa.content,
      ].join('\n')
    })

  const labeledDrafts = [
    ['## Winning Draft', winnerDraft.content].join('\n'),
    ...losingDrafts.map((draft, index) => [
      `## Alternative Draft ${index + 1} (model: ${draft.memberId})`,
      draft.content,
    ].join('\n')),
  ]

  const refineContext = buildMinimalContext('prd_refine', {
    ...ticketState,
    fullAnswers: labeledFullAnswers,
    drafts: labeledDrafts,
  })
  return [{ type: 'text', content: buildPromptFromTemplate(PROM12, refineContext) }]
}

function buildPromptParts(template: typeof PROM10a | typeof PROM10b, contextParts: PromptPart[]): PromptPart[] {
  return [{ type: 'text', content: buildPromptFromTemplate(template, contextParts) }]
}

function stripGeneratedByForRetry(
  normalizedInterviewDocument: InterviewDocument,
): string {
  const { generated_by: _generatedBy, ...sanitized } = normalizedInterviewDocument
  return (jsYaml.dump({
    ...sanitized,
    // Reasons reach this model through the fenced side channel, never as part of
    // the artifact. Leaving them in the retry copy would hand it a field it has
    // been told not to write and would then have to be stripped back out.
    questions: sanitized.questions.map((question) => ({
      ...question,
      answer: { ...question.answer, skip_reason: undefined },
    })),
  }, { lineWidth: 120, noRefs: true, skipInvalid: true }) as string).trim()
}

/**
 * The one place a model is handed skip reasons.
 *
 * A separate fenced part rather than a field on the artifact. PROM10a invents
 * answers for skipped questions and currently does so blind, so it should see
 * why they were skipped — but `PROM4_FINAL_INTERVIEW_SCHEMA` stays untouched and
 * the answer-only recovery whitelist stays untouched, which means there is no
 * field for the model to write the reason back into and nothing to overwrite if
 * it tries.
 *
 * Truncated at {@link SKIP_REASON_PROMPT_MAX_LENGTH}: forty skipped questions at
 * the 20,000-character storage cap is a token bomb.
 */
function buildSkipReasonSideChannel(
  canonicalInterviewDocument: InterviewDocument,
): PromptPart | null {
  const entries = canonicalInterviewDocument.questions.flatMap((question) => {
    if (!question.answer.skipped) return []
    const { text, truncated } = truncateSkipReason(question.answer.skip_reason, SKIP_REASON_PROMPT_MAX_LENGTH)
    if (!text) return []
    return [{
      question_id: question.id,
      reason: text,
      ...(truncated ? { truncated: true } : {}),
    }]
  })
  if (entries.length === 0) return null

  return {
    type: 'text',
    source: 'skip_reasons',
    content: [
      '## Why These Questions Were Skipped',
      'The person who skipped these questions left a note explaining why. Use it to',
      'infer a better answer than you could otherwise. It is read-only context:',
      'there is no field for it in your output format, so do not echo it, do not',
      'copy it into `free_text`, and do not treat it as the answer itself.',
      'Questions not listed here were skipped without a reason.',
      '```yaml',
      buildYamlDocument(entries).trim(),
      '```',
    ].join('\n'),
  }
}

function buildFullAnswersRuntimeChecklist(
  canonicalInterviewDocument: InterviewDocument,
): PromptPart {
  const canonicalQuestionIds = canonicalInterviewDocument.questions.map((question) => question.id)
  const skippedQuestionIds = canonicalInterviewDocument.questions
    .filter((question) => question.answer.skipped)
    .map((question) => question.id)

  return {
    type: 'text',
    source: 'full_answers_runtime_checklist',
    content: [
      'Runtime checklist for this approved interview:',
      `canonical_question_count: ${canonicalQuestionIds.length}`,
      `canonical_question_ids: [${canonicalQuestionIds.join(', ')}]`,
      `skipped_question_ids: [${skippedQuestionIds.length > 0 ? skippedQuestionIds.join(', ') : 'none'}]`,
      'coverage_follow_up questions are canonical questions too and must not be omitted from the final artifact.',
    ].join('\n'),
  }
}

function buildFullAnswersRetryPrompt(
  baseParts: PromptPart[],
  options: {
    validationError: string
    rawResponse: string
    canonicalInterviewContent: string
    skippedQuestionIds: string[]
  },
): PromptPart[] {
  const skippedLabel = options.skippedQuestionIds.length > 0
    ? options.skippedQuestionIds.join(', ')
    : '[none]'

  return [
    ...baseParts,
    {
      type: 'text',
      content: [
        '## Full Answers Structured Output Retry',
        `Your previous response failed machine validation: ${options.validationError}`,
        'Return only a corrected full interview YAML artifact.',
        'Keep every generated free_text answer concise, ideally 1-2 sentences.',
        'For any `free_text` question with `answer.skipped: false`, `free_text` must be non-empty.',
        'If the final free-form question has nothing else to add, write a short explicit `free_text` response such as "Nothing else to add." instead of `""`.',
        'If an earlier answer makes a follow-up question not applicable, say that explicitly in `free_text`; never leave the follow-up blank.',
        'For single_choice and multiple_choice questions, `selected_option_ids` must still use the existing canonical option IDs.',
        'Treat single_choice and multiple_choice options as orientation only, not as the full answer: choose the best-fit canonical IDs when they help anchor the answer, and use concise `free_text` when nuance, caveats, or a better suggestion matter.',
        'If any free_text contains `:`, emit it as a quoted scalar or a `>-` block scalar.',
        'Keep `artifact` as the scalar value `interview`, not an object wrapper.',
        'Keep `generated_by` as a mapping with `winner_model`, `generated_at`, and `canonicalization`.',
        'Keep `follow_up_rounds`, `summary`, and `approval` as top-level blocks after `questions`, never nested under a question.',
        'Preserve the canonical `follow_up_rounds` and `summary` exactly as provided.',
        'Set `status: draft` and keep `approval.approved_by: ""` plus `approval.approved_at: ""`.',
        'If length is a concern, shorten generated answers instead of omitting later questions or trailing sections.',
        'Stop immediately after the final approval block. Do not append status text, fences, tool notes, or stray terminal characters.',
        `Only these skipped question answers may change: ${skippedLabel}`,
        'Allowed edits:',
        '- Only `questions[*].answer` for the skipped question IDs listed above.',
        '- For choice questions, populate `selected_option_ids` using the existing canonical option IDs.',
        'Forbidden edits:',
        '- Do not change question IDs, question order, prompts, phases, `answer_type`, or `options`.',
        '- Do not change any existing non-skipped answer.',
        '- Do not change `follow_up_rounds` or `summary`.',
        '- Do not set non-empty approval fields or keep `status: approved`.',
        '- Do not use markdown fences or wrap the artifact under another object.',
        'Canonical approved interview artifact (copy everything except the skipped question answers):',
        '```yaml',
        options.canonicalInterviewContent.trim() || '[empty canonical interview artifact]',
        '```',
        'Previous invalid response:',
        '```',
        options.rawResponse.trim() || '[empty response]',
        '```',
      ].join('\n\n'),
    },
  ]
}

function buildStructuredOutput(
  validation: StepValidationResult | undefined,
  lastValidationError: string | undefined,
  attemptCount: number,
  failureClass?: DraftStructuredOutputMeta['failureClass'],
  retryDiagnostics?: DraftStructuredOutputMeta['retryDiagnostics'],
): DraftStructuredOutputMeta {
  return {
    repairApplied: validation?.repairApplied ?? false,
    repairWarnings: validation?.repairWarnings ?? [],
    autoRetryCount: attemptCount,
    ...(lastValidationError ? { validationError: lastValidationError } : {}),
    ...(retryDiagnostics && retryDiagnostics.length > 0 ? { retryDiagnostics } : {}),
    ...(failureClass ? { failureClass } : {}),
  }
}

function buildFailedDraft(
  memberId: string,
  outcome: MemberOutcome,
  duration: number,
  error: string,
  content = '',
  questionCount?: number,
  draftMetrics?: DraftResult['draftMetrics'],
  structuredOutput?: DraftStructuredOutputMeta,
  rawResponse?: string,
  normalizedResponse?: string,
  rawAttempts?: RawAttempt[],
  skippedReason?: string,
): DraftResult {
  return {
    memberId,
    content,
    outcome,
    duration,
    error,
    questionCount,
    draftMetrics,
    structuredOutput,
    ...(typeof rawResponse === 'string' ? { rawResponse } : {}),
    ...(typeof normalizedResponse === 'string' ? { normalizedResponse } : {}),
    ...(rawAttempts && rawAttempts.length > 0 ? { rawAttempts: [...rawAttempts] } : {}),
    ...(skippedReason ? { skippedReason } : {}),
  }
}

function buildCompletedDraft(
  memberId: string,
  duration: number,
  content: string,
  questionCount?: number,
  draftMetrics?: DraftResult['draftMetrics'],
  structuredOutput?: DraftStructuredOutputMeta,
  rawResponse?: string,
  normalizedResponse?: string,
  rawAttempts?: RawAttempt[],
): DraftResult {
  return {
    memberId,
    content,
    outcome: 'completed',
    duration,
    questionCount,
    draftMetrics,
    structuredOutput,
    ...(typeof rawResponse === 'string' ? { rawResponse } : {}),
    ...(typeof normalizedResponse === 'string' ? { normalizedResponse } : {}),
    ...(rawAttempts && rawAttempts.length > 0 ? { rawAttempts: [...rawAttempts] } : {}),
  }
}

function buildSkippedPrdDraftAfterFullAnswers(memberId: string, fullAnswersOutcome: MemberOutcome): DraftResult {
  if (fullAnswersOutcome === 'stopped') {
    return buildFailedDraft(
      memberId,
      'stopped',
      0,
      'PRD draft not started because the model was stopped during Full Answers',
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'full_answers_invalid',
    )
  }

  if (fullAnswersOutcome === 'timed_out') {
    return buildFailedDraft(
      memberId,
      'timed_out',
      0,
      'PRD draft not started because Full Answers timed out',
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'full_answers_invalid',
    )
  }

  return buildFailedDraft(
    memberId,
    'invalid_output',
    0,
    PRD_DRAFT_SKIPPED_AFTER_FULL_ANSWERS_ERROR,
    '',
    undefined,
    undefined,
    {
      repairApplied: false,
      repairWarnings: [],
      autoRetryCount: 0,
      validationError: PRD_DRAFT_SKIPPED_AFTER_FULL_ANSWERS_ERROR,
      failureClass: 'validation_error',
    },
    undefined,
    undefined,
    undefined,
    'full_answers_invalid',
  )
}

function shouldRestartFullAnswersInFreshSession(validationError: string): boolean {
  const normalized = validationError.trim()
  if (!normalized) return false

  return [
    /^No resolved interview document content found$/i,
    /^Resolved interview must preserve all \d+ canonical questions\b/i,
    /^Resolved interview must preserve canonical question ids\b/i,
    /^Resolved interview is missing canonical question\b/i,
    /^Resolved interview left skipped question unanswered\b/i,
    /^Resolved interview is missing answered_at for AI-filled question\b/i,
  ].some((pattern) => pattern.test(normalized))
}

async function executeStructuredStep(
  adapter: OpenCodeAdapter,
  member: CouncilMember,
  projectPath: string,
  baseParts: PromptPart[],
  options: {
    step: PrdDraftSubstep
    signal?: AbortSignal
    ticketId?: string
    phaseAttempt?: number
    timeoutMs: number
    activeSession?: Session
    /** The phase-attempt budget. Spans both PROM10a and PROM10b. */
    budget: WorkBudget
    /** A restarted member opens new sessions rather than resuming abandoned ones. */
    forceFresh?: boolean
    toolPolicy: OpenCodeToolPolicy
    maxStructuredRetries?: number
    validateStep: (content: string) => StepValidationResult
    schemaReminder: string
    buildRetryPrompt?: (params: {
      baseParts: PromptPart[]
      validationError: string
      rawResponse: string
    }) => PromptPart[]
    onOpenCodeSessionLog?: (entry: {
      stage: 'draft' | 'vote' | 'refine'
      memberId: string
      sessionId: string
      response: string
      messages: Message[]
    }) => void
    onOpenCodeStreamEvent?: (entry: {
      stage: 'draft'
      memberId: string
      sessionId: string
      event: StreamEvent
    }) => void
    onOpenCodePromptDispatched?: (entry: {
      stage: 'draft'
      memberId: string
      event: OpenCodePromptDispatchEvent
    }) => void
    onSessionCreated?: (sessionId: string) => void
  },
): Promise<StructuredStepSuccess> {
  let session = options.activeSession
  let promptParts = baseParts
  const initialInput = formatPromptText(baseParts)
  let attemptCount = 0
  const maxStructuredRetries = normalizeStructuredRetryCount(options.maxStructuredRetries)
  let validation: StepValidationResult | undefined
  let lastValidationError: string | undefined
  let rawResponse = ''
  const rawAttempts: RawAttempt[] = []
  const retryDiagnostics: NonNullable<DraftStructuredOutputMeta['retryDiagnostics']> = []
  const sessionManager = options.ticketId ? new SessionManager(adapter) : null

  const sessionOwnership = options.ticketId
    ? {
        ticketId: options.ticketId,
        phase: 'DRAFTING_PRD' as const,
        phaseAttempt: options.phaseAttempt ?? 1,
        memberId: member.modelId,
        step: options.step,
        keepActive: true,
        ...(options.forceFresh ? { forceFresh: true } : {}),
      }
    : undefined

  while (true) {
    if (options.signal?.aborted) throw new CancelledError()

    if (options.budget.expired()) {
      throw new Error(PHASE_DEADLINE_ERROR)
    }

    const result = session
      ? await runOpenCodeSessionPrompt({
          adapter,
          session,
          parts: promptParts,
          signal: options.signal,
          workBudget: options.budget,
          timeoutKind: 'ai_response',
          model: member.modelId,
          variant: member.variant,
          toolPolicy: options.toolPolicy,
          onStreamEvent: (event) => {
            options.onOpenCodeStreamEvent?.({
              stage: 'draft',
              memberId: member.modelId,
              sessionId: session!.id,
              event,
            })
          },
          onPromptDispatched: (event) => {
            options.onOpenCodePromptDispatched?.({
              stage: 'draft',
              memberId: member.modelId,
              event,
            })
          },
        })
      : await runOpenCodePrompt({
          adapter,
          projectPath,
          parts: promptParts,
          signal: options.signal,
          workBudget: options.budget,
          timeoutKind: 'ai_response',
          model: member.modelId,
          variant: member.variant,
          toolPolicy: options.toolPolicy,
          ...(sessionOwnership ? { sessionOwnership } : {}),
          onSessionCreated: (createdSession) => {
            session = createdSession
            options.onSessionCreated?.(createdSession.id)
          },
          onStreamEvent: (event) => {
            if (!session) return
            options.onOpenCodeStreamEvent?.({
              stage: 'draft',
              memberId: member.modelId,
              sessionId: session.id,
              event,
            })
          },
          onPromptDispatched: (event) => {
            options.onOpenCodePromptDispatched?.({
              stage: 'draft',
              memberId: member.modelId,
              event,
            })
          },
        })

    session = result.session
    rawResponse = result.response
    options.onOpenCodeSessionLog?.({
      stage: 'draft',
      memberId: member.modelId,
      sessionId: result.session.id,
      response: result.response,
      messages: result.messages,
    })

    try {
      validation = options.validateStep(rawResponse)
      const content = validation.normalizedContent ?? rawResponse
      appendAcceptedRawAttempt(rawAttempts, {
        stage: options.step,
        rawResponse,
        initialInput,
      })
      return {
        session: result.session,
        content,
        rawResponse,
        ...(content !== rawResponse ? { normalizedResponse: content } : {}),
        questionCount: validation.questionCount,
        draftMetrics: validation.draftMetrics,
        structuredOutput: buildStructuredOutput(validation, lastValidationError, attemptCount, undefined, retryDiagnostics),
        rawAttempts: [...rawAttempts],
      }
    } catch (error) {
      lastValidationError = getErrorMessage(error)
      const baseRetryDecision = getStructuredRetryDecision(rawResponse, result.responseMeta)
      const retryDecision = options.step === 'full_answers'
        && baseRetryDecision.failureClass === 'validation_error'
        && shouldRestartFullAnswersInFreshSession(lastValidationError)
        ? {
            ...baseRetryDecision,
            reuseSession: false,
            useStructuredRetryPrompt: false,
          }
        : baseRetryDecision
      const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
        stage: options.step,
        rawResponse,
        initialInput,
        validationError: lastValidationError,
        failureClass: retryDecision.failureClass,
      })
      retryDiagnostics.push(resolveStructuredRetryDiagnostic({
        attempt: rawAttempt.attempt,
        rawResponse,
        validationError: lastValidationError,
        failureClass: retryDecision.failureClass,
        error,
      }))
      if (!shouldRetryStructuredOutput(attemptCount, maxStructuredRetries)) {
        throw new StructuredStepError(
          lastValidationError,
          rawResponse,
          buildStructuredOutput(validation, lastValidationError, attemptCount, retryDecision.failureClass, retryDiagnostics),
          validation?.questionCount,
          validation?.draftMetrics,
          [...rawAttempts],
        )
      }

      attemptCount += 1
      if (!retryDecision.reuseSession) {
        if (session) {
          await stopPrdSession(adapter, sessionManager, session.id, options.signal)
        }
        session = undefined
        promptParts = baseParts
        continue
      }

      promptParts = options.buildRetryPrompt?.({
        baseParts,
        validationError: lastValidationError,
        rawResponse,
      }) ?? buildStructuredRetryPrompt(baseParts, {
        validationError: lastValidationError,
        rawResponse,
        schemaReminder: options.schemaReminder,
      })
    }
  }
}

/** One member's result as the live artifacts receive it. */
function toFinishedProgress(memberId: string, draft: DraftResult, sessionId?: string): DraftProgressEvent {
  return {
    memberId,
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
  }
}

/** How one member's step ended without a usable result, from the error that ended it. */
function buildPrdMemberFailure(
  memberId: string,
  error: unknown,
  options: { stoppedByPerson: boolean; duration: number; timeoutMs: number },
): DraftResult {
  // A stop keeps nothing the model wrote, earlier rejected attempts included.
  if (options.stoppedByPerson) return buildFailedDraft(memberId, 'stopped', options.duration, COUNCIL_MEMBER_STOPPED_ERROR)
  const structuredError = error instanceof StructuredStepError ? error : null
  const errorContent = structuredError?.content ?? ''
  if (isPhaseDeadlineError(error) || (error instanceof Error && error.message === 'Timeout')) {
    return buildFailedDraft(
      memberId,
      'timed_out',
      options.timeoutMs,
      `AI response timeout reached after ${options.timeoutMs}ms`,
      '',
      structuredError?.questionCount,
      structuredError?.draftMetrics,
      structuredError?.structuredOutput,
      errorContent || undefined,
      undefined,
      structuredError?.rawAttempts,
    )
  }
  const { outcome, errorDetail, failureClass } = classifyDraftFailure(error, {
    content: errorContent,
    failureClass: structuredError?.structuredOutput.failureClass,
  })
  return buildFailedDraft(
    memberId,
    outcome,
    options.duration,
    errorDetail,
    '',
    structuredError?.questionCount,
    structuredError?.draftMetrics,
    structuredError?.structuredOutput ?? (
      failureClass ? buildStructuredOutput(undefined, undefined, 0, failureClass) : undefined
    ),
    errorContent || undefined,
    undefined,
    structuredError?.rawAttempts,
  )
}

export async function draftPRD(
  adapter: OpenCodeAdapter,
  members: CouncilMember[],
  ticketState: TicketState,
  projectPath: string,
  options: {
    draftTimeoutMs: number
    minQuorum: number
    maxStructuredRetries?: number
    ticketId?: string
    ticketExternalId?: string
    phaseAttempt?: number
  },
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
  onOpenCodePromptDispatched?: (entry: {
    stage: 'draft'
    memberId: string
    event: OpenCodePromptDispatchEvent
  }) => void,
  onDraftProgress?: (entry: DraftProgressEvent) => void,
  onFullAnswersProgress?: (entry: DraftProgressEvent) => void,
  onStepEvent?: (entry: PrdDraftStepEvent) => void,
): Promise<PrdDraftPhaseResult> {
  if (ticketState.ticketId) {
    clearContextCache(ticketState.ticketId)
  }

  const canonicalInterview = ticketState.interview ?? ''
  if (!canonicalInterview.trim()) {
    throw new Error('Canonical interview artifact is required before PRD drafting')
  }

  // One budget for the whole phase attempt. PROM10a's session is completed and
  // PROM10b runs in a fresh one, so a session-keyed clock could not span them —
  // and a question asked in the first step has to credit the second. A member a
  // person restarts gets a fresh one of its own with the full timeout.
  const createBudget = () => createWorkBudget({
    ...(options.ticketId ? { ticketId: options.ticketId } : {}),
    ...(options.draftTimeoutMs > 0 ? { totalMs: options.draftTimeoutMs } : {}),
    scope: 'phase_attempt',
  })
  const budget = createBudget()
  const canonicalInterviewResult = normalizeInterviewDocumentOutput(canonicalInterview, {
    ticketId: options.ticketExternalId ?? options.ticketId ?? '',
  })
  const canonicalInterviewForRetry = canonicalInterviewResult?.ok
    ? stripGeneratedByForRetry(canonicalInterviewResult.value)
    : canonicalInterview
  const skippedQuestionIds = canonicalInterviewResult?.ok
    ? canonicalInterviewResult.value.questions
      .filter((question) => question.answer.skipped)
      .map((question) => question.id)
    : []
  const shouldResolveGaps = skippedQuestionIds.length > 0
  const phaseAttempt = options.phaseAttempt ?? 1

  /**
   * A member's finished Full Answers, kept across a restart of its PRD draft.
   *
   * A restart from the PRD draft chip keeps them; one from the Full Answers chip,
   * or one while Full Answers was still unfinished, redoes both parts.
   */
  const keptFullAnswers = new Map<string, { result: DraftResult; resolvedInterviewContent: string }>()
  const keepsFullAnswers = (memberId: string, part: CouncilMemberRetryPart | undefined) => (
    part !== 'full_answers' && keptFullAnswers.has(memberId)
  )

  const round = openCouncilRound<PrdMemberResult>({
    ticketId: options.ticketId,
    phase: 'DRAFTING_PRD',
    memberIds: members.map((member) => member.modelId),
    signal,
    outcomeOf: (result) => result.prd.outcome,
    onRestart: (memberId, restart) => {
      if (!keepsFullAnswers(memberId, restart.part)) {
        keptFullAnswers.delete(memberId)
        onFullAnswersProgress?.({ memberId, status: 'restarted' })
      }
      onDraftProgress?.({ memberId, status: 'restarted' })
    },
    // The live view must stop showing a member working once it has left the
    // round on an error; the round fails when the others settle.
    onFailed: (memberId, error) => {
      const failed = buildFailedDraft(memberId, 'failed', 0, getErrorMessage(error))
      if (!keptFullAnswers.has(memberId)) onFullAnswersProgress?.(toFinishedProgress(memberId, failed))
      onDraftProgress?.(toFinishedProgress(memberId, failed))
    },
  })

  const draftMember = async (member: CouncilMember, attempt: CouncilMemberAttempt): Promise<PrdMemberResult> => {
    const memberStart = Date.now()
    const attemptBudget = attempt.number === 1 ? budget : createBudget()
    const memberSignal = signal ? AbortSignal.any([signal, attempt.signal]) : attempt.signal
    const sessionManager = options.ticketId ? new SessionManager(adapter) : null
    const kept = keepsFullAnswers(member.modelId, attempt.retryPart)
      ? keptFullAnswers.get(member.modelId)
      : undefined
    let currentSession: Session | undefined
    let fullAnswersResult: DraftResult | null = kept?.result ?? null
    let prdResult: DraftResult | null = null
    // Where the member is, and the session it most recently opened there, so a
    // stop can find what to close while a step is still running.
    let currentStep: PrdDraftSubstep = kept ? 'prd_draft' : 'full_answers'
    let stepSessionId: string | undefined
    // Set when the attempt's deadline beats the work, which a prompt that
    // ignores its abort signal would otherwise never let end.
    let timedOut = false
    let resolveSessionReady: () => void = () => undefined
    let sessionReady = new Promise<void>((resolve) => {
      resolveSessionReady = resolve
    })
    let resolveExecutionSettled: () => void = () => undefined
    const executionSettled = new Promise<void>((resolve) => {
      resolveExecutionSettled = resolve
    })

    const enterStep = (step: PrdDraftSubstep) => {
      currentStep = step
      stepSessionId = undefined
      sessionReady = new Promise<void>((resolve) => {
        resolveSessionReady = resolve
      })
    }

    /** Past a stop, a restart or the deadline, nothing this attempt does may reach the artifacts. */
    const throwIfInterrupted = () => {
      const interruption = attempt.interruption()
      if (interruption) throw new CouncilMemberInterruptedError(interruption)
      if (timedOut) throw new Error(PHASE_DEADLINE_ERROR)
    }

    const noteSessionCreated = (sessionId: string) => {
      stepSessionId = sessionId
      resolveSessionReady()
      // Thrown so the prompt runner stops the session it just opened: the
      // member's turn ended, or the ticket was canceled, while it was being
      // created, and nothing else will stop it.
      if (attempt.interruption() || timedOut || signal?.aborted) {
        throw new Error(`OpenCode session ${sessionId} was created after the member's council turn ended`)
      }
    }

    const stopCutShortSession = async () => {
      const ownership = { phaseAttempt, memberId: member.modelId, step: currentStep }
      return stopCutShortCouncilSession({
        adapter,
        sessionManager,
        role: 'drafter',
        // Each step's session stays open after its prompt returns, so there is
        // always something to look for.
        promptReturned: false,
        findSessionId: () => stepSessionId ?? (
          options.ticketId
            ? sessionManager?.getOwnedActiveSession(options.ticketId, 'DRAFTING_PRD', ownership)?.sessionId
            : undefined
        ),
        sessionReady,
        executionSettled,
        hasUnresolvedOwnership: () => Boolean(
          options.ticketId
          && sessionManager?.hasUnresolvedSessionOwnershipForScope(options.ticketId, 'DRAFTING_PRD', ownership),
        ),
      })
    }

    /** Stops the step's session; a stop OpenCode will not confirm fails the member. */
    const stopStepSession = async (): Promise<void> => {
      const stop = await stopCutShortSession()
      if (stop.stopped) return
      throw new Error(stop.sessionId
        ? `Could not confirm abort of OpenCode session ${stop.sessionId}`
        : 'Could not confirm abort of an OpenCode session that was still being created')
    }

    /** Records how the member's attempt ended without a PRD draft, and returns what stands. */
    const settleFailedMember = (error: unknown, step: PrdDraftSubstep, stoppedByPerson: boolean): PrdMemberResult => {
      if (!stoppedByPerson && (signal?.aborted || error instanceof CancelledError || (isAbortError(error) && signal?.aborted))) {
        throw new CancelledError()
      }
      const failed = buildPrdMemberFailure(member.modelId, error, {
        stoppedByPerson,
        duration: Date.now() - memberStart,
        timeoutMs: options.draftTimeoutMs,
      })
      const sessionId = currentSession?.id ?? stepSessionId
      onStepEvent?.({
        memberId: member.modelId,
        step,
        status: 'failed',
        outcome: failed.outcome,
        duration: failed.duration,
        error: failed.error,
      })

      // A stop throws away everything the model did in this step, finished Part 1
      // answers included, so nothing of a stopped model reaches the vote or the
      // refinement. A later retry then redoes both parts.
      if (stoppedByPerson) keptFullAnswers.delete(member.modelId)
      const answers = fullAnswersResult && !stoppedByPerson ? fullAnswersResult : failed
      if (answers !== fullAnswersResult) {
        fullAnswersResult = answers
        // A Part 2 session is not the one that wrote the answers being dropped.
        onFullAnswersProgress?.(toFinishedProgress(member.modelId, answers, step === 'full_answers' ? sessionId : undefined))
      }

      const draft = prdResult ?? (step === 'full_answers'
        ? buildSkippedPrdDraftAfterFullAnswers(member.modelId, failed.outcome)
        : failed)
      if (!prdResult) {
        prdResult = draft
        onDraftProgress?.(toFinishedProgress(member.modelId, draft, sessionId))
        if (step === 'full_answers') {
          onStepEvent?.({
            memberId: member.modelId,
            step: 'prd_draft',
            status: 'skipped',
            outcome: draft.outcome,
            duration: 0,
            error: draft.error,
          })
        }
      }
      return { fullAnswers: answers, prd: draft }
    }

    const pipeline = (async (): Promise<PrdMemberResult> => {
      let resolvedInterviewContent: string

      if (kept) {
        fullAnswersResult = kept.result
        resolvedInterviewContent = kept.resolvedInterviewContent
      } else if (shouldResolveGaps) {
        onStepEvent?.({ memberId: member.modelId, step: 'full_answers', status: 'started' })
        const skipReasonSideChannel = canonicalInterviewResult?.ok
          ? buildSkipReasonSideChannel(canonicalInterviewResult.value)
          : null
        const gapResolutionParts = buildPromptParts(
          PROM10a,
          [
            ...buildMinimalContext('prd_draft', {
              ...ticketState,
              fullAnswers: undefined,
            }),
            ...(canonicalInterviewResult?.ok
              ? [
                buildFullAnswersRuntimeChecklist(canonicalInterviewResult.value),
                ...(skipReasonSideChannel ? [skipReasonSideChannel] : []),
              ]
              : []),
          ],
        )

        const fullAnswersStep = await executeStructuredStep(adapter, member, projectPath, gapResolutionParts, {
          step: 'full_answers',
          signal: memberSignal,
          ticketId: options.ticketId,
          phaseAttempt: options.phaseAttempt,
          timeoutMs: options.draftTimeoutMs,
          activeSession: currentSession,
          budget: attemptBudget,
          forceFresh: attempt.number > 1,
          toolPolicy: PROM10a.toolPolicy,
          maxStructuredRetries: options.maxStructuredRetries,
          validateStep: (content) => {
            const result = validateResolvedInterview(content, {
              ticketId: options.ticketExternalId ?? options.ticketId ?? '',
              canonicalInterviewContent: canonicalInterview,
              memberId: member.modelId,
            })
            return {
              questionCount: result.questionCount,
              normalizedContent: result.normalizedContent,
              repairApplied: result.repairApplied,
              repairWarnings: result.repairWarnings,
            }
          },
          schemaReminder: PROM10a.outputFormat,
          buildRetryPrompt: ({ baseParts, validationError, rawResponse }) => buildFullAnswersRetryPrompt(baseParts, {
            validationError,
            rawResponse,
            canonicalInterviewContent: canonicalInterviewForRetry,
            skippedQuestionIds,
          }),
          onOpenCodeSessionLog,
          onOpenCodeStreamEvent,
          onOpenCodePromptDispatched,
          onSessionCreated: (sessionId) => {
            noteSessionCreated(sessionId)
            onFullAnswersProgress?.({
              memberId: member.modelId,
              status: 'session_created',
              sessionId,
            })
          },
        })

        throwIfInterrupted()
        currentSession = fullAnswersStep.session
        resolvedInterviewContent = fullAnswersStep.content
        fullAnswersResult = buildCompletedDraft(
          member.modelId,
          Date.now() - memberStart,
          fullAnswersStep.content,
          fullAnswersStep.questionCount,
          undefined,
          fullAnswersStep.structuredOutput,
          fullAnswersStep.rawResponse,
          fullAnswersStep.normalizedResponse,
          fullAnswersStep.rawAttempts,
        )
        keptFullAnswers.set(member.modelId, { result: fullAnswersResult, resolvedInterviewContent })
        onFullAnswersProgress?.({
          memberId: member.modelId,
          status: 'finished',
          sessionId: currentSession.id,
          outcome: 'completed',
          duration: fullAnswersResult.duration,
          content: fullAnswersResult.content,
          questionCount: fullAnswersResult.questionCount,
          structuredOutput: fullAnswersResult.structuredOutput,
          ...(typeof fullAnswersResult.rawResponse === 'string' ? { rawResponse: fullAnswersResult.rawResponse } : {}),
          ...(typeof fullAnswersResult.normalizedResponse === 'string' ? { normalizedResponse: fullAnswersResult.normalizedResponse } : {}),
          ...(fullAnswersResult.rawAttempts ? { rawAttempts: fullAnswersResult.rawAttempts } : {}),
        })
        onStepEvent?.({
          memberId: member.modelId,
          step: 'full_answers',
          status: 'completed',
          outcome: 'completed',
          duration: fullAnswersResult.duration,
        })

        if (currentSession && sessionManager) {
          await sessionManager.completeSession(currentSession.id)
        }
        currentSession = undefined
      } else {
        const syntheticFullAnswers = validateResolvedInterview(canonicalInterview, {
          ticketId: options.ticketExternalId ?? options.ticketId ?? '',
          canonicalInterviewContent: canonicalInterview,
          memberId: member.modelId,
        })
        resolvedInterviewContent = syntheticFullAnswers.normalizedContent
        fullAnswersResult = buildCompletedDraft(
          member.modelId,
          0,
          resolvedInterviewContent,
          syntheticFullAnswers.questionCount,
          undefined,
          {
            repairApplied: syntheticFullAnswers.repairApplied,
            repairWarnings: syntheticFullAnswers.repairWarnings,
            autoRetryCount: 0,
          },
        )
        keptFullAnswers.set(member.modelId, { result: fullAnswersResult, resolvedInterviewContent })
        onStepEvent?.({
          memberId: member.modelId,
          step: 'full_answers',
          status: 'skipped',
          outcome: 'completed',
        })
        onFullAnswersProgress?.({
          memberId: member.modelId,
          status: 'finished',
          outcome: 'completed',
          duration: 0,
          content: fullAnswersResult.content,
          questionCount: fullAnswersResult.questionCount,
          structuredOutput: fullAnswersResult.structuredOutput,
        })
      }

      throwIfInterrupted()
      enterStep('prd_draft')
      onStepEvent?.({ memberId: member.modelId, step: 'prd_draft', status: 'started' })
      const prdPromptParts = buildPromptParts(
        PROM10b,
        buildMinimalContext('prd_draft', {
          ...ticketState,
          interview: undefined,
          fullAnswers: [resolvedInterviewContent],
        }),
      )

      const prdStep = await executeStructuredStep(adapter, member, projectPath, prdPromptParts, {
        step: 'prd_draft',
        signal: memberSignal,
        ticketId: options.ticketId,
        phaseAttempt: options.phaseAttempt,
        timeoutMs: options.draftTimeoutMs,
        activeSession: currentSession,
        budget: attemptBudget,
        forceFresh: attempt.number > 1,
        toolPolicy: PROM10b.toolPolicy,
        maxStructuredRetries: options.maxStructuredRetries,
        validateStep: (content) => {
          const result = validatePrdDraft(content, {
            ticketId: options.ticketExternalId ?? options.ticketId ?? '',
            interviewContent: resolvedInterviewContent,
          })
          return {
            normalizedContent: result.normalizedContent,
            repairApplied: result.repairApplied,
            repairWarnings: result.repairWarnings,
            draftMetrics: result.metrics,
          }
        },
        schemaReminder: PROM10b.outputFormat,
        onOpenCodeSessionLog,
        onOpenCodeStreamEvent,
        onOpenCodePromptDispatched,
        onSessionCreated: (sessionId) => {
          noteSessionCreated(sessionId)
          onDraftProgress?.({
            memberId: member.modelId,
            status: 'session_created',
            sessionId,
          })
        },
      })

      throwIfInterrupted()
      currentSession = prdStep.session
      prdResult = buildCompletedDraft(
        member.modelId,
        Date.now() - memberStart,
        prdStep.content,
        undefined,
        prdStep.draftMetrics,
        prdStep.structuredOutput,
        prdStep.rawResponse,
        prdStep.normalizedResponse,
        prdStep.rawAttempts,
      )
      onDraftProgress?.({
        memberId: member.modelId,
        status: 'finished',
        sessionId: currentSession.id,
        outcome: 'completed',
        duration: prdResult.duration,
        content: prdResult.content,
        draftMetrics: prdResult.draftMetrics,
        structuredOutput: prdResult.structuredOutput,
        ...(typeof prdResult.rawResponse === 'string' ? { rawResponse: prdResult.rawResponse } : {}),
        ...(typeof prdResult.normalizedResponse === 'string' ? { normalizedResponse: prdResult.normalizedResponse } : {}),
        ...(prdResult.rawAttempts ? { rawAttempts: prdResult.rawAttempts } : {}),
      })
      onStepEvent?.({
        memberId: member.modelId,
        step: 'prd_draft',
        status: 'completed',
        outcome: 'completed',
        duration: prdResult.duration,
      })

      if (currentSession && sessionManager) {
        await sessionManager.completeSession(currentSession.id)
      }
      currentSession = undefined

      return {
        fullAnswers: fullAnswersResult,
        prd: prdResult,
      }
    })()
      .finally(() => {
        resolveExecutionSettled()
      })

    const deadline = armAttemptDeadline(attemptBudget, () => timedOut, () => {
      timedOut = true
    })

    try {
      return await Promise.race([pipeline, attempt.interrupted, ...(deadline.promise ? [deadline.promise] : [])])
    } catch (error) {
      // A person's stop or restart wins over whatever reached the race first,
      // unless the whole ticket is being canceled.
      const interruption = signal?.aborted ? null : attempt.interruption()
      if (interruption) {
        await stopStepSession()
        if (interruption === 'retry') {
          // Nothing is recorded: the round starts this member over at once.
          const discarded = buildFailedDraft(member.modelId, 'stopped', 0, COUNCIL_MEMBER_STOPPED_ERROR)
          return { fullAnswers: discarded, prd: discarded }
        }
        return settleFailedMember(error, fullAnswersResult ? 'prd_draft' : 'full_answers', true)
      }

      if (currentSession) {
        await stopPrdSession(adapter, sessionManager, currentSession.id, signal)
      } else if (!signal?.aborted) {
        // The step failed before handing its session back (structured retries
        // ran out, or its time did). Each step's session stays open after its
        // prompt, so stop the one it opened. A cancel stops every session itself.
        await stopStepSession()
      }
      return settleFailedMember(error, fullAnswersResult ? 'prd_draft' : 'full_answers', false)
    } finally {
      deadline.dispose()
      if (attemptBudget !== budget) attemptBudget.release()
    }
  }

  const settled = await Promise.allSettled(
    members.map((member) => round.run(member.modelId, (attempt) => draftMember(member, attempt))),
  )
  round.close()
  budget.release()
  if (signal?.aborted) {
    throw new CancelledError()
  }
  const results = settled.map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
  const fullAnswers = results.map((result) => result.fullAnswers)
  const drafts = results.map((result) => result.prd)

  return {
    phase: 'prd_draft',
    drafts,
    fullAnswers,
    memberOutcomes: drafts.reduce<Record<string, MemberOutcome>>((acc, draft) => {
      acc[draft.memberId] = draft.outcome
      return acc
    }, {}),
    fullAnswerOutcomes: fullAnswers.reduce<Record<string, MemberOutcome>>((acc, draft) => {
      acc[draft.memberId] = draft.outcome
      return acc
    }, {}),
    // From the outcomes that stand, so a member restarted after timing out does
    // not report a deadline the final round never hit.
    deadlineReached: [...drafts, ...fullAnswers].some((draft) => draft.outcome === 'timed_out'),
  }
}
