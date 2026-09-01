/**
 * One tuple per union, with the type, the Zod enum and the guard all derived
 * from it.
 *
 * Each of these existed three times over — as a TypeScript union here, as a
 * `z.enum` at the storage boundary, and as a chain of `===` comparisons in the
 * normaliser below. Adding a kind meant editing all three, and forgetting the
 * `z.enum` meant stored rows with the new kind failed to parse and were
 * silently discarded. Order is preserved from the original declarations.
 */
export const BLOCKED_ERROR_DIAGNOSTIC_KINDS = [
  'model_output_truncated',
  'opencode_provider',
  'opencode_session',
  'timeout',
  'transport',
  'runtime',
  'unknown',
] as const

export type BlockedErrorDiagnosticKind = (typeof BLOCKED_ERROR_DIAGNOSTIC_KINDS)[number]

export const BLOCKED_ERROR_DIAGNOSTIC_SOURCES = ['opencode', 'provider', 'system', 'runtime'] as const

export type BlockedErrorDiagnosticSource = (typeof BLOCKED_ERROR_DIAGNOSTIC_SOURCES)[number]

export function isBlockedErrorDiagnosticKind(value: unknown): value is BlockedErrorDiagnosticKind {
  return (BLOCKED_ERROR_DIAGNOSTIC_KINDS as readonly unknown[]).includes(value)
}

export function isBlockedErrorDiagnosticSource(value: unknown): value is BlockedErrorDiagnosticSource {
  return (BLOCKED_ERROR_DIAGNOSTIC_SOURCES as readonly unknown[]).includes(value)
}

export interface BlockedErrorDiagnostics {
  kind: BlockedErrorDiagnosticKind
  source: BlockedErrorDiagnosticSource
  summary: string
  modelId?: string
  sessionId?: string
  providerId?: string
  providerModelId?: string
  statusCode?: number
  requestModel?: string
  isRetryable?: boolean
  providerErrorType?: string
  providerErrorTitle?: string
  providerErrorMessage?: string
  responseBodyPreview?: string
  finishReason?: string
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

import { isRecord } from './typeGuards'

const REDACTED = '[redacted]'
const CREDENTIAL_WORD_KEY_PATTERN = String.raw`(?:x[-_\s]?api[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)`
const CREDENTIAL_VALUE_PATTERN = /(["']?(?:authorization|x[-_\s]?api[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)["']?\s*[:=]\s*)(["']?)(?:Bearer\s+)?([^"',\s}&]+)(\2)/gi
const BEARER_TOKEN_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._~+/-]+=*)/gi
const CREDENTIAL_WORD_PATTERN = new RegExp(
  String.raw`\b(${CREDENTIAL_WORD_KEY_PATTERN})\s+(?:is\s+)?(["']?)([^"',\s}&]+)(\2)`,
  'gi',
)

function redactSensitive(value: string): string {
  CREDENTIAL_VALUE_PATTERN.lastIndex = 0
  BEARER_TOKEN_PATTERN.lastIndex = 0
  CREDENTIAL_WORD_PATTERN.lastIndex = 0
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(CREDENTIAL_VALUE_PATTERN, (_match, prefix: string, quote: string, _secret: string, closingQuote: string) =>
      `${prefix}${quote}${REDACTED}${closingQuote}`,
    )
    .replace(CREDENTIAL_WORD_PATTERN, (_match, key: string, quote: string, _secret: string, closingQuote: string) =>
      `${key} ${quote}${REDACTED}${closingQuote}`,
    )
    .replace(BEARER_TOKEN_PATTERN, `$1${REDACTED}`)
}

function cleanString(value: unknown, maxLength = 1000): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = redactSensitive(value.trim())
  if (!trimmed) return undefined
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function cleanBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function cleanKind(value: unknown): BlockedErrorDiagnosticKind | undefined {
  return isBlockedErrorDiagnosticKind(value) ? value : undefined
}

function cleanSource(value: unknown): BlockedErrorDiagnosticSource | undefined {
  return isBlockedErrorDiagnosticSource(value) ? value : undefined
}

export function normalizeBlockedErrorDiagnostics(value: unknown): BlockedErrorDiagnostics | null {
  if (!isRecord(value)) return null

  const summary = cleanString(value.summary)
    ?? cleanString(value.providerErrorMessage)
    ?? cleanString(value.providerErrorTitle)
    ?? cleanString(value.providerErrorType)
  if (!summary) return null

  const modelId = cleanString(value.modelId, 240)
  const sessionId = cleanString(value.sessionId, 240)
  const providerId = cleanString(value.providerId, 240)
  const providerModelId = cleanString(value.providerModelId, 240)
  const requestModel = cleanString(value.requestModel, 240)
  const providerErrorType = cleanString(value.providerErrorType, 240)
  const providerErrorTitle = cleanString(value.providerErrorTitle, 500)
  const providerErrorMessage = cleanString(value.providerErrorMessage)
  const responseBodyPreview = cleanString(value.responseBodyPreview)
  const finishReason = cleanString(value.finishReason, 240)

  return {
    kind: cleanKind(value.kind) ?? 'unknown',
    source: cleanSource(value.source) ?? 'system',
    summary,
    ...(modelId ? { modelId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(providerId ? { providerId } : {}),
    ...(providerModelId ? { providerModelId } : {}),
    ...(cleanNumber(value.statusCode) !== undefined ? { statusCode: cleanNumber(value.statusCode) } : {}),
    ...(requestModel ? { requestModel } : {}),
    ...(cleanBoolean(value.isRetryable) !== undefined ? { isRetryable: cleanBoolean(value.isRetryable) } : {}),
    ...(providerErrorType ? { providerErrorType } : {}),
    ...(providerErrorTitle ? { providerErrorTitle } : {}),
    ...(providerErrorMessage ? { providerErrorMessage } : {}),
    ...(responseBodyPreview ? { responseBodyPreview } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(cleanNumber(value.inputTokens) !== undefined ? { inputTokens: cleanNumber(value.inputTokens) } : {}),
    ...(cleanNumber(value.outputTokens) !== undefined ? { outputTokens: cleanNumber(value.outputTokens) } : {}),
    ...(cleanNumber(value.reasoningTokens) !== undefined ? { reasoningTokens: cleanNumber(value.reasoningTokens) } : {}),
    ...(cleanNumber(value.cacheReadTokens) !== undefined ? { cacheReadTokens: cleanNumber(value.cacheReadTokens) } : {}),
    ...(cleanNumber(value.cacheWriteTokens) !== undefined ? { cacheWriteTokens: cleanNumber(value.cacheWriteTokens) } : {}),
  }
}
