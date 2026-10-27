import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useUI } from '@/context/useUI'
import { useDeleteTicket, type Ticket } from '@/hooks/useTickets'
import { TicketExternalId } from '@/components/ticket/TicketExternalId'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

interface TerminalTicketDeleteProps {
  ticket: Ticket
  statusLabel: 'completed' | 'canceled'
  buttonLabel?: string
  buttonTitle?: string
  buttonVariant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
  buttonSize?: 'default' | 'sm' | 'lg' | 'icon'
  buttonClassName?: string
}

export function TerminalTicketDelete({
  ticket,
  statusLabel,
  buttonLabel = 'Delete Ticket',
  buttonTitle,
  buttonVariant = 'destructive',
  buttonSize = 'sm',
  buttonClassName,
}: TerminalTicketDeleteProps) {
  const { dispatch } = useUI()
  const [isOpen, setIsOpen] = useState(false)
  const { mutate: deleteTicket, isPending, error, reset } = useDeleteTicket()

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) reset()
    setIsOpen(nextOpen)
  }

  const handleDelete = () => {
    deleteTicket(ticket.id, {
      onSuccess: () => {
        handleOpenChange(false)
        dispatch({ type: 'CLOSE_TICKET' })
      },
    })
  }

  return (
    <>
      <Tooltip>
            <TooltipTrigger asChild>
              <Button
                  variant={buttonVariant}
                  size={buttonSize}
                  onClick={() => handleOpenChange(true)}
                  className={cn('gap-1.5 shrink-0', buttonClassName)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{buttonLabel}</span>
                </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-center text-balance">{buttonTitle}</TooltipContent>
          </Tooltip>

      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Ticket</DialogTitle>
            <DialogDescription>
              Permanently delete <TicketExternalId
                externalId={ticket.externalId}
                isDisplayOnlyMock={ticket.isDisplayOnlyMock}
              />. This removes the {statusLabel} ticket from all stored
              state, including logs, artifacts, cached UI state, its worktree data, and dedicated assistant conversations.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p className="font-medium">{ticket.title}</p>
            <p className="mt-1 text-muted-foreground">This action cannot be undone.</p>
          </div>

          {error instanceof Error && (
            <p className="text-sm text-destructive">{error.message}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)} disabled={isPending}>
              Keep Ticket
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={isPending}>
              {isPending ? 'Deleting…' : 'Delete Permanently'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
