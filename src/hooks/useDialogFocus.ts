import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

/**
 * Focus containment for the app's own overlay primitives.
 *
 * `role="dialog"` and `aria-modal="true"` are a promise to assistive technology:
 * everything outside this box is unreachable until it closes. Announcing that
 * boundary without enforcing it is worse than saying nothing — a screen reader
 * reports a modal the user can Tab straight out of, into a background it has
 * already stopped describing. So the attributes and the containment ship
 * together, and this hook is the containment half.
 *
 * Radix provides all of this for the dialogs built on it. These two primitives
 * (`CenteredModal`, `FullScreenModal`) predate it and carry behaviour Radix does
 * not have — the unsaved-changes confirm, `closeDisabled`, and About layering
 * over Configuration — so they keep their own implementation.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Layout is not consulted on purpose: jsdom reports every element as unlaid-out. */
function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('inert') && !element.hasAttribute('hidden'),
  )
}

const INERT_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'TITLE', 'BASE'])

/**
 * Makes everything outside `container` inert, by walking to the document root and
 * marking each sibling on the way up. Only what this call changed is restored, so
 * a second overlay opening over a first (About over Configuration) nests instead of
 * fighting: the inner one hides the outer, and undoes exactly that on close.
 *
 * Portal roots are skipped — a tooltip or dropdown belonging to the overlay itself
 * is mounted next to it, not inside it.
 */
function hideOutside(container: HTMLElement): () => void {
  const restore: Array<() => void> = []
  let node: HTMLElement = container

  while (node.parentElement) {
    const parent = node.parentElement
    for (const child of Array.from(parent.children)) {
      if (child === node || !(child instanceof HTMLElement)) continue
      if (INERT_SKIP_TAGS.has(child.tagName)) continue
      if (child.matches('[data-radix-portal],[data-radix-popper-content-wrapper]')) continue

      const hadInert = child.hasAttribute('inert')
      const previousAriaHidden = child.getAttribute('aria-hidden')
      if (!hadInert) child.setAttribute('inert', '')
      if (previousAriaHidden === null) child.setAttribute('aria-hidden', 'true')
      restore.push(() => {
        if (!hadInert) child.removeAttribute('inert')
        if (previousAriaHidden === null) child.removeAttribute('aria-hidden')
      })
    }
    node = parent
  }

  return () => {
    for (const undo of restore) undo()
  }
}

/**
 * Transfers focus into the overlay on open, keeps Tab inside it, makes the rest of
 * the page inert, and returns focus where it came from on close. The container
 * needs `tabIndex={-1}` so it can hold focus itself while nothing inside it can.
 *
 * Returns the `onKeyDown` handler the container must spread — the trap is bound to
 * the overlay rather than the document so a nested overlay's own handler wins.
 */
export function useDialogFocus(open: boolean, containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return
    const container = containerRef.current
    if (!container) return

    const previouslyFocused = document.activeElement as HTMLElement | null
    const restoreOutside = hideOutside(container)
    container.focus()

    return () => {
      restoreOutside()
      // A focused element that left the document takes focus to <body> with it, and
      // the keyboard user loses their place in the page entirely.
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [open, containerRef])

  return (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab') return
    const container = containerRef.current
    if (!container) return

    const focusable = getFocusable(container)
    if (focusable.length === 0) {
      // Nothing to move to, so Tab must not escape to the page behind.
      event.preventDefault()
      return
    }

    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const active = document.activeElement

    if (event.shiftKey && (active === first || active === container)) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }
}
