import { getStructuredOutputWarnings, hasArtifactProcessingNotice } from '../artifactProcessingNotice'
import {
  mergeStructuredInterventions,
  normalizeStructuredInterventions,
} from '@shared/structuredInterventions'
import type { StructuredIntervention } from '@shared/structuredInterventions'
import { mergeStructuredRetryDiagnostics } from '@shared/structuredRetryDiagnostics'
import type { ArtifactStructuredOutputData } from '../phaseArtifactTypes'

/** Folding a raw-output normalisation into an artifact's structured-output record. */

export function mergeStructuredOutputMetadata(
  outputs: Array<ArtifactStructuredOutputData | undefined | null>,
): ArtifactStructuredOutputData | undefined {
  const present = outputs.filter((output): output is ArtifactStructuredOutputData => Boolean(output))
  if (present.length === 0) return undefined

  return present.reduce<ArtifactStructuredOutputData>((merged, output) => ({
    repairApplied: Boolean(merged.repairApplied || output.repairApplied),
    repairWarnings: [...(merged.repairWarnings ?? []), ...getStructuredOutputWarnings(output)],
    autoRetryCount: Math.max(merged.autoRetryCount ?? 0, output.autoRetryCount ?? 0),
    ...(mergeStructuredRetryDiagnostics(merged.retryDiagnostics, output.retryDiagnostics).length > 0
      ? { retryDiagnostics: mergeStructuredRetryDiagnostics(merged.retryDiagnostics, output.retryDiagnostics) }
      : {}),
    interventions: mergeStructuredInterventions(
      normalizeStructuredInterventions(merged.interventions),
      normalizeStructuredInterventions(output.interventions),
    ),
    ...(output.validationError
      ? { validationError: output.validationError }
      : merged.validationError
        ? { validationError: merged.validationError }
        : {}),
  }), {
    repairApplied: false,
    repairWarnings: [],
    autoRetryCount: 0,
  })
}

const RAW_NORMALIZATION_WARNING = 'Normalized saved artifact details from raw model output before saving the validated artifact.'

function buildRawNormalizationIntervention(): StructuredIntervention {
  return {
    code: 'cleanup_raw_normalization',
    stage: 'normalize',
    category: 'cleanup',
    title: 'Saved validated output instead of raw model text',
    summary: 'The raw model response and the persisted validated artifact differed.',
    why: 'The raw response included formatting or wrapper detail that was not part of the validated artifact shape.',
    how: 'LoopTroop persisted the normalized validated artifact while keeping the raw response available in the Raw view.',
    rule: {
      id: 'cleanup_raw_normalization',
      label: 'Raw Output Normalization',
    },
    exactCorrection: 'Persisted the validated structured output instead of the raw model text.',
    technicalDetail: RAW_NORMALIZATION_WARNING,
    rawMessages: [RAW_NORMALIZATION_WARNING],
  }
}

function didPersistedOutputChange(
  rawResponse?: string,
  normalizedResponse?: string,
  content?: string,
): boolean {
  if (typeof rawResponse !== 'string') return false
  const validated = typeof normalizedResponse === 'string'
    ? normalizedResponse
    : typeof content === 'string'
      ? content
      : undefined
  return typeof validated === 'string' && rawResponse !== validated
}

export function withRawNormalizationNotice(
  structuredOutput?: ArtifactStructuredOutputData,
  rawResponse?: string,
  normalizedResponse?: string,
  content?: string,
): ArtifactStructuredOutputData | undefined {
  if (!didPersistedOutputChange(rawResponse, normalizedResponse, content)) return structuredOutput
  if (hasArtifactProcessingNotice(structuredOutput)) return structuredOutput

  const repairWarnings = getStructuredOutputWarnings(structuredOutput)
  const interventions = mergeStructuredInterventions(
    normalizeStructuredInterventions(structuredOutput?.interventions),
    [buildRawNormalizationIntervention()],
  )
  return {
    ...(structuredOutput ?? {}),
    repairApplied: true,
    repairWarnings: repairWarnings.includes(RAW_NORMALIZATION_WARNING)
      ? repairWarnings
      : [...repairWarnings, RAW_NORMALIZATION_WARNING],
    autoRetryCount: structuredOutput?.autoRetryCount ?? 0,
    interventions,
  }
}
