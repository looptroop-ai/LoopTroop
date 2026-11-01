/**
 * Where the assistant launcher sits when the current view has a log.
 *
 * The launcher lives in the app root, while the log belongs to whichever
 * surface is mounted (phase log, full log, bead log). Each surface renders an
 * always-present, invisible marker exactly where its "Back to bottom" button
 * appears, and registers it here. The launcher measures the marker, so it sits
 * in the same spot whether or not the button is showing, and follows it when
 * a surface adds its own padding, a drawer is resized, or the window changes
 * size, instead of relying on a fixed offset that only matches one layout.
 *
 * Positions are distances from the viewport's right and bottom edges, so a
 * held spot keeps following that corner when the window grows or shrinks.
 */

/** Marks the element in the DOM; the runtime uses the registry below. */
export const BACK_TO_BOTTOM_ANCHOR_ATTRIBUTE = 'data-lt-back-to-bottom-anchor'
export const ASSISTANT_LAUNCHER_GAP_PX = 8
const VIEWPORT_MARGIN_PX = 4

export interface AssistantLauncherPosition {
  right: number
  bottom: number
}

interface Size {
  width: number
  height: number
}

interface AnchorRect extends Size {
  left: number
  top: number
}

type Viewport = Size

const anchors = new Set<HTMLElement>()
const listeners = new Set<() => void>()

function notifyAnchorListeners() {
  for (const listener of listeners) listener()
}

/**
 * Callback ref for a marker element. React 19 calls the returned function when
 * the element unmounts, so a surface only has to pass this as `ref`.
 */
export function registerBackToBottomAnchor(element: HTMLElement | null): (() => void) | undefined {
  if (!element) return undefined
  anchors.add(element)
  notifyAnchorListeners()
  return () => {
    anchors.delete(element)
    notifyAnchorListeners()
  }
}

export function subscribeBackToBottomAnchors(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function hasBackToBottomAnchors(): boolean {
  return anchors.size > 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(minimum, value), Math.max(minimum, maximum))
}

export function isAssistantBackToBottomAnchorVisible(rect: AnchorRect, viewport: Viewport): boolean {
  return rect.width > 0
    && rect.height > 0
    && rect.left < viewport.width
    && rect.top < viewport.height
    && rect.left + rect.width > 0
    && rect.top + rect.height > 0
}

export function clampAssistantLauncherPosition(
  position: AssistantLauncherPosition,
  launcher: Size,
  viewport: Viewport,
): AssistantLauncherPosition {
  return {
    right: clamp(position.right, VIEWPORT_MARGIN_PX, viewport.width - launcher.width - VIEWPORT_MARGIN_PX),
    bottom: clamp(position.bottom, VIEWPORT_MARGIN_PX, viewport.height - launcher.height - VIEWPORT_MARGIN_PX),
  }
}

/** One gap to the anchor's left, centered on it vertically. */
export function assistantLauncherPositionForAnchor(
  anchor: AnchorRect,
  launcher: Size,
  viewport: Viewport,
): AssistantLauncherPosition {
  const top = anchor.top + (anchor.height - launcher.height) / 2
  return clampAssistantLauncherPosition({
    right: viewport.width - anchor.left + ASSISTANT_LAUNCHER_GAP_PX,
    bottom: viewport.height - top - launcher.height,
  }, launcher, viewport)
}

/**
 * The bottom-most visible anchor wins, then the right-most: in narrow layouts
 * two log surfaces can be on screen at once, and the one nearest the
 * bottom-right corner is the one the launcher belongs beside. `checkVisibility`
 * (absent in jsdom) drops markers hidden by an ancestor's `visibility`.
 */
export function findAssistantBackToBottomAnchor(): HTMLElement | null {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  let best: { anchor: HTMLElement; bottom: number; right: number } | null = null
  for (const anchor of anchors) {
    if (anchor.checkVisibility?.({ visibilityProperty: true }) === false) continue
    const rect = anchor.getBoundingClientRect()
    if (!isAssistantBackToBottomAnchorVisible(rect, viewport)) continue
    const bottom = rect.top + rect.height
    const right = rect.left + rect.width
    if (!best || bottom > best.bottom || (bottom === best.bottom && right > best.right)) {
      best = { anchor, bottom, right }
    }
  }
  return best?.anchor ?? null
}
