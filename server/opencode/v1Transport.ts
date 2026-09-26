import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type {
  GenericMessagePart,
  HealthStatus,
  Message,
  MessageInfo,
  MessagePart,
  OpenCodePermissionRule,
  OpenCodeQuestionAnswer,
  OpenCodeQuestionInfo,
  OpenCodeQuestionRequest,
  OpenCodeSessionCreateOptions,
  OpenCodeTodo,
  PromptPart,
  ReasoningMessagePart,
  Session,
  StepFinishMessagePart,
  StreamEvent,
  TextMessagePart,
  ToolMessagePart,
} from './types'
import type {
  OpenCodeEventSubscription,
  OpenCodePromptRequest,
  OpenCodeSessionLog,
  OpenCodeTransport,
  OpenCodeTransportEventEnvelope,
} from './transport'
import { getOpenCodeBasicAuthHeader } from '../../shared/opencodeAuth'
import {
  SDK_OPERATION_TIMEOUT_MS,
  SESSION_LIST_LIMIT,
  MESSAGE_LIST_LIMIT,
  MAX_CATALOG_MODEL_IDS,
} from '../lib/constants'
import { extractTextFromMessageParts } from './assistantMessageAnalysis'
import { enrichGenericOpenCodeProviderError } from './logDiagnostics'
import { getErrorMessage } from '@shared/typeGuards'

interface RawEvent {
  type: string
  properties?: Record<string, unknown>
  directory?: string
  project?: string
  workspace?: string
}

function normalizeSafeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export type OpenCodeV1Client = ReturnType<typeof createOpencodeClient>

export class OpenCodeV1Transport implements OpenCodeTransport {
  readonly protocol = 'v1' as const
  private readonly client: OpenCodeV1Client

  constructor(baseUrl: string, client?: OpenCodeV1Client, headers?: Record<string, string>) {
    const authHeader = getOpenCodeBasicAuthHeader()
    this.client = client ?? createOpencodeClient({
      baseUrl,
      ...(headers ? { headers } : authHeader ? { headers: { Authorization: authHeader } } : {}),
    })
  }

  async createSession(projectPath: string, options?: OpenCodeSessionCreateOptions, signal?: AbortSignal): Promise<Session> {
    const res = await this.client.session.create({
      directory: projectPath,
      ...(options?.permission ? { permission: options.permission.map(rule => ({ ...rule })) } : {}),
    }, this.requestOptions(this.withSdkOperationTimeout(signal)))
    if (!res.data) throw new Error('OpenCode returned no session payload')
    return this.mapSession(res.data as Record<string, unknown>)
  }

  async updateSession(
    sessionId: string,
    directory: string | undefined,
    options: { permission?: ReadonlyArray<OpenCodePermissionRule> },
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.client.session.update({
      sessionID: sessionId,
      ...(directory ? { directory } : {}),
      ...(options.permission ? { permission: options.permission.map(rule => ({ ...rule })) } : {}),
    }, this.requestOptions(this.withSdkOperationTimeout(signal)))
    if (!res.data) throw new Error('OpenCode returned no updated session payload')
  }

