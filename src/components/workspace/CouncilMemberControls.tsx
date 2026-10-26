import { LoaderCircle, MessageSquarePlus, RotateCcw, Square, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import type { CouncilMemberControlAction } from '@/hooks/useCouncilMemberControl'
import { describeQueryError } from '@/lib/fetchError'
import { cn } from '@/lib/utils'
import {
  useCouncilMemberConfirmation,
  type CouncilMemberConfirmation,
  type CouncilMemberControl,
  type CouncilMemberControlScope,
} from './councilMemberControl'

// RotateCcw rather than RefreshCw: the spinning RefreshCw already means "refining".
// The hints stay general: what a stop or retry does here depends on the round,
// and the confirmation says it.
type CouncilMemberButtonAction = CouncilMemberControlAction | 'retry_with_note'
const ACTIONS: Record<CouncilMemberButtonAction, { label: string; hint: string; Icon: LucideIcon }> = {
  stop: { label: 'Stop', hint: 'Stop this model.', Icon: Square },
  retry: { label: 'Retry', hint: 'Run this model again.', Icon: RotateCcw },
  retry_with_note: { label: 'Retry with extra note', hint: 'Restart this model with your guidance in a new session.', Icon: MessageSquarePlus },
}

export function CouncilMemberControlButton({ action, memberId, onClick, disabled, iconOnly = false }: {
  action: CouncilMemberButtonAction
  memberId: string
  onClick: () => void
  disabled?: boolean
  /** For a badge, where a word would not fit. */
  iconOnly?: boolean
}) {
  const { label, hint, Icon } = ACTIONS[action]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${label} ${getModelDisplayName(memberId)}`}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            'gap-1 text-[11px] font-normal text-muted-foreground hover:text-foreground [&_svg]:size-3',
            // 24px: the smallest pointer target WCAG 2.2 AA accepts.
            iconOnly ? 'h-6 w-6 px-0' : 'h-6 px-1.5',
          )}
        >
          <Icon aria-hidden="true" />
          {iconOnly ? null : <span className="hidden sm:inline">{label}</span>}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The open confirmation, or what the last stop turned out to be.
 *
 * Inline rather than a toast or a second dialog: it opens inside a dialog, and
 * toasts render under the dialog's overlay.
 */
export function CouncilMemberConfirmStrip({ confirmation, control }: {
  confirmation: CouncilMemberConfirmation
  /** The controls of the model the open confirmation is about. */
  control: CouncilMemberControl | null
}) {
  const { request } = confirmation
  const error = describeQueryError(confirmation.error)
  if (request && control) {
    const copy = request.action === 'stop' ? control.stop : control.retry
    return (
      <div role="group" aria-label={copy.question} className="space-y-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
        <p>
          <span className="font-medium text-foreground">{copy.question}</span>{' '}
          <span className="text-muted-foreground">{copy.consequence}</span>
        </p>
        {copy.warning ? <p className="text-amber-700 dark:text-amber-400">{copy.warning}</p> : null}
        {request.action === 'retry' && request.note !== undefined ? (
          <div className="space-y-1">
            <p className="text-muted-foreground">This model starts a new session with the saved inputs and your note unchanged. Other council models keep their work.</p>
            <label className="block space-y-1">
              <span>Extra note</span>
              <textarea
                value={request.note}
                onChange={(event) => confirmation.updateNote(event.target.value.slice(0, 20_000))}
                maxLength={20_000}
                required
                disabled={confirmation.isPending}
                className="block min-h-24 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs disabled:opacity-50"
              />
            </label>
            <p className="text-right text-muted-foreground">{request.note.length.toLocaleString()} / 20,000 characters</p>
          </div>
        ) : null}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" className="h-7" disabled={confirmation.isPending} onClick={confirmation.cancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={copy.destructive ? 'destructive' : 'default'}
            size="sm"
            className="h-7"
            disabled={confirmation.isPending || (request.note !== undefined && !request.note.trim())}
            onClick={confirmation.confirm}
          >
            {confirmation.isPending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
            {request.note !== undefined ? 'Add note and retry model' : copy.confirmLabel}
          </Button>
        </div>
      </div>
    )
  }
  // The round ended under the request: the buttons are gone, but a refusal
  // still has to reach the person who confirmed it.
  if (error) return <p role="alert" className="text-xs text-destructive">{error}</p>
  return confirmation.notice
    ? <p role="status" className="text-xs text-muted-foreground">{confirmation.notice}</p>
    : null
}

/**
 * Stop and Retry for the model a drafting step's member dialog shows: small
 * buttons in the header's top right, left of the close button, and the
 * confirmation under the header.
 *
 * Stays mounted after the round ends (`control` null, no buttons), so the
 * notice about a stop the model beat, or a refusal, is still there to read
 * for as long as the dialog is.
 */
export function CouncilMemberDialogControls({ scope, control }: {
  scope: CouncilMemberControlScope
  control: CouncilMemberControl | null
}) {
  const confirmation = useCouncilMemberConfirmation(scope)
  return (
    <>
      {control ? (
        // The close button sits at right-4 top-4 and is 16px wide.
        <div className="absolute right-11 top-3 flex items-center gap-0.5">
          {control.canStop ? (
            <CouncilMemberControlButton
              action="stop"
              memberId={control.memberId}
              disabled={confirmation.isPending}
              onClick={() => confirmation.open({ action: 'stop', memberId: control.memberId })}
            />
          ) : null}
          <CouncilMemberControlButton
            action="retry"
            memberId={control.memberId}
            disabled={confirmation.isPending}
            onClick={() => confirmation.open({ action: 'retry', memberId: control.memberId, part: control.part })}
          />
          <CouncilMemberControlButton
            iconOnly
            action="retry_with_note"
            memberId={control.memberId}
            disabled={confirmation.isPending}
            onClick={() => confirmation.open({ action: 'retry', memberId: control.memberId, part: control.part, note: '' })}
          />
        </div>
      ) : null}
      <CouncilMemberConfirmStrip confirmation={confirmation} control={control} />
    </>
  )
}
