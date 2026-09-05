import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatNodeVersion,
  parseNodeFloor,
  parseNodeVersion,
  satisfiesNodeFloor,
  type NodeVersion,
} from '../nodeFloor'

const FLOOR: NodeVersion = { major: 24, minor: 18, patch: 1, prerelease: false }
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('parseNodeVersion', () => {
  it('reads a plain version, a v-prefixed one and a tagged one', () => {
    expect(parseNodeVersion('24.18.1')).toEqual(FLOOR)
    expect(parseNodeVersion('v24.18.1')).toEqual(FLOOR)
    expect(parseNodeVersion('25.0.0-nightly')).toEqual({ major: 25, minor: 0, patch: 0, prerelease: true })
  })

  /**
   * Unreadable components read as 0, which can only under-report a runtime, so
   * an unparseable version fails the floor rather than sneaking past it. The
   * dash in `not-a-version` reads as a prerelease tag, which is wrong in detail
   * and right in direction — it lowers the result further.
   */
  it('fails closed on anything it cannot read', () => {
    expect(parseNodeVersion('')).toEqual({ major: 0, minor: 0, patch: 0, prerelease: false })
    expect(parseNodeVersion('not-a-version')).toEqual({ major: 0, minor: 0, patch: 0, prerelease: true })
    expect(satisfiesNodeFloor(parseNodeVersion('not-a-version'), FLOOR)).toBe(false)
    expect(satisfiesNodeFloor(parseNodeVersion(''), FLOOR)).toBe(false)
  })
})

describe('parseNodeFloor', () => {
  it('reads the engines form and the bare form the same way', () => {
    expect(parseNodeFloor('>=24.18.1')).toEqual(FLOOR)
    expect(parseNodeFloor('24.18.1')).toEqual(FLOOR)
    expect(parseNodeFloor('>= 24.18.1')).toEqual(FLOOR)
  })

  /**
   * A floor is the one value with no safe fallback. Reading `{0,0,0}` out of a
   * malformed range would accept every runtime, so `doctor`'s node check would
   * pass unconditionally with nothing on screen to say the check had stopped
   * meaning anything. Throwing is the only fail-closed answer.
   */
  it.each(['', 'latest', '*', '>=x.y.z'])('throws rather than accepting everything for %o', (range) => {
    expect(() => parseNodeFloor(range)).toThrow(/Unreadable Node floor/)
  })

  /**
   * A positive major is not enough. `>=24.bad.1` read component by component is
   * `24.0.1` — a floor every Node in the wild clears, written into the launcher,
   * doctor, the installers and the verifier, all agreeing with each other.
   * Matching the whole grammar is what turns a typo into a build failure.
   */
  it.each(['>=24.bad.1', '>=24.18.x', '>=24.18', '>=24', '>=24.18.1.2', '^24.18.1', '>=24.18.-1'])(
    'throws for the malformed floor %o even though its major reads',
    (range) => {
      expect(() => parseNodeFloor(range)).toThrow(/Unreadable Node floor/)
    },
  )

  it('reads a prerelease floor, which asks for the prereleases too', () => {
    expect(parseNodeFloor('>=24.18.1-rc.0')).toEqual({ major: 24, minor: 18, patch: 1, prerelease: true })
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
    expect(satisfiesNodeFloor({ ...FLOOR, patch: 0 }, FLOOR)).toBe(false)
    expect(satisfiesNodeFloor({ ...FLOOR, patch: 2 }, FLOOR)).toBe(true)
  })

  it('rejects the minor just below and accepts the one just above', () => {
    expect(satisfiesNodeFloor({ ...FLOOR, minor: 17, patch: 99 }, FLOOR)).toBe(false)
    expect(satisfiesNodeFloor({ ...FLOOR, minor: 19, patch: 0 }, FLOOR)).toBe(true)
  })

  it('rejects the major just below and accepts the one just above', () => {
    expect(satisfiesNodeFloor({ ...FLOOR, major: 23, minor: 99, patch: 99 }, FLOOR)).toBe(false)
    expect(satisfiesNodeFloor({ ...FLOOR, major: 25, minor: 0, patch: 0 }, FLOOR)).toBe(true)
  })

  /**
   * A prerelease of a version is *below* that version, which is how npm reads
   * `engines` and so the only reading that agrees with the installer that put
   * the runtime there. `24.18.1-rc.1` is missing whatever 24.18.1 fixed, and the
   * comparison used to wave it through because the numbers matched.
   */
  it('rejects a prerelease of the floor and accepts a prerelease above it', () => {
    expect(satisfiesNodeFloor(parseNodeVersion('24.18.1-rc.1'), FLOOR)).toBe(false)
    expect(satisfiesNodeFloor(parseNodeVersion('v25.0.0-nightly20260101'), FLOOR)).toBe(true)
  })

  /** A prerelease floor is asking for the prereleases too, npm's `includePrerelease`. */
  it('accepts a prerelease when the floor is itself one', () => {
    const prereleaseFloor = parseNodeVersion('24.18.1-rc.0')
    expect(satisfiesNodeFloor(parseNodeVersion('24.18.1-rc.1'), prereleaseFloor)).toBe(true)
  })
})

describe('formatNodeVersion', () => {
  it('prints the patch level, which is what a user has to install', () => {
    expect(formatNodeVersion(FLOOR)).toBe('24.18.1')
  })
})

/**
 * `engines.node` is the single hand-written floor; every other copy is
 * generated from it. `npm run installers:check` proves the generated copies
 * still agree, but it only runs in the release workflow — by which point a
 * mismatch is already on `main`. This is the per-PR half of that gate.
 */
describe('the declared floor', () => {
  it('is a form this module can actually read', () => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      engines?: { node?: string }
    }
    const declared = manifest.engines?.node
    expect(declared).toMatch(/^>=\s*\d+\.\d+\.\d+$/)

    const floor = parseNodeFloor(declared ?? '')
    expect(floor.major).toBeGreaterThanOrEqual(24)
    expect(`>=${formatNodeVersion(floor)}`).toBe(declared?.replace(/\s+/g, ''))
  })
})
