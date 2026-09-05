import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import type { TicketArtifact } from '@/hooks/useTicketArtifacts'
import type { StructuredIntervention } from '@shared/structuredInterventions'
import type { StructuredRetryDiagnostic } from '@shared/structuredRetryDiagnostics'
import { extractInterviewQuestionPreviews } from '@shared/interviewQuestions'
import * as jsYaml from 'js-yaml'
import {
  findLatestArtifact,
  findLatestCompanionArtifact,
  mergeCoverageArtifactContent,
  mergeDraftArtifactContent,
  mergeVoteArtifactContent,
} from './artifactCompanionUtils'

export type CouncilAction = 'drafting' | 'scoring' | 'refining' | 'verifying' | 'working'
export type CouncilOutcome = 'pending' | 'completed' | 'timed_out' | 'invalid_output' | 'failed'

export interface CouncilViewerArtifact {
  id: string
  label: string
  description: string
  content: string
}

export interface CouncilMemberArtifactChip {
  key: string
  modelId: string
  action: CouncilAction
  outcome?: CouncilOutcome
  detail?: string
  isWinner?: boolean
  viewer: CouncilViewerArtifact
}

interface DraftLike {
  memberId: string
  content?: string
  outcome?: CouncilOutcome
  error?: string
  structuredOutput?: {
    repairApplied?: boolean
    repairWarnings?: string[]
    autoRetryCount?: number
    validationError?: string
    retryDiagnostics?: StructuredRetryDiagnostic[]
    interventions?: StructuredIntervention[]
  }
  questionCount?: number
  draftMetrics?: {
    questionCount?: number
    epicCount?: number
    userStoryCount?: number
    beadCount?: number
    totalTestCount?: number
    totalAcceptanceCriteriaCount?: number
  }
}

interface VoteLike {
  voterId: string
  draftId: string
  totalScore: number
}

interface CouncilResultLike {
  drafts?: DraftLike[]
  votes?: VoteLike[]
  winnerId?: string
  voterOutcomes?: Record<string, CouncilOutcome>
  memberOutcomes?: Record<string, CouncilOutcome>
  voterDetails?: Array<{
    voterId: string
    error?: string
    rawResponse?: string
    normalizedResponse?: string
    structuredOutput?: {
      repairApplied?: boolean
      repairWarnings?: string[]
      autoRetryCount?: number
      validationError?: string
      retryDiagnostics?: StructuredRetryDiagnostic[]
      interventions?: StructuredIntervention[]
    }
  }>
}

interface CoverageResultLike {
  winnerId?: string
  response?: string
  hasGaps?: boolean
  limitReached?: boolean
  terminationReason?: string
}

type Domain = 'interview' | 'prd' | 'beads'
type ArtifactSource = Pick<TicketArtifact, 'phase' | 'artifactType' | 'content'>
type NonSuccessOutcome = Extract<CouncilOutcome, 'invalid_output' | 'failed' | 'timed_out'>

export function getCouncilAction(phase: string): CouncilAction {
  if (phase.includes('DELIBERATING') || phase.includes('DRAFTING')) return 'drafting'
  if (phase.includes('VOTING')) return 'scoring'
  if (phase.includes('COMPILING') || phase.includes('REFINING')) return 'refining'
  if (phase.includes('VERIFYING')) return 'verifying'
  return 'working'
}

export function getCouncilStatusLabel(outcome?: CouncilOutcome, action?: CouncilAction): string {
  if (outcome === 'failed') return 'Failed'
  if (outcome === 'timed_out') return 'Timed Out'
  if (outcome === 'invalid_output') return 'Invalid Output'
  if (outcome === 'completed') return 'Finished'
  if (outcome === 'pending') {
    if (action === 'drafting') return 'Drafting'
    if (action === 'scoring') return 'Scoring'
    if (action === 'refining') return 'Refining'
    if (action === 'verifying') return 'Verifying'
  }
  if (action === 'drafting') return 'Drafting'
  if (action === 'scoring') return 'Scoring'
  if (action === 'refining') return 'Refining'
  if (action === 'verifying') return 'Verifying'
  return 'Working'
}

