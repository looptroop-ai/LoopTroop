import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { PORTAL_SELECTOR } from '@/lib/overlays'

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
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Only what Tab can actually reach, in DOM order.
 *
 * Layout is not consulted on purpose: jsdom reports every element as unlaid-out,
 * so a visibility test would empty this list under test and trap nothing. What is
 * excluded instead is what cannot hold sequential focus whatever the layout —
 * hidden inputs, inert or `hidden` subtrees, and anything explicitly taken out of
 * the tab order. A hidden input landing first or last would otherwise become the
 * boundary the wrap-around aims at, and focus would leave the dialog.
 */
function getFocusable(roots: HTMLElement[]): HTMLElement[] {
  const found: HTMLElement[] = []
  for (const root of roots) {
    for (const element of root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
      if (element.hasAttribute('inert') || element.hasAttribute('hidden')) continue
      if (element.tabIndex < 0) continue
      if (element.closest('[inert]')) continue
      found.push(element)
    }
  }
  return found
}

/**
 * The dialog plus the popups it owns.
 *
 * `DropdownPicker` and `ModelPicker` portal their popup to `document.body`, so a
 * picker opened inside a dialog is a DOM sibling of the whole app rather than a
 * descendant of the dialog. A trap that only looked inside the dialog element made
 * those popups unreachable by Tab — the New Ticket project picker and the project
 * appearance pickers could be opened from the keyboard and not used — while
 * `ModelPicker`, which moves focus into its own popup, escaped the trap entirely
 * because the focused element was outside every boundary the trap knew about.
 *
 * Every such popup that is currently mounted is treated as part of the open
 * dialog. They close on outside pointerdown, so at most one is open at a time, and
 * one open over a dialog belongs to it.
 */
function getScope(container: HTMLElement): HTMLElement[] {
  const portals = Array.from(document.querySelectorAll<HTMLElement>(PORTAL_SELECTOR))
    .filter((portal) => !container.contains(portal))
  return [container, ...portals]
}

const INERT_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'TITLE', 'BASE'])

/** A sibling that must stay interactive: not markup-only, and not a popup surface. */
function isInertable(node: Element): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false
  if (INERT_SKIP_TAGS.has(node.tagName)) return false
  return !node.matches(`[data-radix-popper-content-wrapper],${PORTAL_SELECTOR}`)
}

/** Marks one sibling inert, returning the undo for exactly what it changed. */
function markInert(element: HTMLElement): () => void {
  const hadInert = element.hasAttribute('inert')
  const previousAriaHidden = element.getAttribute('aria-hidden')
  if (!hadInert) element.setAttribute('inert', '')
  if (previousAriaHidden === null) element.setAttribute('aria-hidden', 'true')
  return () => {
    if (!hadInert) element.removeAttribute('inert')
    if (previousAriaHidden === null) element.removeAttribute('aria-hidden')
  }
}

/**
 * Makes everything outside `container` inert, by walking to the document root and
 * marking each sibling on the way up. Only what this call changed is restored, so
 * a second overlay opening over a first (About over Configuration) nests instead of
 * fighting: the inner one hides the outer, and undoes exactly that on close.
 *
 * Popup surfaces are skipped — a tooltip, a Radix popper, or one of this app's own
 * portaled pickers belongs to the overlay rather than to the page behind it.
 */
function hideOutside(container: HTMLElement): () => void {
  const restore: Array<() => void> = []
  let node: HTMLElement = container

  while (node.parentElement) {
    const parent = node.parentElement
    for (const child of parent.children) {
      if (child !== node && isInertable(child)) restore.push(markInert(child))
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
 * React routes portal events through the React tree, so a keypress inside a picker
 * this dialog owns reaches this handler even though the DOM says otherwise.
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

    const focusable = getFocusable(getScope(container))
    if (focusable.length === 0) {
      // Nothing to move to, so Tab must not escape to the page behind.
      event.preventDefault()
      return
    }

    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const active = document.activeElement as HTMLElement | null
    const index = active ? focusable.indexOf(active) : -1

    // `-1` is the container itself, or a popup control this scope does not list:
    // either way the next Tab has to land back inside the dialog rather than out.
    if (event.shiftKey && (index === 0 || index === -1)) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && (index === focusable.length - 1 || index === -1)) {
      event.preventDefault()
      first.focus()
    }
  }
}
