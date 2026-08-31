import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { PORTAL_SELECTOR, isPortalOwnedBy } from '@/lib/overlays'

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
 * Ownership, not mere existence: a popup belonging to a window *underneath* this one
 * — a picker still open when the shortcuts overlay is summoned over it — is not part
 * of this dialog and must be inert like the rest of the page behind it.
 */
function getScope(container: HTMLElement): HTMLElement[] {
  const portals = Array.from(document.querySelectorAll<HTMLElement>(PORTAL_SELECTOR))
    .filter((portal) => !container.contains(portal) && isPortalOwnedBy(portal, container))
  return [container, ...portals]
}

const INERT_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'TITLE', 'BASE'])

/** A sibling that must stay interactive: not markup-only, and this dialog's own popup. */
function isInertable(node: Element, container: HTMLElement): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false
  if (INERT_SKIP_TAGS.has(node.tagName)) return false
  // Radix mounts its poppers on demand, after this ran, so they are skipped by name.
  if (node.matches('[data-radix-popper-content-wrapper]')) return false
  if (node.matches(PORTAL_SELECTOR)) return !isPortalOwnedBy(node, container)
  return true
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
      if (child !== node && isInertable(child, container)) restore.push(markInert(child))
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

    const scope = getScope(container)
    const active = document.activeElement as HTMLElement | null

    /*
     * Focus outside this dialog's scope means something nested owns it — a Radix menu
     * or confirmation dialog opened from inside, each of which brings its own focus
     * scope and portals its content to the body. Their key events still travel the
     * React tree to this handler, and treating "not in my list" as "wrap me back to
     * my own first control" yanked focus straight out of the menu the user had open.
     */
    if (!scope.some((root) => root === active || (active !== null && root.contains(active)))) return

    const focusable = getFocusable(scope)
    if (focusable.length === 0) {
      // Nothing to move to, so Tab must not escape to the page behind.
      event.preventDefault()
      return
    }

    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const index = active ? focusable.indexOf(active) : -1

    // The container itself holds focus after open, and is not in the tab order.
    if (event.shiftKey && (index === 0 || active === container)) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && (index === focusable.length - 1 || active === container)) {
      event.preventDefault()
      first.focus()
    }
  }
}
