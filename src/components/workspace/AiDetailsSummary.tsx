import { AlertCircle, RefreshCw } from 'lucide-react'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import type { TicketAiDetails } from '@/hooks/useTicketAiDetails'

interface AiDetailsSummaryProps {
  details?: TicketAiDetails
  isLoading: boolean
  isError: boolean
  isFetching: boolean
  modelId?: string
  scope: 'phase' | 'lifecycle'
  onRetry: () => void
}

function formatCount(value: number | null): string {
  return value == null ? 'Not reported' : new Intl.NumberFormat().format(value)
}

function formatCost(value: number | null): string {
  if (value == null) return 'Not reported'
  const [whole, fraction = ''] = value.toFixed(6).split('.')
  const meaningfulFraction = fraction.replace(/0+$/, '').padEnd(2, '0')
  return `$${whole}.${meaningfulFraction}`
}

function formatDuration(value: number | null): string {
  if (value == null) return 'Not reported'
  if (value < 1_000) return `${Math.round(value)}ms`
  const seconds = value / 1_000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${minutes}m ${remainder}s`
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 rounded border border-border/60 bg-background/50 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xs font-semibold text-foreground" title={value}>{value}</div>
      {detail ? <div className="mt-0.5 break-words text-[10px] leading-snug text-muted-foreground">{detail}</div> : null}
    </div>
  )
}

export function AiDetailsSummary({
  details,
  isLoading,
  isError,
  isFetching,
  modelId,
  scope,
  onRetry,
}: AiDetailsSummaryProps) {
  const scopeLabel = scope === 'lifecycle' ? 'Ticket lifecycle' : 'Current status attempt'
  const targetLabel = modelId ? getModelDisplayName(modelId) : 'All AI models'

  if (isLoading) {
    return (
      <div className="mb-3 rounded-md border border-border/70 bg-background/40 p-3 text-xs text-muted-foreground" role="status">
        Loading AI details…
      </div>
    )
  }

  if (isError) {
    return (
      <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
        <span className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          AI details could not be loaded.
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </button>
      </div>
    )
  }

  const summary = details?.summary
  if (!summary || summary.turns === 0) {
    return (
      <div className="mb-3 rounded-md border border-border/70 bg-background/40 p-3 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">{targetLabel}</div>
        <div className="mt-1">No completed AI turns have reported details for this scope yet.</div>
      </div>
    )
  }

  const tokenDetail = [
    `In ${formatCount(summary.tokens.input)}`,
    `Out ${formatCount(summary.tokens.output)}`,
    `Reasoning ${formatCount(summary.tokens.reasoning)}`,
    `Cache R/W ${formatCount(summary.tokens.cacheRead)} / ${formatCount(summary.tokens.cacheWrite)}`,
  ].join(' · ')
  const coverage = summary.coverage
  const partialCoverage = coverage.costTurns < summary.turns
    || coverage.tokenTurns < summary.turns
    || coverage.timingTurns < summary.turns
  const coverageText = `Cost ${coverage.costTurns}/${summary.turns} · Tokens ${coverage.tokenTurns}/${summary.turns} · Timing ${coverage.timingTurns}/${summary.turns}`

  return (
    <section className="mb-3 rounded-md border border-border/70 bg-background/40 p-3" aria-label={`${modelId ? 'Model' : 'AI'} details`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-foreground">{targetLabel}</div>
          <div className="text-[10px] text-muted-foreground">{scopeLabel}</div>
        </div>
        <div className="text-[10px] text-muted-foreground">
          {isFetching ? 'Updating…' : details.updatedAt ? `Updated ${new Date(details.updatedAt).toLocaleTimeString()}` : 'Waiting for an update'}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Cost" value={formatCost(summary.costUsd)} />
        <Stat label="Activity" value={`${formatCount(summary.turns)} turns`} detail={`${formatCount(summary.sessions)} sessions`} />
        <Stat label="Tokens" value={formatCount(summary.tokens.total)} detail={tokenDetail} />
        <Stat
          label="Model time"
          value={formatDuration(summary.timingMs.total)}
          detail={`Avg ${formatDuration(summary.timingMs.average)} · Longest ${formatDuration(summary.timingMs.longest)}`}
        />
      </div>
      {partialCoverage ? (
        <div className="mt-2 text-[10px] text-amber-600 dark:text-amber-400">
          Partial provider data · {coverageText}
        </div>
      ) : null}
    </section>
  )
}
