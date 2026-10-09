import { CalendarDays } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { EffortBadge } from '@/components/shared/EffortBadge'
import type { Ticket } from '@/hooks/useTickets'
import type { Project } from '@/hooks/useProjects'
import type { DraftContext } from './useDraftView'

const PRIORITY_LABELS: Record<number, string> = { 1: 'Very High', 2: 'High', 3: 'Normal', 4: 'Low', 5: 'Very Low' }
const PRIORITY_COLORS: Record<number, string> = {
  1: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  2: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  3: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  4: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
  5: 'bg-blue-50 text-blue-500 dark:bg-blue-900/20 dark:text-blue-300',
}

interface DraftOverviewProps {
  ticket: Ticket
  context: DraftContext
}

export const DraftOverview = ({ ticket, context }: DraftOverviewProps) => (
  <>
    <div className="text-center">
      <h3 className="text-lg font-semibold">Ready to Start</h3>
      <p className="text-xs text-muted-foreground mt-1">
        Click Start to begin the AI-driven interview process. This may take hours. LoopTroop optimizes for correctness, not speed.
      </p>
    </div>
    <DraftTicketMetadata ticket={ticket} project={context.project} />
    <DraftCouncilSection council={context.council} isProfileLoading={context.isProfileLoading} />
  </>
)

export const DraftTicketMetadata = ({ ticket, project }: { ticket: Ticket; project: Project | undefined }) => (
  <div className="w-full flex flex-wrap items-center justify-center gap-3 text-xs">
    <Badge variant="outline" className={PRIORITY_COLORS[ticket.priority] ?? PRIORITY_COLORS[3]}>
      P{ticket.priority}: {PRIORITY_LABELS[ticket.priority] ?? 'Normal'}
    </Badge>
    <DraftCreationTime createdAt={ticket.createdAt} />
    {project && <DraftProjectLabel project={project} />}
  </div>
)

export const DraftCreationTime = ({ createdAt }: { createdAt: string }) => {
  const date = new Date(createdAt)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1 text-muted-foreground">
          <CalendarDays className="h-3.5 w-3.5" />
          Created {date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-center text-balance">{date.toLocaleString()}</TooltipContent>
    </Tooltip>
  )
}

export const DraftProjectLabel = ({ project }: { project: Project }) => (
  <span className="flex items-center gap-1 text-muted-foreground">
    {project.icon && (project.icon.startsWith('data:') ? <img src={project.icon} className="h-3.5 w-3.5 rounded" alt="" /> : <span>{project.icon}</span>)}
    {project.name}
  </span>
)

interface DraftCouncilProps {
  council: DraftContext['council']
}

export const DraftCouncilSection = ({ council, isProfileLoading }: DraftCouncilProps & { isProfileLoading: boolean }) => {
  if (isProfileLoading && council.members.length === 0) return null
  return (
    <div className="w-full flex justify-center">
      <div className="inline-flex max-w-full flex-col items-center gap-1 rounded-md border border-dashed border-border/70 bg-muted/25 px-2.5 py-1.5 text-center">
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-medium uppercase tracking-[0.22em] text-muted-foreground">Current Council Members</span>
          <DraftCouncilInfo />
        </div>
        {council.members.length > 0 ? <DraftCouncilList council={council} /> : <p className="text-[10px] text-muted-foreground">No council members are configured yet.</p>}
      </div>
    </div>
  )
}

export const DraftCouncilInfo = () => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border/70 text-[8px] font-semibold leading-none text-muted-foreground transition-colors hover:bg-muted/60" aria-label="Council member info">i</button>
    </TooltipTrigger>
    <TooltipContent className="max-w-56 text-[11px] leading-snug">
      If you start this ticket now, these council members will stay fixed for the entire ticket lifecycle. To change the models, go to Configuration first.
    </TooltipContent>
  </Tooltip>
)

export const DraftCouncilList = ({ council }: DraftCouncilProps) => (
  <div className="flex flex-wrap justify-center gap-1">
    {council.members.map((memberId) => {
      const isMainImplementer = memberId === council.highlightedMainImplementer
      const variant = isMainImplementer ? council.mainImplementerVariant : council.variants[memberId]
      return <DraftCouncilMember key={memberId} memberId={memberId} isMainImplementer={isMainImplementer} variant={variant} />
    })}
  </div>
)

interface DraftCouncilMemberProps {
  memberId: string
  isMainImplementer: boolean
  variant: string | null | undefined
}

export const DraftCouncilMember = ({ memberId, isMainImplementer, variant }: DraftCouncilMemberProps) => (
  <Badge variant={isMainImplementer ? 'default' : 'secondary'} className="h-auto max-w-full gap-1 px-1.5 py-0.5 text-[9px] leading-tight whitespace-normal">
    {isMainImplementer && <span className="rounded-sm bg-background/20 px-1 py-px text-[8px] font-semibold uppercase tracking-[0.14em]">Main Implementer</span>}
    <span className="font-mono break-all">{memberId}</span>
    {variant && <EffortBadge variant={variant} className="text-[8px]" />}
  </Badge>
)
