import { broadcaster } from '../../sse/broadcaster'
import { appendLogEvent, createLogEvent, shouldSkipLogEmission } from '../../log/executionLog'
import type { LogEventType, LogSource } from '../../log/types'
import { buildOpenCodeQuestionLogIdentity } from '@shared/logIdentity'
import { type TicketState } from '../../opencode/contextBuilder'
import { analyzeAssistantMessages } from '../../opencode/assistantMessageAnalysis'
import { hasRichModelErrorInfo, summarizeModelErrorForLog } from '../../opencode/errorDetails'
import type { Message, MessagePart, PromptPart, StreamEvent } from '../../opencode/types'
import { PROM5, PROM13, PROM23 } from '../../prompts/index'
import type {
  DraftProgressEvent,
  DraftResult,
  DraftStructuredOutputMeta,
  MemberOutcome,
  RawAttempt,
  Vote,
  VotePresentationOrder,
} from '../../council/types'
import { parseCouncilMembers } from '../../council/members'
import { db as appDb } from '../../db/index'
import { profiles } from '../../db/schema'
import { PROFILE_DEFAULTS } from '../../db/defaults'
import type { TicketContext } from '../../machines/types'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import {
  getLatestPhaseArtifact,
  getActivePhaseAttempt,
  getTicketContext as getStoredTicketContext,
  getTicketByRef,
  getTicketPaths,
  upsertLatestPhaseArtifact,
} from '../../storage/tickets'
import { buildPrdContextBuilder } from '../../phases/prd/draft'
import { buildBeadsContextBuilder } from '../../phases/beads/draft'
import { formatInterviewQuestionPreview, parseInterviewQuestions } from '../../phases/interview/questions'
import type { OpenCodePromptDispatchEvent } from '../runOpenCodePrompt'
import { buildSessionStatusLogEntries } from '../sessionStatusLogging'
import {
  buildStructuredOutputMetadata,
  type StructuredOutputMetadata,
} from '../../structuredOutput'
import type { StructuredLogFields, StructuredLogAudience, StructuredLogKind, StructuredLogOp, OpenCodeStreamState, PhaseIntermediateData } from './types'
import { phaseIntermediate } from './state'
import { formatStructuredFailureForLog, type StructuredFailureClass } from '../../lib/structuredOutputRetry'
import { normalizeStructuredRetryCount } from '../../lib/structuredRetryPolicy'
import {
  attachOpenCodeBlockedErrorDiagnostics,
  buildOutputTruncatedBlockedErrorDiagnostics,
} from '../../opencode/blockedErrorDiagnostics'
import { persistUiArtifactCompanionArtifact } from '../artifactCompanions'
import { getErrorMessage } from '@shared/typeGuards'
export { resolveAiQuestionSettings } from '../aiQuestionSettings'
import { resolveAiQuestionSettings } from '../aiQuestionSettings'
import { resolvePhaseAttempt } from '../../storage/ticketPhaseAttempts'
import {
  attachRequest,
  markRequestRejectedExternally,
  markRequestReplied,
} from '../questionWindows'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

// ── Cached tool log limits from profile ──────────────────────────────────────

export interface ToolLogLimits {
  inputMaxChars: number
  outputMaxChars: number
  errorMaxChars: number
}

const DEFAULT_TOOL_LOG_LIMITS: ToolLogLimits = {
  inputMaxChars: PROFILE_DEFAULTS.toolInputMaxChars,
  outputMaxChars: PROFILE_DEFAULTS.toolOutputMaxChars,
  errorMaxChars: PROFILE_DEFAULTS.toolErrorMaxChars,
}

const STREAMING_LOG_MIN_INTERVAL_MS = 10
const LIVE_DEBUG_LOG_MAX_CHARS = 8000

let _cachedToolLogLimits: ToolLogLimits = { ...DEFAULT_TOOL_LOG_LIMITS }
let _toolLogLimitsCachedAt = 0
const TOOL_LOG_LIMITS_CACHE_TTL_MS = 30_000

/**
 * Returns the tool log truncation limits from the profile, cached for 30 seconds
 * to avoid a DB read on every stream event.
 */
export function getToolLogLimits(): ToolLogLimits {
  const now = Date.now()
  if (now - _toolLogLimitsCachedAt < TOOL_LOG_LIMITS_CACHE_TTL_MS) {
    return _cachedToolLogLimits
  }
  try {
    const profile = appDb.select().from(profiles).get()
    _cachedToolLogLimits = {
      inputMaxChars: profile?.toolInputMaxChars ?? DEFAULT_TOOL_LOG_LIMITS.inputMaxChars,
      outputMaxChars: profile?.toolOutputMaxChars ?? DEFAULT_TOOL_LOG_LIMITS.outputMaxChars,
      errorMaxChars: profile?.toolErrorMaxChars ?? DEFAULT_TOOL_LOG_LIMITS.errorMaxChars,
    }
  } catch {
    // DB read failed — keep using previous cached values.
  }
  _toolLogLimitsCachedAt = now
  return _cachedToolLogLimits
}

export function emitPhaseLog(
  ticketId: string,
  _ticketExternalId: string,
  phase: WorkflowPhaseId,
  type: LogEventType,
  content: string,
  data?: Record<string, unknown>,
) {
  const source = typeof data?.source === 'string' ? data.source : undefined
  const suppressDebugMirror = data?.suppressDebugMirror === true
  const structuredExtra = {
    ...(typeof data?.entryId === 'string' ? { entryId: data.entryId } : {}),
    ...(typeof data?.fingerprint === 'string' ? { fingerprint: data.fingerprint } : {}),
    ...(typeof data?.op === 'string' ? { op: data.op as StructuredLogOp } : {}),
    ...(typeof data?.audience === 'string' ? { audience: data.audience as StructuredLogAudience } : {}),
    ...(typeof data?.kind === 'string' ? { kind: data.kind as StructuredLogKind } : {}),
    ...(typeof data?.modelId === 'string' ? { modelId: data.modelId } : {}),
    ...(typeof data?.variant === 'string' ? { variant: data.variant } : {}),
    ...(typeof data?.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
    ...(typeof data?.beadId === 'string' ? { beadId: data.beadId } : {}),
    ...(typeof data?.beadIteration === 'number' && Number.isFinite(data.beadIteration) ? { beadIteration: data.beadIteration } : {}),
    ...(typeof data?.streaming === 'boolean' ? { streaming: data.streaming } : {}),
    ...(typeof data?.phaseAttempt === 'number' && Number.isFinite(data.phaseAttempt) ? { phaseAttempt: data.phaseAttempt } : {}),
  }
  const timestamp = new Date().toISOString()
  const emissionData = data ? { ...data, timestamp } : { timestamp }
  if (shouldSkipLogEmission(ticketId, type, phase, content, emissionData, source as LogSource | undefined, phase, structuredExtra)) {
    return
  }

  const event = createLogEvent(
    ticketId,
    type,
    phase,
    content,
    emissionData,
    source as LogSource | undefined,
    phase,
    structuredExtra,
  )
  broadcaster.broadcast(ticketId, 'log', { ...event })
  appendLogEvent(
    ticketId,
    type,
    phase,
    content,
    emissionData,
    source as LogSource | undefined,
    phase,
    structuredExtra,
  )
  // Debug mirrors are broadcast via SSE for the real-time DEBUG tab but NOT
  // persisted to disk — they are near-identical copies of the original entry
  // and account for ~55% of log file bloat. See LOG SIZE BUDGET in executionLog.ts.
  if (type !== 'debug' && !suppressDebugMirror) {
    emitDebugLog(
      ticketId,
      phase,
      `app.${type}`,
      {
        content,
        ...(data ? { data } : {}),
        ...(typeof event.phaseAttempt === 'number' ? { phaseAttempt: event.phaseAttempt } : {}),
      },
      false,
    )
  }
}

function buildBeadLogFields(beadId?: string, beadIteration?: number): Pick<StructuredLogFields, 'beadId' | 'beadIteration'> {
  return {
    ...(beadId ? { beadId } : {}),
    ...(typeof beadIteration === 'number' && Number.isFinite(beadIteration) ? { beadIteration } : {}),
  }
}

export function emitModelSystemLog(
  ticketId: string,
  ticketExternalId: string,
  phase: WorkflowPhaseId,
  type: LogEventType,
  content: string,
  modelId: string,
  extra?: Record<string, unknown>,
) {
  emitPhaseLog(ticketId, ticketExternalId, phase, type, content, {
    ...(extra ?? {}),
    source: 'system',
    modelId,
  })
}

/**
 * Emit a debug-level log entry.
 *
 * @param persist  Whether to write this entry to the persistent execution log
 *   file. Defaults to `true` for direct calls (unique debug data such as raw
 *   AI responses). Mirror calls from emitPhaseLog pass `false` so the entry
 *   is only broadcast via SSE for the real-time DEBUG tab — this prevents
 *   near-duplicate entries from bloating the log file.
 *   See LOG SIZE BUDGET comment in executionLog.ts.
 */
export function emitDebugLog(
  ticketId: string,
  phase: WorkflowPhaseId,
  message: string,
  payload?: unknown,
  persist = true,
) {
  const payloadText = payload === undefined ? '' : ` ${stringifyForLog(payload)}`
  const content = `[DEBUG] ${message}${payloadText}`
  const liveContent = content.length > LIVE_DEBUG_LOG_MAX_CHARS
    ? `${content.slice(0, LIVE_DEBUG_LOG_MAX_CHARS)}\n... [debug payload truncated for live stream; full entry is available in the debug log]`
    : content
  const debugData = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)
    : (payload !== undefined ? { value: payload } : undefined)
  const timestamp = new Date().toISOString()
  const logData: Record<string, unknown> = debugData ? { ...debugData, timestamp } : { timestamp }
  const structuredExtra = {
    audience: 'debug' as const,
    kind: 'session' as const,
    op: 'append' as const,
    streaming: false,
    ...(typeof logData.phaseAttempt === 'number' && Number.isFinite(logData.phaseAttempt) ? { phaseAttempt: logData.phaseAttempt } : {}),
  }
  if (shouldSkipLogEmission(ticketId, 'debug', phase, content, logData, 'debug', phase, structuredExtra)) {
    return
  }

  // Always broadcast via SSE so the real-time log viewer DEBUG tab works.
  const event = createLogEvent(
    ticketId,
    'debug',
    phase,
    liveContent,
    logData,
    'debug',
    phase,
    structuredExtra,
  )
  broadcaster.broadcast(ticketId, 'log', { ...event })

  // Only persist to disk when this is a direct (non-mirror) debug call.
  if (persist) {
    appendLogEvent(ticketId, 'debug', phase, content, logData, 'debug', phase, structuredExtra)
  }
}

