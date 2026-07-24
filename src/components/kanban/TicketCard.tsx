import { useState, useEffect } from 'react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Loader2, AlertTriangle, ChevronUp, ChevronDown, Minus, HelpCircle } from 'lucide-react'
import { useUI } from '@/context/useUI'
import { useAIQuestions } from '@/context/useAIQuestions'
import { STATUS_DESCRIPTIONS, STATUS_TO_PHASE, getStatusUserLabel } from '@/lib/workflowMeta'
import {
  clearErrorTicketSeen,
  getErrorTicketSignature,
  markErrorTicketSeen,
  readErrorTicketSeen,
} from '@/lib/errorTicketSeen'
import {
  clearNeedsInputSeen,
  getNeedsInputSignature,
  markNeedsInputSeen,
  readNeedsInputSeen,
} from '@/lib/needsInputSeen'
import {
  getStatusColor,
  formatRelativeDateChip,
  getBeadCompletionProgress,
  getWorkflowRingProgress,
} from './ticketCardUtils'
import { EtaRange } from '@/components/navigator/EtaRange'
import { TicketExternalId } from '@/components/ticket/TicketExternalId'
import { getTicketExternalIdLabel } from '@/lib/ticketDisplay'
import type { TicketEta } from '@/hooks/useTickets'


interface TicketCardProps {
  ticket: {
    id: string
    externalId: string
    isDisplayOnlyMock?: boolean | null
    title: string
    priority: number
    status: string
    updatedAt: string
    projectId: number
    currentBead?: number | null
    totalBeads?: number | null
    percentComplete?: number | null
    errorMessage?: string | null
    errorSeenSignature?: string | null
    needsInputSeenSignature?: string | null
    completionDisposition?: 'merged' | 'closed_unmerged' | null
    runtime?: {
      currentBead?: number | null
      completedBeads?: number | null
      totalBeads?: number | null
      percentComplete?: number | null
      iterationCount?: number | null
      maxIterations?: number | null
      activeBeadIteration?: number | null
      maxIterationsPerBead?: number | null
      eta?: TicketEta | null
    } | null
  }
  projectColor?: string
  projectIcon?: string
  projectName?: string
  searchMatchLabel?: string | null
}

function PriorityArrows({ priority }: { priority: number }) {
  switch (priority) {
    case 1:
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30 font-mono text-[10px] font-bold shadow-2xs whitespace-nowrap">
              <ChevronUp className="h-3 w-3 -mr-1 shrink-0" strokeWidth={3} />
              <ChevronUp className="h-3 w-3 shrink-0" strokeWidth={3} />
              <span>P1</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-center text-balance">Very High Priority</TooltipContent>
        </Tooltip>
      )
    case 2:
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 font-mono text-[10px] font-bold shadow-2xs whitespace-nowrap">
              <ChevronUp className="h-3 w-3 shrink-0" strokeWidth={2.5} />
              <span>P2</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-center text-balance">High Priority</TooltipContent>
        </Tooltip>
      )
    case 3:
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border border-zinc-500/20 font-mono text-[10px] font-medium whitespace-nowrap">
              <Minus className="h-3 w-3 shrink-0" strokeWidth={2} />
              <span>P3</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-center text-balance">Normal Priority</TooltipContent>
        </Tooltip>
      )
    case 4:
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/30 font-mono text-[10px] font-medium whitespace-nowrap">
              <ChevronDown className="h-3 w-3 shrink-0" strokeWidth={2} />
              <span>P4</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-center text-balance">Low Priority</TooltipContent>
        </Tooltip>
      )
    case 5:
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-slate-500/15 text-slate-600 dark:text-slate-400 border border-slate-500/30 font-mono text-[10px] font-medium whitespace-nowrap">
              <ChevronDown className="h-3 w-3 -mr-1 shrink-0" strokeWidth={2} />
              <ChevronDown className="h-3 w-3 shrink-0" strokeWidth={2} />
              <span>P5</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-center text-balance">Very Low Priority</TooltipContent>
        </Tooltip>
      )
    default:
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border border-zinc-500/20 font-mono text-[10px] font-medium whitespace-nowrap">
              <Minus className="h-3 w-3 shrink-0" strokeWidth={2} />
              <span>P3</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-center text-balance">Normal Priority</TooltipContent>
        </Tooltip>
      )
  }
}

