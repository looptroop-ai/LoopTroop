import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The scroll anchor behind every log surface.
 *
 * `FullLogView`, `PhaseLogPanel` and `CodingView` each wrote out the same
 * viewport ref, near-bottom threshold, `requestAnimationFrame` scheduler,
 * scroll listener, older-page anchor restore and resize observer. They had
 * already drifted: two spelled the near-bottom distance as a named constant and
 * the third inlined `50`, and the frame cleanup differed in whether it nulled
 * the ref.
 *
 * Two things are worth stating about what this preserves:
 *
 * - The near-bottom threshold is an explicit parameter rather than a constant
 *   baked in here, because a panel that changes it should have to say so.
 * - The scroll listener depends only on the viewport node and the caller's
 *   stable lifecycle inputs. Both paginating panels previously listed the whole
 *   `useTicketHistoricalLogs` return value, which is a fresh object every
 *   render — so the listener detached and reattached on every render, and the
 *   `updateScrollState(false)` that runs on attach re-ran with it. The
 *   pagination inputs are read through a ref that is kept current instead.
 */

/** Distance from the bottom, in pixels, still counted as "pinned to the bottom". */
export const LOG_BOTTOM_THRESHOLD = 50
/** Distance from the top, in pixels, that counts as "at the top". */
export const LOG_TOP_THRESHOLD = 50

export interface LogScrollPagination {
  /** Whether the caller wants an older page fetched when the viewport reaches the top. */
  enabled: boolean
  hasOlder: boolean
  isFetchingOlder: boolean
  fetchOlder: () => void
  /**
   * Whether to remember the current scroll offset before the older page lands,
   * so the first row that was visible stays where it is. Each panel gates this
   * differently, and one of them also refuses while an explicit jump-to-top is
   * in flight.
   */
  shouldAnchor: () => boolean
  /** Changes when an older page has been merged in; drives the offset restore. */
  loadedEntryCount: number
}

export interface LogScrollAnchor {
  viewportRef: React.RefObject<HTMLDivElement | null>
  /** Ref callback for the scroll viewport; also exposes the node as state for virtualizers. */
  setViewportRef: (node: HTMLDivElement | null) => void
  scrollParent: HTMLDivElement | null
  contentRef: React.RefObject<HTMLDivElement | null>
  /** True while the viewport is pinned to the bottom. Read this in effects; it never lags. */
  autoScrollEnabledRef: React.RefObject<boolean>
  isAutoScroll: boolean
  isAtTop: boolean
  scheduleScrollToBottom: (behavior: ScrollBehavior) => void
  /** Re-arms auto-scroll, for a control that explicitly jumps back to the tail. */
  enableAutoScroll: () => void
  /** Disarms auto-scroll, for a control that explicitly jumps away from the tail. */
  disableAutoScroll: () => void
  /**
   * Forgets a pending older-page offset restore. A jump to the very top loads
   * every older page at once; restoring the offset of whichever page happened
   * to be anchored would undo the jump.
   */
  clearOlderPageAnchor: () => void
}

export function useLogScrollAnchor({
  bottomThreshold = LOG_BOTTOM_THRESHOLD,
  topThreshold = LOG_TOP_THRESHOLD,
  pagination,
  scrollToBottomOverride,
  rebindKey,
}: {
  bottomThreshold?: number
  topThreshold?: number
  /** Omit for a surface that does not page in older entries. */
  pagination?: LogScrollPagination
  /**
   * Scrolls to the tail by some means other than the viewport's own
   * `scrollTo` — `FullLogView` hands its virtualizer's `scrollToIndex` here.
   * Return false to fall through to the plain viewport scroll.
   */
  scrollToBottomOverride?: (behavior: ScrollBehavior) => boolean
  /** Re-attach the scroll listener when this changes, for a node that remounts. */
  rebindKey?: unknown
} = {}): LogScrollAnchor {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null)
  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node
    setScrollParent(node)
  }, [])

  const autoScrollEnabledRef = useRef(true)
  const scrollFrameRef = useRef<number | null>(null)
  const olderPageAnchorRef = useRef<{ height: number; top: number } | null>(null)
  const [isAutoScroll, setIsAutoScroll] = useState(true)
  const [isAtTop, setIsAtTop] = useState(true)

  // Kept current on every render so the listener effect below does not have to
  // depend on it. Writing it during render rather than in an effect matters:
  // the listener is attached in an effect that runs after this, and a scroll
  // can arrive before any effect would have committed the new value.
  const paginationRef = useRef(pagination)
  paginationRef.current = pagination
  const overrideRef = useRef(scrollToBottomOverride)
  overrideRef.current = scrollToBottomOverride

  const scheduleScrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const scroll = () => {
      if (overrideRef.current?.(behavior)) return
      const el = viewportRef.current
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior })
    }

    if (behavior === 'auto') {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
      scroll()
      return
    }

    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      scroll()
    })
  }, [])

  const enableAutoScroll = useCallback(() => {
    autoScrollEnabledRef.current = true
    setIsAutoScroll(true)
  }, [])

  const disableAutoScroll = useCallback(() => {
    autoScrollEnabledRef.current = false
    setIsAutoScroll(false)
  }, [])

  const clearOlderPageAnchor = useCallback(() => {
    olderPageAnchorRef.current = null
  }, [])

  // Attached on the viewport itself, because scroll events do not bubble.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const updateScrollState = (allowPagination: boolean) => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      const atBottom = distanceFromBottom <= bottomThreshold
      autoScrollEnabledRef.current = atBottom
      setIsAutoScroll((prev) => (prev !== atBottom ? atBottom : prev))
      const atTop = el.scrollTop <= topThreshold
      setIsAtTop((prev) => (prev !== atTop ? atTop : prev))

      const paging = paginationRef.current
      if (!allowPagination || !atTop || !paging) return
      if (!paging.enabled || !paging.hasOlder || paging.isFetchingOlder) return
      if (paging.shouldAnchor()) {
        olderPageAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop }
      }
      paging.fetchOlder()
    }
    updateScrollState(false)
    const onScroll = () => updateScrollState(true)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [bottomThreshold, rebindKey, scrollParent, topThreshold])

  // Older entries are prepended in chronological order. Keep the first row
  // that was already visible at the same screen position after the resize.
  const loadedEntryCount = pagination?.loadedEntryCount
  const isFetchingOlder = pagination?.isFetchingOlder
  useEffect(() => {
    const anchor = olderPageAnchorRef.current
    const el = viewportRef.current
    if (!anchor || !el || isFetchingOlder) return
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height)
    olderPageAnchorRef.current = null
  }, [isFetchingOlder, loadedEntryCount])

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
  }, [])

  // Growing content scrolls the tail into view, but only while pinned.
  useEffect(() => {
    const contentEl = contentRef.current
    if (!contentEl) return
    const observer = new ResizeObserver(() => {
      if (!autoScrollEnabledRef.current) return
      scheduleScrollToBottom('auto')
    })
    observer.observe(contentEl)
    return () => observer.disconnect()
  }, [scheduleScrollToBottom])

  return {
    viewportRef,
    setViewportRef,
    scrollParent,
    contentRef,
    autoScrollEnabledRef,
    isAutoScroll,
    isAtTop,
    scheduleScrollToBottom,
    enableAutoScroll,
    disableAutoScroll,
    clearOlderPageAnchor,
  }
}