export function stringifyForLog(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function truncateToolDetail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n… (truncated ${value.length - maxChars} chars)`
}

function stringifyToolDetail(value: unknown, maxChars: number): string {
  if (typeof value === 'string') return truncateToolDetail(value.trimEnd(), maxChars)
  if (value == null) return ''
  try {
    return truncateToolDetail(JSON.stringify(value, null, 2), maxChars)
  } catch {
    return truncateToolDetail(String(value), maxChars)
  }
}

function normalizeAttachmentMetadata(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 2 : 1)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function formatTimestamp(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

export function createOpenCodeStreamState(): OpenCodeStreamState {
  return {
    seenFirstActivity: false,
    liveKinds: new Map(),
    liveContents: new Map(),
    liveStreamEmissions: new Map(),
    todoStatuses: new Map(),
    liveTextMessages: new Map(),
    textPartToMessageIds: new Map(),
    finalizedTextEntryIds: new Set(),
    finalizedDetailEntryIds: new Set(),
  }
}

function shouldEmitStreamingLogUpdate(
  state: OpenCodeStreamState,
  entryId: string,
  _content: string,
  complete: boolean,
): boolean {
  const now = Date.now()
  const previous = state.liveStreamEmissions.get(entryId)

  if (!previous) {
    state.liveStreamEmissions.set(entryId, {
      lastEmittedAt: now,
    })
    return true
  }

  const elapsedMs = now - previous.lastEmittedAt
  if (!complete && elapsedMs < STREAMING_LOG_MIN_INTERVAL_MS) {
    return false
  }

  state.liveStreamEmissions.set(entryId, {
    lastEmittedAt: now,
  })
  return true
}

function getTextMessageEntryId(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}:text`
}

function getPartEntryId(sessionId: string, partId: string): string {
  return `${sessionId}:${partId}`
}

function rememberFinalizedDetailEntry(
  state: OpenCodeStreamState | undefined,
  entryId: string,
) {
  state?.finalizedDetailEntryIds.add(entryId)
}

function getOrCreateLiveTextMessage(
  state: OpenCodeStreamState,
  sessionId: string,
  messageId: string,
) {
  const existing = state.liveTextMessages.get(messageId)
  if (existing) return existing

  const created = {
    entryId: getTextMessageEntryId(sessionId, messageId),
    partOrder: [] as string[],
    partTexts: new Map<string, string>(),
  }
  state.liveTextMessages.set(messageId, created)
  return created
}

function buildLiveTextMessageContent(message: {
  partOrder: string[]
  partTexts: Map<string, string>
}): string {
  return message.partOrder.map((partId) => message.partTexts.get(partId) ?? '').join('')
}

function upsertLiveTextMessage(
  state: OpenCodeStreamState,
  sessionId: string,
  messageId: string,
  partId: string,
  text: string,
) {
  const message = getOrCreateLiveTextMessage(state, sessionId, messageId)
  if (!message.partTexts.has(partId)) {
    message.partOrder.push(partId)
  }
  message.partTexts.set(partId, text)
  state.textPartToMessageIds.set(partId, messageId)
  return message
}

function removeLiveTextPart(
  state: OpenCodeStreamState,
  partId: string,
) {
  const messageId = state.textPartToMessageIds.get(partId)
  if (!messageId) return

  const message = state.liveTextMessages.get(messageId)
  if (!message) {
    state.textPartToMessageIds.delete(partId)
    return
  }

  message.partTexts.delete(partId)
  message.partOrder = message.partOrder.filter((candidate) => candidate !== partId)
  state.textPartToMessageIds.delete(partId)

  if (message.partOrder.length === 0) {
    state.liveTextMessages.delete(messageId)
  }
}

export function formatToolState(
  event: Extract<StreamEvent, { type: 'tool' }>,
  limits?: Partial<ToolLogLimits>,
): string {
  const resolved = limits
    ? { ...getToolLogLimits(), ...limits }
    : getToolLogLimits()
  const tool = event.tool ?? 'tool'
  const status = event.status ?? 'unknown'
  const title = event.title
  const error = event.error
  const output = event.output
  const duration = typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0
    ? ` (${formatDuration(event.durationMs)})`
    : ''
  const lines = [`[TOOL] ${tool} ${status}${duration}${title ? `: ${title}` : ''}`]

  if (event.input && Object.keys(event.input).length > 0) {
    lines.push('Input:', stringifyToolDetail(event.input, resolved.inputMaxChars))
  }

  if (output) {
    lines.push('Output:', stringifyToolDetail(output, resolved.outputMaxChars))
  }

  if (error) {
    lines.push('Error:', stringifyToolDetail(error, resolved.errorMaxChars))
  }

  if (event.attachments && event.attachments.length > 0) {
    lines.push(
      `Attachments: ${event.attachments.length}`,
      ...event.attachments.map((attachment) => {
        const filename = normalizeAttachmentMetadata(attachment.filename, 256) || 'unnamed attachment'
        const mime = normalizeAttachmentMetadata(attachment.mime, 128)
        return `- ${filename}${mime ? ` (${mime})` : ''}`
      }),
    )
  }

  if (typeof event.compactedAt === 'number' && Number.isFinite(event.compactedAt)) {
    lines.push(`Compacted: ${formatTimestamp(event.compactedAt)}`)
  }

  if (lines.length === 1) {
    lines[0] = `${lines[0]}.`
  }

  return lines.join('\n')
}

export function emitStructuredPhaseLog(
  ticketId: string,
  ticketExternalId: string,
  phase: WorkflowPhaseId,
  type: LogEventType,
  content: string,
  fields: StructuredLogFields,
) {
  emitPhaseLog(ticketId, ticketExternalId, phase, type, content, fields)
}

export function emitAiMilestone(
  ticketId: string,
  ticketExternalId: string,
  phase: WorkflowPhaseId,
  message: string,
  suffix: string,
  extra?: Partial<StructuredLogFields>,
) {
  emitStructuredPhaseLog(ticketId, ticketExternalId, phase, 'info', message, {
    entryId: extra?.entryId ?? `milestone:${phase}:${suffix}`,
    audience: 'all',
    kind: 'milestone',
    op: 'append',
    source: extra?.source ?? 'opencode',
    sessionId: extra?.sessionId,
    modelId: extra?.modelId,
    streaming: false,
    suppressDebugMirror: true,
    ...extra,
  })
}

export function emitAiDetail(
  ticketId: string,
  ticketExternalId: string,
  phase: WorkflowPhaseId,
  type: LogEventType,
  content: string,
  fields: StructuredLogFields,
) {
  emitStructuredPhaseLog(ticketId, ticketExternalId, phase, type, content, {
    streaming: fields.streaming ?? true,
    suppressDebugMirror: true,
    ...fields,
  })
}

export function emitOpenCodePromptLog(
  ticketId: string,
  ticketExternalId: string,
  phase: WorkflowPhaseId,
  memberId: string,
  event: OpenCodePromptDispatchEvent,
  beadId?: string,
  beadIteration?: number,
) {
  const source = memberId ? `model:${memberId}` : 'opencode'
  const promptBody = event.promptText.trim()
  const promptHeader = memberId
    ? `[PROMPT] ${memberId} prompt #${event.promptNumber}`
    : `[PROMPT] Prompt #${event.promptNumber}`

  emitAiDetail(
    ticketId,
    ticketExternalId,
    phase,
    'info',
    promptBody ? `${promptHeader}\n${promptBody}` : promptHeader,
    {
      entryId: `${event.session.id}:prompt:${event.promptNumber}`,
      audience: 'ai',
      kind: 'prompt',
      op: 'append',
      source,
      modelId: memberId || undefined,
      variant: event.variant,
      sessionId: event.session.id,
      ...buildBeadLogFields(beadId, beadIteration),
      ...(event.timeoutMs !== undefined ? { timeoutMs: event.timeoutMs } : {}),
      ...(event.deadlineAt ? { deadlineAt: event.deadlineAt } : {}),
      timeoutKind: event.timeoutKind,
      streaming: false,
    },
  )
}

