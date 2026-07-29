import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { CalendarDays, Loader2, Sparkles } from 'lucide-react'
import { PhaseArtifactsPanel } from './PhaseArtifactsPanel'
import { CollapsiblePhaseLogSection } from './CollapsiblePhaseLogSection'
import { useTicketArtifacts } from '@/hooks/useTicketArtifacts'
import { PhaseAttemptSelector } from './PhaseAttemptSelector'
import { useTicketPhaseAttempts } from '@/hooks/useTicketPhaseAttempts'

import type { Ticket } from '@/hooks/useTickets'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TicketDescriptionTabs, type TicketDescriptionMode } from '@/components/ticket/TicketDescriptionTabs'
import { CopyButton } from './RawTextDisplay'
import { TicketDescriptionViewer } from '@/components/ticket/TicketDescriptionViewer'

const PRIORITY_LABELS: Record<number, string> = { 1: 'Very High', 2: 'High', 3: 'Normal', 4: 'Low', 5: 'Very Low' }

interface PhaseReviewViewProps {
  phase: string
  ticket: Ticket
}

export function PhaseReviewView({ phase, ticket }: PhaseReviewViewProps) {
  const councilMemberNames = useMemo(
    () => ticket.lockedCouncilMembers.filter((memberId) => memberId.trim().length > 0),
    [ticket.lockedCouncilMembers],
  )
  const councilMemberCount = councilMemberNames.length || 3
  const isDraft = phase === 'DRAFT'
  const isExecutionSetupDraft = phase === 'GENERATING_EXECUTION_SETUP_PLAN'
  const [descriptionMode, setDescriptionMode] = useState<TicketDescriptionMode>('markdown')
  const { data: attempts = [] } = useTicketPhaseAttempts(ticket.id, phase)
  const [manualSelectedAttemptNumber, setManualSelectedAttemptNumber] = useState<number | null>(null)
  const selectedAttemptNumber = useMemo(() => {
    if (manualSelectedAttemptNumber != null && attempts.some((attempt) => attempt.attemptNumber === manualSelectedAttemptNumber)) {
      return manualSelectedAttemptNumber
    }
    return (attempts.find((attempt) => attempt.state === 'active') ?? attempts[0])?.attemptNumber ?? null
  }, [attempts, manualSelectedAttemptNumber])
  const selectedAttempt = useMemo(
    () => attempts.find((attempt) => attempt.attemptNumber === selectedAttemptNumber)
      ?? attempts.find((attempt) => attempt.state === 'active')
      ?? attempts[0]
      ?? null,
    [attempts, selectedAttemptNumber],
  )
  const archivedAttemptNumber = selectedAttempt?.state === 'archived' ? selectedAttempt.attemptNumber : undefined
  const logPhaseAttempt = attempts.length > 1 ? selectedAttempt?.attemptNumber : undefined
  const logMode = archivedAttemptNumber != null ? 'snapshot' : 'live'
  const artifactQueryOptions = archivedAttemptNumber != null
    ? { phase, phaseAttempt: archivedAttemptNumber }
    : isExecutionSetupDraft
      ? { phase }
      : undefined
  const { artifacts: preloadedArtifacts, isLoading: isLoadingArtifacts } = useTicketArtifacts(ticket.id, artifactQueryOptions)

  if (isLoadingArtifacts && !isExecutionSetupDraft) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <p className="text-xs text-muted-foreground">Loading phase data…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-4 space-y-3 shrink-0">
        {attempts.length > 1 ? (
          <PhaseAttemptSelector
            attempts={attempts}
            value={selectedAttempt?.attemptNumber ?? attempts[0]!.attemptNumber}
            onChange={setManualSelectedAttemptNumber}
          />
        ) : null}
        {isExecutionSetupDraft && ticket.status === phase && selectedAttempt?.state !== 'archived' ? (
          <div className="rounded-xl border border-blue-300/70 bg-blue-50/70 p-4 text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-100">
            <div className="flex items-start gap-3">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  Drafting the workspace setup plan
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label="Drafting in progress" />
                </div>
                <p className="mt-1 text-xs leading-5">
                  LoopTroop is auditing the approved implementation plan and pre-flight evidence, then producing a reviewable setup contract. The plan and its generation report appear below when ready.
                </p>
              </div>
            </div>
          </div>
        ) : null}
        {!isDraft && (
          <PhaseArtifactsPanel
            phase={phase}
            isCompleted={selectedAttempt?.state === 'archived' || ticket.status !== phase}
            ticketId={ticket.id}
            councilMemberCount={councilMemberCount}
            councilMemberNames={councilMemberNames.length > 0 ? councilMemberNames : undefined}
            preloadedArtifacts={preloadedArtifacts}
          />
        )}
      </div>

      {isDraft ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="shrink-0 px-4 pb-4">
            <div className="max-w-lg mx-auto space-y-4">
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <Badge variant="outline">
                  P{ticket.priority} — {PRIORITY_LABELS[ticket.priority] ?? 'Normal'}
                </Badge>
                <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="flex items-center gap-1 text-muted-foreground">
                                                <CalendarDays className="h-3.5 w-3.5" />
                                                Created {new Date(ticket.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                              </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs text-center text-balance">{new Date(ticket.createdAt).toLocaleString()}</TooltipContent>
                              </Tooltip>
              </div>
              {ticket.description && (
                <div className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-xs font-medium">Description</h4>
                    <div className="flex items-center gap-1.5">
                      <TicketDescriptionTabs mode={descriptionMode} onModeChange={setDescriptionMode} />
                      {descriptionMode === 'raw' && (
                        <CopyButton content={ticket.description} title="Copy description" />
                      )}
                    </div>
                  </div>
                  <div className="mt-2 max-h-[300px] overflow-y-auto">
                    {descriptionMode === 'markdown' ? (
                      <TicketDescriptionViewer description={ticket.description} className="text-xs" />
                    ) : (
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{ticket.description}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <CollapsiblePhaseLogSection
            phase={phase}
            phaseAttempt={logPhaseAttempt}
            logMode={logMode}
            ticket={ticket}
            className="px-4 pb-4"
          />
        </div>
      ) : (
        <CollapsiblePhaseLogSection
          key={`${phase}:${selectedAttempt?.attemptNumber ?? 'active'}`}
          phase={phase}
          phaseAttempt={logPhaseAttempt}
          logMode={logMode}
          ticket={ticket}
          defaultExpanded={isExecutionSetupDraft}
          className="px-4 pb-4"
        />
      )}
    </div>
  )
}
