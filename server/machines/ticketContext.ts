import { PROFILE_DEFAULTS } from '../db/defaults'

import type { PublicTicket } from '../storage/ticketQueries'
import { normalizeSettingSource, type TicketContext } from './types'

/**
 * The subset of a ticket this builder reads.
 *
 * Declared structurally rather than as `PublicTicket` so test factories can
 * pass a fixture without assembling every field of a real row — the parity
 * test in `__tests__/ticketContext.test.ts` is what keeps this honest.
 */
export type TicketContextSource = Pick<PublicTicket,
  | 'id'
  | 'projectId'
  | 'externalId'
  | 'title'
  | 'status'
  | 'previousStatus'
  | 'createdAt'
  | 'updatedAt'
  | 'lockedMainImplementer'
  | 'lockedMainImplementerVariant'
  | 'lockedCouncilMembers'
  | 'lockedCouncilMemberVariants'
  | 'lockedInterviewQuestions'
  | 'lockedCoverageFollowUpBudgetPercent'
  | 'lockedMaxCoveragePasses'
  | 'lockedMaxPrdCoveragePasses'
  | 'lockedMaxBeadsCoveragePasses'
  | 'lockedStructuredRetryCount'
  | 'lockedManualQaEnabled'
  | 'lockedManualQaSource'
  | 'lockedAiQuestionsEnabled'
  | 'lockedAiQuestionsSource'
  | 'lockedAiQuestionWindow'
  | 'lockedAiQuestionWindowSource'
  | 'errorMessage'
  | 'errorOccurrences'
  | 'runtime'
>

/**
 * Builds a machine `TicketContext` from a ticket row.
 *
 * Two production call sites and two test factories each assembled this
 * thirty-five-field record by hand, and they had drifted: one dropped the
 * ticket's error, its codes and its diagnostics; one skipped the setting-source
 * normalisation; and the absent-`maxIterations` fallback was `0` in one and `1`
 * in the other where every other path in the codebase uses the profile default.
 * None of those differences was reachable — the consumers read only the
 * identity and model fields — which is exactly why they survived.
 *
 * The remaining `TicketContext` fields describe a *running* workflow
 * (`pendingExecutionSetupPlanRequestArtifactId`, `blockedErrorResolution`,
 * `councilResults`) and have no meaning for a context assembled outside the
 * actor, so they are fixed at their empty values rather than offered as
 * options.
 */
export function buildTicketContextFromTicket(ticket: TicketContextSource): TicketContext {
  const latestOccurrence = ticket.errorOccurrences.at(-1)

  return {
    ticketId: ticket.id,
    projectId: ticket.projectId,
    externalId: ticket.externalId,
    title: ticket.title,
    status: ticket.status,
    lockedMainImplementer: ticket.lockedMainImplementer,
    lockedMainImplementerVariant: ticket.lockedMainImplementerVariant,
    lockedCouncilMembers: ticket.lockedCouncilMembers,
    lockedCouncilMemberVariants: ticket.lockedCouncilMemberVariants,
    lockedInterviewQuestions: ticket.lockedInterviewQuestions,
    lockedCoverageFollowUpBudgetPercent: ticket.lockedCoverageFollowUpBudgetPercent,
    lockedMaxCoveragePasses: ticket.lockedMaxCoveragePasses,
    lockedMaxPrdCoveragePasses: ticket.lockedMaxPrdCoveragePasses,
    lockedMaxBeadsCoveragePasses: ticket.lockedMaxBeadsCoveragePasses,
    lockedStructuredRetryCount: ticket.lockedStructuredRetryCount,
    lockedManualQaEnabled: ticket.lockedManualQaEnabled,
    lockedManualQaSource: normalizeSettingSource(ticket.lockedManualQaSource),
    lockedAiQuestionsEnabled: ticket.lockedAiQuestionsEnabled,
    lockedAiQuestionsSource: normalizeSettingSource(ticket.lockedAiQuestionsSource),
    lockedAiQuestionWindow: ticket.lockedAiQuestionWindow,
    lockedAiQuestionWindowSource: normalizeSettingSource(ticket.lockedAiQuestionWindowSource),
    pendingExecutionSetupPlanRequestArtifactId: null,
    previousStatus: ticket.previousStatus,
    error: ticket.errorMessage,
    errorCodes: latestOccurrence?.errorCodes ?? [],
    errorDiagnostics: latestOccurrence?.diagnostics ?? null,
    blockedErrorResolution: null,
    beadProgress: {
      total: ticket.runtime.totalBeads,
      completed: ticket.runtime.completedBeads,
      current: ticket.runtime.activeBeadId,
    },
    iterationCount: ticket.runtime.iterationCount,
    maxIterations: ticket.runtime.maxIterations ?? PROFILE_DEFAULTS.maxIterations,
    councilResults: null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  }
}
