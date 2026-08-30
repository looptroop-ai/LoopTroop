import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clampNavWidth,
  NAV_WIDTH_DEFAULT,
  NAV_WIDTH_MIN,
  NAV_WIDTH_STORAGE_KEY,
  readNavWidth,
  writeNavWidth,
} from '../navWidth'

/**
 * The navigator width is the one piece of workspace state that has to survive a ticket switch. The
 * dashboard is remounted per ticket, so the round trip through storage below *is* the mechanism —
 * `TicketDashboard` reads it on mount and writes it when a drag ends.
 */
describe('navWidth', () => {
  const originalInnerWidth = window.innerWidth

  beforeEach(() => {
    localStorage.clear()
    window.innerWidth = 1000
  })

  afterEach(() => {
    localStorage.clear()
    window.innerWidth = originalInnerWidth
  })

  it('remembers a width across mounts', () => {
    writeNavWidth(420)
    expect(readNavWidth()).toBe(420)
  })

  it('rounds a fractional drag width before storing it', () => {
    writeNavWidth(333.7)
    expect(localStorage.getItem(NAV_WIDTH_STORAGE_KEY)).toBe('334')
  })

  it('holds a width to the same bounds on the way in and on the way out', () => {
    // Half the viewport is the cap. A width stored on a wide monitor must not survive verbatim into
    // a narrow window, and a value written straight through `writeNavWidth` must not escape it.
    writeNavWidth(900)
    expect(readNavWidth()).toBe(500)

    localStorage.setItem(NAV_WIDTH_STORAGE_KEY, '900')
    expect(readNavWidth()).toBe(500)

    localStorage.setItem(NAV_WIDTH_STORAGE_KEY, '20')
    expect(readNavWidth()).toBe(NAV_WIDTH_MIN)
  })

  it('falls back to the default, clamped, when nothing usable is stored', () => {
    expect(readNavWidth()).toBe(NAV_WIDTH_DEFAULT)

    localStorage.setItem(NAV_WIDTH_STORAGE_KEY, 'not-a-width')
    expect(readNavWidth()).toBe(NAV_WIDTH_DEFAULT)

    // A window too narrow for the default gets the cap rather than the default.
    window.innerWidth = 400
    localStorage.removeItem(NAV_WIDTH_STORAGE_KEY)
    expect(readNavWidth()).toBe(NAV_WIDTH_MIN)
  })

  it('keeps the minimum when the viewport is narrower than twice the minimum', () => {
    window.innerWidth = 300
    expect(clampNavWidth(280)).toBe(NAV_WIDTH_MIN)
  })
})
