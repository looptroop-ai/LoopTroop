import { describe, it, expect } from 'vitest'
import { resolveGuard } from '../scripts/release-guard.mjs'

/**
 * The decision that separates "built and verified" from "published to seven
 * registries".
 *
 * It was fifteen lines of shell inside the release workflow, and it was wrong
 * twice: once because a boolean input arrives as the *string* `"false"`, which is
 * truthy in a GitHub expression and inverted the guard; once because every
 * manual dispatch was forced to a dry run, which made the `skip_binaries`
 * bypass unusable — an input that could be set for a release that could never
 * happen. Neither was visible without running a release.
 */
describe('the publication guard', () => {
  const MAIN = 'refs/heads/main'

  it('publishes on a push to main', () => {
    expect(resolveGuard({ event: 'push', ref: MAIN, requested: '', skipBinaries: '' }))
      .toMatchObject({ dryRun: false, skipBinaries: false })
  })

  it('never publishes on a push to any other branch', () => {
    expect(resolveGuard({ event: 'push', ref: 'refs/heads/release/9.9.9', requested: 'false', skipBinaries: '' }).dryRun)
      .toBe(true)
  })

  /** The bug: a dispatch asking to publish was silently forced to a dry run. */
  it('publishes from a dispatch only with the binary bypass, on main', () => {
    expect(resolveGuard({ event: 'workflow_dispatch', ref: MAIN, requested: 'false', skipBinaries: 'true' }))
      .toMatchObject({ dryRun: false, skipBinaries: true })
  })

  it.each([
    ['without the bypass', { requested: 'false', skipBinaries: 'false' }],
    ['without asking to publish', { requested: 'true', skipBinaries: 'true' }],
    ['with neither', { requested: 'true', skipBinaries: 'false' }],
  ])('refuses to publish from a dispatch %s', (_case, inputs) => {
    expect(resolveGuard({ event: 'workflow_dispatch', ref: MAIN, ...inputs }).dryRun).toBe(true)
  })

  /**
   * The bypass exists for a runner outage, not for releasing from a branch.
   * Publishing from anywhere but `main` would tag unreviewed code.
   */
  it('refuses the bypass from a branch that is not main', () => {
    const guard = resolveGuard({
      event: 'workflow_dispatch',
      ref: 'refs/heads/release/9.9.9',
      requested: 'false',
      skipBinaries: 'true',
    })

    expect(guard.dryRun).toBe(true)
    // Still records the operator's intent, so `build` tolerates the absent matrix
    // and the report says the binaries were skipped rather than lost.
    expect(guard.skipBinaries).toBe(true)
    expect(guard.notes.join(' ')).toContain('publishes only from refs/heads/main')
  })

  /**
   * The string "false" is truthy in a GitHub expression, which is how this was
   * inverted the first time. Nothing here may test truthiness.
   */
  it('treats the string "false" as false, everywhere it appears', () => {
    expect(resolveGuard({ event: 'workflow_dispatch', ref: MAIN, requested: 'false', skipBinaries: 'false' }).dryRun).toBe(true)
    expect(resolveGuard({ event: 'workflow_dispatch', ref: MAIN, requested: 'false', skipBinaries: 'false' }).skipBinaries).toBe(false)
  })

  it('says why, whenever it overrides a request to publish', () => {
    const guard = resolveGuard({ event: 'workflow_dispatch', ref: MAIN, requested: 'false', skipBinaries: '' })

    expect(guard.notes.join(' ')).toContain('Forcing a dry run')
  })

  it('stays quiet when nothing was overridden', () => {
    expect(resolveGuard({ event: 'workflow_dispatch', ref: MAIN, requested: 'true', skipBinaries: '' }).notes).toEqual([])
  })

  /** A push never carries dispatch inputs, so the bypass is unreachable there. */
  it('cannot be reached by a push, even if the inputs somehow arrive', () => {
    expect(resolveGuard({ event: 'push', ref: 'refs/heads/other', requested: 'false', skipBinaries: 'true' }))
      .toMatchObject({ dryRun: true, skipBinaries: false })
  })
})