  async dispatchPrompt(request: OpenCodePromptRequest, signal?: AbortSignal) {
    const { systemText, promptParts } = this.partitionPromptParts(request.parts, request.system, true)
    const res = await this.client.session.prompt({
      sessionID: request.sessionId,
      ...(request.directory ? { directory: request.directory } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.agent ? { agent: request.agent } : {}),
      ...(request.variant ? { variant: request.variant } : {}),
      ...(systemText ? { system: systemText } : {}),
      ...(typeof request.noReply === 'boolean' ? { noReply: request.noReply } : {}),
      ...(request.tools ? { tools: request.tools } : {}),
      parts: promptParts,
    // Generation can outlast the short timeout used for ordinary SDK calls.
    // Respect the workflow's caller signal without imposing a transport cap.
    }, this.requestOptions(signal))
    if (!res.data) throw new Error('OpenCode returned no prompt response')
    return { kind: 'completed' as const, message: this.mapMessageRecord(res.data, request.sessionId) }
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<Session | null> {
    try {
      const res = await this.client.session.get(
        { sessionID: sessionId },
        this.requestOptions(this.withSdkOperationTimeout(signal)),
      )
      if (!res.data) {
        if (res.response?.status === 404) return null
        if (typeof res.response?.status === 'number') {
          throw new Error(`OpenCode session lookup failed with HTTP ${res.response.status}`)
        }
        if (res.error) throw res.error
        throw new Error('OpenCode returned no session payload')
      }
      return this.mapSession(res.data as Record<string, unknown>)
    } catch (error) {
      if (this.isConfirmedSessionNotFoundError(error)) return null
      throw error
    }
  }

  async listSessions(signal?: AbortSignal): Promise<Session[]> {
    const res = await this.client.session.list(
      { limit: SESSION_LIST_LIMIT },
      this.requestOptions(this.withSdkOperationTimeout(signal)),
    )
    return Array.isArray(res.data)
      ? res.data.map(session => this.mapSession(session as Record<string, unknown>))
      : []
  }

  async getSessionMessages(sessionId: string, directory?: string, signal?: AbortSignal): Promise<Message[]> {
    const res = await this.client.session.messages({
      sessionID: sessionId,
      ...(directory ? { directory } : {}),
      limit: MESSAGE_LIST_LIMIT,
    }, this.requestOptions(this.withSdkOperationTimeout(signal)))
    return Array.isArray(res.data)
      ? res.data.map(entry => this.mapMessageRecord(entry, sessionId))
      : []
  }

  async subscribeToEvents(
    sessionId: string,
    _directory: string | undefined,
    signal?: AbortSignal,
    stepFinishSafetyMs?: number,
    _afterCursor?: number,
  ): Promise<OpenCodeEventSubscription> {
    const controller = new AbortController()
    const streamSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const eventStream = await this.client.global.event(this.requestOptions(streamSignal))
    return {
      events: this.readEvents(
        sessionId,
        eventStream.stream as AsyncIterable<RawEvent>,
        streamSignal,
        stepFinishSafetyMs,
        controller,
        signal,
      ),
    }
  }

  async readSessionLog(_sessionId: string, _after?: number, _signal?: AbortSignal): Promise<OpenCodeSessionLog> {
    throw new Error('OpenCode v1 does not expose a durable session log')
  }

  async waitForIdle(_sessionId: string, _directory?: string, _signal?: AbortSignal): Promise<void> {
    // The v1 prompt endpoint waits for the requested turn before returning.
  }

  async listPendingQuestions(
    projectPath?: string,
    sessionId?: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeQuestionRequest[]> {
    const scopedDirectory = directory ?? projectPath
    const res = await this.client.question.list(
      scopedDirectory ? { directory: scopedDirectory } : undefined,
      this.requestOptions(this.withSdkOperationTimeout(signal)),
    )
    const requests = Array.isArray(res.data)
      ? res.data.map(request => this.mapQuestionRequest(request)).filter((request): request is OpenCodeQuestionRequest => Boolean(request))
      : []
    return sessionId ? requests.filter(request => request.sessionID === sessionId) : requests
  }

  async replyQuestion(
    _sessionId: string,
    requestId: string,
    answers: OpenCodeQuestionAnswer[],
    directory: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.client.question.reply({ requestID: requestId, directory, answers }, this.requestOptions(this.withSdkOperationTimeout(signal)))
    if (res.data !== true) throw new Error(`OpenCode did not confirm reply ${requestId}`)
  }

  async rejectQuestion(
    _sessionId: string,
    requestId: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.client.question.reject({ requestID: requestId, directory }, this.requestOptions(this.withSdkOperationTimeout(signal)))
    if (res.data !== true) throw new Error(`OpenCode did not confirm rejection ${requestId}`)
  }

  async replyPermission(
    _sessionId: string,
    permissionId: string,
    reply: 'always' | 'reject',
    directory?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.client.permission.reply({
      requestID: permissionId,
      ...(directory ? { directory } : {}),
      reply,
    }, this.requestOptions(this.withSdkOperationTimeout(signal)))
    if (!res.data) throw new Error('OpenCode did not confirm the permission reply')
  }

  async interruptSession(sessionId: string, directory?: string): Promise<boolean> {
    try {
      const res = await this.client.session.abort({
        sessionID: sessionId,
        ...(directory ? { directory } : {}),
      }, this.requestOptions(AbortSignal.timeout(SDK_OPERATION_TIMEOUT_MS)))
      return res.data === true || this.isConfirmedSessionNotFoundResponse(res)
    } catch (error) {
      return this.isConfirmedSessionNotFoundError(error)
    }
  }

  async checkHealth(signal?: AbortSignal): Promise<HealthStatus> {
    const withTimeout = () => this.withSdkOperationTimeout(signal)
    let version = 'unknown'
    try {
      const health = await this.client.global.health(this.requestOptions(withTimeout()))
      version = health.data?.version ? String(health.data.version) : version
    } catch (healthError) {
      if (this.healthFailureKind(healthError) === 'authentication') {
        return { available: false, protocol: 'v1', failureKind: 'authentication', error: getErrorMessage(healthError) }
      }
      try {
        await this.client.session.status(undefined, this.requestOptions(withTimeout()))
      } catch (statusError) {
        return {
          available: false,
          protocol: 'v1',
          failureKind: this.healthFailureKind(statusError),
          error: getErrorMessage(statusError),
        }
      }
    }

    try {
      const providers = await this.withSdkPromiseTimeout(
        this.client.config.providers(undefined, this.requestOptions(withTimeout())),
        signal,
      )
      return {
        available: true,
        protocol: 'v1',
        version,
        models: this.extractConnectedModelIds(providers.data),
      }
    } catch (error) {
      const failureKind = this.healthFailureKind(error) === 'authentication' ? 'authentication' : 'model_discovery'
      return {
        available: failureKind !== 'authentication',
        protocol: 'v1',
        version,
        models: [],
        failureKind,
        error: `OpenCode is reachable, but model discovery failed: ${getErrorMessage(error)}`,
      }
    }
  }

  private healthFailureKind(error: unknown): 'authentication' | 'unsupported_protocol' | 'network' {
    const record = this.getRecord(error)
    const response = this.getRecord(record?.response)
    const status = this.readHttpStatus(response) ?? this.readHttpStatus(record)
    if (status === 401 || status === 403) return 'authentication'
    if (status === 404) return 'unsupported_protocol'
    return 'network'
  }

  private async *readEvents(
    sessionId: string,
    stream: AsyncIterable<RawEvent>,
    signal?: AbortSignal,
    stepFinishSafetyMs?: number,
    controller?: AbortController,
    callerSignal?: AbortSignal,
  ): AsyncGenerator<OpenCodeTransportEventEnvelope> {
    const partCache = new Map<string, GenericMessagePart>()
    const finalizedPartIds = new Set<string>()
    const messageRoles = new Map<string, string>()
    let emittedDone = false
    let lastStatus: string | undefined
    let safetyActive = false
    let shouldEmitSyntheticDone = false
    let nextDidNotFinish = false
    const rawIterator = stream[Symbol.asyncIterator]()

    try {
      while (true) {
        if (signal?.aborted) break
        let result: IteratorResult<RawEvent>
        if (safetyActive && stepFinishSafetyMs) {
          const nextPromise = rawIterator.next()
          const expired = Symbol('expired')
          let timer: ReturnType<typeof setTimeout> | undefined
          const winner = await Promise.race([
            nextPromise,
            new Promise<typeof expired>(resolve => {
              timer = setTimeout(() => resolve(expired), stepFinishSafetyMs)
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer)
          })
          if (winner === expired) {
            void nextPromise.catch(() => undefined)
            shouldEmitSyntheticDone = true
            nextDidNotFinish = true
            break
          }
          result = winner
        } else {
          result = await rawIterator.next()
        }
        if (result.done) {
          shouldEmitSyntheticDone = safetyActive
          break
        }
        const rawEvent = this.unwrapRawEvent(result.value)
        if (!rawEvent || !this.eventBelongsToSession(rawEvent, sessionId)) continue
        const normalized = this.normalizeStreamEvent(rawEvent, sessionId, partCache, finalizedPartIds, messageRoles)
        if (!normalized) continue
        if (normalized.type === 'session_status') {
          if (normalized.status === lastStatus) continue
          lastStatus = normalized.status
        }
        yield { event: normalized }
        if (normalized.type === 'done') {
          emittedDone = true
          break
        }
        if (normalized.type === 'step' && normalized.step === 'finish' && (normalized.reason === 'stop' || normalized.reason === 'end_turn')) {
          safetyActive = true
        }
      }
    } finally {
      controller?.abort()
      if (nextDidNotFinish) {
        try {
          const closing = rawIterator.return?.()
          if (closing) void closing.catch(() => undefined)
        } catch {
          // The safety timeout is terminal even if a stuck source cannot close.
        }
      } else {
        try {
          await rawIterator.return?.()
        } catch {
          // Iterator cleanup must not replace a stream failure or suppress a clean completion.
        }
      }
    }
    if (!emittedDone && !callerSignal?.aborted && shouldEmitSyntheticDone) yield { event: { type: 'done', sessionId } }
  }

  private requestOptions(signal?: AbortSignal) {
    return signal ? { signal } : undefined
  }

  private withSdkOperationTimeout(signal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(SDK_OPERATION_TIMEOUT_MS)
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  }

  private async withSdkPromiseTimeout<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    const timeoutSignal = this.withSdkOperationTimeout(signal)
    if (timeoutSignal.aborted) {
      throw timeoutSignal.reason instanceof Error ? timeoutSignal.reason : new Error('OpenCode SDK operation timed out')
    }
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(timeoutSignal.reason instanceof Error ? timeoutSignal.reason : new Error('OpenCode SDK operation timed out'))
      timeoutSignal.addEventListener('abort', onAbort, { once: true })
      operation.then(resolve, reject).finally(() => timeoutSignal.removeEventListener('abort', onAbort))
    })
  }