export function buildCouncilMemberArtifacts(
  phase: string,
  artifacts: TicketArtifact[],
  configuredMembers: string[],
  isCompleted: boolean,
  fallbackCount: number = 3,
): CouncilMemberArtifactChip[] {
  const action = getCouncilAction(phase)
  if (action === 'drafting') return buildDraftMemberArtifacts(phase, artifacts, configuredMembers, fallbackCount)
  if (action === 'scoring') return buildVotingMemberArtifacts(phase, artifacts, configuredMembers, fallbackCount)
  if (action === 'refining') return buildRefiningMemberArtifacts(phase, artifacts, configuredMembers, isCompleted, fallbackCount)
  if (action === 'verifying') return buildVerificationMemberArtifacts(phase, artifacts, isCompleted)
  return []
}

function mergeCouncilDraftLists(primaryDrafts: DraftLike[], fallbackDrafts: DraftLike[]): DraftLike[] {
  const orderedMemberIds = [
    ...primaryDrafts.map((draft) => draft.memberId),
    ...fallbackDrafts.map((draft) => draft.memberId),
  ].filter((memberId, index, values) => memberId && values.indexOf(memberId) === index)

  return orderedMemberIds.map((memberId) => {
    const primary = primaryDrafts.find((draft) => draft.memberId === memberId)
    const fallback = fallbackDrafts.find((draft) => draft.memberId === memberId)
    if (!primary) return fallback!
    if (!fallback) return primary

    const merged = {
      ...primary,
      content: primary.content?.trim() ? primary.content : fallback.content,
      outcome: primary.outcome === 'pending' && fallback.outcome && fallback.outcome !== 'pending'
        ? fallback.outcome
        : primary.outcome ?? fallback.outcome,
      error: primary.error ?? fallback.error,
      structuredOutput: primary.structuredOutput ?? fallback.structuredOutput,
      questionCount: primary.questionCount ?? fallback.questionCount,
      draftMetrics: primary.draftMetrics ?? fallback.draftMetrics,
    }
    return isFailedDraftOutcome(merged.outcome) ? { ...merged, content: undefined } : merged
  })
}

function isFailedDraftOutcome(outcome: CouncilOutcome | undefined): outcome is NonSuccessOutcome {
  return outcome === 'invalid_output' || outcome === 'failed' || outcome === 'timed_out'
}

function buildDraftMemberArtifacts(
  phase: string,
  artifacts: TicketArtifact[],
  configuredMembers: string[],
  fallbackCount: number,
): CouncilMemberArtifactChip[] {
  const domain = getPhaseDomain(phase)
  if (!domain) return []

  const draftArtifact = findLatestArtifact(artifacts, artifact => artifact.phase === phase && artifact.artifactType === `${domain}_drafts`)
  const draftCompanionArtifact = findLatestCompanionArtifact(artifacts, `${domain}_drafts`, [phase])
  const mergedDraftContent = mergeDraftArtifactContent(draftArtifact?.content, draftCompanionArtifact?.content)
  const draftResult = parseCouncilResult(mergedDraftContent)
  const drafts = Array.isArray(draftResult?.drafts) ? draftResult.drafts : []
  const draftByMember = new Map(drafts.map((draft) => [draft.memberId, draft]))
  const orderedMembers = getOrderedMembers(configuredMembers, drafts.map((draft) => draft.memberId), fallbackCount)
  const winnerId = parseWinnerIdFromArtifacts(domain, phase, artifacts)

  return orderedMembers.map((memberId) => {
    const draft = draftByMember.get(memberId)
    const viewer = makeDraftViewer(domain, memberId, mergedDraftContent ?? draftArtifact?.content ?? '')
    return {
      key: `${phase}:${memberId}`,
      modelId: memberId,
      action: 'drafting',
      outcome: draft?.outcome ?? 'pending',
      detail: getDraftDetail(domain, draft),
      isWinner: memberId === winnerId,
      viewer,
    }
  })
}

