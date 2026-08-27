import { useMemo, useState } from 'react'
import { GitBranch, GitCommitHorizontal, CheckCircle2, XCircle, FlaskConical, Blocks, AlertTriangle, ExternalLink, GitPullRequest } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingText } from '@/components/ui/LoadingText'
import { Badge } from '@/components/ui/badge'
import { useTicketArtifacts } from '@/hooks/useTicketArtifacts'
import { getArtifactTargetPhases, parseIntegrationReport } from './phaseArtifactTypes'
import type { Ticket } from '@/hooks/useTickets'
import { cn } from '@/lib/utils'
import { getSafeGitHubPullRequestUrl } from '@/lib/githubUrls'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SkipReasonField } from './SkipReasonField'

interface VerificationSummaryPanelProps {
  ticket: Ticket
  onMerge: () => void
  onCloseUnmerged: (reason?: string) => void
  isPending: boolean
}

interface FinalTestReport {
  passed?: boolean
  status?: string
  attempt?: number
  commands?: Array<{ command: string; exitCode?: number | null; timedOut?: boolean }>
  errors?: string[]
  testFiles?: string[]
  summary?: string
}

function tryParseJson<T>(content: string | null | undefined): T | null {
  if (!content) return null
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function shortSha(sha: string | null | undefined): string {
  if (!sha) return '—'
  return sha.slice(0, 8)
}

export function VerificationSummaryPanel({ ticket, onMerge, onCloseUnmerged, isPending }: VerificationSummaryPanelProps) {
  const { artifacts: loadedArtifacts } = useTicketArtifacts(ticket.id)
  const artifacts = useMemo(() => loadedArtifacts ?? [], [loadedArtifacts])
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false)
  const [closeReason, setCloseReason] = useState('')
  const targetPhases = useMemo(() => getArtifactTargetPhases('WAITING_PR_REVIEW'), [])

  const integrationReport = useMemo(() => {
    const artifact = [...artifacts]
      .reverse()
      .find(a => targetPhases.includes(a.phase) && a.artifactType === 'integration_report')
    return artifact?.content ? parseIntegrationReport(artifact.content) : null
  }, [artifacts, targetPhases])

  const finalTestReport = useMemo(() => {
    const artifact = [...artifacts]
      .reverse()
      .find(a => targetPhases.includes(a.phase) && a.artifactType === 'final_test_report')
    return tryParseJson<FinalTestReport>(artifact?.content)
  }, [artifacts, targetPhases])

  const runtime = ticket.runtime
  const testsPassed = runtime.finalTestStatus === 'passed'
    || finalTestReport?.passed === true
    || finalTestReport?.status === 'passed'
  const testsFailed = runtime.finalTestStatus === 'failed'
    || finalTestReport?.passed === false
    || finalTestReport?.status === 'failed'
  const commitSha = runtime.candidateCommitSha ?? integrationReport?.candidateCommitSha
  const branchName = ticket.branchName ?? ticket.externalId
  const baseBranch = runtime.baseBranch ?? integrationReport?.baseBranch ?? 'main'
  const prUrl = getSafeGitHubPullRequestUrl(runtime.prUrl)
  const prState = runtime.prState
  const commitCount = integrationReport?.commitCount
  const testAttempts = finalTestReport?.attempt
  const testCommandCount = finalTestReport?.commands?.length

  return (
    <div className="border-b border-border shrink-0" data-testid="verification-summary-panel">
      <Dialog open={isCloseConfirmOpen} onOpenChange={setIsCloseConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Finish Without Merging?</DialogTitle>
            <DialogDescription>
              The pull request and the remote branch are left exactly as they are. The ticket moves to
              cleanup and stops here, and nothing about this work reaches {baseBranch}.
            </DialogDescription>
          </DialogHeader>
          <SkipReasonField
            label="Why finish without merging"
            value={closeReason}
            onChange={setCloseReason}
            disabled={isPending}
            help="Saved with the merge report. It is the only record of why this branch stopped."
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setIsCloseConfirmOpen(false)} disabled={isPending}>
              Keep Reviewing
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={isPending}
              onClick={() => {
                onCloseUnmerged(closeReason.trim() || undefined)
                setIsCloseConfirmOpen(false)
                setCloseReason('')
              }}
            >
              Finish Without Merge
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Header */}
      <div className="px-4 py-3 bg-amber-50/60 dark:bg-amber-950/20">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <span className="text-sm font-semibold">Draft PR Review Required</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsCloseConfirmOpen(true)}
              disabled={isPending}
              className="text-xs"
            >
              Finish Without Merge
            </Button>
            <Button
              size="sm"
              onClick={onMerge}
              disabled={isPending}
              className={cn(
                'text-xs',
                testsPassed && 'bg-green-600 hover:bg-green-700 dark:bg-green-700 dark:hover:bg-green-600',
              )}
            >
              {isPending ? <LoadingText text="Merging" /> : 'Merge PR & Finish'}
            </Button>
          </div>
        </div>
      </div>

      {/* Summary grid */}
      <div className="px-4 py-2.5 grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
        {/* PR */}
        <div className="flex items-start gap-1.5">
          <GitPullRequest className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Pull Request</div>
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                {prState ?? 'missing'}
              </Badge>
              {prUrl && (
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[10px] text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  Open
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              )}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="font-mono truncate">{prUrl ?? (runtime.prUrl ? 'Invalid PR URL' : 'No PR URL')}</div>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-center text-balance">{prUrl ?? undefined}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Branch */}
        <div className="flex items-start gap-1.5">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Branch</div>
            <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="font-mono truncate">{branchName}</div>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-center text-balance">{branchName}</TooltipContent>
                      </Tooltip>
            <div className="text-muted-foreground">
              → <span className="font-mono">{baseBranch}</span>
            </div>
          </div>
        </div>

        {/* Commit */}
        <div className="flex items-start gap-1.5">
          <GitCommitHorizontal className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Candidate Commit</div>
            <Tooltip>
                        <TooltipTrigger asChild>
                          <code className="font-mono text-xs">{shortSha(commitSha)}</code>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-center text-balance">{commitSha ?? undefined}</TooltipContent>
                      </Tooltip>
            {commitCount != null && commitCount > 0 && (
              <div className="text-muted-foreground">
                {commitCount} commit{commitCount !== 1 ? 's' : ''} squashed
              </div>
            )}
          </div>
        </div>

        {/* Tests */}
        <div className="flex items-start gap-1.5">
          <FlaskConical className={cn(
            'h-3.5 w-3.5 mt-0.5 shrink-0',
            testsPassed ? 'text-green-600 dark:text-green-400' : testsFailed ? 'text-red-500' : 'text-muted-foreground',
          )} />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Final Tests</div>
            <div className="flex items-center gap-1.5">
              {testsPassed ? (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-green-300 text-green-700 dark:border-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />Passed
                </Badge>
              ) : testsFailed ? (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-red-300 text-red-700 dark:border-red-700 dark:text-red-400">
                  <XCircle className="h-2.5 w-2.5 mr-0.5" />Failed
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">Pending</Badge>
              )}
            </div>
            {(testAttempts != null || testCommandCount != null) && (
              <div className="text-muted-foreground">
                {testAttempts != null && `${testAttempts} attempt${testAttempts !== 1 ? 's' : ''}`}
                {testAttempts != null && testCommandCount != null && ' · '}
                {testCommandCount != null && `${testCommandCount} cmd${testCommandCount !== 1 ? 's' : ''}`}
              </div>
            )}
          </div>
        </div>

        {/* Beads */}
        <div className="flex items-start gap-1.5">
          <Blocks className={cn(
            'h-3.5 w-3.5 mt-0.5 shrink-0',
            runtime.completedBeads >= runtime.totalBeads && runtime.totalBeads > 0
              ? 'text-green-600 dark:text-green-400'
              : 'text-muted-foreground',
          )} />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Beads</div>
            <div>
              <span className="font-semibold">{runtime.completedBeads}</span>
              <span className="text-muted-foreground">/{runtime.totalBeads}</span>
              {runtime.completedBeads >= runtime.totalBeads && runtime.totalBeads > 0 && (
                <span className="text-green-600 dark:text-green-400 ml-1">✓</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {prUrl && (
        <div className="px-4 pb-2.5">
          <div className="text-[10px] bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 rounded px-2 py-1 text-slate-700 dark:text-slate-300">
            Review the draft PR in GitHub if you want. Merging from LoopTroop will mark the PR ready if needed, merge it, sync local {baseBranch}, and then start cleanup.
          </div>
        </div>
      )}
    </div>
  )
}
