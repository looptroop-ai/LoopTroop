import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import vitestConfig from '../vitest.config'

const repo = process.cwd()
const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  devDependencies: Record<string, string>
}
const ci = loadYaml(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8')) as {
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

const step = (job: Job, predicate: (candidate: Step) => boolean): Step => {
  const result = job.steps?.find(predicate)
  if (!result) throw new Error('Expected workflow step is missing')
  return result
}

const requiredJob = (name: string): Job => {
  const result = ci.jobs[name]
  if (!result) throw new Error(`Expected CI job ${name} is missing`)
  return result
}

describe('coverage and Codecov policy', () => {
  it('collects V8 coverage across the four Vitest projects with 90% line and 80% branch floors', () => {
    expect(packageJson.scripts['test:coverage']).toBe('vitest run --coverage')
    expect(packageJson.devDependencies.vitest).toMatch(/\S/)
    expect(packageJson.devDependencies['@vitest/coverage-v8']).toBe(packageJson.devDependencies.vitest)

    const coverage = vitestConfig.test?.coverage
    expect(coverage).toMatchObject({
      provider: 'v8',
      include: ['{src,server,shared}/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
      reporter: ['lcovonly', 'text', 'json-summary'],
      autoAttachSubprocess: false,
    })
    expect(coverage?.thresholds?.lines).toBe(90)
    expect(coverage?.thresholds?.branches).toBe(80)
    for (const pattern of [
      '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/{test,tests}/**',
      '**/{helper,helpers,fixture,fixtures}/**', '**/*.d.{ts,cts,mts}',
      '**/*.config.*', '**/generated/**', '**/*.generated.*',
    ]) expect(coverage?.exclude).toContain(pattern)

    const projects = vitestConfig.test?.projects as Array<{ test?: { name?: string; include?: string[]; isolate?: boolean; pool?: string } }>
    expect(projects.map((project) => project.test?.name)).toEqual([
      'client-dom', 'client-node', 'server-pure', 'server-integration',
    ])
  })

  it('keeps mocked, process-spawning, and integration tests isolated', () => {
    const projects = vitestConfig.test?.projects as Array<{ test?: { name?: string; include?: string[]; isolate?: boolean; pool?: string } }>
    const integration = projects.find((project) => project.test?.name === 'server-integration')
    expect(integration?.test).toMatchObject({ pool: 'forks', isolate: true })
    const includes = integration?.test?.include ?? []
    const matches = (file: string) => includes.some((pattern) => {
      const wildcard = pattern.indexOf('*')
      if (wildcard < 0) return pattern === file
      const prefix = pattern.slice(0, wildcard)
      const suffix = pattern.slice(wildcard + 1)
      const middle = file.slice(prefix.length, file.length - suffix.length)
      return file.startsWith(prefix) && file.endsWith(suffix) && !middle.includes('/')
    })
    const scan = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) return scan(absolute)
      if (!/\.(?:test|spec)\.[jt]sx?$/.test(entry.name)) return []
      const file = relative(repo, absolute).split(sep).join('/')
      const source = readFileSync(absolute, 'utf8')
      const hasMock = /\bvi\.(?:mock|doMock)\s*\(/.test(source)
      const spawnsProcess = source.split(/\r?\n/).some((line) =>
        /^\s*import\b/.test(line) && /from\s*['"](?:node:)?child_process['"]/.test(line))
      return hasMock || spawnsProcess || file.includes('.integration.test.') ? [file] : []
    })
    const missing = ['server', 'shared', 'tests'].flatMap(scan).filter((file) => !matches(file))

    expect(missing).toEqual([])
  })

  it('collects coverage in Verify and keeps the OIDC upload separate', () => {
    const verify = requiredJob('verify')
    const upload = requiredJob('codecov')
    expect(ci.jobs.coverage).toBeUndefined()
    expect(verify['runs-on']).toBe('ubuntu-latest')
    expect(verify.permissions).toEqual({ contents: 'read' })
    const collectionCheckout = step(verify, (candidate) => candidate.uses?.startsWith('actions/checkout@') ?? false)
    expect(collectionCheckout.with).toEqual({
      ref: '${{ github.event.pull_request.head.sha || github.sha }}',
      'persist-credentials': false,
    })
    expect(step(verify, (candidate) => candidate.uses?.startsWith('actions/setup-node@') ?? false).with)
      .toMatchObject({ 'node-version-file': '.nvmrc', cache: 'npm' })
    expect(verify.steps?.some((candidate) => candidate.run === 'node scripts/pin-npm.mjs')).toBe(true)
    expect(verify.steps?.some((candidate) => candidate.run === 'npm ci')).toBe(true)
    expect(verify.steps?.some((candidate) => candidate.run === 'npm run test')).toBe(false)
    expect(verify.steps?.some((candidate) => candidate.run === 'npm run test:coverage')).toBe(true)
    expect(step(verify, (candidate) => candidate.uses?.startsWith('actions/upload-artifact@') ?? false).with)
      .toMatchObject({
        name: 'coverage-report', path: 'coverage/', 'if-no-files-found': 'error', 'retention-days': 7,
      })

    expect(upload.needs).toBe('verify')
    expect(upload.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
    const uploadCheckout = step(upload, (candidate) => candidate.uses?.startsWith('actions/checkout@') ?? false)
    expect(uploadCheckout.with).toEqual(collectionCheckout.with)
    expect(step(upload, (candidate) => candidate.uses?.startsWith('actions/download-artifact@') ?? false).with)
      .toMatchObject({ name: 'coverage-report', path: 'coverage' })
    const action = step(upload, (candidate) => candidate.uses?.startsWith('codecov/codecov-action@') ?? false)
    expect(action.uses).toMatch(/^codecov\/codecov-action@[0-9a-f]{40}$/)
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

  it('reports project coverage and keeps patch status informational', () => {
    const config = loadYaml(readFileSync(join(repo, 'codecov.yml'), 'utf8')) as {
      coverage: { status: { project: { default: Record<string, unknown> }; patch: { default: Record<string, unknown> } } }
    }
    expect(config.coverage.status.project.default).toEqual({
      target: '90%',
      threshold: '0%',
      informational: false,
    })
    expect(config.coverage.status.patch.default).toEqual({ informational: true })
  })
})
