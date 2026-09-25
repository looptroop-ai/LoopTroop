import type {
  HealthStatus,
  Message,
  ModelSelection,
  OpenCodePermissionRule,
  OpenCodeQuestionAnswer,
  OpenCodeQuestionRequest,
  OpenCodeSessionCreateOptions,
  PromptPart,
  Session,
  StreamEvent,
} from './types'

export interface OpenCodePromptRequest {
  sessionId: string
  directory?: string
  parts: PromptPart[]
  model?: ModelSelection
  agent?: string
  variant?: string
  system?: string
  noReply?: boolean
  tools?: Record<string, boolean>
}

export interface PromptReceipt {
  inboxID: string
}

export type PromptDispatch =
  | { kind: 'completed'; message: Message }
  | { kind: 'accepted'; receipt: PromptReceipt }

export type OpenCodeTransportEvent =
  | StreamEvent
  | { type: 'inbox_enqueued'; sessionId: string; inboxID: string }
  | { type: 'inbox_delivered'; sessionId: string; inboxID: string }
  | { type: 'execution_started'; sessionId: string }
  | {
      type: 'execution_terminal'
      sessionId: string
      outcome: 'succeeded' | 'failed' | 'interrupted'
      error?: unknown
    }

export interface OpenCodeTransportEventEnvelope {
  /** Absent when a known durable event only advances the session cursor. */
  event?: OpenCodeTransportEvent
  cursor?: number
  /** A prior durable sequence gap means this and later events cannot certify attribution. */
  coverageGap?: true
}

export interface OpenCodeEventSubscription {
  /** The subscription promise resolves only after the server has opened the stream. */
  events: AsyncIterable<OpenCodeTransportEventEnvelope>
  /** Durable v2 log sequence captured at the `log.synced` watermark. */
  cursor?: number
  /** Whether history after the supplied cursor is fully accounted for. */
  coverageComplete?: boolean
}

export interface OpenCodeSessionLog {
  /** Events after the requested cursor, returned only after `log.synced`. */
  events: OpenCodeTransportEventEnvelope[]
  cursor?: number
  /** False when the log skipped durable history or an event this client cannot map. */
  coverageComplete?: boolean
}

export interface OpenCodeSessionUpdateOptions {
  permission?: ReadonlyArray<OpenCodePermissionRule>
}

/** Protocol-specific wire operations normalized to LoopTroop-owned types. */
export interface OpenCodeTransport {
  readonly protocol: 'v1' | 'v2'

  createSession(projectPath: string, options?: OpenCodeSessionCreateOptions, signal?: AbortSignal): Promise<Session>
  updateSession(
    sessionId: string,
    directory: string | undefined,
    options: OpenCodeSessionUpdateOptions,
    signal?: AbortSignal,
  ): Promise<void>
  getSession(sessionId: string, signal?: AbortSignal): Promise<Session | null>
  listSessions(signal?: AbortSignal): Promise<Session[]>
  getSessionMessages(sessionId: string, directory?: string, signal?: AbortSignal): Promise<Message[]>
  subscribeToEvents(
    sessionId: string,
    directory: string | undefined,
    signal?: AbortSignal,
    stepFinishSafetyMs?: number,
    afterCursor?: number,
  ): Promise<OpenCodeEventSubscription>
  waitForIdle(sessionId: string, directory?: string, signal?: AbortSignal): Promise<void>
  readSessionLog(sessionId: string, after?: number, signal?: AbortSignal): Promise<OpenCodeSessionLog>
  dispatchPrompt(request: OpenCodePromptRequest, signal?: AbortSignal): Promise<PromptDispatch>
  listPendingQuestions(
    projectPath?: string,
    sessionId?: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeQuestionRequest[]>
  replyQuestion(
    sessionId: string,
    requestId: string,
    answers: OpenCodeQuestionAnswer[],
    directory: string,
    signal?: AbortSignal,
  ): Promise<void>
  rejectQuestion(sessionId: string, requestId: string, directory: string, signal?: AbortSignal): Promise<void>
  replyPermission(
    sessionId: string,
    permissionId: string,
    reply: 'always' | 'reject',
    directory?: string,
    signal?: AbortSignal,
  ): Promise<void>
  interruptSession(sessionId: string, directory?: string): Promise<boolean>
  checkHealth(signal?: AbortSignal): Promise<HealthStatus>
}
