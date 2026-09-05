import type { OpenCodeAdapter } from '../../opencode/adapter'
import type { PromptPart, StreamEvent } from '../../opencode/types'
import { buildMinimalContext, type TicketState } from '../../opencode/contextBuilder'
import { buildConversationalPrompt, PROM4, PROM4_FINAL_INTERVIEW_SCHEMA } from '../../prompts/index'
import {
  runOpenCodePrompt,
  runOpenCodeSessionPrompt,
  type OpenCodePromptDispatchEvent,
} from '../../workflow/runOpenCodePrompt'
import { throwIfAborted } from '../../council/types'
import { throwIfCancelled } from '../../lib/abort'
import type { OpenCodeResponseMeta } from '../../opencode/assistantMessageAnalysis'
import {
  buildStructuredRetryPrompt,
  normalizeInterviewTurnOutput,
  type InterviewTurnOutput,
} from '../../structuredOutput'
import { calculateFollowUpLimit } from './followUpBudget'
import {
  COUNCIL_RESPONSE_TIMEOUT_MS,
  MAX_MULTIPLE_CHOICE_OPTIONS,
  MAX_SINGLE_CHOICE_OPTIONS,
} from '../../lib/constants'
import type { InterviewSessionSnapshot } from '@shared/interviewSession'
import { buildInterviewQuestionViews } from './sessionState'
import { SessionManager } from '../../opencode/sessionManager'
import { getStructuredRetryDecision } from '../../lib/structuredOutputRetry'
import { normalizeStructuredRetryCount } from '../../lib/structuredRetryPolicy'

export { calculateFollowUpLimit } from './followUpBudget'

export interface BatchQuestion {
  id: string
  question: string
  phase?: string
  priority?: string
  rationale?: string
  answerType?: 'free_text' | 'single_choice' | 'multiple_choice'
  options?: Array<{ id: string; label: string }>
}

export interface BatchResponse {
  questions: BatchQuestion[]
  progress: { current: number; total: number }
  isComplete: boolean
  isFinalFreeForm: boolean
  aiCommentary: string
  finalYaml?: string
  batchNumber: number
  sessionId?: string
}

const PROM4_SCHEMA_REMINDER = [
  'Return exactly one structured tag block and nothing else.',
  'If the interview should continue, return exactly one <INTERVIEW_BATCH>...</INTERVIEW_BATCH> block.',
  'Inside <INTERVIEW_BATCH>, return YAML with: batch_number, progress.current, progress.total, is_final_free_form, ai_commentary, questions[].',
  'Each question item must include: id, question, phase, priority, rationale.',
  `Each question item MUST include: answer_type (yes_no|single_choice|multiple_choice|free_text). Prefer structured types (yes_no, single_choice, multiple_choice) — use free_text only for genuinely open-ended questions. For single_choice, provide 2-${MAX_SINGLE_CHOICE_OPTIONS} options. For multiple_choice, provide 2-${MAX_MULTIPLE_CHOICE_OPTIONS} options. For yes_no, omit options. Options are objects with id and label fields.`,
  'If the interview is complete, return exactly one <INTERVIEW_COMPLETE>...</INTERVIEW_COMPLETE> block.',
  'Inside <INTERVIEW_COMPLETE>, return YAML with these exact top-level keys: schema_version, ticket_id, artifact, status, generated_by, questions, follow_up_rounds, summary, approval.',
  'Each `questions` item must include: id, phase, prompt, source, follow_up_round, answer_type, options, answer.',
  'Each `answer` item must include: skipped, selected_option_ids, free_text, answered_by, answered_at.',
  PROM4_FINAL_INTERVIEW_SCHEMA,
].join('\n')

function logInterviewTurnRepairWarnings(warnings: string[], ticketId?: string) {
  if (warnings.length === 0) return
  const label = ticketId
    ? `Interview batch normalization repairs applied for ticket ${ticketId}:`
    : 'Interview batch normalization repairs applied:'
  console.warn(label, warnings.join(' '))
}

function formatResumeQuestionLine(question: ReturnType<typeof buildInterviewQuestionViews>[number]): string {
  const status = question.status === 'answered'
    ? 'answered'
    : question.status === 'skipped'
      ? 'skipped'
      : 'pending'
  const detail = question.status === 'answered'
    ? question.answer?.trim() || '[empty answer]'
    : question.status === 'skipped'
      ? '[SKIPPED]'
      : question.question
  return `- ${question.id} (${status}) [${question.phase}]: ${detail}`
}

