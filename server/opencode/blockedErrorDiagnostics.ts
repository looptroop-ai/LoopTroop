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
import { parseModelRef, type StepFinishMessagePart } from './types'
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
  errorSource?: 'opencode_server'
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

function getErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  while (error !== undefined && !seen.has(error) && chain.length < 8) {
    chain.push(error)
    seen.add(error)
    error = readErrorProperty(error, 'cause')
  }
  return chain
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
  if (isNonProviderStructuredError(info)) return false
  return Boolean(
    info?.statusCode !== undefined
    || info?.requestModel
    || info?.responseErrorType
    || info?.responseErrorTitle
    || info?.responseErrorMessage
    || info?.responseBodyPreview,
  )
}

function isNonProviderStructuredError(info: ModelErrorInfo | undefined): boolean {
  return /^(?:tool\.|permission\.|unknown$)/.test(info?.name ?? '')
}

function normalizeMessage(value: string | undefined): string {
  return value?.trim() ?? ''
}

function cleanOptionalMessage(value: string | undefined): string | undefined {
  const normalized = normalizeMessage(value)
  return normalized.length > 0 ? normalized : undefined
}

function isAuthLikeFailure(info: ModelErrorInfo | undefined, message: string): boolean {
  if (isNonProviderStructuredError(info)) return false
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
    .replace(/_/g, ' ')

  if (/\b(?:credits?error|billing[ .-]?error|payment[ .-]?required|(?:no|missing)[ .-]payment[ .-]method|(?:no|insufficient|exhausted)[ .-]credits?|credits?[ .-](?:exhausted|required|insufficient|unavailable))\b/.test(haystack)) return false

  return info?.statusCode === 401
    || /\b(auth|authentication|authenticated|unauthenticated|authorization|unauthorized|credentials?|api[ -]?key|signing in|sign in)\b/.test(haystack)
    || /\btoken\s+(?:(?:has|have)\s+(?:been\s+)?|(?:is|was)\s+)?(?:expired|invalidated|revoked|invalid)\b|\b(?:expired|invalidated|revoked|invalid)\s+token\b(?!\s+(?:count|limit|capacity|usage|length|budget)\b)/.test(haystack)
}

