import type {
  Message,
  MessageInfo,
  MessagePart,
  OpenCodePermissionRule,
  OpenCodeQuestionAnswer,
  OpenCodeQuestionInfo,
  OpenCodeQuestionRequest,
  PromptPart,
  Session,
  StepFinishMessagePart,
  StreamEvent,
  ToolMessagePart,
} from './types'
import type { OpenCodeTransportEvent, OpenCodeTransportEventEnvelope } from './transport'

type RecordValue = Record<string, unknown>

export interface V2PromptPayload {
  text: string
  files: Array<{ uri: string; name?: string }>
  instructions?: string
}

export interface V2EventMappingState {
  text: Map<string, string>
  reasoning: Map<string, string>
  toolNames: Map<string, string>
  toolInputs: Map<string, RecordValue>
  toolInputText: Map<string, string>
  questions: Map<string, OpenCodeQuestionRequest>
  questionKeys: Map<string, string[]>
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export function createV2EventMappingState(): V2EventMappingState {
  return {
    text: new Map(),
    reasoning: new Map(),
    toolNames: new Map(),
    toolInputs: new Map(),
    toolInputText: new Map(),
    questions: new Map(),
    questionKeys: new Map(),
  }
}

export function mapV2Session(value: unknown): Session {
  const session = asRecord(value)
  if (!session || typeof session.id !== 'string') throw new Error('OpenCode v2 returned a session without an id')
  const location = asRecord(session.location)
  const time = asRecord(session.time)
  const directory = stringValue(location?.directory) ?? stringValue(session.directory)

  return {
    id: session.id,
    slug: stringValue(session.slug),
    projectPath: directory,
    directory,
    createdAt: isoTime(time?.created),
    updatedAt: isoTime(time?.updated),
    title: stringValue(session.title),
    version: stringValue(session.version),
  }
}

export function mapV2PermissionRules(rules?: ReadonlyArray<OpenCodePermissionRule>) {
  return (rules ?? []).map(rule => ({
    action: mapPermissionName(rule.permission),
    resource: rule.pattern,
    effect: rule.action,
  }))
}

export function mapV2PromptParts(parts: PromptPart[], fallbackSystem?: string): V2PromptPayload {
  const text: string[] = []
  const instructions = [fallbackSystem?.trim()]
  const files: V2PromptPayload['files'] = []

  for (const part of parts) {
    if (part.type === 'system') {
      if (part.content.trim()) instructions.push(part.content.trim())
      continue
    }
    if (part.type === 'text') {
      if (part.content) text.push(part.content)
      continue
    }

    const uri = part.url ?? (/^(?:data|file):/i.test(part.content) ? part.content : undefined)
    if (!uri) throw new Error('OpenCode v2 file parts require a data: or file: URL')
    const scheme = safeProtocol(uri)
    if (scheme !== 'data:' && scheme !== 'file:') {
      throw new Error(`OpenCode v2 does not support ${scheme ?? 'this'} file URL scheme`)
    }
    if (scheme === 'data:' && dataUrlBytes(uri) > MAX_ATTACHMENT_BYTES) {
      throw new Error(`OpenCode v2 file attachments are limited to ${MAX_ATTACHMENT_BYTES} bytes`)
    }
    files.push({ uri, ...(part.filename ? { name: part.filename } : {}) })
  }

  const systemText = instructions.filter((value): value is string => Boolean(value)).join('\n\n')
  return {
    text: text.join('\n\n'),
    files,
    ...(systemText ? { instructions: systemText } : {}),
  }
}

export function mapV2Message(value: unknown, fallbackSessionId?: string): Message | null {
  const raw = asRecord(value)
  if (!raw || typeof raw.id !== 'string') return null
  const kind = stringValue(raw.type) ?? stringValue(raw.role)
  if (kind !== 'user' && kind !== 'assistant' && kind !== 'system' && kind !== 'synthetic') return null

  const sessionID = stringValue(raw.sessionID) ?? fallbackSessionId
  if (!sessionID) return null
  const time = asRecord(raw.time)
  const created = numberValue(time?.created)
  const completed = numberValue(time?.completed)
  const timestamp = isoTime(created)
  const model = asRecord(raw.model)
  const variant = stringValue(model?.variant) ?? stringValue(raw.variant)
  const info: MessageInfo = {
    id: raw.id,
    sessionID,
    role: kind === 'synthetic' ? 'system' : kind,
    ...(stringValue(raw.agent) ? { sender: raw.agent as string, author: raw.agent as string } : {}),
    ...(stringValue(model?.providerID) ? { providerID: model?.providerID as string } : {}),
    ...(stringValue(model?.id) ? { modelID: model?.id as string } : {}),
    ...(variant ? { variant } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(created !== undefined || completed !== undefined
      ? { time: { ...(created !== undefined ? { created } : {}), ...(completed !== undefined ? { completed } : {}) } }
      : {}),
    ...(raw.error !== undefined ? { error: raw.error } : {}),
    ...(raw.finish !== undefined ? { finish: raw.finish } : {}),
    ...(raw.cost !== undefined ? { cost: raw.cost } : {}),
    ...(raw.tokens !== undefined ? { tokens: raw.tokens } : {}),
    ...(raw.snapshot !== undefined ? { snapshot: raw.snapshot } : {}),
  }

  if (kind !== 'assistant') {
    const content = stringValue(raw.text)
    const parts: MessagePart[] = []
    if (content) {
      parts.push({
        id: `${raw.id}:text`,
        sessionID,
        messageID: raw.id,
        type: 'text',
        text: content,
      })
    }
    for (const [index, fileValue] of arrayValue(raw.files).entries()) {
      const file = asRecord(fileValue)
      if (!file) continue
      parts.push({
        id: `${raw.id}:file:${index}`,
        sessionID,
        messageID: raw.id,
        type: 'file',
        filename: stringValue(file.name),
        mime: stringValue(file.mime),
        source: file.source,
      })
    }
    return {
      id: raw.id,
      role: info.role,
      content,
      timestamp,
      info,
      parts,
    }
  }

  const parts = arrayValue(raw.content)
    .map((part, index) => mapV2AssistantPart(part, raw.id as string, sessionID, index))
    .filter((part): part is MessagePart => part !== null)
  const snapshot = asRecord(raw.snapshot)
  const finish = stringValue(raw.finish)
  if (finish || raw.cost !== undefined || raw.tokens !== undefined || snapshot) {
    const snapshotId = stringValue(snapshot?.end) ?? stringValue(snapshot?.start)
    const tokens = mapTokens(raw.tokens)
    parts.push({
      id: `${raw.id}:step-finish`,
      sessionID,
      messageID: raw.id,
      type: 'step-finish',
      reason: finish ?? 'unknown',
      ...(snapshotId ? { snapshot: snapshotId } : {}),
      ...(numberValue(raw.cost) !== undefined ? { cost: numberValue(raw.cost) } : {}),
      ...(tokens ? { tokens } : {}),
    })
  }
  const text = parts
    .filter(part => part.type === 'text' && !(part as { ignored?: boolean }).ignored)
    .map(part => (part as { text?: string }).text ?? '')
    .join('')

  return {
    id: raw.id,
    role: 'assistant',
    content: text || undefined,
    timestamp,
    info,
    parts,
  }
}

export function mapV2Question(value: unknown): OpenCodeQuestionRequest | null {
  const form = asRecord(value)
  const metadata = asRecord(form?.metadata)
  if (!form || metadata?.kind !== 'question' || typeof form.id !== 'string' || typeof form.sessionID !== 'string') return null

  const title = stringValue(form.title) ?? 'Question'
  const questions = arrayValue(form.fields)
    .map(field => mapQuestionField(field, title))
    .filter((question): question is OpenCodeQuestionInfo => question !== null)
  if (questions.length === 0) return null

  const toolMeta = asRecord(metadata.tool)
  const messageID = stringValue(toolMeta?.messageID)
  const callID = stringValue(toolMeta?.id) ?? stringValue(toolMeta?.callID)
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions,
    ...(messageID && callID ? { tool: { messageID, callID } } : {}),
  }
}

export function mapV2QuestionAnswer(
  formValue: unknown,
  answers: OpenCodeQuestionAnswer[],
): Record<string, string | string[]> {
  const form = asRecord(formValue)
  if (!form || !isQuestionForm(form)) throw new Error('OpenCode v2 form is not a pending question')
  const fields = arrayValue(form.fields).filter(field => mapQuestionField(field, stringValue(form.title) ?? 'Question'))
  if (answers.length > fields.length) throw new Error('OpenCode v2 question answer count exceeds the form fields')

  const result: Record<string, string | string[]> = {}
  for (let index = 0; index < answers.length; index++) {
    const field = asRecord(fields[index])
    if (!field) continue
    const key = stringValue(field.key) ?? `q${index}`
    const values = answers[index] ?? []
    if (field.type === 'multiselect') {
      result[key] = [...values]
    } else if (values.length > 1) {
      throw new Error(`OpenCode v2 single-select question ${key} received multiple answers`)
    } else if (values.length === 1) {
      result[key] = values[0]!
    }
  }
  return result
}

export function mapV2Event(
  value: unknown,
  sessionId: string,
  state: V2EventMappingState = createV2EventMappingState(),
  allowScopedEvent = false,
): OpenCodeTransportEventEnvelope | null {
  const raw = asRecord(value)
  if (!raw || typeof raw.type !== 'string') return null
  const data = asRecord(raw.data) ?? {}
  const rawSessionId = stringValue(data.sessionID) ?? stringValue(asRecord(data.form)?.sessionID)
  if (rawSessionId && rawSessionId !== sessionId) return null
  if (!rawSessionId && !allowScopedEvent) return null
  const aggregateId = stringValue(asRecord(raw.durable)?.aggregateID)
  if (aggregateId && aggregateId !== sessionId) return null

  const cursor = numberValue(asRecord(raw.durable)?.seq)
  const event = mapEventData(raw, data, sessionId, state)
  if (event) return { event, ...(cursor !== undefined ? { cursor } : {}) }
  return cursor !== undefined
    && V2_DURABLE_EVENT_TYPES.has(raw.type)
    && V2_CURSOR_ONLY_EVENTS.has(raw.type)
    ? { cursor }
    : null
}

// DurableDefinitions in the pinned OpenCode v2.0.16 session-event manifest.
const V2_DURABLE_EVENT_TYPES = new Set([
  'session.created',
  'session.agent.selected',
  'session.model.selected',
  'session.moved',
  'session.renamed',
  'session.metadata.updated',
  'session.permissions',
  'session.viewed',
  'session.message.content.updated',
  'session.usage.recorded',
  'session.deleted',
  'session.forked',
  'session.inbox.delivered',
  'session.inbox.enqueued',
  'session.inbox.cancelled',
  'session.inbox.delivery.changed',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.instructions.updated',
  'session.synthetic',
  'session.skill.activated',
  'session.shell.started',
  'session.shell.ended',
  'session.step.started',
  'session.step.streamed',
  'session.step.ended',
  'session.step.failed',
  'session.text.started',
  'session.text.ended',
  'session.reasoning.started',
  'session.reasoning.ended',
  'session.tool.input.started',
  'session.tool.input.ended',
  'session.tool.called',
  'session.tool.success',
  'session.tool.failed',
  'session.retry.scheduled',
  'session.compaction.started',
  'session.compaction.ended',
  'session.compaction.failed',
  'session.revert.staged',
  'session.revert.cleared',
  'session.revert.committed',
])

const V2_CURSOR_ONLY_EVENTS = new Set([
  'session.created',
  'session.agent.selected',
  'session.model.selected',
  'session.moved',
  'session.renamed',
  'session.deleted',
  'session.forked',
  'session.permissions',
  'session.viewed',
  'session.metadata.updated',
  'session.message.content.updated',
  'session.usage.recorded',
  'session.instructions.updated',
  'session.synthetic',
  'session.skill.activated',
  'session.shell.started',
  'session.shell.ended',
  'session.step.streamed',
  'session.retry.scheduled',
  'session.compaction.started',
  'session.compaction.ended',
  'session.compaction.failed',
  'session.revert.staged',
  'session.revert.cleared',
  'session.revert.committed',
])

export function isV2QuestionForm(value: unknown): boolean {
  const form = asRecord(value)
  return form !== null && isQuestionForm(form)
}

function mapEventData(
  raw: RecordValue,
  data: RecordValue,
  sessionId: string,
  state: V2EventMappingState,
): OpenCodeTransportEvent | null {
  const type = raw.type as string
  const messageId = stringValue(data.assistantMessageID) ?? stringValue(data.messageID)
  const ordinal = numberValue(data.ordinal)
  const partId = messageId && ordinal !== undefined ? `${messageId}:${ordinal}` : undefined

  switch (type) {
    case 'session.inbox.enqueued':
    case 'session.inbox.delivered': {
      const inboxID = stringValue(data.inboxID)
      return inboxID ? { type: type === 'session.inbox.enqueued' ? 'inbox_enqueued' : 'inbox_delivered', sessionId, inboxID } : null
    }
    case 'session.inbox.cancelled': {
      const inboxID = stringValue(data.inboxID)
      return inboxID ? { type: 'inbox_cancelled', sessionId, inboxID } : null
    }
    case 'session.inbox.delivery.changed': {
      const inboxID = stringValue(data.inboxID)
      const delivery = data.delivery
      return inboxID && (delivery === 'steer' || delivery === 'queue')
        ? { type: 'inbox_delivery_changed', sessionId, inboxID, delivery }
        : null
    }
    case 'session.execution.started':
      return { type: 'execution_started', sessionId }
    case 'session.execution.succeeded':
      return { type: 'execution_terminal', sessionId, outcome: 'succeeded' }
    case 'session.execution.failed':
      return { type: 'execution_terminal', sessionId, outcome: 'failed', error: data.error }
    case 'session.execution.interrupted':
      return { type: 'execution_terminal', sessionId, outcome: 'interrupted', error: data.reason }
    case 'session.text.started':
      if (!messageId || !partId) return null
      state.text.set(partId, '')
      return { type: 'text', sessionId, messageId, partId, text: '', streaming: true, complete: false }
    case 'session.text.delta': {
      if (!messageId || !partId) return null
      const delta = stringValue(data.delta) ?? ''
      const text = `${state.text.get(partId) ?? ''}${delta}`
      state.text.set(partId, text)
      return { type: 'text', sessionId, messageId, partId, text, delta, streaming: true, complete: false }
    }
    case 'session.text.ended': {
      if (!messageId || !partId) return null
      const text = stringValue(data.text) ?? state.text.get(partId) ?? ''
      state.text.set(partId, text)
      return { type: 'text', sessionId, messageId, partId, text, streaming: false, complete: true }
    }
    case 'session.reasoning.started':
      if (!messageId || !partId) return null
      state.reasoning.set(partId, '')
      return { type: 'reasoning', sessionId, messageId, partId, text: '', streaming: true, complete: false }
    case 'session.reasoning.delta': {
      if (!messageId || !partId) return null
      const delta = stringValue(data.delta) ?? ''
      const text = `${state.reasoning.get(partId) ?? ''}${delta}`
      state.reasoning.set(partId, text)
      return { type: 'reasoning', sessionId, messageId, partId, text, delta, streaming: true, complete: false }
    }
    case 'session.reasoning.ended': {
      if (!messageId || !partId) return null
      const text = stringValue(data.text) ?? state.reasoning.get(partId) ?? ''
      state.reasoning.set(partId, text)
      return { type: 'reasoning', sessionId, messageId, partId, text, streaming: false, complete: true }
    }
    case 'session.step.started':
      return {
        type: 'step',
        sessionId,
        messageId,
        step: 'start',
        snapshot: stringValue(data.snapshot),
        complete: false,
      }
    case 'session.step.ended':
      return {
        type: 'step',
        sessionId,
        messageId,
        step: 'finish',
        reason: stringValue(data.finish) ?? 'unknown',
        snapshot: stringValue(data.snapshot),
        cost: numberValue(data.cost),
        tokens: mapTokens(data.tokens),
        complete: true,
      }
    case 'session.step.failed':
      return {
        type: 'session_error',
        sessionId,
        error: errorText(data.error),
        details: data.error,
      }
    case 'session.tool.input.started': {
      const id = stringValue(data.id)
      const tool = stringValue(data.name)
      if (!id || !tool) return null
      state.toolNames.set(id, tool)
      state.toolInputs.set(id, {})
      state.toolInputText.set(id, '')
      return mapToolEvent(sessionId, messageId, id, tool, 'pending', {}, { title: tool })
    }
    case 'session.tool.input.delta': {
      const id = stringValue(data.id)
      if (!id) return null
      const tool = state.toolNames.get(id) ?? id
      const inputText = `${state.toolInputText.get(id) ?? ''}${stringValue(data.delta) ?? ''}`
      const input = parseInput(inputText)
      state.toolInputText.set(id, inputText)
      state.toolInputs.set(id, input)
      return mapToolEvent(sessionId, messageId, id, tool, 'pending', input)
    }
    case 'session.tool.input.ended': {
      const id = stringValue(data.id)
      if (!id) return null
      const tool = state.toolNames.get(id) ?? id
      const inputText = stringValue(data.text) ?? ''
      const input = parseInput(inputText)
      state.toolInputText.set(id, inputText)
      state.toolInputs.set(id, input)
      return mapToolEvent(sessionId, messageId, id, tool, 'pending', input, { raw: inputText })
    }
    case 'session.tool.called': {
      const id = stringValue(data.id)
      if (!id) return null
      const input = asRecord(data.input) ?? state.toolInputs.get(id) ?? {}
      state.toolInputs.set(id, input)
      return mapToolEvent(sessionId, messageId, id, state.toolNames.get(id) ?? id, 'running', input)
    }
    case 'session.tool.progress': {
      const id = stringValue(data.id)
      if (!id) return null
      return mapToolEvent(sessionId, messageId, id, state.toolNames.get(id) ?? id, 'running', state.toolInputs.get(id) ?? {}, {
        metadata: asRecord(data.metadata),
      })
    }
    case 'session.tool.success': {
      const id = stringValue(data.id)
      if (!id) return null
      const content = arrayValue(data.content)
      const output = contentText(content)
      const attachments = contentAttachments(content)
      const event = mapToolEvent(sessionId, messageId, id, state.toolNames.get(id) ?? id, 'completed', state.toolInputs.get(id) ?? {}, {
        output,
        metadata: asRecord(data.metadata),
        attachments,
      })
      state.toolNames.delete(id)
      state.toolInputs.delete(id)
      state.toolInputText.delete(id)
      return event
    }
    case 'session.tool.failed': {
      const id = stringValue(data.id)
      if (!id) return null
      const content = arrayValue(data.content)
      const event = mapToolEvent(sessionId, messageId, id, state.toolNames.get(id) ?? id, 'error', state.toolInputs.get(id) ?? {}, {
        error: errorText(data.error),
        metadata: asRecord(data.metadata),
        output: contentText(content),
        attachments: contentAttachments(content),
      })
      state.toolNames.delete(id)
      state.toolInputs.delete(id)
      state.toolInputText.delete(id)
      return event
    }
    case 'session.status':
    case 'session.status.updated': {
      const status = asRecord(data.status)
      const statusType = stringValue(status?.type) ?? stringValue(data.status)
      if (!statusType) return null
      return {
        type: 'session_status',
        sessionId,
        status: statusType === 'retry' ? 'retry' : statusType === 'idle' ? 'idle' : 'busy',
        attempt: numberValue(status?.attempt),
        message: stringValue(status?.message),
        next: numberValue(status?.next),
      }
    }
    case 'permission.asked':
      if (!stringValue(data.id)) return null
      return {
        type: 'permission',
        sessionId,
        action: 'asked',
        permissionId: stringValue(data.id)!,
        permission: stringValue(data.action) ? mapPermissionEventName(stringValue(data.action)!) : undefined,
        patterns: stringArray(data.resources),
        details: asRecord(data.metadata) ?? (stringValue(data.message) ? { message: data.message } : undefined),
      }
    case 'permission.replied':
      if (!stringValue(data.requestID)) return null
      return {
        type: 'permission',
        sessionId,
        action: 'replied',
        permissionId: stringValue(data.requestID)!,
        details: { reply: data.reply },
      }
    case 'form.created': {
      const form = data.form
      const question = mapV2Question(form)
      if (!question) return null
      state.questions.set(question.id, question)
      state.questionKeys.set(question.id, mapQuestionFieldKeys(form))
      return {
        type: 'question',
        sessionId,
        action: 'asked',
        requestId: question.id,
        questions: question.questions,
        tool: question.tool,
      }
    }
    case 'form.replied': {
      const requestId = stringValue(data.id)
      if (!requestId) return null
      const question = state.questions.get(requestId)
      const answers = mapFormEventAnswers(question, data.answer, state.questionKeys.get(requestId))
      state.questions.delete(requestId)
      state.questionKeys.delete(requestId)
      return { type: 'question', sessionId, action: 'replied', requestId, answers, tool: question?.tool }
    }
    case 'form.cancelled': {
      const requestId = stringValue(data.id)
      if (!requestId) return null
      const question = state.questions.get(requestId)
      state.questions.delete(requestId)
      state.questionKeys.delete(requestId)
      return { type: 'question', sessionId, action: 'rejected', requestId, tool: question?.tool }
    }
    case 'session.usage.updated':
      return {
        type: 'debug_event',
        sessionId,
        eventName: type,
        summary: 'Session usage updated',
        details: { cost: data.cost, tokens: data.tokens },
      }
    case 'session.retry.scheduled':
      return {
        type: 'debug_event',
        sessionId,
        messageId,
        eventName: type,
        summary: 'Session retry scheduled',
        details: { attempt: data.attempt, at: data.at, error: data.error },
        severity: 'error',
      }
    default:
      return null
  }
}

function mapV2AssistantPart(value: unknown, messageID: string, sessionID: string, index: number): MessagePart | null {
  const part = asRecord(value)
  if (!part || typeof part.type !== 'string') return null
  const id = stringValue(part.id) ?? `${messageID}:${index}`
  const base = { id, sessionID, messageID }

  if (part.type === 'text' || part.type === 'reasoning') {
    const time = asRecord(part.time)
    return {
      ...base,
      type: part.type,
      text: stringValue(part.text) ?? '',
      ...(part.type === 'text' && typeof part.synthetic === 'boolean' ? { synthetic: part.synthetic } : {}),
      ...(part.type === 'text' && typeof part.ignored === 'boolean' ? { ignored: part.ignored } : {}),
      ...(time ? { time: { start: numberValue(time.created), end: numberValue(time.completed) } } : {}),
      ...(asRecord(part.state) ? { metadata: asRecord(part.state) } : {}),
    } as MessagePart
  }

  if (part.type === 'tool') return mapV2ToolPart(part, base)
  return { ...base, ...part } as MessagePart
}

function mapV2ToolPart(part: RecordValue, base: { id: string; sessionID: string; messageID: string }): ToolMessagePart {
  const state = asRecord(part.state) ?? {}
  const wireStatus = stringValue(state.status)
  const status: ToolMessagePart['state']['status'] = wireStatus === 'completed'
    ? 'completed'
    : wireStatus === 'error'
      ? 'error'
      : wireStatus === 'streaming' || wireStatus === 'running'
        ? 'running'
        : 'pending'
  const time = asRecord(state.time) ?? asRecord(part.time)
  const content = arrayValue(state.content)
  const err = state.error

  return {
    ...base,
    type: 'tool',
    callID: stringValue(part.id) ?? base.id,
    tool: stringValue(part.name) ?? 'tool',
    state: {
      status,
      ...(asRecord(state.input) ? { input: asRecord(state.input)! } : {}),
      ...(stringValue(state.title) ? { title: state.title as string } : {}),
      ...(content.length > 0 ? { output: contentText(content) } : {}),
      ...(err !== undefined ? { error: errorText(err) } : {}),
      ...(asRecord(state.metadata) ? { metadata: asRecord(state.metadata)! } : {}),
      ...(time ? {
        time: {
          ...(numberValue(time.created) !== undefined ? { start: numberValue(time.created) } : {}),
          ...(numberValue(time.ran) !== undefined ? { start: numberValue(time.ran) } : {}),
          ...(numberValue(time.completed) !== undefined ? { end: numberValue(time.completed) } : {}),
        },
      } : {}),
      ...(content.length > 0 ? { attachments: contentAttachments(content) } : {}),
      ...(stringValue(state.raw) ? { raw: state.raw as string } : {}),
    },
    ...(asRecord(part.metadata) ? { metadata: asRecord(part.metadata)! } : {}),
  }
}

function mapToolEvent(
  sessionId: string,
  messageId: string | undefined,
  callId: string,
  tool: string,
  status: ToolMessagePart['state']['status'],
  input: RecordValue,
  extras: {
    title?: string
    raw?: string
    output?: string
    error?: string
    metadata?: RecordValue | null
    attachments?: Array<RecordValue>
  } = {},
): StreamEvent {
  return {
    type: 'tool',
    sessionId,
    messageId,
    partId: callId,
    tool,
    callId,
    status,
    input,
    title: extras.title,
    output: extras.output,
    error: extras.error,
    metadata: extras.metadata ?? undefined,
    attachments: extras.attachments,
    complete: status === 'completed' || status === 'error',
  }
}

function mapQuestionField(value: unknown, header: string): OpenCodeQuestionInfo | null {
  const field = asRecord(value)
  if (!field || field.type === 'external') return null
  const title = stringValue(field.title)
  const options = arrayValue(field.options).map(option => {
    const rawOption = asRecord(option)
    if (!rawOption) return null
    const label = stringValue(rawOption.label)
    const optionValue = stringValue(rawOption.value)
    if (label === undefined || optionValue === undefined) return null
    return {
      label,
      value: optionValue,
      ...(stringValue(rawOption.description) ? { description: rawOption.description as string } : {}),
    }
  }).filter((option): option is NonNullable<typeof option> => option !== null)

  return {
    question: stringValue(field.description) ?? title ?? stringValue(field.key) ?? header,
    header: title ?? header,
    options,
    ...(field.type === 'multiselect' ? { multiple: true } : {}),
    custom: field.type === 'string'
      ? field.options === undefined || field.custom === true
      : field.custom === true,
  }
}

function mapFormEventAnswers(
  question: OpenCodeQuestionRequest | undefined,
  answerValue: unknown,
  fieldKeys?: string[],
): OpenCodeQuestionAnswer[] | undefined {
  const answer = asRecord(answerValue)
  if (!answer) return undefined
  if (!question) return Object.values(answer).map(value => typeof value === 'string' ? [value] : stringArray(value))
  return question.questions.map((_, index) => {
    const key = fieldKeys?.[index] ?? `q${index}`
    const value = Object.hasOwn(answer, key) ? answer[key] : answer[`q${index}`]
    return typeof value === 'string' ? [value] : stringArray(value)
  })
}

function mapQuestionFieldKeys(value: unknown): string[] {
  const form = asRecord(value)
  const header = stringValue(form?.title) ?? 'Question'
  return arrayValue(form?.fields).flatMap((field, index) => {
    if (!mapQuestionField(field, header)) return []
    return [stringValue(asRecord(field)?.key) ?? `q${index}`]
  })
}

function mapTokens(value: unknown): StepFinishMessagePart['tokens'] | undefined {
  const tokens = asRecord(value)
  if (!tokens) return undefined
  const cache = asRecord(tokens.cache)
  return {
    ...(numberValue(tokens.input) !== undefined ? { input: numberValue(tokens.input) } : {}),
    ...(numberValue(tokens.output) !== undefined ? { output: numberValue(tokens.output) } : {}),
    ...(numberValue(tokens.reasoning) !== undefined ? { reasoning: numberValue(tokens.reasoning) } : {}),
    ...(cache ? {
      cache: {
        ...(numberValue(cache.read) !== undefined ? { read: numberValue(cache.read) } : {}),
        ...(numberValue(cache.write) !== undefined ? { write: numberValue(cache.write) } : {}),
      },
    } : {}),
  }
}

function contentText(content: unknown[]): string {
  return content.flatMap(item => {
    const part = asRecord(item)
    return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  }).join('')
}

function contentAttachments(content: unknown[]): Array<RecordValue> {
  return content.flatMap(item => {
    const part = asRecord(item)
    if (part?.type !== 'file') return []
    const mime = stringValue(part.mime)
    const name = stringValue(part.name)
    return [{ ...(name ? { filename: name } : {}), ...(mime ? { mime } : {}) }]
  })
}

function parseInput(value: string): RecordValue {
  try {
    const parsed: unknown = JSON.parse(value)
    return asRecord(parsed) ?? { value: parsed }
  } catch {
    return { raw: value }
  }
}

function errorText(value: unknown): string {
  const error = asRecord(value)
  return stringValue(error?.message) ?? stringValue(error?.name) ?? (typeof value === 'string' ? value : 'OpenCode v2 execution failed')
}

function isQuestionForm(form: RecordValue): boolean {
  return asRecord(form.metadata)?.kind === 'question'
}

function mapPermissionName(name: string): string {
  if (name === 'bash') return 'shell'
  if (name === 'task') return 'subagent'
  if (name === 'write') return 'edit'
  return name
}

function mapPermissionEventName(name: string): string {
  if (name === 'shell') return 'bash'
  if (name === 'subagent') return 'task'
  if (name === 'edit') return 'write'
  return name
}

function dataUrlBytes(value: string): number {
  const comma = value.indexOf(',')
  if (comma < 0) return Number.POSITIVE_INFINITY
  const metadata = value.slice(0, comma)
  const payload = value.slice(comma + 1)
  if (/;base64(?:;|$)/i.test(metadata)) {
    const base64 = payload.replace(/\s+/g, '')
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    return Math.max(0, Math.floor(base64.length * 3 / 4) - padding)
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(payload)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function safeProtocol(value: string): string | undefined {
  try {
    return new URL(value).protocol.toLowerCase()
  } catch {
    return undefined
  }
}

function isoTime(value: unknown): string | undefined {
  const time = numberValue(value)
  if (time === undefined) return undefined
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
