import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const ci = loadYaml(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, {
    name?: string
    if?: string
    needs?: string[]
    permissions?: Record<string, string>
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
    const runGate = (results: Record<string, { result: string }>) => runGateWith(gate, results, [])

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

  /**
   * GitHub reports a matrix job as `success` in `needs` when one of its legs
   * never got a machine and was cancelled, so `needs` alone passed a run in
   * which a macOS lane never ran. The gate also reads every job's own
   * conclusion; only the non-gating jobs, and a skipped Windows gate, are
   * allowed to differ.
   */
  it.skipIf(!hasBashAndJq)('also fails on a leg that never ran, which needs reports as success', () => {
    const packaging = ci.jobs.packaging!
    const gate = packaging.steps!.find((step) => step.name === GATE_STEP)!
    expect(packaging.permissions).toEqual({ actions: 'read' })
    expect(gate.env?.GH_TOKEN).toBe('${{ github.token }}')
    // The names the jobs API reports are the jobs' display names in this file.
    expect(JSON.parse(gate.env!.NOT_GATED!)).toEqual(['packaging', ...NOT_GATING].map((job) => ci.jobs[job]?.name))
    expect(gate.env?.MAY_SKIP_NAME).toBe(ci.jobs['windows-gate']?.name)

    const allSuccessful = Object.fromEntries(packaging.needs!.map((job) => [job, { result: 'success' }]))
    const leg = (name: string, conclusion: string | null, status = 'completed') => ({ name, conclusion, status })
    const clean = [
      leg('Test (macos-latest, toolchain floor)', 'success'),
      leg('Packaging', null, 'in_progress'),
      leg('Codecov', 'failure'),
      leg('Early warning (ubuntu, next Node major)', null, 'in_progress'),
      leg('Windows gate profile (affected files)', 'skipped'),
    ]
    const passing = runGateWith(gate, allSuccessful, clean)
    expect(passing.status, passing.stderr).toBe(0)

    const lost = runGateWith(gate, allSuccessful, [...clean, leg('Test (macos-latest, declared floor)', 'cancelled')])
    expect(lost.status).toBe(1)
    expect(lost.stdout).toContain('Test (macos-latest, declared floor): cancelled')

    const skipped = runGateWith(gate, allSuccessful, [...clean, leg('Binary (darwin-arm64)', 'skipped')])
    expect(skipped.status, 'only the Windows gate may be skipped').toBe(1)

    const unreachable = runGateWith(gate, allSuccessful, clean, { apiFails: true })
    expect(unreachable.status).toBe(1)
    expect(unreachable.stdout).toContain("Could not list this run's jobs")
  })
})

/**
 * Runs the gate with stand-ins for `gh` (one page of the jobs API, or a
 * failure) and `sleep`, the way the job runs it.
 */
function runGateWith(
  gate: { run?: string; env?: Record<string, string> },
  results: Record<string, { result: string }>,
  jobs: unknown[],
  options: { apiFails?: boolean } = {},
) {
  const stubs = [
    `gh() { ${options.apiFails ? 'return 1' : 'printf "%s" "$JOBS_PAGE"'}; }`,
    'sleep() { :; }',
    '',
  ].join('\n')
  return spawnSync('bash', ['-euo', 'pipefail', '-c', stubs + gate.run!], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...gate.env,
      RESULTS: JSON.stringify(results),
      JOBS_PAGE: JSON.stringify({ total_count: jobs.length, jobs }),
      GITHUB_REPOSITORY: 'looptroop-ai/LoopTroop',
      GITHUB_RUN_ID: '42',
    },
  })
}
