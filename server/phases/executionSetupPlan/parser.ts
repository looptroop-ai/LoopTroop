import { EXECUTION_SETUP_PLAN_RESULT_END, EXECUTION_SETUP_PLAN_RESULT_MARKER } from './types'
import { normalizeExecutionSetupPlanOutput } from '../../structuredOutput'
import { unwrapTaggedStructuredOutput } from '../parserTaggedStructuredOutput'
import type { ExecutionSetupPlanParseResult } from './types'

export function parseExecutionSetupPlanResult(output: string): ExecutionSetupPlanParseResult {
  const parsed = unwrapTaggedStructuredOutput(
    output,
    normalizeExecutionSetupPlanOutput(output),
    {
      markerStart: EXECUTION_SETUP_PLAN_RESULT_MARKER,
      markerEnd: EXECUTION_SETUP_PLAN_RESULT_END,
    },
  )

  if (!parsed.ok) {
    return {
      markerFound: parsed.markerFound,
      plan: null,
      errors: parsed.errors,
      repairApplied: parsed.repairApplied,
      repairWarnings: parsed.repairWarnings,
      validationError: parsed.validationError,
      retryDiagnostic: parsed.retryDiagnostic,
    }
  }

  return {
    markerFound: parsed.markerFound,
    plan: parsed.value,
    errors: [],
    repairApplied: parsed.repairApplied,
    repairWarnings: parsed.repairWarnings,
  }
}
