import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ExistingProjectPreview, ExistingStateAction } from '@/hooks/useProjects'

interface ExistingProjectActionDialogProps {
  open: boolean
  action: Exclude<ExistingStateAction, 'restore'>
  project: ExistingProjectPreview
  nextShortname: string
  isPending: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ExistingProjectActionDialog({
  open,
  action,
  project,
  nextShortname,
  isPending,
  onCancel,
  onConfirm,
}: ExistingProjectActionDialogProps) {
  const clearsTickets = action === 'clear_tickets'
  const title = clearsTickets ? 'Clear all tickets and attach?' : 'Delete existing state and start fresh?'
  const confirmLabel = clearsTickets ? 'Clear Tickets & Attach' : 'Start Fresh'

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !isPending) onCancel() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            {title}
          </DialogTitle>
          <DialogDescription>
            Review what LoopTroop will permanently remove before continuing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <p className="font-medium text-foreground">
              {project.ticketCount} {project.ticketCount === 1 ? 'ticket' : 'tickets'} will be deleted
              {project.activeTicketCount > 0 && (
                <span className="text-destructive">
                  , including {project.activeTicketCount} active
                </span>
              )}
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              <li>Ticket workflow data, attempts, logs, artifacts, and managed worktrees will be removed.</li>
              <li>
                The ticket counter resets to 0; the next ticket will be{' '}
                <span className="font-mono">{nextShortname}-1</span>.
              </li>
              <li>Existing Git branches are not deleted, so an old branch may use the same ticket ID.</li>
              <li>Your repository source files, commits, and remote branches are not changed.</li>
            </ul>
          </div>

          <div className="rounded-lg border border-border p-4 text-sm">
            <p className="font-medium">
              {clearsTickets ? 'Project settings kept' : 'New project settings used'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {clearsTickets
                ? `LoopTroop keeps the ${project.shortname} project identity, appearance, creation time, and project-level overrides. Current form edits are applied.`
                : 'The entire .looptroop state folder, including its saved project metadata, will be deleted and recreated from the current form.'}
            </p>
          </div>

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirm} disabled={isPending}>
              {isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-4 w-4" />
              )}
              {confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
