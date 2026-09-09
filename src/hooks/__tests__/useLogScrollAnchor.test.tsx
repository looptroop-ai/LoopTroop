import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { useLogScrollAnchor, type LogScrollPagination } from '../useLogScrollAnchor'

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

function Harness({ pagination, onState, onViewport }: {
  pagination?: LogScrollPagination
  onState: (state: HarnessState) => void
  onViewport?: (node: HTMLDivElement | null) => void
}) {
  const anchor = useLogScrollAnchor({ pagination })
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

  it('removes its scroll listener on unmount', () => {
    const anchor = renderAnchor()
    const remove = vi.spyOn(anchor.viewport, 'removeEventListener')

    anchor.unmount()

    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function))
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
})