function buildVotingMemberArtifacts(
  phase: string,
  artifacts: TicketArtifact[],
  configuredMembers: string[],
  fallbackCount: number,
): CouncilMemberArtifactChip[] {
  const domain = getPhaseDomain(phase)
  if (!domain) return []

  const voteArtifact = findLatestArtifact(artifacts, artifact => artifact.phase === phase && artifact.artifactType === `${domain}_votes`)
  const voteCompanionArtifact = findLatestCompanionArtifact(artifacts, `${domain}_votes`, [phase])
  const draftArtifact = findLatestArtifact(artifacts, artifact => artifact.artifactType === `${domain}_drafts`)
  const draftCompanionArtifact = findLatestCompanionArtifact(artifacts, `${domain}_drafts`)
  const mergedDraftContent = mergeDraftArtifactContent(draftArtifact?.content, draftCompanionArtifact?.content)
  const mergedVoteContent = mergeVoteArtifactContent(voteArtifact?.content, voteCompanionArtifact?.content, mergedDraftContent)
  const voteResult = parseCouncilResult(mergedVoteContent)
  const voterOutcomes = voteResult?.voterOutcomes ?? {}
  const draftPhase = getDraftPhaseForVoting(phase)
  const failedDraftOutcomes = getDraftOutcomes(domain, artifacts, draftPhase)
  const orderedMembers = getOrderedMembers(
    configuredMembers,
    Object.keys(voterOutcomes).length > 0 ? Object.keys(voterOutcomes) : unique(voteResult?.votes?.map((vote) => vote.voterId) ?? []),
    fallbackCount,
  )
  const viewer = makeVotingViewer(domain, mergedVoteContent ?? voteArtifact?.content ?? '')

  return orderedMembers.map((memberId) => {
    const draftFailure = failedDraftOutcomes.get(memberId)
    if (draftFailure) {
      return {
        key: `${phase}:${memberId}`,
        modelId: memberId,
        action: 'scoring' as CouncilAction,
        outcome: draftFailure,
        detail: getDraftFailureVotingDetail(draftFailure),
        viewer,
      }
    }
    const outcome = voterOutcomes[memberId] ?? 'pending'
    const voteCount = (voteResult?.votes ?? []).filter((vote) => vote.voterId === memberId).length
    return {
      key: `${phase}:${memberId}`,
      modelId: memberId,
      action: 'scoring',
      outcome,
      detail: getVotingDetail(outcome, voteCount),
      viewer,
    }
  })
}

