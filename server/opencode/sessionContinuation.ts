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
import { looksBillingFailure, looksPermanentFailure, looksTransientFailure } from './failureSignals'

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
    || looksPermanentFailure(haystack)
    // A 402 is a billing problem this path can still resume from once it is
    // paid; every other billing failure is fatal here as it is for retry.
    || (statusCode !== 402 && looksBillingFailure(haystack))
}

function hasContinuableSignal(diagnostics: BlockedErrorDiagnostics): boolean {
  if (diagnostics.isRetryable === true) return true
  if (typeof diagnostics.statusCode === 'number' && CONTINUABLE_STATUS_CODES.has(diagnostics.statusCode)) return true
  if (isOtherClientError(diagnostics.statusCode)) return false
  if (diagnostics.kind === 'timeout' || diagnostics.kind === 'transport') return true

  const haystack = buildDiagnosticHaystack(diagnostics)
  return looksTransientFailure(haystack)
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

/**
 * `phase` is a lookup key, so it stays `string`.
 *
 * The map itself only ever holds real phase ids — `requestSessionContinuation`
 * takes a `WorkflowPhaseId` — but callers ask with a phase read off a stored
 * session row, and an unrecognised one should simply match nothing rather than
 * be rewritten into a phase that could match the wrong entry.
 */
export function getPendingSessionContinuationForTicketPhase(
  ticketId: string,
  phase: string,
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

/**
 * Drops every pending continuation for a ticket.
 *
 * Aborting a ticket's sessions marked them abandoned but left their
 * continuations in place, and a continuation stays valid for thirty minutes —
 * long enough for the *next* run of the same ticket to pick one up and reapply
 * the abandoned run's extra retry attempts.
 */
export function clearTicketSessionContinuations(ticketId: string): number {
  let cleared = 0
  for (const [sessionId, pending] of pendingSessionContinuations) {
    if (pending.ticketId !== ticketId) continue
    pendingSessionContinuations.delete(sessionId)
    cleared += 1
  }
  return cleared
}

export function hasPendingSessionContinuationForTicketPhase(ticketId: string, phase: string): boolean {
  return getPendingSessionContinuationForTicketPhase(ticketId, phase) !== null
}

export function clearAllPendingSessionContinuationsForTests(): void {
  pendingSessionContinuations.clear()
}
