import type { Message, StepFinishMessagePart } from '../opencode/types'
import type { OpenCodePromptCompletedEvent, OpenCodeSessionOwnership } from '../workflow/runOpenCodePrompt'
import { broadcaster } from '../sse/broadcaster'
import { ticketAiTurnMetrics } from '../db/schema'
import { getTicketContext } from './ticketQueries'
import { sql } from 'drizzle-orm'

export interface AiTurnMetricInput {
  ticketId: string
  phase: string
  phaseAttempt: number
  sessionId: string
  assistantMessageId: string
  modelId: string
  variant?: string | null
  agent?: string | null
  finishReason?: string | null
  startedAt?: string | null
  completedAt?: string | null
  durationMs?: number | null
  costUsd?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  reasoningTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
}

export interface AiDetailsSummary {
  turns: number
  sessions: number
  costUsd: number | null
  tokens: {
    total: number | null
    input: number | null
    output: number | null
    reasoning: number | null
    cacheRead: number | null
    cacheWrite: number | null
  }
  timingMs: {
    total: number | null
    average: number | null
    longest: number | null
  }
  coverage: {
    costTurns: number
    tokenTurns: number
    timingTurns: number
  }
}

export interface AiDetailsResponse {
  scope: 'phase' | 'lifecycle'
  phase: string | null
  phaseAttempt: number | null
  modelId: string | null
  summary: AiDetailsSummary
  updatedAt: string | null
}

