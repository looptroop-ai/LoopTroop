import type { HealthStatus, Message, OpenCodeQuestionAnswer, OpenCodeQuestionRequest, OpenCodeSessionCreateOptions, Session } from './types'
import type {
  OpenCodeEventSubscription,
  OpenCodePromptRequest,
  OpenCodeSessionLog,
  OpenCodeSessionUpdateOptions,
  OpenCodeTransport,
  OpenCodeTransportEventEnvelope,
  PromptDispatch,
} from './transport'
import {
  createV2EventMappingState,
  isV2QuestionForm,
  mapV2Event,
  mapV2Message,
  mapV2PermissionRules,
  mapV2PromptParts,
  mapV2Question,
  mapV2QuestionAnswer,
  mapV2Session,
} from './v2Mapping'
import { fetchProviderCatalog, flattenCatalogModels } from './providerCatalog'
import { MESSAGE_LIST_LIMIT, SDK_OPERATION_TIMEOUT_MS, SESSION_LIST_LIMIT } from '../lib/constants'

type RecordValue = Record<string, unknown>
type FetchOptions = {
  headers?: Record<string, string>
  fetch?: typeof globalThis.fetch
}

const API_OPERATION_TIMEOUT_MS = SDK_OPERATION_TIMEOUT_MS
const SESSION_CREATE_TIMEOUT_MS = 180_000
const EVENT_CONNECT_TIMEOUT_MS = 5_000
const EVENT_RECONNECT_ATTEMPTS = 3
const LOG_SYNC_TIMEOUT_MS = 30_000
const IDLE_WAIT_TIMEOUT_MS = 60_000
const LIST_PAGE_SIZE = 100
const MESSAGE_PAGE_SIZE = 100

export class V2OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(errorMessage(status, body))
    this.name = 'V2OpenCodeHttpError'
  }
}

interface SseConnection {
  iterator: AsyncIterator<unknown>
  next(timeoutMs?: number, timeoutMessage?: string): Promise<IteratorResult<unknown>>
  close(): Promise<void>
}

interface SessionLogScan {
  cursor: number
  coverageComplete: boolean
  hasWatermark: boolean
}

export class V2OpenCodeTransport implements OpenCodeTransport {
  readonly protocol = 'v2' as const
  private readonly baseUrl: URL
  private readonly headers: Headers
  private readonly fetcher: typeof globalThis.fetch

  constructor(baseUrl: string, options: FetchOptions = {}) {
    this.baseUrl = new URL(baseUrl)
    if (!this.baseUrl.pathname.endsWith('/')) this.baseUrl.pathname += '/'
    this.headers = new Headers(options.headers)
    this.fetcher = options.fetch ?? globalThis.fetch
  }

  async createSession(projectPath: string, options?: OpenCodeSessionCreateOptions, signal?: AbortSignal): Promise<Session> {
    const body = await this.request('/api/session', {
      method: 'POST',
      signal,
      timeoutMs: SESSION_CREATE_TIMEOUT_MS,
      body: {
        location: { directory: projectPath },
        ...(options?.permission ? { permissions: mapV2PermissionRules(options.permission) } : {}),
      },
    })
    return mapV2Session(dataOf(body))
  }

