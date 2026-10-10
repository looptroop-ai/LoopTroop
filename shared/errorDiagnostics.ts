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
  operation?: string
  transportCode?: string
  causeMessage?: string
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
import { stripTerminalFormatting } from './errorDisplay'

const REDACTED = '[redacted]'
const CREDENTIAL_WORD_KEY_PATTERN = String.raw`(?:x[-_\s]?api[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret|authorization|cookie|set[-_\s]?cookie)`
const CREDENTIAL_KEY_PATTERN = String.raw`(?:[a-z0-9]+[-_])*(?:authorization|${CREDENTIAL_WORD_KEY_PATTERN}|token|client[-_\s]?secret|private[-_\s]?key|access[-_\s]?key|secret[-_\s]?key)`
const CREDENTIAL_VALUE = String.raw`(?:"(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|(?:(?:Bearer|Basic)\s+)?[^"',\s}&]+)`
const CREDENTIAL_VALUE_PATTERN = new RegExp(
  String.raw`((?<![a-z0-9_-])${CREDENTIAL_KEY_PATTERN}\b["']?\s*[:=]\s*)(${CREDENTIAL_VALUE})`,
  'gi',
)
const BEARER_TOKEN_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._~+/-]+=*)/gi
const CREDENTIAL_WORD_PATTERN = new RegExp(
  String.raw`(\b${CREDENTIAL_WORD_KEY_PATTERN}\b\s+(?:is\s+)?)(${CREDENTIAL_VALUE})`,
  'gi',
)
const PREFIXED_CREDENTIAL_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[abprs]-[A-Za-z0-9-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b/g

function redactCredentialValue(_match: string, prefix: string, value: string): string {
  if (/^(?:authorization|cookie|set[-_\s]?cookie)\s+(?:is\s+)?$/i.test(prefix)
    && /^(?:header|headers|banner|required|missing|invalid|expired|denied|failed|unavailable|not|was|has)[.!?]?$/i.test(value)) return _match
  const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : ''
  const closingQuote = quote && value.length > 1 && value.endsWith(quote) ? quote : ''
  return `${prefix}${quote}${REDACTED}${closingQuote}`
}

/** Clean and redact complete diagnostic text before any preview is shortened. */
export function sanitizeDiagnosticText(value: string): string {
  CREDENTIAL_VALUE_PATTERN.lastIndex = 0
  BEARER_TOKEN_PATTERN.lastIndex = 0
  CREDENTIAL_WORD_PATTERN.lastIndex = 0
  return stripTerminalFormatting(value)
    .replace(PREFIXED_CREDENTIAL_PATTERN, REDACTED)
    .replace(CREDENTIAL_VALUE_PATTERN, redactCredentialValue)
    .replace(CREDENTIAL_WORD_PATTERN, redactCredentialValue)
    .replace(BEARER_TOKEN_PATTERN, `$1${REDACTED}`)
}

function cleanString(value: unknown, maxLength = 1000): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = sanitizeDiagnosticText(value).trim()
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
  const operation = cleanString(value.operation, 240)
  const transportCode = cleanString(value.transportCode, 240)
  const causeMessage = cleanString(value.causeMessage)
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
    ...(operation ? { operation } : {}),
    ...(transportCode ? { transportCode } : {}),
    ...(causeMessage ? { causeMessage } : {}),
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