function buildRefiningMemberArtifacts(
  phase: string,
  artifacts: TicketArtifact[],
  configuredMembers: string[],
  isCompleted: boolean,
  fallbackCount: number,
): CouncilMemberArtifactChip[] {
  const domain = getPhaseDomain(phase)
  if (!domain) return []

  const votePhase = getVotePhaseForRefine(phase)
  const voteArtifact = findLatestArtifact(artifacts, artifact => artifact.phase === votePhase && artifact.artifactType === `${domain}_votes`)
  const voteCompanionArtifact = findLatestCompanionArtifact(artifacts, `${domain}_votes`, [votePhase])
  const draftArtifact = findLatestArtifact(artifacts, artifact => artifact.artifactType === `${domain}_drafts`)
  const draftCompanionArtifact = findLatestCompanionArtifact(artifacts, `${domain}_drafts`)
  const mergedDraftContent = mergeDraftArtifactContent(draftArtifact?.content, draftCompanionArtifact?.content)
  const draftResult = parseCouncilResult(mergedDraftContent)
  const mergedVoteContent = mergeVoteArtifactContent(voteArtifact?.content, voteCompanionArtifact?.content, mergedDraftContent)
  const voteResult = parseCouncilResult(mergedVoteContent)
  const voteDrafts = Array.isArray(voteResult?.drafts) ? voteResult.drafts : []
  const directDrafts = Array.isArray(draftResult?.drafts) ? draftResult.drafts : []
  const drafts = mergeCouncilDraftLists(voteDrafts, directDrafts)
  const orderedMembers = getOrderedMembers(configuredMembers, drafts.map((draft) => draft.memberId), fallbackCount)
  const refinedArtifact = findLatestArtifact(artifacts, artifact => artifact.phase === phase && artifact.artifactType === getRefinedArtifactType(domain))
  const refinedResult = parseCouncilResult(refinedArtifact?.content)
  const winnerId = voteResult?.winnerId
    ?? refinedResult?.winnerId
    ?? parseWinnerIdFromArtifacts(domain, phase, artifacts)
    ?? ''
  const shouldShowProposedDraft = phase === 'COMPILING_INTERVIEW' || phase === 'REFINING_PRD' || phase === 'REFINING_BEADS'

  return orderedMembers.map((memberId) => {
    const draft = drafts.find((d) => d.memberId === memberId)
    const isWinner = memberId === winnerId
    const viewer = shouldShowProposedDraft
      ? makeDraftViewer(domain, memberId, mergedVoteContent ?? voteArtifact?.content ?? '')
      : isWinner
        ? makeWinnerViewer(domain, phase, memberId, refinedArtifact?.content ?? voteArtifact?.content ?? '', refinedArtifact?.content ? true : false)
        : makeDraftViewer(domain, memberId, mergedVoteContent ?? voteArtifact?.content ?? '')
    const draftFailureOutcome = draft?.outcome === 'invalid_output' || draft?.outcome === 'failed' || draft?.outcome === 'timed_out'
      ? draft.outcome as NonSuccessOutcome
      : undefined
    const detail = draftFailureOutcome && !isWinner
      ? getDraftFailureVotingDetail(draftFailureOutcome)
      : shouldShowProposedDraft
        ? getDraftDetail(domain, draft)
        : isWinner
          ? 'Winner — refining draft'
          : getDraftCompletionDetail(domain, draft)

    return {
      key: `${phase}:${memberId}`,
      modelId: memberId,
      action: isWinner && !isCompleted ? 'refining' : 'working',
      outcome: isWinner && !isCompleted
        ? 'pending'
        : (!isWinner && draftFailureOutcome)
          ? draftFailureOutcome
          : 'completed',
      detail,
      isWinner,
      viewer,
    }
  })
}

function buildVerificationMemberArtifacts(
  phase: string,
  artifacts: TicketArtifact[],
  isCompleted: boolean,
): CouncilMemberArtifactChip[] {
  const domain = getPhaseDomain(phase)
  if (!domain) return []

  const coverageArtifact = findLatestArtifact(artifacts, artifact => artifact.phase === phase && artifact.artifactType === `${domain}_coverage`)
  const coverageCompanionArtifact = findLatestCompanionArtifact(artifacts, `${domain}_coverage`, [phase])
  const mergedCoverageContent = mergeCoverageArtifactContent(coverageArtifact?.content, coverageCompanionArtifact?.content)
  const coverageResult = parseCoverageResult(mergedCoverageContent)
  const winnerId = coverageResult?.winnerId
    ?? parseWinnerIdFromArtifacts(domain, phase, artifacts)

  if (!winnerId) return []

  const coverageComplete = isCompleted || Boolean(coverageArtifact?.content)
  return [{
    key: `${phase}:${winnerId}`,
    modelId: winnerId,
    action: coverageComplete ? 'working' : 'verifying',
    outcome: coverageComplete ? 'completed' : 'pending',
    detail: getCoverageDetail(coverageResult),
    isWinner: true,
    viewer: makeCoverageViewer(domain, mergedCoverageContent ?? coverageArtifact?.content ?? ''),
  }]
}

