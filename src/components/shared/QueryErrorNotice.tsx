import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { describeQueryError } from '@/lib/fetchError'

interface QueryErrorNoticeProps {
  /** What could not be loaded, e.g. "The beads outline could not be loaded." */
  title: string
  /** Whatever the query rejected with; quoted when it says something. */
  error?: unknown
  onRetry?: () => void
  className?: string
}

/**
 * The compact counterpart to `DataUnavailableBanner`, for a panel whose failure
 * would otherwise be drawn as emptiness.
 *
 * "The beads outline will appear once the artifact is ready" is what these
 * surfaces printed on a 500 as well as on a phase that had not run yet, so a
 * broken daemon read as work still in progress and nobody retried. This says
 * the request failed and quotes the status the server sent with it.
 */
export function QueryErrorNotice({ title, error, onRetry, className }: QueryErrorNoticeProps) {
  const detail = describeQueryError(error)

  return (
    <div role="alert" className={`space-y-1.5 px-2 py-2 text-xs text-destructive ${className ?? ''}`}>
      <div className="flex items-center gap-1.5">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>{title}</span>
      </div>
      {detail && <p className="font-mono text-[11px] leading-4 opacity-80">{detail}</p>}
      {onRetry && (
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  )
}
