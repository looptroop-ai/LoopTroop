import { normalizeString } from './typeGuards'

/**
 * Why a structured-output attempt failed.
 *
 * The tuple is the single declaration: the type, this module's normaliser and
 * the server's error-shape reader all derive from it, where each used to spell
 * the seven names out again.
 */
export const STRUCTURED_FAILURE_CLASSES = [
  'validation_error',
  'output_truncated',
  'empty_response',
  'provider_error',
  'connection_reset',
  'session_protocol_error',
  'transport_error',
] as const

export type StructuredFailureClass = (typeof STRUCTURED_FAILURE_CLASSES)[number]

export function isStructuredFailureClass(value: unknown): value is StructuredFailureClass {
  return (STRUCTURED_FAILURE_CLASSES as readonly unknown[]).includes(value)
}

export interface StructuredRetryDiagnostic {
  attempt: number
  validationError: string
  failureClass?: StructuredFailureClass
  target?: string
  line?: number
  column?: number
  excerpt: string
}

function normalizeExcerpt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/^\n+|\n+$/g, '')
  return normalized.trim().length > 0 ? normalized : undefined
}

function normalizeStructuredFailureClass(value: unknown): StructuredFailureClass | undefined {
  return isStructuredFailureClass(value) ? value : undefined
}

function buildRetryDiagnosticKey(diagnostic: StructuredRetryDiagnostic): string {
  return JSON.stringify([
    diagnostic.attempt,
    diagnostic.validationError,
    diagnostic.failureClass ?? '',
    diagnostic.target ?? '',
    diagnostic.line ?? 0,
    diagnostic.column ?? 0,
    diagnostic.excerpt,
  ])
}

export function normalizeStructuredRetryDiagnostic(value: unknown): StructuredRetryDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const attempt = typeof record.attempt === 'number' && Number.isInteger(record.attempt) && record.attempt > 0
    ? record.attempt
    : null
  const validationError = normalizeString(record.validationError)
  const excerpt = normalizeExcerpt(record.excerpt)
  if (!attempt || !validationError || !excerpt) return null

  const line = typeof record.line === 'number' && Number.isInteger(record.line) && record.line > 0
    ? record.line
    : undefined
  const column = typeof record.column === 'number' && Number.isInteger(record.column) && record.column > 0
    ? record.column
    : undefined
  const target = normalizeString(record.target)
  const failureClass = normalizeStructuredFailureClass(record.failureClass)

  return {
    attempt,
    validationError,
    excerpt,
    ...(failureClass ? { failureClass } : {}),
    ...(target ? { target } : {}),
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
  }
}

export function normalizeStructuredRetryDiagnostics(value: unknown): StructuredRetryDiagnostic[] {
  if (!Array.isArray(value)) return []

  const diagnostics: StructuredRetryDiagnostic[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const diagnostic = normalizeStructuredRetryDiagnostic(entry)
    if (!diagnostic) continue
    const key = buildRetryDiagnosticKey(diagnostic)
    if (seen.has(key)) continue
    seen.add(key)
    diagnostics.push(diagnostic)
  }

  return diagnostics
}

export function mergeStructuredRetryDiagnostics(
  ...groups: Array<StructuredRetryDiagnostic[] | undefined>
): StructuredRetryDiagnostic[] {
  const merged: StructuredRetryDiagnostic[] = []
  const seen = new Set<string>()

  for (const group of groups) {
    for (const diagnostic of group ?? []) {
      const normalized = normalizeStructuredRetryDiagnostic(diagnostic)
      if (!normalized) continue
      const key = buildRetryDiagnosticKey(normalized)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(normalized)
    }
  }

  return merged
}

export function withStructuredRetryDiagnosticAttempt(
  diagnostic: StructuredRetryDiagnostic | undefined,
  attempt: number,
): StructuredRetryDiagnostic | undefined {
  if (!diagnostic || !Number.isInteger(attempt) || attempt <= 0) return diagnostic
  return {
    ...diagnostic,
    attempt,
  }
}
