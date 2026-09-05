import type { TicketArtifact } from '@/hooks/useTicketArtifacts'
import { findLatestArtifactByType, findLatestCompanionArtifact } from './artifactCompanionUtils'
import { buildCoverageArtifactContent, parseCoverageArtifact } from './phaseArtifactTypes'

export interface CoverageApprovalWarningData {
  candidateLabel: string
  summary: string
  gaps: string[]
  latestExtraFixSummary?: string | null
  extraFixCount: number
}

function getCoverageCandidateLabel(domain: 'prd' | 'beads', version?: number): string {
  if (domain === 'prd') {
    return version ? `PRD Candidate v${version}` : 'current PRD candidate'
  }
  return version ? `Implementation Plan v${version}` : 'current implementation plan'
}

export function resolveCoverageApprovalWarning(
  artifacts: TicketArtifact[],
  domain: 'prd' | 'beads',
): CoverageApprovalWarningData | null {
  const coveragePhase = domain === 'prd'
    ? ['VERIFYING_PRD_COVERAGE', 'WAITING_PRD_APPROVAL']
    : ['VERIFYING_BEADS_COVERAGE', 'WAITING_BEADS_APPROVAL']
  const coverageArtifactType = `${domain}_coverage`
  const coverageArtifact = findLatestArtifactByType(artifacts, coverageArtifactType, coveragePhase)
  const coverageCompanionArtifact = findLatestCompanionArtifact(artifacts, coverageArtifactType, coveragePhase)
  const mergedCoverageContent = buildCoverageArtifactContent(coverageArtifact?.content, coverageCompanionArtifact?.content)
  if (!mergedCoverageContent) return null

  const parsed = parseCoverageArtifact(mergedCoverageContent)
  if (!parsed) return null

  const status = parsed.status ?? parsed.parsed?.status ?? (parsed.hasGaps ? 'gaps' : 'clean')
  const gaps = parsed.remainingGaps?.length
    ? parsed.remainingGaps
    : parsed.gaps ?? parsed.parsed?.gaps ?? []
  const hasRemainingGaps = parsed.hasRemainingGaps ?? (status === 'gaps' || gaps.length > 0)
  if (!hasRemainingGaps) return null

  const finalCandidateVersion = parsed.finalCandidateVersion ?? parsed.attempts?.[parsed.attempts.length - 1]?.candidateVersion
  const candidateLabel = getCoverageCandidateLabel(domain, finalCandidateVersion)
  const extraFixTransitions = parsed.transitions?.filter((transition) => transition.source === 'ai_fix_button') ?? []
  const latestExtraFix = [...extraFixTransitions].reverse()[0]

  return {
    candidateLabel,
    summary: parsed.summary?.trim() || `Coverage carried ${candidateLabel} forward with unresolved gaps.`,
    gaps,
    latestExtraFixSummary: parsed.latestExtraFixSummary ?? latestExtraFix?.summary ?? null,
    extraFixCount: extraFixTransitions.length,
  }
}
