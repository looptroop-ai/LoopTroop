import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { formatNodeVersion, parseNodeFloor, parseNodeVersion, satisfiesNodeFloor } from '../shared/nodeFloor'

const repo = process.cwd()
const workflowDir = join(repo, '.github/workflows')
const files = readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file))
const source = new Map(files.map((file) => [file, readFileSync(join(workflowDir, file), 'utf8')]))

type Step = {
  name?: unknown
  run?: unknown
  uses?: unknown
  env?: Record<string, unknown>
  with?: Record<string, unknown>
  if?: unknown
  shell?: unknown
  'timeout-minutes'?: unknown
  'continue-on-error'?: unknown
}
type Permissions = Record<string, unknown> | string
type Job = { name?: unknown; permissions?: Permissions; steps?: Step[]; if?: unknown; 'continue-on-error'?: unknown; 'runs-on'?: unknown; 'timeout-minutes'?: unknown; defaults?: { run?: { shell?: unknown } } }
type Workflow = { jobs?: Record<string, Job>; permissions?: Permissions; env?: Record<string, unknown> }

const workflows = new Map(files.map((file) => [
  file,
  yaml.load(source.get(file)!) as Workflow,
]))

/** Exact three-part selectors are comparable; bare major selectors float by design. */
function concreteVersion(value: string) {
  const normalized = value.trim().replace(/^['"]|['"]$/g, '')
  if (!normalized.includes('.')) return null
  const numeric = normalized.replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(numeric)) {
    throw new Error(`Floating Node selector is not allowed: ${value}`)
  }
  return parseNodeVersion(numeric)
}

const FLOOR = formatNodeVersion(parseNodeFloor((JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
  engines: { node: string }
}).engines.node))
const TOOLCHAIN = formatNodeVersion(parseNodeVersion(readFileSync(join(repo, '.nvmrc'), 'utf8').trim()))
/** The standalone builder's embedded runtime. Confined to binary jobs by the test that pins it. */
const EMBEDDED_BUILDER = '26.9.0'
const PLATFORMS = ['macos-latest', 'ubuntu-latest', 'windows-latest']
/** The gate step every aggregate job in ci.yml shares; rerun-unacquired.yml reads failures of it as consequences. */
const GATE_STEP = 'Require every needed job to have succeeded'

type MatrixEntry = Record<string, unknown>

/** The `include` entries of a job's matrix, as the parser reads them. */
function matrixEntries(job: Job): MatrixEntry[] {
  const include = (job as { strategy?: { matrix?: { include?: unknown } } }).strategy?.matrix?.include
  return Array.isArray(include) ? include as MatrixEntry[] : []
}

type RenovateRule = {
  groupName?: string
  groupSlug?: string
  labels?: string[]
  addLabels?: string[]
  rangeStrategy?: string
  semanticCommitType?: string
  allowedVersions?: string
  matchFileNames?: string[]
  matchUpdateTypes?: string[]
  matchDepTypes?: string[]
  matchPackageNames?: string[]
}
type RenovateConfig = {
  automerge?: unknown
  lockFileMaintenance?: { automerge?: unknown }
  vulnerabilityAlerts?: { automerge?: unknown }
  packageRules: RenovateRule[]
}

type SetupStep = Step & { with?: Record<string, unknown> }
type SetupNodeStep = { where: string; steps: SetupStep[]; index: number }

function runs(job: Job): string {
  return (job.steps ?? []).map((step) => typeof step.run === 'string' ? step.run : '').join('\n')
}

function executeWindowsScope(run: string, changedPaths: string[], diffStatus = 0): {
  status: number | null
  stdout: string
  output: string
} {
  const directory = mkdtempSync(join(tmpdir(), 'looptroop-windows-scope-'))
  try {
    // A shell function overrides Git identically in POSIX shells and Git Bash,
    // without relying on Windows-to-POSIX PATH conversion for an extensionless fixture.
    const fixture = 'git() { if [ "$1" = diff ] && [ "$2" = --name-only ]; then if [ "$GIT_DIFF_STATUS" -ne 0 ]; then return "$GIT_DIFF_STATUS"; fi; printf \'%s\\n\' "$CHANGED_PATHS"; else return 1; fi; }\n'
    const outputPath = join(directory, 'github-output')
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', fixture + run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BASE_SHA: 'base-sha',
        CHANGED_PATHS: changedPaths.join('\n'),
        GIT_DIFF_STATUS: String(diffStatus),
        GITHUB_OUTPUT: outputPath,
        HEAD_SHA: 'head-sha',
      },
    })
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function executeCleanTreeGate(run: string, workingTree: string) {
  const fixture = 'git() { case "$1:$2" in status:--porcelain) printf "%s" "$WORKING_TREE" ;; --no-pager:diff) printf "simulated diff\\n" ;; *) return 2 ;; esac; }\n'
  return spawnSync('bash', ['-euo', 'pipefail', '-c', fixture + run], {
    encoding: 'utf8',
    env: { ...process.env, WORKING_TREE: workingTree },
  })
}

