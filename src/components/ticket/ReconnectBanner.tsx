import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * The amber "still working on it" strip above the dashboard.
 *
 * `TicketDashboard` rendered this twice with identical markup and different
 * wording — once while the ticket is loading, once while live updates are
 * reconnecting. Only the three strings differ, so only the three strings are
 * props.
 */
export function ReconnectBanner({
  label,
  tooltip,
  description,
}: {
  label: string
  tooltip: string
  description: string
}) {
  return (
    <div
      className="border-b border-amber-200 bg-amber-50/90 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/40"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="w-fit gap-1.5 border-amber-300 bg-amber-100/80 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            >
              <RefreshCw className="h-3 w-3 animate-spin" />
              {label}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-center text-balance">{tooltip}</TooltipContent>
        </Tooltip>
        <p className="text-xs leading-5 text-amber-900/75 dark:text-amber-200/80">
          {description}
        </p>
      </div>
    </div>
  )
}
