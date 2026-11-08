import { useId, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useDialogFocus } from '@/hooks/useDialogFocus'

export const WELCOME_DISCLAIMER_STORAGE_KEY = 'looptroop-welcome-seen'

interface WelcomeDisclaimerProps {
  open: boolean
  onDismiss: () => void
  appPathWarning?: string | null
}

export function WelcomeDisclaimer({ open, onDismiss, appPathWarning }: WelcomeDisclaimerProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const handleTrapKeyDown = useDialogFocus(open, panelRef)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/60 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleTrapKeyDown}
        className="my-auto flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-y-auto rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl"
      >
        <h2 id={titleId} className="mb-3 shrink-0 text-xl font-bold text-foreground">Welcome to LoopTroop</h2>

        <div role="region" aria-labelledby={titleId} tabIndex={0} className="min-h-24 flex-1 overflow-y-auto">
          <p className="text-sm text-muted-foreground mb-4">
            LoopTroop runs long AI-driven planning and execution workflows.
          </p>

          <div className="space-y-3 mb-4 text-sm text-muted-foreground">
            <p>
              🔮 <span className="font-bold text-foreground">Interview phase</span> may take{' '}
              <span className="font-bold text-foreground">1+ hour</span> depending on project complexity and council
              size.
            </p>
            <p>
              🔮 <span className="font-bold text-foreground">Execution phase</span> may take{' '}
              <span className="font-bold text-foreground">10+ hours</span> for large tickets with many beads.
            </p>
          </div>

          {appPathWarning && (
            <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-100">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                <div>
                  <p className="font-semibold text-amber-950 dark:text-amber-50">WSL performance warning</p>
                  <p className="mt-1 text-amber-900/90 dark:text-amber-100/90">{appPathWarning}</p>
                </div>
              </div>
            </div>
          )}

          <p className="text-sm text-muted-foreground mb-5">
            Ensure your machine won't sleep during execution and has at least 4 GB RAM and 15 GB free
            space.
          </p>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className="mt-5 w-full shrink-0 bg-primary text-primary-foreground rounded-lg py-2.5 font-medium hover:bg-primary/90 transition-colors cursor-pointer"
        >
          Got it, let's go!
        </button>
      </div>
    </div>
  )
}
