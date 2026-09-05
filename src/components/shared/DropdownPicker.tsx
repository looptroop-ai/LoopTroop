import { useEffect, useId, useRef, useState, useCallback, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DROPDOWN_MARGIN, DROPDOWN_OFFSET, DROPDOWN_MAX_HEIGHT } from '@/lib/constants'
import { PORTAL_ATTRIBUTE } from '@/lib/overlays'

export interface DropdownPickerProps {
  trigger: ReactNode
  children: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** What a caller's `trigger` node can turn out to be once rendered. */
const TRIGGER_SELECTOR = 'button, [role="button"], a[href], input, select, textarea'

export function DropdownPicker({ trigger, children, open, onOpenChange }: DropdownPickerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [isPositioned, setIsPositioned] = useState(false)
  const popupId = useId()
  // Names this picker to the popup it portals away, so an enclosing dialog can tell
  // its own picker from one belonging to a window underneath it.
  const ownerId = useId()

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const top = Math.max(DROPDOWN_MARGIN, Math.min(rect.bottom + DROPDOWN_OFFSET, window.innerHeight - DROPDOWN_MAX_HEIGHT - DROPDOWN_MARGIN))
    setPos({
      top,
      left: Math.max(DROPDOWN_MARGIN, Math.min(rect.left, window.innerWidth - 340)),
    })
  }, [])

  /**
   * The expanded state belongs on the control the user actually operates, and callers
   * hand us that control wrapped in whatever they like — a bare `<button>` in two
   * places, a Radix `Tooltip` around one in a third. Cloning the node would put these
   * attributes on the wrapper in that third case, where they render nowhere, so the
   * rendered element is found and annotated instead.
   *
   * A disclosure, deliberately: `aria-expanded` plus the id of what it expands, and no
   * `aria-haspopup`. The popup holds whatever the caller puts in it — a list of
   * projects in one place, a search field over an emoji grid in another — so there is
   * no menu, listbox or dialog to claim, and claiming one hands assistive technology a
   * promise the generic container behind it does not keep.
   *
   * `aria-controls` is only set while the popup exists; the rest of the time it would
   * point at nothing.
   */
  useEffect(() => {
    const control = triggerRef.current?.querySelector<HTMLElement>(TRIGGER_SELECTOR) ?? triggerRef.current
    if (!control) return
    control.setAttribute('aria-expanded', String(open))
    if (open) control.setAttribute('aria-controls', popupId)
    else control.removeAttribute('aria-controls')
    return () => {
      control.removeAttribute('aria-expanded')
      control.removeAttribute('aria-controls')
    }
  }, [open, popupId])

  /**
   * Focus follows the popup, both ways.
   *
   * Tab order runs in document order, and the popup is portaled to the end of the
   * body — so from the trigger, Tab went to the next field in the form and reached
   * the popup only by wrapping round the whole dialog. `ModelPicker` already focuses
   * its search field on open; this does the same for whatever the caller put first,
   * and hands focus back to the trigger when the popup goes away, rather than
   * dropping the keyboard user at the top of the page.
   */
  useEffect(() => {
    if (!open) return
    // Captured while it is live: the trigger outlives the popup, but the cleanup runs
    // after the commit that removed the popup, when reading a ref is no longer safe.
    const triggerWrapper = triggerRef.current
    dropdownRef.current?.querySelector<HTMLElement>(TRIGGER_SELECTOR)?.focus()
    return () => {
      // The popup is gone by now, and with it whatever inside it had focus — which
      // leaves the document focused on nothing. Anywhere else means the user moved
      // on deliberately (a click elsewhere closed it), so leave them where they are.
      const active = document.activeElement
      if (active && active !== document.body) return
      triggerWrapper?.querySelector<HTMLElement>(TRIGGER_SELECTOR)?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) { setIsPositioned(false); return }
    updatePosition()
    setIsPositioned(true)

    const handleWindowResize = () => updatePosition()
    const handleScroll = () => updatePosition()

    window.addEventListener('resize', handleWindowResize)
    window.addEventListener('scroll', handleScroll, true)
    const handler = (e: MouseEvent) => {
      if (
        !ref.current?.contains(e.target as Node) &&
        !dropdownRef.current?.contains(e.target as Node)
      ) {
        onOpenChange(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => {
      window.removeEventListener('resize', handleWindowResize)
      window.removeEventListener('scroll', handleScroll, true)
      document.removeEventListener('mousedown', handler)
    }
  }, [open, onOpenChange, updatePosition])

  /**
   * Escape closes the popup and nothing else. The popup is portaled to `document.body`
   * as a plain `div`, so an unstopped Escape carries on to the document listeners that
   * close the ticket dashboard — dismissing a picker would leave the ticket. Portal
   * events still bubble through the React tree, so this one handler covers both the
   * trigger and the popup, and only claims the key while the popup is open.
   */
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return
    event.stopPropagation()
    onOpenChange(false)
    triggerRef.current?.querySelector<HTMLElement>(TRIGGER_SELECTOR)?.focus()
  }

  return (
    <div ref={ref} id={ownerId} className="relative inline-block" onKeyDown={handleKeyDown}>
      <div ref={triggerRef} onClick={() => onOpenChange(!open)}>{trigger}</div>
      {open && createPortal(
        <div
          ref={dropdownRef}
          id={popupId}
          {...{ [PORTAL_ATTRIBUTE]: ownerId }}
          className="fixed z-[100] rounded-lg border border-border bg-popover shadow-xl p-3"
          style={{
            top: pos.top,
            left: pos.left,
            maxHeight: `calc(100vh - ${pos.top}px - ${DROPDOWN_MARGIN}px)`,
            overflowY: 'auto',
            visibility: isPositioned ? 'visible' : 'hidden',
          }}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  )
}
