import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import vitestConfig from '../vitest.config'

const repo = process.cwd()
const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  devDependencies: Record<string, string>
}
const ci = yaml.load(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, Job>
}

type Step = {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
}
type Job = {
  needs?: string | string[]
  permissions?: Record<string, string>
  steps?: Step[]
  'runs-on'?: string
}

const commitRef = '${{ github.event.pull_request.head.sha || github.sha }}'

function step(job: Job, predicate: (candidate: Step) => boolean): Step {
  const result = job.steps?.find(predicate)
  if (!result) throw new Error('Expected workflow step is missing')
  return result
}

function requiredJob(name: string): Job {
  const result = ci.jobs[name]
  if (!result) throw new Error(`Expected CI job ${name} is missing`)
  return result
}

describe('coverage and Codecov policy', () => {
  it('collects V8 coverage across the four Vitest projects without thresholds', () => {
    expect(packageJson.scripts['test:coverage']).toBe('vitest run --coverage')
    expect(packageJson.devDependencies['@vitest/coverage-v8']).toBe('^5.0.1')
    expect(packageJson.devDependencies.vitest).toBe('^5.0.1')

    const coverage = vitestConfig.test?.coverage
    expect(coverage).toMatchObject({
      provider: 'v8',
      include: ['{src,server,shared}/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
      reporter: ['lcov', 'text', 'json-summary'],
      autoAttachSubprocess: false,
    })
    expect(coverage?.thresholds).toBeUndefined()
    for (const pattern of [
      '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/{test,tests}/**',
      '**/{helper,helpers,fixture,fixtures}/**', '**/*.d.{ts,cts,mts}',
      '**/*.config.*', '**/generated/**', '**/*.generated.*',
    ]) expect(coverage?.exclude).toContain(pattern)

    const projects = vitestConfig.test?.projects as Array<{ test?: { name?: string } }>
    expect(projects.map((project) => project.test?.name)).toEqual([
      'client-dom', 'client-node', 'server-pure', 'server-integration',
    ])
  })

  it('keeps Codecov upload isolated from the coverage collection job', () => {
    const coverage = requiredJob('coverage')
    const upload = requiredJob('codecov')
    expect(coverage['runs-on']).toBe('ubuntu-latest')
    expect(coverage.permissions).toEqual({ contents: 'read' })
    const audit = step(coverage, (candidate) => candidate.uses?.startsWith('step-security/harden-runner@') ?? false)
    expect(audit.with?.['egress-policy']).toBe('audit')
    const collectionCheckout = step(coverage, (candidate) => candidate.uses?.startsWith('actions/checkout@') ?? false)
    expect(collectionCheckout.with).toMatchObject({ ref: commitRef, 'persist-credentials': false })
    expect(step(coverage, (candidate) => candidate.uses?.startsWith('actions/setup-node@') ?? false).with)
      .toMatchObject({ 'node-version-file': '.nvmrc', cache: 'npm' })
    expect(coverage.steps?.some((candidate) => candidate.run === 'node scripts/pin-npm.mjs')).toBe(true)
    expect(coverage.steps?.some((candidate) => candidate.run === 'npm ci')).toBe(true)
    expect(coverage.steps?.some((candidate) => candidate.run === 'npm run test:coverage')).toBe(true)
    expect(step(coverage, (candidate) => candidate.uses?.startsWith('actions/upload-artifact@') ?? false).with)
      .toMatchObject({ name: 'coverage-report', path: 'coverage/', 'if-no-files-found': 'error' })

    expect(upload.needs).toBe('coverage')
    expect(upload.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
    const uploadCheckout = step(upload, (candidate) => candidate.uses?.startsWith('actions/checkout@') ?? false)
    expect(uploadCheckout.with).toMatchObject({ ref: commitRef, 'persist-credentials': false })
    expect(uploadCheckout.with).toEqual(collectionCheckout.with)
    expect(step(upload, (candidate) => candidate.uses?.startsWith('actions/download-artifact@') ?? false).with)
      .toMatchObject({ name: 'coverage-report', path: 'coverage' })
    const action = step(upload, (candidate) => candidate.uses?.startsWith('codecov/codecov-action@') ?? false)
    expect(action.uses).toBe('codecov/codecov-action@303a32d7a59b442fa8d48b6a1cc6825c09c847a5')
    expect(action.with).toMatchObject({
      use_oidc: true,
      version: 'v11.3.1',
      files: 'coverage/lcov.info',
      disable_search: true,
      plugins: 'noop',
      fail_ci_if_error: true,
    })
    expect(action.with?.token).toBeUndefined()
    expect(action.with?.skip_validation).toBeUndefined()
    expect(upload.steps?.some((candidate) => candidate.run !== undefined)).toBe(false)
    expect(upload.steps?.some((candidate) => candidate.uses?.startsWith('step-security/harden-runner@'))).toBe(false)

    const packaging = requiredJob('packaging')
    expect(packaging.needs).not.toContain('coverage')
    expect(packaging.needs).not.toContain('codecov')
  })

  it('keeps project and patch coverage statuses informational', () => {
    const config = yaml.load(readFileSync(join(repo, 'codecov.yml'), 'utf8')) as {
      coverage: { status: { project: { default: Record<string, unknown> }; patch: { default: Record<string, unknown> } } }
    }
    expect(config.coverage.status.project.default).toEqual({ informational: true })
    expect(config.coverage.status.patch.default).toEqual({ informational: true })
  })
})