  async updateSession(
    sessionId: string,
    _directory: string | undefined,
    options: OpenCodeSessionUpdateOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    if (options.permission === undefined) return
    await this.request(`/api/session/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      signal,
      expectedStatus: 204,
      body: { permissions: mapV2PermissionRules(options.permission) },
    })
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<Session | null> {
    try {
      const body = await this.request(`/api/session/${encodeURIComponent(sessionId)}`, { signal })
      return mapV2Session(dataOf(body))
    } catch (error) {
      if (isSessionNotFound(error)) return null
      throw error
    }
  }

  async listSessions(signal?: AbortSignal): Promise<Session[]> {
    const sessions: Session[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined

    while (sessions.length < SESSION_LIST_LIMIT) {
      const query = new URLSearchParams({
        limit: String(Math.min(LIST_PAGE_SIZE, SESSION_LIST_LIMIT - sessions.length)),
        ...(!cursor ? { order: 'desc' } : {}),
      })
      if (cursor) query.set('cursor', cursor)
      const page = asRecord(await this.request(`/api/session?${query}`, { signal }))
      for (const session of arrayValue(page?.data)) {
        if (sessions.length >= SESSION_LIST_LIMIT) break
        sessions.push(mapV2Session(session))
      }
      const next = stringValue(asRecord(page?.cursor)?.next)
      if (!next || seenCursors.has(next)) break
      seenCursors.add(next)
      cursor = next
    }
    return sessions
  }

  async getSessionMessages(sessionId: string, _directory?: string, signal?: AbortSignal): Promise<Message[]> {
    const messages: Message[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined

    while (messages.length < MESSAGE_LIST_LIMIT) {
      const query = new URLSearchParams({
        limit: String(Math.min(MESSAGE_PAGE_SIZE, MESSAGE_LIST_LIMIT - messages.length)),
        ...(!cursor ? { order: 'desc' } : {}),
      })
      if (cursor) query.set('cursor', cursor)
      const page = asRecord(await this.request(`/api/session/${encodeURIComponent(sessionId)}/message?${query}`, { signal }))
      for (const item of arrayValue(page?.data)) {
        if (messages.length >= MESSAGE_LIST_LIMIT) break
        const message = mapV2Message(item, sessionId)
        if (message) messages.push(message)
      }
      const next = stringValue(asRecord(page?.cursor)?.next)
      if (!next || seenCursors.has(next)) break
      seenCursors.add(next)
      cursor = next
    }
    return messages.reverse()
  }

  async subscribeToEvents(
    sessionId: string,
    _directory: string | undefined,
    signal?: AbortSignal,
    _stepFinishSafetyMs?: number,
    afterCursor?: number,
  ): Promise<OpenCodeEventSubscription> {
    const cleanupController = new AbortController()
    const streamSignal = signal
      ? AbortSignal.any([signal, cleanupController.signal])
      : cleanupController.signal
    const connection = await this.openEventStream(streamSignal)
    const ownedConnections = new Set<SseConnection>([connection])
    const closeConnections = async () => {
      if (!cleanupController.signal.aborted) {
        cleanupController.abort(new DOMException('OpenCode v2 event subscription closed', 'AbortError'))
      }
      await Promise.all([...ownedConnections].map(owned => owned.close()))
    }
    const backlog: OpenCodeTransportEventEnvelope[] = []
    const mappingState = createV2EventMappingState()
    let scan: SessionLogScan
    try {
      scan = await this.scanSessionLog(
        sessionId,
        afterCursor,
        streamSignal,
        event => backlog.push(event),
        mappingState,
      )
    } catch (error) {
      await closeConnections()
      throw error
    }
    const cursor = scan.cursor
    const generator = this.followEvents(
      connection,
      sessionId,
      cursor,
      backlog,
      streamSignal,
      ownedConnections,
      closeConnections,
      mappingState,
      !scan.coverageComplete || !scan.hasWatermark,
    )
    return {
      ...(scan.hasWatermark ? { cursor } : {}),
      coverageComplete: scan.coverageComplete && scan.hasWatermark,
      events: closeOnIteratorReturn(generator, closeConnections),
    }
  }

  async waitForIdle(sessionId: string, _directory?: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/api/experimental/session/${encodeURIComponent(sessionId)}/wait`, {
      method: 'POST',
      signal,
      timeoutMs: IDLE_WAIT_TIMEOUT_MS,
      expectedStatus: 204,
    })
  }

  async readSessionLog(sessionId: string, after?: number, signal?: AbortSignal): Promise<OpenCodeSessionLog> {
    const events: OpenCodeTransportEventEnvelope[] = []
    const scan = await this.scanSessionLog(
      sessionId,
      after,
      signal,
      event => events.push(event),
      createV2EventMappingState(),
    )
    return {
      events,
      ...(scan.hasWatermark ? { cursor: scan.cursor } : after !== undefined ? { cursor: after } : {}),
      coverageComplete: scan.coverageComplete && scan.hasWatermark,
    }
  }