export function finalizeOpenCodeParts(
  ticketId: string,
  ticketExternalId: string,
  phase: WorkflowPhaseId,
  memberId: string,
  sessionId: string,
  state: OpenCodeStreamState,
  beadId?: string,
  beadIteration?: number,
  hasTerminalOutput = true,
) {
  const source = memberId ? `model:${memberId}` : 'opencode'
  const beadFields = buildBeadLogFields(beadId, beadIteration)
  const completedTextMessages = Array.from(state.liveTextMessages.values())
    .filter((message) => buildLiveTextMessageContent(message).length > 0)
  const terminalTextEntryId = hasTerminalOutput ? completedTextMessages.at(-1)?.entryId : undefined
  for (const message of completedTextMessages) {
    const content = buildLiveTextMessageContent(message)
    const isTerminal = message.entryId === terminalTextEntryId
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      isTerminal ? 'model_output' : 'info',
      isTerminal ? content : `[ASSISTANT] ${content}`,
      {
        entryId: message.entryId,
        audience: 'ai',
        kind: isTerminal ? 'text' : 'assistant',
        op: 'finalize',
        source,
        modelId: memberId || undefined,
        sessionId,
        ...beadFields,
        streaming: false,
      },
    )
    if (isTerminal) {
      state.finalizedTextEntryIds.add(message.entryId)
    }
    rememberFinalizedDetailEntry(state, message.entryId)
    state.liveStreamEmissions.delete(message.entryId)
  }

  const FINALIZED_CONTENT_BY_KIND: Partial<Record<string, string>> = {
    tool: 'Tool event finalized.',
    step: 'Step finalized.',
  }
  const LOG_TYPE_BY_KIND: Partial<Record<string, 'error' | 'model_output' | 'info'>> = {
    error: 'error',
    text: 'model_output',
    reasoning: 'model_output',
  }
  for (const [partId, kind] of state.liveKinds.entries()) {
    const entryId = `${sessionId}:${partId}`
    const content = state.liveContents.get(partId) ?? (FINALIZED_CONTENT_BY_KIND[kind] ?? '')
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      LOG_TYPE_BY_KIND[kind] ?? 'info',
      content,
      {
        entryId,
        audience: 'ai',
        kind,
        op: 'finalize',
      source,
      modelId: memberId || undefined,
      sessionId,
      ...beadFields,
      streaming: false,
    },
    )
    rememberFinalizedDetailEntry(state, entryId)
    state.liveStreamEmissions.delete(entryId)
  }
  state.liveTextMessages.clear()
  state.textPartToMessageIds.clear()
  state.liveKinds.clear()
  state.liveContents.clear()
  state.liveStreamEmissions.clear()
  state.todoStatuses.clear()
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function getAssistantMessageId(message: Message): string | undefined {
  return message.id || message.info?.id || undefined
}

function isAssistantMessage(message: Message): boolean {
  return message.role === 'assistant' || message.info?.role === 'assistant'
}

function getAssistantMessageVariant(message: Message): string | undefined {
  const variant = message.info?.variant
  return typeof variant === 'string' && variant.trim().length > 0 ? variant : undefined
}

function getAssistantMessageText(message: Message): string {
  const partText = (message.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => getString((part as MessagePart & Record<string, unknown>).text) ?? '')
    .join('')
    .trimEnd()
  if (partText) return partText
  return typeof message.content === 'string' ? message.content.trimEnd() : ''
}

function selectAssistantMessagesForDetailBackfill(
  messages: Message[],
  latestAssistantMessageId?: string,
): Message[] {
  let latestIndex = latestAssistantMessageId
    ? messages.findIndex((message) =>
        isAssistantMessage(message) && getAssistantMessageId(message) === latestAssistantMessageId,
      )
    : -1
  if (latestIndex < 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message && isAssistantMessage(message)) {
        latestIndex = index
        break
      }
    }
  }
  if (latestIndex < 0) return []

  let startIndex = 0
  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || !isAssistantMessage(message)) {
      startIndex = index + 1
      break
    }
  }
  return messages.slice(startIndex, latestIndex + 1).filter(isAssistantMessage)
}

type ToolStatus = Extract<StreamEvent, { type: 'tool' }>['status']
const TOOL_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'completed', 'error'])

function normalizeToolStatus(value: unknown): ToolStatus {
  return typeof value === 'string' && TOOL_STATUSES.has(value)
    ? value as ToolStatus
    : 'completed'
}

function emitBackfilledAiDetail(
  ticketId: string,
  ticketExternalId: string,
  phase: WorkflowPhaseId,
  type: LogEventType,
  content: string,
  state: OpenCodeStreamState | undefined,
  fields: StructuredLogFields,
) {
  if (state?.finalizedDetailEntryIds.has(fields.entryId)) return
  emitAiDetail(ticketId, ticketExternalId, phase, type, content, {
    ...fields,
    op: fields.op === 'upsert' ? 'finalize' : fields.op,
    streaming: false,
  })
  rememberFinalizedDetailEntry(state, fields.entryId)
}

function emitAssistantMessagePartDetails(
  ticketId: string,
  ticketExternalId: string,
  phase: WorkflowPhaseId,
  memberId: string,
  sessionId: string,
  messages: Message[],
  state?: OpenCodeStreamState,
  beadId?: string,
  beadIteration?: number,
  latestAssistantMessageId?: string,
) {
  const source = memberId ? `model:${memberId}` : 'opencode'
  const beadFields = buildBeadLogFields(beadId, beadIteration)
  for (const message of messages) {
    const messageId = getAssistantMessageId(message)
    const variant = getAssistantMessageVariant(message)
    const text = getAssistantMessageText(message)
    if (messageId && text) {
      const isTerminal = messageId === latestAssistantMessageId
      emitBackfilledAiDetail(
        ticketId,
        ticketExternalId,
        phase,
        isTerminal ? 'model_output' : 'info',
        isTerminal ? text : `[ASSISTANT] ${text}`,
        state,
        {
          entryId: getTextMessageEntryId(sessionId, messageId),
          audience: 'ai',
          kind: isTerminal ? 'text' : 'assistant',
          op: 'finalize',
          source,
          modelId: memberId || undefined,
          variant,
          sessionId,
          ...beadFields,
        },
      )
      if (isTerminal) state?.finalizedTextEntryIds.add(getTextMessageEntryId(sessionId, messageId))
    }

    for (const part of message.parts ?? []) {
      const partRecord = part as MessagePart & Record<string, unknown>
      const partId = getString(partRecord.id)
      if (!partId) continue
      if (part.type === 'text') continue

      const entryId = getPartEntryId(sessionId, partId)
      const commonFields = {
        entryId,
        audience: 'ai' as const,
        source,
        modelId: memberId || undefined,
        variant,
        sessionId,
        ...beadFields,
      }

      if (part.type === 'reasoning') {
        const text = getString(partRecord.text)?.trimEnd() ?? ''
        if (!text) continue
        emitBackfilledAiDetail(ticketId, ticketExternalId, phase, 'model_output', text, state, {
          ...commonFields,
          kind: 'reasoning',
          op: 'finalize',
        })
        continue
      }

      if (part.type === 'tool') {
        const stateRecord = getRecord(partRecord.state)
        const timeRecord = getRecord(stateRecord?.time)
        const tool = getString(partRecord.tool) ?? 'tool'
        const status = normalizeToolStatus(stateRecord?.status)
        const input = getRecord(stateRecord?.input) ?? undefined
        const output = getString(stateRecord?.output)
        const error = getString(stateRecord?.error)
        const title = getString(stateRecord?.title)
        const start = typeof timeRecord?.start === 'number' ? timeRecord.start : undefined
        const end = typeof timeRecord?.end === 'number' ? timeRecord.end : undefined
        const attachments = Array.isArray(stateRecord?.attachments)
          ? stateRecord.attachments.flatMap((attachment) => {
              const record = getRecord(attachment)
              if (!record) return []
              const filename = getString(record.filename) ?? getString(record.name)
              const mime = getString(record.mime) ?? getString(record.mediaType)
              return filename || mime
                ? [{ ...(filename ? { filename } : {}), ...(mime ? { mime } : {}) }]
                : []
            })
          : undefined
        const content = formatToolState({
          type: 'tool',
          sessionId,
          ...(messageId ? { messageId } : {}),
          partId,
          tool,
          callId: getString(partRecord.callID) ?? partId,
          status,
          ...(title ? { title } : {}),
          ...(input ? { input } : {}),
          ...(output ? { output } : {}),
          ...(error ? { error } : {}),
          ...(start !== undefined && end !== undefined && end >= start ? { durationMs: end - start } : {}),
          ...(typeof timeRecord?.compacted === 'number' ? { compactedAt: timeRecord.compacted } : {}),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          complete: true,
        })
        emitBackfilledAiDetail(ticketId, ticketExternalId, phase, 'info', content, state, {
          ...commonFields,
          kind: 'tool',
          op: 'finalize',
        })
        continue
      }

      if (part.type === 'step-start') {
        emitBackfilledAiDetail(ticketId, ticketExternalId, phase, 'info', 'Step started.', state, {
          ...commonFields,
          kind: 'step',
          op: 'append',
        })
        continue
      }

      if (part.type === 'step-finish') {
        const reason = getString(partRecord.reason)
        emitBackfilledAiDetail(
          ticketId,
          ticketExternalId,
          phase,
          'info',
          `Step finished${reason ? `: ${reason}` : '.'}`,
          state,
          {
            ...commonFields,
            kind: 'step',
            op: 'finalize',
          },
        )
      }
    }
  }
}

