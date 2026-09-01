import {
  OPENCODE_OUTPUT_TRUNCATED,
  OPENCODE_PROVIDER_AUTH_FAILED,
  OPENCODE_PROVIDER_ERROR,
} from '@shared/errorCodes'
import {
  normalizeBlockedErrorDiagnostics,
  type BlockedErrorDiagnostics,
  type BlockedErrorDiagnosticKind,
} from '@shared/errorDiagnostics'
import type { OpenCodeResponseMeta } from './assistantMessageAnalysis'
import type { StepFinishMessagePart } from './types'
import type { ModelErrorInfo } from './errorDetails'
import { extractModelErrorInfo, summarizeModelErrorForLog } from './errorDetails'
import { isRecord } from '@shared/typeGuards'

export interface OpenCodeAttemptDiagnosticMeta {
  errorSource?: 'session_error' | 'assistant_error'
  error?: string
  errorDetails?: unknown
  sessionErrored?: boolean
  latestAssistantErrored?: boolean
}

export interface BuildOpenCodeBlockedErrorDiagnosticsInput {
  error?: unknown
  responseMeta?: OpenCodeResponseMeta
  attemptMeta?: OpenCodeAttemptDiagnosticMeta
  modelId?: string
  sessionId?: string
  fallbackMessage?: string
}

export interface OpenCodeBlockedErrorDiagnosticsResult {
  diagnostics: BlockedErrorDiagnostics | null
  errorCodes: string[]
}

type BlockedErrorDiagnosticsCarrier = Error & {
  blockedErrorDiagnostics?: BlockedErrorDiagnostics | null
  blockedErrorCodes?: string[]
}

function readErrorProperty(error: unknown, key: string): unknown {
  return isRecord(error) ? error[key] : undefined
}

function normalizeErrorCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .filter((code): code is string => typeof code === 'string')
      .map((code) => code.trim())
      .filter(Boolean),
  ))
}

function hasProviderSignal(info: ModelErrorInfo | undefined): boolean {
  return Boolean(
    info?.statusCode !== undefined
    || info?.requestModel
    || info?.responseErrorType
    || info?.responseErrorTitle
    || info?.responseErrorMessage
    || info?.responseBodyPreview,
  )
}

function normalizeMessage(value: string | undefined): string {
  return value?.trim() ?? ''
}

function cleanOptionalMessage(value: string | undefined): string | undefined {
  const normalized = normalizeMessage(value)
  return normalized.length > 0 ? normalized : undefined
}

