import type { PromptPart } from '../../opencode/types'
import { PROM5, PROM13, PROM23 } from '../../prompts/index'
import { db as appDb } from '../../db/index'
import { profiles } from '../../db/schema'
import { PROFILE_DEFAULTS } from '../../db/defaults'
import type { TicketContext } from '../../machines/types'
import {
  getTicketContext as getStoredTicketContext,
} from '../../storage/tickets'
import { normalizeStructuredRetryCount } from '../../lib/structuredRetryPolicy'
export { resolveAiQuestionSettings } from '../aiQuestionSettings'
import type { WorkflowPhaseId } from '@shared/workflowMeta'

export function mapCouncilStageToStatus(
  flow: 'interview' | 'prd' | 'beads',
  stage: 'draft' | 'vote' | 'refine',
): WorkflowPhaseId {
  if (flow === 'interview') {
    if (stage === 'draft') return 'COUNCIL_DELIBERATING'
    if (stage === 'vote') return 'COUNCIL_VOTING_INTERVIEW'
    return 'COMPILING_INTERVIEW'
  }
  if (flow === 'prd') {
    if (stage === 'draft') return 'DRAFTING_PRD'
    if (stage === 'vote') return 'COUNCIL_VOTING_PRD'
    return 'REFINING_PRD'
  }
  if (stage === 'draft') return 'DRAFTING_BEADS'
  if (stage === 'vote') return 'COUNCIL_VOTING_BEADS'
  return 'REFINING_BEADS'
}

export function formatCouncilMemberRoster(members: Array<{ modelId: string; name: string }>): string {
  return members.map(member => member.modelId).join(', ')
}

export function describeCouncilMemberSource(source: 'locked_ticket' | 'profile'): string {
  if (source === 'locked_ticket') return 'locked ticket config'
  return 'profile config'
}

export function formatCouncilResolutionLog(
  context: TicketContext,
  council: {
    members: Array<{ modelId: string; name: string }>
    source: 'locked_ticket' | 'profile'
  },
): string {
  const implementer = context.lockedMainImplementer ?? 'not configured'
  return `Council members resolved from ${describeCouncilMemberSource(council.source)}: ${council.members.length} members (${formatCouncilMemberRoster(council.members)}). Main implementer: ${implementer}.`
}

export function resolveInterviewDraftSettings(context: TicketContext): {
  maxInitialQuestions: number
  coverageFollowUpBudgetPercent: number
  draftTimeoutMs: number
  minQuorum: number
} {
  const councilSettings = resolveCouncilRuntimeSettings(context)
  const storedContext = getStoredTicketContext(context.ticketId)
  const profile = appDb.select().from(profiles).get()
  const maxInitialQuestions = context.lockedInterviewQuestions
    ?? storedContext?.localProject.interviewQuestions
    ?? profile?.interviewQuestions
    ?? 50

  return {
    maxInitialQuestions,
    coverageFollowUpBudgetPercent: resolveCoverageRuntimeSettings(context).coverageFollowUpBudgetPercent,
    draftTimeoutMs: councilSettings.draftTimeoutMs,
    minQuorum: councilSettings.minQuorum,
  }
}

export function resolveCoverageRuntimeSettings(context: TicketContext): {
  coverageFollowUpBudgetPercent: number
  maxCoveragePasses: number
  maxPrdCoveragePasses: number
  maxBeadsCoveragePasses: number
} {
  const profile = appDb.select().from(profiles).get()

  return {
    coverageFollowUpBudgetPercent: context.lockedCoverageFollowUpBudgetPercent
      ?? profile?.coverageFollowUpBudgetPercent
      ?? PROFILE_DEFAULTS.coverageFollowUpBudgetPercent,
    maxCoveragePasses: context.lockedMaxCoveragePasses
      ?? profile?.maxCoveragePasses
      ?? PROFILE_DEFAULTS.maxCoveragePasses,
    maxPrdCoveragePasses: context.lockedMaxPrdCoveragePasses
      ?? profile?.maxPrdCoveragePasses
      ?? PROFILE_DEFAULTS.maxPrdCoveragePasses,
    maxBeadsCoveragePasses: context.lockedMaxBeadsCoveragePasses
      ?? profile?.maxBeadsCoveragePasses
      ?? PROFILE_DEFAULTS.maxBeadsCoveragePasses,
  }
}