export function emitOpenCodeStreamEvent(
  ticketId: string,
  ticketExternalId: string,
  phase: WorkflowPhaseId,
  memberId: string,
  sessionId: string,
  event: StreamEvent,
  state: OpenCodeStreamState,
  beadId?: string,
  beadIteration?: number,
) {
  const source = memberId ? `model:${memberId}` : 'opencode'
  const beadFields = buildBeadLogFields(beadId, beadIteration)

  const emitFirstActivity = () => {
    if (state.seenFirstActivity) return
    state.seenFirstActivity = true
    emitAiMilestone(
      ticketId,
      ticketExternalId,
      phase,
      memberId
        ? `First AI activity observed from ${memberId} (session=${sessionId}).`
        : `First AI activity observed (session=${sessionId}).`,
      `${sessionId}:first-activity`,
      { modelId: memberId || undefined, sessionId, source, ...beadFields },
    )
  }

  if (event.type === 'reasoning') {
    emitFirstActivity()
    const partId = event.partId ?? event.messageId ?? event.type
    const entryId = `${sessionId}:${partId}`
    const kind = 'reasoning'
    state.liveKinds.set(partId, kind)
    state.liveContents.set(partId, event.text)
    if (!shouldEmitStreamingLogUpdate(state, entryId, event.text, event.complete)) {
      return
    }
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      'model_output',
      event.text,
      {
        entryId,
        audience: 'ai',
        kind,
        op: event.complete ? 'finalize' : 'upsert',
        source,
        modelId: memberId || undefined,
        sessionId,
        ...beadFields,
        streaming: event.streaming,
      },
    )
    if (event.complete) {
      rememberFinalizedDetailEntry(state, entryId)
      state.liveKinds.delete(partId)
      state.liveContents.delete(partId)
      state.liveStreamEmissions.delete(entryId)
    }
    return
  }

  if (event.type === 'text') {
    emitFirstActivity()
    const messageId = event.messageId ?? event.partId ?? event.type
    const partId = event.partId ?? messageId
    const message = upsertLiveTextMessage(state, sessionId, messageId, partId, event.text)
    const content = buildLiveTextMessageContent(message)

    if (content.length > 0 && shouldEmitStreamingLogUpdate(state, message.entryId, content, event.complete)) {
      emitAiDetail(
        ticketId,
        ticketExternalId,
        phase,
        'model_output',
        content,
        {
          entryId: message.entryId,
          audience: 'ai',
          kind: 'text',
          op: 'upsert',
          source,
          modelId: memberId || undefined,
          sessionId,
          ...beadFields,
          streaming: true,
        },
      )
    }
    return
  }

  if (event.type === 'tool') {
    emitFirstActivity()
    const partId = event.partId ?? event.callId
    state.liveKinds.set(partId, 'tool')
    state.liveContents.set(partId, formatToolState(event))
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      'info',
      formatToolState(event),
      {
        entryId: `${sessionId}:${partId}`,
        audience: 'ai',
        kind: 'tool',
        op: event.complete ? 'finalize' : 'upsert',
        source,
        modelId: memberId || undefined,
        sessionId,
        ...beadFields,
        streaming: !event.complete,
      },
    )
    if (event.complete) {
      rememberFinalizedDetailEntry(state, `${sessionId}:${partId}`)
      state.liveKinds.delete(partId)
      state.liveContents.delete(partId)
    }
    return
  }

  if (event.type === 'step') {
    emitFirstActivity()
    const partId = event.partId ?? event.messageId ?? `step:${event.step}`
    state.liveKinds.set(partId, 'step')
    state.liveContents.set(partId, event.step === 'start' ? 'Step started.' : `Step finished${event.reason ? `: ${event.reason}` : '.'}`)
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      'info',
      state.liveContents.get(partId) ?? 'Step event.',
      {
        entryId: `${sessionId}:${partId}`,
        audience: 'ai',
        kind: 'step',
        op: event.step === 'start' ? 'append' : 'finalize',
        source,
        modelId: memberId || undefined,
        sessionId,
        ...beadFields,
        streaming: false,
      },
    )
    rememberFinalizedDetailEntry(state, `${sessionId}:${partId}`)
    if (event.complete) {
      state.liveKinds.delete(partId)
      state.liveContents.delete(partId)
    }
    return
  }

  if (event.type === 'session_status') {
    if (event.status === 'idle') {
      finalizeOpenCodeParts(ticketId, ticketExternalId, phase, memberId, sessionId, state, beadId, beadIteration)
    }

    for (const entry of buildSessionStatusLogEntries(sessionId, event)) {
      emitAiDetail(
        ticketId,
        ticketExternalId,
        phase,
        entry.type,
        entry.content,
        {
          entryId: entry.entryId,
          audience: 'ai',
          kind: entry.kind,
          op: entry.op,
          source,
          modelId: memberId || undefined,
          sessionId,
          ...beadFields,
          streaming: entry.op !== 'append' && event.status !== 'idle',
          ...(entry.recoveryAction ? { recoveryAction: entry.recoveryAction } : {}),
        },
      )
    }
    return
  }

  if (event.type === 'question') {
    emitFirstActivity()
    const identity = buildOpenCodeQuestionLogIdentity({
      sessionId,
      requestId: event.requestId,
      action: event.action,
    })
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      'info',
      questionLogContent(event),
      {
        entryId: identity.entryId,
        fingerprint: identity.fingerprint,
        audience: 'ai',
        kind: 'session',
        op: 'append',
        source,
        modelId: memberId || undefined,
        sessionId,
        ...beadFields,
        streaming: false,
      },
    )
    // The stream is the only place a question announces itself, so this is
    // where the countdown starts. Everything else — the panel, the card, the
    // phase timeout suspension — hangs off the window this opens.
    if (event.action === 'asked') {
      attachRequest({
        ticketId,
        sessionId,
        requestId: event.requestId,
        memberId: memberId || null,
        phase,
        phaseAttempt: resolvePhaseAttempt(ticketId, phase),
        windowMs: resolveAiQuestionSettings(ticketId).windowMs,
        questions: event.questions ?? [],
        tool: event.tool,
      })
    } else if (event.action === 'replied') {
      markRequestReplied(ticketId, sessionId, event.requestId)
    } else {
      markRequestRejectedExternally(ticketId, sessionId, event.requestId)
    }
    broadcaster.broadcast(ticketId, 'needs_input', buildQuestionSsePayload({
      ticketId,
      ticketExternalId,
      phase,
      memberId,
      sessionId,
      event,
    }))
    return
  }

  if (event.type === 'todo') {
    emitFirstActivity()
    const summary = formatTodoTransitionSummary(event.todos, state)
    if (summary) {
      emitAiDetail(
        ticketId,
        ticketExternalId,
        phase,
        'info',
        summary,
        {
          entryId: `${sessionId}:todo:${Date.now()}`,
          audience: 'ai',
          kind: 'session',
          op: 'append',
          source,
          modelId: memberId || undefined,
          sessionId,
          ...beadFields,
          streaming: false,
        },
      )
    }
    return
  }

  if (event.type === 'part_summary') {
    emitFirstActivity()
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      event.severity === 'error' ? 'error' : 'info',
      event.summary,
      {
        entryId: `${sessionId}:${event.partId ?? event.partType}`,
        audience: 'ai',
        kind: event.severity === 'error' ? 'error' : 'session',
        op: 'append',
        source,
        modelId: memberId || undefined,
        sessionId,
        ...beadFields,
        streaming: false,
        ...(event.details ? { details: event.details } : {}),
      },
    )
    return
  }

  if (event.type === 'file_edited') {
    emitFirstActivity()
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      'info',
      `[TOOL] File edited: ${event.file}`,
      {
        entryId: `${sessionId}:file-edited:${event.file}`,
        audience: 'ai',
        kind: 'tool',
        op: 'append',
        source,
        modelId: memberId || undefined,
        sessionId,
        ...beadFields,
        streaming: false,
      },
    )
    return
  }

  if (event.type === 'debug_event') {
    emitDebugLog(ticketId, phase, `opencode.${event.eventName}`, event.details ?? { summary: event.summary })
    if (event.severity === 'error') {
      emitErrorLogOnly(
        ticketId,
        phase,
        `[ERROR] ${event.summary}`,
        {
          entryId: `${sessionId}:opencode:${event.eventName}:error`,
          audience: 'debug',
          kind: 'error',
          op: 'append',
          source: 'error',
          modelId: memberId || undefined,
          sessionId,
          ...beadFields,
          streaming: false,
        },
      )
    }
    return
  }

  if (event.type === 'permission') {
    emitDebugLog(ticketId, phase, 'opencode.permission', event.details ?? {
      permissionId: event.permissionId,
      permission: event.permission,
      title: event.title,
      patterns: event.patterns,
    })
    return
  }

  if (event.type === 'session_error') {
    const errorSummary = summarizeModelErrorForLog(event.details ?? event.error, event.error)
    finalizeOpenCodeParts(ticketId, ticketExternalId, phase, memberId, sessionId, state, beadId, beadIteration, false)
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      'error',
      errorSummary.message,
      {
        entryId: `${sessionId}:error`,
        audience: 'ai',
        kind: 'error',
        op: 'append',
        source,
        modelId: memberId || undefined,
        sessionId,
        ...beadFields,
        streaming: false,
        ...(errorSummary.details ? { errorDetails: errorSummary.details } : {}),
      },
    )
    emitAiMilestone(
      ticketId,
      ticketExternalId,
      phase,
      memberId
        ? `AI session failed for ${memberId} (session=${sessionId}).`
        : `AI session failed (session=${sessionId}).`,
      `${sessionId}:failed`,
      { modelId: memberId || undefined, sessionId, source, ...beadFields },
    )
    return
  }

  if (event.type === 'part_removed') {
    const partId = event.partId
    if (partId) {
      emitDebugLog(ticketId, phase, `opencode.part_removed partId=${partId}`, { partId, sessionId, source }, false)
      removeLiveTextPart(state, partId)
      state.liveKinds.delete(partId)
      state.liveContents.delete(partId)
      state.liveStreamEmissions.delete(`${sessionId}:${partId}`)
    }
    return
  }

  if (event.type === 'done') {
    finalizeOpenCodeParts(ticketId, ticketExternalId, phase, memberId, sessionId, state, beadId, beadIteration)
    emitAiMilestone(
      ticketId,
      ticketExternalId,
      phase,
      memberId
        ? `AI session completed for ${memberId} (session=${sessionId}).`
        : `AI session completed (session=${sessionId}).`,
      `${sessionId}:completed`,
      { modelId: memberId || undefined, sessionId, source, ...beadFields },
    )
  }
}

