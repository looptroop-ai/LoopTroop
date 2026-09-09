import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

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
  /**
   * Ref callback for the growing content element. Prefer it over `contentRef`:
   * the observer follows the node it is given, so a surface that remounts its
   * content keeps its tail-follow behaviour.
   */
  setContentRef: (node: HTMLDivElement | null) => void
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
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null)
  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node
    setScrollParent(node)
  }, [])
  const setContentRef = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node
    setContentNode(node)
  }, [])

  const autoScrollEnabledRef = useRef(true)
  const scrollFrameRef = useRef<number | null>(null)
  const olderPageAnchorRef = useRef<{ height: number; top: number } | null>(null)
  const [isAutoScroll, setIsAutoScroll] = useState(true)
  const [isAtTop, setIsAtTop] = useState(true)

  // Kept current so the listener effect below does not have to depend on it —
  // both values are fresh objects every render, which is what made the listener
  // detach and reattach on every render before it was extracted.
  //
  // Written in a layout effect rather than during render. A render can be
  // started and thrown away, and a ref written in that render would keep a
  // value that never committed. `useLayoutEffect` runs after commit and before
  // the browser paints, so no scroll event can be dispatched against the new
  // DOM while these still hold the previous render's values.
  const paginationRef = useRef(pagination)
  const overrideRef = useRef(scrollToBottomOverride)
  useLayoutEffect(() => {
    paginationRef.current = pagination
    overrideRef.current = scrollToBottomOverride
  })

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
  //
  // Keyed on the node rather than observed once at mount: a surface that
  // remounts its content — `CodingView` keys its subtree by bead and iteration —
  // otherwise leaves the observer watching the detached element, which is the
  // same hole the scroll listener had before it was bound through a callback.
  useEffect(() => {
    const contentEl = contentNode ?? contentRef.current
    if (!contentEl) return
    const observer = new ResizeObserver(() => {
      if (!autoScrollEnabledRef.current) return
      scheduleScrollToBottom('auto')
    })
    observer.observe(contentEl)
    return () => observer.disconnect()
  }, [contentNode, scheduleScrollToBottom])

  return {
    viewportRef,
    setViewportRef,
    scrollParent,
    contentRef,
    setContentRef,
    autoScrollEnabledRef,
    isAutoScroll,
    isAtTop,
    scheduleScrollToBottom,
    enableAutoScroll,
    disableAutoScroll,
    clearOlderPageAnchor,
  }
}
