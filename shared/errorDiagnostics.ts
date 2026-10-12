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
  errorName?: string
  stackTrace?: string
  failedChecks?: Array<{ name: string; category: string; message: string; details?: string }>
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
const CREDENTIAL_VALUE_PATTERN = /((?<![a-z0-9_-])[a-z0-9_-]*(?:authorization|x[-_\s]?api[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret|token|client[-_\s]?secret|private[-_\s]?key|access[-_\s]?key|secret[-_\s]?key|ssh[-_\s]?key|signing[-_\s]?key|passphrase|jwt|bearer|credentials?)\b["']?\s*(?:headers?(?:[ \t]+value)?\s*)?[:=]\s*)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|(?:(?:Bearer|Basic)\s+)?[^"',\s}&]+)/gi
// Native records can encode JSON repeatedly; embedded quotes have a different escape depth.
const ESCAPED_CREDENTIAL_PREFIX_PATTERN = /((?<![a-z0-9_-])[a-z0-9_-]*(?:authorization|x[-_\s]?api[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret|set[-_\s]?cookie|cookie|token|client[-_\s]?secret|private[-_\s]?key|access[-_\s]?key|secret[-_\s]?key|ssh[-_\s]?key|signing[-_\s]?key|passphrase|jwt|bearer|credentials?)\b(?:\\+["']|["'])?(?:\s|\\+[nrt])*[:=](?:\s|\\+[nrt])*(\\+)(["']))/gi
const AUTHORIZATION_VALUE_PATTERN = /((?<![a-z0-9_-])[a-z0-9_-]*authorization\b["']?\s*(?:headers?(?:[ \t]+value)?\s*)?[:=]\s*)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|(?:[A-Za-z][\w.-]*\s+)?[^"',\s}&]+)/gi
const COOKIE_VALUE_PATTERN = /((?<![a-z0-9_-])[a-z0-9_-]*(?:set[-_\s]?cookie|cookie)\b["']?\s*(?:headers?(?:[ \t]+value)?\s*)?[:=]\s*)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|[^\n]+)/gi
const CREDENTIAL_WORD_PATTERN = /(\b(?:x[-_\s]?api[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret|passphrase|jwt|credentials?)\b[ \t]+(?:(?:headers?(?:[ \t]+value)?|provided|code)(?:[ \t]*[:=]\s*|[ \t]+(?:(?:is|was|has)[ \t]+(?:not[ \t]+)?)?)|(?:is|was|has)[ \t]+(?:not[ \t]+)?)?)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|(?:(?:Bearer|Basic)\s+)?[^"',\s}&]+)/gi
const AUTHORIZATION_WORD_PATTERN = /(\bauthorization\b[ \t]+(?:(?:headers?(?:[ \t]+value)?|provided|code)(?:[ \t]*[:=]\s*|[ \t]+(?:(?:is|was|has)[ \t]+(?:not[ \t]+)?)?)|(?:is|was|has)[ \t]+(?:not[ \t]+)?)?)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|(?:(?:Bearer|Basic)\s+|[A-Za-z][\w.-]*[ \t]+)?[^"',\s}&]+)/gi
const COOKIE_WORD_PATTERN = /(\b(?:set[-_\s]?cookie|cookie)\b[ \t]+(?:(?:headers?(?:[ \t]+value)?|provided)(?:[ \t]*[:=]\s*|[ \t]+(?:(?:is|was|has)[ \t]+(?:not[ \t]+)?)?)|(?:is|was|has)[ \t]+(?:not[ \t]+)?)?)("(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)|[^\n]+)/gi
const AUTHORIZATION_TOKEN_PATTERN = /\b((?:Bearer|Basic)\s+)([A-Za-z0-9._~+/-]+=*)/gi
const CREDENTIAL_PROSE_PATTERN = /^(?:headers?|banner|required|missing|invalid|expired|denied|rejected|failed|unavailable|available|not|is|are|was|has|been|stale|rotated|valid|limit)\b/i
const PREFIXED_CREDENTIAL_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[abprs]-[A-Za-z0-9-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b/g
const CREDENTIAL_HINT_PATTERN = /authorization|api[-_\s]?key|token|password|secret|cookie|private[-_\s]?key|access[-_\s]?key|credentials?|ssh[-_\s]?key|signing[-_\s]?key|passphrase|jwt|bearer|basic/i

function isDiagnosticMetadata(key: string, value: unknown): boolean {
  const normalized = key.replace(/[-_\s]/g, '').toLowerCase()
  return /^(?:(?:next|previous|prev|continuation)?pagetoken|(?:start|child|leader)token)$/.test(normalized)
    || (/^(?:input|output|reasoning|cacheread|cachewrite)token$/.test(normalized)
      && typeof value === 'number' && Number.isFinite(value))
    || (/^(?:has|is)(?:credentials?|password|secret|token|cookie|authorization)$/.test(normalized)
      && (typeof value === 'boolean' || value === 'true' || value === 'false'))
}

function redactCredentialValue(match: string, prefix: string, value: string): string {
  const metadataValue = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) ? Number(value) : value
  if (isDiagnosticMetadata(prefix.match(/[a-z0-9_-]+/i)?.[0] ?? '', metadataValue)) return match
  const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : ''
  const closingQuote = quote && value.length > 1 && value.endsWith(quote) ? quote : ''
  return `${prefix}${quote}${REDACTED}${closingQuote}`
}

function findQuotedValueEnd(value: string, start: number, escapes: number, quote: string): { end: number; closing: string } {
  let end = start
  while (end < value.length && value[end] !== '\n' && value[end] !== '\r') {
    const runStart = end
    while (value[end] === '\\') end += 1
    // Re-encoded literal backslashes add pairs at the quote's encoding depth.
    if (value[end] === quote && (end - runStart - escapes) % (2 * (escapes + 1)) === 0) {
      return { end: end + 1, closing: value.slice(end - escapes, end + 1) }
    }
    if (end === runStart) end += 1
  }
  return { end, closing: '' }
}

function findCookieValueEnd(value: string): number {
  const pair = /^[!#$%&'*+\-.^_`|~a-z0-9]+=[ \t]*/i.exec(value)
  let end = pair?.[0].length ?? 0
  let header = false
  while (end < value.length && value[end] !== '\n' && value[end] !== '\r') {
    if (value[end] === ' ' || value[end] === '\t') {
      let next = end
      while (value[next] === ' ' || value[next] === '\t') next += 1
      if (!header && !(value[next] === ';' || (pair && value[next] === ','))) return end
      end = next
      continue
    }
    if (value[end] === ';' || value[end] === ',') {
      if (value[end] === ',' && !pair) return end
      // Semicolon-separated cookie names and attributes may also look like log fields.
      header = true
      end += 1
      continue
    }
    const runStart = end
    while (value[end] === '\\') end += 1
    const quote = value[end]
    if (quote === '"' || (quote === "'" && runStart === 0)) {
      let previous = runStart - 1
      while (value[previous] === ' ' || value[previous] === '\t') previous -= 1
      if (runStart !== 0 && value[previous] !== '=') return runStart
      const quoted = findQuotedValueEnd(value, end + 1, end - runStart, quote)
      if (runStart === 0 || !quoted.closing) return quoted.end
      end = quoted.end
      continue
    }
    if (end === runStart) end += 1
  }
  return end
}

function redactCookies(value: string, pattern: RegExp, wordForm = false): string {
  const parts: string[] = []
  let consumed = 0
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value))) {
    const prefix = match[1] ?? ''
    const cookie = (match[2] ?? '').slice(0, findCookieValueEnd(match[2] ?? ''))
    const end = match.index + prefix.length + cookie.length
    pattern.lastIndex = end
    if (wordForm && !/[:=]\s*$/.test(prefix) && CREDENTIAL_PROSE_PATTERN.test(cookie)) continue
    const encodedQuote = /^(\\+)(["'])/.exec(cookie)
    const encodedClosing = encodedQuote
      ? findQuotedValueEnd(cookie, encodedQuote[0].length, (encodedQuote[1] ?? '').length, encodedQuote[2] ?? '"').closing
      : ''
    const replacement = encodedQuote
      ? `${prefix}${encodedQuote[0]}${REDACTED}${encodedClosing}`
      : redactCredentialValue(`${prefix}${cookie}`, prefix, cookie)
    if (replacement === `${prefix}${cookie}`) continue
    parts.push(value.slice(consumed, match.index), replacement)
    consumed = end
  }
  return parts.length ? `${parts.join('')}${value.slice(consumed)}` : value
}

function redactEscapedCredentials(value: string): string {
  if (!value.includes('\\"') && !value.includes("\\'")) return value
  const parts: string[] = []
  let consumed = 0
  ESCAPED_CREDENTIAL_PREFIX_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ESCAPED_CREDENTIAL_PREFIX_PATTERN.exec(value))) {
    const prefix = match[1] ?? ''
    const escapes = (match[2] ?? '').length
    const quote = match[3]
    const start = ESCAPED_CREDENTIAL_PREFIX_PATTERN.lastIndex
    const { end, closing } = findQuotedValueEnd(value, start, escapes, quote ?? '"')
    if (isDiagnosticMetadata(prefix.match(/[a-z0-9_-]+/i)?.[0] ?? '', value.slice(start, end))) continue
    parts.push(value.slice(consumed, match.index), prefix, REDACTED, closing)
    consumed = end
    ESCAPED_CREDENTIAL_PREFIX_PATTERN.lastIndex = end
  }
  return parts.length ? `${parts.join('')}${value.slice(consumed)}` : value
}

function redactCredentialWord(match: string, prefix: string, value: string): string {
  if (!/[:=]\s*$/.test(prefix) && CREDENTIAL_PROSE_PATTERN.test(value)) return match
  return redactCredentialValue(match, prefix, value)
}

function sanitizeDiagnosticUrl(value: string, offset: number, input: string): string {
  let escapeStart = value.length
  while (value[escapeStart - 1] === '\\') escapeStart -= 1
  const trailingEscapes = value.slice(escapeStart)
  const quote = input[offset + value.length]
  let delimiter = ''
  if (trailingEscapes && (quote === '"' || quote === "'")) {
    delimiter = trailingEscapes
    if (input[offset - 1] === quote) {
      let depth = 0
      while (input[offset - depth - 2] === '\\') depth += 1
      if ((trailingEscapes.length - depth) % (2 * (depth + 1)) === 0) delimiter = '\\'.repeat(depth)
    }
  }
  const url = delimiter ? value.slice(0, -delimiter.length) : value
  try {
    const parsed = new URL(url)
    const withoutParameters = url.split(/[?#]/, 1)[0] ?? ''
    return `${parsed.username || parsed.password ? withoutParameters.replace(URL_USERINFO_PATTERN, '$1') : withoutParameters}${delimiter}`
  } catch {
    // Malformed userinfo can contain raw query/hash markers before the @.
    return `${url.replace(URL_USERINFO_PATTERN, '$1').split(/[?#]/, 1)[0] ?? ''}${delimiter}`
  }
}

/** Clean and redact complete diagnostic text before any preview is shortened. */
export function sanitizeDiagnosticText(value: string): string {
  const cleaned = stripTerminalFormatting(value)
    .replace(DIAGNOSTIC_URL_PATTERN, sanitizeDiagnosticUrl)
    .replace(PREFIXED_CREDENTIAL_PATTERN, REDACTED)
  if (!CREDENTIAL_HINT_PATTERN.test(cleaned)) return cleaned
  const cookieAssignments = redactCookies(redactEscapedCredentials(cleaned)
    .replace(AUTHORIZATION_VALUE_PATTERN, redactCredentialValue), COOKIE_VALUE_PATTERN)
  return redactCookies(cookieAssignments, COOKIE_WORD_PATTERN, true)
    .replace(CREDENTIAL_VALUE_PATTERN, redactCredentialValue)
    .replace(AUTHORIZATION_WORD_PATTERN, redactCredentialWord)
    .replace(CREDENTIAL_WORD_PATTERN, redactCredentialWord)
    .replace(AUTHORIZATION_TOKEN_PATTERN, `$1${REDACTED}`)
}

/** Preserve structured evidence while redacting credentials before it leaves the server. */
export function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeDiagnosticText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 100) return '[details omitted: nesting limit]'
  if (Array.isArray(value)) return value.map(item => sanitizeDiagnosticValue(item, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const cleanKey = stripTerminalFormatting(key)
    const sensitive = !isDiagnosticMetadata(cleanKey, item)
      && /(?:authorization|api[-_\s]?key|password|secret|cookie|token|private[-_\s]?key|access[-_\s]?key|secret[-_\s]?key|ssh[-_\s]?key|signing[-_\s]?key|passphrase|jwt|bearer|credentials?)$|^(?:auth|access|refresh)$/i.test(cleanKey)
    return [cleanKey, sensitive ? REDACTED : sanitizeDiagnosticValue(item, depth + 1)]
  }))
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
  const errorName = cleanString(value.errorName, 240)
  const stackTrace = cleanString(value.stackTrace, 12000)
  const failedChecks = Array.isArray(value.failedChecks)
    ? value.failedChecks.flatMap((check) => {
      if (!isRecord(check)) return []
      const name = cleanString(check.name, 240)
      const category = cleanString(check.category, 240)
      const message = cleanString(check.message)
      if (!name || !category || !message) return []
      const details = cleanString(check.details, 12000)
      return [{ name, category, message, ...(details ? { details } : {}) }]
    })
    : []
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
    ...(errorName ? { errorName } : {}),
    ...(stackTrace ? { stackTrace } : {}),
    ...(failedChecks.length > 0 ? { failedChecks } : {}),
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