function buildInterviewResumePrompt(
  ticketState: TicketState,
  snapshot: InterviewSessionSnapshot,
): PromptPart[] {
  const contextParts = buildMinimalContext('interview_qa', ticketState)
  const prompt = buildConversationalPrompt(PROM4, contextParts)
  const questionViews = buildInterviewQuestionViews(snapshot)
  const answeredQuestions = questionViews
    .filter((question) => question.status === 'answered' || question.status === 'skipped')
    .map((question) => formatResumeQuestionLine(question))
  const pendingQuestions = questionViews
    .filter((question) => question.status === 'pending' || question.status === 'current')
    .map((question) => formatResumeQuestionLine(question))

  return [{
    type: 'text',
    content: [
      prompt,
      '',
      '## Resume Existing Interview Session',
      'The previous session failed to return a usable structured response.',
      'Continue the interview from this normalized state and return only the next structured artifact.',
      `max_initial_questions: ${snapshot.maxInitialQuestions}`,
      `max_follow_ups: ${snapshot.maxFollowUps}`,
      '',
      'Answered or skipped questions:',
      answeredQuestions.length > 0 ? answeredQuestions.join('\n') : '[none]',
      '',
      'Pending questions:',
      pendingQuestions.length > 0 ? pendingQuestions.join('\n') : '[none]',
      '',
      'Do not re-ask answered or skipped questions unless a new follow-up is genuinely required.',
      'Return only the next <INTERVIEW_BATCH> or the final <INTERVIEW_COMPLETE> artifact.',
    ].join('\n'),
  }]
}

/**
 * Start a new PROM4 interview session with the winning AI model.
 * Creates an OpenCode session, sends the initial prompt with compiled questions,
 * and returns the first batch of questions from the AI.
 */
export async function startInterviewSession(
  adapter: OpenCodeAdapter,
  projectPath: string,
  winnerId: string,
  compiledQuestions: string,
  ticketState: TicketState,
  maxQuestions: number,
  followUpBudgetPercent: number,
  signal?: AbortSignal,
  onOpenCodeStreamEvent?: (entry: { sessionId: string; event: StreamEvent }) => void,
  onPromptDispatched?: (entry: { sessionId: string; event: OpenCodePromptDispatchEvent }) => void,
  ticketId?: string,
  timeoutMs: number = COUNCIL_RESPONSE_TIMEOUT_MS,
  structuredRetryCount?: number,
): Promise<{ sessionId: string; firstBatch: BatchResponse }> {
  const contextParts = buildMinimalContext('interview_qa', ticketState)
  const prompt = buildConversationalPrompt(PROM4, contextParts)

  const fullPrompt = [
    prompt,
    '',
    `## Configuration`,
    `max_initial_questions: ${maxQuestions}`,
    `coverage_follow_up_budget_percent: ${followUpBudgetPercent}`,
    `max_follow_ups: ${calculateFollowUpLimit(maxQuestions, followUpBudgetPercent)}`,
    '',
    `## Compiled Questions (from council)`,
    compiledQuestions,
    '',
    `Begin the interview now. Treat the compiled questions above as your working interview checklist and present the first batch of questions.`,
  ].join('\n')

  let sessionId = ''
  const sessionManager = ticketId ? new SessionManager(adapter) : null
  throwIfAborted(signal)
  let result: Awaited<ReturnType<typeof runOpenCodePrompt>>
  try {
    result = await runOpenCodePrompt({
      adapter,
      projectPath,
      parts: [{ type: 'text', content: fullPrompt }] as PromptPart[],
      signal,
      timeoutMs,
      timeoutKind: 'ai_response',
      model: winnerId,
      toolPolicy: PROM4.toolPolicy,
      ...(ticketId
        ? {
            sessionOwnership: {
              ticketId,
              phase: 'WAITING_INTERVIEW_ANSWERS',
              memberId: winnerId,
              keepActive: true,
            },
          }
        : {}),
      onSessionCreated: (session) => {
        sessionId = session.id
      },
      onStreamEvent: (event) => {
        onOpenCodeStreamEvent?.({
          sessionId,
          event,
        })
      },
      onPromptDispatched: (event) => {
        onPromptDispatched?.({
          sessionId: event.session.id,
          event,
        })
      },
    })
  } catch (error) {
    throwIfCancelled(error, signal)
    throw error
  }

  throwIfAborted(signal)
  const firstBatch = await parseBatchResponseWithRetry({
    adapter,
    sessionId: result.session.id,
    response: result.response,
    responseMeta: result.responseMeta,
    signal,
    timeoutMs,
    model: winnerId,
    onOpenCodeStreamEvent,
    onPromptDispatched,
    ticketId,
    structuredRetryCount,
    restartSession: async (currentSessionId) => {
      if (sessionManager) {
        await sessionManager.abandonSession(currentSessionId)
      }
      const restarted = await runOpenCodePrompt({
        adapter,
        projectPath,
        parts: [{ type: 'text', content: fullPrompt }] as PromptPart[],
        signal,
        timeoutMs,
        timeoutKind: 'ai_response',
        model: winnerId,
        toolPolicy: PROM4.toolPolicy,
        ...(ticketId
          ? {
              sessionOwnership: {
                ticketId,
                phase: 'WAITING_INTERVIEW_ANSWERS',
                memberId: winnerId,
                keepActive: true,
              },
            }
          : {}),
        onSessionCreated: (session) => {
          sessionId = session.id
        },
        onStreamEvent: (event) => {
          onOpenCodeStreamEvent?.({
            sessionId,
            event,
          })
        },
        onPromptDispatched: (event) => {
          onPromptDispatched?.({
            sessionId: event.session.id,
            event,
          })
        },
      })
      return { sessionId: restarted.session.id, response: restarted.response, responseMeta: restarted.responseMeta }
    },
  })
  return { sessionId: firstBatch.sessionId ?? result.session.id, firstBatch }
}

