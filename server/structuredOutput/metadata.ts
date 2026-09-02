import {
  deriveStructuredInterventions,
  mergeStructuredInterventions,
  normalizeStructuredInterventions,
} from '@shared/structuredInterventions'
import {
  mergeStructuredRetryDiagnostics,
  normalizeStructuredRetryDiagnostics,
} from '@shared/structuredRetryDiagnostics'
import type { StructuredOutputMetadata } from './types'
import { isRecord } from './yamlUtils'

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const normalized = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  const unique: string[] = []
  const seen = new Set<string>()

  for (const entry of normalized) {
    if (seen.has(entry)) continue
    seen.add(entry)
    unique.push(entry)
  }

  return unique
}

export function normalizeStructuredOutputMetadata(value: unknown): StructuredOutputMetadata | undefined {
  if (!isRecord(value)) return undefined

  const repairApplied = typeof value.repairApplied === 'boolean' ? value.repairApplied : false
  const repairWarnings = normalizeStringArray(value.repairWarnings)
  const autoRetryCount = typeof value.autoRetryCount === 'number' && Number.isInteger(value.autoRetryCount)
    ? value.autoRetryCount
    : 0
  const validationError = typeof value.validationError === 'string' && value.validationError.trim()
    ? value.validationError
    : undefined
  const retryDiagnostics = normalizeStructuredRetryDiagnostics(value.retryDiagnostics)
  const interventions = normalizeStructuredInterventions(value.interventions)

  return {
    repairApplied,
    repairWarnings,
    autoRetryCount,
    ...(validationError ? { validationError } : {}),
    ...(retryDiagnostics.length > 0 ? { retryDiagnostics } : {}),
    ...(interventions.length > 0 ? { interventions } : {}),
  }
}

export function buildStructuredOutputMetadata(
  base: Partial<StructuredOutputMetadata> | null | undefined,
  extra?: Partial<StructuredOutputMetadata>,
): StructuredOutputMetadata {
  const retryDiagnostics = mergeStructuredRetryDiagnostics(base?.retryDiagnostics, extra?.retryDiagnostics)
  const merged: StructuredOutputMetadata = {
    repairApplied: Boolean(base?.repairApplied || extra?.repairApplied),
    repairWarnings: normalizeStringArray([
      ...normalizeStringArray(base?.repairWarnings),
      ...normalizeStringArray(extra?.repairWarnings),
    ]),
    autoRetryCount: Math.max(base?.autoRetryCount ?? 0, extra?.autoRetryCount ?? 0),
    ...(extra?.validationError
      ? { validationError: extra.validationError }
      : base?.validationError
        ? { validationError: base.validationError }
        : {}),
    ...(retryDiagnostics.length > 0 ? { retryDiagnostics } : {}),
  }

  const interventions = mergeStructuredInterventions(
    normalizeStructuredInterventions(base?.interventions),
    normalizeStructuredInterventions(extra?.interventions),
    deriveStructuredInterventions({
      repairWarnings: merged.repairWarnings,
      autoRetryCount: merged.autoRetryCount,
      validationError: merged.validationError,
    }),
  )

  return interventions.length > 0
    ? { ...merged, interventions }
    : merged
}
