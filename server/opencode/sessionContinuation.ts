import { OPENCODE_PROVIDER_AUTH_FAILED } from '@shared/errorCodes'
import type { BlockedErrorDiagnostics } from '@shared/errorDiagnostics'
import {
  attachOpenCodeBlockedErrorDiagnostics,
  buildOpenCodeBlockedErrorDiagnostics,
  type OpenCodeBlockedErrorDiagnosticsResult,
} from './blockedErrorDiagnostics'
import type { OpenCodeResponseMeta } from './assistantMessageAnalysis'
import type { SessionOwnership } from './sessionManager'
import { isWorkflowDeadlineTimeoutError } from '../lib/deadlineErrors'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

const CONTINUABLE_STATUS_CODES = new Set([402, 408, 429, 500, 502, 503, 504, 529])
const NON_CONTINUABLE_STATUS_CODES = new Set([400, 401, 403, 404, 413, 422])
const PENDING_CONTINUATION_TTL_MS = 30 * 60 * 1000

export interface PendingSessionContinuation {
  ticketId: string
  phase: WorkflowPhaseId
  sessionId: string
  requestedAt: string
  prompt?: string
  additionalRetryAttempts?: number
}

export interface ContinuableBlockedErrorInput {
  diagnostics?: BlockedErrorDiagnostics | null
  errorCodes?: string[] | null
}

export interface BuildContinuationDiagnosticsInput {
  error?: unknown
  responseMeta?: OpenCodeResponseMeta
  modelId?: string
  sessionId?: string
  fallbackMessage?: string
}

export interface PreserveSessionForContinuationInput extends BuildContinuationDiagnosticsInput {
  sessionOwnership?: SessionOwnership & { ticketId?: string; phase?: WorkflowPhaseId; keepActive?: boolean }
  signal?: AbortSignal
}

const pendingSessionContinuations = new Map<string, PendingSessionContinuation>()

function pruneStalePendingContinuations(now = Date.now()): void {
  for (const [sessionId, pending] of pendingSessionContinuations) {
    const requestedAt = Date.parse(pending.requestedAt)
    if (Number.isNaN(requestedAt) || now - requestedAt > PENDING_CONTINUATION_TTL_MS) {
      pendingSessionContinuations.delete(sessionId)
    }
  }
}

function normalizeText(value: string | undefined | null): string {
  return value?.trim().toLowerCase() ?? ''
}

