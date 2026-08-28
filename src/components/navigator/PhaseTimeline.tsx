import { useState, useMemo, useEffect, type ReactNode } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { StatusIndicator } from './StatusIndicator'
import { EtaRange } from './EtaRange'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STATUS_DESCRIPTIONS, getStatusUserLabel } from '@/lib/workflowMeta'
import { resolveKanbanPhase } from '@shared/kanbanPhase'
import { useWorkflowMeta } from '@/hooks/useWorkflowMeta'
import type { Ticket } from '@/hooks/useTickets'

interface PhaseTimelineProps {
  currentStatus: string
  reviewCutoffStatus?: string
  previousStatus?: string
  onSelectPhase?: (phase: string) => void
  selectedPhase?: string | null
  showBlockedErrorPhase?: boolean
  footer?: ReactNode
  ticket?: Ticket
}

type PhaseIndicatorStatus = 'completed' | 'active' | 'waiting' | 'pending' | 'error' | 'completed-final' | 'canceled'

function getPhaseIndicatorStatus(
  phaseId: string,
  currentStatus: string,
  phaseOrder: string[],
  reviewCutoffStatus?: string,
  previousStatus?: string,
  visitedStatuses: string[] = [],
  hasPendingQuestion = false,
): PhaseIndicatorStatus {
  if (currentStatus === 'BLOCKED_ERROR') {
    if (phaseId === 'BLOCKED_ERROR') return 'error'
    if (previousStatus) {
      const prevIndex = phaseOrder.indexOf(previousStatus)
      const phaseIndex = phaseOrder.indexOf(phaseId)
      if (prevIndex >= 0 && phaseIndex >= 0) {
        if (phaseIndex < prevIndex) return 'completed'
        if (phaseIndex === prevIndex) return 'error'
      }
    }
    if (visitedStatuses.includes(phaseId)) return 'completed'
    return 'pending'
  }

  if (phaseId === 'DRAFT' && currentStatus === 'DRAFT') {
    return 'pending'
  }

  if (currentStatus === 'CANCELED') {
    if (phaseId === 'CANCELED') return 'canceled'
    if (previousStatus === 'BLOCKED_ERROR') {
      if (phaseId === 'BLOCKED_ERROR') return 'error'
      if (reviewCutoffStatus) {
        const cutoffIndex = phaseOrder.indexOf(reviewCutoffStatus)
        const phaseIndex = phaseOrder.indexOf(phaseId)
        if (cutoffIndex >= 0 && phaseIndex >= 0) {
          if (phaseId === reviewCutoffStatus) return 'error'
          if (phaseIndex < cutoffIndex) return 'completed'
        }
      }
      if (visitedStatuses.includes(phaseId)) return 'completed'
      return 'pending'
    }
    if (reviewCutoffStatus) {
      const cutoffIndex = phaseOrder.indexOf(reviewCutoffStatus)
      const phaseIndex = phaseOrder.indexOf(phaseId)
      if (cutoffIndex >= 0 && phaseIndex >= 0 && phaseIndex <= cutoffIndex) {
        return 'completed'
      }
    }
    if (visitedStatuses.includes(phaseId)) return 'completed'
    return 'pending'
  }

  if (currentStatus === 'COMPLETED' && phaseId === 'COMPLETED') return 'completed-final'
  if (phaseId === currentStatus) {
    // A model that stopped to ask reads as waiting, not running, even though the
    // status still says the step is in flight.
    return resolveKanbanPhase(currentStatus, { hasPendingQuestion }) === 'needs_input' ? 'waiting' : 'active'
  }

  if (visitedStatuses.includes(phaseId)) return 'completed'

  const currentIndex = phaseOrder.indexOf(currentStatus)
  const phaseIndex = phaseOrder.indexOf(phaseId)

  if (currentIndex === -1 || phaseIndex === -1) return 'pending'
  return phaseIndex < currentIndex ? 'completed' : 'pending'
}

