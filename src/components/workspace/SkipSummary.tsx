import { AlertCircle, RefreshCw } from 'lucide-react'
import { describeSkipSurface, type SkipEvent, type SkipEventCounts } from '@shared/skipReceipt'
import type { TicketSkips } from '@/hooks/useTicketSkips'
import { cn } from '@/lib/utils'

interface SkipSummaryProps {
  skips?: TicketSkips
  isLoading: boolean
  isError: boolean
  isFetching: boolean
  onRetry: () => void
}

/**
 * Eight lines, then scroll.
 *
 * A ticket can carry forty skips. A block that grows to hold all of them pushes
 * the log itself off the screen, which is the thing people came here to read.
 */
const MAX_VISIBLE_LINES = 8
const LINE_HEIGHT_REM = 1.75

function Shell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mb-3 rounded-md border border-border/70 bg-background/40 p-3 text-xs', className)}>
      {children}
    </div>
  )
}

function CountsLine({ counts }: { counts: SkipEventCounts }) {
  // One bulk action counts as 1 action and N items. Summing rows would report a
  // forty-question Skip All as forty-one skips.
  return (
    <span className="text-[11px] text-muted-foreground">
      {counts.actions} action{counts.actions === 1 ? '' : 's'}
      {' · '}
      {counts.items} item{counts.items === 1 ? '' : 's'} skipped
      {' · '}
      {counts.itemsWithReason} with a reason
      {' · '}
      {counts.itemsWithoutReason} without
    </span>
  )
}

function SkipLine({ event }: { event: SkipEvent }) {
  const label = describeSkipSurface(event.surface)
  return (
    <div
      className={cn(
        'flex items-baseline gap-2 whitespace-nowrap',
        event.superseded && 'opacity-50',
      )}
      style={{ lineHeight: `${LINE_HEIGHT_REM}rem` }}
      title={event.reason ?? undefined}
    >
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      {event.itemId ? <span className="shrink-0 font-mono text-[11px] text-foreground">{event.itemId}</span> : null}
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        {event.reason ?? <span className="italic">No reason given</span>}
      </span>
      {event.superseded ? (
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">superseded</span>
      ) : null}
    </div>
  )
}

export function SkipSummary({ skips, isLoading, isError, isFetching, onRetry }: SkipSummaryProps) {
  if (isLoading) {
    return (
      <Shell>
        <span className="text-muted-foreground" role="status">Loading skips…</span>
      </Shell>
    )
  }

  if (isError || !skips) {
    return (
      <Shell className="border-destructive/40">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
            Could not load the skips for this ticket.
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted/60"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        </div>
      </Shell>
    )
  }

  // Newest first: the last decision is the one most likely to be under review.
  const events = [...skips.events].reverse().filter((event) => !event.isActionSummary)

  return (
    <Shell>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">Skips</span>
        <span className="inline-flex items-center gap-2">
          <CountsLine counts={skips.counts} />
          {isFetching ? <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" /> : null}
        </span>
      </div>
      {events.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">Nothing was skipped on this ticket.</div>
      ) : (
        <div
          className="overflow-y-auto overflow-x-hidden pr-1"
          style={{ maxHeight: `${MAX_VISIBLE_LINES * LINE_HEIGHT_REM}rem` }}
        >
          {events.map((event) => (
            <SkipLine key={`${event.receiptId}:${event.itemId ?? ''}`} event={event} />
          ))}
        </div>
      )}
    </Shell>
  )
}
