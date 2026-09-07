import type { ReactNode } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { QueryErrorNotice } from '@/components/shared/QueryErrorNotice'
import { cn } from '@/lib/utils'

interface ApprovalOutlineShellProps {
  /** The uppercase heading above the outline. */
  title: string
  /** Badges rendered beside the heading — counts, a readiness status. */
  headerBadges?: ReactNode
  isLoading: boolean
  isError: boolean
  error: unknown
  onRetry: () => void
  /** Sentence shown while the outline is being fetched. */
  loadingMessage: string
  /** Sentence shown when the request failed, above the retry. */
  errorTitle: string
  /**
   * Sentence shown when the request succeeded but there is nothing to outline
   * yet. `null` means the outline is ready and `children` should render.
   */
  emptyMessage: string | null
  /** Tailwind max-height for the scroll region; panes differ. */
  maxHeightClass?: string
  /** Tailwind spacing between the outline's own children; panes differ. */
  contentClassName?: string
  children: ReactNode
}

/**
 * The chrome every approval outline draws around itself: a padded header, a
 * bounded scroll region, and the loading / failed / not-ready / ready decision.
 *
 * Four navigators wrote all of it out, so the four had already drifted — one
 * scrolls to a different height and they space their items differently — and
 * PR-07's work to stop a failed request rendering as an empty outline had to be
 * repeated in each. The differences that are real are props; the copy is
 * per-domain because "Loading beads outline…" is not "Loading PRD outline…".
 *
 * It does not unify the outline builders. Those are genuinely different shapes,
 * and flattening them into one would be the wrong kind of sharing.
 */
export function ApprovalOutlineShell({
  title,
  headerBadges,
  isLoading,
  isError,
  error,
  onRetry,
  loadingMessage,
  errorTitle,
  emptyMessage,
  maxHeightClass = 'max-h-[320px]',
  contentClassName = 'space-y-1',
  children,
}: ApprovalOutlineShellProps) {
  return (
    <div className="p-2">
      <div className="px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
        <span>{title}</span>
        {headerBadges}
      </div>
      <ScrollArea className={maxHeightClass}>
        <div className={cn(contentClassName, 'pr-2')}>
          {isLoading ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">{loadingMessage}</div>
          ) : isError ? (
            <QueryErrorNotice title={errorTitle} error={error} onRetry={onRetry} />
          ) : emptyMessage !== null ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">{emptyMessage}</div>
          ) : (
            children
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