/**
 * Submit a batch of user answers to an existing PROM4 session.
 * Formats answers as a message and sends to the AI for processing.
 */
export async function submitBatchToSession(
  adapter: OpenCodeAdapter,
  sessionId: string,
  batchAnswers: Record<string, string>,
  signal?: AbortSignal,
  model?: string,
  onOpenCodeStreamEvent?: (entry: { sessionId: string; event: StreamEvent }) => void,
  onPromptDispatched?: (entry: { sessionId: string; event: OpenCodePromptDispatchEvent }) => void,
  ticketId?: string,
  timeoutMs: number = COUNCIL_RESPONSE_TIMEOUT_MS,
  restartOptions?: {
    projectPath: string
    ticketState: TicketState
    snapshot: InterviewSessionSnapshot
  },
  structuredRetryCount?: number,
): Promise<BatchResponse> {
  const answerLines = Object.entries(batchAnswers).map(([id, answer]) => {
    const text = answer.trim() || '[SKIPPED]'
    return `${id}: ${text}`
  })

  const message = [
    `Here are my answers:`,
    '',
    ...answerLines,
    '',
    `Please continue with the next batch of questions, or finalize the interview if complete.`,
  ].join('\n')

  throwIfAborted(signal)
  const sessionManager = ticketId ? new SessionManager(adapter) : null
  let result: Awaited<ReturnType<typeof runOpenCodeSessionPrompt>>
  try {
    result = await runOpenCodeSessionPrompt({
      adapter,
      session: { id: sessionId },
      parts: [{ type: 'text', content: message }] as PromptPart[],
      signal,
      timeoutMs,
      timeoutKind: 'ai_response',
      model,
      toolPolicy: PROM4.toolPolicy,
      onStreamEvent: (event) => {
        onOpenCodeStreamEvent?.({
          sessionId,
          event,
        })
      },
      onPromptDispatched: (event) => {
        onPromptDispatched?.({
          sessionId: event.session.id,
          event,
        })
      },
    })
  } catch (error) {
    throwIfCancelled(error, signal)
    throw error
  }

  throwIfAborted(signal)
  return await parseBatchResponseWithRetry({
    adapter,
    sessionId,
    response: result.response,
    responseMeta: result.responseMeta,
    signal,
    timeoutMs,
    model,
    onOpenCodeStreamEvent,
    onPromptDispatched,
    ticketId,
    structuredRetryCount,
    restartSession: restartOptions
      ? async (currentSessionId) => {
          if (sessionManager) {
            await sessionManager.abandonSession(currentSessionId)
          }
          const restarted = await runOpenCodePrompt({
            adapter,
            projectPath: restartOptions.projectPath,
            parts: buildInterviewResumePrompt(restartOptions.ticketState, restartOptions.snapshot),
            signal,
            timeoutMs,
            timeoutKind: 'ai_response',
            model,
            toolPolicy: PROM4.toolPolicy,
            ...(ticketId
              ? {
                  sessionOwnership: {
                    ticketId,
                    phase: 'WAITING_INTERVIEW_ANSWERS',
                    memberId: model,
                    keepActive: true,
                  },
                }
              : {}),
            onStreamEvent: (event) => {
              onOpenCodeStreamEvent?.({
                sessionId: event.sessionId,
                event,
              })
            },
            onPromptDispatched: (event) => {
              onPromptDispatched?.({
                sessionId: event.session.id,
                event,
              })
            },
          })
          return { sessionId: restarted.session.id, response: restarted.response, responseMeta: restarted.responseMeta }
        }
      : undefined,
  })
}

