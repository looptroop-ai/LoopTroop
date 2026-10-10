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
const DIAGNOSTIC_URL_PATTERN = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi
const URL_USERINFO_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i
const CREDENTIAL_VALUE_PATTERN = /((?<![a-z0-9_-])[a-z0-9_-]*?(?:authorization|x[-_\s]?api[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret|cookie|set[-_\s]?cookie|token|client[-_\s]?secret|private[-_\s]?key|access[-_\s]?key|secret[-_\s]?key)\b["']?\s*(?:headers?(?:[ \t]+value)?\s*)?[:=]\s*)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|(?:(?:Bearer|Basic)\s+)?[^"',\s}&]+)/gi
const AUTHORIZATION_VALUE_PATTERN = /((?<![a-z0-9_-])[a-z0-9_-]*?authorization\b["']?\s*(?:headers?(?:[ \t]+value)?\s*)?[:=]\s*)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|(?:[A-Za-z][\w.-]*\s+)?[^"',\s}&]+)/gi
const COOKIE_VALUE_PATTERN = /((?<![a-z0-9_-])[a-z0-9_-]*?(?:set[-_\s]?cookie|cookie)\b["']?\s*(?:headers?(?:[ \t]+value)?\s*)?[:=]\s*)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|[^\n]+)/gi
const CREDENTIAL_WORD_PATTERN = /(\b(?:x[-_\s]?api[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\b[ \t]+(?:(?:headers?(?:[ \t]+value)?|provided|code)(?:[ \t]*[:=]\s*|[ \t]+(?:(?:is|was|has)[ \t]+(?:not[ \t]+)?)?)|(?:is|was|has)[ \t]+(?:not[ \t]+)?)?)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|(?:(?:Bearer|Basic)\s+)?[^"',\s}&]+)/gi
const AUTHORIZATION_WORD_PATTERN = /(\bauthorization\b[ \t]+(?:(?:headers?(?:[ \t]+value)?|provided|code)(?:[ \t]*[:=]\s*|[ \t]+(?:(?:is|was|has)[ \t]+(?:not[ \t]+)?)?)|(?:is|was|has)[ \t]+(?:not[ \t]+)?)?)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|(?:(?:Bearer|Basic)\s+|[A-Za-z][\w.-]*[ \t]+)?[^"',\s}&]+)/gi
const COOKIE_WORD_PATTERN = /(\b(?:set[-_\s]?cookie|cookie)\b[ \t]+(?:(?:headers?(?:[ \t]+value)?|provided)(?:[ \t]*[:=]\s*|[ \t]+(?:(?:is|was|has)[ \t]+(?:not[ \t]+)?)?)|(?:is|was|has)[ \t]+(?:not[ \t]+)?)?)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|[^"',\s};]+(?:[ \t]*;[^\n]*)?)/gi
const AUTHORIZATION_TOKEN_PATTERN = /\b((?:Bearer|Basic)\s+)([A-Za-z0-9._~+/-]+=*)/gi
const CREDENTIAL_PROSE_PATTERN = /^(?:headers?|banner|required|missing|invalid|expired|denied|failed|unavailable|available|not|is|are|was|has|been|stale|rotated|valid|limit)\b/i
const PREFIXED_CREDENTIAL_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[abprs]-[A-Za-z0-9-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b/g

function redactCredentialValue(_match: string, prefix: string, value: string): string {
  const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : ''
  const closingQuote = quote && value.length > 1 && value.endsWith(quote) ? quote : ''
  return `${prefix}${quote}${REDACTED}${closingQuote}`
}

function redactCredentialWord(match: string, prefix: string, value: string): string {
  if (!/[:=]\s*$/.test(prefix) && CREDENTIAL_PROSE_PATTERN.test(value)) return match
  return redactCredentialValue(match, prefix, value)
}

function sanitizeDiagnosticUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const withoutParameters = url.split(/[?#]/, 1)[0] ?? ''
    return parsed.username || parsed.password ? withoutParameters.replace(URL_USERINFO_PATTERN, '$1') : withoutParameters
  } catch {
    // Malformed userinfo can contain raw query/hash markers before the @.
    return url.replace(URL_USERINFO_PATTERN, '$1').split(/[?#]/, 1)[0] ?? ''
  }
}

/** Clean and redact complete diagnostic text before any preview is shortened. */
export function sanitizeDiagnosticText(value: string): string {
  return stripTerminalFormatting(value)
    .replace(DIAGNOSTIC_URL_PATTERN, sanitizeDiagnosticUrl)
    .replace(PREFIXED_CREDENTIAL_PATTERN, REDACTED)
    .replace(AUTHORIZATION_VALUE_PATTERN, redactCredentialValue)
    .replace(COOKIE_VALUE_PATTERN, redactCredentialValue)
    .replace(CREDENTIAL_VALUE_PATTERN, redactCredentialValue)
    .replace(AUTHORIZATION_WORD_PATTERN, redactCredentialWord)
    .replace(COOKIE_WORD_PATTERN, redactCredentialWord)
    .replace(CREDENTIAL_WORD_PATTERN, redactCredentialWord)
    .replace(AUTHORIZATION_TOKEN_PATTERN, `$1${REDACTED}`)
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
