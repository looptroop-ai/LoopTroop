/**
 * Configuration defaults both halves of the app need.
 *
 * These lived in `server/db/defaults.ts`, which imports `server/lib/constants`,
 * so seven SPA components importing them dragged a server database module —
 * and everything it transitively imports — into `dist/client`.
 *
 * This is a split, not a move: the server's own file still exists and still
 * owns the two defaults the SPA never reads. Nothing here may import a server
 * module, or the bundle problem comes straight back.
 */
import { AI_QUESTION_WINDOW_DEFAULT_MS } from './aiQuestions'

export const SHARED_PROFILE_DEFAULTS = {
  manualQaEnabled: true,
  aiQuestionsEnabled: true,
  aiQuestionWindow: AI_QUESTION_WINDOW_DEFAULT_MS,
  minCouncilQuorum: 2,
  perIterationTimeout: 1_200_000,
  executionSetupTimeout: 1_200_000,
  councilResponseTimeout: 1_200_000,
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
