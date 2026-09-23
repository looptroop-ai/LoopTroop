import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { formatNodeVersion, parseNodeFloor, parseNodeVersion, satisfiesNodeFloor } from '../shared/nodeFloor'

const repo = process.cwd()
const workflowDir = join(repo, '.github/workflows')
const files = readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file))
const source = new Map(files.map((file) => [file, readFileSync(join(workflowDir, file), 'utf8')]))

type Step = { name?: unknown; run?: unknown; uses?: unknown; env?: Record<string, unknown> }
type Job = { permissions?: Record<string, unknown>; steps?: Step[] }
type Workflow = { jobs?: Record<string, Job> }

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

type MatrixEntry = Record<string, unknown>

/** The `include` entries of a job's matrix, as the parser reads them. */
function matrixEntries(job: Job): MatrixEntry[] {
  const include = (job as { strategy?: { matrix?: { include?: unknown } } }).strategy?.matrix?.include
  return Array.isArray(include) ? include as MatrixEntry[] : []
}

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

describe('release workflow policy', () => {
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
   * The toolchain is stated once, in `.nvmrc`, and every other copy is held to
   * it. That used to happen for free: the pin and `engines.node` were one
   * number, so holding the copies to the floor held them to each other. Split
   * apart, a lower bound would let the container, the toolchain lanes and the
   * release jobs each drift to a different runtime while every test passed —
   * Renovate moves `.nvmrc` and the Dockerfile, and nothing moves these.
   *
   * The only exceptions are named: the declared-floor lanes, which run the
   * floor, and the standalone builder's embedded runtime, which the binary-job
   * test below confines to those jobs.
   */
  it('holds every Node runtime literal to the toolchain pin, or to the floor where it says so', () => {
    const toolchain = formatNodeVersion(parseNodeVersion(readFileSync(join(repo, '.nvmrc'), 'utf8').trim()))

    for (const [file, text] of source) {
      for (const match of text.matchAll(/^\s*node-version:\s*["']?(v?\d+(?:\.\d+){0,2})["']?(?=\s|$)/gm)) {
        const found = match[1]
        if (!found) throw new Error(`${file}: node-version capture missing`)
        const parsed = concreteVersion(found)
        if (parsed === null) continue
        expect([toolchain, EMBEDDED_BUILDER], `${file}: node-version ${found}`).toContain(formatNodeVersion(parsed))
      }
    }

    // A bare major floats to whatever shipped this week, and the checks above
    // skip it. Only the Node 26 early-warning lane may float, on purpose.
    for (const [file, workflow] of workflows) {
      for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
        for (const step of (job.steps ?? []) as Array<Step & { with?: Record<string, unknown> }>) {
          const selector = step.with?.['node-version']
          if (typeof selector !== 'string' && typeof selector !== 'number') continue
          if (String(selector).includes('${{')) continue
          if (concreteVersion(String(selector)) === null) {
            expect(`${file}: ${name}`, `${file}: ${name} floats on node-version ${String(selector)}`).toBe('ci.yml: early-warning')
          }
        }
      }
    }

    for (const [file, workflow] of workflows) {
      for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
        for (const entry of matrixEntries(job)) {
          if (entry.node === undefined) continue
          const parsed = concreteVersion(String(entry.node))
          if (parsed === null) continue
          const expected = entry.label === 'declared floor' ? FLOOR : toolchain
          expect(formatNodeVersion(parsed), `${file}: ${name} matrix node (${String(entry.label)})`).toBe(expected)
        }
      }
    }

    const docker = readFileSync(join(repo, 'scripts', 'Dockerfile'), 'utf8')
    const bases = [...docker.matchAll(/^\s*FROM\s+node:(\d+\.\d+\.\d+)(?=[-@])/gm)].map(([, version]) => version)
    expect(bases.length, 'Dockerfile Node base images').toBeGreaterThan(0)
    for (const base of bases) expect(base, 'Dockerfile FROM node:').toBe(toolchain)
  })

  /**
   * The floor is a promise, and the only lanes that keep it are the ones that
   * switch to the exact version `engines.node` names. They read it at run time,
   * so a floor change never has to edit this workflow — which the job that
   * finishes Renovate's floor pull requests could not push anyway.
   *
   * Four ways the promise can quietly stop being kept. The switch can stop
   * reading the floor. A platform can be dropped, so the operating systems are
   * asserted as a set, and an `include` or `exclude` could add or remove a
   * combination unseen, so neither is allowed. And the job can be made
   * advisory — `continue-on-error` reports success however the job went.
   */
  it('runs the declared floor, read from engines.node, on every platform, and blocks on it', () => {
    const job = workflows.get('ci.yml')?.jobs?.['test-matrix'] as (Job & {
      'continue-on-error'?: unknown
      strategy?: { matrix?: Record<string, unknown> }
    }) | undefined
    if (!job) throw new Error('ci.yml: test-matrix job missing')
    expect(Object.hasOwn(job, 'continue-on-error'), 'test-matrix continue-on-error').toBe(false)

    const matrix = job.strategy?.matrix ?? {}
    expect(Object.keys(matrix).sort(), 'test-matrix axes').toEqual(['label', 'os'])
    expect([...(matrix.os as string[])].sort(), 'test-matrix platforms').toEqual(PLATFORMS)
    expect([...(matrix.label as string[])].sort(), 'test-matrix lanes').toEqual(['declared floor', 'toolchain floor'])

    const steps = (job.steps ?? []) as Array<Step & { id?: unknown; if?: unknown; with?: Record<string, unknown> }>
    const floorOnly = "matrix.label == 'declared floor'"
    const read = steps.findIndex((step) => step.id === 'floor')
    const switchTo = steps.findIndex((step) =>
      String(step.uses ?? '').startsWith('actions/setup-node@') && step.with?.['node-version'] === '${{ steps.floor.outputs.node }}')
    expect(read, 'the floor is read from engines.node').toBeGreaterThan(-1)
    expect(switchTo, 'the floor is read before switching to it').toBeGreaterThan(read)
    expect(steps[read]?.if).toBe(floorOnly)
    expect(steps[switchTo]?.if).toBe(floorOnly)
    expect(String(steps[read]?.run), 'the floor is parsed by the shared parser').toContain('parseNodeFloor')

    const test = steps.findIndex((step) => step.run === 'npm run test')
    expect(test, 'the suite runs after the switch').toBeGreaterThan(switchTo)
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

    const pins = steps.flatMap((step, index) => text(step).includes('scripts/pin-npm.mjs') ? [index] : [])
    expect(pins.length, 'pin-npm before the dependency install').toBeGreaterThan(0)
    for (const pin of pins) expect(pin, 'no npm pin after switching to the floor').toBeLessThan(floor)

    const smoke = steps.findIndex((step) => text(step).includes('node scripts/smoke-install.mjs'))
    expect(smoke, 'the smoke runs on the floor runtime').toBeGreaterThan(floor)

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
      expect(binary, `${file}: binary runtime`).not.toContain(`node-version: ${TOOLCHAIN}`)
      expect(binary, `${file}: embedded-runtime check`).toContain('Run blocking application checks on the embedded runtime')
      expect(binary, `${file}: embedded-runtime check`).toContain('doctor --json')
      expect(binary, `${file}: embedded-runtime check`).toContain('nodeCheck?.node?.version')
      expect(binary, `${file}: embedded-runtime check`).toContain('EXPECTED_NODE_VERSION')
      expect(binary, `${file}: embedded-runtime check`).not.toContain('v26.9.0 (latest')
      expect(binary, `${file}: binary job`).not.toContain('continue-on-error:')

      expect((text.match(/^\s*node-version:\s*26\.9\.0\s*$/gm) ?? []).length, `${file}: only binary jobs pin Node 26.9.0`).toBe(1)
    }

    const earlyWarning = source.get('ci.yml')!.slice(
      source.get('ci.yml')!.indexOf('  early-warning:'),
    )
    expect(earlyWarning).toContain('continue-on-error: true')
    expect(earlyWarning).toContain('node-version: 26')
  })

  it('keeps OIDC and attestation permissions off dependency/build jobs', () => {
    for (const [file, workflow] of workflows) {
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        const permissions = job.permissions ?? {}
        if (permissions['id-token'] !== 'write' && permissions.attestations !== 'write') continue
        expect(runs(job), `${file}: ${jobName}`).not.toMatch(/\bnpm\s+(?:ci|install|run)\b/)
      }
    }
    const release = workflows.get('release.yml')!
    expect(release.jobs?.binary?.permissions?.['id-token']).toBeUndefined()
    expect(release.jobs?.build?.permissions?.attestations).toBeUndefined()
    expect(runs(release.jobs?.npm ?? {})).toMatch(/\bnpm publish\b/)
    expect(runs(release.jobs?.npm ?? {})).not.toMatch(/\bnpm\s+(?:ci|install|run)\b/)
    expect(release.jobs?.['attest-release-assets']?.permissions?.attestations).toBe('write')
    expect(release.jobs?.['container-attest']?.permissions?.['id-token']).toBe('write')
    expect(runs(release.jobs?.['attest-release-assets'] ?? {}).trim()).toBe('')
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

  it('uses the released tag for scheduled and repair smoke code', () => {
    const smoke = source.get('published-smoke.yml')!
    expect(smoke).toContain('git checkout --detach "refs/tags/v${VERSION}"')
    expect(smoke).toContain('ref: refs/tags/v${{ needs.plan.outputs.version }}')
    expect(source.get('channel-republish.yml')!).not.toMatch(/--ref\s+main/)
    expect(source.get('container-republish.yml')!).not.toMatch(/--ref\s+main/)
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

  it('executes the Windows affected-file scope against affected and unrelated paths', () => {
    const windowsGate = workflows.get('ci.yml')!.jobs?.['windows-gate']
    const scope = windowsGate?.steps?.find((step) => step.name === 'Check whether the Windows profile is affected')?.run
    if (typeof scope !== 'string') throw new Error('Windows gate scope script missing')
    expect(scope).toContain('changed="$(git diff --name-only "${BASE_SHA}" "${HEAD_SHA}")"')
    expect(scope).toContain('done <<< "${changed}"')
    expect(scope).not.toContain('< <(git diff')

    for (const path of ['scripts/smoke-lib.mjs', 'scripts/installer-core.mjs', 'scripts/smoke-installer.mjs']) {
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
    expect(releaseAttestation).toContain('path: release-assets')
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
    expect(repairBuild).toContain('path: release-assets')
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
   * The floor workflow commits to Renovate's branch with a write token, from a
   * patch that code on that branch produced. The token must never share a job
   * with that code, and the patch must be confined to the files the floor lives
   * in before git applies it.
   */
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
    // Push and pull request both report this required name for one commit, so
    // both must reach the same verdict: no event may skip the step.
    expect(gate?.if, 'the feed gate runs on every event').toBeUndefined()
    expect(gate?.env?.BASE_REF).toBe('${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}')
    expect(String(gate?.run)).toContain('node scripts/check-node-feeds.ts')
    expect(String(gate?.run)).toContain('engines.node')
    expect(gate?.env?.GITHUB_TOKEN).toBe('${{ github.token }}')

    const packaging = ci.packaging as (Job & { needs?: unknown }) | undefined
    expect(packaging?.needs, 'Packaging waits on the declared-floor lanes').toContain('test-matrix')
  })

  it('finishes Renovate floor pull requests without giving the branch a token', () => {
    const workflow = workflows.get('renovate-node-floor.yml')
    const text = source.get('renovate-node-floor.yml')
    if (!workflow || !text) throw new Error('renovate-node-floor.yml missing')
    const jobs = workflow.jobs ?? {}
    expect(Object.keys(jobs).sort()).toEqual(['push', 'regenerate'])

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
    expect(apply?.env).toBeUndefined()
    for (const path of ['package-lock.json', 'README.md', 'scripts/install.ps1', 'scripts/install.sh', 'server/cli/launcher.cjs', 'tests/fixtures/channels/looptroop.nuspec']) {
      expect(String(apply?.run), `the patch may edit ${path}`).toContain(` ${path} `)
    }
    expect(String(apply?.run)).toContain('git apply --summary')
    // A floor move changes numbers only, so nothing else may reach install.sh.
    for (const side of ['removed', 'added']) {
      expect(String(apply?.run), `${side} lines are compared with their numbers masked`)
        .toContain(`line = substr($0, 2); gsub(/[0-9]+/, "#", line); print line > ${side}; next }`)
    }
    expect(String(apply?.run)).toContain('cmp -s -- "${removed}" "${added}"')
    expect(text).toContain('persist-credentials: false')
    expect(text).not.toContain('persist-credentials: true')
  })

  it('downloads Renovate notices outside checkout and gives the token only to push', () => {
    const text = source.get('renovate-notices.yml')!
    expect(text).toContain('path: ${{ runner.temp }}/third-party-notices-artifact')
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
})
