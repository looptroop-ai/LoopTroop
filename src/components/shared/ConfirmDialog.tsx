import { useSyncExternalStore } from 'react'
import { AlertTriangle, CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { getPendingConfirm, settleConfirm, subscribeConfirm } from '@/lib/confirmDialog'

/** Draws the request made through `confirmDialog`/`alertDialog`. Mount once. */
export function ConfirmDialogHost() {
  const current = useSyncExternalStore(subscribeConfirm, getPendingConfirm, getPendingConfirm)
  const danger = current?.tone === 'danger'
  const Icon = current?.alert ? CircleAlert : AlertTriangle

  return (
    <Dialog open={current !== null} onOpenChange={(open) => { if (!open) settleConfirm(false) }}>
      {current && (
        <DialogContent
          // A new request remounts the content, so focus lands on its safe button
          // instead of staying on the previous request's (maybe destructive) one.
          key={current.id}
          role="alertdialog"
          closeButtonVariant="dashboard"
          // Above every other overlay: it is always asked from inside one of them.
          className="z-[110] max-w-md gap-0 p-0 sm:p-0 rounded-xl shadow-xl"
          overlayClassName="z-[110] backdrop-blur-[1px]"
        >
          <DialogHeader className="flex-row items-start gap-3 space-y-0 px-6 pt-6 pr-14 text-left">
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                danger ? 'bg-rose-500/10 text-rose-500' : 'bg-primary/10 text-primary',
              )}
            >
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 space-y-1.5">
              <DialogTitle className="leading-snug">{current.title}</DialogTitle>
              <DialogDescription className="leading-relaxed">{current.message}</DialogDescription>
            </div>
          </DialogHeader>
          <div className="mt-6 flex justify-end gap-2.5 border-t border-border bg-muted/30 px-6 py-4 rounded-b-xl">
            {!current.alert && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => settleConfirm(false)}
                className="rounded-lg border-border/70 bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground active:scale-[0.98] font-mono text-xs font-medium transition-all"
              >
                {current.cancelLabel ?? 'Cancel'}
              </Button>
            )}
            <Button
              variant={danger ? 'destructive' : 'default'}
              size="sm"
              onClick={() => settleConfirm(true)}
              className={cn(
                'rounded-lg active:scale-[0.98] shadow-xs font-mono text-xs font-semibold transition-all',
                danger && 'bg-rose-500 text-white hover:bg-rose-600',
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