  async dispatchPrompt(request: OpenCodePromptRequest, signal?: AbortSignal): Promise<PromptDispatch> {
    if (request.tools && Object.keys(request.tools).length > 0) {
      throw new Error('OpenCode v2 does not support per-prompt tool overrides')
    }

    const prompt = mapV2PromptParts(request.parts, request.system)
    if (request.variant && !request.model) {
      throw new Error('OpenCode v2 requires a model selection when setting a model variant')
    }
    if (request.model) {
      await this.request(`/api/session/${encodeURIComponent(request.sessionId)}/model`, {
        method: 'POST',
        signal,
        expectedStatus: 204,
        body: {
          model: {
            id: request.model.modelID,
            providerID: request.model.providerID,
            ...(request.variant ? { variant: request.variant } : {}),
          },
        },
      })
    }
    if (request.agent) {
      await this.request(`/api/session/${encodeURIComponent(request.sessionId)}/agent`, {
        method: 'POST',
        signal,
        expectedStatus: 204,
        body: { agent: request.agent },
      })
    }

    const instructionsPath = `/api/experimental/session/${encodeURIComponent(request.sessionId)}/instructions/entries/looptroop`
    if (prompt.instructions) {
      await this.request(instructionsPath, {
        method: 'PUT',
        signal,
        expectedStatus: 204,
        body: { value: prompt.instructions },
      })
    } else {
      await this.request(instructionsPath, {
        method: 'DELETE',
        signal,
        expectedStatus: 204,
      })
    }

    const body = await this.request(`/api/session/${encodeURIComponent(request.sessionId)}/prompt`, {
      method: 'POST',
      signal,
      body: {
        text: prompt.text,
        ...(prompt.files.length > 0 ? { files: prompt.files } : {}),
        resume: request.noReply !== true,
      },
    })
    const accepted = asRecord(dataOf(body))
    const inboxID = stringValue(accepted?.id)
    if (!inboxID) throw new Error('OpenCode v2 prompt response did not include an inbox receipt')
    return { kind: 'accepted', receipt: { inboxID } }
  }

