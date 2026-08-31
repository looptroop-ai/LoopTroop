import {
  isStructuredFailureClass,
  normalizeStructuredRetryDiagnostic,
  type StructuredFailureClass,
  type StructuredRetryDiagnostic,
  withStructuredRetryDiagnosticAttempt,
} from '@shared/structuredRetryDiagnostics'
import { isRecord, normalizeString } from '@shared/typeGuards'

const EXCERPT_CONTEXT_LINES = 2
const MAX_EXCERPT_LINES = 8
const MAX_EXCERPT_CHARS = 700

type StructuredRetryDiagnosticCarrier = Error & {
  retryDiagnostic?: StructuredRetryDiagnostic
  structuredFailureClass?: StructuredFailureClass
}

function truncateExcerpt(text: string): string {
  const normalized = text.replace(/^\n+|\n+$/g, '')
  if (!normalized.trim()) return '[empty response]'
  if (normalized.length <= MAX_EXCERPT_CHARS) return normalized
  return `${normalized.slice(0, MAX_EXCERPT_CHARS - 1).trimEnd()}…`
}

function formatExcerptWindow(lines: string[], start: number, end: number): string {
  const excerpt = lines
    .slice(start, end)
    .map((line, index) => `${String(start + index + 1).padStart(3, ' ')} | ${line}`)
    .join('\n')
  return truncateExcerpt(excerpt)
}

function extractMarkedYamlLocation(error: unknown): { line?: number; column?: number; snippet?: string } | null {
  if (!isRecord(error)) return null
  const mark = isRecord(error.mark) ? error.mark : null
  if (!mark) return null

  const line = typeof mark.line === 'number' && Number.isInteger(mark.line) && mark.line >= 0
    ? mark.line + 1
    : undefined
  const column = typeof mark.column === 'number' && Number.isInteger(mark.column) && mark.column >= 0
    ? mark.column + 1
    : undefined
  const snippet = normalizeString(mark.snippet)
  if (!line && !column && !snippet) return null
  return {
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
    ...(snippet ? { snippet } : {}),
  }
}

function extractLineColumnFromMessage(message: string): { line?: number; column?: number } {
  const normalized = message.trim()
  const explicitLineColumn = normalized.match(/\bline\s+(\d+)\b(?:[^\d]+column\s+(\d+)\b)?/i)
  if (explicitLineColumn?.[1]) {
    const line = Number(explicitLineColumn[1])
    const column = explicitLineColumn[2] ? Number(explicitLineColumn[2]) : undefined
    return {
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      ...(column && Number.isInteger(column) && column > 0 ? { column } : {}),
    }
  }

  const compactLocation = normalized.match(/\((\d+):(\d+)\)/)
  if (compactLocation?.[1] && compactLocation[2]) {
    const line = Number(compactLocation[1])
    const column = Number(compactLocation[2])
    return {
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      ...(Number.isInteger(column) && column > 0 ? { column } : {}),
    }
  }

  return {}
}

