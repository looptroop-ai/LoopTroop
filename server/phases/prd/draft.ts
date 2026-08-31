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
import { classifyDraftFailure, isPhaseDeadlineError, PHASE_DEADLINE_ERROR } from '../../council/draftUtils'
import { isAbortError } from '../../lib/abort'
import { buildMinimalContext, clearContextCache, type TicketState } from '../../opencode/contextBuilder'
import type { OpenCodeToolPolicy } from '../../opencode/toolPolicy'
import type { Message, PromptPart, Session, StreamEvent } from '../../opencode/types'
import { SessionManager } from '../../opencode/sessionManager'
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
        phase: 'DRAFTING_PRD',
        phaseAttempt: options.phaseAttempt ?? 1,
        memberId: member.modelId,
        step: options.step,
        keepActive: true,
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
        if (sessionManager && session) {
          await sessionManager.abandonSession(session.id)
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
  // and a question asked in the first step has to credit the second.
  const budget = createWorkBudget({
    ...(options.ticketId ? { ticketId: options.ticketId } : {}),
    ...(options.draftTimeoutMs > 0 ? { totalMs: options.draftTimeoutMs } : {}),
    scope: 'phase_attempt',
  })
  let deadlineReached = false
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

  const results = await Promise.all(members.map(async (member) => {
    const memberStart = Date.now()
    const sessionManager = options.ticketId ? new SessionManager(adapter) : null
    let currentSession: Session | undefined
    let fullAnswersResult: DraftResult | null = null
    let prdResult: DraftResult | null = null

    const emitFailedResult = (error: unknown, step: 'full_answers' | 'prd_draft') => {
      if (signal?.aborted || error instanceof CancelledError || (isAbortError(error) && signal?.aborted)) {
        throw new CancelledError()
      }

      const duration = Date.now() - memberStart
      const timedOut = isPhaseDeadlineError(error) || (error instanceof Error && error.message === 'Timeout')
      if (timedOut) deadlineReached = true
      const timedOutDuration = options.draftTimeoutMs
      const structuredError = error instanceof StructuredStepError ? error : null
      const errorContent = structuredError?.content ?? ''
      const errorRawAttempts = structuredError?.rawAttempts

      const failed = timedOut
        ? buildFailedDraft(
            member.modelId,
            'timed_out',
            timedOutDuration,
            `AI response timeout reached after ${options.draftTimeoutMs}ms`,
            '',
            structuredError?.questionCount,
            structuredError?.draftMetrics,
            structuredError?.structuredOutput,
            errorContent || undefined,
            undefined,
            errorRawAttempts,
          )
        : (() => {
            const {
              outcome,
              errorDetail,
              failureClass,
            } = classifyDraftFailure(error, {
              content: errorContent,
              failureClass: structuredError?.structuredOutput.failureClass,
            })
            const structuredOutput = structuredError?.structuredOutput ?? (
              failureClass
                ? buildStructuredOutput(undefined, undefined, 0, failureClass)
                : undefined
            )
            return buildFailedDraft(
              member.modelId,
              outcome,
              duration,
              errorDetail,
              '',
              structuredError?.questionCount,
              structuredError?.draftMetrics,
              structuredOutput,
              errorContent || undefined,
              undefined,
              errorRawAttempts,
            )
          })()

      onStepEvent?.({
        memberId: member.modelId,
        step,
        status: 'failed',
        outcome: failed.outcome,
        duration: failed.duration,
        error: failed.error,
      })

      if (!fullAnswersResult) {
        fullAnswersResult = failed
        onFullAnswersProgress?.({
          memberId: member.modelId,
          status: 'finished',
          sessionId: currentSession?.id,
          outcome: fullAnswersResult.outcome,
          duration: fullAnswersResult.duration,
          error: fullAnswersResult.error,
          content: fullAnswersResult.content,
          questionCount: fullAnswersResult.questionCount,
          structuredOutput: fullAnswersResult.structuredOutput,
          ...(typeof fullAnswersResult.rawResponse === 'string' ? { rawResponse: fullAnswersResult.rawResponse } : {}),
          ...(typeof fullAnswersResult.normalizedResponse === 'string' ? { normalizedResponse: fullAnswersResult.normalizedResponse } : {}),
          ...(fullAnswersResult.rawAttempts ? { rawAttempts: fullAnswersResult.rawAttempts } : {}),
          ...(fullAnswersResult.skippedReason ? { skippedReason: fullAnswersResult.skippedReason } : {}),
        })
      }

      if (!prdResult) {
        prdResult = step === 'full_answers'
          ? buildSkippedPrdDraftAfterFullAnswers(member.modelId, failed.outcome)
          : failed
        onDraftProgress?.({
          memberId: member.modelId,
          status: 'finished',
          sessionId: currentSession?.id,
          outcome: prdResult.outcome,
          duration: prdResult.duration,
          error: prdResult.error,
          content: prdResult.content,
          questionCount: prdResult.questionCount,
          draftMetrics: prdResult.draftMetrics,
          structuredOutput: prdResult.structuredOutput,
          ...(typeof prdResult.rawResponse === 'string' ? { rawResponse: prdResult.rawResponse } : {}),
          ...(typeof prdResult.normalizedResponse === 'string' ? { normalizedResponse: prdResult.normalizedResponse } : {}),
          ...(prdResult.rawAttempts ? { rawAttempts: prdResult.rawAttempts } : {}),
          ...(prdResult.skippedReason ? { skippedReason: prdResult.skippedReason } : {}),
        })
        if (step === 'full_answers') {
          onStepEvent?.({
            memberId: member.modelId,
            step: 'prd_draft',
            status: 'skipped',
            outcome: prdResult.outcome,
            duration: 0,
            error: prdResult.error,
          })
        }
      }
    }

    try {
      let resolvedInterviewContent: string

      if (shouldResolveGaps) {
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
          signal,
          ticketId: options.ticketId,
          phaseAttempt: options.phaseAttempt,
          timeoutMs: options.draftTimeoutMs,
          activeSession: currentSession,
          budget,
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
            onFullAnswersProgress?.({
              memberId: member.modelId,
              status: 'session_created',
              sessionId,
            })
          },
        })

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
        signal,
        ticketId: options.ticketId,
        phaseAttempt: options.phaseAttempt,
        timeoutMs: options.draftTimeoutMs,
        activeSession: currentSession,
        budget,
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
          onDraftProgress?.({
            memberId: member.modelId,
            status: 'session_created',
            sessionId,
          })
        },
      })

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
    } catch (error) {
      try {
        if (currentSession && sessionManager) {
          await sessionManager.abandonSession(currentSession.id)
        }
      } catch {
        // Best effort cleanup only.
      }

      const failedStep = fullAnswersResult ? 'prd_draft' : 'full_answers'
      emitFailedResult(error, failedStep)
      return {
        fullAnswers: fullAnswersResult!,
        prd: prdResult!,
      }
    }
  }))

  budget.release()
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
    deadlineReached,
  }
}
