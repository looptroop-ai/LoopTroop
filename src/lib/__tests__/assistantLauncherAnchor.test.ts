import { afterEach, expect, it, vi } from 'vitest'
import {
  ASSISTANT_LAUNCHER_GAP_PX,
  assistantLauncherPositionForAnchor,
  clampAssistantLauncherPosition,
  findAssistantBackToBottomAnchor,
  hasBackToBottomAnchors,
  isAssistantBackToBottomAnchorVisible,
  registerBackToBottomAnchor,
  subscribeBackToBottomAnchors,
} from '../assistantLauncherAnchor'

// jsdom's window is 1024 x 768, which findAssistantBackToBottomAnchor reads.
const viewport = { width: 1024, height: 768 }
const launcher = { width: 32, height: 32 }
const unregister: Array<() => void> = []

afterEach(() => {
  unregister.splice(0).forEach(cleanup => cleanup())
  vi.restoreAllMocks()
})

function rect(left: number, top: number, width = 32, height = 32): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

function anchorAt(rectValue: DOMRect): HTMLSpanElement {
  const marker = document.createElement('span')
  marker.getBoundingClientRect = () => rectValue
  unregister.push(registerBackToBottomAnchor(marker))
  return marker
}

it('places the launcher one gap to the left of the anchor and centers it vertically', () => {
  // Launcher left edge = 800 - gap - 32, so its right edge sits gap px left of the anchor.
  expect(assistantLauncherPositionForAnchor(rect(800, 700), launcher, viewport)).toEqual({
    right: 1024 - 800 + ASSISTANT_LAUNCHER_GAP_PX,
    bottom: 768 - 700 - 32,
  })
})

it('centers the launcher against anchors of other sizes', () => {
  expect(assistantLauncherPositionForAnchor(rect(800, 700, 32, 48), launcher, viewport)).toEqual({
    right: 1024 - 800 + ASSISTANT_LAUNCHER_GAP_PX,
    bottom: 768 - 708 - 32,
  })
})

it('keeps a clamped launcher inside the viewport and its margin', () => {
  expect(clampAssistantLauncherPosition({ right: -20, bottom: 900 }, launcher, viewport)).toEqual({ right: 4, bottom: 732 })
  expect(clampAssistantLauncherPosition({ right: 2000, bottom: -40 }, launcher, viewport)).toEqual({ right: 988, bottom: 4 })
})

it('reports whether an anchor is on screen', () => {
  expect(isAssistantBackToBottomAnchorVisible(rect(20, 20), viewport)).toBe(true)
  expect(isAssistantBackToBottomAnchorVisible(rect(-40, 700), viewport)).toBe(false)
  expect(isAssistantBackToBottomAnchorVisible(rect(20, -40), viewport)).toBe(false)
  expect(isAssistantBackToBottomAnchorVisible(rect(1100, 700), viewport)).toBe(false)
  expect(isAssistantBackToBottomAnchorVisible(rect(20, 20, 0, 32), viewport)).toBe(false)
})

it('finds the bottom-most visible anchor and ignores hidden or unregistered elements', () => {
  anchorAt(rect(100, 100))
  // Lower than every visible anchor, so it would win if zero-size rects counted.
  anchorAt(rect(200, 750, 0, 0))
  const lower = anchorAt(rect(300, 600))
  anchorAt(rect(400, 500))
  const unregistered = document.createElement('span')
  unregistered.getBoundingClientRect = () => rect(900, 700)
  document.body.append(unregistered)

  expect(findAssistantBackToBottomAnchor()).toBe(lower)
  unregistered.remove()
})

it('skips an anchor the browser reports as not visible', () => {
  const visible = anchorAt(rect(300, 600))
  // Lower, so it would win if checkVisibility were ignored.
  const hidden = anchorAt(rect(300, 700))
  hidden.checkVisibility = () => false

  expect(findAssistantBackToBottomAnchor()).toBe(visible)
})

it('prefers the right-most control when two share the same bottom edge', () => {
  anchorAt(rect(300, 600))
  const right = anchorAt(rect(500, 600))
  anchorAt(rect(400, 600))

  expect(findAssistantBackToBottomAnchor()).toBe(right)
})

it('returns null when no anchor is visible', () => {
  expect(findAssistantBackToBottomAnchor()).toBeNull()
  anchorAt(rect(10, -80))
  expect(findAssistantBackToBottomAnchor()).toBeNull()
})

it('notifies subscribers when a marker mounts and unmounts', () => {
  const listener = vi.fn()
  const unsubscribe = subscribeBackToBottomAnchors(listener)
  registerBackToBottomAnchor(null)()
  expect(listener).not.toHaveBeenCalled()
  expect(hasBackToBottomAnchors()).toBe(false)

  const cleanup = registerBackToBottomAnchor(document.createElement('span'))
  expect(listener).toHaveBeenCalledTimes(1)
  expect(hasBackToBottomAnchors()).toBe(true)

  cleanup()
  expect(listener).toHaveBeenCalledTimes(2)
  expect(hasBackToBottomAnchors()).toBe(false)

  unsubscribe()
  registerBackToBottomAnchor(document.createElement('span'))()
  expect(listener).toHaveBeenCalledTimes(2)
})
