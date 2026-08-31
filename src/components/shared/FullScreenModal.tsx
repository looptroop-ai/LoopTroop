import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useDialogFocus } from '@/hooks/useDialogFocus'

interface FullScreenModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}

export function FullScreenModal({ open, onClose, title, children }: FullScreenModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const handleTrapKeyDown = useDialogFocus(open, panelRef)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={handleTrapKeyDown}
      className="fixed inset-0 z-[60] bg-background flex flex-col outline-none"
    >
      <Tooltip>
            <TooltipTrigger asChild>
              <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="absolute top-3 right-3 z-10 flex items-center justify-center h-8 w-8 rounded-md border border-border bg-muted text-foreground hover:bg-destructive hover:text-white hover:border-destructive transition-colors"
                >
                  <X className="h-4 w-4" strokeWidth={2.5} />
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-center text-balance">Close window (Esc)</TooltipContent>
          </Tooltip>
      <div className="flex items-center border-b border-border px-6 py-4 pr-10">
        <h2 id={titleId} className="text-lg font-semibold text-foreground">{title}</h2>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {children}
      </div>
    </div>,
    document.body
  )
}
