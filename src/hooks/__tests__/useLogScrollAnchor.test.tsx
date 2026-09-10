import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { useLogScrollAnchor, type LogScrollAnchor, type LogScrollPagination } from '../useLogScrollAnchor'

/**
 * jsdom reports zero for every scroll measurement, so the three the hook reads
 * are defined on the prototype and driven from one mutable object. Defining
 * them per-node is not enough: the hook binds through its own ref callback
 * during commit, before a test could reach the node.
 */
const geometry = { scrollHeight: 1000, clientHeight: 500, scrollTop: 500 }

function installGeometry() {
  for (const [prop, get] of [
    ['scrollHeight', () => geometry.scrollHeight],
    ['clientHeight', () => geometry.clientHeight],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { get, configurable: true })
  }
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    get: () => geometry.scrollTop,
    set: (value: number) => { geometry.scrollTop = value },
    configurable: true,
  })
  HTMLElement.prototype.scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number) {
    if (typeof options === 'object' && typeof options.top === 'number') geometry.scrollTop = options.top
  }) as unknown as typeof HTMLElement.prototype.scrollTo
}

interface HarnessState { isAtTop: boolean; isAutoScroll: boolean }

function Harness({ pagination, onState, onViewport, onAnchor, ...options }: {
  pagination?: LogScrollPagination
  onState: (state: HarnessState) => void
  onViewport?: (node: HTMLDivElement | null) => void
  onAnchor?: (anchor: LogScrollAnchor) => void
  scrollToBottomOverride?: (behavior: ScrollBehavior) => boolean
  rebindKey?: unknown
}) {
  const anchor = useLogScrollAnchor({ pagination, ...options })
  onAnchor?.(anchor)
  onState({ isAtTop: anchor.isAtTop, isAutoScroll: anchor.isAutoScroll })
  return (
    <div
      data-testid="viewport"
      ref={(node) => {
        anchor.setViewportRef(node)
        onViewport?.(node)
      }}
    >
      <div data-testid="content" ref={anchor.setContentRef} />
    </div>
  )
}

beforeEach(() => {
  geometry.scrollHeight = 1000
  geometry.clientHeight = 500
  geometry.scrollTop = 500
  installGeometry()
})

afterEach(() => {
  vi.restoreAllMocks()
  // `restoreAllMocks` does not undo `stubGlobal`, so the last stubbed
  // `ResizeObserver` would otherwise outlive its test and quietly replace the
  // one `src/test/setup.ts` installs.
  vi.unstubAllGlobals()
})

