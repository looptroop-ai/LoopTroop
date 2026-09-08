import { CheckCircle2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The strip above the coding view: phase or completion, the bead progress bar,
 * and which bead and iteration is running.
 *
 * Extracted with explicit props rather than by handing it the ticket, so it
 * owns no state and the tab bar below it — which is coupled to tab-state
 * ownership — is deliberately left where it is.
 */
export function CodingProgressHeader({
  isCompleted,
  phaseLabel,
  hasBeadControls,
  percent,
  current,
  total,
  activeIteration,
  maxIterationsPerBead,
  beadLabel,
}: {
  isCompleted: boolean
  phaseLabel: string
  hasBeadControls: boolean
  percent: number
  current: number
  total: number
  activeIteration?: number | null
  maxIterationsPerBead?: number | null
  beadLabel: string
}) {
  return (
    <div className="px-4 py-2 border-b border-border flex items-center gap-3 shrink-0">
      {isCompleted
        ? <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
        : <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />}
      <span className="text-sm font-medium">
        {isCompleted ? 'Completed Successfully' : phaseLabel}
      </span>
      {hasBeadControls && (
        <>
          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn('h-full transition-all duration-500', isCompleted ? 'bg-green-600' : 'bg-primary')}
              style={{ width: `${isCompleted ? 100 : percent}%` }}
            />
          </div>
          <span className="text-xs font-mono text-muted-foreground shrink-0">
            {isCompleted ? `${Math.max(total, 0)}/${Math.max(total, 0)}` : `${current}/${Math.max(total, 0)}`}
          </span>
        </>
      )}
      {hasBeadControls && activeIteration && activeIteration > 0 && (
        <span className="text-[11px] text-muted-foreground shrink-0">
          {beadLabel} · Iteration {activeIteration}
          {maxIterationsPerBead && maxIterationsPerBead > 0 ? `/${maxIterationsPerBead}` : ''}
        </span>
      )}
    </div>
  )
}
