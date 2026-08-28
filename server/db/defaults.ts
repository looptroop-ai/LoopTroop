import { COUNCIL_RESPONSE_TIMEOUT_MS } from '../lib/constants'
import { AI_QUESTION_WINDOW_DEFAULT_MS } from '@shared/aiQuestions'

export const PROFILE_DEFAULTS = {
  gitHookPolicy: 'validate_advisory',
  ignoreMode: 'local',
  manualQaEnabled: true,
  aiQuestionsEnabled: true,
  aiQuestionWindow: AI_QUESTION_WINDOW_DEFAULT_MS,
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