export function buildFullAnswerMemberArtifacts(
  phase: string,
  artifacts: TicketArtifact[],
  configuredMembers: string[],
  fallbackCount: number = 3,
): CouncilMemberArtifactChip[] {
  if (phase !== 'DRAFTING_PRD') return []

  const fullAnswersArtifact = findLatestArtifact(artifacts, (a) => a.phase === phase && a.artifactType === 'prd_full_answers')
  const fullAnswersCompanionArtifact = findLatestCompanionArtifact(artifacts, 'prd_full_answers', [phase])
  const mergedFullAnswersContent = mergeDraftArtifactContent(fullAnswersArtifact?.content, fullAnswersCompanionArtifact?.content)
  const result = parseCouncilResult(mergedFullAnswersContent)
  const drafts = Array.isArray(result?.drafts) ? result.drafts : []
  const draftByMember = new Map(drafts.map((d) => [d.memberId, d]))
  const orderedMembers = getOrderedMembers(configuredMembers, drafts.map((d) => d.memberId), fallbackCount)

  return orderedMembers.map((memberId) => {
    const draft = draftByMember.get(memberId)
    const viewer = makeFullAnswersViewer(memberId, mergedFullAnswersContent ?? fullAnswersArtifact?.content ?? '')
    return {
      key: `${phase}:fullanswers:${memberId}`,
      modelId: memberId,
      action: 'drafting' as CouncilAction,
      outcome: draft?.outcome ?? 'pending',
      detail: getFullAnswersDetail(draft),
      viewer,
    }
  })
}

function makeFullAnswersViewer(modelId: string, content: string): CouncilViewerArtifact {
  const safe = encodeURIComponent(modelId)
  return {
    id: `prd-fullanswers-member-${safe}`,
    label: `Full Answers — ${getModelDisplayName(modelId)}`,
    description: 'Interview results with skipped answers filled in',
    content,
  }
}

function getFullAnswersDetail(draft: DraftLike | undefined): string {
  if (!draft) return 'waiting for response'
  if (draft.outcome === 'pending') return 'filling in answers'
  if (draft.outcome === 'timed_out') return 'no response received'
  if (draft.outcome === 'failed') return draft.error || 'runtime failure'
  if (draft.outcome === 'invalid_output') return draft.error || 'malformed response'
  if (!draft.content) return ''
  const count = typeof draft.questionCount === 'number'
    ? draft.questionCount
    : typeof draft.draftMetrics?.questionCount === 'number'
      ? draft.draftMetrics.questionCount
      : countQuestionsInContent(draft.content)
  return count > 0 ? `${count} answers` : ''
}

function formatPrdDraftMetrics(draft: DraftLike): string | null {
  const epicCount = draft.draftMetrics?.epicCount
  const userStoryCount = draft.draftMetrics?.userStoryCount

  if (typeof epicCount !== 'number' && typeof userStoryCount !== 'number') {
    return null
  }

  return [
    `${epicCount ?? 0} epics`,
    `${userStoryCount ?? 0} user stories`,
  ].join(' · ')
}

function formatBeadsDraftMetrics(draft: DraftLike): string | null {
  const beadCount = draft.draftMetrics?.beadCount
  const totalTestCount = draft.draftMetrics?.totalTestCount
  const totalAcceptanceCriteriaCount = draft.draftMetrics?.totalAcceptanceCriteriaCount

  if (typeof beadCount !== 'number' && typeof totalTestCount !== 'number' && typeof totalAcceptanceCriteriaCount !== 'number') {
    return null
  }

  const parts: string[] = []
  if (typeof beadCount === 'number') parts.push(`${beadCount} beads`)
  if (typeof totalTestCount === 'number') parts.push(`${totalTestCount} tests`)
  if (typeof totalAcceptanceCriteriaCount === 'number') parts.push(`${totalAcceptanceCriteriaCount} criteria`)
  return parts.join(' · ')
}

