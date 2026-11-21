import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const ci = loadYaml(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, {
    if?: string
    needs?: string[]
    'continue-on-error'?: unknown
    steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>
  }>
}

/** Jobs that report but do not decide a merge: a third party's upload, and the advisory next-Node lane. */
const NOT_GATING = ['codecov', 'early-warning']
/** The one job whose normal result for most pull requests is "skipped". */
const MAY_SKIP = ['windows-gate']
const GATE_STEP = 'Require every needed job to have succeeded'

const hasBashAndJq = spawnSync('bash', ['-euo', 'pipefail', '-c', 'command -v jq'], { encoding: 'utf8' }).status === 0

describe('CI merge gate policy', () => {
  /**
   * Derived from the workflow rather than listed here: a job added later is
   * gated the moment it exists, unless it is named as not gating above. The
   * only advisory job must say so with continue-on-error.
   */
  it('makes Packaging wait on every job that is not explicitly advisory', () => {
    const packaging = ci.jobs.packaging
    if (!packaging?.needs) throw new Error('ci.yml: packaging dependencies missing')
    const expected = Object.keys(ci.jobs).filter((job) => job !== 'packaging' && !NOT_GATING.includes(job))
    expect([...packaging.needs].sort()).toEqual(expected.sort())
    expect(packaging.if).toBe('always()')
    expect(ci.jobs['early-warning']?.['continue-on-error']).toBe(true)
    for (const job of expected) expect(ci.jobs[job]?.['continue-on-error'], job).toBeUndefined()
  })

  it.skipIf(!hasBashAndJq)('blocks the merge unless every needed job succeeds', () => {
    const packaging = ci.jobs.packaging!
    const gate = packaging.steps?.find((step) => step.name === GATE_STEP)
    if (!gate?.run) throw new Error('ci.yml: packaging result gate missing')
    expect(gate.env?.RESULTS).toBe('${{ toJSON(needs) }}')
    expect(gate.env?.MAY_SKIP?.split(' ')).toEqual(MAY_SKIP)

    const needs = packaging.needs!
    const allSuccessful = Object.fromEntries(needs.map((job) => [job, { result: 'success' }]))
    const runGate = (results: Record<string, { result: string }>) => spawnSync(
      'bash',
      ['-euo', 'pipefail', '-c', gate.run!],
      { encoding: 'utf8', env: { ...process.env, RESULTS: JSON.stringify(results), MAY_SKIP: gate.env!.MAY_SKIP } },
    )

    const success = runGate(allSuccessful)
    expect(success.status, success.stderr).toBe(0)
    expect(success.stdout).toContain('Every needed job succeeded.')

    for (const job of needs) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        const outcome = runGate({ ...allSuccessful, [job]: { result } })
        if (result === 'skipped' && MAY_SKIP.includes(job)) {
          expect(outcome.status, `${job}=${result}: ${outcome.stderr}`).toBe(0)
          continue
        }
        expect(outcome.status, `${job}=${result}: ${outcome.stderr}`).toBe(1)
        expect(outcome.stdout, `${job}=${result}`).toContain(`${job}: ${result}`)
      }
    }
  })
})
