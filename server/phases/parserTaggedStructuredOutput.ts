import type { StructuredOutputResult } from '../structuredOutput'
import type { StructuredRetryDiagnostic } from '@shared/structuredRetryDiagnostics'

interface TaggedStructuredParseSuccess<T> {
  ok: true
  markerFound: true
  value: T
  repairApplied: boolean
  repairWarnings: string[]
}

interface TaggedStructuredParseFailure {
  ok: false
  markerFound: boolean
  errors: string[]
  repairApplied: boolean
  repairWarnings: string[]
  validationError: string
  retryDiagnostic?: StructuredRetryDiagnostic
}

/**
 * `markerFound` used to be inferred from the error text when a caller omitted the
 * tags, so a prompt echo or any other validation error read as "the marker was
 * present". The tags are required: the only honest answer is whether they are in
 * the output.
 */
export function unwrapTaggedStructuredOutput<T>(
  output: string,
  normalized: StructuredOutputResult<T>,
  options: {
    missingMarkerError: string
    markerStart: string
    markerEnd: string
  },
): TaggedStructuredParseSuccess<T> | TaggedStructuredParseFailure {
  if (!normalized.ok) {
    const markerFound = output.includes(options.markerStart) && output.includes(options.markerEnd)

    return {
      ok: false,
      markerFound,
      errors: [normalized.error],
      repairApplied: normalized.repairApplied,
      repairWarnings: normalized.repairWarnings,
      validationError: normalized.error,
      retryDiagnostic: normalized.retryDiagnostic,
    }
  }

  return {
    ok: true,
    markerFound: true,
    value: normalized.value,
    repairApplied: normalized.repairApplied,
    repairWarnings: normalized.repairWarnings,
  }
}
