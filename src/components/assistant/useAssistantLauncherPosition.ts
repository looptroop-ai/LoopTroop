import { useLayoutEffect, useState, type RefObject } from 'react'
import {
  assistantLauncherPositionForAnchor,
  clampAssistantLauncherPosition,
  findAssistantBackToBottomAnchor,
  hasBackToBottomAnchors,
  subscribeBackToBottomAnchors,
  type AssistantLauncherPosition,
} from '@/lib/assistantLauncherAnchor'

/**
 * Follows the log's Back to bottom spot so the launcher stays immediately left
 * of it. When no log is on screen (the dashboard, a collapsed log drawer) the
 * last measured spot is kept, as distances from the right and bottom edges, so
 * the launcher neither jumps between views nor drifts off its corner when the
 * window is resized.
 */
export function useAssistantLauncherPosition(
  launcherRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): AssistantLauncherPosition | null {
  const [position, setPosition] = useState<AssistantLauncherPosition | null>(null)

  useLayoutEffect(() => {
    if (!enabled) return

    let frame: number | null = null
    let resizeObserver: ResizeObserver | null = null
    let observedAnchor: HTMLElement | null = null

    function schedule() {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        update()
      })
    }

    // Scrolling only matters while a marker can move with it; on the dashboard
    // every scroll would otherwise pay for a measurement that changes nothing.
    function scheduleIfAnchored() {
      if (hasBackToBottomAnchors()) schedule()
    }

    function syncResizeObserver(anchor: HTMLElement | null) {
      if (anchor === observedAnchor) return
      observedAnchor = anchor
      resizeObserver?.disconnect()
      if (!anchor) return
      resizeObserver ??= new ResizeObserver(schedule)
      for (let element: Element | null = anchor; element && element !== document.body; element = element.parentElement) {
        resizeObserver.observe(element)
      }
    }

    function update() {
      const launcher = launcherRef.current
      if (!launcher) return
      const launcherRect = launcher.getBoundingClientRect()
      const anchor = findAssistantBackToBottomAnchor()
      syncResizeObserver(anchor)
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      setPosition(current => {
        const next = anchor
          ? assistantLauncherPositionForAnchor(anchor.getBoundingClientRect(), launcherRect, viewport)
          : current && clampAssistantLauncherPosition(current, launcherRect, viewport)
        return next && current?.right === next.right && current.bottom === next.bottom ? current : next
      })
    }

    update()

    const unsubscribe = subscribeBackToBottomAnchors(schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', scheduleIfAnchored, { capture: true, passive: true })

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      unsubscribe()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', scheduleIfAnchored, { capture: true })
    }
  }, [enabled, launcherRef])

  return position
}
