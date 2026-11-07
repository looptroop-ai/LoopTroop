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
} from "./types";

export interface OpenCodePromptRequest {
  sessionId: string;
  directory?: string;
  parts: PromptPart[];
  model?: ModelSelection;
  agent?: string;
  variant?: string;
  system?: string;
  noReply?: boolean;
  tools?: Record<string, boolean>;
}

const PROMPT_NOT_SENT = Symbol("opencode.promptNotSent");

/**
 * Marks a dispatch failure that happened before the prompt itself was sent
 * (v2 model, agent or instruction setup), so the adapter can repeat it.
 */
export function markPromptNotSent(error: unknown): unknown {
  if (error instanceof Object && Object.isExtensible(error)) {
    Object.defineProperty(error, PROMPT_NOT_SENT, { value: true });
  }
  return error;
}

export function isPromptNotSent(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current instanceof Object && depth < 8; depth++) {
    if ((current as Record<symbol, unknown>)[PROMPT_NOT_SENT] === true) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface PromptReceipt {
  inboxID: string;
}

export interface OpenCodeShellCompletion {
  shellID: string;
  jobID: string;
  state: "completed" | "error" | "cancelled";
}

export interface OpenCodeInboxItem {
  type?: string;
  delivery?: "steer" | "queue";
  shellCompletion?: OpenCodeShellCompletion;
}

export interface OpenCodePendingInbox {
  id: string;
  sessionID?: string;
  item?: OpenCodeInboxItem;
}

export class OpenCodePromptReceiptUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    options?: ErrorOptions,
  ) {
    const cause = options?.cause instanceof Error && options.cause.message
      ? ` (${options.cause.message})`
      : "";
    super(
      `OpenCode did not confirm that it received the prompt${cause}, so LoopTroop cannot tell whether the AI started working on it.`,
      options,
    );
    this.name = "OpenCodePromptReceiptUnavailableError";
  }
}

/** How a v2 permission reply was confirmed, for the Debug log. */
export interface PermissionReplyReceipt {
  attempts: number;
  /** response: OpenCode answered; pending_check / not_found_on_retry: an earlier timed-out attempt had landed. */
  confirmedBy: "response" | "pending_check" | "not_found_on_retry";
}

export type PromptDispatch =
  | { kind: "completed"; message: Message }
  | { kind: "accepted"; receipt: PromptReceipt };

export type OpenCodeTransportEvent =
  | StreamEvent
  | {
      type: "inbox_enqueued";
      sessionId: string;
      inboxID: string;
      item?: OpenCodeInboxItem;
    }
  | { type: "inbox_delivered"; sessionId: string; inboxID: string }
  | { type: "inbox_cancelled"; sessionId: string; inboxID: string }
  | {
      type: "inbox_delivery_changed";
      sessionId: string;
      inboxID: string;
      delivery: "steer" | "queue";
    }
  | { type: "execution_started"; sessionId: string }
  | {
      type: "execution_terminal";
      sessionId: string;
      outcome: "succeeded" | "failed" | "interrupted";
      error?: unknown;
    };

export interface OpenCodeTransportEventEnvelope {
  /** Absent when a known durable event only advances the session cursor. */
  event?: OpenCodeTransportEvent;
  cursor?: number;
  /** Previous cursor on an uninterrupted public stream, which omits internal durable events. */
  observedAfter?: number;
  /** Missing replay or an unmapped durable event makes this and later events unsafe. */
  coverageGap?: true;
}

export interface OpenCodeEventSubscription {
  /** The subscription promise resolves only after the server has opened the stream. */
  events: AsyncIterable<OpenCodeTransportEventEnvelope>;
  /** Initial ordered evidence delivered before the live iterator starts. */
  initialEvents?: readonly OpenCodeTransportEventEnvelope[];
  /** The `log.synced` watermark through which this subscription is certified. */
  cursor?: number;
  /** Whether the requested range through `cursor` is fully accounted for. */
  coverageComplete?: boolean;
  /** Releases the event stream when setup fails before iteration begins. */
  close?: () => Promise<void>;
}

export interface OpenCodeSessionLog {
  /** Events after the requested cursor, returned only after `log.synced`. */
  events: OpenCodeTransportEventEnvelope[];
  /** The `log.synced` cursor is a watermark, not proof that earlier payloads were replayed. */
  cursor?: number;
  /** False when a requested sequence was omitted or an event this client cannot map. */
  coverageComplete?: boolean;
  /** True when replay included a durable event this client could not map. */
  hasUnmappedEvents?: boolean;
}

export const OPEN_CODE_V2_EVENT_SYNC_TIMEOUT_MS = 30_000;

export interface OpenCodeSessionUpdateOptions {
  permission?: ReadonlyArray<OpenCodePermissionRule>;
}

/** Protocol-specific wire operations normalized to LoopTroop-owned types. */
export interface OpenCodeTransport {
  readonly protocol: "v1" | "v2";

  createSession(
    projectPath: string,
    options?: OpenCodeSessionCreateOptions,
    signal?: AbortSignal,
  ): Promise<Session>;
  deleteSession(
    sessionId: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  updateSession(
    sessionId: string,
    directory: string | undefined,
    options: OpenCodeSessionUpdateOptions,
    signal?: AbortSignal,
  ): Promise<void>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<Session | null>;
  listSessions(signal?: AbortSignal): Promise<Session[]>;
  /**
   * Every session id the server has, in every project, or null when this
   * transport cannot prove the listing complete (cut short, malformed, or a
   * protocol that lists one project only).
   */
  listAllSessionIds?(signal?: AbortSignal): Promise<ReadonlySet<string> | null>;
  getSessionMessages(
    sessionId: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<Message[]>;
  subscribeToEvents(
    sessionId: string,
    directory: string | undefined,
    signal?: AbortSignal,
    stepFinishSafetyMs?: number,
    afterCursor?: number,
  ): Promise<OpenCodeEventSubscription>;
  waitForIdle(
    sessionId: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  readSessionLog(
    sessionId: string,
    after?: number,
    signal?: AbortSignal,
  ): Promise<OpenCodeSessionLog>;
  listPendingInboxes?(
    sessionId: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<readonly OpenCodePendingInbox[]>;
  getPendingPermissions?(
    sessionId: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeTransportEventEnvelope[]>;
  retireSession?(
    sessionId: string,
    directory?: string,
  ): Promise<boolean>;
  dispatchPrompt(
    request: OpenCodePromptRequest,
    signal?: AbortSignal,
  ): Promise<PromptDispatch>;
  listPendingQuestions(
    projectPath?: string,
    sessionId?: string,
    directory?: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeQuestionRequest[]>;
  replyQuestion(
    sessionId: string,
    requestId: string,
    answers: OpenCodeQuestionAnswer[],
    directory: string,
    signal?: AbortSignal,
  ): Promise<void>;
  rejectQuestion(
    sessionId: string,
    requestId: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<void>;
  replyPermission(
    sessionId: string,
    permissionId: string,
    reply: "once" | "always" | "reject",
    directory?: string,
    signal?: AbortSignal,
    message?: string,
  ): Promise<PermissionReplyReceipt | void>;
  interruptSession(sessionId: string, directory?: string): Promise<boolean>;
  checkHealth(signal?: AbortSignal): Promise<HealthStatus>;
}
