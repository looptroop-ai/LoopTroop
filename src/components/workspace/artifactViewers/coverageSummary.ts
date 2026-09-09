import type { CoverageArtifactData } from '../phaseArtifactTypes'

/** Wording and gap lists for the coverage views. */

export function getCoverageCandidateLabel(phase?: string, candidateVersion?: number): string {
  if (phase === 'VERIFYING_PRD_COVERAGE' || phase === 'WAITING_PRD_APPROVAL') {
    return candidateVersion ? `PRD Candidate v${candidateVersion}` : 'current PRD candidate'
  }
  if (phase === 'VERIFYING_BEADS_COVERAGE' || phase === 'EXPANDING_BEADS' || phase === 'WAITING_BEADS_APPROVAL') {
    return candidateVersion ? `Implementation Plan v${candidateVersion}` : 'current implementation plan'
  }
  if (phase === 'VERIFYING_INTERVIEW_COVERAGE' || phase === 'WAITING_INTERVIEW_APPROVAL') {
    return 'compiled interview'
  }
  return 'current draft'
}

export function getCoverageReviewedAgainst(phase?: string): string {
  if (phase === 'VERIFYING_PRD_COVERAGE' || phase === 'WAITING_PRD_APPROVAL') return 'winner Full Answers'
  if (phase === 'VERIFYING_BEADS_COVERAGE' || phase === 'EXPANDING_BEADS' || phase === 'WAITING_BEADS_APPROVAL') return 'approved PRD'
  if (phase === 'VERIFYING_INTERVIEW_COVERAGE' || phase === 'WAITING_INTERVIEW_APPROVAL') return 'submitted answers'
  return 'source material'
}

export function buildCoverageSummaryText(coverageResult: CoverageArtifactData, phase?: string): string {
  if (coverageResult.summary?.trim()) {
    return coverageResult.summary
  }

  const status = coverageResult.status ?? coverageResult.parsed?.status ?? (coverageResult.hasGaps ? 'gaps' : 'clean')
  const finalCandidateVersion = coverageResult.finalCandidateVersion ?? coverageResult.attempts?.[coverageResult.attempts.length - 1]?.candidateVersion
  const gaps = getCoverageDisplayGaps(coverageResult)
  const reviewedArtifact = getCoverageCandidateLabel(phase, finalCandidateVersion)
  const reviewedAgainst = getCoverageReviewedAgainst(phase)
  const isVerifyPrdCoverage = phase === 'VERIFYING_PRD_COVERAGE'

  return status === 'gaps'
    ? gaps.length > 0
      ? `This ${isVerifyPrdCoverage ? 'check' : 'pass'} found ${gaps.length === 1 ? '1 gap' : `${gaps.length} gaps`} between the ${reviewedArtifact} and the ${reviewedAgainst}.`
      : `This ${isVerifyPrdCoverage ? 'check' : 'pass'} found coverage gaps between the ${reviewedArtifact} and the ${reviewedAgainst}.`
    : `The ${reviewedArtifact} covers the ${reviewedAgainst}. No gaps were ${isVerifyPrdCoverage ? 'found in this check' : 'flagged in this pass'}.`
}

export function normalizeCoverageGapList(gaps: string[] | undefined): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const gap of gaps ?? []) {
    const trimmed = gap.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

export function getCoverageDisplayGaps(coverageResult: CoverageArtifactData): string[] {
  if (Array.isArray(coverageResult.remainingGaps)) {
    return normalizeCoverageGapList(coverageResult.remainingGaps)
  }

  const directGaps = [
    coverageResult.gaps,
    coverageResult.parsed?.gaps,
  ]

  for (const gaps of directGaps) {
    const normalized = normalizeCoverageGapList(gaps)
    if (normalized.length > 0) return normalized
  }

  const latestGapAttempt = coverageResult.attempts
    ?.slice()
    .reverse()
    .find((attempt) => attempt.status === 'gaps' && attempt.gaps.length > 0)

  return normalizeCoverageGapList(latestGapAttempt?.gaps)
}