type AggregateRow = {
  turns: number
  sessions: number
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  totalTokens: number | null
  totalDurationMs: number | null
  averageDurationMs: number | null
  longestDurationMs: number | null
  costTurns: number
  tokenTurns: number
  timingTurns: number
  updatedAt: string | null
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  const number = finiteOrNull(value)
  return number === null ? null : Math.max(0, Math.round(number))
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function epochToIso(value: unknown): string | null {
  const epoch = finiteOrNull(value)
  if (epoch === null || epoch < 0) return null
  const date = new Date(epoch)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Upserts one completed assistant turn and broadcasts a lightweight invalidation.
 * Callers may safely retry with the same ticket/session/message identity.
 */
export function upsertAiTurnMetric(input: AiTurnMetricInput): boolean {
  const context = getTicketContext(input.ticketId)
  if (!context) return false

  const updatedAt = new Date().toISOString()
  const values = {
    ticketId: context.localTicketId,
    phase: input.phase,
    phaseAttempt: Math.max(1, Math.round(input.phaseAttempt)),
    sessionId: input.sessionId,
    assistantMessageId: input.assistantMessageId,
    modelId: input.modelId,
    variant: normalizeOptionalText(input.variant),
    agent: normalizeOptionalText(input.agent),
    finishReason: normalizeOptionalText(input.finishReason),
    startedAt: normalizeOptionalText(input.startedAt),
    completedAt: normalizeOptionalText(input.completedAt),
    durationMs: nonNegativeIntegerOrNull(input.durationMs),
    costUsd: finiteOrNull(input.costUsd),
    inputTokens: nonNegativeIntegerOrNull(input.inputTokens),
    outputTokens: nonNegativeIntegerOrNull(input.outputTokens),
    reasoningTokens: nonNegativeIntegerOrNull(input.reasoningTokens),
    cacheReadTokens: nonNegativeIntegerOrNull(input.cacheReadTokens),
    cacheWriteTokens: nonNegativeIntegerOrNull(input.cacheWriteTokens),
    updatedAt,
    schemaVersion: 1,
  }
  context.projectDb.insert(ticketAiTurnMetrics)
    .values({ ...values, createdAt: updatedAt })
    .onConflictDoUpdate({
      target: [
        ticketAiTurnMetrics.ticketId,
        ticketAiTurnMetrics.sessionId,
        ticketAiTurnMetrics.assistantMessageId,
      ],
      set: values,
    })
    .run()

  broadcaster.broadcast(input.ticketId, 'ai_metrics', {
    ticketId: input.ticketId,
    phase: input.phase,
    phaseAttempt: Math.max(1, Math.round(input.phaseAttempt)),
    modelId: input.modelId,
    updatedAt,
  })
  return true
}

function sumStepMetrics(parts: Message['parts']): {
  finishReason: string | null
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
} {
  const finishes = (parts ?? []).filter(
    (part): part is StepFinishMessagePart => part.type === 'step-finish',
  )
  const sum = (read: (part: StepFinishMessagePart) => number | undefined) => {
    const values = finishes.map(read).filter((value): value is number => Number.isFinite(value))
    return values.length > 0 ? values.reduce((total, value) => total + value, 0) : null
  }
  const latest = finishes.at(-1)
  return {
    finishReason: normalizeOptionalText(latest?.reason),
    costUsd: sum((part) => part.cost),
    inputTokens: sum((part) => part.tokens?.input),
    outputTokens: sum((part) => part.tokens?.output),
    reasoningTokens: sum((part) => part.tokens?.reasoning),
    cacheReadTokens: sum((part) => part.tokens?.cache?.read),
    cacheWriteTokens: sum((part) => part.tokens?.cache?.write),
  }
}

/**
 * Extracts the latest assistant message produced by this prompt. It deliberately
 * ignores older messages returned with a continued session, preventing backfill.
 */
export function recordAiTurnMetricFromPrompt(
  event: OpenCodePromptCompletedEvent,
  ownership: OpenCodeSessionOwnership,
): boolean {
  const latestAssistantMessageId = event.responseMeta.latestAssistantMessageId
  if (!latestAssistantMessageId) return false

  const latestIndex = event.messages.findIndex((candidate) =>
    candidate.id === latestAssistantMessageId
      || candidate.info?.id === latestAssistantMessageId
  )
  if (latestIndex < 0) return false

  // A prompt appends a user/system request followed by one or more assistant
  // messages (tool cycles can produce several). Only select that trailing
  // segment so continuation history is never imported as a backfill.
  let promptBoundary = -1
  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    const role = event.messages[index]?.role ?? event.messages[index]?.info?.role
    if (role === 'user' || role === 'system') {
      promptBoundary = index
      break
    }
  }
  const currentMessages = promptBoundary >= 0
    ? event.messages.slice(promptBoundary + 1, latestIndex + 1)
    : [event.messages[latestIndex]!]
  const assistantMessages = currentMessages.filter((message) =>
    (message.role ?? message.info?.role) === 'assistant'
  )

  let recorded = false
  for (const message of assistantMessages) {
    const assistantMessageId = message.id || message.info?.id
    if (!assistantMessageId) continue
    const info = message.info as Record<string, unknown> | undefined
    const time = info?.time && typeof info.time === 'object'
      ? info.time as Record<string, unknown>
      : undefined
    const startedMs = finiteOrNull(time?.created)
    const completedMs = finiteOrNull(time?.completed)
    const step = sumStepMetrics(message.parts)
    const infoTokens = getRecord(info?.tokens)
    const infoCacheTokens = getRecord(infoTokens?.cache)
    const providerId = normalizeOptionalText(info?.providerID)
    const nativeModelId = normalizeOptionalText(info?.modelID)
    const actualModelId = providerId && nativeModelId
      ? `${providerId}/${nativeModelId}`
      : nativeModelId ?? event.model ?? ownership.memberId ?? 'unknown'
    const actualVariant = normalizeOptionalText(info?.variant) ?? normalizeOptionalText(event.variant)

    recorded = upsertAiTurnMetric({
      ticketId: ownership.ticketId,
      phase: ownership.phase,
      phaseAttempt: ownership.phaseAttempt ?? 1,
      sessionId: event.session.id,
      assistantMessageId,
      modelId: actualModelId,
      variant: actualVariant,
      agent: normalizeOptionalText(info?.agent) ?? normalizeOptionalText(info?.mode) ?? event.agent,
      finishReason: step.finishReason
        ?? (assistantMessageId === latestAssistantMessageId
          ? event.responseMeta.latestStepFinishReason
          : null),
      startedAt: epochToIso(startedMs),
      completedAt: epochToIso(completedMs),
      durationMs: startedMs !== null && completedMs !== null
        ? Math.max(0, completedMs - startedMs)
        : null,
      costUsd: finiteOrNull(info?.cost) ?? step.costUsd,
      inputTokens: finiteOrNull(infoTokens?.input) ?? step.inputTokens,
      outputTokens: finiteOrNull(infoTokens?.output) ?? step.outputTokens,
      reasoningTokens: finiteOrNull(infoTokens?.reasoning) ?? step.reasoningTokens,
      cacheReadTokens: finiteOrNull(infoCacheTokens?.read) ?? step.cacheReadTokens,
      cacheWriteTokens: finiteOrNull(infoCacheTokens?.write) ?? step.cacheWriteTokens,
    }) || recorded
  }
  return recorded
}

export function getAiDetails(
  ticketId: string,
  options: {
    scope: 'phase' | 'lifecycle'
    phase?: string
    phaseAttempt?: number
    modelId?: string
  },
): AiDetailsResponse | null {
  const context = getTicketContext(ticketId)
  if (!context) return null

  const clauses = [sql`ticket_id = ${context.localTicketId}`]
  if (options.scope === 'phase') {
    clauses.push(sql`phase = ${options.phase!}`, sql`phase_attempt = ${options.phaseAttempt!}`)
  }
  if (options.modelId) {
    clauses.push(sql`model_id = ${options.modelId}`)
  }

  const row = context.projectDb.get<AggregateRow>(sql`
    SELECT
      COUNT(*) AS turns,
      COUNT(DISTINCT session_id) AS sessions,
      SUM(cost_usd) AS costUsd,
      SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,
      SUM(reasoning_tokens) AS reasoningTokens,
      SUM(cache_read_tokens) AS cacheReadTokens,
      SUM(cache_write_tokens) AS cacheWriteTokens,
      SUM(CASE WHEN input_tokens IS NOT NULL
                    OR output_tokens IS NOT NULL
                    OR reasoning_tokens IS NOT NULL
                    OR cache_read_tokens IS NOT NULL
                    OR cache_write_tokens IS NOT NULL
               THEN COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
                  + COALESCE(reasoning_tokens, 0) + COALESCE(cache_read_tokens, 0)
                  + COALESCE(cache_write_tokens, 0)
          END) AS totalTokens,
      SUM(duration_ms) AS totalDurationMs,
      AVG(duration_ms) AS averageDurationMs,
      MAX(duration_ms) AS longestDurationMs,
      COUNT(cost_usd) AS costTurns,
      SUM(CASE WHEN input_tokens IS NOT NULL
                    OR output_tokens IS NOT NULL
                    OR reasoning_tokens IS NOT NULL
                    OR cache_read_tokens IS NOT NULL
                    OR cache_write_tokens IS NOT NULL
               THEN 1 ELSE 0 END) AS tokenTurns,
      COUNT(duration_ms) AS timingTurns,
      MAX(updated_at) AS updatedAt
    FROM ticket_ai_turn_metrics
    WHERE ${sql.join(clauses, sql` AND `)}
  `)

  return {
    scope: options.scope,
    phase: options.scope === 'phase' ? options.phase! : null,
    phaseAttempt: options.scope === 'phase' ? options.phaseAttempt! : null,
    modelId: options.modelId ?? null,
    summary: {
      turns: Number(row?.turns ?? 0),
      sessions: Number(row?.sessions ?? 0),
      costUsd: finiteOrNull(row?.costUsd),
      tokens: {
        total: finiteOrNull(row?.totalTokens),
        input: finiteOrNull(row?.inputTokens),
        output: finiteOrNull(row?.outputTokens),
        reasoning: finiteOrNull(row?.reasoningTokens),
        cacheRead: finiteOrNull(row?.cacheReadTokens),
        cacheWrite: finiteOrNull(row?.cacheWriteTokens),
      },
      timingMs: {
        total: finiteOrNull(row?.totalDurationMs),
        average: finiteOrNull(row?.averageDurationMs),
        longest: finiteOrNull(row?.longestDurationMs),
      },
      coverage: {
        costTurns: Number(row?.costTurns ?? 0),
        tokenTurns: Number(row?.tokenTurns ?? 0),
        timingTurns: Number(row?.timingTurns ?? 0),
      },
    },
    updatedAt: normalizeOptionalText(row?.updatedAt),
  }
}