  private mapSession(session: Record<string, unknown>): Session {
    const time = this.getRecord(session.time)
    return {
      id: String(session.id),
      slug: typeof session.slug === 'string' ? session.slug : undefined,
      projectPath: typeof session.directory === 'string' ? session.directory : undefined,
      directory: typeof session.directory === 'string' ? session.directory : undefined,
      createdAt: typeof time?.created === 'number' ? new Date(time.created).toISOString() : undefined,
      updatedAt: typeof time?.updated === 'number' ? new Date(time.updated).toISOString() : undefined,
      title: typeof session.title === 'string' ? session.title : undefined,
      version: typeof session.version === 'string' ? session.version : undefined,
    }
  }

  private partitionPromptParts(parts: PromptPart[], fallbackSystem?: string, includeImageFiles = false) {
    const systemParts = parts.filter(part => part.type === 'system').map(part => part.content.trim()).filter(Boolean)
    const promptParts: Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; filename?: string; url: string }> = []
    for (const part of parts) {
      if (part.type === 'system') continue
      if (part.type === 'file') {
        if (!includeImageFiles || !part.url || !part.mime?.toLowerCase().startsWith('image/')) continue
        promptParts.push({ type: 'file', mime: part.mime, ...(part.filename ? { filename: part.filename } : {}), url: part.url })
        continue
      }
      promptParts.push({ type: 'text', text: part.content })
    }
    return {
      systemText: [fallbackSystem?.trim(), ...systemParts].filter(Boolean).join('\n\n'),
      promptParts: promptParts.length > 0 ? promptParts : [{ type: 'text' as const, text: '' }],
    }
  }

  private mapMessageRecord(entry: unknown, sessionId?: string): Message {
    const record = this.getRecord(entry)
    const rawInfo = this.getRecord(record?.info) as MessageInfo | null
    const info = rawInfo ? { ...rawInfo } : null
    if (info?.error) {
      const enriched = enrichGenericOpenCodeProviderError(info.error, sessionId ?? info.sessionID)
      if (enriched) info.error = enriched.details
    }
    const parts = Array.isArray(record?.parts) ? record.parts as MessagePart[] : []
    const createdAt = typeof info?.time?.created === 'number'
      ? new Date(info.time.created).toISOString()
      : typeof info?.timestamp === 'string' ? info.timestamp : undefined
    return {
      id: typeof info?.id === 'string' ? info.id : '',
      role: typeof info?.role === 'string' ? info.role : undefined,
      content: extractTextFromMessageParts(parts) || undefined,
      timestamp: createdAt,
      info: info ?? undefined,
      parts,
    }
  }

    private eventBelongsToSession(event: RawEvent, sessionId: string): boolean {
    const props = event.properties ?? {}
    const part = this.getRecord(props.part)
    const info = this.getRecord(props.info)

    const eventSessionId = typeof props.sessionID === 'string'
      ? props.sessionID
      : typeof info?.sessionID === 'string'
        ? info.sessionID
        : typeof part?.sessionID === 'string'
          ? part.sessionID
          : event.type.startsWith('session.') && typeof info?.id === 'string'
            ? info.id
            : undefined

    if (eventSessionId) return eventSessionId === sessionId

    // Global events have no session owner. Assigning one to whichever ticket
    // happened to be consuming the shared stream makes unrelated work appear
    // to belong to that ticket, so the per-session stream intentionally omits
    // them. Events with an explicit session ID remain eligible above.
    return false
  }

  normalizeStreamEvent(
    event: RawEvent,
    sessionId: string,
    partCache: Map<string, GenericMessagePart>,
    finalizedPartIds: Set<string>,
    messageRoles: Map<string, string>,
  ): StreamEvent | null {
    const props = event.properties ?? {}

    switch (event.type) {
      case 'message.updated':
        this.rememberMessageRole(props.info ?? props.message, messageRoles)
        return null

      case 'message.part.updated': {
        const part = this.getRecord(props.part) as GenericMessagePart | null
        if (!part?.id) return null
        if (this.isKnownNonAssistantMessagePart(part, messageRoles)) return null
        const partId = String(part.id)
        if (finalizedPartIds.has(partId)) return null

        const nextPart = this.clonePart(part)
        const previousPart = partCache.get(partId)
        if (previousPart && !this.hasMeaningfulPartUpdate(previousPart, nextPart)) {
          return null
        }

        partCache.set(partId, nextPart)
        const normalized = this.mapPartUpdate(nextPart)
        if (normalized && 'complete' in normalized && normalized.complete) {
          finalizedPartIds.add(partId)
        }
        return normalized
      }

      case 'message.part.delta': {
        const partId = typeof props.partID === 'string' ? props.partID : undefined
        const delta = typeof props.delta === 'string' ? props.delta : ''
        if (!partId || !delta) return null
        if (finalizedPartIds.has(partId)) return null
        const part = partCache.get(partId)
        if (!part) return null
        if (this.isKnownNonAssistantMessagePart(part, messageRoles)) return null
        return this.mapPartDelta(part, delta)
      }

      case 'message.part.removed': {
        const partId = typeof props.partID === 'string' ? props.partID : undefined
        if (partId) {
          partCache.delete(partId)
          finalizedPartIds.delete(partId)
        }
        return {
          type: 'part_removed',
          sessionId,
          partId,
        }
      }

      case 'session.status': {
        const status = this.getRecord(props.status)
        const statusType = typeof status?.type === 'string' ? status.type : 'busy'
        const rawAction = this.getRecord(status?.action)
        const actionLink = typeof rawAction?.link === 'string'
          ? normalizeSafeHttpUrl(rawAction.link)
          : undefined
        const action = rawAction
          ? {
              ...(typeof rawAction.reason === 'string' ? { reason: rawAction.reason } : {}),
              ...(typeof rawAction.provider === 'string' ? { provider: rawAction.provider } : {}),
              ...(typeof rawAction.title === 'string' ? { title: rawAction.title } : {}),
              ...(typeof rawAction.message === 'string' ? { message: rawAction.message } : {}),
              ...(typeof rawAction.label === 'string' ? { label: rawAction.label } : {}),
              ...(actionLink ? { link: actionLink } : {}),
            }
          : undefined
        return {
          type: 'session_status',
          sessionId,
          status: statusType === 'retry' ? 'retry' : (statusType === 'idle' ? 'idle' : 'busy'),
          attempt: typeof status?.attempt === 'number' ? status.attempt : undefined,
          message: typeof status?.message === 'string' ? status.message : undefined,
          next: typeof status?.next === 'number' ? status.next : undefined,
          ...(action && Object.keys(action).length > 0 ? { action } : {}),
        }
      }

      case 'session.error': {
        const rawError = props.error ?? props
        const enriched = enrichGenericOpenCodeProviderError(rawError, sessionId)
        return {
          type: 'session_error',
          sessionId,
          error: enriched?.message ?? this.describeError(rawError),
          details: enriched?.details ?? rawError,
        }
      }

      case 'question.asked': {
        const request = this.mapQuestionRequest(props)
        if (!request) return null
        return {
          type: 'question',
          action: 'asked',
          sessionId: request.sessionID,
          requestId: request.id,
          questions: request.questions,
          tool: request.tool,
        }
      }

      case 'question.replied': {
        const requestId = typeof props.requestID === 'string' ? props.requestID : ''
        const answers = Array.isArray(props.answers)
          ? props.answers
              .filter((answer): answer is unknown[] => Array.isArray(answer))
              .map((answer) => answer.filter((item): item is string => typeof item === 'string'))
          : undefined
        return {
          type: 'question',
          action: 'replied',
          sessionId,
          requestId,
          ...(answers ? { answers } : {}),
        }
      }

      case 'question.rejected':
        return {
          type: 'question',
          action: 'rejected',
          sessionId,
          requestId: typeof props.requestID === 'string' ? props.requestID : '',
        }

      case 'todo.updated': {
        const todos = this.mapTodos(props.todos)
        return todos.length > 0
          ? { type: 'todo', sessionId, todos }
          : null
      }

      case 'permission.asked':
      case 'permission.replied':
      case 'permission.updated': {
        const details = this.getRecord(props)
        return {
          type: 'permission',
          action: event.type === 'permission.asked'
            ? 'asked'
            : event.type === 'permission.replied'
              ? 'replied'
              : 'updated',
          sessionId,
          permissionId: typeof details?.id === 'string' ? details.id : '',
          permission: typeof details?.permission === 'string' ? details.permission : undefined,
          title: typeof details?.title === 'string' ? details.title : undefined,
          patterns: Array.isArray(details?.patterns)
            ? details.patterns.filter((pattern): pattern is string => typeof pattern === 'string')
            : undefined,
          details: details ?? undefined,
        }
      }

      case 'session.idle':
        return { type: 'done', sessionId }

      case 'session.compacted':
      case 'session.created':
      case 'session.updated':
      case 'session.deleted':
      case 'workspace.ready':
      case 'workspace.restore':
      case 'workspace.status':
      case 'server.connected':
      case 'server.instance.disposed':
      case 'global.disposed':
      case 'command.executed':
      case 'vcs.branch.updated':
        return this.mapDebugEvent(event, sessionId)

      case 'workspace.failed':
        return this.mapDebugEvent(event, sessionId, 'error')

      case 'file.edited': {
        const file = typeof props.file === 'string' ? props.file : ''
        return file ? { type: 'file_edited', sessionId, file } : null
      }

      default:
        return null
    }
  }

  private rememberMessageRole(value: unknown, messageRoles: Map<string, string>) {
    const info = this.getRecord(value)
    const messageId = typeof info?.id === 'string'
      ? info.id
      : typeof info?.messageID === 'string'
        ? info.messageID
        : undefined
    const role = typeof info?.role === 'string' ? info.role : undefined
    if (messageId && role) messageRoles.set(messageId, role)
  }

  private isKnownNonAssistantMessagePart(part: GenericMessagePart, messageRoles: Map<string, string>) {
    const messageId = typeof part.messageID === 'string' ? part.messageID : undefined
    if (!messageId) return false
    const role = messageRoles.get(messageId)
    return role !== undefined && role !== 'assistant'
  }

  private isToolPart(part: GenericMessagePart): part is GenericMessagePart & ToolMessagePart {
    return part.type === 'tool'
  }

  private isStepFinishPart(part: GenericMessagePart): part is GenericMessagePart & StepFinishMessagePart {
    return part.type === 'step-finish'
  }

  mapPartUpdate(part: GenericMessagePart): StreamEvent | null {
    const sessionId = String(part.sessionID)
    const messageId = String(part.messageID)
    const partId = String(part.id)

    if (part.type === 'text') {
      const textPart = part as TextMessagePart
      if (!textPart.text && !textPart.time?.end) return null
      return {
        type: 'text',
        sessionId,
        messageId,
        partId,
        text: textPart.text ?? '',
        streaming: !textPart.time?.end,
        complete: Boolean(textPart.time?.end),
      }
    }

    if (part.type === 'reasoning') {
      const reasoningPart = part as ReasoningMessagePart
      if (!reasoningPart.text && !reasoningPart.time?.end) return null
      return {
        type: 'reasoning',
        sessionId,
        messageId,
        partId,
        text: reasoningPart.text ?? '',
        streaming: !reasoningPart.time?.end,
        complete: Boolean(reasoningPart.time?.end),
      }
    }

    if (this.isToolPart(part)) {
      // `isToolPart` only checks the discriminator, and a tool part can arrive
      // before its state exists. Reading through the missing state threw inside
      // `subscribeToEvents`, which is not wrapped — so one malformed part turned
      // into a single `session_error` and the event loop stopped reading.
      if (!this.getRecord(part.state)) return null
      const input = this.getRecord(part.state.input)
      const time = this.getRecord(part.state.time)
      const start = typeof time?.start === 'number' ? time.start : undefined
      const end = typeof time?.end === 'number' ? time.end : undefined
      const attachments = Array.isArray(part.state.attachments)
        ? part.state.attachments.flatMap((attachment) => {
            const record = this.getRecord(attachment)
            if (!record) return []
            const filename = typeof record.filename === 'string'
              ? record.filename
              : typeof record.name === 'string'
                ? record.name
                : undefined
            const mime = typeof record.mime === 'string'
              ? record.mime
              : typeof record.mediaType === 'string'
                ? record.mediaType
                : undefined
            return filename || mime
              ? [{ ...(filename ? { filename } : {}), ...(mime ? { mime } : {}) }]
              : []
          })
        : undefined
      return {
        type: 'tool',
        sessionId,
        messageId,
        partId,
        tool: part.tool,
        callId: part.callID,
        status: part.state.status,
        title: part.state.title,
        input: input ? { ...input } : undefined,
        output: typeof part.state.output === 'string' ? part.state.output : undefined,
        error: typeof part.state.error === 'string' ? part.state.error : undefined,
        metadata: part.metadata,
        ...(start !== undefined && end !== undefined && end >= start ? { durationMs: end - start } : {}),
        ...(typeof time?.compacted === 'number' ? { compactedAt: time.compacted } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        complete: part.state.status === 'completed' || part.state.status === 'error',
      }
    }

    if (part.type === 'step-start') {
      return {
        type: 'step',
        sessionId,
        messageId,
        partId,
        step: 'start',
        snapshot: typeof part.snapshot === 'string' ? part.snapshot : undefined,
        complete: true,
      }
    }

    if (this.isStepFinishPart(part)) {
      return {
        type: 'step',
        sessionId,
        messageId,
        partId,
        step: 'finish',
        reason: part.reason,
        snapshot: typeof part.snapshot === 'string' ? part.snapshot : undefined,
        cost: typeof part.cost === 'number' ? part.cost : undefined,
        tokens: part.tokens,
        complete: true,
      }
    }

    if (this.isCompactPartType(part.type)) {
      return this.mapCompactPartUpdate(part, sessionId, messageId, partId)
    }

    return null
  }

  private mapPartDelta(part: GenericMessagePart, delta: string): StreamEvent | null {
    const sessionId = String(part.sessionID)
    const messageId = String(part.messageID)
    const partId = String(part.id)
    const nextText = `${typeof part.text === 'string' ? part.text : ''}${delta}`
    part.text = nextText

    if (part.type === 'reasoning') {
      return {
        type: 'reasoning',
        sessionId,
        messageId,
        partId,
        text: nextText,
        delta,
        streaming: true,
        complete: false,
      }
    }

    if (part.type === 'text') {
      return {
        type: 'text',
        sessionId,
        messageId,
        partId,
        text: nextText,
        delta,
        streaming: true,
        complete: false,
      }
    }

    return null
  }

  private clonePart(part: GenericMessagePart): GenericMessagePart {
    return typeof structuredClone === 'function'
      ? structuredClone(part)
      : JSON.parse(JSON.stringify(part)) as GenericMessagePart
  }

  private isCompactPartType(type: string): type is 'file' | 'patch' | 'snapshot' | 'agent' | 'subtask' | 'retry' | 'compaction' {
    return type === 'file'
      || type === 'patch'
      || type === 'snapshot'
      || type === 'agent'
      || type === 'subtask'
      || type === 'retry'
      || type === 'compaction'
  }

  private mapCompactPartUpdate(
    part: GenericMessagePart,
    sessionId: string,
    messageId: string,
    partId: string,
  ): StreamEvent | null {
    const partType = part.type
    if (!this.isCompactPartType(partType)) return null
    const summary = this.summarizeCompactPart(part)
    if (!summary) return null
    return {
      type: 'part_summary',
      sessionId,
      messageId,
      partId,
      partType,
      summary,
      details: this.compactPartDetails(part),
      severity: partType === 'retry' ? 'error' : 'info',
      complete: true,
    }
  }

  private summarizeCompactPart(part: GenericMessagePart): string {
    switch (part.type) {
      case 'file': {
        const filename = typeof part.filename === 'string' ? part.filename : undefined
        const mime = typeof part.mime === 'string' ? part.mime : undefined
        const source = this.getRecord(part.source)
        const sourcePath = typeof source?.path === 'string' ? source.path : undefined
        return `File attached: ${filename ?? sourcePath ?? 'unnamed file'}${mime ? ` (${mime})` : ''}.`
      }
      case 'patch': {
        const files = Array.isArray(part.files) ? part.files.filter((file): file is string => typeof file === 'string') : []
        const shown = files.slice(0, 6)
        const hash = typeof part.hash === 'string' ? part.hash.slice(0, 12) : undefined
        return `Patch prepared${hash ? ` ${hash}` : ''}: ${files.length} file${files.length === 1 ? '' : 's'}${shown.length ? ` (${shown.join(', ')}${files.length > shown.length ? ', …' : ''})` : ''}.`
      }
      case 'snapshot': {
        const snapshot = typeof part.snapshot === 'string' ? part.snapshot.slice(0, 16) : undefined
        return `Snapshot captured${snapshot ? `: ${snapshot}` : ''}.`
      }
      case 'agent': {
        const name = typeof part.name === 'string' ? part.name : 'agent'
        return `Agent context selected: ${name}.`
      }
      case 'subtask': {
        const description = typeof part.description === 'string' ? part.description : undefined
        const agent = typeof part.agent === 'string' ? part.agent : undefined
        const command = typeof part.command === 'string' ? part.command : undefined
        return [
          `Subtask started${agent ? ` for ${agent}` : ''}${description ? `: ${this.truncateInline(description, 160)}` : '.'}`,
          command ? `Command: ${this.truncateInline(command, 160)}` : '',
        ].filter(Boolean).join('\n')
      }
      case 'retry': {
        const attempt = typeof part.attempt === 'number' ? part.attempt : undefined
        return `Retry requested${attempt !== undefined ? ` (attempt ${attempt})` : ''}: ${this.describeError(part.error)}`
      }
      case 'compaction': {
        const mode = part.auto === true ? 'auto' : 'manual'
        const overflow = part.overflow === true ? ' after context overflow' : ''
        return `Context compaction (${mode})${overflow}.`
      }
      default:
        return ''
    }
  }

  private compactPartDetails(part: GenericMessagePart): Record<string, unknown> {
    const details: Record<string, unknown> = { partType: part.type }
    for (const key of ['filename', 'mime', 'url', 'hash', 'files', 'snapshot', 'name', 'agent', 'command', 'attempt', 'auto', 'overflow', 'tail_start_id']) {
      if (part[key] !== undefined) details[key] = part[key]
    }
    if (part.type === 'retry' && part.error !== undefined) details.error = part.error
    return details
  }

  private hasMeaningfulPartUpdate(previous: GenericMessagePart, next: GenericMessagePart) {
    return this.buildPartStreamKey(previous) !== this.buildPartStreamKey(next)
  }

  private buildPartStreamKey(part: GenericMessagePart): string {
    if (part.type === 'text' || part.type === 'reasoning') {
      return JSON.stringify({
        type: part.type,
        text: typeof part.text === 'string' ? part.text : '',
        end: this.getRecord(part.time)?.end ?? null,
      })
    }

    if (this.isToolPart(part)) {
      return JSON.stringify({
        type: part.type,
        callId: part.callID,
        tool: part.tool,
        status: part.state?.status ?? null,
        title: part.state?.title ?? null,
        input: part.state?.input ?? null,
        output: part.state?.output ?? null,
        error: part.state?.error ?? null,
      })
    }

    if (part.type === 'step-start') {
      return JSON.stringify({
        type: part.type,
        snapshot: typeof part.snapshot === 'string' ? part.snapshot : null,
      })
    }

    if (this.isStepFinishPart(part)) {
      return JSON.stringify({
        type: part.type,
        reason: part.reason,
        snapshot: typeof part.snapshot === 'string' ? part.snapshot : null,
        cost: typeof part.cost === 'number' ? part.cost : null,
        tokens: part.tokens ?? null,
      })
    }

    return JSON.stringify(part)
  }

  private unwrapRawEvent(value: RawEvent | { payload?: unknown; directory?: unknown; project?: unknown; workspace?: unknown }): RawEvent | null {
    const eventRecord = this.getRecord(value)
    if (!eventRecord) return null

    const payload = this.getRecord(eventRecord.payload)
    if (payload && typeof payload.type === 'string') {
      const payloadProps = this.getRecord(payload.properties)
      return {
        type: payload.type,
        properties: payloadProps ?? {},
        directory: typeof eventRecord.directory === 'string' ? eventRecord.directory : undefined,
        project: typeof eventRecord.project === 'string' ? eventRecord.project : undefined,
        workspace: typeof eventRecord.workspace === 'string' ? eventRecord.workspace : undefined,
      }
    }

    if (typeof eventRecord.type !== 'string') return null
    const properties = this.getRecord(eventRecord.properties)
    return {
      type: eventRecord.type,
      properties: properties ?? {},
      directory: typeof eventRecord.directory === 'string' ? eventRecord.directory : undefined,
      project: typeof eventRecord.project === 'string' ? eventRecord.project : undefined,
      workspace: typeof eventRecord.workspace === 'string' ? eventRecord.workspace : undefined,
    }
  }

  private mapQuestionRequest(value: unknown): OpenCodeQuestionRequest | null {
    const record = this.getRecord(value)
    if (!record) return null
    const id = typeof record.id === 'string' ? record.id : undefined
    const sessionID = typeof record.sessionID === 'string' ? record.sessionID : undefined
    if (!id || !sessionID) return null

    const questions = Array.isArray(record.questions)
      ? record.questions.map((question) => this.mapQuestionInfo(question)).filter((question): question is OpenCodeQuestionInfo => Boolean(question))
      : []
    const toolRecord = this.getRecord(record.tool)
    const tool = typeof toolRecord?.messageID === 'string' && typeof toolRecord.callID === 'string'
      ? { messageID: toolRecord.messageID, callID: toolRecord.callID }
      : undefined

    return {
      id,
      sessionID,
      questions,
      ...(tool ? { tool } : {}),
    }
  }

  private mapQuestionInfo(value: unknown): OpenCodeQuestionInfo | null {
    const record = this.getRecord(value)
    if (!record) return null
    const question = typeof record.question === 'string' ? record.question : ''
    const header = typeof record.header === 'string' ? record.header : 'Question'
    const options = Array.isArray(record.options)
      ? record.options.map((option) => {
          const optionRecord = this.getRecord(option)
          if (!optionRecord || typeof optionRecord.label !== 'string') return null
          return {
            label: optionRecord.label,
            ...(typeof optionRecord.value === 'string' ? { value: optionRecord.value } : {}),
            ...(typeof optionRecord.description === 'string' ? { description: optionRecord.description } : {}),
          }
        }).filter((option): option is OpenCodeQuestionInfo['options'][number] => Boolean(option))
      : []

    if (!question && !header && options.length === 0) return null
    return {
      question,
      header,
      options,
      ...(typeof record.multiple === 'boolean' ? { multiple: record.multiple } : {}),
      ...(typeof record.custom === 'boolean' ? { custom: record.custom } : {}),
    }
  }

  private mapTodos(value: unknown): OpenCodeTodo[] {
    if (!Array.isArray(value)) return []
    return value
      .map((todo) => {
        const record = this.getRecord(todo)
        if (!record || typeof record.content !== 'string') return null
        return {
          content: record.content,
          status: typeof record.status === 'string' ? record.status : 'pending',
          priority: typeof record.priority === 'string' ? record.priority : 'medium',
        }
      })
      .filter((todo): todo is OpenCodeTodo => Boolean(todo))
  }

  private mapDebugEvent(event: RawEvent, sessionId: string, severity: 'debug' | 'error' = 'debug'): StreamEvent {
    const props = event.properties ?? {}
    return {
      type: 'debug_event',
      sessionId,
      eventName: event.type,
      summary: this.summarizeDebugEvent(event.type, props),
      details: props,
      severity,
    }
  }

  private summarizeDebugEvent(eventName: string, props: Record<string, unknown>): string {
    switch (eventName) {
      case 'session.compacted':
        return 'OpenCode session compacted.'
      case 'session.created':
        return `OpenCode session created${typeof props.sessionID === 'string' ? `: ${props.sessionID}` : ''}.`
      case 'session.updated':
        return `OpenCode session updated${typeof props.sessionID === 'string' ? `: ${props.sessionID}` : ''}.`
      case 'session.deleted':
        return `OpenCode session deleted${typeof props.sessionID === 'string' ? `: ${props.sessionID}` : ''}.`
      case 'workspace.ready':
        return `Workspace ready${typeof props.name === 'string' ? `: ${props.name}` : ''}.`
      case 'workspace.failed':
        return `Workspace failed: ${typeof props.message === 'string' ? props.message : 'unknown failure'}`
      case 'workspace.restore':
        return `Workspace restore ${typeof props.step === 'number' && typeof props.total === 'number' ? `${props.step}/${props.total}` : 'started'}.`
      case 'workspace.status':
        return `Workspace status: ${typeof props.status === 'string' ? props.status : 'unknown'}.`
      case 'server.connected':
        return 'OpenCode server connected.'
      case 'server.instance.disposed':
        return `OpenCode server instance disposed${typeof props.directory === 'string' ? `: ${props.directory}` : ''}.`
      case 'global.disposed':
        return 'OpenCode global disposed.'
      case 'command.executed':
        return `Command executed: ${typeof props.name === 'string' ? props.name : 'unknown'}${typeof props.arguments === 'string' && props.arguments ? ` ${this.truncateInline(props.arguments, 180)}` : ''}.`
      case 'vcs.branch.updated':
        return `VCS branch updated${typeof props.branch === 'string' ? `: ${props.branch}` : ''}.`
      default:
        return `OpenCode event: ${eventName}.`
    }
  }

  private truncateInline(value: string, maxChars: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized
  }

  private describeError(error: unknown): string {
    if (!error) return 'Unknown OpenCode error'
    if (typeof error === 'string') return error
    if (typeof error === 'object') {
      const record = error as Record<string, unknown>
      if (typeof record.message === 'string') return record.message
      const data = this.getRecord(record.data)
      if (typeof data?.message === 'string') return data.message
      try {
        return JSON.stringify(error)
      } catch {
        return String(error)
      }
    }
    return String(error)
  }

  isConfirmedSessionNotFoundResponse(response: unknown): boolean {
    const record = this.getRecord(response)
    const sdkResponse = this.getRecord(record?.response)
    const responseStatus = this.readHttpStatus(sdkResponse)
    if (responseStatus !== undefined) return responseStatus === 404
    return this.isConfirmedSessionNotFoundError(record?.error)
  }

  isConfirmedSessionNotFoundError(error: unknown): boolean {
    const record = this.getRecord(error)
    const response = this.getRecord(record?.response)
    const status = this.readHttpStatus(response) ?? this.readHttpStatus(record)
    return status === 404
  }

  private readHttpStatus(value: Record<string, unknown> | null | undefined): number | undefined {
    if (typeof value?.status === 'number') return value.status
    if (typeof value?.statusCode === 'number') return value.statusCode
    return undefined
  }

  private extractConnectedModelIds(data: unknown): string[] {
    const record = this.getRecord(data)
    const providers = Array.isArray(record?.providers) ? record.providers : []
    const modelIds: string[] = []

    for (const provider of providers) {
      const providerRecord = this.getRecord(provider)
      const providerId = typeof providerRecord?.id === 'string' ? providerRecord.id : undefined
      const models = this.getRecord(providerRecord?.models)
      if (!providerId || !models) continue
      for (const modelId of Object.keys(models)) {
        modelIds.push(`${providerId}/${modelId}`)
      }
    }

    return modelIds.slice(0, MAX_CATALOG_MODEL_IDS)
  }

  private getRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
  }

}