export function resolveStructuredRetryRuntimeSettings(context: TicketContext): {
  structuredRetryCount: number
} {
  const profile = appDb.select().from(profiles).get()

  return {
    structuredRetryCount: normalizeStructuredRetryCount(
      context.lockedStructuredRetryCount
        ?? profile?.structuredRetryCount
        ?? PROFILE_DEFAULTS.structuredRetryCount,
    ),
  }
}

export function resolveStructuredRetryCountForTicket(ticketId: string): number {
  const storedContext = getStoredTicketContext(ticketId)
  const profile = appDb.select().from(profiles).get()

  return normalizeStructuredRetryCount(
    storedContext?.localTicket.lockedStructuredRetryCount
      ?? profile?.structuredRetryCount
      ?? PROFILE_DEFAULTS.structuredRetryCount,
  )
}

export function getCoverageStateLabel(phase: 'interview' | 'prd' | 'beads'): WorkflowPhaseId {
  return phase === 'interview'
    ? 'VERIFYING_INTERVIEW_COVERAGE'
    : phase === 'prd'
      ? 'VERIFYING_PRD_COVERAGE'
      : 'VERIFYING_BEADS_COVERAGE'
}

export function getCoverageContextPhase(phase: 'interview' | 'prd' | 'beads'): 'interview_coverage' | 'prd_coverage' | 'beads_coverage' {
  return phase === 'interview'
    ? 'interview_coverage'
    : phase === 'prd'
      ? 'prd_coverage'
      : 'beads_coverage'
}

export function getCoveragePromptTemplate(phase: 'interview' | 'prd' | 'beads') {
  return phase === 'interview' ? PROM5 : phase === 'prd' ? PROM13 : PROM23
}

export function describeCoverageTerminationReason(reason: string): string {
  if (reason === 'coverage_pass_limit_reached') return 'retry cap reached'
  if (reason === 'follow_up_budget_exhausted') return 'follow-up budget exhausted'
  if (reason === 'follow_up_generation_failed') return 'follow-up generation failed'
  return 'manual review required'
}

export function buildCoveragePromptConfiguration(input: {
  phase: 'interview' | 'prd' | 'beads'
  coverageRunNumber: number
  maxCoveragePasses: number
  isFinalAllowedRun: boolean
  coverageFollowUpBudgetPercent?: number
  followUpBudgetTotal?: number
  followUpBudgetUsed?: number
  followUpBudgetRemaining?: number
}): PromptPart {
  const remainingCoverageRuns = Math.max(input.maxCoveragePasses - input.coverageRunNumber, 0)
  const lines = [
    '## Coverage Configuration',
    `coverage_domain: ${input.phase}`,
    `coverage_run_number: ${input.coverageRunNumber}`,
    `max_coverage_passes: ${input.maxCoveragePasses}`,
    `is_final_coverage_run: ${input.isFinalAllowedRun ? 'true' : 'false'}`,
    input.isFinalAllowedRun
      ? 'This is the final allowed coverage run. If gaps remain, report them clearly and do not assume another retry or refinement loop exists.'
      : remainingCoverageRuns === 1
        ? 'At most one more coverage run may occur after this one if real gaps remain.'
        : `Up to ${remainingCoverageRuns} more coverage runs may occur after this one if real gaps remain.`,
  ]

  if (input.phase === 'interview') {
    lines.push(
      `coverage_follow_up_budget_percent: ${input.coverageFollowUpBudgetPercent ?? PROFILE_DEFAULTS.coverageFollowUpBudgetPercent}`,
      `follow_up_budget_total: ${input.followUpBudgetTotal ?? 0}`,
      `follow_up_budget_used: ${input.followUpBudgetUsed ?? 0}`,
      `follow_up_budget_remaining: ${input.followUpBudgetRemaining ?? 0}`,
      (input.followUpBudgetRemaining ?? 0) === 0
        ? 'If gaps remain and follow_up_budget_remaining is 0, you MUST return `status: gaps`, concrete `gaps`, and `follow_up_questions: []`.'
        : 'If gaps remain, generate only the targeted follow-up questions that fit within follow_up_budget_remaining.',
    )
  } else if (input.phase === 'prd') {
    lines.push(
      'PRD coverage is envelope-only: return `follow_up_questions: []` and do not invent PRD follow-up questions.',
      'If you need to flag more work, use concrete `gaps` entries only.',
    )
  }

  return {
    type: 'text',
    source: 'coverage_settings',
    content: lines.join('\n'),
  }
}

