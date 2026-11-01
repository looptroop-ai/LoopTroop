import type { InterviewDocument } from '@shared/interviewArtifact'
import type { RefinementChange } from '@shared/refinementChanges'
import type { PrdDocument, PrdDraftMetrics } from '../../structuredOutput'
import {
  getPrdDraftMetrics,
  normalizePrdYamlOutput,
  normalizeResolvedInterviewDocumentOutput,
} from '../../structuredOutput'
import { attachStructuredRetryDiagnostic, buildStructuredRetryDiagnostic } from '../../lib/structuredRetryDiagnostics'

export interface ValidatedResolvedInterview {
  document: InterviewDocument
  questionCount: number
  normalizedContent: string
  repairApplied: boolean
  repairWarnings: string[]
}

export interface ValidatedPrdDraft {
  document: PrdDocument
  metrics: PrdDraftMetrics
  normalizedContent: string
  repairApplied: boolean
  repairWarnings: string[]
  changes?: RefinementChange[]
}

export function validatePrdDraft(
  content: string,
  options: {
    ticketId: string
    interviewContent?: string
    losingDraftMeta?: Array<{ memberId: string }>
    repoRoot?: string
  },
): ValidatedPrdDraft {
  const result = normalizePrdYamlOutput(content, options)
  if (!result.ok) {
    const error = new Error(result.error)
    throw attachStructuredRetryDiagnostic(
      error,
      result.retryDiagnostic ?? buildStructuredRetryDiagnostic({
        attempt: 1,
        rawResponse: content,
        validationError: result.error,
      }),
    )
  }

  const { changes, ...document } = result.value

  return {
    document,
    metrics: getPrdDraftMetrics(document),
    normalizedContent: result.normalizedContent,
    repairApplied: result.repairApplied,
    repairWarnings: result.repairWarnings,
    ...(changes ? { changes } : {}),
  }
}

export function validateResolvedInterview(
  content: string,
  options: {
    ticketId: string
    canonicalInterviewContent: string
    memberId?: string
  },
): ValidatedResolvedInterview {
  const result = normalizeResolvedInterviewDocumentOutput(content, options)
  if (!result.ok) {
    const error = new Error(result.error)
    throw attachStructuredRetryDiagnostic(
      error,
      result.retryDiagnostic ?? buildStructuredRetryDiagnostic({
        attempt: 1,
        rawResponse: content,
        validationError: result.error,
      }),
    )
  }

  return {
    document: result.value,
    questionCount: result.value.questions.length,
    normalizedContent: result.normalizedContent,
    repairApplied: result.repairApplied,
    repairWarnings: result.repairWarnings,
  }
}
