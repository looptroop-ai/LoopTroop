import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { LoadingText } from '@/components/ui/LoadingText'
import { CollapsiblePhaseLogSection } from '@/components/workspace/CollapsiblePhaseLogSection'
import type { Ticket } from '@/hooks/useTickets'
import { DraftOverview } from './DraftOverview'
import { DraftAdvancedSettings } from './DraftAdvancedSettings'
import { DraftDescriptionSection } from './DraftDescriptionSection'
import { useDraftActions, useDraftContext, useDraftDescription } from './useDraftView'

interface DraftViewProps {
  ticket: Ticket
}

export const DraftView = ({ ticket }: DraftViewProps) => {
  const context = useDraftContext(ticket)
  const [hasAiQuestionWaitError, setHasAiQuestionWaitError] = useState(false)
  const actions = useDraftActions(ticket, hasAiQuestionWaitError || context.isLoading)
  const description = useDraftDescription(ticket, actions)

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col items-center gap-4 max-w-3xl mx-auto w-full">
          <DraftOverview ticket={ticket} context={context} />
          <DraftAdvancedSettings ticket={ticket} context={context} actions={actions} hasWaitError={hasAiQuestionWaitError} onWaitValidationChange={setHasAiQuestionWaitError} />
          <DraftDescriptionSection draft={description} />
        </div>
      </div>

      {actions.isStartAttemptActive && (
        <div className="shrink-0 bg-background px-4 pb-3">
          <CollapsiblePhaseLogSection phase="DRAFT" ticket={ticket} variant="bottom" defaultHeight={220} />
        </div>
      )}

      <div className="shrink-0 border-t border-border bg-background p-4 flex flex-col items-center justify-center gap-2">
        <Button size="lg" onClick={actions.handleStart} disabled={actions.isStartDisabled} className="w-auto">
          {actions.isStarting ? <LoadingText text="Starting" /> : '🚀 Start Ticket'}
        </Button>
        {actions.startError && (
          <p role="alert" aria-live="polite" className="max-w-md text-center text-xs text-destructive">{actions.startError}</p>
        )}
      </div>
    </div>
  )
}
