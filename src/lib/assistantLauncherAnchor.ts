/**
 * Where the assistant launcher sits when the current view also has a log
 * "Back to bottom" control.
 *
 * The launcher lives in the app root, while the control belongs to whichever
 * log surface is mounted (phase log, full log, bead log). Each surface marks
 * its control in the DOM so the launcher can measure it. That keeps the two
 * side by side even when a surface adds its own padding, a drawer is resized,
 * or the window changes size, instead of relying on a fixed offset that only
 * matches one layout.
 */

export const BACK_TO_BOTTOM_ANCHOR_SELECTOR = '[data-lt-back-to-bottom-anchor]'
export const ASSISTANT_LAUNCHER_GAP_PX = 8
export const ASSISTANT_LAUNCHER_VIEWPORT_MARGIN_PX = 4

export interface AssistantLauncherPosition {
  left: number
  top: number
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

export function assistantLauncherPositionForAnchor(
  anchor: AnchorRect,
  launcher: Size,
  viewport: Viewport,
): AssistantLauncherPosition {
  const margin = ASSISTANT_LAUNCHER_VIEWPORT_MARGIN_PX
  return {
    left: clamp(
      anchor.left - ASSISTANT_LAUNCHER_GAP_PX - launcher.width,
      margin,
      viewport.width - launcher.width - margin,
    ),
    top: clamp(
      anchor.top + (anchor.height - launcher.height) / 2,
      margin,
      viewport.height - launcher.height - margin,
    ),
  }
}

export function clampAssistantLauncherPosition(
  position: AssistantLauncherPosition,
  launcher: Size,
  viewport: Viewport,
): AssistantLauncherPosition {
  const margin = ASSISTANT_LAUNCHER_VIEWPORT_MARGIN_PX
  return {
    left: clamp(position.left, margin, viewport.width - launcher.width - margin),
    top: clamp(position.top, margin, viewport.height - launcher.height - margin),
  }
}

/**
 * The bottom-most visible anchor wins. A view can leave a collapsed log panel
 * mounted, and in narrow layouts more than one control can technically be on
 * screen; the one nearest the bottom-right corner is the one the launcher
 * belongs beside.
 */
export function findAssistantBackToBottomAnchor(): HTMLElement | null {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  let best: { anchor: HTMLElement; bottom: number; right: number } | null = null
  for (const anchor of document.querySelectorAll<HTMLElement>(BACK_TO_BOTTOM_ANCHOR_SELECTOR)) {
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
