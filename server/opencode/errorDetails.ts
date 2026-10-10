import { sanitizeDiagnosticText } from '../../shared/errorDiagnostics'

export interface ModelErrorInfo {
  name?: string
  message?: string
  transportCode?: string
  causeMessage?: string
  providerId?: string
  providerModelId?: string
  statusCode?: number
  url?: string
  isRetryable?: boolean
  requestModel?: string
  responseErrorType?: string
  responseErrorTitle?: string
  responseErrorMessage?: string
  responseBodyPreview?: string
}

export interface ModelErrorSummary {
  message: string
  details?: ModelErrorInfo
}

const MAX_ERROR_PREVIEW_LENGTH = 280
const URL_PATTERN = /\bhttps?:\/\/[^\s"',}]+/gi

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined
  if (value instanceof Error) {
    const record: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      record[key] = (value as Error & Record<string, unknown>)[key]
    }
    return record
  }
  if (typeof value === 'object') {
    return value as Record<string, unknown>
  }
  return undefined
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function sanitizeUrl(value: string | undefined): string | undefined {
  const cleaned = value ? trimQuotes(value).trim() : ''
  if (!cleaned) return undefined
  try {
    const url = new URL(cleaned)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return cleaned.split(/[?#]/, 1)[0]
  }
}

function redactUrlQuery(value: string): string {
  URL_PATTERN.lastIndex = 0
  return value.replace(URL_PATTERN, (url) => sanitizeUrl(url) ?? url)
}

function trimQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

function cleanMessage(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = redactUrlQuery(sanitizeDiagnosticText(trimQuotes(value))).trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function truncate(value: string | undefined, maxLength = MAX_ERROR_PREVIEW_LENGTH): string | undefined {
  const cleaned = cleanMessage(value)
  if (!cleaned) return undefined
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength - 3)}...`
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value)
    return toRecord(parsed)
  } catch {
    return undefined
  }
}

function unwrapErrorRecord(error: unknown): Record<string, unknown> | undefined {
  const outer = toRecord(error)
  if (!outer) return undefined

  const inner = toRecord(outer.error)
  if (!inner) return outer

  return {
    ...outer,
    ...inner,
  }
}

function findRetryErrorRecord(record: Record<string, unknown> | undefined, depth = 0): Record<string, unknown> | undefined {
  if (!record || !Array.isArray(record.errors) || depth >= 8) return undefined

  for (let index = record.errors.length - 1; index >= 0; index -= 1) {
    const candidate = unwrapErrorRecord(record.errors[index])
    if (!candidate) continue
    return findRetryErrorRecord(candidate, depth + 1) ?? candidate
  }

  return undefined
}

function extractCauseDetails(error: unknown): Pick<ModelErrorInfo, 'transportCode' | 'causeMessage'> {
  const root = toRecord(error)
  let transportCode = truncate(getString(root?.transportCode) ?? getString(root?.code), 80)
  let causeMessage = truncate(getString(root?.causeMessage))
  const pending: unknown[] = [root?.cause]
  if (root?.name === 'AggregateError' && Array.isArray(root.errors)) pending.push(...root.errors.slice(0, 8))
  const seen = new Set<unknown>([error])

  // Error causes can be circular or aggregate; inspect only a bounded chain.
  for (let index = 0; index < pending.length && index < 8; index += 1) {
    const cause = pending[index]
    if (cause === undefined || seen.has(cause)) continue
    seen.add(cause)
    const record = toRecord(cause)
    causeMessage = truncate(getString(record?.message) ?? (typeof cause === 'string' ? cause : undefined)) ?? causeMessage
    transportCode = truncate(getString(record?.code), 80) ?? transportCode
    if (record?.cause !== undefined) pending.push(record.cause)
    if (record?.name === 'AggregateError' && Array.isArray(record.errors)) pending.push(...record.errors.slice(0, 8))
  }

  return { transportCode, causeMessage }
}

export function extractModelErrorInfo(error: unknown): ModelErrorInfo | undefined {
  const baseRecord = unwrapErrorRecord(error)
  const record = findRetryErrorRecord(baseRecord) ?? baseRecord
  const fallbackMessage = typeof error === 'string'
    ? cleanMessage(error)
    : error instanceof Error
      ? cleanMessage(error.message)
      : undefined

  const data = toRecord(record?.data)
  const dataError = toRecord(data?.error)
  const dataDetail = toRecord(data?.detail)
  const responseBodySource = getString(record?.responseBody) ?? getString(data?.responseBody)
  const responseBody = truncate(responseBodySource)
  const responseBodyRecord = parseJsonRecord(responseBodySource)
  const responseBodyError = toRecord(responseBodyRecord?.error)
  const responseBodyErrorText = getString(responseBodyRecord?.error)
  const responseBodyDetail = toRecord(responseBodyRecord?.detail)

  const info: ModelErrorInfo = {
    name: cleanMessage(getString(record?.name)),
    ...extractCauseDetails(error),
    message: cleanMessage(
      getString(record?.message)
      ?? getString(data?.message)
      ?? getString(dataError?.message)
      ?? getString(responseBodyError?.message)
      ?? responseBodyErrorText
      ?? getString(responseBodyRecord?.message)
      ?? getString(dataDetail?.message)
      ?? getString(responseBodyDetail?.message)
      ?? fallbackMessage,
    ),
    providerId: cleanMessage(getString(record?.providerId)),
    providerModelId: cleanMessage(getString(record?.providerModelId)),
    statusCode: getNumber(record?.statusCode) ?? getNumber(data?.statusCode),
    url: sanitizeUrl(getString(record?.url)),
    isRetryable: getBoolean(record?.isRetryable) ?? getBoolean(data?.isRetryable),
    requestModel: cleanMessage(
      getString(record?.requestModel)
      ?? getString(toRecord(record?.requestBodyValues)?.model),
    ),
    responseErrorType: cleanMessage(
      getString(record?.responseErrorType)
      ?? getString(dataError?.type)
      ?? getString(responseBodyError?.type)
      ?? getString(responseBodyRecord?.error_type)
      ?? getString(responseBodyRecord?.type),
    ),
    responseErrorTitle: cleanMessage(
      getString(record?.responseErrorTitle)
      ?? getString(dataError?.title)
      ?? getString(responseBodyError?.title)
      ?? getString(responseBodyRecord?.title),
    ),
    responseErrorMessage: cleanMessage(
      getString(record?.responseErrorMessage)
      ?? getString(data?.message)
      ?? getString(dataError?.message)
      ?? getString(responseBodyError?.message)
      ?? responseBodyErrorText
      ?? getString(responseBodyRecord?.message)
      ?? getString(dataDetail?.message)
      ?? getString(responseBodyDetail?.message)
      ?? getString(dataDetail?.code)
      ?? getString(responseBodyDetail?.code)
      ?? getString(responseBodyRecord?.code)
    ),
    responseBodyPreview: truncate(getString(record?.responseBodyPreview)) ?? responseBody,
  }

  return Object.values(info).some((value) => value !== undefined) ? info : undefined
}

export function hasRichModelErrorInfo(info: ModelErrorInfo | undefined): boolean {
  if (!info) return false
  return [
    info.statusCode,
    info.url,
    info.providerId,
    info.providerModelId,
    info.requestModel,
    info.responseErrorType,
    info.responseErrorTitle,
    info.responseErrorMessage,
    info.responseBodyPreview,
  ].some((value) => value !== undefined)
}

export function summarizeModelErrorForLog(error: unknown, fallbackMessage?: string): ModelErrorSummary {
  const details = extractModelErrorInfo(error)
  const baseMessage = details?.responseErrorTitle && details.responseErrorMessage
    ? `${details.responseErrorTitle}: ${details.responseErrorMessage}`
    : details?.responseErrorType && details.responseErrorMessage
      ? `${details.responseErrorType}: ${details.responseErrorMessage}`
      : details?.responseErrorMessage
        ?? details?.message
        ?? cleanMessage(fallbackMessage)
        ?? 'Model error'

  const metaParts: string[] = []
  if (details?.statusCode !== undefined) {
    metaParts.push(`HTTP ${details.statusCode}`)
  }
  if (details?.requestModel) {
    metaParts.push(`requestModel=${details.requestModel}`)
  }

  return {
    message: metaParts.length > 0 ? `${baseMessage} (${metaParts.join(', ')})` : baseMessage,
    ...(details ? { details } : {}),
  }
}