export function resolveCouncilRuntimeSettings(context: TicketContext): {
  draftTimeoutMs: number
  minQuorum: number
} {
  const storedContext = getStoredTicketContext(context.ticketId)
  const profile = appDb.select().from(profiles).get()
  const draftTimeoutMs = storedContext?.localProject.councilResponseTimeout
    ?? profile?.councilResponseTimeout
    ?? PROFILE_DEFAULTS.councilResponseTimeout
  const minQuorum = storedContext?.localProject.minCouncilQuorum
    ?? profile?.minCouncilQuorum
    ?? PROFILE_DEFAULTS.minCouncilQuorum

  return {
    draftTimeoutMs,
    minQuorum,
  }
}

export function resolveAiResponseRuntimeSettings(context: TicketContext): {
  timeoutMs: number
  minQuorum: number
} {
  const councilSettings = resolveCouncilRuntimeSettings(context)
  return {
    timeoutMs: councilSettings.draftTimeoutMs,
    minQuorum: councilSettings.minQuorum,
  }
}

export function resolveAiResponseTimeoutForTicket(ticketId: string): number {
  const storedContext = getStoredTicketContext(ticketId)
  const profile = appDb.select().from(profiles).get()
  return storedContext?.localProject.councilResponseTimeout
    ?? profile?.councilResponseTimeout
    ?? PROFILE_DEFAULTS.councilResponseTimeout
}

export function resolveExecutionRuntimeSettings(context: TicketContext): {
  maxIterations: number
  perIterationTimeoutMs: number
  opencodeRetryLimit: number
  opencodeRetryDelayMs: number
  opencodeSteps: number
} {
  const storedContext = getStoredTicketContext(context.ticketId)
  const profile = appDb.select().from(profiles).get()
  const maxIterations = storedContext?.localProject.maxIterations
    ?? profile?.maxIterations
    ?? context.maxIterations
    ?? PROFILE_DEFAULTS.maxIterations
  const perIterationTimeoutMs = storedContext?.localProject.perIterationTimeout
    ?? profile?.perIterationTimeout
    ?? PROFILE_DEFAULTS.perIterationTimeout
  const opencodeRetryLimit = profile?.opencodeRetryLimit ?? PROFILE_DEFAULTS.opencodeRetryLimit
  const opencodeRetryDelayMs = profile?.opencodeRetryDelay ?? PROFILE_DEFAULTS.opencodeRetryDelay
  const opencodeSteps = profile?.opencodeSteps ?? PROFILE_DEFAULTS.opencodeSteps

  return {
    maxIterations,
    perIterationTimeoutMs,
    opencodeRetryLimit,
    opencodeRetryDelayMs,
    opencodeSteps,
  }
}

export function resolveExecutionSetupRuntimeSettings(context: TicketContext): {
  maxIterations: number
  timeoutMs: number
} {
  const storedContext = getStoredTicketContext(context.ticketId)
  const profile = appDb.select().from(profiles).get()
  const maxIterations = storedContext?.localProject.maxIterations
    ?? profile?.maxIterations
    ?? context.maxIterations
    ?? PROFILE_DEFAULTS.maxIterations
  const timeoutMs = storedContext?.localProject.executionSetupTimeout
    ?? profile?.executionSetupTimeout
    ?? PROFILE_DEFAULTS.executionSetupTimeout

  return {
    maxIterations,
    timeoutMs,
  }
}

export function formatDurationMs(durationMs: number): string {
  if (durationMs >= 60000) return `${(durationMs / 60000).toFixed(1)}m`
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(1)}s`
  return `${durationMs}ms`
}