function getGroupStatus(
  group: { id: string; phases: Array<{ id: string }> },
  currentStatus: string,
  phaseOrder: string[],
  reviewCutoffStatus?: string,
  previousStatus?: string,
  visitedStatuses: string[] = [],
  hasPendingQuestion = false,
): PhaseIndicatorStatus {
  const statuses = group.phases.map(p => getPhaseIndicatorStatus(p.id, currentStatus, phaseOrder, reviewCutoffStatus, previousStatus, visitedStatuses, hasPendingQuestion))

  if (group.id === 'todo' && currentStatus === 'DRAFT') {
    return 'pending'
  }

  if (currentStatus === 'CANCELED') {
    if (statuses.some(s => s === 'error')) return 'error'
    if (statuses.some(s => s === 'canceled')) return 'canceled'
    if (statuses.some(s => s === 'completed-final')) return 'completed-final'
    if (statuses.some(s => s === 'completed')) return 'completed'
    return 'pending'
  }

  if (statuses.some(s => s === 'completed-final')) return 'completed-final'
  if (statuses.some(s => s === 'waiting')) return 'waiting'
  if (statuses.some(s => s === 'active')) return 'active'
  if (statuses.some(s => s === 'error')) return 'error'
  if (statuses.every(s => s === 'canceled')) return 'canceled'
  if (statuses.every(s => s === 'completed')) return 'completed'
  // A loop may visit post-implementation phases and then return to Coding. The
  // group remains historical/selectable, but it must not look like the active
  // group when none of its phases is currently active.
  if (statuses.some(s => s === 'completed')) return 'completed'
  return 'pending'
}

function getPhaseTooltip(phaseId: string): string {
  return STATUS_DESCRIPTIONS[phaseId] ?? phaseId.replace(/_/g, ' ')
}

function resolvePositiveNumber(...values: Array<number | null | undefined>): number | null {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0) ?? null
}

function resolveFiniteNumber(...values: Array<number | null | undefined>): number | null {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value)) ?? null
}

function getCodingBeadProgress(ticket?: Ticket): { current: number; total: number; percent: number } | null {
  const current = resolvePositiveNumber(ticket?.runtime?.currentBead, ticket?.currentBead)
  const total = resolvePositiveNumber(ticket?.runtime?.totalBeads, ticket?.totalBeads)
  if (current === null || total === null) return null
  const percent = resolveFiniteNumber(ticket?.runtime?.percentComplete, ticket?.percentComplete)
    ?? Math.round((Math.max(0, current - 1) / total) * 100)
  return { current, total, percent: Math.max(0, Math.min(100, Math.round(percent))) }
}

function getPhaseLabel(phaseId: string, ticket?: Ticket): string {
  if (phaseId === 'CODING') {
    const beadProgress = getCodingBeadProgress(ticket)
    return getStatusUserLabel(phaseId, {
      currentBead: beadProgress?.current ?? null,
      totalBeads: beadProgress?.total ?? null,
    })
  }

  return getStatusUserLabel(phaseId)
}