  async listPendingQuestions(
    projectPath?: string,
    sessionId?: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeQuestionRequest[]> {
    let forms: unknown[]
    if (sessionId) {
      forms = arrayValue(dataOf(await this.request(`/api/session/${encodeURIComponent(sessionId)}/form`, { signal })))
    } else {
      const location = directory ?? projectPath
      const query = new URLSearchParams()
      if (location) query.set('location[directory]', location)
      const suffix = query.size > 0 ? `?${query}` : ''
      const response = await this.request(`/api/form${suffix}`, { signal })
      const payload = asRecord(response)
      forms = Array.isArray(response) ? response : arrayValue(payload?.data)
    }

    return forms
      .map(form => mapV2Question(form))
      .filter((form): form is OpenCodeQuestionRequest => Boolean(form) && (!sessionId || form?.sessionID === sessionId))
  }

  async replyQuestion(
    sessionId: string,
    requestId: string,
    answers: OpenCodeQuestionAnswer[],
    _directory: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const form = await this.getQuestionForm(sessionId, requestId, signal)
    const answer = mapV2QuestionAnswer(form, answers)
    await this.request(`/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestId)}/reply`, {
      method: 'POST',
      signal,
      expectedStatus: 204,
      body: { answer },
    })
  }

  async rejectQuestion(sessionId: string, requestId: string, _directory: string, signal?: AbortSignal): Promise<void> {
    await this.getQuestionForm(sessionId, requestId, signal)
    await this.request(`/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestId)}`, {
      method: 'DELETE',
      signal,
      expectedStatus: 204,
    })
  }

  async replyPermission(
    sessionId: string,
    permissionId: string,
    reply: 'always' | 'reject',
    _directory?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(`/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(permissionId)}/reply`, {
      method: 'POST',
      signal,
      expectedStatus: 204,
      body: { decision: reply },
    })
  }

  async interruptSession(sessionId: string, directory?: string): Promise<boolean> {
    const signal = AbortSignal.timeout(IDLE_WAIT_TIMEOUT_MS)
    try {
      await this.request(`/api/session/${encodeURIComponent(sessionId)}/interrupt?resume=false`, {
        method: 'POST',
        signal,
      })
    } catch (error) {
      if (isSessionNotFound(error)) return true
      throw error
    }
    await this.waitForIdle(sessionId, directory, signal)
    return true
  }

  async checkHealth(signal?: AbortSignal): Promise<HealthStatus> {
    let version: string | undefined
    try {
      const payload = asRecord(dataOf(await this.request('/api/info', { signal })))
      version = stringValue(payload?.version)
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      return {
        available: false,
        protocol: 'v2',
        failureKind: error instanceof V2OpenCodeHttpError && (error.status === 401 || error.status === 403) ? 'authentication' : 'network',
        error: error instanceof Error ? error.message : String(error),
      }
    }

    try {
      const models = flattenCatalogModels(await fetchProviderCatalog(signal), 'connected').map(model => model.fullId)
      return { available: true, protocol: 'v2', ...(version ? { version } : {}), models }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      const message = error instanceof Error ? error.message : String(error)
      const authentication = error instanceof V2OpenCodeHttpError
        ? error.status === 401 || error.status === 403
        : /\b(?:401|403)\b/.test(message)
      return {
        available: !authentication,
        protocol: 'v2',
        ...(version ? { version } : {}),
        models: [],
        failureKind: authentication ? 'authentication' : 'model_discovery',
        error: authentication ? message : `OpenCode is reachable, but model discovery failed: ${message}`,
      }
    }
  }

  private async getQuestionForm(sessionId: string, requestId: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestId)}`,
      { signal },
    )
    const form = dataOf(response)
    if (!isV2QuestionForm(form)) throw new Error(`OpenCode v2 form ${requestId} is not a question`)
    const record = asRecord(form)
    if (record?.sessionID !== sessionId) throw new Error(`OpenCode v2 form ${requestId} belongs to another session`)
    return form
  }

  private async request(
    path: string,
    options: {
      method?: string
      query?: URLSearchParams
      body?: unknown
      signal?: AbortSignal
      expectedStatus?: number
      timeoutMs?: number | null
    } = {},
  ): Promise<unknown> {
    const url = this.makeUrl(path, options.query)
    const headers = new Headers(this.headers)
    headers.set('accept', 'application/json')
    const timeout = options.timeoutMs === null
      ? undefined
      : createTimeoutSignal(options.signal, options.timeoutMs ?? API_OPERATION_TIMEOUT_MS, 'OpenCode v2 request timed out')
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      signal: timeout?.signal ?? options.signal,
      redirect: 'manual',
    }
    if (options.body !== undefined) {
      headers.set('content-type', 'application/json')
      init.body = JSON.stringify(options.body)
    }

    try {
      const response = await this.fetcher(url, init)
      const expectedStatus = options.expectedStatus ?? 200
      if (response.status !== expectedStatus) {
        throw new V2OpenCodeHttpError(response.status, await responseBody(response))
      }
      if (expectedStatus === 204) {
        await response.body?.cancel().catch(() => undefined)
        return undefined
      }
      return await responseBody(response)
    } finally {
      timeout?.dispose()
    }
  }

  private async openSse(path: string, query: URLSearchParams | undefined, signal?: AbortSignal): Promise<SseConnection> {
    const url = this.makeUrl(path, query)
    const headers = new Headers(this.headers)
    headers.set('accept', 'text/event-stream')
    const controller = new AbortController()
    const abortFromCaller = () => controller.abort(signal?.reason)
    if (signal?.aborted) throw signal.reason
    signal?.addEventListener('abort', abortFromCaller, { once: true })

    const connectTimeout = createTimeoutSignal(signal, EVENT_CONNECT_TIMEOUT_MS, 'OpenCode v2 event stream connection timed out')
    const fetchSignal = AbortSignal.any([controller.signal, connectTimeout.signal])

    let response: Response
    try {
      response = await this.fetcher(url, { method: 'GET', headers, signal: fetchSignal, redirect: 'manual' })
    } catch (error) {
      connectTimeout.dispose()
      signal?.removeEventListener('abort', abortFromCaller)
      if (signal?.aborted) throw signal.reason
      if (connectTimeout.timedOut()) throw connectTimeout.signal.reason
      throw error
    }
    connectTimeout.dispose()

    if (signal?.aborted || connectTimeout.timedOut()) {
      await response.body?.cancel().catch(() => undefined)
      signal?.removeEventListener('abort', abortFromCaller)
      throw signal?.aborted ? signal.reason : connectTimeout.signal.reason
    }

    if (!response.ok) {
      signal?.removeEventListener('abort', abortFromCaller)
      throw new V2OpenCodeHttpError(response.status, await responseBody(response))
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      signal?.removeEventListener('abort', abortFromCaller)
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`OpenCode v2 returned ${response.headers.get('content-type') ?? 'no content type'} for an event stream`)
    }
    if (!response.body) {
      signal?.removeEventListener('abort', abortFromCaller)
      throw new Error('OpenCode v2 returned an event stream without a response body')
    }

    const iterator = parseSse(response.body)[Symbol.asyncIterator]()
    let closed = false
    return {
      iterator,
      next: async (timeoutMs, timeoutMessage) => {
        if (!timeoutMs) return await iterator.next()
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort(new DOMException(timeoutMessage ?? 'OpenCode v2 event stream timed out', 'TimeoutError'))
        }, timeoutMs)
        try {
          return await iterator.next()
        } catch (error) {
          if (timedOut) throw controller.signal.reason
          throw error
        } finally {
          clearTimeout(timer)
        }
      },
      close: async () => {
        if (closed) return
        closed = true
        if (!controller.signal.aborted) controller.abort(new DOMException('OpenCode v2 event stream closed', 'AbortError'))
        signal?.removeEventListener('abort', abortFromCaller)
        try {
          await iterator.return?.(undefined)
        } catch {
          // Closing a fetch stream can reject its pending reader after abort.
        }
      },
    }
  }

  private async openEventStream(signal?: AbortSignal): Promise<SseConnection> {
    if (signal?.aborted) throw signal.reason
    const connection = await this.openSse('/api/event', undefined, signal)
    try {
      const first = await connection.next(EVENT_CONNECT_TIMEOUT_MS, 'OpenCode v2 event stream did not send server.connected')
      if (signal?.aborted) throw signal.reason
      if (first.done || asRecord(first.value)?.type !== 'server.connected') {
        throw new Error('OpenCode v2 event stream did not start with server.connected')
      }
      return connection
    } catch (error) {
      await connection.close()
      throw error
    }
  }

  private async scanSessionLog(
    sessionId: string,
    after: number | undefined,
    signal: AbortSignal | undefined,
    onEvent?: (event: OpenCodeTransportEventEnvelope) => void,
    mappingState: ReturnType<typeof createV2EventMappingState> = createV2EventMappingState(),
  ): Promise<SessionLogScan> {
    const query = new URLSearchParams({ follow: 'false' })
    if (after !== undefined) query.set('after', String(after))
    const deadline = createTimeoutSignal(signal, LOG_SYNC_TIMEOUT_MS, 'OpenCode v2 session log did not reach log.synced')
    let connection: SseConnection | undefined
    let maxSequence = after ?? 0
    let lastCoveredSequence = after
    let coverageComplete = true
    const seen = new Set<number>()
    try {
      connection = await this.openSse(
        `/api/experimental/session/${encodeURIComponent(sessionId)}/log`,
        query,
        deadline.signal,
      )
      while (true) {
        const result = await connection.next()
        if (result.done) {
          if (deadline.signal.aborted) throw deadline.signal.reason
          throw new Error('OpenCode v2 session log ended before log.synced')
        }
        const event = asRecord(result.value)
        if (!event || typeof event.type !== 'string') continue

        if (event.type === 'log.synced') {
          const aggregateID = stringValue(event.aggregateID)
          if (aggregateID !== undefined && aggregateID !== sessionId) {
            throw new Error('OpenCode v2 session log watermark belongs to another session')
          }
          const watermark = numberValue(event.seq)
          const hasWatermark = watermark !== undefined && Number.isSafeInteger(watermark)
          if (!hasWatermark || (after !== undefined && lastCoveredSequence !== watermark)) {
            coverageComplete = false
          }
          return {
            cursor: Math.max(maxSequence, watermark ?? 0),
            coverageComplete,
            hasWatermark,
          }
        }

        const durable = asRecord(event.durable)
        const aggregateID = stringValue(durable?.aggregateID)
        const sequence = numberValue(durable?.seq)
        if (aggregateID !== sessionId || sequence === undefined) {
          throw new Error('OpenCode v2 session log returned an event without its session cursor')
        }
        maxSequence = Math.max(maxSequence, sequence)
        if (after !== undefined && sequence <= after) continue
        if (seen.has(sequence)) continue
        seen.add(sequence)
        if (after !== undefined) {
          if (sequence !== lastCoveredSequence! + 1) coverageComplete = false
          if (sequence > lastCoveredSequence!) lastCoveredSequence = sequence
        } else if (lastCoveredSequence !== undefined && sequence !== lastCoveredSequence + 1) {
          coverageComplete = false
        } else {
          lastCoveredSequence = sequence
        }
        const mapped = mapV2Event(event, sessionId, mappingState, true)
        if (mapped) onEvent?.(mapped)
        else coverageComplete = false
      }
    } finally {
      deadline.dispose()
      await connection?.close()
    }
  }

  private async *followEvents(
    initialConnection: SseConnection,
    sessionId: string,
    initialCursor: number,
    backlog: OpenCodeTransportEventEnvelope[],
    signal: AbortSignal | undefined,
    ownedConnections: Set<SseConnection>,
    closeConnections: () => Promise<void>,
    state: ReturnType<typeof createV2EventMappingState>,
    initialCoverageGap: boolean,
  ): AsyncGenerator<OpenCodeTransportEventEnvelope> {
    let connection = initialConnection
    let cursor = initialCursor
    let coveredThrough = initialCursor
    let coverageGap = initialCoverageGap
    let reconnects = 0
    const seen = new Set<number>(backlog.flatMap(event => event.cursor === undefined ? [] : [event.cursor]))

    try {
      for (const event of backlog) yield coverageGap ? { ...event, coverageGap: true } : event
      while (true) {
        if (signal?.aborted) throw signal.reason
        try {
          const result = await connection.next()
          if (result.done) throw new Error('OpenCode v2 event stream closed')
          const raw = asRecord(result.value)
          if (!raw || raw.type === 'server.connected') continue
          const sequence = numberValue(asRecord(raw.durable)?.seq)
          if (sequence !== undefined && sequence <= coveredThrough) continue
          if (sequence !== undefined && seen.has(sequence)) continue
          const rawSessionId = stringValue(asRecord(raw.data)?.sessionID)
            ?? stringValue(asRecord(asRecord(raw.data)?.form)?.sessionID)
          const aggregateId = stringValue(asRecord(raw.durable)?.aggregateID)
          const belongsToSession = rawSessionId === sessionId || aggregateId === sessionId
          if (sequence !== undefined && belongsToSession) {
            if (sequence !== cursor + 1) coverageGap = true
            seen.add(sequence)
            cursor = Math.max(cursor, sequence)
          }

          const mapped = mapV2Event(raw, sessionId, state)
          if (!mapped) {
            if (sequence !== undefined && belongsToSession) coverageGap = true
            continue
          }
          yield coverageGap ? { ...mapped, coverageGap: true } : mapped
        } catch (error) {
          if (signal?.aborted) throw signal.reason
          reconnects++
          if (reconnects > EVENT_RECONNECT_ATTEMPTS) {
            throw new Error('OpenCode v2 event stream could not reconnect; the accepted prompt was not resubmitted', { cause: error })
          }

          const reconnected = await this.openEventStream(signal)
          ownedConnections.add(reconnected)
          const fetchPendingPermissions = !coverageGap
          const pendingPermissionsResponse = fetchPendingPermissions
            ? await this.request(`/api/session/${encodeURIComponent(sessionId)}/permission`, { signal })
            : undefined
          const replayEvents: OpenCodeTransportEventEnvelope[] = []
          let replay: SessionLogScan
          try {
            replay = await this.scanSessionLog(
              sessionId,
              cursor,
              signal,
              event => replayEvents.push(event),
              state,
            )
          } catch (replayError) {
            await reconnected.close()
            throw replayError
          }
          if (!replay.coverageComplete) coverageGap = true
          await connection.close()
          connection = reconnected
          const pendingPermissions: OpenCodeTransportEventEnvelope[] = []
          if (replay.coverageComplete && !coverageGap && fetchPendingPermissions) {
            const response = dataOf(pendingPermissionsResponse)
            if (!Array.isArray(response)) throw new Error('OpenCode v2 returned an invalid pending permission list')
            for (const request of response) {
              const event = mapV2Event({ type: 'permission.asked', data: request }, sessionId, state)
              if (!event?.event || event.event.type !== 'permission') {
                throw new Error('OpenCode v2 returned an invalid pending permission request')
              }
              pendingPermissions.push(event)
            }
          }
          for (const event of replayEvents) {
            const sequence = event.cursor
            if (sequence !== undefined && seen.has(sequence)) continue
            if (sequence !== undefined) {
              seen.add(sequence)
              cursor = Math.max(cursor, sequence)
            }
            yield coverageGap ? { ...event, coverageGap: true } : event
          }
          for (const permission of pendingPermissions) yield permission
          cursor = Math.max(cursor, replay.cursor)
          coveredThrough = Math.max(coveredThrough, replay.cursor)
        }
      }
    } finally {
      await closeConnections()
    }
  }

  private makeUrl(path: string, query?: URLSearchParams): URL {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl)
    if (query) {
      for (const [key, value] of query) url.searchParams.append(key, value)
    }
    return url
  }
}

function closeOnIteratorReturn<T>(
  source: AsyncGenerator<T, void, unknown>,
  close: () => Promise<void>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        [Symbol.asyncIterator]() {
          return this
        },
        next(value?: unknown) {
          return source.next(value)
        },
        async return(value?: unknown) {
          await close()
          return await source.return(value as void)
        },
        async throw(error?: unknown) {
          await close()
          return await source.throw(error)
        },
      }
    },
  }
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      if (buffer.length > 16 * 1024 * 1024) throw new Error('OpenCode v2 sent an event larger than 16 MiB')
      const endsWithCarriageReturn = !chunk.done && buffer.endsWith('\r')
      if (endsWithCarriageReturn) buffer = buffer.slice(0, -1)
      buffer = buffer.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
      if (endsWithCarriageReturn) buffer += '\r'
      if (chunk.done && buffer) buffer += '\n\n'

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = block.split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (data) {
          try {
            yield JSON.parse(data) as unknown
          } catch (error) {
            throw new Error('OpenCode v2 sent malformed JSON in an event stream', { cause: error })
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
      if (chunk.done) return
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The caller may already have aborted the fetch body.
    }
    reader.releaseLock()
  }
}

function createTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number, message: string) {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new DOMException(message, 'TimeoutError')), timeoutMs)
  return {
    signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
    timedOut: () => timeout.signal.aborted,
    dispose: () => clearTimeout(timer),
  }
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function dataOf(value: unknown): unknown {
  const record = asRecord(value)
  return record && Object.hasOwn(record, 'data') ? record.data : value
}

function isSessionNotFound(error: unknown): error is V2OpenCodeHttpError {
  return error instanceof V2OpenCodeHttpError
    && error.status === 404
    && asRecord(error.body)?._tag === 'SessionNotFoundError'
}

function errorMessage(status: number, body: unknown): string {
  const message = findMessage(body)
  return message ? `OpenCode v2 request failed (HTTP ${status}): ${message}` : `OpenCode v2 request failed (HTTP ${status})`
}

function findMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined
  const record = asRecord(value)
  if (!record) return typeof value === 'string' ? value : undefined
  if (typeof record.message === 'string') return record.message
  for (const child of Object.values(record)) {
    const message = findMessage(child, depth + 1)
    if (message) return message
  }
  return undefined
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
