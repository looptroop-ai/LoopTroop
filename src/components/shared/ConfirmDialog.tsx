import { useEffect, useRef, useSyncExternalStore } from 'react'
import { AlertTriangle, CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { CONFIRM_DIALOG_Z_INDEX } from '@/lib/constants'
import { getPendingConfirm, settleAllConfirms, settleConfirm, subscribeConfirm } from '@/lib/confirmDialog'

const LAYER = { zIndex: CONFIRM_DIALOG_Z_INDEX }

/** Draws the request made through `confirmDialog`/`alertDialog`. Mount once. */
export function ConfirmDialogHost() {
  const current = useSyncExternalStore(subscribeConfirm, getPendingConfirm, getPendingConfirm)
  const safeButtonRef = useRef<HTMLButtonElement>(null)
  const danger = current?.tone === 'danger'
  const Icon = current?.alert ? CircleAlert : AlertTriangle

  // A host that goes away must not leave a caller awaiting an answer nobody can give,
  // nor bring a stale question back when it mounts again.
  useEffect(() => settleAllConfirms, [])

  return (
    <Dialog open={current !== null} onOpenChange={(open) => { if (!open) settleConfirm(false) }}>
      {current && (
        <DialogContent
          // A new request remounts the content, so focus lands on its safe button
          // instead of staying on the previous request's (maybe destructive) one.
          key={current.id}
          role="alertdialog"
          aria-modal="true"
          closeButtonVariant="dashboard"
          style={LAYER}
          overlayStyle={LAYER}
          overlayClassName="backdrop-blur-[1px]"
          // Capped to the viewport; the message scrolls while the title and answers stay in view.
          className="max-h-[calc(100dvh-2rem)] max-w-md flex flex-col gap-0 overflow-y-auto p-0 sm:p-0 rounded-xl shadow-xl"
          // The safe answer, stated rather than left to DOM order: Cancel for a
          // question, OK for a message.
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            safeButtonRef.current?.focus()
          }}
          // Nothing triggered this dialog, so Radix has nowhere to return focus to.
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (current.opener?.isConnected) current.opener.focus()
          }}
          // A message must be read: a stray click outside does not dismiss it.
          onPointerDownOutside={(event) => { if (current.alert) event.preventDefault() }}
        >
          <div className="flex shrink-0 items-start gap-3 px-6 pt-6 pr-14">
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                danger ? 'bg-rose-500/10 text-rose-500' : 'bg-primary/10 text-primary',
              )}
            >
              <Icon className="h-5 w-5" />
            </span>
            <DialogHeader className="min-w-0 space-y-1.5 text-left">
              <DialogTitle className="leading-snug">{current.title}</DialogTitle>
            </DialogHeader>
          </div>
          <div tabIndex={0} className="min-h-24 flex-1 overflow-y-auto px-6 pb-2 pl-[4.5rem]">
            <DialogDescription className="whitespace-pre-wrap break-words leading-relaxed">{current.message}</DialogDescription>
          </div>
          <div className="mt-6 flex shrink-0 justify-end gap-2.5 border-t border-border bg-muted/30 px-6 py-4 rounded-b-xl">
            {!current.alert && (
              <Button
                ref={safeButtonRef}
                variant="outline"
                size="sm"
                onClick={() => settleConfirm(false)}
                className="rounded-lg border-border/70 bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground active:scale-[0.98] font-mono text-xs font-medium transition-all"
              >
                {current.cancelLabel ?? 'Cancel'}
              </Button>
            )}
            <Button
              ref={current.alert ? safeButtonRef : undefined}
              // Red only when this button is the risky answer; an error message's OK is not.
              variant={danger && !current.alert ? 'destructive' : 'default'}
              size="sm"
              onClick={() => settleConfirm(true)}
              className={cn(
                'rounded-lg active:scale-[0.98] shadow-xs font-mono text-xs font-semibold transition-all',
                danger && !current.alert && 'bg-rose-500 text-white hover:bg-rose-600',
              )}
            >
              {current.confirmLabel ?? 'OK'}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
