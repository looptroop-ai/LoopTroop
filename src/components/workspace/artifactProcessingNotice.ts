import {
  deriveStructuredInterventions,
  normalizeStructuredInterventions,
  STRUCTURED_INTERVENTION_CATEGORY_ORDER,
} from '@shared/structuredInterventions'
import type {
  StructuredIntervention,
  StructuredInterventionCategory,
  StructuredInterventionStage,
} from '@shared/structuredInterventions'
import { isCouncilMemberOutcome } from '@shared/councilMembers'
import type {
  ArtifactStructuredOutputData,
  CouncilOutcome,
} from './phaseArtifactTypes'

export type ArtifactProcessingKind =
  | 'artifact'
  | 'diff'
  | 'coverage'
  | 'relevant-files'
  | 'vote'
  | 'vote-aggregate'
  | 'draft'
  | 'interview-draft'
  | 'prd-draft'
  | 'beads-draft'
  | 'full-answers'
  | 'final-test'

export type ArtifactProcessingStatus = 'completed' | CouncilOutcome

export interface ArtifactProcessingNoticeContext {
  affectedCount?: number
  fullAnswersOrigin?: 'reused-approved-interview'
  ownerInterventions?: Array<{ label: string; structuredOutput?: ArtifactStructuredOutputData }>
  status?: ArtifactProcessingStatus
}

export interface ArtifactProcessingNoticeCopy {
  title: string
  summary: string
  body: string
  badges: Array<{ label: string; count: number; className: string }>
  interventions: StructuredIntervention[]
}

export const INTERVENTION_CATEGORY_COPY: Record<StructuredInterventionCategory, { label: string; className: string }> = {
  parser_fix: {
    label: 'Parser Fix',
    className: 'border-amber-300 bg-amber-100/80 text-amber-900 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100',
  },
  cleanup: {
    label: 'Cleanup',
    className: 'border-blue-300 bg-blue-100/80 text-blue-900 dark:border-blue-700 dark:bg-blue-900/40 dark:text-blue-100',
  },
  synthesized: {
    label: 'Synthesized',
    className: 'border-emerald-300 bg-emerald-100/80 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-100',
  },
  dropped: {
    label: 'Dropped',
    className: 'border-rose-300 bg-rose-100/80 text-rose-900 dark:border-rose-700 dark:bg-rose-900/40 dark:text-rose-100',
  },
  attribution: {
    label: 'Attribution',
    className: 'border-violet-300 bg-violet-100/80 text-violet-900 dark:border-violet-700 dark:bg-violet-900/40 dark:text-violet-100',
  },
  retry: {
    label: 'Retry',
    className: 'border-slate-300 bg-slate-100/80 text-slate-900 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-100',
  },
}

export const INTERVENTION_STAGE_LABELS: Record<StructuredInterventionStage, string> = {
  parse: 'Parse',
  normalize: 'Normalize',
  semantic_validation: 'Validation',
  retry: 'Retry',
}

export function getStructuredOutputWarnings(structuredOutput?: ArtifactStructuredOutputData): string[] {
  return (structuredOutput?.repairWarnings ?? []).filter(
    (warning): warning is string => typeof warning === 'string' && warning.trim().length > 0,
  )
}

export function getStructuredOutputInterventions(structuredOutput?: ArtifactStructuredOutputData): StructuredIntervention[] {
  const explicit = normalizeStructuredInterventions(structuredOutput?.interventions)
  if (explicit.length > 0) return explicit

  return deriveStructuredInterventions({
    repairWarnings: structuredOutput?.repairWarnings,
    autoRetryCount: structuredOutput?.autoRetryCount,
    validationError: structuredOutput?.validationError,
  }).filter((intervention) => intervention.code !== 'cleanup_generic')
}

export function hasArtifactProcessingNotice(structuredOutput?: ArtifactStructuredOutputData): boolean {
  return Boolean(structuredOutput && getStructuredOutputInterventions(structuredOutput).length > 0)
}