export function emitOpenCodeSessionLogs(
  ticketId: string,
  ticketExternalId: string,
  phase: WorkflowPhaseId,
  memberId: string,
  sessionId: string,
  stage: string,
  response: string,
  messages: Message[],
  state?: OpenCodeStreamState,
  beadId?: string,
  beadIteration?: number,
) {
  const beadFields = buildBeadLogFields(beadId, beadIteration)
  const latestReportedVariant = [...messages]
    .reverse()
    .find(isAssistantMessage)
    ?.info?.variant
  emitModelSystemLog(
    ticketId,
    ticketExternalId,
    phase,
    'info',
    `OpenCode ${stage}: ${memberId} session=${sessionId}, messages=${messages.length}, responseChars=${response.length}.`,
    memberId,
    {
      ...beadFields,
      ...(typeof latestReportedVariant === 'string' && latestReportedVariant.trim()
        ? { variant: latestReportedVariant }
        : {}),
    },
  )
  if (response.length === 0) {
    emitAiMilestone(
      ticketId,
      ticketExternalId,
      phase,
      `OpenCode session was restarted: no response text was produced (stage: ${stage}, messages: ${messages.length}). A new session will be started to continue.`,
      `session-restart:${sessionId}`,
      { source: 'system', modelId: memberId, ...beadFields },
    )
  }
  const { responseText, responseMeta } = analyzeAssistantMessages(messages)
  const latestAssistantMessageId = responseMeta.latestAssistantMessageId
  const latestTextEntryId = latestAssistantMessageId
    ? getTextMessageEntryId(sessionId, latestAssistantMessageId)
    : undefined
  const fallbackContent = response.trim() || responseText.trim()
  const hadCanonicalStreamedText = latestTextEntryId
    ? state?.finalizedTextEntryIds.has(latestTextEntryId) ?? false
    : false
  const assistantMessages = selectAssistantMessagesForDetailBackfill(messages, latestAssistantMessageId)

  emitAssistantMessagePartDetails(
    ticketId,
    ticketExternalId,
    phase,
    memberId,
    sessionId,
    assistantMessages,
    state,
    beadId,
    beadIteration,
    latestAssistantMessageId,
  )

  const hasCanonicalText = hadCanonicalStreamedText || (latestTextEntryId
    ? state?.finalizedTextEntryIds.has(latestTextEntryId) ?? false
    : false)
  if (fallbackContent && !hasCanonicalText) {
    const entryId = latestTextEntryId
      ? latestTextEntryId
      : `${sessionId}:response-fallback`
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      'model_output',
      fallbackContent,
      {
        entryId,
        audience: 'ai',
        kind: 'text',
        op: 'append',
        source: `model:${memberId}`,
        modelId: memberId,
        ...(typeof latestReportedVariant === 'string' && latestReportedVariant.trim()
          ? { variant: latestReportedVariant }
          : {}),
        sessionId,
        ...beadFields,
        streaming: false,
      },
    )
    if (latestTextEntryId) {
      state?.finalizedTextEntryIds.add(latestTextEntryId)
    }
    rememberFinalizedDetailEntry(state, entryId)
  }

  if (responseMeta.latestAssistantHasError && hasRichModelErrorInfo(responseMeta.latestAssistantErrorInfo)) {
    const assistantErrorSummary = summarizeModelErrorForLog(
      responseMeta.latestAssistantErrorInfo,
      responseMeta.latestAssistantError,
    )
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      'error',
      assistantErrorSummary.message,
      {
        entryId: `${sessionId}:${latestAssistantMessageId ?? 'assistant-error'}:assistant-error`,
        audience: 'ai',
        kind: 'error',
        op: 'append',
        source: `model:${memberId}`,
        modelId: memberId,
        sessionId,
        ...beadFields,
        streaming: false,
        ...(assistantErrorSummary.details ? { errorDetails: assistantErrorSummary.details } : {}),
      },
    )
  }

  emitDebugLog(ticketId, phase, `opencode.${stage}.response`, { memberId, response })
  for (const message of messages) {
    emitDebugLog(ticketId, phase, `opencode.${stage}.raw_message`, { memberId, message })
  }
}

function emitErrorLogOnly(
  ticketId: string,
  phase: WorkflowPhaseId,
  content: string,
  data: StructuredLogFields,
) {
  emitStructuredPhaseLog(ticketId, ticketId, phase, 'error', content, {
    ...data,
    audience: data.audience ?? 'debug',
    kind: 'error',
    source: 'error',
    streaming: false,
    suppressDebugMirror: true,
  })
}

function formatTodoTransitionSummary(
  todos: Extract<StreamEvent, { type: 'todo' }>['todos'],
  state: OpenCodeStreamState,
): string | null {
  const transitions: Array<{ content: string; status: string; priority: string }> = []

  for (const todo of todos) {
    const previous = state.todoStatuses.get(todo.content)
    if (previous !== todo.status && (previous !== undefined || todo.status === 'in_progress' || todo.status === 'completed' || todo.status === 'cancelled')) {
      transitions.push(todo)
    }
    state.todoStatuses.set(todo.content, todo.status)
  }

  if (transitions.length === 0) return null

  const counts = transitions.reduce<Record<string, number>>((acc, todo) => {
    acc[todo.status] = (acc[todo.status] ?? 0) + 1
    return acc
  }, {})
  const countText = Object.entries(counts)
    .map(([status, count]) => `${count} ${status.replace(/_/g, ' ')}`)
    .join(', ')
  const examples = transitions
    .slice(0, 4)
    .map((todo) => `${todo.status}: ${todo.content}`)
  const suffix = transitions.length > examples.length ? `; +${transitions.length - examples.length} more` : ''
  return `[TASK] ${countText}: ${examples.join('; ')}${suffix}`
}

function questionLogContent(event: Extract<StreamEvent, { type: 'question' }>): string {
  if (event.action === 'asked') {
    const count = event.questions?.length ?? 0
    const preview = event.questions?.[0]?.question
    return `[QUESTION] AI asked ${count || 1} question${count === 1 ? '' : 's'}${preview ? `: ${preview}` : '.'}`
  }
  if (event.action === 'replied') return '[QUESTION] AI question answered.'
  return '[QUESTION] AI question rejected.'
}

function buildQuestionSsePayload(input: {
  ticketId: string
  ticketExternalId: string
  phase: WorkflowPhaseId
  memberId: string
  sessionId: string
  event: Extract<StreamEvent, { type: 'question' }>
}) {
  const ticket = getTicketByRef(input.ticketId)
  return {
    type: input.event.action === 'asked' ? 'opencode_question' : 'opencode_question_resolved',
    action: input.event.action,
    ticketId: input.ticketId,
    ticketExternalId: input.ticketExternalId,
    ticketTitle: ticket?.title ?? input.ticketExternalId,
    status: ticket?.status ?? input.phase,
    phase: input.phase,
    modelId: input.memberId || undefined,
    sessionId: input.sessionId,
    requestId: input.event.requestId,
    questions: input.event.questions ?? [],
    questionCount: input.event.questions?.length ?? 0,
    answers: input.event.answers,
    tool: input.event.tool,
    timestamp: new Date().toISOString(),
  }
}

export function mapCouncilStageToStatus(
  flow: 'interview' | 'prd' | 'beads',
  stage: 'draft' | 'vote' | 'refine',
): WorkflowPhaseId {
  if (flow === 'interview') {
    if (stage === 'draft') return 'COUNCIL_DELIBERATING'
    if (stage === 'vote') return 'COUNCIL_VOTING_INTERVIEW'
    return 'COMPILING_INTERVIEW'
  }
  if (flow === 'prd') {
    if (stage === 'draft') return 'DRAFTING_PRD'
    if (stage === 'vote') return 'COUNCIL_VOTING_PRD'
    return 'REFINING_PRD'
  }
  if (stage === 'draft') return 'DRAFTING_BEADS'
  if (stage === 'vote') return 'COUNCIL_VOTING_BEADS'
  return 'REFINING_BEADS'
}

export function formatCouncilMemberRoster(members: Array<{ modelId: string; name: string }>): string {
  return members.map(member => member.modelId).join(', ')
}

export function describeCouncilMemberSource(source: 'locked_ticket' | 'profile'): string {
  if (source === 'locked_ticket') return 'locked ticket config'
  return 'profile config'
}

export function formatCouncilResolutionLog(
  context: TicketContext,
  council: {
    members: Array<{ modelId: string; name: string }>
    source: 'locked_ticket' | 'profile'
  },
): string {
  const implementer = context.lockedMainImplementer ?? 'not configured'
  return `Council members resolved from ${describeCouncilMemberSource(council.source)}: ${council.members.length} members (${formatCouncilMemberRoster(council.members)}). Main implementer: ${implementer}.`
}

export function resolveInterviewDraftSettings(context: TicketContext): {
  maxInitialQuestions: number
  coverageFollowUpBudgetPercent: number
  draftTimeoutMs: number
  minQuorum: number
} {
  const councilSettings = resolveCouncilRuntimeSettings(context)
  const storedContext = getStoredTicketContext(context.ticketId)
  const profile = appDb.select().from(profiles).get()
  const maxInitialQuestions = context.lockedInterviewQuestions
    ?? storedContext?.localProject.interviewQuestions
    ?? profile?.interviewQuestions
    ?? 50

  return {
    maxInitialQuestions,
    coverageFollowUpBudgetPercent: resolveCoverageRuntimeSettings(context).coverageFollowUpBudgetPercent,
    draftTimeoutMs: councilSettings.draftTimeoutMs,
    minQuorum: councilSettings.minQuorum,
  }
}

