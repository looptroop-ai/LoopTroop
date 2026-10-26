import { BEAD_FINALIZATION_FAILED } from './errorCodes'
import type { WorkflowPhaseId } from './workflowMeta'
import type { BlockedErrorDiagnostics } from './errorDiagnostics'

/** Phases whose failed work can be restarted with instructions for an AI. */
const AI_RETRY_PHASES = new Set<WorkflowPhaseId>([
  'SCANNING_RELEVANT_FILES',
  'COUNCIL_DELIBERATING',
  'COUNCIL_VOTING_INTERVIEW',
  'COMPILING_INTERVIEW',
  'WAITING_INTERVIEW_ANSWERS',
  'VERIFYING_INTERVIEW_COVERAGE',
  'DRAFTING_PRD',
  'COUNCIL_VOTING_PRD',
  'REFINING_PRD',
  'VERIFYING_PRD_COVERAGE',
  'DRAFTING_BEADS',
  'COUNCIL_VOTING_BEADS',
  'REFINING_BEADS',
  'VERIFYING_BEADS_COVERAGE',
  'EXPANDING_BEADS',
  'PRE_FLIGHT_CHECK',
  'GENERATING_EXECUTION_SETUP_PLAN',
  'PREPARING_EXECUTION_ENV',
  'CODING',
  'RUNNING_FINAL_TEST',
  'GENERATING_QA_CHECKLIST',
  'WAITING_MANUAL_QA',
  'CREATING_PULL_REQUEST',
])

export function isAiRetryPhase(phase: string | null | undefined): phase is WorkflowPhaseId {
  return AI_RETRY_PHASES.has(phase as WorkflowPhaseId)
}

export function supportsRetryNote(
  phase: string | null | undefined,
  errorCodes: readonly string[] = [],
  diagnostics?: BlockedErrorDiagnostics | null,
): boolean {
  if (!isAiRetryPhase(phase) || errorCodes.some(code => [
    BEAD_FINALIZATION_FAILED, 'MAIN_IMPLEMENTER_MISSING', 'PROM4_NO_WINNER',
    'PROM4_NO_COMPILED_INTERVIEW', 'PROM4_INVALID_COMPILED_INTERVIEW', 'FINAL_TEST_FAILED',
  ].includes(code))) return false
  if (diagnostics?.source === 'system' || diagnostics?.source === 'runtime') return false
  if (phase === 'WAITING_MANUAL_QA') return errorCodes.includes('MANUAL_QA_FIX_BEADS_FAILED')
  if (phase === 'PRE_FLIGHT_CHECK' || phase === 'CREATING_PULL_REQUEST') {
    return diagnostics?.source === 'opencode' || diagnostics?.source === 'provider'
  }
  return true
}
