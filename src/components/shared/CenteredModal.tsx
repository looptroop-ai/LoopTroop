import { useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useDialogFocus } from '@/hooks/useDialogFocus'
import { isEscapeClaimedByNestedOverlay } from '@/lib/overlays'

interface CenteredModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  maxWidth?: string
  closeDisabled?: boolean
  zIndexClass?: string
}

export function CenteredModal({
  open,
  onClose,
  title,
  children,
  maxWidth = 'max-w-2xl',
  closeDisabled = false,
  zIndexClass = 'z-50',
}: CenteredModalProps) {
  const [isSessionDirty, setIsSessionDirty] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const handleTrapKeyDown = useDialogFocus(open, panelRef)

  useEffect(() => {
    if (open) {
      setIsSessionDirty(false)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (closeDisabled) return
      if (e.key === 'Escape') {
        // Escape belongs to the innermost overlay. Without this, dismissing the folder
        // picker, a confirmation dialog, or a model list opened from inside this window
        // closed the window behind it as well — the same defect the ticket dashboard
        // has already been taught to avoid.
        if (isEscapeClaimedByNestedOverlay(e, panelRef.current)) return
        if (isSessionDirty) {
          const shouldClose = window.confirm('You have unsaved changes. Close this window anyway?')
          if (!shouldClose) return
        }
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [closeDisabled, open, onClose, isSessionDirty])

  if (!open) return null

  return (
    <div
      className={`fixed inset-0 ${zIndexClass} flex items-center justify-center bg-black/50 backdrop-blur-[1px]`}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return
        if (closeDisabled) return
        if (isSessionDirty) return
        onClose()
      }}
      onChangeCapture={(e) => {
        const target = e.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
          setIsSessionDirty(true)
        }
      }}
      onInputCapture={(e) => {
        const target = e.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
          setIsSessionDirty(true)
        }
      }}
      onSubmitCapture={() => {
        setIsSessionDirty(false)
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleTrapKeyDown}
        className={`${maxWidth} w-full mx-4 bg-background rounded-xl shadow-xl border border-border flex flex-col max-h-[85vh] relative outline-none`}
      >
        <Tooltip>
                <TooltipTrigger asChild>
                  <button
                        type="button"
                        onClick={() => {
                          if (closeDisabled) return
                          if (isSessionDirty) {
                            const shouldClose = window.confirm('You have unsaved changes. Close this window anyway?')
                            if (!shouldClose) return
                          }
                          onClose()
                        }}
                        aria-label="Close"
                        className="absolute top-3 right-3 z-10 flex items-center justify-center h-8 w-8 rounded-md border border-border bg-muted text-foreground hover:bg-destructive hover:text-white hover:border-destructive transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={closeDisabled}
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
      </div>
    </div>
  )
}
