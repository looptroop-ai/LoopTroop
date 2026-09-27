import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const ci = loadYaml(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, {
    if?: string
    needs?: string[]
    steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>
  }>
}

const packagingJobs = [
  'dependency-review',
  'test-matrix',
  'smoke-installer',
  'node-managers',
  'bundle',
  'bundle-runs',
  'formula-audit',
  'channel-install',
  'choco-install',
  'binary',
  'winget-install',
  'aur-package',
]

describe('CI packaging gate policy', () => {
  it('blocks packaging unless every required job succeeds', () => {
    const packaging = ci.jobs.packaging
    if (!packaging?.needs) throw new Error('ci.yml: packaging dependencies missing')
    expect([...packaging.needs].sort()).toEqual([...packagingJobs].sort())
    expect(packaging.if).toBe('always()')

    const gate = packaging.steps?.find((step) => step.name === 'Require every packaging job to have succeeded')
    if (!gate?.run) throw new Error('ci.yml: packaging result gate missing')
    expect(gate.env?.RESULTS).toBe('${{ toJSON(needs) }}')

    const allSuccessful = Object.fromEntries(packagingJobs.map((job) => [job, { result: 'success' }]))
    const runGate = (results: Record<string, { result: string }>) => spawnSync(
      'bash',
      ['-euo', 'pipefail', '-c', gate.run!],
      { encoding: 'utf8', env: { ...process.env, RESULTS: JSON.stringify(results) } },
    )

    const success = runGate(allSuccessful)
    expect(success.status, success.stderr).toBe(0)
    expect(success.stdout).toContain('Every packaging job succeeded.')

    for (const job of packagingJobs) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        const results = { ...allSuccessful, [job]: { result } }
        const failed = runGate(results)
        expect(failed.status, `${job}=${result}: ${failed.stderr}`).toBe(1)
        expect(failed.stdout, `${job}=${result}`).toContain(`${job}: ${result}`)
      }
    }
  })
})
