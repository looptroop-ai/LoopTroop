import { useLayoutEffect, useState, type RefObject } from 'react'
import {
  BACK_TO_BOTTOM_ANCHOR_SELECTOR,
  assistantLauncherPositionForAnchor,
  clampAssistantLauncherPosition,
  findAssistantBackToBottomAnchor,
  type AssistantLauncherPosition,
} from '@/lib/assistantLauncherAnchor'

/**
 * Follows the visible log "Back to bottom" control so the launcher stays
 * immediately left of it. When that control disappears — or the reader is on
 * the dashboard, where none exists — the last measured spot is kept, so the
 * launcher does not jump between views.
 */
export function useAssistantLauncherPosition(
  launcherRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): AssistantLauncherPosition | null {
  const [position, setPosition] = useState<AssistantLauncherPosition | null>(null)

  useLayoutEffect(() => {
    if (!enabled) return
    const launcher = launcherRef.current
    if (!launcher) return

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
      const currentLauncher = launcherRef.current
      if (!currentLauncher) return
      const launcherRect = currentLauncher.getBoundingClientRect()
      const anchor = findAssistantBackToBottomAnchor()
      syncResizeObserver(anchor)
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      if (!anchor) {
        setPosition(current => {
          if (!current) return current
          const next = clampAssistantLauncherPosition(current, launcherRect, viewport)
          return next.left === current.left && next.top === current.top ? current : next
        })
        return
      }
      const next = assistantLauncherPositionForAnchor(anchor.getBoundingClientRect(), launcherRect, viewport)
      setPosition(current => current?.left === next.left && current.top === next.top ? current : next)
    }

    update()

    const mutationObserver = new MutationObserver(records => {
      const anchorChanged = records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
        node instanceof Element
        && (node.matches(BACK_TO_BOTTOM_ANCHOR_SELECTOR) || node.querySelector(BACK_TO_BOTTOM_ANCHOR_SELECTOR) !== null)))
      if (anchorChanged) schedule()
    })
    mutationObserver.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      mutationObserver.disconnect()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [enabled, launcherRef])

  return position
}
