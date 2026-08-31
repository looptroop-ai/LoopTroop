/**
 * Who owns Escape, and what counts as part of an open overlay.
 *
 * Escape belongs to the innermost thing that is open. Every overlay in this app
 * dismisses itself and lets the key bubble, so a surface that closes on a document
 * `keydown` will also close on the keypress that dismissed the dialog in front of
 * it — which is how dismissing "Cancel ticket?" used to leave the ticket, and how
 * dismissing the folder picker used to close the Projects window behind it.
 *
 * Shared rather than repeated in each surface: three of them now make the same
 * decision, and a fourth kind of overlay must not be a defect in two of them.
 */

/**
 * Marks a popup this app portals out of the React tree — `DropdownPicker`'s menu,
 * `ModelPicker`'s list. They are body children by the time they reach the DOM, so
 * nothing about their position says which overlay they belong to.
 *
 * The attribute's **value is the id of the element that owns it**, which lives back
 * inside whatever dialog opened the picker. Ownership is what lets `useDialogFocus`
 * tell "my own picker, which Tab must reach" from "a picker belonging to a window
 * underneath me, which must be inert" — without it, opening the shortcuts overlay
 * over an open picker put that picker in the overlay's tab order.
 */
export const PORTAL_ATTRIBUTE = 'data-lt-portal'
export const PORTAL_SELECTOR = `[${PORTAL_ATTRIBUTE}]`

/** Anything that owns Escape while it is open. */
export const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[data-radix-dialog-content]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[data-radix-popper-content-wrapper]',
  // A focused native dropdown owns the key too, and unlike the roles above it says
  // so with its tag rather than an attribute. Escape on a focused select therefore
  // never reaches the ticket or the window behind it, open list or not — a native
  // select does not expose which it is.
  'select',
  // This app's own portaled popups. They carry no role, because what they contain is
  // the caller's business, so they would otherwise claim Escape only through React's
  // synthetic propagation and not through a document listener.
  PORTAL_SELECTOR,
].join(',')

/** The element a portaled popup belongs to, if it is still in the document. */
export function getPortalOwner(portal: Element): HTMLElement | null {
  const ownerId = portal.getAttribute(PORTAL_ATTRIBUTE)
  return ownerId ? document.getElementById(ownerId) : null
}

/** Whether `portal` was opened from inside `container`. */
export function isPortalOwnedBy(portal: Element, container: HTMLElement): boolean {
  const owner = getPortalOwner(portal)
  return owner !== null && container.contains(owner)
}

/**
 * Whether an Escape keypress has already been claimed by something nested inside
 * `self` — or, when `self` is null, by any overlay at all.
 *
 * `self` is the caller's own overlay element, if it is one. A modal's own panel now
 * carries `role="dialog"`, so without that exclusion every modal would decide that
 * Escape belonged to a nested overlay and never close at all.
 */
export function isEscapeClaimedByNestedOverlay(
  event: KeyboardEvent,
  self: HTMLElement | null,
): boolean {
  if (event.defaultPrevented) return true
  const target = event.target as Element | null
  const overlay = target?.closest?.(OVERLAY_SELECTOR) ?? null
  if (!overlay) return false
  return overlay !== self
}
