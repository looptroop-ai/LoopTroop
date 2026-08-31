import { useState, useEffect } from 'react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Loader2, AlertTriangle, ChevronUp, ChevronDown, ChevronsUp, ChevronsDown, Minus, HelpCircle } from 'lucide-react'
import { useUI } from '@/context/useUI'
import { useAIQuestions } from '@/context/useAIQuestions'
import { getStatusDescription, getStatusUserLabel } from '@/lib/workflowMeta'
import { resolveKanbanPhase } from '@shared/kanbanPhase'
import { isTerminalWorkflowStatus } from '@shared/workflowMeta'
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
    pendingQuestions?: {
      requestCount: number
      questionCount: number
      deadlineAt: string | null
      stoppedAt: string | null
    } | null
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
            <span className="inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-zinc-900 text-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 border border-zinc-800 dark:border-zinc-200 font-mono text-[10px] font-bold shadow-2xs whitespace-nowrap">
              <ChevronsUp className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
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
            <span className="inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-zinc-500/30 text-zinc-900 dark:text-zinc-100 border border-zinc-500/45 dark:border-zinc-400/45 font-mono text-[10px] font-bold shadow-2xs whitespace-nowrap">
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
            <span className="inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-zinc-500/20 text-zinc-700 dark:text-zinc-300 border border-zinc-500/30 dark:border-zinc-400/30 font-mono text-[10px] font-semibold whitespace-nowrap">
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
            <span className="inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-zinc-500/12 text-zinc-600 dark:text-zinc-400 border border-zinc-500/20 dark:border-zinc-500/20 font-mono text-[10px] font-medium whitespace-nowrap">
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
            <span className="inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-zinc-500/7 text-zinc-500 dark:text-zinc-400/80 border border-zinc-500/15 dark:border-zinc-500/15 font-mono text-[10px] font-medium whitespace-nowrap">
              <ChevronsDown className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
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
            <span className="inline-flex shrink-0 items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-zinc-500/20 text-zinc-700 dark:text-zinc-300 border border-zinc-500/30 dark:border-zinc-400/30 font-mono text-[10px] font-semibold whitespace-nowrap">
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
  const isTerminal = isTerminalWorkflowStatus(ticket.status)
  // The DTO decides, so the card and the column it sits in never disagree — the
  // live feed only reaches the ticket view, and an SSE frame refreshes the list
  // anyway.
  const hasPendingAIQuestion = (ticket.pendingQuestions?.requestCount ?? 0) > 0
  const kanbanPhase = resolveKanbanPhase(ticket.status, { hasPendingQuestion: hasPendingAIQuestion })
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
  const isNeedsInput = !isError && kanbanPhase === 'needs_input'
  // The status's own wait, ignoring any question — this is what keeps amber.
  const isStatusNeedsInput = !isError && resolveKanbanPhase(ticket.status) === 'needs_input'
  const needsInputFlashing = isNeedsInput && !!needsInputSignature
  // Questions, not models: "4 questions waiting" is what a person is answering.
  // The live count leads the polled list by a beat, so it wins when it has one.
  const pendingAIQuestions = getPendingCount(ticket.id) || ticket.pendingQuestions?.questionCount || 0
  const attentionColor = projectColor ?? '#1594a6'

  // Track "seen" state for BLOCKED_ERROR — stop flashing after first open
  const [errorSeen, setErrorSeen] = useState(() =>
    readErrorTicketSeen(ticket.id, errorSignature, ticket.errorSeenSignature),
  )

  // Track "seen" state for needs-input waits, questions included — stop flashing
  // after first open, and revert to the static project color even if the required
  // action was not performed.
  const [needsInputSeen, setNeedsInputSeen] = useState(() =>
    readNeedsInputSeen(ticket.id, needsInputSignature, ticket.needsInputSeenSignature),
  )

  // Both acknowledgments have to be re-read, not just cleared. A card stays mounted
  // for as long as its column does, so a `useState` initialiser answers the question
  // once and never again: a ticket that later starts a fresh wait — a beads approval,
  // a new question from a model — kept the acknowledgment of the *previous* wait and
  // never flashed. The signature is what changes when the wait does, so it belongs in
  // the dependencies.
  useEffect(() => {
    if (!isError) {
      if (errorSeen) {
        clearErrorTicketSeen(ticket.id)
        setErrorSeen(false)
      }
      return
    }
    setErrorSeen(readErrorTicketSeen(ticket.id, errorSignature, ticket.errorSeenSignature))
  }, [isError, ticket.id, errorSeen, errorSignature, ticket.errorSeenSignature])

  useEffect(() => {
    if (!isNeedsInput) {
      if (needsInputSeen) {
        clearNeedsInputSeen(ticket.id)
        setNeedsInputSeen(false)
      }
      return
    }
    setNeedsInputSeen(readNeedsInputSeen(ticket.id, needsInputSignature, ticket.needsInputSeenSignature))
  }, [isNeedsInput, ticket.id, needsInputSeen, needsInputSignature, ticket.needsInputSeenSignature])

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
  // Red beats amber beats sky: a failure outranks a wait, and a wait the status
  // itself declares outranks a question raised mid-step.
  const needsInputUnseen = needsInputFlashing && !needsInputSeen && !errorFlashing
  const needsInputYellowFlashing = needsInputUnseen && isStatusNeedsInput
  const questionFlashing = needsInputUnseen && !isStatusNeedsInput
  const statusProgressPercent = beadCompletionProgress?.percent ?? workflowRingProgress?.percent ?? null
  const hasUnseenAttention = errorFlashing || needsInputYellowFlashing || questionFlashing
  const isBlockedError = ticket.status === 'BLOCKED_ERROR'
  // The pulse says "this one is waiting on you" in colour alone, so the label
  // says it in words, and says which kind of wait it is. A question outranks a
  // status wait here even though amber outranks sky visually: it is the more
  // specific thing to act on, and in practice a paused status has no model
  // running to ask.
  const waitLabel = pendingAIQuestions > 0
    ? `${pendingAIQuestions} question${pendingAIQuestions === 1 ? '' : 's'} waiting for your answer`
    : isStatusNeedsInput
      ? 'waiting for your input'
      : null
  const badgeProgressStyle = statusProgressPercent !== null && !hasUnseenAttention && !isBlockedError ? {
    background: `linear-gradient(90deg, color-mix(in srgb, var(--color-brand-500) 16%, transparent) 0%, color-mix(in srgb, var(--color-brand-500) 16%, transparent) ${statusProgressPercent}%, color-mix(in srgb, var(--color-muted) 60%, transparent) ${statusProgressPercent}%, color-mix(in srgb, var(--color-muted) 60%, transparent) 100%)`,
    borderColor: `color-mix(in srgb, var(--color-brand-500) 28%, var(--color-border))`,
  } : undefined

  return (
    <Card
      data-ticket-card={ticket.externalId}
      className="group relative min-w-0 max-w-full cursor-pointer overflow-hidden p-3.5 transition-all duration-200 rounded-xl border border-border/70 bg-card hover:bg-accent/40 hover:shadow-md hover:border-border hover:-translate-y-0.5 active:scale-[0.99]"
      onClick={handleClick}
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
        {/*
          The card is a `<div>`, so its click handler was reachable by mouse only. The
          title carries the action instead — a real button, so Tab reaches it and Enter
          and Space open the ticket. `role="button"` on the card itself would have been
          invalid ARIA: the card holds its own interactive descendants, which a screen
          reader then either hides or mis-announces as part of one control. Clicking the
          card anywhere still works, through the handler above.
        */}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            handleClick()
          }}
          // The visible title leads the accessible name. An `aria-label` that replaced it
          // left a screen reader announcing the id and never the ticket, and left speech
          // input with no name matching the words on screen.
          aria-label={`${ticket.title}, open ticket ${getTicketExternalIdLabel(ticket.externalId, ticket.isDisplayOnlyMock)}${waitLabel ? `, ${waitLabel}` : ''}`}
          className="min-w-0 break-words text-left text-sm font-semibold tracking-tight text-foreground leading-snug [overflow-wrap:anywhere] group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
        >
          {ticket.title}
        </button>
        <div className="flex shrink-0 items-center gap-1.5 ml-2">
          <PriorityArrows priority={ticket.priority} />
          {isInProgress && <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-500" />}
          {pendingAIQuestions > 0 && <HelpCircle className="h-3.5 w-3.5" style={{ color: attentionColor }} />}
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
                  questionFlashing && 'lt-question-pulse border-sky-500/90 bg-sky-500/20 text-sky-800 dark:text-sky-200 shadow-sm',
                )}
                style={badgeProgressStyle}
              >
                {needsInputYellowFlashing && (
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-90" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500 shadow-xs" />
                  </span>
                )}
                {questionFlashing && (
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-90" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-sky-500 shadow-xs" />
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
              {getStatusDescription(ticket.status) ?? statusLabel}
              {statusProgressPercent !== null && ` (${statusProgressPercent}% complete)`}
            </TooltipContent>
          </Tooltip>
          {ticket.status === 'COMPLETED' && ticket.completionDisposition && (
            <Badge variant="outline" className="shrink-0 text-[10px] font-mono px-2 py-0.5">
              {ticket.completionDisposition === 'merged' ? 'Merged' : 'Unmerged'}
            </Badge>
          )}
          {pendingAIQuestions > 0 && (
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
