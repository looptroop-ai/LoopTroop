import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Hourglass } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TicketEta } from '@/hooks/useTickets'

interface EtaRangeProps {
  eta: TicketEta
  className?: string
  showTooltip?: boolean
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '<1m'
  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes < 1) return '<1m'
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

/**
 * Compact ETA display: shows the "likely" remaining time with a tooltip revealing the best/worst
 * range and an explicit reminder that the estimate is approximate. Used in the ticket header and the
 * phase navigator. Renders nothing when the estimate is not meaningful.
 */
export function EtaRange({ eta, className, showTooltip = true }: EtaRangeProps) {
  if (eta.likelyMs <= 0) return null
  // A rough default (no throughput history yet) is flagged with ≈ instead of ~.
  const prefix = eta.basis === 'default' ? '≈' : '~'
  const chip = (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-1.5 align-middle font-mono text-[10px] font-medium leading-none text-muted-foreground shadow-sm',
        className,
      )}
    >
      <Hourglass className="h-3 w-3" aria-hidden="true" />
      <span>{prefix}{formatDuration(eta.likelyMs)}</span>
    </span>
  )

  if (!showTooltip) return chip

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {chip}
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-center text-balance">
        Estimated time remaining (approximate): best {formatDuration(eta.bestMs)} · worst {formatDuration(eta.worstMs)}.
        {eta.basis === 'default' && ' No throughput history yet. This is a rough default.'}
        {eta.basis === 'current' && ' Based on this run so far; refines as more beads complete.'}
      </TooltipContent>
    </Tooltip>
  )
}
