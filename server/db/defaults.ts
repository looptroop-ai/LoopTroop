import { COUNCIL_RESPONSE_TIMEOUT_MS } from '../lib/constants'

export const PROFILE_DEFAULTS = {
  gitHookPolicy: 'validate_advisory',
  manualQaEnabled: false,
  minCouncilQuorum: 2,
  perIterationTimeout: 1200000,
  executionSetupTimeout: 1200000,
  councilResponseTimeout: COUNCIL_RESPONSE_TIMEOUT_MS,
  interviewQuestions: 50,
  coverageFollowUpBudgetPercent: 20,
  maxCoveragePasses: 2,
  maxPrdCoveragePasses: 5,
  maxBeadsCoveragePasses: 5,
  structuredRetryCount: 1,
  maxIterations: 5,
  opencodeRetryLimit: 10,
  opencodeRetryDelay: 60_000,
  opencodeSteps: 0,
  toolInputMaxChars: 4000,
  toolOutputMaxChars: 12_000,
  toolErrorMaxChars: 6_000,
} as const