function executeNodeFloorGate(run: string, before: string, after: string, checkerStatus = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'looptroop-node-floor-gate-'))
  const checkerCalls = join(directory, 'checker-calls')
  const fixture = [
    'git() { case "$1" in fetch) return 0 ;; show) printf \'{}\\n\' ;; *) return 2 ;; esac; }',
    'node() {',
    '  if [ "$1" = "-p" ]; then',
    '    case "$2" in *readFileSync\\(0*) cat >/dev/null; printf "%s\\n" "$BEFORE" ;; *) printf "%s\\n" "$AFTER" ;; esac',
    '  elif [ "$1" = "scripts/check-node-feeds.ts" ]; then',
    '    printf "called\\n" >> "$CHECKER_CALLS"',
    '    return "$CHECKER_STATUS"',
    '  else return 2; fi',
    '}',
    '',
  ].join('\n')

  try {
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', fixture + run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AFTER: after,
        DIFF_BASE: 'base-ref',
        BEFORE: before,
        CHECKER_CALLS: checkerCalls,
        CHECKER_STATUS: String(checkerStatus),
      },
    })
    return { ...result, checkerCalled: existsSync(checkerCalls) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('release workflow policy', () => {
  it('limits runner auditing to supported jobs without publishing credentials', () => {
    for (const [file, workflow] of workflows) {
      for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
        const audit = (job.steps ?? []).find((step) => String(step.uses).startsWith('step-security/harden-runner@')) as SetupStep | undefined
        if (!audit) continue
        const scope = `${file}: ${name}`
        const permissions = job.permissions ?? workflow.permissions
        expect(permissions, scope).toBeDefined()
        if (typeof permissions === 'string') expect(permissions, scope).toBe('read-all')
        else expect(Object.values(permissions ?? {}).every((value) => value === 'read' || value === 'none'), scope).toBe(true)
        expect(JSON.stringify([workflow.env, job]), scope).not.toMatch(/\bsecrets\s*(?:\.|\[)/)
        expect((job as { container?: unknown }).container, scope).toBeUndefined()
        expect((job as { environment?: unknown }).environment, scope).toBeUndefined()
        // ponytail: pre hooks bypass step conditions; split mixed ARM jobs only if their other legs need auditing.
        const runner = job as Job & { 'runs-on'?: unknown; strategy?: unknown }
        expect(JSON.stringify([runner['runs-on'], runner.strategy]), scope).not.toMatch(/ubuntu[^"]*arm|linux-arm64/i)
        expect(audit.with?.['egress-policy'], scope).toBe('audit')
      }
    }
  })

  it('requires dependency review on every CI event before Packaging can pass', () => {
    const ci = workflows.get('ci.yml')!.jobs!
    const verify = ci.verify as Job & { if?: string }
    expect(verify.if).toBeUndefined()
    const action = verify.steps!.find((step) => String(step.uses).startsWith('actions/dependency-review-action@')) as SetupStep
    expect(action.if, 'no event skips the review, and an earlier failure does not hide it').toBe('${{ !cancelled() }}')
    expect(action.with).toMatchObject({
      'fail-on-scopes': 'runtime,development,unknown',
      'base-ref': '${{ env.DIFF_BASE }}',
      'head-ref': '${{ github.event.pull_request.head.sha || github.sha }}',
    })
    expect((ci.packaging as Job & { needs: string[] }).needs).toContain('verify')
    expect((ci.packaging as Job & { if: string }).if).toBe('always()')
    const gate = ci.packaging!.steps!.find((step) => step.name === GATE_STEP)!
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      const results = { verify: { result }, 'test-matrix': { result: 'success' } }
      const run = spawnSync('bash', ['-euo', 'pipefail', '-c', `gh() { printf '{"jobs":[]}'; }\n${String(gate.run)}`], {
        encoding: 'utf8',
        env: { ...process.env, ...gate.env, RESULTS: JSON.stringify(results), GITHUB_REPOSITORY: 'looptroop-ai/LoopTroop', GITHUB_RUN_ID: '42' },
      })
      expect(run.status, `${result}: ${run.stderr}`).toBe(result === 'success' ? 0 : 1)
    }
  })

  /**
   * A push to main used to be compared with main, which by then is the pushed
   * commit: the dependency diff was empty and the floor never changed, so both
   * gates passed without checking anything. A push compares with the commit
   * it replaced.
   */
  it('compares a push with the commit it replaced, not with itself', () => {
    const verify = workflows.get('ci.yml')!.jobs!.verify as Job & { env?: Record<string, string> }
    expect(verify.env?.DIFF_BASE).toBe(
      "${{ github.event.pull_request.base.sha || (github.event.before != '0000000000000000000000000000000000000000' && github.event.before) || github.event.repository.default_branch }}",
    )
    const floor = verify.steps!.find((step) => step.name === 'Check every feed offers a changed Node floor')!
    expect(String(floor.run)).toContain('git fetch --no-tags --depth=1 origin "${DIFF_BASE}"')
    expect(JSON.stringify(verify.steps)).not.toContain('github.event.repository.default_branch')
  })

  it('runs the workflow, shell, and local verification gates in blocking CI jobs', () => {
    const ci = workflows.get('ci.yml')!.jobs!
    const scripts = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }).scripts
    const verify = ci.verify as (Job & { 'continue-on-error'?: unknown }) | undefined
    if (!verify) throw new Error('ci.yml: verify job missing')
    expect(verify['runs-on']).toBe('ubuntu-latest')
    expect(Object.hasOwn(verify, 'continue-on-error'), 'the required Verify job must remain blocking').toBe(false)

    const steps = verify.steps ?? []
    const installer = steps.find((candidate) => candidate.name === 'Install actionlint')
    const lintCommand = steps.find((candidate) => candidate.name === 'Lint the workflows')?.run
    expect(String(installer?.run)).toMatch(/version=\d+\.\d+\.\d+/)
    expect(String(installer?.run)).toMatch(/sha256=[a-f0-9]{64}/)
    expect(steps.some((candidate) => candidate.run === 'shellcheck --version')).toBe(true)
    expect(String(lintCommand)).toContain('/tmp/actionlint -color -shellcheck="shellcheck -S warning"')

    // zizmor is pinned and verified like actionlint, and audits every workflow and local action.
    const zizmor = steps.find((candidate) => candidate.name === 'Install zizmor')
    expect(String(zizmor?.run)).toMatch(/version=\d+\.\d+\.\d+/)
    expect(String(zizmor?.run)).toMatch(/sha256=[a-f0-9]{64}/)
    expect(String(zizmor?.run)).toContain('sha256sum --check --status')
    const audit = steps.find((candidate) => candidate.name === 'Audit the workflows for security problems')
    expect(audit?.run).toBe('/tmp/zizmor --format github --no-progress .github')
    expect(audit?.env?.GH_TOKEN).toBe('${{ github.token }}')

    const verificationCommands = [
      ['npm run lint', 'lint'],
      ['npm run typecheck', 'typecheck'],
      ['npm run build', 'build'],
      ['npm run verify:no-native-addons', 'verify:no-native-addons'],
      ['npm run verify:package', 'verify:package'],
      ['npm run verify:version', 'verify:version'],
      ['npm run verify:strip-types', 'verify:strip-types'],
    ] as const
    const indices = verificationCommands.map(([command, script]) => {
      expect(scripts[script], `${script} is an npm script`).toBeDefined()
      const index = steps.findIndex((candidate) => candidate.run === command)
      expect(index, `${command} stays in the blocking Verify job`).toBeGreaterThan(-1)
      return index
    })
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
    // The root run writes Vite's caches as root, so anything after it that
    // writes them as the runner user, the build first of all, would fail.
    const asRoot = steps.findIndex((candidate) => String(candidate.run ?? '').includes('server/lib/__tests__/executablePath.test.ts'))
    expect(String(steps[asRoot]?.run)).toMatch(/^sudo /)
    expect(asRoot, 'the root-only test runs last').toBe(steps.length - 1)

    // One failure must not hide the next: every check after the checkout runs
    // unless the run was cancelled, and waits only for what it needs.
    const checkout = steps.findIndex((candidate) => String(candidate.uses ?? '').startsWith('actions/checkout@'))
    for (const candidate of steps.slice(checkout + 1).filter((step) => step.name !== 'Install actionlint')) {
      expect(String(candidate.if ?? ''), `Verify: ${String(candidate.name ?? candidate.uses)} runs after an earlier failure`).toContain('!cancelled()')
    }
    for (const command of ['npm run verify:no-native-addons', 'npm run verify:package']) {
      expect(steps.find((candidate) => candidate.run === command)?.if, command).toBe("${{ !cancelled() && steps.build.outcome == 'success' }}")
    }

    // The license notices are the install check's to verify, before any Mac or Windows job starts.
    const installCheck = ci['install-check']!
    expect(installCheck['runs-on']).toBe('ubuntu-latest')
    expect(scripts['licenses:check']).toBeDefined()
    const installIndex = (installCheck.steps ?? []).findIndex((candidate) => candidate.uses === './.github/actions/npm-ci')
    const clientIndex = (installCheck.steps ?? []).findIndex((candidate) => candidate.run === 'npm run build:client')
    const noticesIndex = (installCheck.steps ?? []).findIndex((candidate) => candidate.run === 'npm run licenses:check')
    expect(installIndex).toBeGreaterThan(-1)
    // The notices check reads the client bundle's list of inlined packages.
    expect(clientIndex, 'the client is built before the notices are checked').toBeGreaterThan(installIndex)
    expect(noticesIndex).toBeGreaterThan(clientIndex)
    const cleanTree = steps.find((candidate) => candidate.name === 'Verify working tree is clean after build')
    expect(cleanTree).toBeDefined()
    const cleanTreeCommand = String(cleanTree?.run ?? '')
    const clean = executeCleanTreeGate(cleanTreeCommand, '')
    expect(clean.status, clean.stderr).toBe(0)
    const dirty = executeCleanTreeGate(cleanTreeCommand, ' M generated-output.js')
    expect(dirty.status).toBe(1)
    expect(dirty.stdout).toContain('Build modified tracked files')
    expect(dirty.stdout).toContain('simulated diff')
  })

  it('expands release artifact VERSION arguments in Bash on Windows', () => {
    const job = workflows.get('release.yml')?.jobs?.['verify-artifact']
    if (!job) throw new Error('Release artifact verification job is missing')
    const matrix = (job as { strategy?: { matrix?: { os?: string[] } } }).strategy?.matrix
    expect(matrix?.os).toContain('windows-latest')
    const versionSteps = (job.steps ?? []).filter((step) => step.env?.VERSION !== undefined && /\$\{VERSION\}/.test(String(step.run)))
    expect(versionSteps.length).toBeGreaterThan(0)
    for (const step of versionSteps) {
      expect(step.shell ?? job.defaults?.run?.shell, String(step.name)).toBe('bash')
    }
  })

  it('fails release tag verification on registry errors while accepting a confirmed missing tag', () => {
    const release = source.get('release.yml')!
    const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }
    for (const variable of ['latest_before', 'latest_now']) {
      const lines = release.split('\n')
      const probeStart = lines.findIndex((line) =>
        line.includes(`${variable}=$(npm view looptroop dist-tags.latest`),
      )
      const probeEnd = lines.findIndex((line, index) => index >= probeStart && line.trim() === 'fi')
      const probe = probeStart >= 0 && probeEnd >= probeStart ? lines.slice(probeStart, probeEnd + 1).join('\n') : undefined
      expect(probe).toBeDefined()
      for (const [status, output] of [[0, version], [0, ''], [1, ''], [1, 'none']] as const) {
        const result = spawnSync('bash', ['-euo', 'pipefail', '-c', [
          'npm() { printf "%s" "$PROBE_OUTPUT"; return "$PROBE_STATUS"; }',
          probe!,
          `${variable}=\${${variable}:-none}`,
          `printf '%s' "\${${variable}}"`,
        ].join('\n')], {
          encoding: 'utf8',
          env: { ...process.env, PROBE_STATUS: String(status), PROBE_OUTPUT: output },
        })
        expect(result.status).toBe(status)
        expect(result.stdout).toBe(status === 0 ? output || 'none' : '')
      }
    }
  })

  it('treats quoted and shorthand Node selectors as concrete patch values', () => {
    const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { engines: { node: string } }
    const floor = parseNodeFloor(packageJson.engines.node)
    const shorthand = `${floor.major}.${floor.minor}`
    expect(parseNodeVersion(shorthand)).toEqual({ ...floor, patch: 0, prerelease: false })
    expect(satisfiesNodeFloor(parseNodeVersion(shorthand), { ...floor, patch: floor.patch + 1 })).toBe(false)
    expect(satisfiesNodeFloor(parseNodeVersion(`v${floor.major}.${floor.minor}.${floor.patch}`), floor)).toBe(true)
    expect(/^\s*node-version:\s*["']?(v?\d+(?:\.\d+){0,2})["']?(?=\s|$)/.exec(`node-version: "${shorthand}"`)?.[1])
      .toBe(shorthand)
  })

  /**
   * The toolchain is stated in `.nvmrc`, and every workflow reads it from there
   * with `node-version-file` instead of repeating it. Renovate moves `.nvmrc`
   * and the Dockerfile; no Renovate manager edits a number typed into a
   * workflow, so a typed copy is refused even while it agrees, because the next
   * toolchain pull request would leave it behind.
   *
   * The only typed versions are named exceptions: the standalone builder's
   * embedded runtime, which the binary-job test below confines to those jobs;
   * the declared-floor lanes, which read `engines.node` at run time; and the
   * early-warning lane, which works out the major after `.nvmrc`'s at run time.
   */
  it('types no copy of the toolchain Node into any workflow', () => {
    const typed = [...source].flatMap(([file, text]) =>
      [...text.matchAll(/^\s*node-version:\s*["']?(v?\d+(?:\.\d+){0,2})["']?(?=\s|$)/gm)].map((match) => ({ file, found: match[1] ?? '' })))
    expect(typed.length, 'the named exceptions are still typed').toBeGreaterThan(0)
    for (const { file, found } of typed) {
      const parsed = concreteVersion(found)
      if (parsed !== null) expect(formatNodeVersion(parsed), `${file}: node-version ${found}; read .nvmrc with node-version-file instead`).toBe(EMBEDDED_BUILDER)
    }
  })

  /**
   * A `node-version-file` step reads `.nvmrc` from the workspace, so an earlier
   * checkout has to put it there, at the workspace root. A sparse checkout has
   * to name it: in non-cone mode only the listed patterns reach the disk, which
   * is how four container jobs once asked setup-node for a file they never had.
   */
  function expectReadsNvmrc({ where, steps, index }: SetupNodeStep) {
    expect(steps[index]?.with?.['node-version-file'], `${where} reads the toolchain from .nvmrc`).toBe('.nvmrc')
    expect(steps[index]?.with?.['node-version'], `${where} sets node-version-file alone`).toBeUndefined()
    const checkout = steps.findIndex((candidate) => String(candidate.uses ?? '').startsWith('actions/checkout@'))
    expect(checkout, `${where} checks out .nvmrc before reading it`).toBeGreaterThan(-1)
    expect(checkout, `${where} checks out .nvmrc before reading it`).toBeLessThan(index)
    const options = steps[checkout]?.with ?? {}
    expect(options.path, `${where} checks out at the workspace root`).toBeUndefined()
    const sparse = options['sparse-checkout']
    if (sparse !== undefined) expect(String(sparse).split(/\s+/), `${where} sparse checkout includes .nvmrc`).toContain('.nvmrc')
  }

  it.each([
    ['release.yml', 'container-manifest'],
    ['container-republish.yml', 'manifest'],
  ])('%s: %s can load its container helper from the sparse checkout', (file, name) => {
    const checkout = workflows.get(file)?.jobs?.[name]?.steps?.find((step) =>
      String(step.uses ?? '').startsWith('actions/checkout@'))
    const patterns = checkout?.with?.['sparse-checkout']
    expect(typeof patterns).toBe('string')
    const directory = mkdtempSync(join(tmpdir(), 'looptroop-container-sparse-'))
    try {
      for (const path of String(patterns).trim().split(/\s+/)) {
        const destination = join(directory, path)
        mkdirSync(dirname(destination), { recursive: true })
        // CI tool installs in the working tree are absent from a sparse checkout.
        cpSync(join(repo, path), destination, {
          recursive: true, filter: (source) => basename(source) !== 'node_modules',
        })
      }
      const loaded = spawnSync(process.execPath, [
        '--input-type=module', '-e', 'await import("./scripts/container-docker.ts")',
      ], { cwd: directory, encoding: 'utf8', timeout: 10_000 })
      expect(loaded.status, loaded.stderr).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('allows a bounded thirty-minute npm scan wait with job time left for verification', () => {
    const job = workflows.get('release.yml')?.jobs?.npm
    const verification = job?.steps?.find((step) => step.name === 'Verify the registry agrees')
    const run = String(verification?.run ?? '')
    const attempts = Number(/for attempt in \{1\.\.(\d+)\}; do/.exec(run)?.[1])
    const interval = Number(/then sleep (\d+); fi/.exec(run)?.[1])
    const delayedAttempts = Number(/if \[ "\$\{attempt\}" -lt (\d+) \]/.exec(run)?.[1])
    const waitSeconds = (attempts - 1) * interval
    expect(delayedAttempts).toBe(attempts)
    expect(interval).toBe(15)
    expect(waitSeconds).toBeGreaterThanOrEqual(30 * 60 - interval)
    expect(waitSeconds).toBeLessThanOrEqual(30 * 60)
    expect(Number(job?.['timeout-minutes']) * 60).toBeGreaterThanOrEqual(waitSeconds + 10 * 60)
    expect(Number(job?.['timeout-minutes'])).toBeLessThanOrEqual(40)
    expect(run).toContain('deadline=$((SECONDS + 30 * 60))')
    expect(run).toMatch(/for attempt[^\n]+\n\s+if \[ "\$\{SECONDS\}" -ge "\$\{deadline\}" \]; then break; fi/)
    expect(run).toContain('dist.integrity --fetch-timeout=15000 --fetch-retries=0')
  })

  it.skipIf(process.platform === 'win32')('stops after a slow metadata read reaches the deadline, without another pacing delay', () => {
    const verification = workflows.get('release.yml')?.jobs?.npm?.steps?.find((step) =>
      step.name === 'Verify the registry agrees')
    const run = String(verification?.run ?? '')
    const poll = run.slice(run.indexOf("published=''"), run.search(/if \[ -z "\$\{published\}" \]/))
      .replace('30 * 60', '2')
    const directory = mkdtempSync(join(tmpdir(), 'looptroop-npm-deadline-'))
    const calls = join(directory, 'calls')
    const pacing = join(directory, 'pacing')
    const fixture = [
      'npm() { printf "%s\\n" "$*" >> "$NPM_CALLS"; command sleep 2.1; return 1; }',
      'sleep() { printf "%s\\n" "$*" >> "$PACING_CALLS"; }',
      '',
    ].join('\n')
    try {
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', fixture + poll], {
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, VERSION: '99.99.99', NPM_CALLS: calls, PACING_CALLS: pacing },
      })
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
      const reads = readFileSync(calls, 'utf8').trim().split(/\r?\n/)
      expect(reads).toHaveLength(1)
      expect(reads[0]).toContain('--fetch-timeout=15000 --fetch-retries=0')
      expect(existsSync(pacing)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  /**
   * A typed selector must be a named exception. An expression is the floor lane
   * reading `engines.node`; a concrete version is held by the test above; a
   * bare major floats to whatever shipped this week, which only the
   * early-warning lane may do.
   */
  function expectNamedNodeSelector({ where, steps, index }: SetupNodeStep) {
    const selector = steps[index]?.with?.['node-version']
    if (typeof selector !== 'string' && typeof selector !== 'number') {
      throw new Error(`${where} sets up Node with neither .nvmrc nor a named exception`)
    }
    if (String(selector).includes('${{') || concreteVersion(String(selector)) !== null) return
    expect(where, `${where} floats on node-version ${String(selector)}`).toBe('ci.yml: early-warning')
  }

  it('reads the toolchain Node from .nvmrc in every setup-node step, or names the exception', () => {
    const setups = [...workflows].flatMap(([file, workflow]) =>
      Object.entries(workflow.jobs ?? {}).flatMap(([name, job]) => {
        const steps = (job.steps ?? []) as SetupStep[]
        return steps.flatMap((step, index) => String(step.uses ?? '').startsWith('actions/setup-node@') ? [{ where: `${file}: ${name}`, steps, index }] : [])
      }))
    expect(setups.length, 'setup-node steps').toBeGreaterThan(0)
    for (const setup of setups) {
      if (setup.steps[setup.index]?.with?.['node-version-file'] === undefined) expectNamedNodeSelector(setup)
      else expectReadsNvmrc(setup)
    }
  })

  it('holds matrix Node versions and the Dockerfile base image to the toolchain pin', () => {
    const entries = [...workflows].flatMap(([file, workflow]) =>
      Object.entries(workflow.jobs ?? {}).flatMap(([name, job]) => matrixEntries(job).map((entry) => ({ where: `${file}: ${name}`, entry }))))
    for (const { where, entry } of entries) {
      const parsed = entry.node === undefined ? null : concreteVersion(String(entry.node))
      const expected = entry.label === 'declared floor' ? FLOOR : TOOLCHAIN
      if (parsed !== null) expect(formatNodeVersion(parsed), `${where} matrix node (${String(entry.label)})`).toBe(expected)
    }

    const docker = readFileSync(join(repo, 'scripts', 'Dockerfile'), 'utf8')
    const bases = [...docker.matchAll(/^\s*FROM\s+node:(\d+\.\d+\.\d+)(?=[-@])/gm)].map(([, version]) => version)
    expect(bases.length, 'Dockerfile Node base images').toBeGreaterThan(0)
    for (const base of bases) expect(base, 'Dockerfile FROM node:').toBe(TOOLCHAIN)
  })

  /**
   * The floor is a promise, and the only lanes that keep it are the ones that
   * switch to the exact version `engines.node` names. They read it at run time,
   * so a floor change never has to edit this workflow — which the job that
   * finishes Renovate's floor pull requests could not push anyway.
   *
   * Four ways the promise can quietly stop being kept. The switch can stop
   * reading the floor. A platform can be dropped, so the lanes are asserted as
   * a set across the two jobs that run them, and an `include` could add a
   * combination unseen, so it may only add keys to an existing one; `exclude`
   * is not allowed at all. And a job can be made advisory —
   * `continue-on-error` reports success however the job went.
   */
  it('runs both floors on every platform, reads the declared one from engines.node, and blocks on them', () => {
    type TestJob = Job & { 'continue-on-error'?: unknown; strategy?: { matrix?: Record<string, unknown> } }
    const jobs = workflows.get('ci.yml')!.jobs!
    const matrixJob = jobs['test-matrix'] as TestJob
    const windows = jobs['test-windows'] as TestJob
    const windowsResult = jobs['test-windows-result'] as TestJob
    for (const [name, job] of Object.entries({ 'test-matrix': matrixJob, 'test-windows': windows, 'test-windows-result': windowsResult })) {
      if (!job) throw new Error(`ci.yml: ${name} job missing`)
      expect(Object.hasOwn(job, 'continue-on-error'), `${name} continue-on-error`).toBe(false)
    }
    // The names branch protection matches on, for every platform.
    expect(matrixJob.name).toBe('Test (${{ matrix.os }}, ${{ matrix.label }})')
    expect(windowsResult.name).toBe('Test (windows-latest, ${{ matrix.lane }} floor)')

    const matrix = matrixJob.strategy?.matrix ?? {}
    expect(Object.keys(matrix).sort(), 'test-matrix axes').toEqual(['include', 'label', 'os'])
    const combinations = (matrix.os as string[]).flatMap((os) => (matrix.label as string[]).map((label) => `${os}, ${label}`))
    for (const entry of matrix.include as MatrixEntry[]) {
      expect(combinations, 'an include only adds keys to an existing lane').toContain(`${String(entry.os)}, ${String(entry.label)}`)
    }
    const windowsMatrix = windows.strategy?.matrix ?? {}
    expect(windowsMatrix).toEqual({ lane: ['toolchain', 'declared'], shard: [1, 2] })
    expect(windowsResult.strategy?.matrix).toEqual({ lane: ['toolchain', 'declared'] })
    const lanes = [...combinations, ...(windowsMatrix.lane as string[]).map((lane) => `windows-latest, ${lane} floor`)]
    expect(lanes.sort(), 'every platform runs both floors').toEqual(
      PLATFORMS.flatMap((os) => ['declared floor', 'toolchain floor'].map((label) => `${os}, ${label}`)).sort())

    for (const [name, job, floorOnly] of [
      ['test-matrix', matrixJob, "matrix.label == 'declared floor'"],
      ['test-windows', windows, "matrix.lane == 'declared'"],
    ] as const) {
      const steps = (job.steps ?? []) as Array<Step & { id?: unknown; with?: Record<string, unknown> }>
      const read = steps.findIndex((step) => step.id === 'floor')
      const switchTo = steps.findIndex((step) =>
        String(step.uses ?? '').startsWith('actions/setup-node@') && step.with?.['node-version'] === '${{ steps.floor.outputs.node }}')
      expect(read, `${name}: the floor is read from engines.node`).toBeGreaterThan(-1)
      expect(switchTo, `${name}: the floor is read before switching to it`).toBeGreaterThan(read)
      expect(steps[read]?.if).toBe(floorOnly)
      expect(steps[switchTo]?.if).toBe(floorOnly)
      expect(String(steps[read]?.run), 'the floor is parsed by the shared parser').toContain('parseNodeFloor')
      const install = steps.findIndex((step) => step.uses === './.github/actions/npm-ci')
      expect(install, `${name}: dependencies are installed on the Node the lane tests`).toBeGreaterThan(switchTo)
      const suites = steps.flatMap((step, index) => /^npm run test(?::coverage)?(?:\s|$)/.test(String(step.run ?? '')) ? [index] : [])
      expect(suites.length, `${name}: runs the suite`).toBeGreaterThan(0)
      for (const suite of suites) expect(suite, `${name}: the suite runs after the install`).toBeGreaterThan(install)
    }

    // Exactly one suite per lane: the coverage lane and the shuffled lane replace the plain run, never add to it.
    const steps = matrixJob.steps ?? []
    const conditions = steps.filter((step) => /^\s*npm run test/m.test(String(step.run ?? ''))).map((step) => step.if)
    expect(conditions).toEqual(['${{ !matrix.coverage && !matrix.shuffle }}', '${{ matrix.coverage }}', '${{ matrix.shuffle }}'])
    expect((matrix.include as MatrixEntry[]).map((entry) => Object.keys(entry).filter((key) => key !== 'os' && key !== 'label')))
      .toEqual([['coverage'], ['shuffle']])
    const shuffled = steps.find((step) => step.if === '${{ matrix.shuffle }}')
    expect(shuffled?.env?.SEED, 'a red shuffled run can be reproduced').toBe('${{ github.run_id }}')
    expect(String(shuffled?.run)).toContain('npm run test -- --sequence.shuffle --sequence.seed="${SEED}"')
    expect(String(shuffled?.run)).toContain('GITHUB_STEP_SUMMARY')

    // Only the coverage lane reads the PR head (Codecov's commit); every other lane tests the merge result.
    const checkout = steps.find((step) => String(step.uses ?? '').startsWith('actions/checkout@'))
    expect(checkout?.with?.ref).toBe("${{ matrix.coverage && (github.event.pull_request.head.sha || github.sha) || '' }}")
    const windowsCheckout = (windows.steps ?? []).find((step) => String(step.uses ?? '').startsWith('actions/checkout@'))
    expect(windowsCheckout?.with?.ref, 'Windows tests the merge result').toBeUndefined()
  })

  /**
   * The only job that installs LoopTroop the way a user does: built with the
   * toolchain, then packed and installed on the floor with the npm that Node
   * ships. Its value is entirely in the order of its steps. A `pin-npm.mjs`
   * after the switch would quietly install the repository's npm again — which
   * is exactly how an `engines.npm` no Node bundles once passed every lane.
   */
  it('installs the package on the declared floor with the npm that Node ships, on every platform', () => {
    const job = workflows.get('ci.yml')?.jobs?.['smoke-install'] as (Job & {
      'continue-on-error'?: unknown
      strategy?: { matrix?: { os?: unknown } }
    }) | undefined
    if (!job) throw new Error('ci.yml: smoke-install job missing')
    expect(Object.hasOwn(job, 'continue-on-error'), 'smoke-install continue-on-error').toBe(false)
    expect([...(job.strategy?.matrix?.os as string[] ?? [])].sort(), 'smoke-install platforms').toEqual(PLATFORMS)

    const steps = (job.steps ?? []) as Array<Step & { id?: unknown; with?: Record<string, unknown> }>
    const text = (step: Step) => typeof step.run === 'string' ? step.run : ''
    const setups = steps.flatMap((step, index) => String(step.uses ?? '').startsWith('actions/setup-node@') ? [index] : [])
    expect(setups.length, 'smoke-install setup-node steps').toBe(2)
    const [build, floor] = setups as [number, number]

    expect(String(steps[build]?.with?.['node-version'])).not.toContain('steps.floor')
    expect(steps.findIndex((step) => step.id === 'floor'), 'floor is read before switching to it').toBeLessThan(floor)
    expect(steps[floor]?.with?.['node-version']).toBe('${{ steps.floor.outputs.node }}')

    // The shared install action pins npm too, so it counts as a pin here.
    const pins = steps.flatMap((step, index) =>
      text(step).includes('scripts/pin-npm.mjs') || step.uses === './.github/actions/npm-ci' ? [index] : [])
    expect(pins.length, 'pin-npm before the dependency install').toBeGreaterThan(0)
    for (const pin of pins) expect(pin, 'no npm pin after switching to the floor').toBeLessThan(floor)

    const smoke = steps.findIndex((step) => text(step).includes('node scripts/smoke-install.mjs'))
    expect(smoke, 'the smoke runs on the floor runtime').toBeGreaterThan(floor)

    // Every other install path runs on the toolchain Node, before the switch —
    // except Homebrew, which puts its own directory first on PATH and so comes last.
    for (const script of ['scripts/smoke-installer.mjs', 'scripts/smoke-bundle.mjs', 'scripts/smoke-node-manager.mjs', 'scripts/audit-formula.ts']) {
      const index = steps.findIndex((step) => text(step).includes(script))
      expect(index, `${script} runs in this job`).toBeGreaterThan(-1)
      expect(index, `${script} runs before the switch to the floor`).toBeLessThan(floor)
    }
    const linuxbrew = steps.findIndex((step) => step.name === 'Put Linuxbrew on PATH')
    const homebrew = steps.findIndex((step) => text(step).includes('scripts/smoke-channel.ts'))
    expect(linuxbrew, 'Homebrew changes PATH only after every other step').toBeGreaterThan(smoke)
    expect(homebrew).toBeGreaterThan(linuxbrew)
    expect(homebrew, 'Homebrew is the last step').toBe(steps.length - 1)

    // One failed install path must not hide the others: each step after the build runs unless the run was cancelled.
    const buildStep = steps.findIndex((step) => step.run === 'npm run build')
    for (const step of steps.slice(buildStep + 1)) {
      expect(String(step.if ?? ''), `smoke-install: ${String(step.name ?? step.id)} runs after an earlier failure`).toContain('!cancelled()')
    }
    // A failed bundle must not hide them either: the job starts once the install
    // check passed, and only the bundle's own steps wait for the bundle job.
    expect((job as Job & { if?: string }).if).toBe("${{ !cancelled() && needs.install-check.result == 'success' }}")
    const download = steps.find((step) => step.name === 'Download the bundle')
    expect(download?.if).toBe("${{ !cancelled() && runner.os != 'Windows' && needs.bundle.result == 'success' }}")
    expect(steps.find((step) => step.id === 'brew-update')?.if).toContain("steps.bundle.outcome == 'success'")
    for (const step of steps.filter((candidate) => text(candidate).includes('RUNNER_TEMP}"/bundle/'))) {
      expect(step.if, `${String(step.name)} waits for the bundle`).toMatch(/steps\.(?:bundle|brew-update)\.outcome == 'success'/)
    }

    // Step order is not enough on Windows, where npm's launcher prefers any npm
    // in the shared global prefix — and the build step pinned npm 12 there. The
    // prefix is emptied for the smoke, and the step proves the npm it runs is
    // the one its Node ships before running anything.
    expect(steps[smoke]?.env?.npm_config_prefix, 'smoke empties the global npm prefix').toEqual(expect.any(String))
    expect(text(steps[smoke]!), 'smoke checks npm against the Node it ships with').toMatch(
      /node_modules['",\s]+npm['",\s]+package\.json[\s\S]*npm --version[\s\S]*exit 1[\s\S]*smoke-install\.mjs/,
    )
  })

  it('pins only standalone binary jobs to Node 26.9.0 and blocks embedded-runtime app checks', () => {
    for (const file of ['ci.yml', 'release.yml']) {
      const text = source.get(file)!
      const start = text.indexOf('  binary:')
      if (start === -1) throw new Error(`${file}: binary job missing`)
      const nextJob = /\n {2}[A-Za-z0-9_-]+:/.exec(text.slice(start + 3))
      const end = nextJob === null ? text.length : start + 3 + nextJob.index
      const binary = text.slice(start, end)

      expect(binary, `${file}: binary runtime`).toContain('node-version: 26.9.0')
      expect(binary, `${file}: binary runtime`).not.toContain('node-version-file')
      expect(binary, `${file}: embedded-runtime check`).toContain('Run blocking application checks on the embedded runtime')
      expect(binary, `${file}: embedded-runtime check`).toContain('doctor --json')
      expect(binary, `${file}: embedded-runtime check`).toContain('nodeCheck?.node?.version')
      expect(binary, `${file}: embedded-runtime check`).toContain('EXPECTED_NODE_VERSION')
      expect(binary, `${file}: embedded-runtime check`).not.toContain('v26.9.0 (latest')
      expect(binary, `${file}: binary job`).not.toContain('continue-on-error:')

      expect((text.match(/^\s*node-version:\s*26\.9\.0\s*$/gm) ?? []).length, `${file}: only binary jobs pin Node 26.9.0`).toBe(1)
    }

    const earlyWarning = workflows.get('ci.yml')!.jobs!['early-warning']!
    expect(earlyWarning['continue-on-error']).toBe(true)
    const setup = (earlyWarning.steps ?? []).find((step) => String(step.uses ?? '').startsWith('actions/setup-node@')) as SetupStep
    expect(setup.with?.['node-version'], 'the next major is worked out, never typed').toBe('${{ steps.next.outputs.node }}')
  })

  /**
   * The early-warning lane typed its Node major ("26") and kept testing it for
   * three weeks after the toolchain itself moved to 26, warning about nothing.
   * It now works out "the major after .nvmrc's" at run time: the newest release
   * of it (Node's alphas are releases), or its nightly builds when there is no
   * release of it yet.
   */
  it.skipIf(process.platform === 'win32')('points the early-warning lane at the major after the toolchain', () => {
    const pick = workflows.get('ci.yml')!.jobs!['early-warning']!.steps!.find((step) => step.name === 'Pick the next Node major')
    const run = String(pick?.run)
    expect(run).toContain('https://nodejs.org/download/release/index.json')
    const choose = (nvmrc: string, releases: string[]) => {
      const directory = mkdtempSync(join(tmpdir(), 'looptroop-next-node-'))
      try {
        writeFileSync(join(directory, '.nvmrc'), `${nvmrc}\n`)
        const output = join(directory, 'output')
        const index = JSON.stringify(releases.map((version) => ({ version })))
        const result = spawnSync('bash', ['-euo', 'pipefail', '-c', `curl() { printf '%s' "$INDEX"; }\n${run}`], {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, INDEX: index, GITHUB_OUTPUT: output },
        })
        expect(result.status, result.stderr).toBe(0)
        return readFileSync(output, 'utf8').trim()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
    expect(choose('26.13.1', ['v27.0.0-alpha.0.1.1', 'v27.0.0-alpha.0.1.0', 'v26.13.1'])).toBe('node=27.0.0-alpha.0.1.1')
    expect(choose('v26.13.1', ['v26.13.1', 'v26.12.0'])).toBe('node=27-nightly')
    expect(choose('27.2.0', ['v28.0.0-alpha.0.0.1', 'v27.2.0', 'v270.0.0'])).toBe('node=28.0.0-alpha.0.0.1')
  })

  it('keeps OIDC and attestation permissions off dependency/build jobs', () => {
    for (const [file, workflow] of workflows) {
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        const permissions = job.permissions ?? workflow.permissions
        if (typeof permissions === 'string' ? permissions === 'read-all' :
          permissions && permissions['id-token'] !== 'write' && permissions.attestations !== 'write') continue
        expect(runs(job), `${file}: ${jobName}`).not.toMatch(/\bnpm\s+(?:ci|install|run)\b/)
      }
    }
    const release = workflows.get('release.yml')!
    expect(release.jobs?.binary?.permissions).not.toEqual(expect.objectContaining({ 'id-token': 'write' }))
    expect(release.jobs?.build?.permissions).not.toEqual(expect.objectContaining({ attestations: 'write' }))
    expect(runs(release.jobs?.npm ?? {})).toMatch(/\bnpm publish\b/)
    expect(runs(release.jobs?.npm ?? {})).not.toMatch(/\bnpm\s+(?:ci|install|run)\b/)
    expect(release.jobs?.['attest-release-assets']?.permissions).toEqual(expect.objectContaining({ attestations: 'write' }))
    expect(release.jobs?.['container-attest']?.permissions).toEqual(expect.objectContaining({ 'id-token': 'write' }))
    expect(runs(release.jobs?.['attest-release-assets'] ?? {})).toContain('zipfile.ZipFile(')
    expect(runs(release.jobs?.['attest-release-assets'] ?? {})).not.toMatch(/\bnode\s+scripts\//)
    expect(release.jobs?.['attest-release-assets']?.steps?.some((step) => String(step.uses).startsWith('./'))).toBe(false)
    expect(runs(release.jobs?.['container-attest'] ?? {})).toContain('docker login ghcr.io')
    expect(runs(release.jobs?.['container-attest'] ?? {})).not.toMatch(/\bnpm\s+(?:ci|install|run)\b/)
  })

  it('does not put manifest-derived values in workflow shell source', () => {
    for (const [file, workflow] of workflows) {
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        expect(runs(job), `${file}: ${jobName}`).not.toMatch(/\$\{\{[^}\n]*outputs\./)
      }
    }
  })

  it('freezes the workflow driver for every smoke leg and uses current CI for channel repairs', () => {
    const smoke = source.get('published-smoke.yml')!
    const jobs = workflows.get('published-smoke.yml')!.jobs!
    const checkout = jobs.plan!.steps!.find((step) => String(step.uses).startsWith('actions/checkout@'))!
    expect(checkout.with?.ref).toBe('${{ github.workflow_sha }}')
    expect(smoke).not.toContain('driver_ref')
    expect(smoke).not.toContain('git checkout --detach "refs/tags/v${VERSION}"')
    const smokeCheckout = jobs.smoke!.steps!.find((step) => String(step.uses).startsWith('actions/checkout@'))!
    expect(smokeCheckout.with?.ref).toBe('${{ github.workflow_sha }}')
    for (const file of ['channel-republish.yml', 'container-republish.yml']) {
      const dispatch = source.get(file)!.split('gh workflow run published-smoke.yml')[1]!
      expect(dispatch).toContain('--ref main')
      expect(dispatch).toContain('-f version="${VERSION}"')
    }
    expect(source.get('release.yml')!).toContain('--ref "v${VERSION}"')
  })

  it('runs the published smoke gate on the Windows affected-file job', () => {
    const ci = source.get('ci.yml')!
    const gate = ci.slice(ci.indexOf('  windows-gate:'), ci.indexOf('  smoke-install:'))
    expect(gate).toContain('npm view looptroop version')
    expect(gate).toContain('node scripts/smoke-published.mjs')
    expect(gate).toContain('--channel npm')
    expect(gate).toContain('--pin')
    expect(gate).toContain('--profile gate')
    expect(gate).toContain('--leg "npm (windows-latest)"')
  })

  it('runs Windows published installs outside Git Bash with the same arguments and credentials', () => {
    const steps = workflows.get('published-smoke.yml')!.jobs!.smoke!.steps!
    const installSteps = steps.filter((step) => String(step.name).startsWith('Install it, run it, and uninstall it again'))
    expect(installSteps).toHaveLength(2)
    expect(installSteps[0]!.shell).toBe('bash')
    expect(installSteps[0]!.if).toBe("runner.os != 'Windows'")
    expect(installSteps[1]!.shell).toBe('pwsh')
    expect(installSteps[1]!.if).toBe("runner.os == 'Windows'")
    expect(installSteps[1]!['timeout-minutes']).toBe("${{ matrix.channel == 'chocolatey' && 20 || 40 }}")
    expect(workflows.get('published-smoke.yml')!.jobs!.smoke!['timeout-minutes']).toBe(40)
    expect(installSteps[1]!.env).toEqual(installSteps[0]!.env)
    expect(installSteps[1]!.run).toContain('node scripts/smoke-published.mjs @smokeArgs')
    expect(installSteps[1]!.run).toContain('exit $LASTEXITCODE')
    expect(installSteps[1]!.run).toContain("if ($env:PIN) { $smokeArgs += '--pin' }")
  })

  it('decides on Linux whether the Windows gate runs, and runs it only when affected', () => {
    const jobs = workflows.get('ci.yml')!.jobs!
    const scope = jobs['windows-gate-scope'] as Job & { outputs?: Record<string, unknown> }
    const gate = jobs['windows-gate'] as Job & { needs?: string[] }
    expect(scope['runs-on']).toBe('ubuntu-latest')
    expect(scope.outputs).toEqual({ affected: '${{ steps.scope.outputs.affected || steps.manual.outputs.affected }}' })
    // A manual run is a full run: it has no pull request to scope, so the profile runs.
    const manual = (scope.steps ?? []).find((step) => (step as Step & { id?: string }).id === 'manual')
    expect(manual?.if).toBe("github.event_name == 'workflow_dispatch'")
    expect(manual?.run).toBe('echo "affected=true" >> "$GITHUB_OUTPUT"')
    expect(gate['runs-on']).toBe('windows-latest')
    expect(gate.needs).toContain('windows-gate-scope')
    expect(gate.if).toBe("needs.windows-gate-scope.outputs.affected == 'true'")
    expect((gate.steps ?? []).some((step) => String(step.name ?? '').includes('affected')), 'the Windows job no longer scopes itself').toBe(false)
    const checkout = (scope.steps ?? []).find((step) => String(step.uses ?? '').startsWith('actions/checkout@'))
    expect(checkout?.with).toMatchObject({ 'fetch-depth': 0, filter: 'blob:none', 'persist-credentials': false })
  })

  it('executes the Windows affected-file scope against affected and unrelated paths', () => {
    const windowsGate = workflows.get('ci.yml')!.jobs?.['windows-gate-scope']
    const scope = windowsGate?.steps?.find((step) => step.name === 'Check whether the Windows profile is affected')?.run
    if (typeof scope !== 'string') throw new Error('Windows gate scope script missing')
    // Three dots: what the pull request changed, not what main gained since;
    // --no-renames: a renamed watched file lists its old path too.
    expect(scope).toContain('changed="$(git diff --name-only --no-renames "${BASE_SHA}...${HEAD_SHA}")"')
    expect(scope).toContain('done <<< "${changed}"')
    expect(scope).not.toContain('< <(git diff')

    // The gate installs through the shared action, so a change to it is a change to the gate.
    // ...and the modules the gated smoke script and tests import.
    for (const path of [
      'scripts/smoke-lib.mjs', 'scripts/installer-core.mjs', 'scripts/smoke-installer.mjs', '.github/actions/npm-ci/action.yml',
      'server/cli/processControl.ts', 'server/lib/processIdentity.ts', 'scripts/package-manifests.ts', 'server/test/tempDir.ts',
    ]) {
      const affected = executeWindowsScope(scope, [path])
      expect(affected.status).toBe(0)
      expect(affected.output).toBe('affected=true\n')
      expect(affected.stdout).toContain('Windows gate affected: true')
    }

    const unrelated = executeWindowsScope(scope, ['server/README.md'])
    expect(unrelated.status).toBe(0)
    expect(unrelated.output).toBe('affected=false\n')
    expect(unrelated.stdout).toContain('Windows gate affected: false')

    const gitFailure = executeWindowsScope(scope, ['scripts/smoke-lib.mjs'], 128)
    expect(gitFailure.status).toBe(128)
    expect(gitFailure.output).toBe('')
  })

  it('keeps release pushes free of token-bearing URLs and pins Scoop fetches', () => {
    for (const [file, text] of source) {
      expect(text, file).not.toContain('https://x-access-token:')
    }
    expect(source.get('ci.yml')).toContain('irm https://get.scoop.sh')
    expect(source.get('published-smoke.yml')).toContain('irm https://get.scoop.sh')
    const releasePr = source.get('release-pr.yml')!
    const push = releasePr.slice(releasePr.indexOf('  - name: Push the release branch'), releasePr.indexOf('  - name: Open the pull request'))
    expect(push).toContain('unset RELEASE_TOKEN')
    expect(push).toContain('core.hooksPath=/dev/null')
    // Every push from a workflow skips repository hooks, not only that one.
    for (const [file, text] of source) {
      for (const line of text.split('\n').filter((candidate) => /\bgit\b.*\bpush\b/.test(candidate) && !candidate.trim().startsWith('#'))) {
        expect(line, `${file}: ${line.trim()}`).toContain('core.hooksPath=/dev/null')
      }
    }
  })

  it('bounds npm network retries without adding a test retry loop', () => {
    for (const [file, text] of source) {
      if (!/\bnpm\s+(?:ci|install|publish|view)\b/.test(text)) continue
      expect(text, file).toContain('NPM_CONFIG_FETCH_RETRIES:')
      expect(text, file).toContain('NPM_CONFIG_FETCH_RETRY_MINTIMEOUT:')
      expect(text, file).toContain('NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT:')
      expect(text, file).toMatch(/NPM_CONFIG_FETCH_RETRIES:\s*'3'/)
      expect(text, file).toMatch(/NPM_CONFIG_FETCH_RETRY_MINTIMEOUT:\s*'10000'/)
      expect(text, file).toMatch(/NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT:\s*'60000'/)
    }
    expect(source.get('release.yml')).not.toMatch(/retry.*npm test|npm test.*retry/i)
  })

  it('retains the release lockfile and image package-version evidence', () => {
    const docker = readFileSync(join(repo, 'scripts', 'Dockerfile'), 'utf8')
    expect(docker).toContain('COPY ${LOCKFILE} ./package-lock.json')
    expect(docker).toContain('tar -xzf package.tgz --strip-components=1 -C /opt/looptroop/lib/node_modules/looptroop')
    expect(docker).toContain('npm ci --ignore-scripts --omit=dev')
    expect(docker).not.toMatch(/npm install --global/)
    expect(docker).not.toMatch(/npm install[^\n]*\.\/package\.tgz/)
    expect(docker).toContain('chmod 0755 /opt/looptroop/lib/node_modules/looptroop/dist/server/cli/launcher.cjs')
    expect(docker).toContain('/usr/share/looptroop/image-package-versions.txt')
    const release = source.get('release.yml')!
    const releaseBuild = release.slice(release.indexOf('  build:'), release.indexOf('  attest-release-assets:'))
    expect(releaseBuild).toContain('rm -rf release-assets && mkdir -p release-assets')
    expect(releaseBuild).toContain('release-assets is missing')
    expect(releaseBuild).toContain('release-assets has unexpected files')
    expect(releaseBuild).toContain('release-assets/*')
    const releaseAttestation = release.slice(
      release.indexOf('  attest-release-assets:'),
      release.indexOf('  verify-artifact:'),
    )
    expect(releaseAttestation).toContain('ARTIFACT_DESTINATION: release-assets')
    expect(releaseAttestation).toContain('subject-path: release-assets/*')
    expect(releaseAttestation).not.toContain('looptroop-*.tgz')
    const releaseContainer = release.slice(release.indexOf('  container-build:'), release.indexOf('  container-manifest:'))
    expect(releaseContainer).toContain('tar -cf - scripts/Dockerfile "${LOCKFILE}" "${TARBALL}"')
    expect(releaseContainer).toContain('docker buildx build -f scripts/Dockerfile')
    expect(releaseContainer).toContain('image-package-versions-${ARCH}.txt')
    expect(releaseContainer).toContain('--assets-dir .')
    expect(release).toContain('subject-digest: ${{ needs.container-manifest.outputs.index_digest }}')
    const repair = source.get('container-republish.yml')!
    const repairPrepare = repair.slice(repair.indexOf('  prepare:'), repair.indexOf('  build:'))
    expect(repairPrepare).toContain('Legacy release manifest: no package-lock.json asset')
    expect(repairPrepare).toContain('--dir "${ASSET_DIR}"')
    expect(repairPrepare).toContain('${process.env.ASSET_DIR}/package-lock.json')
    const repairBuild = repair.slice(repair.indexOf('  build:'), repair.indexOf('  manifest:'))
    expect(repairBuild).toContain('ARTIFACT_DESTINATION: release-assets')
    expect(repairBuild).toContain('LOCKFILE: ${{ needs.prepare.outputs.lockfile }}')
    expect(repairBuild).toContain('if [ -f scripts/Dockerfile ]; then')
    expect(repairBuild).toContain('if ! test -f "${dockerfile}"; then')
    expect(repairBuild).toContain('No Dockerfile at scripts/Dockerfile or Dockerfile in the released tag.')
    expect(repairBuild).toContain('context_files=("${dockerfile}" "${TARBALL}")')
    expect(repairBuild).toContain('context_files+=("${LOCKFILE}")')
    expect(repairBuild).toContain('build_args+=(--build-arg "LOCKFILE=${LOCKFILE}")')
    expect(repairBuild).toContain('docker buildx build -f "${dockerfile}"')
    expect(repair).toContain('subject-digest: ${{ needs.manifest.outputs.index_digest }}')
    expect(repair).toContain('tar -cf - "${context_files[@]}" | docker buildx build')
    expect(repair).toContain('image-package-versions-${ARCH}.txt')
    expect(repair).toContain('inventory_status')
    expect(repair).toContain("[ \"${inventory_status}\" -eq 42 ]")
    expect(repair).toContain('rm -f "${inventory}"\n            inventory="image-package-inventory-unavailable-${ARCH}.txt"')
    expect(repair).toContain('cat "${inventory}"')
  })

  it.each([
    { name: 'legacy object', version: '1.2.3', metadata: { 'dist-tags': { latest: '1.2.3' }, versions: ['1.1.9', '1.2.3'] }, expected: 'latest 1.2' },
    { name: 'npm singleton array', version: '1.2.3', metadata: [{ 'dist-tags': { latest: '1.2.3' }, versions: ['1.1.9', '1.2.3'] }], expected: 'latest 1.2' },
    { name: 'older release', version: '1.1.9', metadata: [{ 'dist-tags': { latest: '1.2.3' }, versions: ['1.1.9', '1.2.3'] }], expected: '1.1' },
    { name: 'prerelease', version: '1.3.0-rc.1', metadata: [{ 'dist-tags': { latest: '1.2.3', next: '1.3.0-rc.1' }, versions: ['1.2.3', '1.3.0-rc.1'] }], expected: 'next' },
    { name: 'unproven tags', version: '1.2.3', metadata: {}, expected: '' },
    { name: 'empty array', version: '1.2.3', metadata: [], expected: null },
    { name: 'ambiguous array', version: '1.2.3', metadata: [{}, {}], expected: null },
    { name: 'null singleton', version: '1.2.3', metadata: [null], expected: null },
    { name: 'primitive', version: '1.2.3', metadata: '1.2.3', expected: null },
  ])('container repair resolves floating tags from $name npm metadata', ({ version, metadata, expected }) => {
    const run = workflows.get('container-republish.yml')?.jobs?.prepare?.steps?.find((step) => step.name === 'Which floating tags this repair may move')?.run
    const script = typeof run === 'string' ? run.match(/floating=\$\(node -e '([\s\S]*?)'\)/)?.[1] : undefined
    if (!script) throw new Error('Container repair npm metadata script missing')
    const directory = mkdtempSync(join(tmpdir(), 'looptroop-container-metadata-'))
    try {
      mkdirSync(join(directory, 'scripts'))
      cpSync(join(repo, 'scripts/container-tags.ts'), join(directory, 'scripts/container-tags.ts'))
      writeFileSync(join(directory, 'npm-view.json'), JSON.stringify(metadata))
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, VERSION: version },
      })
      if (expected === null) {
        expect(result.status).not.toBe(0)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('Invalid npm package metadata')
      } else {
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toBe(expected)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps moved sources in their existing destination folders', () => {
    const relocated = [
      ['Dockerfile', 'scripts/Dockerfile'],
      ['install.sh', 'scripts/install.sh'],
      ['install.ps1', 'scripts/install.ps1'],
      ['renovate.json', '.github/renovate.json'],
      ['CONTRIBUTING.md', '.github/CONTRIBUTING.md'],
      ['CODE_OF_CONDUCT.md', '.github/CODE_OF_CONDUCT.md'],
      ['SECURITY.md', '.github/SECURITY.md'],
      ['drizzle.app.config.ts', 'server/db/app.config.ts'],
      ['drizzle.project.config.ts', 'server/db/project.config.ts'],
    ] as const

    for (const [oldPath, newPath] of relocated) {
      expect(existsSync(join(repo, oldPath)), oldPath).toBe(false)
      expect(existsSync(join(repo, newPath)), newPath).toBe(true)
    }
    for (const removed of ['drizzle.config.ts', 'tsconfig.node.json']) {
      expect(existsSync(join(repo, removed)), removed).toBe(false)
    }
  })

  it('keeps every Drizzle script config path valid', () => {
    const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      const config = command.match(/--config=(\S+)/)?.[1]
      if (config) expect(existsSync(join(repo, config)), `${name}: ${config}`).toBe(true)
    }
  })

  it('logs in each finished-image attestation job and disables storage records', () => {
    const release = source.get('release.yml')!
    const releaseAttest = release.slice(release.indexOf('  container-attest:'), release.indexOf('  container-verify:'))
    expect(releaseAttest).toContain('docker login ghcr.io')
    expect(releaseAttest).toContain('create-storage-record: false')

    const repair = source.get('container-republish.yml')!
    const repairAttest = repair.slice(repair.indexOf('  attest:'), repair.indexOf('  verify:'))
    expect(repairAttest).toContain('docker login ghcr.io')
    expect(repairAttest).toContain('create-storage-record: false')
  })

  /**
   * A floor above what a package feed offers breaks the install instructions
   * for everyone on that feed — #135. The check that prevents it has to sit in
   * a required job, or a red result merges anyway: a new check name gates
   * nothing until someone edits the branch ruleset. The same goes for the
   * declared-floor test lanes, which are not required by name, so the required
   * Packaging aggregate waits on the whole test matrix.
   */
  it('gates a changed Node floor, and the declared-floor lanes, through required jobs', () => {
    const ci = workflows.get('ci.yml')?.jobs ?? {}
    const verify = (ci.verify?.steps ?? []) as Array<Step & { if?: unknown }>
    const gate = verify.find((step) => step.name === 'Check every feed offers a changed Node floor')
    expect(gate, 'Verify checks the feeds when the floor changes').toBeDefined()
    // No event may skip the step, and an earlier failure in Verify must not hide it.
    expect(gate?.if, 'the feed gate runs on every event').toBe('${{ !cancelled() }}')
    expect(gate?.env?.BASE_REF, 'the job-level DIFF_BASE decides the comparison').toBeUndefined()
    expect(String(gate?.run)).toContain('node scripts/check-node-feeds.ts')
    expect(String(gate?.run)).toContain('engines.node')
    expect(gate?.env?.GITHUB_TOKEN).toBe('${{ github.token }}')

    const packaging = ci.packaging as (Job & { needs?: unknown }) | undefined
    expect(packaging?.needs, 'Packaging waits on the declared-floor lanes').toContain('test-matrix')
    expect(packaging?.needs, 'Packaging waits on the Windows lanes, and on their completeness checks').toEqual(
      expect.arrayContaining(['test-windows', 'test-windows-result']))
  })

  it('skips the networked Node-feed verifier for an unchanged floor and propagates failures for a changed floor', () => {
    const verify = workflows.get('ci.yml')?.jobs?.verify
    const gate = verify?.steps?.find((step) => step.name === 'Check every feed offers a changed Node floor')
    if (typeof gate?.run !== 'string') throw new Error('Node floor feed gate script missing')

    const unchanged = executeNodeFloorGate(gate.run, '>=24.15.0', '>=24.15.0')
    expect(unchanged.status, unchanged.stderr).toBe(0)
    expect(unchanged.stdout).toContain('engines.node is unchanged (>=24.15.0); no feed to check.')
    expect(unchanged.checkerCalled).toBe(false)

    const changed = executeNodeFloorGate(gate.run, '>=24.15.0', '>=24.17.0', 17)
    expect(changed.status, changed.stderr).toBe(17)
    expect(changed.stdout).toContain('engines.node changes from >=24.15.0 to >=24.17.0.')
    expect(changed.checkerCalled).toBe(true)
  })

  /**
   * The floor workflow commits to Renovate's branch with a write token, from a
   * patch that code on that branch produced. The token must never share a job
   * with that code, and the patch must be confined to the files the floor lives
   * in before git applies it.
   */
  it('finishes Renovate floor pull requests without giving the branch a token', () => {
    const workflow = workflows.get('renovate-node-floor.yml')
    const text = source.get('renovate-node-floor.yml')
    if (!workflow || !text) throw new Error('renovate-node-floor.yml missing')
    const jobs = workflow.jobs ?? {}
    expect(Object.keys(jobs).sort()).toEqual(['push', 'recheck', 'regenerate'])

    for (const name of ['regenerate']) {
      const job = jobs[name] as Job & { if?: unknown }
      expect(String(job.if), `${name} runs only on Renovate's floor branch`).toContain("github.head_ref == 'renovate/node-floor'")
      expect(String(job.if), `${name} runs only for Renovate's own pull request`).toContain("user.login == 'renovate[bot]'")
      expect(JSON.stringify(job), `${name} never sees a secret`).not.toContain('secrets.')
      expect(runs(job), `${name} installs nothing`).not.toMatch(/npm (ci|install)/)
    }

    const push = jobs.push as Job
    const steps = (push.steps ?? []) as Array<Step & { env?: Record<string, unknown> }>
    expect(runs(push), 'push runs no code from the branch').not.toMatch(/(^|[\s;&|($])(node|npm|npx)\s/m)
    const withToken = steps.filter((step) => JSON.stringify(step).includes('secrets.RELEASE_PR_TOKEN'))
    expect(withToken.map((step) => step.name)).toEqual(['Push the Node floor'])
    expect(String(withToken[0]?.run)).toContain('unset RELEASE_TOKEN')

    const apply = steps.find((step) => step.name === 'Validate and apply the patch')
    // The base SHA to read the old floor from, and no credential.
    expect(Object.keys(apply?.env ?? {})).toEqual(['BASE_SHA'])
    expect(JSON.stringify(apply)).not.toContain('secrets.')
    for (const path of ['package-lock.json', 'README.md', 'scripts/install.ps1', 'scripts/install.sh', 'server/cli/launcher.cjs', 'tests/fixtures/channels/looptroop.nuspec']) {
      expect(String(apply?.run), `the patch may edit ${path}`).toContain(` ${path} `)
    }
    expect(String(apply?.run)).toContain('git apply --summary')
    // A floor move changes the floor and nothing else. Masking every number is
    // not that rule — `exit 1` to `exit 0` changes digits alone — so the lines
    // are compared with the old and new floor written out, and nothing more.
    const validate = String(apply?.run)
    for (const side of ['removed', 'added']) {
      expect(validate, `${side} lines are compared with the floor written out`)
        .toContain(`print floorless(substr($0, 2)) > ${side}; next }`)
    }
    expect(validate).toContain('git show FETCH_HEAD:package.json | jq -r .engines.node')
    expect(validate).toContain('jq -r .engines.node package.json')
    expect(validate).toContain('cmp -s -- "${removed_lines}" "${added_lines}"')
    expect(validate, 'no rule that lets any digit change').not.toContain('gsub(/[0-9]+/')
    // The launcher's lines are judged before anything is masked — masking the
    // version first let REQUIRED_MAJOR = 24.18.1 through as a launcher that
    // cannot parse — and everywhere else only the phrases a floor move writes
    // are masked, so a dependency sharing the floor's version cannot move.
    const floorless = validate.slice(validate.indexOf('function floorless('))
    expect(floorless.indexOf('if (text ~ /^var REQUIRED_/)'), 'launcher lines judged first')
      .toBeLessThan(floorless.indexOf('sprintf(phrase[i], old_floor)'))
    expect(validate).toContain('split("\\">=%s\\"|version=\\"%s\\"|Node %s or newer|Node `%s+`|Node.js %s or newer", phrase, "|")')
    // The launcher's three constants may take only the old or new floor's own
    // component — never any number, which would let REQUIRED_MAJOR = 0 through.
    for (const part of ['MAJOR', 'MINOR', 'PATCH']) {
      const name = part.toLowerCase()
      expect(validate, `REQUIRED_${part} is held to the floor's ${name}`)
        .toContain(`part == "${part}" && (value == old_${name} || value == new_${name})`)
    }
    expect(apply?.env?.BASE_SHA).toBe('${{ github.event.pull_request.base.sha }}')
    expect(text).toContain('persist-credentials: false')
    expect(text).not.toContain('persist-credentials: true')
  })

  /**
   * The floor pull request stays red until every feed offers the new floor, so
   * something has to look at it again once a late feed catches up, or it is
   * still red when someone comes to merge it: nothing on it changes when that
   * happens, so no check would run. `recheck` re-runs whatever failed there,
   * daily. It checks out nothing and holds no secret, and the only thing it may
   * write is a request to re-run.
   */
  it('re-runs a red floor pull request every day, holding nothing but actions: write', () => {
    const workflow = workflows.get('renovate-node-floor.yml') as (Workflow & { on?: Record<string, unknown> }) | undefined
    expect(Object.keys(workflow?.on ?? {}).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch'])
    const recheck = workflow?.jobs?.recheck as (Job & { if?: unknown }) | undefined
    if (!recheck) throw new Error('renovate-node-floor.yml has no recheck job')
    expect(recheck.if).toBe("github.event_name != 'pull_request'")
    expect(recheck.permissions).toEqual({ actions: 'write', contents: 'read', 'pull-requests': 'write' })
    expect(JSON.stringify(recheck), 'recheck never sees a secret').not.toContain('secrets.')
    expect((recheck.steps ?? []).filter((step) => step.uses !== undefined), 'recheck checks nothing out').toEqual([])
    const run = runs(recheck)
    expect(run).toContain('gh pr list --head renovate/node-floor --state open')
    expect(run, 'only Renovate\'s own pull request, never a fork\'s').toContain('select((.isCrossRepository | not) and (.author.login == "app/renovate"')
    expect(run).toMatch(/gh run rerun "\$\{run\}" --failed/)
    // The jobs that write run only on the floor branch's pull request, so a
    // scheduled run can never reach them.
    expect(String((workflow?.jobs?.regenerate as Job & { if?: unknown }).if)).toContain("github.head_ref == 'renovate/node-floor'")
    expect((workflow?.jobs?.push as Job & { needs?: unknown }).needs).toEqual(['regenerate'])
  })

  /**
   * The same script, run against a stand-in `gh`: re-runs while GitHub allows
   * them, and once it refuses (a run older than 30 days), ticks Renovate's
   * rebase box, and only that box, so the pull request cannot stay red for good.
   */
  it('asks Renovate to rebase the floor pull request once a failed run can no longer be re-run', () => {
    const recheck = workflows.get('renovate-node-floor.yml')?.jobs?.recheck
    const script = String(recheck?.steps?.[0]?.run)
    const box = (mark: string) => `Update node.\n\n - [${mark}] <!-- rebase-check -->If you want to rebase/retry this PR, check this box\n`
    const stub = [
      'gh() {',
      '  printf "%s\\n" "$*" >> "$GH_CALLS"',
      '  case "$1 $2" in',
      '    "pr list") printf "%s" "$FIXTURE_PR" ;;',
      '    "run list") printf "%s" "$FIXTURE_FAILED" ;;',
      '    "run rerun") [ "$FIXTURE_RERUN" = allowed ] ;;',
      '    "api --method") printf "%s" "$6" > "$GH_PATCHED" ;;',
      '    "api repos/"*) printf "%s" "$FIXTURE_BODY" ;;',
      '  esac',
      '}',
      '',
    ].join('\n')
    const readIfWritten = <T,>(path: string, otherwise: T) => (existsSync(path) ? readFileSync(path, 'utf8') : otherwise)
    const execute = (given: { pr: string; failed?: string; rerun?: 'allowed' | 'refused'; body?: string }) => {
      const fixture = { failed: '', rerun: 'allowed', body: '', ...given }
      const directory = mkdtempSync(join(tmpdir(), 'looptroop-recheck-'))
      const calls = join(directory, 'calls')
      const patched = join(directory, 'patched')
      try {
        const result = spawnSync('bash', ['-c', stub + script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GH_CALLS: calls,
            GH_PATCHED: patched,
            GH_REPO: 'looptroop-ai/LoopTroop',
            FIXTURE_PR: fixture.pr,
            FIXTURE_FAILED: fixture.failed,
            FIXTURE_RERUN: fixture.rerun,
            FIXTURE_BODY: fixture.body,
          },
        })
        return {
          status: result.status,
          output: `${result.stdout}${result.stderr}`,
          calls: readIfWritten(calls, ''),
          patched: readIfWritten(patched, null),
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }

    const none = execute({ pr: '' })
    expect(none.status).toBe(0)
    expect(none.calls).not.toContain('run list')

    const green = execute({ pr: '42 abc123', failed: '' })
    expect(green.status).toBe(0)
    expect(green.calls).toContain('run list --commit abc123')
    expect(green.calls).not.toContain('run rerun')

    const rerun = execute({ pr: '42 abc123', failed: '101\n102' })
    expect(rerun.status).toBe(0)
    expect(rerun.calls).toContain('run rerun 101 --failed')
    expect(rerun.calls).toContain('run rerun 102 --failed')
    expect(rerun.calls, 'nothing is edited while re-runs work').not.toContain('api')

    const expired = execute({ pr: '42 abc123', failed: '101', rerun: 'refused', body: box(' ') })
    expect(expired.status).toBe(0)
    expect(expired.calls).toContain('api --method PATCH repos/looptroop-ai/LoopTroop/pulls/42 -f')
    expect(expired.patched, 'only the box changes').toBe(`body=${box('x')}`.replace(/\n$/, ''))

    const asked = execute({ pr: '42 abc123', failed: '101', rerun: 'refused', body: box('x') })
    expect(asked.status).toBe(0)
    expect(asked.patched, 'a box already ticked is left alone').toBeNull()

    const boxless = execute({ pr: '42 abc123', failed: '101', rerun: 'refused', body: 'Update node.' })
    expect(boxless.status).toBe(1)
    expect(boxless.output).toContain('no rebase box to tick')
  })

  /**
   * Renovate stops touching a branch another author has committed to — no
   * rebase, no newer release — unless that author is in gitIgnoredAuthors. Its
   * own workflows commit to its branches, so the author they commit as is an
   * interface: change it without this list and every such pull request freezes,
   * the floor's with it, and nothing reports an error.
   */
  it('lets Renovate keep updating the branches its own workflows commit to', () => {
    const renovate = JSON.parse(readFileSync(join(repo, '.github/renovate.json'), 'utf8')) as {
      gitIgnoredAuthors?: string[]
    }
    const committing = files.filter((file) => file.startsWith('renovate-') && (source.get(file) ?? '').includes('git config user.email'))
    expect(committing, 'the floor workflow is one of them').toContain('renovate-node-floor.yml')
    for (const file of committing) {
      const author = /git config user\.email "([^"]+)"/.exec(source.get(file) ?? '')?.[1]
      expect(renovate.gitIgnoredAuthors, `${file} commits as ${author}`).toContain(author)
    }
  })

  /**
   * Every Renovate pull request is merged by a person, or an agent acting for
   * one, after review. An `automerge` switched on anywhere, the top level, a
   * rule or `lockFileMaintenance`, would merge that lane unreviewed the moment
   * its checks pass, so the whole file is searched rather than known places.
   * Presets from `extends` are not in this file, and their rules come first, so
   * the last rule matches every package and switches automerge off after them.
   * Two lanes escape that rule: a lockfile refresh has no package name to
   * match, and Renovate forces the security settings after every rule, so both
   * say `automerge: false` themselves.
   */
  it('lets no Renovate update merge itself', () => {
    const found: string[] = []
    const text = readFileSync(join(repo, '.github/renovate.json'), 'utf8')
    const renovate = JSON.parse(text, (key, value: unknown) => {
      if (key === 'automerge' && value !== false) found.push(String(value))
      return value
    }) as RenovateConfig
    expect(found, 'automerge settings that are not false').toEqual([])
    expect(renovate.automerge, 'the default is stated, not inherited from a preset').toBe(false)
    expect(renovate.lockFileMaintenance?.automerge, 'the lockfile refresh states it').toBe(false)
    expect(renovate.vulnerabilityAlerts?.automerge, 'security fixes state it').toBe(false)
    expect(renovate.packageRules.at(-1), 'the last rule switches automerge off for everything').toEqual(
      expect.objectContaining({ matchPackageNames: ['*'], automerge: false }),
    )
    expect(Object.keys(renovate.packageRules.at(-1) ?? {}).sort(), 'and does nothing else').toEqual(['automerge', 'description', 'matchPackageNames'])
  })

  /**
   * Renovate applies package rules in order and a later `groupName` replaces
   * an earlier one. The bundled frontend group once sat above the dev tooling
   * rule, which matches every devDependency, so it never took effect and React
   * and CodeMirror shipped inside dev tooling. The frontend list also appears
   * twice, once for its label and once for its group, and the two must agree.
   * The Node floor rule is read by name: renovate-node-floor.yml acts only on
   * the `renovate/node-floor` branch its groupSlug produces. `engines.node`
   * also matches the toolchain group, so the floor rule has to come after it,
   * or the floor lands in the toolchain pull request and the workflow never
   * runs.
   */
  it('keeps the Renovate groups in the order that lets them take effect', () => {
    const rules = (JSON.parse(readFileSync(join(repo, '.github/renovate.json'), 'utf8')) as RenovateConfig).packageRules
    const devTooling = rules.findIndex((rule) => rule.groupName === 'dev tooling (non-major)')
    const frontendGroup = rules.findIndex((rule) => rule.groupName === 'ships to users (non-major)' && rule.matchDepTypes?.includes('devDependencies'))
    const frontendLabel = rules.findIndex((rule) => rule.labels?.includes('frontend'))
    expect(devTooling, 'dev tooling group').toBeGreaterThan(-1)
    expect(frontendGroup, 'the frontend group comes after the dev tooling group').toBeGreaterThan(devTooling)
    expect(rules[frontendLabel]?.matchPackageNames, 'the frontend label and group name the same packages').toEqual(rules[frontendGroup]?.matchPackageNames)
    expect(rules.filter((rule) => rule.groupSlug === 'node-floor'), 'one Node floor rule').toHaveLength(1)
    const toolchain = rules.findIndex((rule) => rule.groupName === 'toolchain (node + npm)')
    expect(toolchain, 'toolchain group').toBeGreaterThan(-1)
    expect(rules.findIndex((rule) => rule.groupSlug === 'node-floor'), 'the Node floor rule comes after the toolchain group').toBeGreaterThan(toolchain)
  })

  it('keeps CI-tool majors separate and lockfile refreshes in the shared weekly branch', () => {
    const rules = (JSON.parse(readFileSync(join(repo, '.github/renovate.json'), 'utf8')) as RenovateConfig).packageRules
    const ciRules = rules.filter((rule) => rule.matchFileNames?.some((file) => file.startsWith('scripts/ci-tools/')))
    const grouped = ciRules.filter((rule) => rule.groupName)
    expect(grouped).toHaveLength(1)
    expect(grouped[0]).toMatchObject({ groupName: 'CI tools', matchUpdateTypes: ['patch', 'minor'] })
    // A path-only grouping rule also matches lockFileMaintenance, creating a
    // second refresh branch. Labels replace; addLabels preserves 'major'.
    expect(ciRules.every((rule) => rule.labels === undefined)).toBe(true)
    expect(ciRules).toContainEqual(expect.objectContaining({
      matchFileNames: ['scripts/ci-tools/**/package.json'],
      rangeStrategy: 'pin', semanticCommitType: 'chore', addLabels: ['ci'],
    }))
    expect(rules.find((rule) => rule.groupName === 'ships to users (non-major)' && rule.matchDepTypes?.includes('dependencies'))?.matchFileNames)
      .toEqual(['package.json'])
    for (const [name, range] of [['yarn', '<2'], ['opencode-ai', '>=1 <2'], ['@opencode/cli', '>=2 <3']] as const) {
      expect(ciRules.find((rule) => rule.matchPackageNames?.includes(name))?.allowedVersions).toBe(range)
    }
    for (const name of ['bun', 'pnpm']) {
      expect(ciRules.filter((rule) => rule.matchPackageNames?.includes(name)).some((rule) => rule.allowedVersions)).toBe(false)
    }
  })

  it('downloads Renovate notices outside checkout and gives the token only to push', () => {
    const text = source.get('renovate-notices.yml')!
    expect(text).toContain('ARTIFACT_DESTINATION: ${{ runner.temp }}/third-party-notices-artifact')
    expect(text).toContain('Validate and copy the notices artifact')
    expect(text).toContain('persist-credentials: false')
    expect(text).toContain('RELEASE_TOKEN: ${{ secrets.RELEASE_PR_TOKEN }}')
    const push = workflows.get('renovate-notices.yml')!.jobs?.push
    const commit = push?.steps?.find((step) => step.name === 'Commit the regenerated notices')
    const authenticatedPush = push?.steps?.find((step) => step.name === 'Push the regenerated notices')
    expect(commit?.env).toBeUndefined()
    expect(authenticatedPush?.env?.RELEASE_TOKEN).toBe('${{ secrets.RELEASE_PR_TOKEN }}')
    expect(commit?.run).toContain('core.hooksPath=/dev/null')
    expect(authenticatedPush?.run).toContain('unset RELEASE_TOKEN')
    expect(authenticatedPush?.run).toContain('core.hooksPath=/dev/null')
  })

  /**
   * One run per commit. A branch push used to start a full run beside its pull
   * request's, doubling every job against an account limit of 20 jobs and 5
   * Macs at a time, with both copies reporting under the same required names.
   */
  it('runs CI once per commit: for pull requests, for pushes to main, and on demand', () => {
    const ci = workflows.get('ci.yml') as Workflow & { on?: Record<string, unknown>; concurrency?: Record<string, unknown> }
    expect(Object.keys(ci.on ?? {}).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(ci.on?.pull_request).toBeNull()
    expect(ci.on?.push).toEqual({ branches: ['main'] })
    // A newer commit cancels a pull request's older run; a push to main, which
    // saves what pull requests read, gets a group of its own, since GitHub
    // keeps one pending run per group and a third push replaced the second's.
    expect(ci.concurrency).toEqual({
      group: "ci-${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    })
    // Nothing in the workflow tells a push copy apart from a pull request copy any more.
    expect(source.get('ci.yml')).not.toContain('[push]')
  })

  /**
   * setup-node caches by itself whenever package.json names a packageManager,
   * including in jobs that never install. Those finished first and saved an
   * empty cache under the key every later job restored; a saved key is never
   * replaced, so macOS jobs restored 1 KB and downloaded everything. The shared
   * install action owns npm's cache instead: restored everywhere, saved only
   * after a successful `npm ci`, and only on pushes to main.
   */
  it('leaves npm caching to the shared install action, which saves only on main', () => {
    for (const [file, workflow] of workflows) {
      for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
        for (const step of (job.steps ?? []) as SetupStep[]) {
          if (!String(step.uses ?? '').startsWith('actions/setup-node@')) continue
          expect(step.with?.['package-manager-cache'], `${file}: ${name} turns setup-node's caching off`).toBe(false)
          expect(step.with?.cache, `${file}: ${name} caches nothing through setup-node`).toBeUndefined()
        }
      }
    }
    const action = yaml.load(readFileSync(join(repo, '.github/actions/npm-ci/action.yml'), 'utf8')) as {
      runs: { steps: Array<Step & { id?: string }> }
    }
    const steps = action.runs.steps
    const index = (predicate: (step: Step & { id?: string }) => boolean) => steps.findIndex(predicate)
    const restore = index((step) => String(step.uses ?? '').startsWith('actions/cache/restore@'))
    const install = index((step) => step.run === 'npm ci')
    const save = index((step) => String(step.uses ?? '').startsWith('actions/cache/save@'))
    expect(restore).toBeGreaterThan(-1)
    expect(install).toBeGreaterThan(restore)
    expect(save, 'saves only what a successful npm ci downloaded').toBeGreaterThan(install)
    expect(steps[save]?.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main' && steps.restore.outputs.cache-hit != 'true'")
    expect(steps[restore]?.with?.['restore-keys'], 'a changed lockfile still starts from main\'s newest cache').toBe('npm-${{ runner.os }}-${{ runner.arch }}-')
    expect(steps[save]?.with?.key).toBe(steps[restore]?.with?.key)
    for (const file of ['release.yml', 'channel-republish.yml', 'container-republish.yml']) {
      expect(source.get(file), `${file} restores no cache`).not.toMatch(/actions\/cache|\.\/\.github\/actions\/npm-ci/)
    }
  })

  /**
   * A commit that cannot install would otherwise start every Mac and Windows
   * job only for each to fail at its own install; the install check runs first
   * and those jobs wait for it. Derived from where each job runs, so a new Mac
   * or Windows job is held to it the moment it is added.
   */
  it('makes every Mac and Windows job wait for the install check', () => {
    const jobs = workflows.get('ci.yml')!.jobs!
    const usesMacOrWindows = (job: Job) => /macos|windows/.test(JSON.stringify([job['runs-on'], (job as { strategy?: unknown }).strategy]))
    const held = Object.entries(jobs).filter(([, job]) => usesMacOrWindows(job))
    expect(held.map(([name]) => name).sort()).toEqual(
      ['binary', 'channel-windows', 'smoke-install', 'test-matrix', 'test-windows', 'windows-gate'])
    for (const [name, job] of held) {
      const needs = (job as { needs?: string | string[] }).needs
      expect([needs].flat(), `${name} waits for the install check`).toContain('install-check')
    }
    expect((jobs['install-check'] as { needs?: unknown }).needs).toBeUndefined()
  })

  /**
   * Each Windows lane runs on two machines, split by the file times main
   * recorded; the result job fails unless both halves passed and together ran
   * every file. Its gate step shares Packaging's name, which is how the
   * re-run workflow tells a consequence from a finding.
   */
  it('splits each Windows lane by recorded times and proves the halves ran every file', () => {
    const jobs = workflows.get('ci.yml')!.jobs!
    const shards = (jobs['test-windows'] as Job & { strategy: { matrix: { shard: number[] } } }).strategy.matrix.shard
    const steps = jobs['test-windows']!.steps ?? []
    // The shards read the run's one snapshot, never the cache: a cache entry
    // saved on Linux never restores on Windows, and two separate restores can
    // pick different snapshots, so the halves would split differently.
    expect(steps.some((step) => String(step.uses ?? '').startsWith('actions/cache/')), 'no cache on the Windows shards').toBe(false)
    const timings = steps.find((step) => step.name === "Download this run's test timings")
    expect(timings?.uses).toBe('./.github/actions/download-artifact')
    expect(timings?.with).toEqual({ name: 'test-timings-windows', path: '${{ runner.temp }}/test-timings' })
    const test = steps.find((step) => step.name === 'Test')
    expect(test?.env).toMatchObject({
      SHARD: '${{ matrix.shard }}',
      VITEST_SHARD_DIR: '${{ runner.temp }}/test-shard',
      VITEST_SHARD_TIMINGS: '${{ runner.temp }}/test-timings/windows-${{ matrix.lane }}.json',
    })
    expect(test?.run).toBe(`npm run test -- --shard="\${SHARD}/${shards.length}"`)
    const upload = steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'))
    expect(upload?.if, 'a failed or timed-out shard still reports what it planned').toBe('always()')
    expect(upload?.with?.name).toBe('test-windows-${{ matrix.lane }}-shard-${{ matrix.shard }}')

    // install-check restores each lane's times on Linux, from the very path
    // the result job saves them to on Linux, and hands them on.
    const install = jobs['install-check']!.steps ?? []
    const saved = (jobs['test-windows-result']!.steps ?? []).find((step) => step.name === 'Save the file timings')
    expect(saved?.with).toEqual({
      path: '${{ runner.temp }}/test-timings/windows-${{ matrix.lane }}.json',
      key: 'test-timings-windows-${{ matrix.lane }}-${{ github.run_id }}',
    })
    for (const lane of ['toolchain', 'declared']) {
      const restore = install.find((step) => String(step.uses ?? '').startsWith('actions/cache/restore@') && String(step.with?.key).includes(`-${lane}-`))
      expect(restore?.with, lane).toEqual({
        path: `\${{ runner.temp }}/test-timings/windows-${lane}.json`,
        key: `test-timings-windows-${lane}-\${{ github.run_id }}`,
        'restore-keys': `test-timings-windows-${lane}-`,
      })
    }
    expect(jobs['test-windows-result']!['runs-on'], 'saved on the OS install-check restores on').toBe(jobs['install-check']!['runs-on'])
    const handOff = install.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'))
    expect(handOff?.with).toMatchObject({ name: 'test-timings-windows', path: '${{ runner.temp }}/test-timings/', 'if-no-files-found': 'error', overwrite: true })

    const result = jobs['test-windows-result']!
    expect((result as { needs?: unknown }).needs).toBe('test-windows')
    expect(result.if).toBe('always()')
    const resultSteps = result.steps ?? []
    const download = resultSteps.find((step) => step.name === 'Download the shard reports')
    expect(download?.with?.pattern).toBe('test-windows-${{ matrix.lane }}-shard-*')
    expect(download?.['continue-on-error'], 'a missing shard is reported by the next step, by name').toBe(true)
    const require = resultSteps.find((step) => step.name === GATE_STEP)
    expect(require?.run).toBe(`node scripts/test-shards.ts require --dir "\${RUNNER_TEMP}/shards" --count ${shards.length}`)
    const cover = resultSteps.find((step) => step.name === 'Check the shards together ran every test file')
    expect(cover?.run).toBe(`node scripts/test-shards.ts cover --dir "\${RUNNER_TEMP}/shards" --count ${shards.length}`)
    expect(cover?.if, 'coverage is judged only once every shard reported').toBe("${{ !cancelled() && steps.require.outcome == 'success' }}")
    const record = resultSteps.find((step) => step.name === 'Record the file timings for the next run')
    expect(record?.if, 'only main records the timings everyone splits by').toBe("github.event_name == 'push' && github.ref == 'refs/heads/main' && success()")
    expect((record as Step & { 'continue-on-error'?: boolean })['continue-on-error'], 'failing to record times costs balance, not the required check').toBe(true)
    expect(record?.run).toBe('node scripts/test-shards.ts timings --dir "${RUNNER_TEMP}/shards" --out "${RUNNER_TEMP}/test-timings/windows-${LANE}.json"')
    expect(record?.env).toEqual({ LANE: '${{ matrix.lane }}' })
    expect(jobs.packaging!.steps!.some((step) => step.name === GATE_STEP)).toBe(true)
  })

  /**
   * Chocolatey and Scoop share one Windows job now. A Chocolatey check that
   * fails after installing never reaches its own uninstall, and its shim on
   * PATH would answer the Scoop check's `looptroop` instead.
   */
  it('clears a failed Chocolatey install before the Scoop check in the same job', () => {
    const steps = workflows.get('ci.yml')!.jobs!['channel-windows']!.steps ?? []
    const index = (name: string) => steps.findIndex((step) => step.name === name)
    const choco = index('Install it with Chocolatey, run it, and uninstall it again')
    const cleanup = index('Remove what a failed Chocolatey check left installed')
    expect(choco).toBeGreaterThan(-1)
    expect(cleanup).toBe(choco + 1)
    expect(index('Install Scoop')).toBeGreaterThan(cleanup)
    expect((steps[choco] as Step & { id?: string }).id).toBe('choco')
    expect(steps[cleanup]!.if).toBe("${{ !cancelled() && steps.choco.outcome == 'failure' }}")
  })

  /**
   * GitHub's macOS shortage cancels jobs that never got a machine, which turns
   * a run red for nothing. This re-runs a run's failed jobs, at most twice, when
   * every failure is either such a job or a gate repeating one; anything that
   * ran and failed is a finding and is left alone.
   */
  it('re-runs only jobs that never got a machine, at most twice, holding nothing but actions: write', () => {
    const workflow = workflows.get('rerun-unacquired.yml') as (Workflow & { on?: Record<string, unknown> }) | undefined
    if (!workflow) throw new Error('rerun-unacquired.yml missing')
    expect(workflow.on).toEqual({ workflow_run: { workflows: ['CI'], types: ['completed'] } })
    expect(workflow.permissions).toEqual({})
    const job = workflow.jobs!.rerun!
    expect(job.if).toBe("github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.run_attempt < 3")
    expect(job.permissions).toEqual({ actions: 'write' })
    expect((job.steps ?? []).filter((step) => step.uses !== undefined), 'checks nothing out, runs nothing from the run').toEqual([])
    expect(JSON.stringify(job)).not.toContain('secrets.')
    const step = job.steps![0]!
    expect(step.env?.GATE_STEP).toBe(GATE_STEP)

    // Each API call answers with what its --jq would have extracted.
    const stub = [
      'gh() {',
      '  if [ "$1" != api ]; then printf "%s\\n" "$*" >> "$GH_CALLS"; return; fi',
      '  case "$*" in',
      '    *"/attempts/"*) printf "%s" "$FIXTURE" ;;',
      '    *"/workflows/"*) printf "%s" "$NEWEST" ;;',
      '    *) printf "%s" "$CURRENT_ATTEMPT" ;;',
      '  esac',
      '}',
      '',
    ].join('\n')
    const execute = (jobsInRun: unknown[], state: { newest?: string; currentAttempt?: string } = {}) => {
      const directory = mkdtempSync(join(tmpdir(), 'looptroop-rerun-'))
      const calls = join(directory, 'calls')
      try {
        const result = spawnSync('bash', ['-euo', 'pipefail', '-c', stub + String(step.run)], {
          encoding: 'utf8',
          env: {
            ...process.env,
            FIXTURE: JSON.stringify([{ jobs: jobsInRun }]),
            NEWEST: state.newest ?? '42',
            CURRENT_ATTEMPT: state.currentAttempt ?? '1',
            GH_CALLS: calls,
            GH_REPO: 'looptroop-ai/LoopTroop',
            RUN_ID: '42',
            ATTEMPT: '1',
            WORKFLOW_ID: '7',
            HEAD_BRANCH: 'topic',
            HEAD_REPO: 'looptroop-ai/LoopTroop',
            EVENT: 'pull_request',
            GATE_STEP,
            NOT_GATED: String(step.env?.NOT_GATED),
          },
        })
        expect(result.status, result.stderr).toBe(0)
        return { output: result.stdout, calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
    const unacquired = { name: 'Test (macos-latest, toolchain floor)', conclusion: 'cancelled', runner_name: '', steps: [] }
    const gate = { name: 'Packaging', conclusion: 'failure', runner_name: 'runner-1', steps: [{ name: GATE_STEP, conclusion: 'failure' }] }
    const finding = { name: 'Verify (ubuntu, toolchain floor)', conclusion: 'failure', runner_name: 'runner-2', steps: [{ name: 'Lint', conclusion: 'failure' }] }
    const timedOut = { name: 'Test shard 1/2 (windows-latest, toolchain floor)', conclusion: 'cancelled', runner_name: 'runner-3', steps: [{ name: 'Test', conclusion: 'cancelled' }] }
    const passed = { name: 'Bundle (build)', conclusion: 'success', runner_name: 'runner-4', steps: [{ name: 'Build', conclusion: 'success' }] }

    const lost = execute([unacquired, gate, passed])
    expect(lost.calls).toBe('run rerun 42 --failed\n')
    expect(lost.output).toContain('No runner ever picked up: Test (macos-latest, toolchain floor).')
    const mixed = execute([unacquired, gate, finding])
    expect(mixed.calls, 'a real failure in the same run is never re-run').toBe('')
    expect(mixed.output).toContain('left as it is: Verify (ubuntu, toolchain floor); never got a machine: Test (macos-latest, toolchain floor).')
    expect(execute([unacquired, timedOut]).calls, 'a timeout is a finding').toBe('')
    const ran = execute([finding, gate])
    expect(ran.calls).toBe('')
    expect(ran.output, 'an ordinary failure is named as one').toContain('Jobs failed on their own, so run 42 is left as it is: Verify (ubuntu, toolchain floor).')

    // An advisory job's failure decides no merge, so it does not stop a re-run;
    // the next-Node lane reports `failure` although it continues on error.
    const advisory = (name: string) => ({ name, conclusion: 'failure', runner_name: 'runner-5', steps: [{ name: 'Test', conclusion: 'failure' }] })
    expect(execute([unacquired, gate, advisory('Early warning (ubuntu, next Node major)'), advisory('Codecov')]).calls).toBe('run rerun 42 --failed\n')
    const onlyAdvisory = execute([advisory('Codecov')])
    expect(onlyAdvisory.calls).toBe('')
    expect(onlyAdvisory.output).toContain('nothing to re-run')
    // A startup failure with no runner and no steps is the same no-code-ran kind.
    expect(execute([{ ...unacquired, conclusion: 'startup_failure' }, gate]).calls).toBe('run rerun 42 --failed\n')
    // The advisory names are ci.yml's own display names.
    const ci = workflows.get('ci.yml')!.jobs! as Record<string, Job & { name?: string }>
    expect(JSON.parse(String(step.env?.NOT_GATED))).toEqual([ci.codecov!.name, ci['early-warning']!.name])

    const replaced = execute([unacquired, gate], { newest: '43' })
    expect(replaced.calls, 'a newer run for the branch would be cancelled by the re-run').toBe('')
    expect(replaced.output).toContain('replaced by run 43')
    const moved = execute([unacquired, gate], { currentAttempt: '2' })
    expect(moved.calls, 'a later attempt decides for itself').toBe('')
    expect(moved.output).toContain('already at attempt 2')
    expect(step.env?.HEAD_BRANCH, 'a fork-chosen name reaches the script only through the environment').toBe('${{ github.event.workflow_run.head_branch }}')
    expect(String(step.run)).not.toContain('${{')
    // "Newest" among this repository's runs: a fork can push a branch of the same name.
    expect(step.env?.HEAD_REPO).toBe('${{ github.event.workflow_run.head_repository.full_name }}')
    expect(String(step.run)).toContain('select(.head_repository.full_name == env.HEAD_REPO)')
    // A re-run someone else started meanwhile is refused; that must not turn this run red.
    const refused = spawnSync('bash', ['-euo', 'pipefail', '-c', `${stub.replace('if [ "$1" != api ]; then printf "%s\\n" "$*" >> "$GH_CALLS"; return; fi', 'if [ "$1" != api ]; then return 1; fi')}${String(step.run)}`], {
      encoding: 'utf8',
      env: {
        ...process.env, FIXTURE: JSON.stringify([{ jobs: [unacquired, gate] }]), NEWEST: '42', CURRENT_ATTEMPT: '1',
        GH_REPO: 'looptroop-ai/LoopTroop', RUN_ID: '42', ATTEMPT: '1', WORKFLOW_ID: '7', HEAD_BRANCH: 'topic', HEAD_REPO: 'looptroop-ai/LoopTroop',
        EVENT: 'pull_request', GATE_STEP, NOT_GATED: String(step.env?.NOT_GATED),
      },
    })
    expect(refused.status, refused.stderr).toBe(0)
    expect(refused.stdout).toContain('::warning::GitHub refused to re-run run 42')
  })

  /**
   * Renovate used to rebase every open pull request of its own after every
   * merge to main, and every rebase was a full CI run, mostly for pull requests
   * that would be rebased again before anyone merged them; it made up two
   * thirds of all CI runs. Now it rebases only on a conflict, and whoever
   * merges ticks the rebase box first, because main requires an up-to-date
   * branch.
   */
  it('lets Renovate rebase only on conflict', () => {
    const renovate = JSON.parse(readFileSync(join(repo, '.github/renovate.json'), 'utf8')) as { rebaseWhen?: string }
    expect(renovate.rebaseWhen).toBe('conflicted')
    expect(readFileSync(join(repo, '.github/CONTRIBUTING.md'), 'utf8')).toContain('tick the rebase box')
  })

  /**
   * The workflow security audit fails Verify on any finding it is not told to
   * excuse, so what it is told to excuse is a reviewed list, here, kept short.
   */
  it('excuses only reviewed zizmor rules, and only the ones that read other repositories\' state', () => {
    const config = yaml.load(readFileSync(join(repo, '.github/zizmor.yml'), 'utf8')) as { rules: Record<string, { disable?: boolean }> }
    expect(Object.entries(config.rules).map(([rule, settings]) => [rule, settings.disable])).toEqual([
      ['self-repository', true],
      ['ref-version-mismatch', true],
      ['known-vulnerable-actions', true],
      ['stale-action-refs', true],
    ])
    const ignores = [...source].flatMap(([file, text]) => [...text.matchAll(/zizmor: ignore\[([a-z-]+)\]/g)].map((match) => `${file}: ${match[1]}`))
    expect(ignores.sort()).toEqual(['release.yml: artipacked', 'rerun-unacquired.yml: dangerous-triggers'])
  })
})