export function PhaseTimeline({
  currentStatus,
  reviewCutoffStatus,
  previousStatus,
  onSelectPhase,
  selectedPhase,
  showBlockedErrorPhase = currentStatus === 'BLOCKED_ERROR',
  footer,
  ticket,
}: PhaseTimelineProps) {
  const { groups, phases } = useWorkflowMeta()
  const visiblePhases = useMemo(
    () => phases.filter((phase) => showBlockedErrorPhase || phase.id !== 'BLOCKED_ERROR'),
    [phases, showBlockedErrorPhase],
  )
  const currentTimelineStatus = useMemo(() => {
    if (showBlockedErrorPhase || currentStatus !== 'BLOCKED_ERROR') return currentStatus
    return previousStatus ?? currentStatus
  }, [currentStatus, previousStatus, showBlockedErrorPhase])
  const phaseGroups = useMemo(() => groups
    .map((group) => ({
      id: group.id,
      label: group.label,
      phases: visiblePhases.filter((phase) => phase.groupId === group.id).map((phase) => ({ id: phase.id })),
    }))
    .filter((group) => group.phases.length > 0), [groups, visiblePhases])
  const phaseOrder = useMemo(() => visiblePhases.map((phase) => phase.id), [visiblePhases])
  const hasPendingQuestion = (ticket?.pendingQuestions?.requestCount ?? 0) > 0
  const defaultExpandedGroupIndexes = useMemo(() => {
    const indexes = new Set<number>()
    const activeGroupIndex = phaseGroups.findIndex(group => group.phases.some((phase) => phase.id === currentTimelineStatus))
    if (activeGroupIndex >= 0) indexes.add(activeGroupIndex)

    if (currentStatus === 'BLOCKED_ERROR' && previousStatus) {
      const previousGroupIndex = phaseGroups.findIndex(group => group.phases.some((phase) => phase.id === previousStatus))
      if (previousGroupIndex >= 0) indexes.add(previousGroupIndex)
    }

    if (indexes.size === 0) indexes.add(0)
    return indexes
  }, [currentStatus, currentTimelineStatus, phaseGroups, previousStatus])

  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(() => new Set(defaultExpandedGroupIndexes))

  // Auto-collapse previous group and expand new active group when status changes
  useEffect(() => {
    setExpandedGroups(new Set(defaultExpandedGroupIndexes))
  }, [defaultExpandedGroupIndexes])

  const toggleGroup = (idx: number) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-1">
        {phaseGroups.map((group, gi) => {
          const groupStatus = getGroupStatus(group, currentStatus, phaseOrder, reviewCutoffStatus, previousStatus, ticket?.visitedStatuses ?? [], hasPendingQuestion)
          const isExpanded = expandedGroups.has(gi)

          return (
            <div key={group.id}>
              <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                                  onClick={() => toggleGroup(gi)}
                                  className={cn(
                                    'w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wider transition-colors text-left',
                                    groupStatus === 'active' && 'text-primary',
                                    groupStatus === 'waiting' && 'text-amber-600 dark:text-amber-400',
                                    groupStatus === 'completed' && 'text-green-600',
                                    groupStatus === 'error' && 'text-destructive',
                                    groupStatus === 'pending' && 'text-muted-foreground',
                                    'hover:bg-accent/50',
                                  )}
                                >
                                  <ChevronRight className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')} />
                                  <StatusIndicator status={groupStatus} />
                                  <span>{group.label}</span>
                                </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-center text-balance">{`Toggle ${group.label} phases`}</TooltipContent>
                  </Tooltip>

              {isExpanded && (
                <div className="ml-3 space-y-0.5 mt-0.5">
                  {group.phases.map(phase => {
                    const indicatorStatus = getPhaseIndicatorStatus(phase.id, currentStatus, phaseOrder, reviewCutoffStatus, previousStatus, ticket?.visitedStatuses ?? [], hasPendingQuestion)
                    const isSelected = selectedPhase === phase.id
                    const isPast = indicatorStatus === 'completed'
                    const isFuture = indicatorStatus === 'pending'
                    const isCurrent = phase.id === currentStatus
                    const isSelectable = !isFuture || isCurrent

                    const phaseLabel = getPhaseLabel(phase.id, ticket)
                    const codingBeadProgress = phase.id === 'CODING' && isCurrent
                      ? getCodingBeadProgress(ticket)
                      : null

                    return (
                      <Tooltip key={phase.id}>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => isSelectable && onSelectPhase?.(phase.id)}
                            disabled={!isSelectable}
                            className={cn(
                              'w-full flex items-center gap-2 px-2 py-1 rounded-md text-xs transition-colors text-left',
                              isSelected && 'bg-accent',
                              isCurrent && !isSelected && 'bg-accent/50 font-medium',
                              isPast && 'cursor-pointer hover:bg-accent',
                              !isSelectable && 'opacity-40 cursor-default',
                            )}
                          >
                            <StatusIndicator status={indicatorStatus} />
                            {codingBeadProgress ? (
                              <>
                                <span className="min-w-0 truncate">Implementing</span>
                                <span className="shrink-0 text-muted-foreground">({codingBeadProgress.current}/{codingBeadProgress.total}, {codingBeadProgress.percent}%)</span>
                                <span className="min-w-0 flex-1" />
                              </>
                            ) : (
                              <span className="truncate flex-1">{phaseLabel}</span>
                            )}
                            {phase.id === 'CODING' && isCurrent && ticket?.runtime?.eta && (
                              <EtaRange eta={ticket.runtime.eta} showTooltip={false} className="ml-auto" />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs text-center text-balance">
                          {codingBeadProgress
                            ? `Bead completion: ${codingBeadProgress.current}/${codingBeadProgress.total} (${codingBeadProgress.percent}%). Remaining time is approximate.`
                            : getPhaseTooltip(phase.id)}
                        </TooltipContent>
                      </Tooltip>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
        {footer ? <div className="pt-2">{footer}</div> : null}
      </div>
    </ScrollArea>
  )
}
