import { useState, useEffect, useId, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useDialogFocus } from '@/hooks/useDialogFocus'

// Only shortcuts the app actually binds. `?` and Escape are handled here, `/` in
// DashboardSearch. Listing one the app does not implement is worse than listing
// nothing: the user presses it, nothing happens, and the whole list loses credit.
const SHORTCUTS = [
  { key: '?', description: 'Show keyboard shortcuts' },
  { key: 'Escape', description: 'Close current view / modal' },
  { key: '/', description: 'Focus search' },
]

export function KeyboardShortcuts() {
  const [isOpen, setIsOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const handleTrapKeyDown = useDialogFocus(isOpen, panelRef)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        const target = e.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
          || target.isContentEditable || target.closest('[role="textbox"]')) return
        e.preventDefault()
        setIsOpen(prev => !prev)
      }
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setIsOpen(false)}>
      <Card
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleTrapKeyDown}
        className="w-full max-w-md outline-none"
        onClick={e => e.stopPropagation()}
      >
        <CardHeader>
          <CardTitle id={titleId} className="text-sm">Keyboard Shortcuts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {SHORTCUTS.map(s => (
              <div key={s.key} className="flex justify-between text-sm">
                <span className="text-muted-foreground">{s.description}</span>
                <kbd className="px-2 py-0.5 rounded bg-muted text-xs font-mono">{s.key}</kbd>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