export function resolveCoverageRuntimeSettings(context: TicketContext): {
  coverageFollowUpBudgetPercent: number
  maxCoveragePasses: number
  maxPrdCoveragePasses: number
  maxBeadsCoveragePasses: number
} {
  const profile = appDb.select().from(profiles).get()

  return {
    coverageFollowUpBudgetPercent: context.lockedCoverageFollowUpBudgetPercent
      ?? profile?.coverageFollowUpBudgetPercent
      ?? PROFILE_DEFAULTS.coverageFollowUpBudgetPercent,
    maxCoveragePasses: context.lockedMaxCoveragePasses
      ?? profile?.maxCoveragePasses
      ?? PROFILE_DEFAULTS.maxCoveragePasses,
    maxPrdCoveragePasses: context.lockedMaxPrdCoveragePasses
      ?? profile?.maxPrdCoveragePasses
      ?? PROFILE_DEFAULTS.maxPrdCoveragePasses,
    maxBeadsCoveragePasses: context.lockedMaxBeadsCoveragePasses
      ?? profile?.maxBeadsCoveragePasses
      ?? PROFILE_DEFAULTS.maxBeadsCoveragePasses,
  }
}

export function resolveStructuredRetryRuntimeSettings(context: TicketContext): {
  structuredRetryCount: number
} {
  const profile = appDb.select().from(profiles).get()

  return {
    structuredRetryCount: normalizeStructuredRetryCount(
      context.lockedStructuredRetryCount
        ?? profile?.structuredRetryCount
        ?? PROFILE_DEFAULTS.structuredRetryCount,
    ),
  }
}

export function resolveStructuredRetryCountForTicket(ticketId: string): number {
  const storedContext = getStoredTicketContext(ticketId)
  const profile = appDb.select().from(profiles).get()

  return normalizeStructuredRetryCount(
    storedContext?.localTicket.lockedStructuredRetryCount
      ?? profile?.structuredRetryCount
      ?? PROFILE_DEFAULTS.structuredRetryCount,
  )
}

export function getCoverageStateLabel(phase: 'interview' | 'prd' | 'beads'): WorkflowPhaseId {
  return phase === 'interview'
    ? 'VERIFYING_INTERVIEW_COVERAGE'
    : phase === 'prd'
      ? 'VERIFYING_PRD_COVERAGE'
      : 'VERIFYING_BEADS_COVERAGE'
}

export function getCoverageContextPhase(phase: 'interview' | 'prd' | 'beads'): 'interview_coverage' | 'prd_coverage' | 'beads_coverage' {
  return phase === 'interview'
    ? 'interview_coverage'
    : phase === 'prd'
      ? 'prd_coverage'
      : 'beads_coverage'
}

export function getCoveragePromptTemplate(phase: 'interview' | 'prd' | 'beads') {
  return phase === 'interview' ? PROM5 : phase === 'prd' ? PROM13 : PROM23
}

export function describeCoverageTerminationReason(reason: string): string {
  if (reason === 'coverage_pass_limit_reached') return 'retry cap reached'
  if (reason === 'follow_up_budget_exhausted') return 'follow-up budget exhausted'
  if (reason === 'follow_up_generation_failed') return 'follow-up generation failed'
  return 'manual review required'
}

export function buildCoveragePromptConfiguration(input: {
  phase: 'interview' | 'prd' | 'beads'
  coverageRunNumber: number
  maxCoveragePasses: number
  isFinalAllowedRun: boolean
  coverageFollowUpBudgetPercent?: number
  followUpBudgetTotal?: number
  followUpBudgetUsed?: number
  followUpBudgetRemaining?: number
}): PromptPart {
  const remainingCoverageRuns = Math.max(input.maxCoveragePasses - input.coverageRunNumber, 0)
  const lines = [
    '## Coverage Configuration',
    `coverage_domain: ${input.phase}`,
    `coverage_run_number: ${input.coverageRunNumber}`,
    `max_coverage_passes: ${input.maxCoveragePasses}`,
    `is_final_coverage_run: ${input.isFinalAllowedRun ? 'true' : 'false'}`,
    input.isFinalAllowedRun
      ? 'This is the final allowed coverage run. If gaps remain, report them clearly and do not assume another retry or refinement loop exists.'
      : remainingCoverageRuns === 1
        ? 'At most one more coverage run may occur after this one if real gaps remain.'
        : `Up to ${remainingCoverageRuns} more coverage runs may occur after this one if real gaps remain.`,
  ]

  if (input.phase === 'interview') {
    lines.push(
      `coverage_follow_up_budget_percent: ${input.coverageFollowUpBudgetPercent ?? PROFILE_DEFAULTS.coverageFollowUpBudgetPercent}`,
      `follow_up_budget_total: ${input.followUpBudgetTotal ?? 0}`,
      `follow_up_budget_used: ${input.followUpBudgetUsed ?? 0}`,
      `follow_up_budget_remaining: ${input.followUpBudgetRemaining ?? 0}`,
      (input.followUpBudgetRemaining ?? 0) === 0
        ? 'If gaps remain and follow_up_budget_remaining is 0, you MUST return `status: gaps`, concrete `gaps`, and `follow_up_questions: []`.'
        : 'If gaps remain, generate only the targeted follow-up questions that fit within follow_up_budget_remaining.',
    )
  } else if (input.phase === 'prd') {
    lines.push(
      'PRD coverage is envelope-only: return `follow_up_questions: []` and do not invent PRD follow-up questions.',
      'If you need to flag more work, use concrete `gaps` entries only.',
    )
  }

  return {
    type: 'text',
    source: 'coverage_settings',
    content: lines.join('\n'),
  }
}

export function resolveCouncilRuntimeSettings(context: TicketContext): {
  draftTimeoutMs: number
  minQuorum: number
} {
  const storedContext = getStoredTicketContext(context.ticketId)
  const profile = appDb.select().from(profiles).get()
  const draftTimeoutMs = storedContext?.localProject.councilResponseTimeout
    ?? profile?.councilResponseTimeout
    ?? PROFILE_DEFAULTS.councilResponseTimeout
  const minQuorum = storedContext?.localProject.minCouncilQuorum
    ?? profile?.minCouncilQuorum
    ?? PROFILE_DEFAULTS.minCouncilQuorum

  return {
    draftTimeoutMs,
    minQuorum,
  }
}

export function resolveAiResponseRuntimeSettings(context: TicketContext): {
  timeoutMs: number
  minQuorum: number
} {
  const councilSettings = resolveCouncilRuntimeSettings(context)
  return {
    timeoutMs: councilSettings.draftTimeoutMs,
    minQuorum: councilSettings.minQuorum,
  }
}

export function resolveAiResponseTimeoutForTicket(ticketId: string): number {
  const storedContext = getStoredTicketContext(ticketId)
  const profile = appDb.select().from(profiles).get()
  return storedContext?.localProject.councilResponseTimeout
    ?? profile?.councilResponseTimeout
    ?? PROFILE_DEFAULTS.councilResponseTimeout
}

export function resolveExecutionRuntimeSettings(context: TicketContext): {
  maxIterations: number
  perIterationTimeoutMs: number
  opencodeRetryLimit: number
  opencodeRetryDelayMs: number
  opencodeSteps: number
} {
  const storedContext = getStoredTicketContext(context.ticketId)
  const profile = appDb.select().from(profiles).get()
  const maxIterations = storedContext?.localProject.maxIterations
    ?? profile?.maxIterations
    ?? context.maxIterations
    ?? PROFILE_DEFAULTS.maxIterations
  const perIterationTimeoutMs = storedContext?.localProject.perIterationTimeout
    ?? profile?.perIterationTimeout
    ?? PROFILE_DEFAULTS.perIterationTimeout
  const opencodeRetryLimit = profile?.opencodeRetryLimit ?? PROFILE_DEFAULTS.opencodeRetryLimit
  const opencodeRetryDelayMs = profile?.opencodeRetryDelay ?? PROFILE_DEFAULTS.opencodeRetryDelay
  const opencodeSteps = profile?.opencodeSteps ?? PROFILE_DEFAULTS.opencodeSteps

  return {
    maxIterations,
    perIterationTimeoutMs,
    opencodeRetryLimit,
    opencodeRetryDelayMs,
    opencodeSteps,
  }
}

export function resolveExecutionSetupRuntimeSettings(context: TicketContext): {
  maxIterations: number
  timeoutMs: number
} {
  const storedContext = getStoredTicketContext(context.ticketId)
  const profile = appDb.select().from(profiles).get()
  const maxIterations = storedContext?.localProject.maxIterations
    ?? profile?.maxIterations
    ?? context.maxIterations
    ?? PROFILE_DEFAULTS.maxIterations
  const timeoutMs = storedContext?.localProject.executionSetupTimeout
    ?? profile?.executionSetupTimeout
    ?? PROFILE_DEFAULTS.executionSetupTimeout

  return {
    maxIterations,
    timeoutMs,
  }
}

