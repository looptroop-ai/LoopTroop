export const EXECUTION_BAND_STATUSES = [
  'PRE_FLIGHT_CHECK',
  'GENERATING_EXECUTION_SETUP_PLAN',
  'WAITING_EXECUTION_SETUP_APPROVAL',
  'PREPARING_EXECUTION_ENV',
  'CODING',
  'RUNNING_FINAL_TEST',
  'GENERATING_QA_CHECKLIST',
  'WAITING_MANUAL_QA',
  'INTEGRATING_CHANGES',
  'CREATING_PULL_REQUEST',
  'WAITING_PR_REVIEW',
  'CLEANING_ENV',
] as const

export function isExecutionBandStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && EXECUTION_BAND_STATUSES.includes(status as (typeof EXECUTION_BAND_STATUSES)[number])
}