function toBatchResponse(output: InterviewTurnOutput): BatchResponse {
  if (output.kind === 'complete') {
    return {
      questions: [],
      progress: { current: 0, total: 0 },
      isComplete: true,
      isFinalFreeForm: false,
      aiCommentary: 'Interview complete.',
      finalYaml: output.finalYaml.trim(),
      batchNumber: -1,
    }
  }

  return {
    questions: output.batch.questions.map((question) => ({
      id: question.id,
      question: question.question,
      phase: question.phase,
      priority: question.priority,
      rationale: question.rationale,
      ...(question.answerType ? { answerType: question.answerType } : {}),
      ...(question.options && question.options.length > 0 ? { options: question.options } : {}),
    })),
    progress: output.batch.progress,
    isComplete: false,
    isFinalFreeForm: output.batch.isFinalFreeForm,
    aiCommentary: output.batch.aiCommentary,
    batchNumber: output.batch.batchNumber,
  }
}

async function parseBatchResponseWithRetry(input: {
  adapter: OpenCodeAdapter
  sessionId: string
  response: string
  responseMeta?: OpenCodeResponseMeta
  signal?: AbortSignal
  timeoutMs?: number
  model?: string
  onOpenCodeStreamEvent?: (entry: { sessionId: string; event: StreamEvent }) => void
  onPromptDispatched?: (entry: { sessionId: string; event: OpenCodePromptDispatchEvent }) => void
  ticketId?: string
  structuredRetryCount?: number
  restartSession?: (currentSessionId: string) => Promise<{ sessionId: string; response: string; responseMeta?: OpenCodeResponseMeta }>
}): Promise<BatchResponse> {
  const structuredRetryCount = normalizeStructuredRetryCount(input.structuredRetryCount)
  let response = input.response
  let responseMeta = input.responseMeta
  let sessionId = input.sessionId
  let lastError = 'Unknown PROM4 validation error'

  for (let attempt = 0; attempt <= structuredRetryCount; attempt += 1) {
    const normalized = normalizeInterviewTurnOutput(response)
    if (normalized.ok) {
      logInterviewTurnRepairWarnings(normalized.repairWarnings, input.ticketId)
      return {
        ...toBatchResponse(normalized.value),
        ...(sessionId !== input.sessionId ? { sessionId } : {}),
      }
    }

    lastError = normalized.error
    if (attempt >= structuredRetryCount) {
      break
    }

    const retryDecision = getStructuredRetryDecision(response, responseMeta)
    if (!retryDecision.reuseSession) {
      if (!input.restartSession) {
        throw new Error(`PROM4 output failed validation without a recoverable session: ${normalized.error}`)
      }

      const restarted = await input.restartSession(sessionId)
      throwIfAborted(input.signal)
      sessionId = restarted.sessionId
      response = restarted.response
      responseMeta = restarted.responseMeta
      continue
    }

    const retryParts = buildStructuredRetryPrompt([], {
      validationError: normalized.error,
      rawResponse: response,
      schemaReminder: PROM4_SCHEMA_REMINDER,
    })

    try {
      const retryResult = await runOpenCodeSessionPrompt({
        adapter: input.adapter,
        session: { id: sessionId },
        parts: retryParts,
        signal: input.signal,
        timeoutMs: input.timeoutMs ?? COUNCIL_RESPONSE_TIMEOUT_MS,
        timeoutKind: 'ai_response',
        model: input.model,
        toolPolicy: PROM4.toolPolicy,
        onStreamEvent: (event) => {
          input.onOpenCodeStreamEvent?.({
            sessionId,
            event,
          })
        },
        onPromptDispatched: (event) => {
          input.onPromptDispatched?.({
            sessionId: event.session.id,
            event,
          })
        },
      })
      throwIfAborted(input.signal)
      response = retryResult.response
      responseMeta = retryResult.responseMeta
    } catch (error) {
      throwIfCancelled(error, input.signal)
      throw error
    }
  }

  throw new Error(`PROM4 output failed validation after ${structuredRetryCount} structured retry attempt(s): ${lastError}`)
}
