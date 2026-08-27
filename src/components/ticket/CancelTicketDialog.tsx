import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useCancelTicket } from '@/hooks/useTickets'
import { SkipReasonField } from '@/components/workspace/SkipReasonField'

interface CancelTicketDialogProps {
  ticketId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CancelTicketDialog({ ticketId, open, onOpenChange }: CancelTicketDialogProps) {
  const { mutate: cancelTicket, isPending } = useCancelTicket()
  const [deleteContent, setDeleteContent] = useState(false)
  const [deleteLog, setDeleteLog] = useState(false)
  const [deleteTicket, setDeleteTicket] = useState(false)
  const [reason, setReason] = useState('')

  const close = () => {
    onOpenChange(false)
    setDeleteContent(false)
    setDeleteLog(false)
    setDeleteTicket(false)
    setReason('')
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => nextOpen ? onOpenChange(true) : close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel Ticket</DialogTitle>
          <DialogDescription className="sr-only">
            Confirm cancellation and choose optional cleanup actions.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The ticket will be stopped and moved to Canceled. No further AI execution will occur.
          Artifacts generated up to this point are preserved by default.
        </p>
        <div className="mt-3 space-y-3">
          <label className={`flex items-start gap-3 cursor-pointer group ${deleteTicket ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''}`}>
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border border-border bg-background accent-destructive cursor-pointer disabled:cursor-not-allowed"
              checked={deleteTicket || deleteContent}
              disabled={deleteTicket}
              onChange={(event) => setDeleteContent(event.target.checked)}
              data-testid="delete-content-checkbox"
            />
            <span className="text-sm leading-snug text-muted-foreground group-hover:text-foreground transition-colors">
              <span className="font-medium text-foreground">Delete AI-generated artifacts and worktree</span>
              <br />
              Permanently removes all AI-generated content stored for this ticket — interview questions and answers, PRD drafts, beads plan entries — and deletes the isolated git worktree including its branch and any code written to it. This cannot be undone.
            </span>
          </label>
          <label className={`flex items-start gap-3 cursor-pointer group ${deleteTicket ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''}`}>
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border border-border bg-background accent-destructive cursor-pointer disabled:cursor-not-allowed"
              checked={deleteTicket || deleteLog}
              disabled={deleteTicket}
              onChange={(event) => setDeleteLog(event.target.checked)}
              data-testid="delete-log-checkbox"
            />
            <span className="text-sm leading-snug text-muted-foreground group-hover:text-foreground transition-colors">
              <span className="font-medium text-foreground">Delete execution log</span>
              <br />
              Permanently removes both persisted execution logs: the normal phase log and the debug/forensic log. The log viewer will show no history for this ticket after deletion.
            </span>
          </label>
          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border border-border bg-background accent-destructive cursor-pointer"
              checked={deleteTicket}
              onChange={(event) => setDeleteTicket(event.target.checked)}
              data-testid="delete-ticket-checkbox"
            />
            <span className="text-sm leading-snug text-muted-foreground group-hover:text-foreground transition-colors">
              <span className="font-medium text-foreground">Delete the ticket completely</span>
              <br />
              Permanently deletes the ticket record from the database and removes all related files on disk. The ticket will be completely erased and will no longer appear in the UI.
            </span>
          </label>
        </div>
        <div className="mt-4">
          <SkipReasonField
            label="Why cancel"
            value={reason}
            onChange={setReason}
            disabled={isPending || deleteTicket}
            help={deleteTicket
              ? 'Deleting the ticket removes everything, including this.'
              : 'Kept on the ticket even if you delete its artifacts.'}
          />
        </div>
        <div className="flex justify-end gap-2.5 mt-4">
          <Button variant="outline" size="sm" onClick={close} className="rounded-lg border-border/70 bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground active:scale-[0.98] font-mono text-xs font-medium transition-all">
            Keep Ticket
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={isPending}
            onClick={() => {
              cancelTicket({
                id: ticketId,
                options: {
                  deleteContent: deleteTicket || deleteContent,
                  deleteLog: deleteTicket || deleteLog,
                  deleteTicket,
                  ...(deleteTicket ? {} : { reason }),
                },
              })
              close()
            }}
            className="rounded-lg bg-rose-500 text-white hover:bg-rose-600 active:scale-[0.98] shadow-xs font-mono text-xs font-semibold transition-all"
          >
            {deleteTicket ? 'Yes, Delete Ticket' : 'Yes, Cancel Ticket'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