function getDraftDetail(domain: Domain, draft: DraftLike | undefined): string {
  if (!draft) return 'waiting for response'
  if (draft.outcome === 'pending') return 'waiting for response'
  if (draft.outcome === 'timed_out') return 'no response received'
  if (draft.outcome === 'failed') return draft.error || 'runtime failure'
  if (draft.outcome === 'invalid_output') {
    // Still try to show useful detail if content exists
    if (draft.content) {
      const detail = getDraftCompletionDetail(domain, draft)
      if (detail) return detail
    }
    return draft.error || 'malformed response'
  }
  return getDraftCompletionDetail(domain, draft)
}

function getDraftCompletionDetail(domain: Domain, draft: DraftLike | undefined): string {
  if (!draft?.content) return ''
  if (domain === 'prd') {
    const metricsLabel = formatPrdDraftMetrics(draft)
    if (metricsLabel) return metricsLabel
  }
  if (domain === 'beads') {
    const metricsLabel = formatBeadsDraftMetrics(draft)
    if (metricsLabel) return metricsLabel
    const beadCount = countBeadsInContent(draft.content)
    if (beadCount > 0) return `${beadCount} beads`
  }
  const questionCount = typeof draft.questionCount === 'number'
    ? draft.questionCount
    : typeof draft.draftMetrics?.questionCount === 'number'
      ? draft.draftMetrics.questionCount
    : countQuestionsInContent(draft.content)
  if (questionCount > 0) return `proposed ${questionCount} questions`
  const lineCount = draft.content.split('\n').filter((line) => line.trim()).length
  return lineCount > 0 ? `${lineCount} lines generated` : ''
}

function getVotingDetail(outcome: CouncilOutcome, voteCount: number): string {
  if (outcome === 'completed') return voteCount > 0 ? `scored ${voteCount} drafts` : 'scoring complete'
  if (outcome === 'timed_out') return 'vote timed out'
  if (outcome === 'failed') return 'vote failed'
  if (outcome === 'invalid_output') return 'malformed scores'
  return 'waiting for scores'
}

function getDraftFailureVotingDetail(outcome: NonSuccessOutcome): string {
  if (outcome === 'invalid_output') return 'draft had invalid output'
  if (outcome === 'timed_out') return 'draft timed out'
  return 'draft failed'
}

function getCoverageDetail(result: CoverageResultLike | null): string {
  if (!result) return 'waiting for review'
  if (result.hasGaps === true) {
    if (result.terminationReason === 'coverage_pass_limit_reached') return 'gaps found; retry cap reached'
    if (result.terminationReason === 'follow_up_budget_exhausted') return 'gaps found; follow-up budget exhausted'
    if (result.terminationReason === 'follow_up_generation_failed') return 'gaps found; manual review required'
    return 'gaps found'
  }
  if (result.hasGaps === false) return 'no gaps found'
  return 'review available'
}

function makeDraftViewer(domain: Domain, modelId: string, content: string): CouncilViewerArtifact {
  return {
    id: getDraftArtifactId(domain, modelId),
    label: `${getDomainLabel(domain)} Draft — ${getModelDisplayName(modelId)}`,
    description: getDraftDescription(domain),
    content,
  }
}

function makeVotingViewer(domain: Domain, content: string): CouncilViewerArtifact {
  return {
    id: getVotesArtifactId(domain),
    label: `${getDomainLabel(domain)} Voting Results`,
    description: 'Weighted scoring results',
    content,
  }
}

function makeWinnerViewer(
  domain: Domain,
  phase: string,
  modelId: string,
  content: string,
  hasRefinedArtifact: boolean,
): CouncilViewerArtifact {
  if (!hasRefinedArtifact) return makeDraftViewer(domain, modelId, content)
  if (phase === 'COMPILING_INTERVIEW') {
    return {
      id: 'final-interview',
      label: 'Final Interview Questions',
      description: 'Compiled question set',
      content,
    }
  }
  if (domain === 'prd') {
    return {
      id: 'refined-prd',
      label: 'PRD Candidate v1',
      description: 'Initial PRD candidate consolidated from the winning draft',
      content,
    }
  }
  return {
    id: 'refined-beads',
    label: 'Refined Beads',
    description: 'Winning beads with improvements',
    content,
  }
}

