import { describe, it, expect } from 'vitest'
import { planMatrix } from '../scripts/smoke-published.mjs'

/**
 * The matrix is asserted by name rather than by count.
 *
 * Every hand-count of this matrix during planning was wrong — four times, in
 * four different directions — and a count alone would still let one leg be
 * swapped for another silently. Naming them means adding, moving or removing a
 * leg has to be an explicit edit here, where the reviewer sees it.
 *
 * These lists grow as each milestone lands. The final shape is 8 release legs
 * and 17 weekly ones; anything short of that is a milestone still in progress,
 * not a regression.
 */
const RELEASE_LEGS = [
  'npm (ubuntu-latest)',
  'npm (macos-latest)',
  'npm (windows-latest)',
]

describe('planMatrix', () => {
  it('emits exactly the release-tier legs, by name', () => {
    const names = planMatrix({ tier: 'release' }).map((leg) => leg.name)
    expect(names.sort()).toEqual([...RELEASE_LEGS].sort())
  })

  it('makes the weekly tier a superset of the release tier', () => {
    const release = planMatrix({ tier: 'release' }).map((leg) => leg.name)
    const weekly = planMatrix({ tier: 'weekly' }).map((leg) => leg.name)
    for (const name of release) expect(weekly).toContain(name)
    expect(weekly.length).toBeGreaterThanOrEqual(release.length)
  })

  it('gives every leg a unique name', () => {
    // The name is the job name, the artifact name and the report key. Two legs
    // sharing one would collide on artifact upload and silently overwrite a
    // result — a failure that reads as a missing leg rather than a clash.
    const names = planMatrix({ tier: 'weekly' }).map((leg) => leg.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('declares a known OpenCode mode on every leg', () => {
    const allowed = new Set(['installer', 'npm', 'adopt', 'mock', 'none'])
    for (const leg of planMatrix({ tier: 'weekly' })) {
      expect(allowed.has(leg.opencode), `${leg.name} has opencode=${leg.opencode}`).toBe(true)
    }
  })

  it('covers the OpenCode launch shapes that have actually broken', () => {
    // 0.5.7 shipped a daemon that could not spawn an npm-installed OpenCode on
    // Windows, because it is `opencode.cmd` rather than an `.exe`. Mock mode
    // cannot see that class of defect, so at least one Windows leg has to
    // install OpenCode from npm and start a real daemon.
    const windowsNpmOpencode = planMatrix({ tier: 'weekly' })
      .filter((leg) => leg.os.startsWith('windows') && leg.opencode === 'npm')
    expect(windowsNpmOpencode.length).toBeGreaterThan(0)
  })

  it('honours --only', () => {
    expect(planMatrix({ tier: 'weekly', only: ['npm'] }).every((leg) => leg.channel === 'npm')).toBe(true)
    expect(planMatrix({ tier: 'weekly', only: ['nothing-by-this-name'] })).toEqual([])
  })
})
