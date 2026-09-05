import { Separator } from '@/components/ui/separator'
import { PhaseTimeline } from '@/components/navigator/PhaseTimeline'
import { ContextTree } from '@/components/navigator/ContextTree'
import { ApprovalNavigator } from '@/components/navigator/ApprovalNavigator'
import { ErrorOccurrencesPanel } from '@/components/navigator/ErrorOccurrencesPanel'
import { ScrollText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Ticket } from '@/hooks/useTickets'

interface NavigatorPanelProps {
  ticketId: string
  ticket: Ticket
  currentStatus: string
  selectedPhase: string
  selectedErrorOccurrenceId?: string | null
  reviewCutoffStatus?: string
  previousStatus?: string
  fullLogOpen?: boolean
  onSelectPhase: (phase: string | null) => void
  onSelectErrorOccurrence: (occurrenceId: string | null) => void
  onOpenFullLog?: () => void
  contextPhase: string
}

export function NavigatorPanel({
  ticketId,
  ticket,
  currentStatus,
  selectedPhase,
  selectedErrorOccurrenceId,
  reviewCutoffStatus,
  previousStatus,
  fullLogOpen,
  onSelectPhase,
  onSelectErrorOccurrence,
  onOpenFullLog,
  contextPhase,
}: NavigatorPanelProps) {
  const isApprovalNavigatorPhase = contextPhase === 'WAITING_INTERVIEW_APPROVAL'
    || contextPhase === 'WAITING_PRD_APPROVAL'
    || contextPhase === 'WAITING_BEADS_APPROVAL'
    || contextPhase === 'WAITING_EXECUTION_SETUP_APPROVAL'

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-hidden">
          <PhaseTimeline
            ticket={ticket}
            currentStatus={currentStatus}
            reviewCutoffStatus={reviewCutoffStatus}
            previousStatus={previousStatus}
            onSelectPhase={(phase) => onSelectPhase(phase === currentStatus ? null : phase)}
            selectedPhase={selectedPhase}
            showBlockedErrorPhase={false}
            footer={(
              <div className="space-y-2">
                <Separator />
                <ErrorOccurrencesPanel
                  ticket={ticket}
                  selectedErrorOccurrenceId={selectedErrorOccurrenceId}
                  onSelectErrorOccurrence={onSelectErrorOccurrence}
                />
              </div>
            )}
          />
          {isApprovalNavigatorPhase ? (
            <ApprovalNavigator ticketId={ticketId} phase={contextPhase} />
          ) : null}
        </div>
        {(selectedPhase !== currentStatus || Boolean(selectedErrorOccurrenceId) || fullLogOpen) && (
          <div className="sticky bottom-0 border-t border-border bg-background p-2">
            <button
              onClick={() => {
                onSelectPhase(null)
                onSelectErrorOccurrence(null)
              }}
              className="text-xs text-blue-500 hover:underline w-full text-center"
            >
              ← Back to live
            </button>
          </div>
        )}
      </div>
      {selectedPhase !== 'DRAFT' && currentStatus !== 'DRAFT' && (
        <>
          <Separator />
          <button
            type="button"
            onClick={onOpenFullLog}
            className={cn(
              'w-full flex items-center gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors',
              fullLogOpen
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
            )}
          >
            <ScrollText className="h-3.5 w-3.5" />
            Full Log
          </button>
          {!fullLogOpen && (
            <ContextTree selectedPhase={contextPhase} />
          )}
        </>
      )}
    </div>
  )
}
