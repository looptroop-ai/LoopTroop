import type { OpenCodeResponseMeta } from '../opencode/assistantMessageAnalysis'
import type { StructuredFailureClass } from '@shared/structuredRetryDiagnostics'
import { getErrorMessage } from '@shared/typeGuards'

export type { StructuredFailureClass } from '@shared/structuredRetryDiagnostics'

export interface StructuredRetryDecision {
  failureClass: StructuredFailureClass
  reuseSession: boolean
  useStructuredRetryPrompt: boolean
}

export function classifyStructuredFailureFromMessage(message: string): StructuredFailureClass {
  const normalized = message.trim()
  if (!normalized) return 'empty_response'
  if (/connection reset by server|econnreset/i.test(normalized)) return 'connection_reset'
  if (/last message cannot have role 'assistant'|cannot have role 'assistant'|no longer active for/i.test(normalized)) {
    return 'session_protocol_error'
  }
  if (/provider returned error|param incorrect/i.test(normalized)) return 'provider_error'
  return 'transport_error'
}

export function classifyStructuredFailureFromError(error: unknown): StructuredFailureClass {
  return classifyStructuredFailureFromMessage(getErrorMessage(error))
}

export function classifyStructuredFailureFromValidation(
  response: string,
  responseMeta?: OpenCodeResponseMeta,
): StructuredFailureClass {
  if (responseMeta?.sessionErrored) {
    return classifyStructuredFailureFromMessage(responseMeta.sessionError ?? responseMeta.latestAssistantError ?? '')
  }

  if (responseMeta?.latestAssistantHasError) {
    return classifyStructuredFailureFromMessage(responseMeta.latestAssistantError ?? '')
  }

  if (responseMeta?.latestAssistantWasStale) {
    return 'empty_response'
  }

  if (isOutputTruncatedFinishReason(responseMeta?.latestStepFinishReason)) {
    return 'output_truncated'
  }

  if (!response.trim()) {
    return 'empty_response'
  }

  return 'validation_error'
}

export function getStructuredRetryDecision(
  response: string,
  responseMeta?: OpenCodeResponseMeta,
): StructuredRetryDecision {
  const failureClass = classifyStructuredFailureFromValidation(response, responseMeta)
  return {
    failureClass,
    reuseSession: failureClass === 'validation_error',
    useStructuredRetryPrompt: failureClass === 'validation_error',
  }
}

function isOutputTruncatedFinishReason(reason: string | undefined): boolean {
  if (!reason) return false
  return /^(length|max[_ -]?tokens?|output[_ -]?limit|token[_ -]?limit)$/i.test(reason.trim())
}

export function formatStructuredFailureForLog(
  failureClass?: StructuredFailureClass,
  error?: string,
): string {
  if (!failureClass) {
    return error ? `failed (${error})` : 'failed'
  }

  if (!error) {
    return `failed (${failureClass})`
  }

  return `failed (${failureClass}: ${error})`
}
