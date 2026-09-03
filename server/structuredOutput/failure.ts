import type { StructuredOutputFailure } from './types'
import type { StructuredFailureClass, StructuredRetryDiagnostic } from '@shared/structuredRetryDiagnostics'
import { buildStructuredRetryDiagnostic } from '../lib/structuredRetryDiagnostics'
import { getErrorMessage } from '@shared/typeGuards'

export function buildStructuredOutputFailure(
  rawContent: string,
  error: string,
  options?: {
    repairApplied?: boolean
    repairWarnings?: string[]
    failureClass?: StructuredFailureClass
    cause?: unknown
    retryDiagnostic?: StructuredRetryDiagnostic
  },
): StructuredOutputFailure {
  return {
    ok: false,
    error,
    repairApplied: Boolean(options?.repairApplied),
    repairWarnings: options?.repairWarnings ?? [],
    retryDiagnostic: options?.retryDiagnostic ?? buildStructuredRetryDiagnostic({
      attempt: 1,
      rawResponse: rawContent,
      validationError: error,
      failureClass: options?.failureClass,
      error: options?.cause,
    }),
  }
}

export interface StructuredCandidateFailureTracker {
  /** Records a candidate rejected before parsing because it echoed the prompt schema. */
  recordPromptEcho(candidate: string, error: string): void
  /** Records a thrown candidate error, keeping its diagnostic and echo preference. */
  recordCandidateError(candidate: string, error: unknown, isPromptEcho: (message: string) => boolean): void
  /** Records a nested normaliser's failure, which already carries its own diagnostic. */
  recordCandidateFailure(failure: StructuredOutputFailure, isPromptEcho: (message: string) => boolean): void
  /** The failure to return once every candidate has been rejected. */
  build(rawContent: string, options?: { fallbackError?: string }): StructuredOutputFailure
}

/**
 * Shared bookkeeping for a normaliser that tries several candidates.
 *
 * Interview documents, resolved interview documents and PRDs each kept their own
 * `lastError` / `lastErrorCause` / `preferredPromptEcho*` variables and repeated
 * the same `??=` dance. interviewDocument's `lastRetryDiagnostic` was declared
 * and read but never assigned, so its failure quoted the whole raw response
 * rather than the candidate that failed.
 */
export function createStructuredCandidateFailureTracker(initialError: string): StructuredCandidateFailureTracker {
  let lastError = initialError
  let lastErrorCause: unknown = null
  let lastRetryDiagnostic: StructuredRetryDiagnostic | undefined
  let promptEchoError: string | undefined
  let promptEchoRetryDiagnostic: StructuredRetryDiagnostic | undefined

  const rememberPromptEcho = (failure: StructuredOutputFailure) => {
    promptEchoError ??= failure.error
    promptEchoRetryDiagnostic ??= failure.retryDiagnostic
  }

  return {
    recordPromptEcho(candidate, error) {
      rememberPromptEcho(buildStructuredOutputFailure(candidate, error))
    },
    recordCandidateError(candidate, error, isPromptEcho) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
      const failure = buildStructuredOutputFailure(candidate, lastError, { cause: error })
      lastRetryDiagnostic = failure.retryDiagnostic
      if (isPromptEcho(lastError)) rememberPromptEcho(failure)
    },
    recordCandidateFailure(failure, isPromptEcho) {
      if (isPromptEcho(failure.error)) {
        rememberPromptEcho(failure)
        return
      }
      lastError = failure.error
      // The two recorders used to leave different things here: a thrown Error
      // from one, a retry diagnostic from the other, so what a consumer read as
      // the cause depended on which had run. The diagnostic has its own slot
      // below; a pre-built failure carries no original error to put here.
      lastErrorCause = undefined
      lastRetryDiagnostic = failure.retryDiagnostic
    },
    build(rawContent, options) {
      if (promptEchoError) {
        return buildStructuredOutputFailure(rawContent, promptEchoError, {
          retryDiagnostic: promptEchoRetryDiagnostic,
        })
      }
      return buildStructuredOutputFailure(rawContent, options?.fallbackError ?? lastError, {
        cause: lastErrorCause,
        retryDiagnostic: lastRetryDiagnostic,
      })
    },
  }
}