function getStructuredRetryAttemptCount(structuredOutput?: ArtifactStructuredOutputData): number {
  const autoRetryCount = structuredOutput?.autoRetryCount
  return Number.isInteger(autoRetryCount) && (autoRetryCount ?? 0) > 0
    ? autoRetryCount ?? 0
    : 0
}

function getContextRetryAttemptCount(context?: ArtifactProcessingNoticeContext): number {
  return (context?.ownerInterventions ?? []).reduce(
    (total, owner) => total + getStructuredRetryAttemptCount(owner.structuredOutput),
    0,
  )
}

function getContextInterventions(context?: ArtifactProcessingNoticeContext): StructuredIntervention[] {
  return (context?.ownerInterventions ?? []).flatMap((owner) =>
    getStructuredOutputInterventions(owner.structuredOutput),
  )
}

function buildInterventionBadges(
  interventions: StructuredIntervention[],
  structuredOutput?: ArtifactStructuredOutputData,
  context?: ArtifactProcessingNoticeContext,
): Array<{ label: string; count: number; className: string }> {
  const counts = interventions.reduce<Record<StructuredInterventionCategory, number>>((acc, intervention) => {
    acc[intervention.category] = (acc[intervention.category] ?? 0) + 1
    return acc
  }, {
    parser_fix: 0,
    cleanup: 0,
    synthesized: 0,
    dropped: 0,
    attribution: 0,
    retry: 0,
  })

  return STRUCTURED_INTERVENTION_CATEGORY_ORDER
    .filter((category) => counts[category] > 0)
    .map((category) => {
      if (category === 'retry') {
        const retryAttemptCount = getContextRetryAttemptCount(context) || getStructuredRetryAttemptCount(structuredOutput)
        if (retryAttemptCount > 0) {
          return {
            label: 'Retries',
            count: retryAttemptCount,
            className: INTERVENTION_CATEGORY_COPY[category].className,
          }
        }
      }

      return {
        label: INTERVENTION_CATEGORY_COPY[category].label,
        count: counts[category],
        className: INTERVENTION_CATEGORY_COPY[category].className,
      }
    })
}

function buildInterventionSummary(interventions: StructuredIntervention[]): string {
  const interventionCount = interventions.length
  const categoryCount = new Set(interventions.map((intervention) => intervention.category)).size
  const labels = interventions
    .map((intervention) => intervention.rule?.label ?? INTERVENTION_CATEGORY_COPY[intervention.category].label)
    .filter((label, index, values) => values.indexOf(label) === index)
  const labelSummary = labels.length > 0
    ? `: ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? `, +${labels.length - 3} more` : ''}.`
    : '.'

  if (interventionCount === 1) {
    return `1 intervention${labelSummary}`
  }

  if (categoryCount <= 1) {
    return `${interventionCount} interventions${labelSummary}`
  }

  return `${interventionCount} interventions across ${categoryCount} categories${labelSummary}`
}

export function getStructuredOutputSourceMessages(structuredOutput?: ArtifactStructuredOutputData): string[] {
  if (!structuredOutput) return []

  const messages: string[] = []
  messages.push(...getStructuredOutputWarnings(structuredOutput))
  if (typeof structuredOutput.validationError === 'string' && structuredOutput.validationError.trim()) {
    messages.push(structuredOutput.validationError.trim())
  }
  for (const diagnostic of structuredOutput.retryDiagnostics ?? []) {
    if (typeof diagnostic.validationError === 'string' && diagnostic.validationError.trim()) {
      messages.push(diagnostic.validationError.trim())
    }
    if (typeof diagnostic.excerpt === 'string' && diagnostic.excerpt.trim()) {
      messages.push(`Retry attempt ${diagnostic.attempt} excerpt:\n${diagnostic.excerpt.trim()}`)
    }
  }

  const unique: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    if (seen.has(message)) continue
    seen.add(message)
    unique.push(message)
  }

  return unique
}

