import { EXECUTION_SETUP_RESULT_END, EXECUTION_SETUP_RESULT_MARKER } from './types'
import { normalizeExecutionSetupResultOutput } from '../../structuredOutput'
import { unwrapTaggedStructuredOutput } from '../parserTaggedStructuredOutput'
import type { ExecutionSetupParseResult } from './types'

export function parseExecutionSetupResult(output: string): ExecutionSetupParseResult {
  const parsed = unwrapTaggedStructuredOutput(
    output,
    normalizeExecutionSetupResultOutput(output),
    {
      markerStart: EXECUTION_SETUP_RESULT_MARKER,
      markerEnd: EXECUTION_SETUP_RESULT_END,
    },
  )

  if (!parsed.ok) {
    return {
      markerFound: parsed.markerFound,
      result: null,
      errors: parsed.errors,
      repairApplied: parsed.repairApplied,
      repairWarnings: parsed.repairWarnings,
      validationError: parsed.validationError,
      retryDiagnostic: parsed.retryDiagnostic,
    }
  }

  return {
    markerFound: parsed.markerFound,
    result: parsed.value,
    errors: [],
    repairApplied: parsed.repairApplied,
    repairWarnings: parsed.repairWarnings,
  }
}
