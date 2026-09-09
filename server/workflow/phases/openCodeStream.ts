import { STREAMING_LOG_MIN_INTERVAL_MS, buildBeadLogFields, emitDebugLog, emitModelSystemLog, emitPhaseLog, formatStreamEventDuration, formatTimestamp, getToolLogLimits, normalizeAttachmentMetadata, stringifyToolDetail, type ToolLogLimits } from './logEmission'
import { formatTodoTransitionSummary } from './todoSummary'
import { broadcaster } from '../../sse/broadcaster'
import type { LogEventType } from '../../log/types'
import { buildOpenCodeQuestionLogIdentity } from '@shared/logIdentity'
import { analyzeAssistantMessages } from '../../opencode/assistantMessageAnalysis'
import { hasRichModelErrorInfo, summarizeModelErrorForLog } from '../../opencode/errorDetails'
import type { Message, MessagePart, StreamEvent } from '../../opencode/types'
import {
  getTicketByRef,
} from '../../storage/tickets'
import type { OpenCodePromptDispatchEvent } from '../runOpenCodePrompt'
import { buildSessionStatusLogEntries } from '../sessionStatusLogging'
import type { StructuredLogFields, OpenCodeStreamState } from './types'
import { resolveAiQuestionSettings } from '../aiQuestionSettings'
import { resolvePhaseAttempt } from '../../storage/ticketPhaseAttempts'
import {
  attachRequest,
  markRequestRejectedExternally,
  markRequestReplied,
} from '../questionWindows'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

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
    ? ` (${formatStreamEventDuration(event.durationMs)})`
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