function buildDiagnosticHaystack(diagnostics: BlockedErrorDiagnostics | null | undefined): string {
  return [
    diagnostics?.summary,
    diagnostics?.providerErrorType,
    diagnostics?.providerErrorTitle,
    diagnostics?.providerErrorMessage,
    diagnostics?.responseBodyPreview,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join('\n')
}

function isOtherClientError(statusCode: number | undefined): boolean {
  return typeof statusCode === 'number'
    && statusCode >= 400
    && statusCode < 500
    && !CONTINUABLE_STATUS_CODES.has(statusCode)
    && !NON_CONTINUABLE_STATUS_CODES.has(statusCode)
}

function hasNonContinuableSignal(input: ContinuableBlockedErrorInput): boolean {
  const diagnostics = input.diagnostics ?? null
  const errorCodes = input.errorCodes ?? []
  const haystack = buildDiagnosticHaystack(diagnostics)
  const statusCode = diagnostics?.statusCode

  return errorCodes.includes(OPENCODE_PROVIDER_AUTH_FAILED)
    || (typeof statusCode === 'number' && NON_CONTINUABLE_STATUS_CODES.has(statusCode))
    || /\b(invalid[_ -]?request|permission|auth|authentication|authenticated|unauthorized|forbidden|credential|api key|token|request[_ -]?too[_ -]?large|payload[_ -]?too[_ -]?large|model[_ -]?not[_ -]?found|provider[_ -]?model[_ -]?not[_ -]?found)\b/.test(haystack)
    || (statusCode !== 402 && /\b(billing|insufficient[_ -]?quota)\b/.test(haystack))
}

function hasContinuableSignal(diagnostics: BlockedErrorDiagnostics): boolean {
  if (diagnostics.isRetryable === true) return true
  if (typeof diagnostics.statusCode === 'number' && CONTINUABLE_STATUS_CODES.has(diagnostics.statusCode)) return true
  if (isOtherClientError(diagnostics.statusCode)) return false
  if (diagnostics.kind === 'timeout' || diagnostics.kind === 'transport') return true

  const haystack = buildDiagnosticHaystack(diagnostics)
  return /\b(rate[_ -]?(?:limit|limited)|too many requests|usage limit|limit (?:has been )?reached|resource exhausted|overloaded|overload|capacity|service unavailable|temporarily unavailable|timeout|timed out|deadline(?: exceeded)?|fetch failed|connection reset|socket reset|econnreset|etimedout|eai_again|enotfound|econnrefused|socket hang up|network)\b/.test(haystack)
}

export function isContinuableBlockedError(input: ContinuableBlockedErrorInput): boolean {
  const diagnostics = input.diagnostics ?? null
  if (!diagnostics?.sessionId) return false
  if (hasNonContinuableSignal(input)) return false
  return hasContinuableSignal(diagnostics)
}

export function buildContinuationDiagnostics(
  input: BuildContinuationDiagnosticsInput,
): OpenCodeBlockedErrorDiagnosticsResult {
  return buildOpenCodeBlockedErrorDiagnostics({
    error: input.error,
    responseMeta: input.responseMeta,
    modelId: input.modelId,
    sessionId: input.sessionId,
    fallbackMessage: input.fallbackMessage,
  })
}

export function shouldPreserveSessionForContinuation(input: PreserveSessionForContinuationInput): boolean {
  if (input.signal?.aborted) return false
  if (isWorkflowDeadlineTimeoutError(input.error)) return false
  if (!input.sessionId || !input.sessionOwnership?.ticketId || !input.sessionOwnership.phase) return false

  const diagnosticResult = buildContinuationDiagnostics(input)
  return isContinuableBlockedError({
    diagnostics: diagnosticResult.diagnostics,
    errorCodes: diagnosticResult.errorCodes,
  })
}

export function attachContinuationDiagnostics<T extends Error>(
  error: T,
  input: BuildContinuationDiagnosticsInput,
): T {
  return attachOpenCodeBlockedErrorDiagnostics(error, buildContinuationDiagnostics(input))
}

export function requestSessionContinuation(input: {
  ticketId: string
  phase: WorkflowPhaseId
  sessionId: string
  requestedAt?: string
  prompt?: string
  additionalRetryAttempts?: number
}): PendingSessionContinuation {
  pruneStalePendingContinuations()
  const pending: PendingSessionContinuation = {
    ticketId: input.ticketId,
    phase: input.phase,
    sessionId: input.sessionId,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.additionalRetryAttempts !== undefined
      ? { additionalRetryAttempts: input.additionalRetryAttempts }
      : {}),
  }
  pendingSessionContinuations.set(input.sessionId, pending)
  return pending
}

export function getPendingSessionContinuationForTicketPhase(
  ticketId: string,
  phase: WorkflowPhaseId,
): PendingSessionContinuation | null {
  pruneStalePendingContinuations()
  for (const pending of pendingSessionContinuations.values()) {
    if (pending.ticketId === ticketId && pending.phase === phase) return pending
  }
  return null
}

export function consumeSessionContinuation(input: {
  ticketId: string
  phase: WorkflowPhaseId
  sessionId: string
}): PendingSessionContinuation | null {
  pruneStalePendingContinuations()
  const pending = pendingSessionContinuations.get(input.sessionId)
  if (!pending) return null
  if (pending.ticketId !== input.ticketId || pending.phase !== input.phase) return null
  pendingSessionContinuations.delete(input.sessionId)
  return pending
}

export function clearSessionContinuation(sessionId: string): void {
  pendingSessionContinuations.delete(sessionId)
}

export function hasPendingSessionContinuationForTicketPhase(ticketId: string, phase: WorkflowPhaseId): boolean {
  return getPendingSessionContinuationForTicketPhase(ticketId, phase) !== null
}

export function clearAllPendingSessionContinuationsForTests(): void {
  pendingSessionContinuations.clear()
}