function inferStructuredRetryTarget(validationError: string): string | undefined {
  const normalized = validationError.trim()
  if (!normalized) return undefined

  const questionMatch = normalized.match(/\b(?:canonical\s+)?question\s+([A-Za-z]+\d+)\b/i)
  if (questionMatch?.[1]) return `Question ${questionMatch[1].toUpperCase()}`

  const questionIdMatch = normalized.match(/\b(QFF\d+|FU\d+|Q\d+)\b/i)
  if (questionIdMatch?.[1]) return `Question ${questionIdMatch[1].toUpperCase()}`

  const beadMatch = normalized.match(/\bbead\s+["']?([^"'\s:.,)]+)["']?/i)
  if (beadMatch?.[1]) return `Bead ${beadMatch[1]}`

  const draftMatch = normalized.match(/\bdraft\s+(\d+)\b/i)
  if (draftMatch?.[1]) return `Draft ${draftMatch[1]}`

  const pathMatch = normalized.match(/\b([A-Za-z_][\w-]*(?:\[\d+\])?(?:\.[A-Za-z_][\w-]*(?:\[\d+\])?)*)\b/)
  if (pathMatch?.[1] && /[._[]/.test(pathMatch[1])) return pathMatch[1]

  const indexMatch = normalized.match(/\bat index (\d+)\b/i)
  if (indexMatch?.[1]) return `index ${indexMatch[1]}`

  return undefined
}

function buildTargetSearchTerms(target: string): string[] {
  const terms = new Set<string>()
  const normalized = target.trim()
  if (!normalized) return []

  terms.add(normalized)
  const withoutLabel = normalized.replace(/^(Question|Bead|Draft)\s+/i, '').trim()
  if (withoutLabel) terms.add(withoutLabel)

  for (const segment of normalized.split(/[.[\]]+/)) {
    const trimmed = segment.trim()
    if (trimmed.length > 0) terms.add(trimmed)
  }

  return [...terms]
}

function buildExcerptFromLine(rawResponse: string, line: number): string | undefined {
  if (!rawResponse.trim()) return '[empty response]'
  const lines = rawResponse.split('\n')
  if (line <= 0 || line > lines.length) return undefined
  const start = Math.max(0, line - EXCERPT_CONTEXT_LINES - 1)
  const end = Math.min(lines.length, line + EXCERPT_CONTEXT_LINES)
  return formatExcerptWindow(lines, start, end)
}

function buildExcerptFromTarget(rawResponse: string, target: string): string | undefined {
  if (!rawResponse.trim()) return '[empty response]'
  const lines = rawResponse.split('\n')
  const terms = buildTargetSearchTerms(target)
  const lowerTerms = terms.map((term) => term.toLowerCase())
  const hitIndex = lines.findIndex((line) => lowerTerms.some((term) => line.toLowerCase().includes(term)))
  if (hitIndex < 0) return undefined
  const start = Math.max(0, hitIndex - EXCERPT_CONTEXT_LINES)
  const end = Math.min(lines.length, hitIndex + EXCERPT_CONTEXT_LINES + 1)
  return formatExcerptWindow(lines, start, end)
}

function buildFallbackExcerpt(rawResponse: string): string {
  const trimmed = rawResponse.trim()
  if (!trimmed) return '[empty response]'
  const lines = trimmed.split('\n')
  return formatExcerptWindow(lines, 0, Math.min(lines.length, MAX_EXCERPT_LINES))
}

export function buildStructuredRetryDiagnostic(params: {
  attempt?: number
  rawResponse: string
  validationError: string
  failureClass?: StructuredFailureClass
  error?: unknown
}): StructuredRetryDiagnostic {
  const attempt = params.attempt && Number.isInteger(params.attempt) && params.attempt > 0 ? params.attempt : 1
  const validationError = params.validationError.trim() || 'Unknown validation error'
  const yamlLocation = extractMarkedYamlLocation(params.error)
  const messageLocation = extractLineColumnFromMessage(validationError)
  const target = inferStructuredRetryTarget(validationError)
  const line = yamlLocation?.line ?? messageLocation.line
  const column = yamlLocation?.column ?? messageLocation.column
  const excerpt = yamlLocation?.snippet
    ? truncateExcerpt(yamlLocation.snippet)
    : line
      ? buildExcerptFromLine(params.rawResponse, line) ?? buildExcerptFromTarget(params.rawResponse, target ?? '') ?? buildFallbackExcerpt(params.rawResponse)
      : target
        ? buildExcerptFromTarget(params.rawResponse, target) ?? buildFallbackExcerpt(params.rawResponse)
        : buildFallbackExcerpt(params.rawResponse)

  return {
    attempt,
    validationError,
    excerpt,
    ...(params.failureClass ? { failureClass: params.failureClass } : {}),
    ...(target ? { target } : {}),
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
  }
}

export function getStructuredRetryDiagnosticFromError(error: unknown): StructuredRetryDiagnostic | undefined {
  if (!isRecord(error)) return undefined
  return normalizeStructuredRetryDiagnostic(error.retryDiagnostic) ?? undefined
}

export function getStructuredFailureClassFromError(error: unknown): StructuredFailureClass | undefined {
  if (!isRecord(error)) return undefined
  return isStructuredFailureClass(error.structuredFailureClass)
    ? error.structuredFailureClass
    : undefined
}

export function attachStructuredRetryDiagnostic<T extends Error>(
  error: T,
  diagnostic: StructuredRetryDiagnostic,
  failureClass?: StructuredFailureClass,
): T & StructuredRetryDiagnosticCarrier {
  const enriched = error as T & StructuredRetryDiagnosticCarrier
  enriched.retryDiagnostic = diagnostic
  if (failureClass) {
    enriched.structuredFailureClass = failureClass
  }
  return enriched
}

export function resolveStructuredRetryDiagnostic(params: {
  attempt: number
  rawResponse: string
  validationError: string
  failureClass?: StructuredFailureClass
  error?: unknown
  retryDiagnostic?: StructuredRetryDiagnostic
}): StructuredRetryDiagnostic {
  const existing = withStructuredRetryDiagnosticAttempt(
    params.retryDiagnostic ?? getStructuredRetryDiagnosticFromError(params.error),
    params.attempt,
  )
  if (existing) {
    return {
      ...existing,
      ...(params.failureClass ? { failureClass: params.failureClass } : {}),
    }
  }

  return buildStructuredRetryDiagnostic({
    attempt: params.attempt,
    rawResponse: params.rawResponse,
    validationError: params.validationError,
    failureClass: params.failureClass ?? getStructuredFailureClassFromError(params.error),
    error: params.error,
  })
}