describe('useLogScrollAnchor', () => {
  function renderAnchor(pagination?: LogScrollPagination) {
    let state: HarnessState = { isAtTop: true, isAutoScroll: true }
    let viewport: HTMLDivElement | null = null
    const result = render(
      <Harness
        pagination={pagination}
        onState={(s) => { state = s }}
        onViewport={(node) => { if (node) viewport = node }}
      />,
    )
    const scroll = () => act(() => { viewport!.dispatchEvent(new Event('scroll')) })
    return { ...result, get state() { return state }, get viewport() { return viewport! }, scroll }
  }

  it('starts pinned to the bottom when the viewport is already at the bottom', () => {
    const anchor = renderAnchor()

    expect(anchor.state.isAutoScroll).toBe(true)
    expect(anchor.state.isAtTop).toBe(false)
  })

  it('releases the pin when the user scrolls up, and takes it back at the bottom', () => {
    const anchor = renderAnchor()

    geometry.scrollTop = 100
    anchor.scroll()
    expect(anchor.state.isAutoScroll).toBe(false)
    expect(anchor.state.isAtTop).toBe(false)

    geometry.scrollTop = 10
    anchor.scroll()
    expect(anchor.state.isAtTop).toBe(true)

    geometry.scrollTop = 500
    anchor.scroll()
    expect(anchor.state.isAutoScroll).toBe(true)
  })

  it('asks for an older page once the viewport reaches the top', () => {
    const fetchOlder = vi.fn()
    const anchor = renderAnchor({
      enabled: true, hasOlder: true, isFetchingOlder: false,
      fetchOlder, shouldAnchor: () => true, loadedEntryCount: 0,
    })

    // The pass that runs when the listener attaches is deliberately not
    // allowed to paginate, or mounting at the top would fetch immediately.
    expect(fetchOlder).not.toHaveBeenCalled()

    geometry.scrollTop = 0
    anchor.scroll()
    expect(fetchOlder).toHaveBeenCalledTimes(1)
  })

  it('does not ask for an older page when the caller has pagination switched off', () => {
    const fetchOlder = vi.fn()
    const anchor = renderAnchor({
      enabled: false, hasOlder: true, isFetchingOlder: false,
      fetchOlder, shouldAnchor: () => true, loadedEntryCount: 0,
    })

    geometry.scrollTop = 0
    anchor.scroll()
    expect(fetchOlder).not.toHaveBeenCalled()
  })

  it('does not ask again while an older page is already in flight', () => {
    const fetchOlder = vi.fn()
    const anchor = renderAnchor({
      enabled: true, hasOlder: true, isFetchingOlder: true,
      fetchOlder, shouldAnchor: () => true, loadedEntryCount: 0,
    })

    geometry.scrollTop = 0
    anchor.scroll()
    expect(fetchOlder).not.toHaveBeenCalled()
  })

  /**
   * Records every `scroll` listener added to and removed from any element,
   * through to the real implementation so behaviour is unchanged. Installed
   * before the render, because the hook binds its listener during commit.
   */
  function trackScrollListeners() {
    const added: EventListener[] = []
    const removed: EventListener[] = []
    // React binds its own delegated `scroll` listener to the render container,
    // so only the viewport's own listeners are counted.
    const isViewport = (node: HTMLElement) => node.dataset.testid === 'viewport'
    const realAdd = HTMLElement.prototype.addEventListener
    const realRemove = HTMLElement.prototype.removeEventListener
    vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (
      this: HTMLElement, type: string, listener: EventListener, ...rest: unknown[]
    ) {
      if (type === 'scroll' && isViewport(this)) added.push(listener)
      return (realAdd as unknown as (...args: unknown[]) => void).call(this, type, listener, ...rest)
    } as unknown as typeof HTMLElement.prototype.addEventListener)
    vi.spyOn(HTMLElement.prototype, 'removeEventListener').mockImplementation(function (
      this: HTMLElement, type: string, listener: EventListener, ...rest: unknown[]
    ) {
      if (type === 'scroll' && isViewport(this)) removed.push(listener)
      return (realRemove as unknown as (...args: unknown[]) => void).call(this, type, listener, ...rest)
    } as unknown as typeof HTMLElement.prototype.removeEventListener)
    return { added, removed }
  }

  it('removes on unmount the very listener it added', () => {
    // The pair matters, not the call count: `removeEventListener` given a
    // different function object is a no-op, and the listener survives the
    // unmount holding the detached node and the hook's state alive.
    const listeners = trackScrollListeners()
    const view = render(<Harness onState={() => {}} />)

    view.unmount()

    expect(listeners.added.length).toBeGreaterThan(0)
    expect(listeners.removed).toEqual(listeners.added)
  })

  it('re-attaches the listener when rebindKey changes, and only then', () => {
    // For a viewport node that is replaced without the hook unmounting: the
    // listener lives on the node itself, so it has to move with it.
    const listeners = trackScrollListeners()
    const view = render(<Harness onState={() => {}} rebindKey="a" />)
    const afterMount = listeners.added.length
    expect(afterMount).toBeGreaterThan(0)

    view.rerender(<Harness onState={() => {}} rebindKey="a" />)
    expect(listeners.added).toHaveLength(afterMount)

    view.rerender(<Harness onState={() => {}} rebindKey="b" />)
    expect(listeners.added).toHaveLength(afterMount + 1)
    // Every listener but the live one has been removed, in the order it was
    // added: a rebind that added without removing would leak the old one onto
    // the node, and both would answer the next scroll.
    expect(listeners.removed).toEqual(listeners.added.slice(0, -1))
  })

  /**
   * §13.5's "appended lines while pinned": content growing under a viewport
   * that is still pinned to the bottom follows the tail.
   *
   * This runs through the `ResizeObserver`, which is why the observer is bound
   * to the content node through a callback ref — bound once at mount it kept
   * watching a detached element whenever a surface remounted its content, the
   * same hole the scroll listener had.
   */
  it('follows appended content while pinned, and stops once the user scrolls away', () => {
    const observed: Element[] = []
    let trigger: (() => void) | undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { trigger = callback }
      observe(node: Element) { observed.push(node) }
      disconnect() {}
      unobserve() {}
    })

    const anchor = renderAnchor()
    const content = anchor.getByTestId('content')
    expect(observed).toContain(content)

    const scrollTo = vi.spyOn(anchor.viewport, 'scrollTo')
    geometry.scrollHeight = 2000
    act(() => { trigger?.() })
    expect(scrollTo).toHaveBeenCalled()

    // Scroll away, and the same growth must not drag the view back down.
    geometry.scrollTop = 100
    anchor.scroll()
    scrollTo.mockClear()
    geometry.scrollHeight = 3000
    act(() => { trigger?.() })
    expect(scrollTo).not.toHaveBeenCalled()
  })

  /**
   * The remount case that the single-node test above cannot reach.
   *
   * `CodingView` keys its log subtree by bead and iteration, so its content
   * element is replaced without the hook unmounting. Observed once at mount,
   * the `ResizeObserver` kept watching the detached node and tail-follow
   * silently stopped working for the new one.
   */
  it('follows the content node when the surface remounts it', () => {
    const observed: Element[] = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(_callback: () => void) {}
      observe(node: Element) { observed.push(node) }
      disconnect() {}
      unobserve() {}
    })

    function Remounter() {
      const [key, setKey] = useState(0)
      const anchor = useLogScrollAnchor()
      return (
        <>
          <div ref={anchor.setViewportRef}>
            <div key={key} data-testid={`content-${key}`} ref={anchor.setContentRef} />
          </div>
          <button type="button" onClick={() => setKey(key + 1)}>remount {key}</button>
        </>
      )
    }

    const { getByRole, getByTestId } = render(<Remounter />)
    expect(observed).toContain(getByTestId('content-0'))

    act(() => { getByRole('button').click() })

    expect(observed).toContain(getByTestId('content-1'))
  })

  /**
   * The measurement behind §13.5's listener-reattach fix, kept as a test rather
   * than a number in a commit message.
   *
   * `useTicketHistoricalLogs` returns a fresh object every render, and both
   * paginating panels listed it in the scroll listener's dependencies — so the
   * listener detached and reattached on every render, re-running the position
   * check with it. The pagination inputs are read through a ref now, so
   * re-rendering with a brand-new pagination object must not touch the listener.
   */
  it('does not reattach its scroll listener when only the pagination object changes', () => {
    const adds: string[] = []
    const realAdd = HTMLElement.prototype.addEventListener
    vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (
      this: HTMLElement, type: string, ...rest: unknown[]
    ) {
      adds.push(type)
      return (realAdd as unknown as (...args: unknown[]) => void).call(this, type, ...rest)
    } as unknown as typeof HTMLElement.prototype.addEventListener)

    function Rerenderer() {
      const [tick, setTick] = useState(0)
      // A new object identity every render, exactly like the real hook's return.
      const pagination: LogScrollPagination = {
        enabled: true, hasOlder: true, isFetchingOlder: false,
        fetchOlder: () => {}, shouldAnchor: () => true, loadedEntryCount: 0,
      }
      return (
        <>
          <Harness pagination={pagination} onState={() => {}} />
          <button type="button" onClick={() => setTick(tick + 1)}>rerender {tick}</button>
        </>
      )
    }

    const { getByRole } = render(<Rerenderer />)
    const scrollAdds = () => adds.filter((type) => type === 'scroll').length
    const afterMount = scrollAdds()
    expect(afterMount).toBeGreaterThan(0)

    for (let i = 0; i < 5; i += 1) {
      act(() => { getByRole('button').click() })
    }

    expect(scrollAdds()).toBe(afterMount)
  })
  it('uses the caller\'s scroll override, and falls through when it declines', () => {
    let anchor: LogScrollAnchor | undefined
    const override = vi.fn(() => true)
    const view = render(
      <Harness onState={() => {}} onAnchor={(a) => { anchor = a }} scrollToBottomOverride={override} />,
    )
    const scrollTo = vi.spyOn(view.getByTestId('viewport'), 'scrollTo')

    act(() => { anchor!.scheduleScrollToBottom('auto') })
    expect(override).toHaveBeenCalledWith('auto')
    expect(scrollTo).not.toHaveBeenCalled()

    // `FullLogView` hands its virtualizer here and returns false when the
    // virtualizer cannot do it, which has to reach the viewport instead.
    override.mockReturnValue(false)
    act(() => { anchor!.scheduleScrollToBottom('auto') })
    expect(scrollTo).toHaveBeenCalled()
  })

  it('calls the override the caller passed on this render, not the one it mounted with', () => {
    // The override is read through a ref written in a layout effect. Reading a
    // stale one means scrolling a virtualizer that has since been replaced.
    let anchor: LogScrollAnchor | undefined
    const first = vi.fn(() => true)
    const second = vi.fn(() => true)
    const view = render(
      <Harness onState={() => {}} onAnchor={(a) => { anchor = a }} scrollToBottomOverride={first} />,
    )

    view.rerender(
      <Harness onState={() => {}} onAnchor={(a) => { anchor = a }} scrollToBottomOverride={second} />,
    )
    act(() => { anchor!.scheduleScrollToBottom('auto') })

    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('coalesces smooth scrolls into one frame, and cancels a pending one on unmount', () => {
    const frames: FrameRequestCallback[] = []
    const cancelled: number[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { cancelled.push(handle) })

    let anchor: LogScrollAnchor | undefined
    const view = render(<Harness onState={() => {}} onAnchor={(a) => { anchor = a }} />)
    const scrollTo = vi.spyOn(view.getByTestId('viewport'), 'scrollTo')

    act(() => {
      anchor!.scheduleScrollToBottom('smooth')
      anchor!.scheduleScrollToBottom('smooth')
    })
    expect(frames).toHaveLength(2)
    expect(cancelled).toEqual([1])

    act(() => { frames[1]!(performance.now()) })
    expect(scrollTo).toHaveBeenCalledTimes(1)

    // A frame still pending when the surface goes away would scroll a detached
    // node — or, before the cleanup existed, keep the closure alive.
    act(() => { anchor!.scheduleScrollToBottom('smooth') })
    view.unmount()
    expect(cancelled).toEqual([1, 3])
  })

  it('drops a pending frame when an immediate scroll overtakes it', () => {
    const frames: FrameRequestCallback[] = []
    const cancelled: number[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { cancelled.push(handle) })

    let anchor: LogScrollAnchor | undefined
    const view = render(<Harness onState={() => {}} onAnchor={(a) => { anchor = a }} />)
    const scrollTo = vi.spyOn(view.getByTestId('viewport'), 'scrollTo')

    act(() => {
      anchor!.scheduleScrollToBottom('smooth')
      anchor!.scheduleScrollToBottom('auto')
    })

    expect(cancelled).toEqual([1])
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }))
  })

  it('arms and disarms the pin on request, for a control that jumps to or away from the tail', () => {
    let anchor: LogScrollAnchor | undefined
    let state: HarnessState = { isAtTop: true, isAutoScroll: true }
    render(
      <Harness onState={(s) => { state = s }} onAnchor={(a) => { anchor = a }} />,
    )

    act(() => { anchor!.disableAutoScroll() })
    expect(state.isAutoScroll).toBe(false)
    // The ref is what effects read, and it must not lag the state.
    expect(anchor!.autoScrollEnabledRef.current).toBe(false)

    act(() => { anchor!.enableAutoScroll() })
    expect(state.isAutoScroll).toBe(true)
    expect(anchor!.autoScrollEnabledRef.current).toBe(true)
  })

  describe('the older-page anchor', () => {
    function renderPaginated(shouldAnchor: () => boolean) {
      let anchor: LogScrollAnchor | undefined
      let viewport: HTMLDivElement | null = null
      const pagination = {
        enabled: true, hasOlder: true, isFetchingOlder: false,
        fetchOlder: vi.fn(), shouldAnchor, loadedEntryCount: 0,
      }
      const view = render(
        <Harness
          pagination={pagination}
          onState={() => {}}
          onAnchor={(a) => { anchor = a }}
          onViewport={(node) => { if (node) viewport = node }}
        />,
      )
      const rerenderWith = (next: Partial<LogScrollPagination>) => view.rerender(
        <Harness
          pagination={{ ...pagination, ...next }}
          onState={() => {}}
          onAnchor={(a) => { anchor = a }}
          onViewport={(node) => { if (node) viewport = node }}
        />,
      )
      return { pagination, rerenderWith, get anchor() { return anchor! }, get viewport() { return viewport! } }
    }

    function reachTop(view: { viewport: HTMLDivElement }) {
      geometry.scrollTop = 0
      act(() => { view.viewport.dispatchEvent(new Event('scroll')) })
    }

    it('keeps the first visible row where it is when an older page lands', () => {
      const view = renderPaginated(() => true)
      reachTop(view)

      // The older page is prepended, so the document grows above the viewport.
      geometry.scrollHeight = 1600
      view.rerenderWith({ loadedEntryCount: 50 })

      expect(geometry.scrollTop).toBe(600)
    })

    it('does not restore an offset the caller declined to anchor', () => {
      const view = renderPaginated(() => false)
      reachTop(view)

      geometry.scrollHeight = 1600
      view.rerenderWith({ loadedEntryCount: 50 })

      expect(geometry.scrollTop).toBe(0)
    })

    it('forgets the anchor when the caller jumps to the very top', () => {
      // A jump to the top loads every older page at once; restoring whichever
      // page happened to be anchored would undo the jump.
      const view = renderPaginated(() => true)
      reachTop(view)

      act(() => { view.anchor.clearOlderPageAnchor() })
      geometry.scrollHeight = 1600
      view.rerenderWith({ loadedEntryCount: 50 })

      expect(geometry.scrollTop).toBe(0)
    })

    it('waits for the fetch to settle before restoring the offset', () => {
      const view = renderPaginated(() => true)
      reachTop(view)

      geometry.scrollHeight = 1600
      view.rerenderWith({ loadedEntryCount: 50, isFetchingOlder: true })
      expect(geometry.scrollTop).toBe(0)

      view.rerenderWith({ loadedEntryCount: 50, isFetchingOlder: false })
      expect(geometry.scrollTop).toBe(600)
    })
  })
})
