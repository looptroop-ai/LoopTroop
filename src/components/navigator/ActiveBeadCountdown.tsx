import { useEffect, useState } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Clock3 } from 'lucide-react'
import { COUNTDOWN_TICK_MS } from '@/lib/constants'

interface ActiveBeadCountdownProps {
  startedAt: string
  perIterationTimeoutMs: number
  tooltip?: string
}

function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

export function ActiveBeadCountdown({ startedAt, perIterationTimeoutMs, tooltip = 'Time remaining for the current bead iteration before it times out and is retried.' }: ActiveBeadCountdownProps) {
  const [remainingMs, setRemainingMs] = useState(() => {
    const startMs = new Date(startedAt).getTime()
    const now = Date.now()
    return Math.max(0, perIterationTimeoutMs - (now - startMs))
  })

  useEffect(() => {
    const interval = setInterval(() => {
      const startMs = new Date(startedAt).getTime()
      const now = Date.now()
      setRemainingMs(Math.max(0, perIterationTimeoutMs - (now - startMs)))
    }, COUNTDOWN_TICK_MS)
    return () => clearInterval(interval)
  }, [startedAt, perIterationTimeoutMs])

  if (perIterationTimeoutMs <= 0) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ml-0.5 inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-1.5 align-middle font-mono text-[10px] font-medium leading-none text-muted-foreground shadow-sm">
          <Clock3 className="h-3 w-3" aria-hidden="true" />
          <span>{formatTime(remainingMs)}</span>
          <span className="text-muted-foreground/50">/</span>
          <span>{formatTime(perIterationTimeoutMs)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
