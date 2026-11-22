import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const ci = loadYaml(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')) as {
  on: Record<string, unknown>
  jobs: Record<string, {
    name?: string
    if?: string
    needs?: string | string[]
    permissions?: Record<string, string>
    outputs?: Record<string, string>
    'continue-on-error'?: unknown
    steps?: Array<{ id?: string; name?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }>
  }>
}

/** Jobs that report but do not decide a merge: a third party's upload, and the advisory next-Node lane. */
const NOT_GATING = ['codecov', 'early-warning']
/** Jobs whose normal result is "skipped": the Windows gate for most pull requests, the merge check for all of them. */
const MAY_SKIP = ['windows-gate', 'merge-check']
const GATE_STEP = 'Require every needed job to have succeeded'
/** What a job's `if` says to skip on a merge the merge check found already tested. */
const UNLESS_TESTED = "needs.merge-check.outputs.tested != 'true'"

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
    expect([packaging.needs].flat().sort()).toEqual(expected.sort())
    // Runs whatever its dependencies did, except on a merge already tested, where nothing ran.
    expect(packaging.if).toBe(`\${{ always() && ${UNLESS_TESTED} }}`)
    // The context branch protection matches, and after the post-merge trim the
    // only one: a renamed gate would leave GitHub waiting for a check that never
    // reports.
    expect(packaging.name).toBe('Packaging')
    expect(ci.jobs['early-warning']?.['continue-on-error']).toBe(true)
    for (const job of expected) expect(ci.jobs[job]?.['continue-on-error'], job).toBeUndefined()
  })

  it.skipIf(!hasBashAndJq)('blocks the merge unless every needed job succeeds', () => {
    const packaging = ci.jobs.packaging!
    const gate = packaging.steps?.find((step) => step.name === GATE_STEP)
    if (!gate?.run) throw new Error('ci.yml: packaging result gate missing')
    expect(gate.env?.RESULTS).toBe('${{ toJSON(needs) }}')
    expect(gate.env?.MAY_SKIP?.split(' ')).toEqual(MAY_SKIP)

    const needs = [packaging.needs!].flat()
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
    expect(JSON.parse(gate.env!.MAY_SKIP_NAMES!)).toEqual(MAY_SKIP.map((job) => ci.jobs[job]?.name))

    const allSuccessful = Object.fromEntries([packaging.needs!].flat().map((job) => [job, { result: 'success' }]))
    const leg = (name: string, conclusion: string | null, status = 'completed') => ({ name, conclusion, status })
    const clean = [
      leg('Test (macos-latest, toolchain floor)', 'success'),
      leg('Packaging', null, 'in_progress'),
      leg('Codecov', 'failure'),
      leg('Early warning (ubuntu, next Node major)', null, 'in_progress'),
      leg('Windows gate profile (affected files)', 'skipped'),
      leg('Merge check', 'skipped'),
    ]
    const passing = runGateWith(gate, allSuccessful, clean)
    expect(passing.status, passing.stderr).toBe(0)

    const lost = runGateWith(gate, allSuccessful, [...clean, leg('Test (macos-latest, declared floor)', 'cancelled')])
    expect(lost.status).toBe(1)
    expect(lost.stdout).toContain('Test (macos-latest, declared floor): cancelled')

    const skipped = runGateWith(gate, allSuccessful, [...clean, leg('Binary (darwin-arm64)', 'skipped')])
    expect(skipped.status, 'only the Windows gate and the merge check may be skipped').toBe(1)

    const brokenCheck = runGateWith(gate, allSuccessful, [...clean.filter((job) => job.name !== 'Merge check'), leg('Merge check', 'failure')])
    expect(brokenCheck.status, 'a merge check that ran and failed is a finding').toBe(1)
    expect(brokenCheck.stdout).toContain('Merge check: failure')

    const unreachable = runGateWith(gate, allSuccessful, clean, { apiFails: true })
    expect(unreachable.status).toBe(1)
    expect(unreachable.stdout).toContain("Could not list this run's jobs")
  })
})

