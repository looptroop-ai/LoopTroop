import { buildCoverageSummaryText, getCoverageDisplayGaps } from './coverageSummary'
import { normalizeCoverageFollowUpArtifacts } from '../phaseArtifactTypes'
import { parseCoverageArtifact } from '../phaseArtifactTypes'
import type { CoverageArtifactData } from '../phaseArtifactTypes'
import { CollapsibleSection } from './CollapsibleSection'

export function CleanCoverageCallout({
  coverageResult,
  phase,
  fallbackCandidateVersion,
}: {
  coverageResult: CoverageArtifactData | null
  phase?: string
  fallbackCandidateVersion?: number
}) {
  const coverageStatus = coverageResult?.status ?? coverageResult?.parsed?.status
  if (coverageStatus !== 'clean' || !coverageResult) return null

  const finalCandidateVersion = coverageResult.finalCandidateVersion ?? fallbackCandidateVersion
  const summaryText = buildCoverageSummaryText(
    finalCandidateVersion && finalCandidateVersion !== coverageResult.finalCandidateVersion
      ? { ...coverageResult, finalCandidateVersion }
      : coverageResult,
    phase,
  )

  return (
    <div className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-900 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200">
      {summaryText}
    </div>
  )
}

export function CoverageResultView({
  content,
  header,
  phase,
  cleanStatusLabel,
  openGapsTitle,
}: {
  content: string
  header?: React.ReactNode
  phase?: string
  cleanStatusLabel?: string
  openGapsTitle?: string
}) {
  const coverageResult = parseCoverageArtifact(content)
  if (!coverageResult) {
    return (
      <div className="space-y-3">
        {header && <div className="flex items-center gap-2">{header}</div>}
        <div className="text-xs text-muted-foreground italic">Coverage result is still being generated.</div>
      </div>
    )
  }

  const isPrdCoverage = phase === 'VERIFYING_PRD_COVERAGE' || phase === 'WAITING_PRD_APPROVAL'
  const status = coverageResult.status ?? coverageResult.parsed?.status ?? (coverageResult.hasGaps ? 'gaps' : 'clean')
  const finalCandidateVersion = coverageResult.finalCandidateVersion ?? coverageResult.attempts?.[coverageResult.attempts.length - 1]?.candidateVersion
  const openGaps = getCoverageDisplayGaps(coverageResult)
  const hasOpenCoverageGaps = status === 'gaps'
    || coverageResult.hasGaps === true
    || coverageResult.hasRemainingGaps === true
    || openGaps.length > 0
  const followUpQuestions = isPrdCoverage
    ? []
    : normalizeCoverageFollowUpArtifacts(
        coverageResult.parsed?.followUpQuestions ?? coverageResult.parsed?.follow_up_questions,
      )
  const hasStructuredFollowUps = !isPrdCoverage && followUpQuestions.length > 0
  const summaryText = buildCoverageSummaryText(coverageResult, phase)
  const terminationSummary = coverageResult.terminationReason === 'coverage_pass_limit_reached'
    ? 'Retry cap reached; moving to approval with unresolved gaps.'
    : coverageResult.terminationReason === 'follow_up_budget_exhausted'
      ? 'Follow-up budget exhausted; moving to approval with unresolved gaps.'
      : coverageResult.terminationReason === 'follow_up_generation_failed'
        ? 'Follow-up questions could not be recovered; moving to approval with unresolved gaps.'
        : null
  return (
    <div className="space-y-4">
      {header && <div className="flex items-center gap-2">{header}</div>}

      <div className={`rounded-md border px-3 py-2 text-xs font-medium ${
        hasOpenCoverageGaps
          ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200'
          : 'border-green-300 bg-green-50 text-green-900 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200'
      }`}>
        {hasOpenCoverageGaps
          ? 'Coverage review found gaps'
          : finalCandidateVersion && finalCandidateVersion > 1
            ? cleanStatusLabel ?? 'No remaining coverage gaps found'
            : 'No coverage gaps found'}
      </div>

      <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        {summaryText}
      </div>

      {terminationSummary && (
        <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
          {terminationSummary}
        </div>
      )}

      {hasOpenCoverageGaps && openGaps.length > 0 && (
        <CollapsibleSection
          title={(
            <span className="flex items-center gap-2">
              <span>{openGapsTitle ?? 'Open Coverage Gaps'}</span>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {openGaps.length}
              </span>
            </span>
          )}
          defaultOpen
        >
          <div className="space-y-2">
            {openGaps.map((gap, index) => (
              <div
                key={`${gap}:${index}`}
                className="rounded-md border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs leading-5 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100"
              >
                {gap}
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {typeof coverageResult.followUpBudgetTotal === 'number' && (
        <div className="rounded-md border border-border bg-background px-3 py-2 text-[11px] text-muted-foreground">
          Follow-up budget: {coverageResult.followUpBudgetUsed ?? 0}/{coverageResult.followUpBudgetTotal} used
          {typeof coverageResult.followUpBudgetPercent === 'number' ? ` (${coverageResult.followUpBudgetPercent}%)` : ''}
          {typeof coverageResult.followUpBudgetRemaining === 'number' ? ` · ${coverageResult.followUpBudgetRemaining} remaining` : ''}
        </div>
      )}

      {hasStructuredFollowUps && (
        <div className="space-y-3">
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Suggested Follow-up Questions</div>
            <div className="space-y-2">
              {followUpQuestions.map((question, index) => (
                <div key={`${question.id ?? 'follow-up'}-${index}`} className="rounded-md border border-border bg-background px-3 py-2 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {question.id && <span className="font-mono text-[10px] text-muted-foreground">{question.id}</span>}
                    {question.phase && <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{question.phase}</span>}
                    {question.priority && <span className="text-[10px] text-blue-500">{question.priority}</span>}
                  </div>
                  <div className="text-xs font-medium">{question.question}</div>
                  {question.rationale && <div className="text-[10px] italic text-muted-foreground">{question.rationale}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
