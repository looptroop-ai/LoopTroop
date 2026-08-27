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

function SkipLine({ event, itemCount }: { event: SkipEvent; itemCount?: number }) {
  const label = describeSkipSurface(event.surface)
  return (
    <div
      className={cn(
        'flex items-baseline gap-2 whitespace-nowrap',
        (event.superseded || event.resolves) && 'opacity-50',
        event.isActionSummary && 'font-medium',
      )}
      style={{ lineHeight: `${LINE_HEIGHT_REM}rem` }}
      title={event.reason ?? undefined}
    >
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      {event.isActionSummary && itemCount !== undefined ? (
        <span className="shrink-0 font-mono text-[11px] text-foreground">{itemCount} item{itemCount === 1 ? '' : 's'}</span>
      ) : null}
      {event.itemId ? <span className="shrink-0 font-mono text-[11px] text-foreground">{event.itemId}</span> : null}
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        {event.resolves
          ? <span className="italic">Answered after all</span>
          : event.reason ?? <span className="italic">No reason given</span>}
      </span>
      {event.superseded && !event.resolves ? (
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
  // The action-summary row is kept, not filtered out — it carries the bulk
  // reason, which is stored nowhere else, and it is the only signal that forty
  // adjacent lines were one decision rather than forty.
  const events = [...skips.events].reverse()
  const itemsByAction = new Map<string, number>()
  for (const event of skips.events) {
    if (event.isActionSummary || event.resolves) continue
    const key = event.parentActionId ?? event.actionId
    itemsByAction.set(key, (itemsByAction.get(key) ?? 0) + 1)
  }

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
            <SkipLine
              key={`${event.receiptId}:${event.itemId ?? ''}`}
              event={event}
              itemCount={event.isActionSummary ? itemsByAction.get(event.actionId) : undefined}
            />
          ))}
        </div>
      )}
    </Shell>
  )
}
