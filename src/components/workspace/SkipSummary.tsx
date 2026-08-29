import { AlertCircle, RefreshCw } from 'lucide-react'
import { formatAiQuestionWindow } from '@shared/aiQuestions'
import {
  describeSkipSurface,
  SKIP_ACTORS,
  SKIP_ACTOR_LABELS,
  type SkipActor,
  type SkipEvent,
  type SkipEventCounts,
  type SkipQuestionContext,
} from '@shared/skipReceipt'
import type { TicketSkips } from '@/hooks/useTicketSkips'
import { cn } from '@/lib/utils'
import { formatElapsedDuration } from './currentActivity'

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

/**
 * Reads the actor off a row, defaulting to `user`.
 *
 * Receipts written before the trail had an actor meant `user` — a person was
 * the only thing that could skip. Rendering those as "unknown" would invent a
 * doubt the record never had.
 */
function resolveSkipActor(value: unknown): SkipActor {
  return typeof value === 'string' && (SKIP_ACTORS as readonly string[]).includes(value)
    ? (value as SkipActor)
    : 'user'
}

// Three actors, three registers, none of them a failure. A wait that ran out is
// an outcome the operator configured, so it reads as a note rather than an
// error: amber and blue outlines, never the destructive red.
const ACTOR_CLASSES: Record<SkipActor, string> = {
  user: 'border-border text-muted-foreground',
  timeout: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  system: 'border-blue-500/40 text-blue-700 dark:text-blue-400',
}

function ActorBadge({ actor }: { actor: SkipActor }) {
  return (
    <span
      data-actor={actor}
      className={cn('shrink-0 rounded-full border px-1.5 text-[10px] leading-4', ACTOR_CLASSES[actor])}
    >
      {SKIP_ACTOR_LABELS[actor]}
    </span>
  )
}

/** Who paused the countdown, in a form that fits mid-sentence. */
function describeStop(stoppedBy: string | null): string {
  if (stoppedBy === 'user') return 'you stopped the clock'
  if (stoppedBy === 'system') return 'LoopTroop stopped the clock'
  return 'the clock was stopped'
}

/** The clock on one line: what the wait allowed, and what it actually took. */
function describeQuestionClock(context: SkipQuestionContext): string {
  const parts = [
    `${formatAiQuestionWindow(context.window_ms)} to answer`,
    `waited ${formatElapsedDuration(context.elapsed_wall_ms)}`,
  ]
  // Worth saying only when it happened. A clock nobody touched needs no line.
  if (context.stopped_at !== null) parts.push(describeStop(context.stopped_by))
  return parts.join(' · ')
}

/**
 * The rest of the clock, for the hover.
 *
 * The request is gone the moment OpenCode is told, so the receipt is the only
 * place these numbers survive — but they do not all belong on a line that has
 * to share its width with a reason.
 */
function describeQuestionDetail(context: SkipQuestionContext): string {
  const lines = [
    `${context.question_count} question${context.question_count === 1 ? '' : 's'} went unanswered`,
    `Wait: ${formatAiQuestionWindow(context.window_ms)}`,
    `Waited ${formatElapsedDuration(context.elapsed_wall_ms)}, of which ${formatElapsedDuration(context.elapsed_active_ms)} on the clock`,
  ]
  if (context.reset_count > 0) {
    const times = `${context.reset_count} time${context.reset_count === 1 ? '' : 's'}`
    lines.push(`Another model asking pushed the wait back to full ${times}`)
  }
  if (context.stopped_at !== null) lines.push(`Then ${describeStop(context.stopped_by)}`)
  if (context.quorum_impact) lines.push(context.quorum_impact)
  return lines.join('\n')
}

function SkipLine({ event, itemCount, showClock }: {
  event: SkipEvent
  itemCount?: number
  showClock?: boolean
}) {
  const label = describeSkipSurface(event.surface)
  const actor = resolveSkipActor(event.skippedBy)
  const context = showClock ? event.questionContext ?? null : null
  // The reason keeps the hover it has always had; the clock adds to it rather
  // than taking it over.
  const title = [event.reason, context && describeQuestionDetail(context)]
    .filter((part): part is string => Boolean(part))
    .join('\n\n')
  return (
    <div
      className={cn(
        'flex items-baseline gap-2 whitespace-nowrap',
        (event.superseded || event.resolves) && 'opacity-50',
        event.isActionSummary && 'font-medium',
      )}
      style={{ lineHeight: `${LINE_HEIGHT_REM}rem` }}
      title={title || undefined}
    >
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      {event.isActionSummary && itemCount !== undefined ? (
        <span className="shrink-0 font-mono text-[11px] text-foreground">{itemCount} item{itemCount === 1 ? '' : 's'}</span>
      ) : null}
      {event.itemId ? <span className="shrink-0 font-mono text-[11px] text-foreground">{event.itemId}</span> : null}
      <ActorBadge actor={actor} />
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        {event.resolves
          ? <span className="italic">Answered after all</span>
          : event.reason ?? <span className="italic">No reason given</span>}
      </span>
      {context ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">{describeQuestionClock(context)}</span>
      ) : null}
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
  const actionsWithSummary = new Set<string>()
  for (const event of skips.events) {
    if (event.isActionSummary) {
      actionsWithSummary.add(event.actionId)
      continue
    }
    if (event.resolves) continue
    const key = event.parentActionId ?? event.actionId
    itemsByAction.set(key, (itemsByAction.get(key) ?? 0) + 1)
  }

  // One clock covered the whole request, so it is stated once per action — on
  // the summary row that stands for the request, or on the row itself when the
  // action left no summary. Repeating it under every child would read as
  // several waits where there was one.
  const showsClock = (event: SkipEvent): boolean => (
    Boolean(event.questionContext)
    && (event.isActionSummary || !actionsWithSummary.has(event.parentActionId ?? event.actionId))
  )

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
              showClock={showsClock(event)}
            />
          ))}
        </div>
      )}
    </Shell>
  )
}