function isAuthLikeFailure(info: ModelErrorInfo | undefined, message: string): boolean {
  const haystack = [
    message,
    info?.message,
    info?.responseErrorType,
    info?.responseErrorTitle,
    info?.responseErrorMessage,
    info?.responseBodyPreview,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()

  return info?.statusCode === 401
    || info?.statusCode === 403
    || /\b(auth|authentication|authenticated|unauthorized|forbidden|credential|api key|token|signing in|sign in)\b/.test(haystack)
}

function isProviderLikeFailure(info: ModelErrorInfo | undefined, message: string): boolean {
  const haystack = [
    message,
    info?.message,
    info?.responseErrorType,
    info?.responseErrorTitle,
    info?.responseErrorMessage,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()

  return hasProviderSignal(info)
    || isAuthLikeFailure(info, message)
    || /\b(rate[_ -]?(?:limit|limited)|too many requests|usage limit|limit (?:has been )?reached|resource exhausted|overloaded|overload|capacity|service unavailable|temporarily unavailable|quota|credits?|modelerror|model error|invalid_request_error|provider)\b/.test(haystack)
}

function parseHttpStatus(message: string): number | undefined {
  const match = message.match(/\bHTTP\s+([1-5]\d{2})\b/i)
  if (!match) return undefined
  const status = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(status) ? status : undefined
}

function isOutputTruncatedFinishReason(reason: string | undefined): boolean {
  if (!reason) return false
  return /^(length|max[_ -]?tokens?|output[_ -]?limit|token[_ -]?limit)$/i.test(reason.trim())
}

function formatTokenSummary(tokens: StepFinishMessagePart['tokens'] | undefined): string {
  const parts = [
    typeof tokens?.output === 'number' ? `output=${tokens.output}` : '',
    typeof tokens?.reasoning === 'number' ? `reasoning=${tokens.reasoning}` : '',
    typeof tokens?.input === 'number' ? `input=${tokens.input}` : '',
  ].filter(Boolean)
  return parts.length > 0 ? ` Token usage reported by OpenCode: ${parts.join(', ')}.` : ''
}

function buildOutputTruncatedSummary(reason: string, tokens: StepFinishMessagePart['tokens'] | undefined): string {
  return [
    `The model stopped because OpenCode reported finish reason "${reason}", which usually means the response reached the model or provider output length limit.`,
    'The structured artifact may be incomplete or cut off; later parser errors such as missing sections are probably secondary validation symptoms.',
    formatTokenSummary(tokens),
  ].join(' ').replace(/\s+/g, ' ').trim()
}

export function buildOutputTruncatedBlockedErrorDiagnostics(input: {
  modelId?: string
  sessionId?: string
  finishReason?: string
  tokens?: StepFinishMessagePart['tokens']
}): OpenCodeBlockedErrorDiagnosticsResult {
  const finishReason = input.finishReason?.trim() || 'length'
  const tokens = input.tokens
  const diagnostics = normalizeBlockedErrorDiagnostics({
    kind: 'model_output_truncated',
    source: 'opencode',
    summary: buildOutputTruncatedSummary(finishReason, tokens),
    modelId: input.modelId,
    sessionId: input.sessionId,
    finishReason,
    isRetryable: false,
    inputTokens: tokens?.input,
    outputTokens: tokens?.output,
    reasoningTokens: tokens?.reasoning,
    cacheReadTokens: tokens?.cache?.read,
    cacheWriteTokens: tokens?.cache?.write,
  })

  return {
    diagnostics,
    errorCodes: diagnostics ? [OPENCODE_OUTPUT_TRUNCATED] : [],
  }
}

function isTimeoutLike(message: string): boolean {
  return /\b(timeout|timed out|deadline|aborterror)\b/i.test(message)
}

function isTransportLike(message: string): boolean {
  return /\b(connection reset|socket reset|econnreset|etimedout|eai_again|enotfound|econnrefused|socket hang up|network|fetch failed|failed to prompt|unreachable)\b/i.test(message)
}

function resolveKind(input: {
  info?: ModelErrorInfo
  summaryMessage: string
  responseMeta?: OpenCodeResponseMeta
  attemptMeta?: OpenCodeAttemptDiagnosticMeta
}): BlockedErrorDiagnosticKind {
  if (isTimeoutLike(input.summaryMessage)) return 'timeout'
  if (isProviderLikeFailure(input.info, input.summaryMessage)) return 'opencode_provider'
  if (input.responseMeta?.sessionErrored || input.attemptMeta?.errorSource === 'session_error') return 'opencode_session'
  if (isTransportLike(input.summaryMessage)) return 'transport'
  return 'runtime'
}

function resolveErrorCodes(info: ModelErrorInfo | undefined, summaryMessage: string): string[] {
  if (isAuthLikeFailure(info, summaryMessage)) return [OPENCODE_PROVIDER_AUTH_FAILED]
  if (isProviderLikeFailure(info, summaryMessage)) return [OPENCODE_PROVIDER_ERROR]
  return []
}

function resolveDetails(input: BuildOpenCodeBlockedErrorDiagnosticsInput): unknown {
  return input.responseMeta?.sessionErrorDetails
    ?? input.responseMeta?.latestAssistantErrorInfo
    ?? input.attemptMeta?.errorDetails
    ?? readErrorProperty(input.error, 'modelErrorDetails')
    ?? readErrorProperty(input.error, 'details')
    ?? input.error
}

function resolveFallbackMessage(input: BuildOpenCodeBlockedErrorDiagnosticsInput): string | undefined {
  return input.responseMeta?.sessionError
    ?? input.responseMeta?.latestAssistantError
    ?? input.attemptMeta?.error
    ?? cleanOptionalMessage(input.fallbackMessage)
    ?? (input.error instanceof Error ? input.error.message : undefined)
}

export function buildOpenCodeBlockedErrorDiagnostics(
  input: BuildOpenCodeBlockedErrorDiagnosticsInput,
): OpenCodeBlockedErrorDiagnosticsResult {
  const attachedDiagnostics = normalizeBlockedErrorDiagnostics(readErrorProperty(input.error, 'blockedErrorDiagnostics'))
  if (attachedDiagnostics) {
    return {
      diagnostics: attachedDiagnostics,
      errorCodes: normalizeErrorCodes(readErrorProperty(input.error, 'blockedErrorCodes')),
    }
  }

  const hasDiagnosticSignal = Boolean(
    input.error !== undefined
    || cleanOptionalMessage(input.fallbackMessage)
    || isOutputTruncatedFinishReason(input.responseMeta?.latestStepFinishReason)
    || input.responseMeta?.sessionErrored
    || input.responseMeta?.latestAssistantHasError
    || input.attemptMeta?.error
    || input.attemptMeta?.errorDetails !== undefined,
  )
  if (!hasDiagnosticSignal) {
    return { diagnostics: null, errorCodes: [] }
  }

  if (
    isOutputTruncatedFinishReason(input.responseMeta?.latestStepFinishReason)
    && !input.responseMeta?.sessionErrored
    && !input.responseMeta?.latestAssistantHasError
    && !input.attemptMeta?.error
    && input.error === undefined
    && !cleanOptionalMessage(input.fallbackMessage)
  ) {
    return buildOutputTruncatedBlockedErrorDiagnostics({
      modelId: input.modelId,
      sessionId: input.sessionId,
      finishReason: input.responseMeta?.latestStepFinishReason,
      tokens: input.responseMeta?.latestStepFinishTokens,
    })
  }

  const details = resolveDetails(input)
  const fallbackMessage = resolveFallbackMessage(input)
  const summary = summarizeModelErrorForLog(details, fallbackMessage)
  const summaryMessage = normalizeMessage(summary.message)
  if (!summaryMessage) {
    return { diagnostics: null, errorCodes: [] }
  }

  const info = summary.details ?? extractModelErrorInfo(details)
  const statusCode = info?.statusCode ?? parseHttpStatus(summaryMessage)
  const infoWithStatus = statusCode === info?.statusCode
    ? info
    : { ...(info ?? {}), ...(statusCode !== undefined ? { statusCode } : {}) }
  const kind = resolveKind({
    info: infoWithStatus,
    summaryMessage,
    responseMeta: input.responseMeta,
    attemptMeta: input.attemptMeta,
  })
  const diagnostics = normalizeBlockedErrorDiagnostics({
    kind,
    source: kind === 'opencode_provider' ? 'provider' : 'opencode',
    summary: summaryMessage,
    modelId: input.modelId,
    sessionId: input.sessionId,
    providerId: info?.providerId,
    providerModelId: info?.providerModelId,
    statusCode,
    requestModel: info?.requestModel,
    isRetryable: info?.isRetryable,
    providerErrorType: info?.responseErrorType,
    providerErrorTitle: info?.responseErrorTitle,
    providerErrorMessage: info?.responseErrorMessage,
    responseBodyPreview: info?.responseBodyPreview,
  })

  return {
    diagnostics,
    errorCodes: resolveErrorCodes(info, summaryMessage),
  }
}

export function appendBlockedErrorDiagnosticsSummary(
  message: string,
  diagnostics: BlockedErrorDiagnostics | null | undefined,
): string {
  const summary = diagnostics?.summary?.trim()
  if (!summary || message.includes(summary)) return message
  return `${message} Underlying OpenCode error: ${summary}`
}

export function attachOpenCodeBlockedErrorDiagnostics<T extends Error>(
  error: T,
  diagnosticResult: OpenCodeBlockedErrorDiagnosticsResult | null | undefined,
): T {
  if (!diagnosticResult?.diagnostics) return error
  const enriched = error as T & BlockedErrorDiagnosticsCarrier
  enriched.blockedErrorDiagnostics = diagnosticResult.diagnostics
  enriched.blockedErrorCodes = normalizeErrorCodes(diagnosticResult.errorCodes)
  return enriched
}

export function mergeErrorCodes(primary: string[], secondary: string[]): string[] {
  return Array.from(new Set([...primary, ...secondary].filter((code) => code.trim().length > 0)))
}
