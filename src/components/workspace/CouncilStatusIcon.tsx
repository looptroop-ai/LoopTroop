import { cn } from '@/lib/utils'
import {
  Pencil,
  Hourglass,
  RefreshCw,
  Search,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  CircleStop,
  type LucideIcon,
} from 'lucide-react'
import { isCouncilMemberOutcome } from '@shared/councilMembers'
import type { CouncilAction, CouncilOutcome } from './councilArtifacts'

interface CouncilStatusIconProps {
  outcome?: CouncilOutcome
  action?: CouncilAction
  className?: string
}

/**
 * A map rather than an if-chain: an outcome missing here would otherwise fall
 * through to the animated "still working" icon, which is what a stopped model
 * showed before it had an entry.
 */
const SETTLED_OUTCOME_ICONS: Record<Exclude<CouncilOutcome, 'pending'>, { Icon: LucideIcon; tone: string }> = {
  failed: { Icon: AlertTriangle, tone: 'text-red-500 animate-wobble-throb' },
  timed_out: { Icon: Clock, tone: 'text-amber-500' },
  invalid_output: { Icon: XCircle, tone: 'text-red-500' },
  completed: { Icon: CheckCircle2, tone: 'text-green-500' },
  // A person's decision, not a fault: neutral and still.
  stopped: { Icon: CircleStop, tone: 'text-slate-500 dark:text-slate-400' },
}

export function CouncilStatusIcon({ outcome, action, className }: CouncilStatusIconProps) {
  // 1. Terminal/Finished Outcomes
  if (isCouncilMemberOutcome(outcome) && outcome !== 'pending') {
    const { Icon, tone } = SETTLED_OUTCOME_ICONS[outcome]
    return <Icon className={cn('h-3.5 w-3.5 shrink-0', tone, className)} />
  }

  // 2. Pending Actions / Fallbacks
  const activeAction = outcome === 'pending' ? action : (action || 'drafting')

  switch (activeAction) {
    case 'scoring':
      return <Hourglass className={cn('h-3.5 w-3.5 text-blue-500 animate-hourglass-flip shrink-0', className)} />
    case 'verifying':
      return <Search className={cn('h-3.5 w-3.5 text-blue-500 animate-search-sweep shrink-0', className)} />
    case 'refining':
      return <RefreshCw className={cn('h-3.5 w-3.5 text-blue-500 animate-slow-spin shrink-0', className)} />
    case 'drafting':
    default:
      return <Pencil className={cn('h-3.5 w-3.5 text-blue-500 animate-pencil-write shrink-0', className)} />
  }
}
