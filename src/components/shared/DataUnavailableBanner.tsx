import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { describeQueryError } from '@/lib/fetchError'

interface DataUnavailableBannerProps {
  /** What could not be loaded, e.g. "Tickets unavailable". */
  title: string
  /** What the reader should do about it. */
  description: string
  /** Whatever the query rejected with; rendered verbatim when it says something. */
  error?: unknown
  onRetry?: () => void
  isRetrying?: boolean
}

/**
 * The counterpart to the "loading…" banner, for a query that has actually
 * failed.
 *
 * A board that shows "fetching the tickets" forever is indistinguishable from a
 * backend that is not answering, which is exactly how a dead daemon reads as a
 * slow one. This states that the request failed, quotes the reason, and offers
 * the retry — so the next person spends their time on the daemon rather than on
 * their network.
 */
export function DataUnavailableBanner({
  title,
  description,
  error,
  onRetry,
  isRetrying = false,
}: DataUnavailableBannerProps) {
  const detail = describeQueryError(error)

  return (
    <div
      className="border-b border-red-200 bg-red-50/90 px-4 py-2 dark:border-red-900/60 dark:bg-red-950/40 shrink-0"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className="w-fit gap-1.5 border-red-300 bg-red-100/80 text-[11px] text-red-900 dark:border-red-800 dark:bg-red-900/40 dark:text-red-200"
              >
                <AlertTriangle className="h-3 w-3" />
                {title}
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-center text-balance">
              The server did not answer this request. It is most likely not running.
            </TooltipContent>
          </Tooltip>
          {onRetry && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRetry}
              disabled={isRetrying}
              className="h-6 gap-1.5 border-red-300 bg-red-100/60 px-2 text-[11px] text-red-900 hover:bg-red-100 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200"
            >
              <RefreshCw className={`h-3 w-3 ${isRetrying ? 'animate-spin' : ''}`} />
              {isRetrying ? 'Retrying…' : 'Retry'}
            </Button>
          )}
        </div>
        <p className="text-xs leading-5 text-red-900/75 dark:text-red-200/80">{description}</p>
        {detail && (
          <p className="font-mono text-[11px] leading-5 text-red-900/60 dark:text-red-200/60">{detail}</p>
        )}
      </div>
    </div>
  )
}