function makeCoverageViewer(domain: Domain, content: string): CouncilViewerArtifact {
  return {
    id: `${domain}-coverage-result`,
    label: `${getDomainLabel(domain)} Coverage Review`,
    description: 'Coverage review of the current candidate by the winning model',
    content,
  }
}

function parseWinnerIdFromArtifacts(domain: Domain, phase: string, artifacts: ArtifactSource[]): string | undefined {
  const coverageArtifact = findLatestArtifact(artifacts, artifact => artifact.phase === phase && artifact.artifactType === `${domain}_coverage`)
  const coverageWinner = parseCoverageResult(coverageArtifact?.content)?.winnerId
  if (coverageWinner) return coverageWinner

  const refinedArtifact = findLatestArtifact(artifacts, artifact => artifact.artifactType === getRefinedArtifactType(domain))
  const refinedWinner = parseCouncilResult(refinedArtifact?.content)?.winnerId
  if (refinedWinner) return refinedWinner

  const winnerArtifactType = domain === 'interview' ? 'interview_winner' : `${domain}_winner`
  const winnerArtifact = findLatestArtifact(artifacts, artifact => artifact.artifactType === winnerArtifactType)
  if (winnerArtifact?.content) {
    try {
      const parsed = JSON.parse(winnerArtifact.content) as { winnerId?: string }
      if (parsed.winnerId) return parsed.winnerId
    } catch {
      // fall through to votes lookup
    }
  }

  const votesArtifactType = `${domain}_votes`
  const votesArtifact = findLatestArtifact(artifacts, artifact => artifact.artifactType === votesArtifactType)
  if (!votesArtifact?.content) return undefined
  try {
    const parsed = JSON.parse(votesArtifact.content) as { winnerId?: string }
    return parsed.winnerId
  } catch {
    return undefined
  }
}

function parseCouncilResult(content: string | null | undefined): CouncilResultLike | null {
  if (!content) return null
  try {
    const parsed = JSON.parse(content) as CouncilResultLike
    if (parsed.drafts || parsed.votes || parsed.voterOutcomes || parsed.winnerId) return parsed
  } catch {
    return null
  }
  return null
}

function parseCoverageResult(content: string | null | undefined): CoverageResultLike | null {
  if (!content) return null
  try {
    const parsed = JSON.parse(content) as unknown
    if (parsed && typeof parsed === 'object') {
      const result = parsed as CoverageResultLike
      if ('response' in result || 'hasGaps' in result || 'winnerId' in result) return result
    }
  } catch {
    return null
  }
  return null
}