export function TicketCard({ ticket, projectColor, projectIcon, projectName, searchMatchLabel }: TicketCardProps) {
  const { dispatch } = useUI()
  const { getPendingCount } = useAIQuestions()
  const isError = ticket.status === 'BLOCKED_ERROR'
  const isTerminal = ticket.status === 'COMPLETED' || ticket.status === 'CANCELED'
  const kanbanPhase = STATUS_TO_PHASE[ticket.status] ?? 'todo'
  const isInProgress = !isTerminal && kanbanPhase === 'in_progress'
  const workflowRingProgress = getWorkflowRingProgress(ticket.status)
  const beadCompletionProgress = getBeadCompletionProgress(ticket.status, {
    totalBeads: ticket.totalBeads ?? ticket.runtime?.totalBeads ?? 0,
    percentComplete: ticket.percentComplete ?? ticket.runtime?.percentComplete ?? 0,
  })
  const currentBead = ticket.currentBead ?? ticket.runtime?.currentBead ?? null
  const totalBeads = ticket.totalBeads ?? ticket.runtime?.totalBeads ?? null
  const statusLabel = getStatusUserLabel(ticket.status, {
    currentBead,
    totalBeads,
    errorMessage: ticket.errorMessage,
  })
  const errorSignature = getErrorTicketSignature(ticket)
  const needsInputSignature = getNeedsInputSignature(ticket)
  // Yellow needs-input flashing is suppressed while an unseen red error is showing.
  const isNeedsInput = !isError && STATUS_TO_PHASE[ticket.status] === 'needs_input'
  const needsInputFlashing = isNeedsInput && !!needsInputSignature
  const pendingAIQuestions = getPendingCount(ticket.id)
  const hasPendingAIQuestion = pendingAIQuestions > 0
  const attentionColor = projectColor ?? '#1594a6'

  // Track "seen" state for BLOCKED_ERROR — stop flashing after first open
  const [errorSeen, setErrorSeen] = useState(() =>
    readErrorTicketSeen(ticket.id, errorSignature, ticket.errorSeenSignature),
  )

  // Track "seen" state for NEEDS_INPUT (yellow) — stop flashing after first open,
  // revert to the static project color even if the required action was not performed.
  const [needsInputSeen, setNeedsInputSeen] = useState(() =>
    readNeedsInputSeen(ticket.id, needsInputSignature, ticket.needsInputSeenSignature),
  )

  useEffect(() => {
    if (!isError && errorSeen) {
      clearErrorTicketSeen(ticket.id)
      setErrorSeen(false)
    }
  }, [isError, ticket.id, errorSeen])

  useEffect(() => {
    if (!isNeedsInput && needsInputSeen) {
      clearNeedsInputSeen(ticket.id)
      setNeedsInputSeen(false)
    }
  }, [isNeedsInput, ticket.id, needsInputSeen])

  const handleClick = () => {
    if (isError && !errorSeen) {
      markErrorTicketSeen(ticket.id, errorSignature)
      setErrorSeen(true)
    }
    if (isNeedsInput && !needsInputSeen && needsInputSignature) {
      markNeedsInputSeen(ticket.id, needsInputSignature)
      setNeedsInputSeen(true)
    }
    dispatch({ type: 'SELECT_TICKET', ticketId: ticket.id, externalId: ticket.externalId })
  }

  const errorFlashing = isError && !errorSeen
  const needsInputYellowFlashing = needsInputFlashing && !needsInputSeen && !errorFlashing
  const statusProgressPercent = beadCompletionProgress?.percent ?? workflowRingProgress?.percent ?? null
  const hasUnseenAttention = errorFlashing || needsInputYellowFlashing
  const isBlockedError = ticket.status === 'BLOCKED_ERROR'
  const badgeProgressStyle = statusProgressPercent !== null && !hasUnseenAttention && !isBlockedError ? {
    background: `linear-gradient(90deg, color-mix(in srgb, var(--color-brand-500) 16%, transparent) 0%, color-mix(in srgb, var(--color-brand-500) 16%, transparent) ${statusProgressPercent}%, color-mix(in srgb, var(--color-muted) 60%, transparent) ${statusProgressPercent}%, color-mix(in srgb, var(--color-muted) 60%, transparent) 100%)`,
    borderColor: `color-mix(in srgb, var(--color-brand-500) 28%, var(--color-border))`,
  } : undefined

  return (
    <Card
      className="group relative min-w-0 max-w-full cursor-pointer overflow-hidden p-3.5 transition-all duration-200 rounded-xl border border-border/70 bg-card hover:bg-accent/40 hover:shadow-md hover:border-border hover:-translate-y-0.5 active:scale-[0.99]"
      onClick={handleClick}
      aria-label={`Open ticket ${getTicketExternalIdLabel(ticket.externalId, ticket.isDisplayOnlyMock)}`}
    >
      {/* Top Project Tag Badge */}
      <div className="flex items-center justify-between gap-2 border-b border-border/40 pb-2 mb-2">
        <span
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold border shadow-2xs min-w-0 max-w-[70%]"
          style={{
            backgroundColor: `${attentionColor}15`,
            color: attentionColor,
            borderColor: `${attentionColor}35`,
          }}
        >
          <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: attentionColor }} />
          {projectIcon && (projectIcon.startsWith('data:') ? <img src={projectIcon} className="h-3 w-3 shrink-0 rounded" alt="" /> : <span className="shrink-0 text-[10px]">{projectIcon}</span>)}
          <span className="truncate uppercase tracking-wider">{projectName || 'General'}</span>
        </span>
        <TicketExternalId
          externalId={ticket.externalId}
          isDisplayOnlyMock={ticket.isDisplayOnlyMock}
          className="shrink-0 text-xs font-mono font-medium"
          style={{ color: attentionColor }}
        />
      </div>

      <div className="flex min-w-0 items-start justify-between gap-2">
        <p className="break-words text-sm font-semibold tracking-tight text-foreground leading-snug [overflow-wrap:anywhere] group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">
          {ticket.title}
        </p>
        <div className="flex shrink-0 items-center gap-1.5 ml-2">
          <PriorityArrows priority={ticket.priority} />
          {isInProgress && <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-500" />}
          {hasPendingAIQuestion && <HelpCircle className="h-3.5 w-3.5" style={{ color: attentionColor }} />}
          {isError && <AlertTriangle className="h-3.5 w-3.5 text-destructive animate-wobble-throb" />}
        </div>
      </div>

      <div className="mt-3 flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                className={cn(
                  'min-w-0 max-w-full truncate px-2.5 py-1 text-xs leading-none font-semibold shadow-2xs font-mono transition-all overflow-hidden border rounded-md inline-flex items-center gap-1.5',
                  getStatusColor(ticket.status),
                  errorFlashing && 'lt-error-pulse border-rose-500/80 bg-rose-500/25 text-rose-700 dark:text-rose-200 shadow-sm',
                  needsInputYellowFlashing && 'lt-needs-input-pulse border-amber-500/90 bg-amber-500/25 text-amber-800 dark:text-amber-200 shadow-sm',
                )}
                style={badgeProgressStyle}
              >
                {needsInputYellowFlashing && (
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-90" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500 shadow-xs" />
                  </span>
                )}
                {errorFlashing && (
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-90" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500 shadow-xs" />
                  </span>
                )}
                <span className="truncate">{statusLabel}</span>
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-center text-balance">
              {STATUS_DESCRIPTIONS[ticket.status] ?? statusLabel}
              {statusProgressPercent !== null && ` (${statusProgressPercent}% complete)`}
            </TooltipContent>
          </Tooltip>
          {ticket.status === 'COMPLETED' && ticket.completionDisposition && (
            <Badge variant="outline" className="shrink-0 text-[10px] font-mono px-2 py-0.5">
              {ticket.completionDisposition === 'merged' ? 'Merged' : 'Unmerged'}
            </Badge>
          )}
          {hasPendingAIQuestion && (
            <Badge variant="outline" className="shrink-0 text-[10px] font-mono px-2 py-0.5" style={{ borderColor: attentionColor, color: attentionColor }}>
              AI question {pendingAIQuestions}
            </Badge>
          )}
          {searchMatchLabel && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  tabIndex={0}
                  className="shrink-0 border-sky-500/30 bg-sky-500/10 text-[10px] text-sky-700 dark:text-sky-300 font-mono px-2 py-0.5"
                >
                  {searchMatchLabel}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-center text-balance">Dashboard search matched this field.</TooltipContent>
            </Tooltip>
          )}
          {ticket.status === 'CODING' && ticket.runtime?.eta && (
            <EtaRange eta={ticket.runtime.eta} />
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 text-[11px] font-mono text-muted-foreground/80 pl-1">
              {formatRelativeDateChip(ticket.updatedAt)}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-center text-balance">{new Date(ticket.updatedAt).toLocaleString()}</TooltipContent>
        </Tooltip>
      </div>
    </Card>
  )
}
