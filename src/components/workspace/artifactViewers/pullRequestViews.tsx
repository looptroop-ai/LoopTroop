import { FileCode2 } from 'lucide-react'
import { WithRawTab } from './WithRawTab'
import { ExternalLink, GitPullRequest, CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { parsePullRequestReport } from '../phaseArtifactTypes'
import type {
  PullRequestCandidateFileAuditData,
  PullRequestCandidateFileAuditEntry,
  PullRequestReportData,
} from '../phaseArtifactTypes'
import { getSafeGitHubPullRequestUrl } from '@/lib/githubUrls'
import { RawContentWithCopy } from '../RawTextDisplay'
import { CollapsibleSection } from './CollapsibleSection'
import { ArtifactListSection, MetadataCard } from './MetadataCard'
import { formatArtifactTimestampLabel } from './artifactTimestamp'

interface PullRequestBodySection {
  title: string
  lines: string[]
}

function parsePullRequestBodySections(body: string): PullRequestBodySection[] {
  const sections: PullRequestBodySection[] = []
  let current: PullRequestBodySection | null = null

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    const heading = line.match(/^##\s+(.+)$/)
    if (heading?.[1]) {
      current = { title: heading[1].trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (!current) {
      if (!line) continue
      current = { title: 'Body', lines: [] }
      sections.push(current)
    }
    if (line) current.lines.push(line.replace(/^-\s+/, ''))
  }

  return sections
}

function PullRequestBodyPreview({ body }: { body: string }) {
  const sections = parsePullRequestBodySections(body)
  if (sections.length === 0) {
    return (
      <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        No pull request body was recorded.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <div key={section.title} className="rounded-md border border-border bg-background px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</div>
          {section.lines.length > 0 ? (
            <ul className="mt-2 space-y-1.5 text-xs text-foreground">
              {section.lines.map((line, index) => (
                <li key={`${section.title}:${index}`} className="flex gap-2 leading-5">
                  <span className="mt-2 h-1 w-1 rounded-full bg-muted-foreground/70 shrink-0" />
                  <span className="min-w-0 whitespace-pre-wrap break-words">{line}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-2 text-xs text-muted-foreground">No details recorded.</div>
          )}
        </div>
      ))}
    </div>
  )
}

function normalizeCandidateAuditDecisionLabel(decision: string): string {
  const normalized = decision.toLowerCase()
  if (normalized === 'include' || normalized === 'included') return 'Included'
  if (normalized === 'exclude' || normalized === 'excluded') return 'Excluded'
  if (normalized === 'ignore' || normalized === 'ignored') return 'Ignored'
  if (normalized === 'review' || normalized === 'reviewed') return 'Reviewed'
  return decision
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function isExcludedCandidateAuditEntry(entry: PullRequestCandidateFileAuditEntry): boolean {
  const normalized = entry.decision.toLowerCase()
  return normalized === 'exclude' || normalized === 'excluded' || normalized === 'ignore' || normalized === 'ignored'
}

function buildCandidateAuditEntriesForPaths(
  audit: PullRequestCandidateFileAuditData,
  paths: string[],
  fallbackDecision: string,
  predicate: (entry: PullRequestCandidateFileAuditEntry) => boolean,
): PullRequestCandidateFileAuditEntry[] {
  const byPath = new Map<string, PullRequestCandidateFileAuditEntry>()
  for (const entry of audit.entries) {
    if (predicate(entry) || paths.includes(entry.path)) {
      byPath.set(entry.path, entry)
    }
  }
  for (const path of paths) {
    if (!byPath.has(path)) byPath.set(path, { path, decision: fallbackDecision })
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path))
}

function CandidateAuditEntryList({
  entries,
  emptyLabel,
}: {
  entries: PullRequestCandidateFileAuditEntry[]
  emptyLabel: string
}) {
  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        {emptyLabel}
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {entries.map((entry) => (
        <div key={`${entry.decision}:${entry.path}`} className="rounded-md border border-border bg-background px-3 py-2">
          <div className="flex min-w-0 items-start gap-2">
            <FileCode2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 break-all font-mono text-[11px] font-semibold text-foreground">{entry.path}</span>
                <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {normalizeCandidateAuditDecisionLabel(entry.decision)}
                </span>
              </div>
              <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
                {entry.reason || 'No reason recorded.'}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function PullRequestCandidateFileAuditView({ audit }: { audit: PullRequestCandidateFileAuditData }) {
  const excludedEntries = buildCandidateAuditEntriesForPaths(
    audit,
    audit.excludedFiles,
    audit.ignoredFiles.length > 0 ? 'ignored' : 'exclude',
    isExcludedCandidateAuditEntry,
  )
  const includedCount = audit.stats?.includedFiles ?? audit.includedFiles.length
  const excludedCount = audit.stats?.excludedFiles ?? audit.excludedFiles.length
  const reviewedCount = audit.stats?.reviewedFiles ?? audit.reviewedFiles.length
  const totalCount = audit.stats?.totalFiles
    ?? new Set([...audit.includedFiles, ...audit.excludedFiles, ...audit.reviewedFiles]).size

  return (
    <CollapsibleSection
      title="Candidate File Audit"
      defaultOpen={excludedEntries.length > 0 || audit.warnings.length > 0}
    >
      <div className="space-y-3">
        {audit.message ? (
          <div className="rounded-md border border-border bg-background px-3 py-2 text-xs leading-5 text-muted-foreground">
            {audit.message}
          </div>
        ) : null}

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <MetadataCard label="Total Files" value={totalCount.toLocaleString()} />
          <MetadataCard label="Included" value={includedCount.toLocaleString()} tone={includedCount > 0 ? 'success' : 'default'} />
          <MetadataCard label="Excluded" value={excludedCount.toLocaleString()} tone={excludedCount > 0 ? 'warning' : 'default'} />
          <MetadataCard label="Reviewed" value={reviewedCount.toLocaleString()} tone={reviewedCount > 0 ? 'info' : 'default'} />
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Ignored / Excluded Files</div>
          <CandidateAuditEntryList
            entries={excludedEntries}
            emptyLabel="No ignored or excluded candidate files were recorded."
          />
        </div>

        {audit.warnings.length > 0 ? (
          <ArtifactListSection
            title="Audit Warnings"
            items={audit.warnings}
            emptyLabel="No audit warnings were recorded."
            tone="warning"
          />
        ) : null}
      </div>
    </CollapsibleSection>
  )
}

export function PullRequestReportView({ content }: { content: string }) {
  const parsed: PullRequestReportData | null = parsePullRequestReport(content)
  if (!parsed) {
    return <RawContentWithCopy content={content} />
  }

  const completedAtLabel = formatArtifactTimestampLabel(parsed.completedAt)
  const createdAtLabel = formatArtifactTimestampLabel(parsed.createdAt)
  const updatedAtLabel = formatArtifactTimestampLabel(parsed.updatedAt)
  const isPassed = parsed.status === 'passed'
  const isFailed = parsed.status === 'failed'
  const title = isPassed
    ? 'Draft pull request ready'
    : isFailed
      ? 'Pull request creation failed'
      : 'Pull request report'
  const message = parsed.message
    ?? (isPassed
      ? 'The candidate branch was pushed and the draft pull request metadata was recorded.'
      : 'Pull request metadata was recorded.')
  const safePrUrl = getSafeGitHubPullRequestUrl(parsed.prUrl)

  const metadataCards: Array<React.ReactNode> = []

  if (parsed.prNumber != null) {
    metadataCards.push(
      <MetadataCard key="pr-number" label="PR Number" value={`#${parsed.prNumber}`} hint="GitHub pull request number" tone="info" />,
    )
  }
  if (parsed.prState) {
    metadataCards.push(
      <MetadataCard key="pr-state" label="PR State" value={parsed.prState} hint="Current state when this report was recorded" tone={parsed.prState === 'draft' || parsed.prState === 'open' ? 'success' : 'default'} />,
    )
  }
  if (parsed.baseBranch) {
    metadataCards.push(
      <MetadataCard key="base-branch" label="Base Branch" value={parsed.baseBranch} mono hint="Target branch for the pull request" />,
    )
  }
  if (parsed.headBranch) {
    metadataCards.push(
      <MetadataCard key="head-branch" label="Head Branch" value={parsed.headBranch} mono hint="Ticket branch pushed to GitHub" />,
    )
  }
  if (parsed.candidateCommitSha) {
    metadataCards.push(
      <MetadataCard key="candidate-commit" label="Candidate Commit" value={parsed.candidateCommitSha} mono hint="Squashed candidate commit used for the PR" />,
    )
  }
  if (parsed.prHeadSha) {
    metadataCards.push(
      <MetadataCard key="pr-head" label="PR Head SHA" value={parsed.prHeadSha} mono hint="GitHub head SHA reported for the PR" />,
    )
  }

  const body = parsed.body ?? ''

  return (
    <WithRawTab
      content={content}
      structuredLabel="Report"
      header={<div className="text-xs font-semibold px-1">Pull Request Report</div>}
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
                : <GitPullRequest className="h-4 w-4 shrink-0 mt-0.5" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{title}</div>
              <div className="mt-1 text-xs leading-5">{message}</div>
              {completedAtLabel ? (
                <div className="mt-2 text-[11px] opacity-80">Completed at {completedAtLabel}</div>
              ) : null}
            </div>
          </div>
        </div>

        {safePrUrl ? (
          <a
            href={safePrUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-start gap-2 rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-blue-950 transition-colors hover:bg-blue-100 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-100 dark:hover:bg-blue-950/30"
          >
            <GitPullRequest className="h-4 w-4 shrink-0 mt-0.5" />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold">Open draft PR in GitHub</span>
              <span className="mt-1 block text-[11px] font-mono break-all">{safePrUrl}</span>
            </span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          </a>
        ) : parsed.prUrl ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
            Recorded pull request URL is not a valid GitHub PR link.
          </div>
        ) : (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
            No pull request URL was recorded yet.
          </div>
        )}

        {parsed.title ? (
          <div className="rounded-md border border-border bg-background px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">PR Title</div>
            <div className="mt-1 text-sm font-semibold text-foreground break-words">{parsed.title}</div>
          </div>
        ) : null}

        {metadataCards.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {metadataCards}
          </div>
        ) : null}

        {(createdAtLabel || updatedAtLabel || parsed.mergedAt || parsed.closedAt) ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {createdAtLabel ? <MetadataCard label="Created At" value={createdAtLabel} /> : null}
            {updatedAtLabel ? <MetadataCard label="Updated At" value={updatedAtLabel} /> : null}
            {parsed.mergedAt ? <MetadataCard label="Merged At" value={formatArtifactTimestampLabel(parsed.mergedAt)} tone="success" /> : null}
            {parsed.closedAt ? <MetadataCard label="Closed At" value={formatArtifactTimestampLabel(parsed.closedAt)} tone="warning" /> : null}
          </div>
        ) : null}

        {parsed.candidateFileAudit ? (
          <PullRequestCandidateFileAuditView audit={parsed.candidateFileAudit} />
        ) : null}

        <CollapsibleSection
          title="Generated PR Description"
          defaultOpen={Boolean(body)}
        >
          <PullRequestBodyPreview body={body} />
        </CollapsibleSection>
      </div>
    </WithRawTab>
  )
}