function getOrderedMembers(configuredMembers: string[], discoveredMembers: string[], fallbackCount: number): string[] {
  if (configuredMembers.length > 0) return configuredMembers
  if (discoveredMembers.length > 0) return unique(discoveredMembers)
  return Array.from({ length: fallbackCount }, (_, index) => `Model ${index + 1}`)
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function getPhaseDomain(phase: string): Domain | null {
  if (phase.includes('INTERVIEW') || phase === 'COUNCIL_DELIBERATING' || phase === 'COMPILING_INTERVIEW') return 'interview'
  if (phase.includes('PRD')) return 'prd'
  if (phase.includes('BEADS')) return 'beads'
  return null
}

function getDomainLabel(domain: Domain): string {
  if (domain === 'interview') return 'Interview'
  if (domain === 'prd') return 'PRD'
  return 'Beads'
}

function getDraftDescription(domain: Domain): string {
  if (domain === 'interview') return 'Model-proposed interview questions'
  if (domain === 'prd') return 'Model-proposed product requirements draft'
  return 'Model-proposed implementation breakdown'
}

function getDraftArtifactId(domain: Domain, memberId: string): string {
  const safe = encodeURIComponent(memberId)
  if (domain === 'interview') return `draft-member-${safe}`
  if (domain === 'prd') return `prd-draft-member-${safe}`
  return `beads-draft-member-${safe}`
}

function getVotesArtifactId(domain: Domain): string {
  if (domain === 'interview') return 'votes'
  if (domain === 'prd') return 'prd-votes'
  return 'beads-votes'
}

function getVotePhaseForRefine(phase: string): string {
  if (phase === 'COMPILING_INTERVIEW') return 'COUNCIL_VOTING_INTERVIEW'
  if (phase === 'REFINING_PRD') return 'COUNCIL_VOTING_PRD'
  return 'COUNCIL_VOTING_BEADS'
}

function getDraftPhaseForVoting(phase: string): string {
  if (phase === 'COUNCIL_VOTING_INTERVIEW') return 'COUNCIL_DELIBERATING'
  if (phase === 'COUNCIL_VOTING_PRD') return 'DRAFTING_PRD'
  return 'DRAFTING_BEADS'
}

function getDraftOutcomes(domain: Domain, artifacts: ArtifactSource[], draftPhase: string): Map<string, NonSuccessOutcome> {
  const draftArtifact = findLatestArtifact(artifacts, a => a.phase === draftPhase && a.artifactType === `${domain}_drafts`)
  const draftCompanion = findLatestCompanionArtifact(artifacts, `${domain}_drafts`, [draftPhase])
  const mergedContent = mergeDraftArtifactContent(draftArtifact?.content, draftCompanion?.content)
  const result = parseCouncilResult(mergedContent)
  const outcomes = new Map<string, NonSuccessOutcome>()
  for (const draft of result?.drafts ?? []) {
    if (draft.outcome === 'invalid_output' || draft.outcome === 'failed' || draft.outcome === 'timed_out') {
      outcomes.set(draft.memberId, draft.outcome)
    }
  }
  return outcomes
}

function getRefinedArtifactType(domain: Domain): string {
  if (domain === 'interview') return 'interview_compiled'
  if (domain === 'prd') return 'prd_refined'
  return 'beads_refined'
}

function countQuestionsInContent(content: string): number {
  const parsedQuestions = extractInterviewQuestionPreviews(content)
  if (parsedQuestions.length > 0) return parsedQuestions.length

  // Try YAML parse first
  try {
    // Use simple JSON parse attempt (council artifacts store YAML-like JSON)
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.questions)) return parsed.questions.length
      if (Array.isArray(parsed)) return parsed.length
    }
  } catch {
    // Not JSON, try line-based counting
  }

  // Count structured list items (numbered or bulleted) that look like questions
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean)
  let count = 0
  for (const line of lines) {
    // Numbered items: "1.", "1)", "Q1:", etc.
    if (/^\d+[.)]\s/.test(line) || /^Q\d+/i.test(line)) {
      count++
      continue
    }
    // Bulleted items with substantial content (not headers/metadata)
    if (/^[-*]\s/.test(line) && line.length > 15) {
      count++
      continue
    }
    // Lines ending with ?
    if (line.endsWith('?')) {
      count++
    }
  }
  return count
}

function countBeadsInContent(content: string): number {
  const trimmed = content.trim()
  if (!trimmed) return 0

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) return parsed.length
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { beads?: unknown[] }).beads)) {
      return (parsed as { beads: unknown[] }).beads.length
    }
  } catch {
    // Ignore and fall back to YAML or line-based parsing.
  }

  try {
    const parsed = jsYaml.load(trimmed) as unknown
    if (Array.isArray(parsed)) return parsed.length
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { beads?: unknown[] }).beads)) {
      return (parsed as { beads: unknown[] }).beads.length
    }
  } catch {
    // Ignore and fall back to JSONL or line-based parsing.
  }

  if (trimmed.startsWith('{')) {
    try {
      return trimmed
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
        .length
    } catch {
      // Ignore malformed JSONL and fall back to line-based counting.
    }
  }

  return (content.match(/^\s*-\s+id\s*:/gm) ?? []).length
}