export function formatDurationMs(durationMs: number): string {
  if (durationMs >= 60000) return `${(durationMs / 60000).toFixed(1)}m`
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(1)}s`
  return `${durationMs}ms`
}

export function formatDraftRoundSummary(
  label: string,
  elapsedMs: number,
  timeoutMs: number,
  deadlineReached: boolean,
  summary: {
    completed: number
    timedOut: number
    failed: number
    invalidOutput: number
  },
) {
  const timing = deadlineReached
    ? `reached configured deadline (${timeoutMs}ms)`
    : `completed in ${formatDurationMs(elapsedMs)}`

  return `${label} ${timing}: completed=${summary.completed}, timed_out=${summary.timedOut}, failed=${summary.failed}, invalid_output=${summary.invalidOutput}.`
}

export function summarizeDraftOutcomes(drafts: DraftResult[]) {
  return drafts.reduce(
    (summary, draft) => {
      if (draft.outcome === 'completed') summary.completed++
      else if (draft.outcome === 'timed_out') summary.timedOut++
      else if (draft.outcome === 'failed') summary.failed++
      else summary.invalidOutput++
      return summary
    },
    { completed: 0, timedOut: 0, invalidOutput: 0, failed: 0 },
  )
}

type StructuredFailureDiagnosticSource = {
  memberId?: string
  voterId?: string
  outcome?: MemberOutcome
  structuredOutput?: DraftStructuredOutputMeta
  rawAttempts?: RawAttempt[]
}

export function buildCouncilQuorumErrorWithDiagnostics(
  message: string,
  sources: StructuredFailureDiagnosticSource[],
): Error {
  const truncatedSource = sources.find((source) =>
    source.outcome !== 'completed'
    && (
      source.structuredOutput?.failureClass === 'output_truncated'
      || source.rawAttempts?.some((attempt) => attempt.failureClass === 'output_truncated')
    ),
  )
  if (!truncatedSource) return new Error(message)
  const modelId = truncatedSource.memberId ?? truncatedSource.voterId

  return attachOpenCodeBlockedErrorDiagnostics(
    new Error(message),
    buildOutputTruncatedBlockedErrorDiagnostics({
      ...(modelId ? { modelId } : {}),
    }),
  )
}

export function formatDraftFailureDetail(
  outcome: DraftResult['outcome'],
  error?: string,
  failureClass?: StructuredFailureClass,
) {
  if (outcome === 'timed_out') return 'timed out'
  if (outcome === 'invalid_output') {
    if (failureClass && error) return `invalid output (${failureClass}: ${error})`
    if (failureClass) return `invalid output (${failureClass})`
    return `invalid output (${error ?? 'malformed response'})`
  }
  if (outcome === 'failed') {
    return formatStructuredFailureForLog(failureClass, error)
  }
  return ''
}

export function emitDraftProgressInfoLog(
  ticketId: string,
  ticketExternalId: string,
  phase: WorkflowPhaseId,
  label: string,
  entry: DraftProgressEvent,
) {
  if (entry.status === 'session_created' && entry.sessionId) {
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      'info',
      `${label} draft session created for ${entry.memberId}: ${entry.sessionId}.`,
      {
        entryId: `${entry.sessionId}:created`,
        audience: 'ai',
        kind: 'session',
        op: 'append',
        source: `model:${entry.memberId}`,
        modelId: entry.memberId,
        sessionId: entry.sessionId,
        streaming: false,
      },
    )
    return
  }

  if (entry.status === 'finished' && entry.outcome && entry.outcome !== 'completed') {
    const detail = formatDraftFailureDetail(
      entry.outcome,
      entry.error,
      entry.structuredOutput?.failureClass,
    )
    const durationText = typeof entry.duration === 'number' ? ` after ${formatDurationMs(entry.duration)}` : ''
    const sessionText = entry.sessionId ? ` session=${entry.sessionId}` : ''
    emitAiDetail(
      ticketId,
      ticketExternalId,
      phase,
      'error',
      `${label} draft ${detail} for ${entry.memberId}${sessionText}${durationText}.`,
      {
        entryId: `${entry.sessionId ?? `${phase}:${entry.memberId}`}:draft-finished`,
        audience: 'ai',
        kind: 'error',
        op: 'append',
        source: `model:${entry.memberId}`,
        modelId: entry.memberId,
        sessionId: entry.sessionId,
        streaming: false,
      },
    )
  }
}

export function createPendingDrafts(members: Array<{ modelId: string }>): DraftResult[] {
  return members.map(member => ({
    memberId: member.modelId,
    content: '',
    outcome: 'pending',
    duration: 0,
  }))
}

export function tryBuildInterviewQuestionPreview(label: string, content?: string): string | null {
  if (!content?.trim()) return null

  try {
    const questions = parseInterviewQuestions(content, { allowTopLevelArray: true })
    if (questions.length === 0) return null
    return formatInterviewQuestionPreview(label, questions)
  } catch {
    return null
  }
}

export function upsertCouncilDraftArtifact(
  ticketId: string,
  phase: WorkflowPhaseId,
  artifactType: string,
  drafts: DraftResult[],
  memberOutcomes?: Record<string, MemberOutcome>,
  isFinal: boolean = false,
) {
  const resolvedOutcomes = memberOutcomes ?? drafts.reduce<Record<string, MemberOutcome>>(
    (acc, draft) => {
      acc[draft.memberId] = draft.outcome
      return acc
    },
    {},
  )

  const persistedDrafts = drafts.map((draft) => ({
    memberId: draft.memberId,
    outcome: draft.outcome,
    ...(draft.outcome === 'completed' && draft.content
      ? { content: draft.content }
      : {}),
  }))

  upsertLatestPhaseArtifact(ticketId, artifactType, phase, JSON.stringify({
    drafts: persistedDrafts,
    memberOutcomes: resolvedOutcomes,
    isFinal,
  }))

  persistUiArtifactCompanionArtifact(ticketId, phase, artifactType, {
    draftDetails: drafts.map((draft) => ({
      memberId: draft.memberId,
      ...(typeof draft.duration === 'number' ? { duration: draft.duration } : {}),
      ...(draft.error ? { error: draft.error } : {}),
      ...(typeof draft.questionCount === 'number' ? { questionCount: draft.questionCount } : {}),
      ...(draft.draftMetrics ? { draftMetrics: draft.draftMetrics } : {}),
      ...(draft.structuredOutput ? { structuredOutput: buildStructuredMetadata(draft.structuredOutput) } : {}),
      ...(typeof draft.rawResponse === 'string' ? { rawResponse: draft.rawResponse } : {}),
      ...(typeof draft.normalizedResponse === 'string' ? { normalizedResponse: draft.normalizedResponse } : {}),
      ...(draft.rawAttempts && draft.rawAttempts.length > 0 ? { rawAttempts: draft.rawAttempts } : {}),
      ...(draft.skippedReason ? { skippedReason: draft.skippedReason } : {}),
    })),
  })
}

export function upsertCouncilVoteArtifact(
  ticketId: string,
  phase: WorkflowPhaseId,
  artifactType: string,
  drafts: DraftResult[],
  votes: Vote[],
  memberOutcomes: Record<string, MemberOutcome>,
  voterDetails?: Array<{
    voterId: string
    error?: string
    rawResponse?: string
    normalizedResponse?: string
    structuredOutput?: DraftStructuredOutputMeta
    rawAttempts?: RawAttempt[]
  }>,
  presentationOrders?: Record<string, VotePresentationOrder>,
  winnerId?: string,
  totalScore?: number,
  isFinal: boolean = false,
) {
  upsertLatestPhaseArtifact(ticketId, artifactType, phase, JSON.stringify({
    ...(winnerId ? { winnerId } : {}),
    ...(isFinal ? { isFinal } : { isFinal: false }),
  }))

  persistUiArtifactCompanionArtifact(ticketId, phase, artifactType, {
    votes,
    voterOutcomes: memberOutcomes,
    ...(voterDetails && voterDetails.length > 0
      ? {
          voterDetails: voterDetails.map((detail) => ({
            ...detail,
            ...(typeof detail.rawResponse === 'string' ? { rawResponse: detail.rawResponse } : {}),
            ...(typeof detail.normalizedResponse === 'string' ? { normalizedResponse: detail.normalizedResponse } : {}),
            ...(detail.structuredOutput ? { structuredOutput: buildStructuredMetadata(detail.structuredOutput) } : {}),
          })),
        }
      : {}),
    ...(presentationOrders ? { presentationOrders } : {}),
    ...(winnerId ? { winnerId } : {}),
    ...(typeof totalScore === 'number' ? { totalScore } : {}),
    drafts: drafts.map((draft) => ({
      memberId: draft.memberId,
      outcome: draft.outcome,
      ...(draft.outcome === 'completed' && draft.content
        ? { content: draft.content }
        : {}),
    })),
  })
}

function getRecoveredDraftPhase(pipeline: 'interview' | 'prd' | 'beads'): string {
  if (pipeline === 'interview') return 'interview_draft'
  if (pipeline === 'prd') return 'prd_draft'
  return 'beads_draft'
}

function getPipelineDraftStatus(pipeline: 'interview' | 'prd' | 'beads'): string {
  if (pipeline === 'interview') return 'COUNCIL_DELIBERATING'
  if (pipeline === 'prd') return 'DRAFTING_PRD'
  return 'DRAFTING_BEADS'
}

function getPipelineVoteStatus(pipeline: 'interview' | 'prd' | 'beads'): string {
  if (pipeline === 'interview') return 'COUNCIL_VOTING_INTERVIEW'
  if (pipeline === 'prd') return 'COUNCIL_VOTING_PRD'
  return 'COUNCIL_VOTING_BEADS'
}

function recoverPersistedDrafts(
  drafts: unknown,
  memberOutcomes?: Record<string, MemberOutcome>,
): DraftResult[] {
  if (!Array.isArray(drafts)) return []

  return drafts.flatMap((draft) => {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return []
    const record = draft as Record<string, unknown>
    const memberId = typeof record.memberId === 'string' ? record.memberId : ''
    if (!memberId) return []

    const outcome = (
      record.outcome === 'completed'
      || record.outcome === 'pending'
      || record.outcome === 'timed_out'
      || record.outcome === 'invalid_output'
      || record.outcome === 'failed'
    )
      ? record.outcome
      : memberOutcomes?.[memberId] ?? 'pending'

    return [{
      memberId,
      outcome,
      content: typeof record.content === 'string' ? record.content : '',
      duration: 0,
    }]
  })
}

export function collectMembersByOutcome(
  memberOutcomes: Record<string, MemberOutcome>,
  outcome: MemberOutcome,
) {
  return Object.entries(memberOutcomes)
    .filter(([, memberOutcome]) => memberOutcome === outcome)
    .map(([memberId]) => memberId)
}

export function emitCouncilDecisionLogs(
  ticketId: string,
  externalId: string,
  phase: WorkflowPhaseId,
  timeoutMs: number,
  deadlineReached: boolean,
  memberOutcomes: Record<string, MemberOutcome>,
  quorum: { passed: boolean; message: string },
  nextStatus: string,
) {
  const completedMembers = collectMembersByOutcome(memberOutcomes, 'completed')
  const timedOutMembers = collectMembersByOutcome(memberOutcomes, 'timed_out')

  emitPhaseLog(
    ticketId,
    externalId,
    phase,
    'info',
    deadlineReached
      ? `Council response deadline reached after ${timeoutMs}ms. completed_members=${completedMembers.length > 0 ? completedMembers.join(', ') : 'none'}. timed_out_members=${timedOutMembers.length > 0 ? timedOutMembers.join(', ') : 'none'}.`
      : `Council responses settled before the ${timeoutMs}ms deadline. completed_members=${completedMembers.length > 0 ? completedMembers.join(', ') : 'none'}. timed_out_members=${timedOutMembers.length > 0 ? timedOutMembers.join(', ') : 'none'}.`,
  )
  emitPhaseLog(
    ticketId,
    externalId,
    phase,
    quorum.passed ? 'info' : 'error',
    `Council quorum ${quorum.passed ? 'passed' : 'failed'}: ${quorum.message}.`,
  )
  emitPhaseLog(
    ticketId,
    externalId,
    phase,
    'info',
    `Council transition selected: ${nextStatus}.`,
  )
}

export function resolveCouncilMembers(context: TicketContext): {
  members: Array<{ modelId: string; name: string; variant?: string }>
  source: 'locked_ticket' | 'profile'
} {
  let members: Array<{ modelId: string; name: string; variant?: string }> = []
  let source: 'locked_ticket' | 'profile' = 'profile'

  const variantMap: Record<string, string> = context.lockedCouncilMemberVariants
    ? (typeof context.lockedCouncilMemberVariants === 'string'
      ? JSON.parse(context.lockedCouncilMemberVariants as string)
      : context.lockedCouncilMemberVariants as Record<string, string>)
    : {}

  if (context.lockedCouncilMembers && context.lockedCouncilMembers.length > 0) {
    members = context.lockedCouncilMembers
      .map(id => ({ modelId: id, name: id.split('/').pop() ?? id, variant: variantMap[id] }))
    source = 'locked_ticket'
  } else {
    const profile = appDb.select().from(profiles).get()
    const configuredMembers = parseCouncilMembers(profile?.councilMembers)
    const profileVariants: Record<string, string> = profile?.councilMemberVariants
      ? (typeof profile.councilMemberVariants === 'string'
        ? JSON.parse(profile.councilMemberVariants)
        : profile.councilMemberVariants as Record<string, string>)
      : {}
    if (configuredMembers.length > 0) {
      members = configuredMembers
        .map(id => ({ modelId: id, name: id.split('/').pop() ?? id, variant: profileVariants[id] }))
      source = 'profile'
    }
  }

  if (members.length === 0) {
    throw new Error('No valid council members are configured for this ticket')
  }
  return { members, source }
}

export function loadTicketDirContext(context: TicketContext) {
  const ticket = getStoredTicketContext(context.ticketId)
  const paths = getTicketPaths(context.ticketId)

  if (!ticket || !paths) {
    throw new Error(`Ticket workspace not initialized: missing ticket context for ${context.externalId}`)
  }

  const worktreePath = paths.worktreePath
  const ticketDir = paths.ticketDir

  if (!existsSync(ticketDir)) {
    throw new Error(`Ticket workspace not initialized: missing ticket directory for ${context.externalId}`)
  }

  const relevantFilesPath = resolve(ticketDir, 'relevant-files.yaml')
  let relevantFiles: string | undefined
  if (existsSync(relevantFilesPath)) {
    try { relevantFiles = readFileSync(relevantFilesPath, 'utf-8') } catch { /* ignore */ }
  }

  return { worktreePath, ticket: ticket.localTicket, ticketDir, relevantFiles }
}

export function buildStructuredMetadata(
  base: Partial<StructuredOutputMetadata> | null | undefined,
  extra?: Partial<StructuredOutputMetadata>,
): StructuredOutputMetadata {
  return buildStructuredOutputMetadata(base, extra)
}

/**
 * Attempt to recover phaseIntermediate data from persisted artifacts after a
 * server restart. Returns true if the data was recovered (or already present).
 */
export function tryRecoverPhaseIntermediate(
  ticketId: string,
  context: TicketContext,
  pipeline: 'interview' | 'prd' | 'beads',
  needsVotes: boolean,
): boolean {
  const key = `${ticketId}:${pipeline}`
  if (phaseIntermediate.has(key)) return true

  try {
    const draftStatus = getPipelineDraftStatus(pipeline)
    const draftAttempt = getActivePhaseAttempt(ticketId, draftStatus)
    const artifact = getLatestPhaseArtifact(ticketId, `${pipeline}_drafts`, draftStatus, draftAttempt ?? undefined)
    if (!artifact) return false

    const result = JSON.parse(artifact.content) as {
      drafts?: unknown
      memberOutcomes?: Record<string, MemberOutcome>
      isFinal?: boolean
    }
    const recoveredDrafts = recoverPersistedDrafts(result.drafts, result.memberOutcomes)
    if (result.isFinal !== true || recoveredDrafts.length === 0) return false

    const { worktreePath, ticket, ticketDir, relevantFiles } = loadTicketDirContext(context)

    let contextBuilder: PhaseIntermediateData['contextBuilder']
    let baseTicketState: TicketState | undefined
    if (pipeline === 'interview') {
      const ticketState: TicketState = {
        ticketId: context.externalId,
        title: context.title,
        description: ticket?.description ?? '',
        relevantFiles,
      }
      baseTicketState = ticketState
    } else if (pipeline === 'prd') {
      const interviewPath = resolve(ticketDir, 'interview.yaml')
      const fullAnswersArtifact = getLatestPhaseArtifact(ticketId, 'prd_full_answers', draftStatus, draftAttempt ?? undefined)
      let interview: string | undefined
      let fullAnswers: string[] | undefined
      if (existsSync(interviewPath)) {
        try { interview = readFileSync(interviewPath, 'utf-8') } catch { /* ignore */ }
      }
      if (fullAnswersArtifact) {
        try {
          const parsed = JSON.parse(fullAnswersArtifact.content) as {
            drafts?: unknown
            memberOutcomes?: Record<string, MemberOutcome>
          }
          fullAnswers = recoverPersistedDrafts(parsed.drafts, parsed.memberOutcomes)
            .filter((draft) => draft.outcome === 'completed' && Boolean(draft.content))
            .map((draft) => draft.content)
        } catch {
          fullAnswers = undefined
        }
      }
      const ticketState: TicketState = {
        ticketId: context.externalId,
        title: context.title,
        description: ticket?.description ?? '',
        relevantFiles,
        interview,
        fullAnswers,
      }
      contextBuilder = buildPrdContextBuilder(ticketState)
      baseTicketState = ticketState
    } else {
      const prdPath = resolve(ticketDir, 'prd.yaml')
      let prd: string | undefined
      if (existsSync(prdPath)) {
        try { prd = readFileSync(prdPath, 'utf-8') } catch { /* ignore */ }
      }
      const ticketState: TicketState = {
        ticketId: context.externalId,
        title: context.title,
        description: ticket?.description ?? '',
        relevantFiles,
        prd,
      }
      contextBuilder = buildBeadsContextBuilder(ticketState)
    }

    const data: PhaseIntermediateData = {
      drafts: recoveredDrafts,
      memberOutcomes: result.memberOutcomes ?? {},
      worktreePath,
      phase: getRecoveredDraftPhase(pipeline),
      ticketState: baseTicketState,
    }
    if (pipeline === 'prd' && baseTicketState?.fullAnswers) {
      const fullAnswersArtifact = getLatestPhaseArtifact(ticketId, 'prd_full_answers', draftStatus, draftAttempt ?? undefined)
      if (fullAnswersArtifact) {
        try {
          const parsed = JSON.parse(fullAnswersArtifact.content) as {
            drafts?: unknown
            memberOutcomes?: Record<string, MemberOutcome>
          }
          data.fullAnswers = recoverPersistedDrafts(parsed.drafts, parsed.memberOutcomes)
        } catch {
          // Ignore malformed persisted full-answers artifact during recovery.
        }
      }
    }
    if (contextBuilder) {
      data.contextBuilder = contextBuilder
    }

    if (needsVotes) {
      const voteStatus = getPipelineVoteStatus(pipeline)
      const voteAttempt = getActivePhaseAttempt(ticketId, voteStatus)
      const voteArtifact = getLatestPhaseArtifact(ticketId, `${pipeline}_votes`, voteStatus, voteAttempt ?? undefined)
      if (!voteArtifact) return false
      const voteResult = JSON.parse(voteArtifact.content) as {
        winnerId: string
        isFinal?: boolean
      }
      if (voteResult.isFinal !== true) return false
      data.winnerId = voteResult.winnerId
    }

    phaseIntermediate.set(key, data)
    console.log(`[runner] Recovered ${pipeline} intermediate data from persisted artifact for ticket ${context.externalId}`)
    return true
  } catch (err) {
    console.error(`[runner] Failed to recover ${pipeline} intermediate data for ticket ${context.externalId}: ${getErrorMessage(err)}`)
    return false
  }
}
