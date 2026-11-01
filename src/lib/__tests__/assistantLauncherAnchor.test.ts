import { afterEach, expect, it, vi } from 'vitest'
import {
  ASSISTANT_LAUNCHER_GAP_PX,
  assistantLauncherPositionForAnchor,
  clampAssistantLauncherPosition,
  findAssistantBackToBottomAnchor,
  isAssistantBackToBottomAnchorVisible,
} from '../assistantLauncherAnchor'

const viewport = { width: 1024, height: 768 }
const launcher = { width: 32, height: 32 }

afterEach(() => {
  document.body.replaceChildren()
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

function anchorAt(rectValue: DOMRect): HTMLButtonElement {
  const button = document.createElement('button')
  button.setAttribute('data-lt-back-to-bottom-anchor', '')
  button.getBoundingClientRect = () => rectValue
  document.body.append(button)
  return button
}

it('places the launcher one gap to the left of the anchor and centers it vertically', () => {
  expect(assistantLauncherPositionForAnchor(rect(800, 700), launcher, viewport)).toEqual({
    left: 800 - ASSISTANT_LAUNCHER_GAP_PX - launcher.width,
    top: 700,
  })
})

it('centers the launcher against anchors of other sizes', () => {
  expect(assistantLauncherPositionForAnchor(rect(800, 700, 32, 48), launcher, viewport)).toEqual({
    left: 800 - ASSISTANT_LAUNCHER_GAP_PX - launcher.width,
    top: 708,
  })
})

it('keeps a clamped launcher inside the viewport and its margin', () => {
  expect(clampAssistantLauncherPosition({ left: -20, top: 900 }, launcher, viewport)).toEqual({ left: 4, top: 732 })
  expect(clampAssistantLauncherPosition({ left: 2000, top: -40 }, launcher, viewport)).toEqual({ left: 988, top: 4 })
})

it('reports whether an anchor is on screen', () => {
  expect(isAssistantBackToBottomAnchorVisible(rect(20, 20), viewport)).toBe(true)
  expect(isAssistantBackToBottomAnchorVisible(rect(-40, 700), viewport)).toBe(false)
  expect(isAssistantBackToBottomAnchorVisible(rect(20, -40), viewport)).toBe(false)
  expect(isAssistantBackToBottomAnchorVisible(rect(1100, 700), viewport)).toBe(false)
  expect(isAssistantBackToBottomAnchorVisible(rect(20, 20, 0, 32), viewport)).toBe(false)
})

it('finds the bottom-most visible anchor and ignores hidden or unrelated controls', () => {
  anchorAt(rect(100, 100))
  // Lower than every visible anchor, so it would win if zero-size rects counted.
  const hidden = anchorAt(rect(200, 750))
  hidden.hidden = true
  hidden.getBoundingClientRect = () => rect(200, 750, 0, 0)
  const lower = anchorAt(rect(300, 600))
  anchorAt(rect(400, 500))
  const unrelated = document.createElement('button')
  unrelated.getBoundingClientRect = () => rect(900, 700)
  document.body.append(unrelated)

  expect(findAssistantBackToBottomAnchor()).toBe(lower)
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
