import { WithRawTab } from './WithRawTab'
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { parseIntegrationReport } from '../phaseArtifactTypes'
import type { IntegrationReportData } from '../phaseArtifactTypes'
import { RawContentWithCopy } from '../RawTextDisplay'
import { MetadataCard } from './MetadataCard'
import { formatArtifactTimestampLabel } from './artifactTimestamp'

export function IntegrationReportView({ content }: { content: string }) {
  const parsed: IntegrationReportData | null = parseIntegrationReport(content)
  if (!parsed) {
    return <RawContentWithCopy content={content} />
  }

  const completedAtLabel = formatArtifactTimestampLabel(parsed.completedAt)
  const isPassed = parsed.status === 'passed'
  const isFailed = parsed.status === 'failed'
  const title = isPassed
    ? 'Integration candidate prepared'
    : isFailed
      ? 'Integration failed'
      : 'Integration report'
  const message = parsed.message
    ?? (isPassed
      ? 'Integration completed and the squashed candidate is ready for manual verification.'
      : 'Integration details were recorded.')

  const metadataCards: Array<React.ReactNode> = []

  if (parsed.baseBranch) {
    metadataCards.push(
      <MetadataCard key="base-branch" label="Base Branch" value={parsed.baseBranch} mono hint="Destination branch for verification merge" />,
    )
  }
  if (parsed.candidateCommitSha) {
    metadataCards.push(
      <MetadataCard key="candidate-commit" label="Candidate Commit" value={parsed.candidateCommitSha} mono hint="Squashed candidate commit ready for review" />,
    )
  }
  if (parsed.mergeBase) {
    metadataCards.push(
      <MetadataCard key="merge-base" label="Merge Base" value={parsed.mergeBase} mono hint="Common ancestor used for the squash" />,
    )
  }
  if (parsed.preSquashHead) {
    metadataCards.push(
      <MetadataCard key="pre-squash-head" label="Pre-Squash Head" value={parsed.preSquashHead} mono hint="Ticket branch head before creating the candidate commit" />,
    )
  }
  if (parsed.commitCount != null) {
    metadataCards.push(
      <MetadataCard
        key="commit-count"
        label="Squashed Commits"
        value={parsed.commitCount.toLocaleString()}
        hint={`${parsed.commitCount} commit${parsed.commitCount === 1 ? '' : 's'} consolidated into the candidate commit`}
        tone={parsed.commitCount > 0 ? 'info' : 'default'}
      />,
    )
  }

  return (
    <WithRawTab
      content={content}
      structuredLabel="Report"
      header={<div className="text-xs font-semibold px-1">Integration Report</div>}
    >
      <div className="space-y-4">
        <div className={cn(
          'rounded-md border px-3 py-3',
          isPassed
            ? 'border-green-300 bg-green-50 text-green-950 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-100'
            : isFailed
              ? 'border-red-300 bg-red-50 text-red-950 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-100'
              : 'border-border bg-background text-foreground',
        )}>
          <div className="flex items-start gap-2">
            {isPassed
              ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              : isFailed
                ? <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                : <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />}
            <div className="min-w-0">
              <div className="text-sm font-semibold">{title}</div>
              <div className="mt-1 text-xs leading-5">{message}</div>
              {completedAtLabel ? (
                <div className="mt-2 text-[11px] opacity-80">Completed at {completedAtLabel}</div>
              ) : null}
            </div>
          </div>
        </div>

        {metadataCards.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {metadataCards}
          </div>
        ) : null}

        {parsed.pushDeferred && parsed.pushed === false && !parsed.pushError ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-200">
            Remote ticket branch stays on the last bead backup until manual verification. Verifying rewrites it once to this squashed candidate.
          </div>
        ) : null}

        {parsed.pushError ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
            <div className="font-semibold">Remote update failed</div>
            <div className="mt-1 whitespace-pre-wrap break-words">{parsed.pushError}</div>
          </div>
        ) : null}
      </div>
    </WithRawTab>
  )
}