function isProviderLikeFailure(info: ModelErrorInfo | undefined, message: string): boolean {
  if (isNonProviderStructuredError(info)) return false
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
    || /\b(rate[_ -]?(?:limit|limited)|too many requests|usage limit|limit (?:has been )?reached|resource exhausted|overloaded|overload|capacity|service unavailable|temporarily unavailable|quota|credits?|modelerror|model error|invalid_request_error|provider|forbidden)\b/.test(haystack)
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
  const model = parseModelRef(input.modelId)
  const diagnostics = normalizeBlockedErrorDiagnostics({
    kind: 'model_output_truncated',
    source: 'opencode',
    summary: buildOutputTruncatedSummary(finishReason, tokens),
    modelId: input.modelId,
    providerId: model?.providerID,
    providerModelId: model?.modelID,
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
  return /\b(connection (?:error|reset)|socket reset|econnreset|etimedout|eai_again|enotfound|econnrefused|socket hang up|network|fetch failed|failed to (?:prompt|fetch|connect)|could not (?:reach|connect)|unreachable)\b/i.test(message)
}

function buildCommunicationSummary(summaryMessage: string, operation: string | undefined, info: ModelErrorInfo | undefined): string {
  const context = operation ? ` while ${operation}` : ''
  const hasCause = info?.transportCode || (info?.causeMessage && !/^fetch failed$/i.test(info.causeMessage))
  const punctuation = /[.!?]$/.test(summaryMessage) ? '' : '.'
  return `LoopTroop could not communicate with OpenCode${context}. Reported error: ${summaryMessage}${punctuation} ${hasCause ? 'Captured connection details are available in Technical details.' : 'The exact connection cause was not reported.'}`
}

function resolveKind(input: {
  info?: ModelErrorInfo
  summaryMessage: string
  responseMeta?: OpenCodeResponseMeta
  attemptMeta?: OpenCodeAttemptDiagnosticMeta
  serverError: boolean
}): BlockedErrorDiagnosticKind {
  if (input.serverError && input.info?.statusCode !== undefined) return 'opencode_session'
  if (isTimeoutLike(input.summaryMessage)) return 'timeout'
  if (input.serverError) return isTransportLike(input.summaryMessage) ? 'transport' : 'opencode_session'
  if (isNonProviderStructuredError(input.info)) return 'runtime'
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

function resolveDetails(input: BuildOpenCodeBlockedErrorDiagnosticsInput, errorChain: unknown[]): unknown {
  const preferred = input.responseMeta?.sessionErrorDetails
    ?? input.responseMeta?.latestAssistantErrorInfo
    ?? input.attemptMeta?.errorDetails
  const explicitDetails = errorChain.map((error) => readErrorProperty(error, 'modelErrorDetails') ?? readErrorProperty(error, 'details'))
    .filter((details) => details !== undefined && details !== null)
  const candidates = [preferred, ...errorChain.toReversed().flatMap((error) => [
    readErrorProperty(error, 'modelErrorDetails') ?? readErrorProperty(error, 'details'), error,
  ])]
  return candidates.find((details) => hasProviderSignal(extractModelErrorInfo(details)))
    ?? preferred
    ?? explicitDetails[0]
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
  const errorChain = getErrorChain(input.error)
  const attachedDiagnostics = errorChain.map((error) => normalizeBlockedErrorDiagnostics(readErrorProperty(error, 'blockedErrorDiagnostics')))
    .find((diagnostics) => diagnostics !== null)
  const carriedErrorCodes = normalizeErrorCodes(errorChain.flatMap((error) => normalizeErrorCodes(readErrorProperty(error, 'blockedErrorCodes'))))
  const serverError = input.errorSource === 'opencode_server'
    || errorChain.some((error) => readErrorProperty(error, 'openCodeErrorSource') === 'opencode_server'
      || readErrorProperty(error, 'name') === 'OpenCodeConnectionError')
  const promptHttpError = errorChain.some((error) => readErrorProperty(error, 'openCodeErrorSource') === 'opencode_prompt'
    || readErrorProperty(error, 'name') === 'V2OpenCodeHttpError')
  const withoutProviderCodes = (codes: string[]) => codes.filter((code) => code !== OPENCODE_PROVIDER_AUTH_FAILED && code !== OPENCODE_PROVIDER_ERROR)
  const actualErrors = errorChain.filter((error): error is Error => error instanceof Error)
  const errorName = actualErrors[0]?.name
  const stackTrace = actualErrors.map((error, index) => error.stack ? `${index > 0 ? 'Caused by: ' : ''}${error.stack}` : '')
    .filter(Boolean).join('\n')
  const operation = errorChain.map((error) => readErrorProperty(error, 'openCodeOperation'))
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
  const model = parseModelRef(attachedDiagnostics?.modelId ?? input.modelId)
  if (attachedDiagnostics) {
    const kind = serverError && attachedDiagnostics.kind === 'opencode_provider' ? 'opencode_session' : attachedDiagnostics.kind
    const serverDiagnostic = serverError || kind === 'opencode_session'
    const inferredModel = kind === 'opencode_provider' || kind === 'model_output_truncated' ? model : undefined
    return {
      diagnostics: normalizeBlockedErrorDiagnostics({
        ...attachedDiagnostics,
        kind,
        source: serverError ? 'opencode' : attachedDiagnostics.source,
        errorName: attachedDiagnostics.errorName ?? errorName,
        stackTrace: attachedDiagnostics.stackTrace ?? stackTrace,
        operation: attachedDiagnostics.operation ?? operation,
        modelId: attachedDiagnostics.modelId ?? input.modelId,
        providerId: serverDiagnostic ? undefined : attachedDiagnostics.providerId ?? inferredModel?.providerID,
        providerModelId: serverDiagnostic ? undefined : attachedDiagnostics.providerModelId
          ?? (!attachedDiagnostics.providerId || attachedDiagnostics.providerId === inferredModel?.providerID ? inferredModel?.modelID : undefined),
        sessionId: attachedDiagnostics.sessionId ?? input.sessionId,
        finishReason: attachedDiagnostics.finishReason ?? input.responseMeta?.latestStepFinishReason,
        inputTokens: attachedDiagnostics.inputTokens ?? input.responseMeta?.latestStepFinishTokens?.input,
        outputTokens: attachedDiagnostics.outputTokens ?? input.responseMeta?.latestStepFinishTokens?.output,
        reasoningTokens: attachedDiagnostics.reasoningTokens ?? input.responseMeta?.latestStepFinishTokens?.reasoning,
        cacheReadTokens: attachedDiagnostics.cacheReadTokens ?? input.responseMeta?.latestStepFinishTokens?.cache?.read,
        cacheWriteTokens: attachedDiagnostics.cacheWriteTokens ?? input.responseMeta?.latestStepFinishTokens?.cache?.write,
      }),
      errorCodes: serverDiagnostic ? withoutProviderCodes(carriedErrorCodes) : carriedErrorCodes,
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

  const details = resolveDetails(input, errorChain)
  const fallbackMessage = resolveFallbackMessage(input)
  const summary = summarizeModelErrorForLog(details, fallbackMessage)
  const summaryMessage = normalizeMessage(summary.message)
  if (!summaryMessage) {
    return { diagnostics: null, errorCodes: [] }
  }

  const info = summary.details ?? extractModelErrorInfo(details)
  const errorCauseInfo = details === input.error ? info : extractModelErrorInfo(input.error)
  const causeDetails = {
    transportCode: info?.transportCode ?? errorCauseInfo?.transportCode,
    causeMessage: info?.causeMessage ?? errorCauseInfo?.causeMessage,
  }
  const statusCode = info?.statusCode ?? parseHttpStatus(summaryMessage)
  const infoWithStatus = statusCode === info?.statusCode
    ? info
    : { ...(info ?? {}), ...(statusCode !== undefined ? { statusCode } : {}) }
  const providerResponseType = info?.responseErrorType
    && !/^(?:error|(?:unauthorized|forbidden)(?:error)?)$/i.test(info.responseErrorType)
  const ambiguousPromptAccess = !serverError && promptHttpError
    && (statusCode === 401 || statusCode === 403)
    && !providerResponseType && !info?.providerId && !info?.requestModel
  const kind = ambiguousPromptAccess ? 'runtime' : resolveKind({
    info: infoWithStatus,
    summaryMessage,
    responseMeta: input.responseMeta,
    attemptMeta: input.attemptMeta,
    serverError,
  })
  const connectionFailure = kind === 'transport'
    && (causeDetails.transportCode !== undefined
      || /\b(connection (?:error|reset)|socket reset|econnreset|etimedout|eai_again|enotfound|econnrefused|socket hang up|network (?:error|failure|failed)|fetch failed|failed to (?:fetch|connect)|could not (?:reach|connect)|(?:network|opencode)(?: is)? unreachable)\b/i.test(summaryMessage))
  const diagnostics = normalizeBlockedErrorDiagnostics({
    kind,
    source: kind === 'opencode_provider' ? 'provider' : 'opencode',
    summary: connectionFailure ? buildCommunicationSummary(summaryMessage, operation, causeDetails) : summaryMessage,
    errorName: errorName ?? info?.name,
    stackTrace,
    operation,
    ...causeDetails,
    modelId: input.modelId,
    sessionId: input.sessionId,
    providerId: serverError || ambiguousPromptAccess ? undefined : info?.providerId ?? (kind === 'opencode_provider' ? model?.providerID : undefined),
    providerModelId: serverError || ambiguousPromptAccess ? undefined : info?.providerModelId
      ?? (kind === 'opencode_provider' && (!info?.providerId || info.providerId === model?.providerID) ? model?.modelID : undefined),
    statusCode,
    requestModel: info?.requestModel,
    isRetryable: info?.isRetryable,
    providerErrorType: info?.responseErrorType,
    providerErrorTitle: info?.responseErrorTitle,
    providerErrorMessage: info?.responseErrorMessage,
    responseBodyPreview: info?.responseBodyPreview,
    finishReason: input.responseMeta?.latestStepFinishReason,
    inputTokens: input.responseMeta?.latestStepFinishTokens?.input,
    outputTokens: input.responseMeta?.latestStepFinishTokens?.output,
    reasoningTokens: input.responseMeta?.latestStepFinishTokens?.reasoning,
    cacheReadTokens: input.responseMeta?.latestStepFinishTokens?.cache?.read,
    cacheWriteTokens: input.responseMeta?.latestStepFinishTokens?.cache?.write,
  })

  return {
    diagnostics,
    errorCodes: serverError || ambiguousPromptAccess ? withoutProviderCodes(carriedErrorCodes) : mergeErrorCodes(carriedErrorCodes, resolveErrorCodes(infoWithStatus, summaryMessage)),
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
  if (!diagnosticResult) return error
  const enriched = error as T & BlockedErrorDiagnosticsCarrier
  if (diagnosticResult.diagnostics) enriched.blockedErrorDiagnostics = diagnosticResult.diagnostics
  enriched.blockedErrorCodes = normalizeErrorCodes(diagnosticResult.errorCodes)
  return enriched
}

export function mergeErrorCodes(primary: string[], secondary: string[]): string[] {
  return Array.from(new Set([...primary, ...secondary].filter((code) => code.trim().length > 0)))
}