describe('CI merge check', () => {
  it('asks, on pushes only, with a read-only token, and hands its answer to the jobs', () => {
    const check = ci.jobs['merge-check']!
    expect(check.if).toBe("github.event_name == 'push'")
    expect(check.permissions).toEqual({ actions: 'read', contents: 'read', 'pull-requests': 'read' })
    expect(check.outputs).toEqual({ tested: '${{ steps.decide.outputs.tested }}', run_id: '${{ steps.decide.outputs.run_id }}' })
    const decide = check.steps!.find((step) => step.id === 'decide')!
    expect(decide.run).toBe('node scripts/merge-check.ts')
    expect(decide.env).toEqual({ GITHUB_TOKEN: '${{ github.token }}', BEFORE: '${{ github.event.before }}' })
    // The job checks out only what it runs, so the script may import nothing from the repository.
    const checkout = check.steps!.find((step) => step.uses?.startsWith('actions/checkout@'))!
    expect(String(checkout.with?.['sparse-checkout']).split(/\s+/).filter(Boolean).sort()).toEqual(['.nvmrc', 'scripts/merge-check.ts'])
    const source = readFileSync(join(process.cwd(), 'scripts/merge-check.ts'), 'utf8')
    const imports = [...source.matchAll(/^import\b[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1])
    expect(imports.length).toBeGreaterThan(0)
    for (const specifier of imports) expect(specifier, 'only node: built-ins').toMatch(/^node:/)
  })

  it('hands Codecov the pull request run\'s report on a merge already tested', () => {
    const codecov = ci.jobs.codecov!
    expect([codecov.needs].flat()).toContain('merge-check')
    expect(codecov.permissions?.actions).toBe('read')
    const download = codecov.steps!.find((step) => step.uses?.startsWith('actions/download-artifact@'))!
    expect(download.with).toMatchObject({
      'run-id': '${{ needs.merge-check.outputs.run_id || github.run_id }}',
      'github-token': "${{ needs.merge-check.outputs.run_id && github.token || '' }}",
    })
  })

  /**
   * Works out from the workflow which jobs run, the way GitHub decides it: a
   * job whose `if` has no status function is skipped when a job it needs was
   * skipped; one with a status function is decided by its condition alone,
   * read here for the merge check's answer and for a needed job's success.
   * The trap it guards: a job that needs the merge check without a status
   * function would be skipped on every pull request, where the check is.
   */
  it('runs everything for a pull request, a full push and the weekly run, and only the Codecov hand-off for a merge already tested', () => {
    type Outcome = 'runs' | 'skipped'
    const simulate = (check: 'skipped' | 'untested' | 'tested') => {
      const outcomes = new Map<string, Outcome>()
      const visit = (job: string): Outcome => {
        const known = outcomes.get(job)
        if (known) return known
        const definition = ci.jobs[job]
        if (!definition) throw new Error(`ci.yml: unknown job ${job}`)
        const needed = [definition.needs ?? []].flat().map(visit)
        const condition = definition.if ?? ''
        let outcome: Outcome
        if (job === 'merge-check') {
          outcome = check === 'skipped' ? 'skipped' : 'runs'
        } else if (/\b(?:always|cancelled|failure|success)\(\)/.test(condition)) {
          const skippedForTested = condition.includes(UNLESS_TESTED) && check === 'tested'
          const neededSuccess = [...condition.matchAll(/needs\.([\w-]+)\.result == 'success'/g)].map((match) => match[1]!)
          outcome = skippedForTested || neededSuccess.some((need) => visit(need) === 'skipped') ? 'skipped' : 'runs'
        } else {
          outcome = needed.includes('skipped') ? 'skipped' : 'runs'
        }
        outcomes.set(job, outcome)
        return outcome
      }
      for (const job of Object.keys(ci.jobs)) visit(job)
      return [...outcomes].filter(([, outcome]) => outcome === 'runs').map(([job]) => job).sort()
    }
    const everyJob = Object.keys(ci.jobs).sort()
    expect(simulate('skipped'), 'a pull request, or the weekly run').toEqual(everyJob.filter((job) => job !== 'merge-check'))
    expect(simulate('untested'), 'a push to main that runs in full').toEqual(everyJob)
    expect(simulate('tested'), 'a merge already tested').toEqual(['codecov', 'merge-check'])
    // Every job that starts a chain waits for the answer, so nothing begins before it.
    for (const [job, definition] of Object.entries(ci.jobs)) {
      const needs = [definition.needs ?? []].flat()
      if (job !== 'merge-check' && needs.every((need) => need === 'merge-check')) expect(needs, job).toEqual(['merge-check'])
    }
  })

  it('runs in full once a week, on main', () => {
    expect(ci.on.schedule).toEqual([{ cron: '37 3 * * 1' }])
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
