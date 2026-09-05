import { describe, it, expect } from 'vitest'
import {
  formatNodeVersion,
  parseNodeFloor,
  parseNodeVersion,
  satisfiesNodeFloor,
  type NodeVersion,
} from '../nodeFloor'

const FLOOR: NodeVersion = { major: 24, minor: 18, patch: 1 }

describe('parseNodeVersion', () => {
  it('reads a plain version, a v-prefixed one and a tagged one', () => {
    expect(parseNodeVersion('24.18.1')).toEqual({ major: 24, minor: 18, patch: 1 })
    expect(parseNodeVersion('v24.18.1')).toEqual({ major: 24, minor: 18, patch: 1 })
    expect(parseNodeVersion('25.0.0-nightly')).toEqual({ major: 25, minor: 0, patch: 0 })
  })

  /**
   * Unreadable components read as 0, which can only under-report a runtime, so
   * an unparseable version fails the floor rather than sneaking past it.
   */
  it('fails closed on anything it cannot read', () => {
    expect(parseNodeVersion('')).toEqual({ major: 0, minor: 0, patch: 0 })
    expect(parseNodeVersion('not-a-version')).toEqual({ major: 0, minor: 0, patch: 0 })
    expect(satisfiesNodeFloor(parseNodeVersion('not-a-version'), FLOOR)).toBe(false)
  })
})

describe('parseNodeFloor', () => {
  it('reads the engines form and the bare form the same way', () => {
    expect(parseNodeFloor('>=24.18.1')).toEqual(FLOOR)
    expect(parseNodeFloor('24.18.1')).toEqual(FLOOR)
    expect(parseNodeFloor('>= 24.18.1')).toEqual(FLOOR)
  })
})

describe('satisfiesNodeFloor', () => {
  it('accepts exactly the floor', () => {
    expect(satisfiesNodeFloor(FLOOR, FLOOR)).toBe(true)
  })

  /**
   * The patch level is the point. A major.minor comparison accepted 24.18.0,
   * which is below a floor of 24.18.1 — and the launcher, which used one,
   * printed `24.18.0` as the version the reader needed.
   */
  it('rejects the patch just below the floor and accepts the one just above', () => {
    expect(satisfiesNodeFloor({ major: 24, minor: 18, patch: 0 }, FLOOR)).toBe(false)
    expect(satisfiesNodeFloor({ major: 24, minor: 18, patch: 2 }, FLOOR)).toBe(true)
  })

  it('rejects the minor just below and accepts the one just above', () => {
    expect(satisfiesNodeFloor({ major: 24, minor: 17, patch: 99 }, FLOOR)).toBe(false)
    expect(satisfiesNodeFloor({ major: 24, minor: 19, patch: 0 }, FLOOR)).toBe(true)
  })

  it('rejects the major just below and accepts the one just above', () => {
    expect(satisfiesNodeFloor({ major: 23, minor: 99, patch: 99 }, FLOOR)).toBe(false)
    expect(satisfiesNodeFloor({ major: 25, minor: 0, patch: 0 }, FLOOR)).toBe(true)
  })
})

describe('formatNodeVersion', () => {
  it('prints the patch level, which is what a user has to install', () => {
    expect(formatNodeVersion(FLOOR)).toBe('24.18.1')
  })
})