function isReusedApprovedInterviewFullAnswersContext(context?: ArtifactProcessingNoticeContext): boolean {
  return context?.fullAnswersOrigin === 'reused-approved-interview'
}

const ARTIFACT_STATUS_LABELS: Record<ArtifactProcessingStatus, string> = {
  timed_out: 'timed out',
  invalid_output: 'saved invalid output',
  failed: 'failed',
  stopped: 'stopped',
  pending: 'is still in progress',
  completed: 'validated',
}

function formatArtifactStatusLabel(status: ArtifactProcessingStatus): string {
  return isCouncilMemberOutcome(status) ? ARTIFACT_STATUS_LABELS[status] : 'validated'
}

function getArtifactProcessingStrings(kind: ArtifactProcessingKind, context?: ArtifactProcessingNoticeContext) {
  const affectedSuffix = context?.affectedCount ? ` across ${context.affectedCount} voter scorecard(s)` : ''

  switch (kind) {
    case 'diff':
      return {
        completedTitle: 'LoopTroop adjusted this diff.',
        nonCompletedTitle: 'Intervention details for this diff.',
        completedBody: 'LoopTroop validated this diff and recorded the intervention details below.',
        nonCompletedBody: (status: ArtifactProcessingStatus) => `LoopTroop recorded these intervention details before this diff ${formatArtifactStatusLabel(status)}.`,
      }
    case 'coverage':
      return {
        completedTitle: 'LoopTroop adjusted this coverage review.',
        nonCompletedTitle: 'Intervention details for this coverage review.',
        completedBody: 'LoopTroop validated this coverage review and recorded the intervention details below.',
        nonCompletedBody: (status: ArtifactProcessingStatus) => `LoopTroop recorded these intervention details before this coverage review ${formatArtifactStatusLabel(status)}.`,
      }
    case 'relevant-files':
      return {
        completedTitle: 'LoopTroop adjusted this relevant files scan.',
        nonCompletedTitle: 'Intervention details for this relevant files scan.',
        completedBody: 'LoopTroop validated this relevant files scan and recorded the intervention details below.',
        nonCompletedBody: (status: ArtifactProcessingStatus) => `LoopTroop recorded these intervention details before this relevant files scan ${formatArtifactStatusLabel(status)}.`,
      }
    case 'vote':
      return {
        completedTitle: 'LoopTroop adjusted this vote scorecard.',
        nonCompletedTitle: 'Intervention details for this vote scorecard.',
        completedBody: 'LoopTroop validated this vote scorecard and recorded the intervention details below.',
        nonCompletedBody: (status: ArtifactProcessingStatus) => `LoopTroop recorded these intervention details before this vote scorecard ${formatArtifactStatusLabel(status)}.`,
      }
    case 'vote-aggregate':
      return {
        completedTitle: 'LoopTroop adjusted some vote scorecards.',
        nonCompletedTitle: 'Intervention details for these vote scorecards.',
        completedBody: `LoopTroop validated one or more vote scorecards${affectedSuffix} and recorded the intervention details below.`,
        nonCompletedBody: (status: ArtifactProcessingStatus) => `LoopTroop recorded these intervention details before one or more vote scorecards${affectedSuffix} ${formatArtifactStatusLabel(status)}.`,
      }
    case 'draft':
      return {
        completedTitle: 'LoopTroop adjusted this draft.',
        nonCompletedTitle: 'Intervention details for this draft.',
        completedBody: 'LoopTroop validated this draft and recorded the intervention details below.',
        nonCompletedBody: (status: ArtifactProcessingStatus) => `LoopTroop recorded these intervention details before this draft ${formatArtifactStatusLabel(status)}.`,
      }
    case 'interview-draft':
      return {
        completedTitle: 'LoopTroop adjusted this interview draft.',
        nonCompletedTitle: 'Intervention details for this interview draft.',
        completedBody: 'LoopTroop validated this interview draft and recorded the intervention details below.',
        nonCompletedBody: (status: ArtifactProcessingStatus) => `LoopTroop recorded these intervention details before this interview draft ${formatArtifactStatusLabel(status)}.`,
      }
    case 'prd-draft':
      return {
        completedTitle: 'LoopTroop adjusted this PRD draft.',
        nonCompletedTitle: 'Intervention details for this PRD draft.',
        completedBody: 'LoopTroop validated this PRD draft and recorded the intervention details below.',
        nonCompletedBody: (status: ArtifactProcessingStatus) => `LoopTroop recorded these intervention details before this PRD draft ${formatArtifactStatusLabel(status)}.`,
      }
    case 'beads-draft':
      return {
        completedTitle: 'LoopTroop adjusted this blueprint draft.',
        nonCompletedTitle: 'Intervention details for this blueprint draft.',
        completedBody: 'LoopTroop validated this blueprint draft and recorded the intervention details below.',
        nonCompletedBody: (status: ArtifactProcessingStatus) => `LoopTroop recorded these intervention details before this blueprint draft ${formatArtifactStatusLabel(status)}.`,
      }
    case 'full-answers':
      return {
        completedTitle: isReusedApprovedInterviewFullAnswersContext(context)
          ? 'LoopTroop reused the approved interview for these answers.'
          : 'LoopTroop adjusted these Full Answers.',
        nonCompletedTitle: 'Intervention details for these Full Answers.',
        completedBody: isReusedApprovedInterviewFullAnswersContext(context)
          ? 'This ticket had no skipped interview questions, so Part 1 did not need a model response. To keep PRD drafting consistent across models, LoopTroop copied the approved interview into a Full Answers artifact for this model and only changed draft-only fields such as status, approval, or the model label.'
          : 'LoopTroop validated these Full Answers and recorded the intervention details below.',
        nonCompletedBody: (status: ArtifactProcessingStatus) => `LoopTroop recorded these intervention details before these Full Answers ${formatArtifactStatusLabel(status)}.`,
      }
    case 'final-test':
      return {
        completedTitle: 'LoopTroop adjusted this final test plan.',
        nonCompletedTitle: 'Intervention details for this final test plan.',
        completedBody: 'LoopTroop validated this final test plan and recorded the intervention details below.',
        nonCompletedBody: (status: ArtifactProcessingStatus) => `LoopTroop recorded these intervention details before this final test plan ${formatArtifactStatusLabel(status)}.`,
      }
    default:
      return {
        completedTitle: 'LoopTroop adjusted this artifact.',
        nonCompletedTitle: 'Intervention details for this artifact.',
        completedBody: 'LoopTroop validated this artifact and recorded the intervention details below.',
        nonCompletedBody: (status: ArtifactProcessingStatus) => `LoopTroop recorded these intervention details before this artifact ${formatArtifactStatusLabel(status)}.`,
      }
  }
}

export function buildArtifactProcessingNoticeCopy(
  structuredOutput?: ArtifactStructuredOutputData,
  kind: ArtifactProcessingKind = 'artifact',
  context?: ArtifactProcessingNoticeContext,
): ArtifactProcessingNoticeCopy | null {
  const interventions = getStructuredOutputInterventions(structuredOutput)
  if (interventions.length === 0) return null

  const strings = getArtifactProcessingStrings(kind, context)
  const status = context?.status ?? 'completed'
  const contextInterventions = getContextInterventions(context)
  const displayInterventions = contextInterventions.length > 0 ? contextInterventions : interventions
  const badges = buildInterventionBadges(displayInterventions, structuredOutput, context)

  return {
    title: status === 'completed' ? strings.completedTitle : strings.nonCompletedTitle,
    summary: buildInterventionSummary(displayInterventions),
    body: status === 'completed' ? strings.completedBody : strings.nonCompletedBody(status),
    badges,
    interventions,
  }
}
