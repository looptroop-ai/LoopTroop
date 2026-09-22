import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { parseNodeFloor, parseNodeVersion, satisfiesNodeFloor } from '../shared/nodeFloor'

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

  it('keeps every literal workflow and Docker Node runtime at the package floor', () => {
    const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { engines: { node: string } }
    const floor = parseNodeFloor(packageJson.engines.node)

    for (const [file, text] of source) {
      for (const match of text.matchAll(/^\s*node-version:\s*["']?(v?\d+(?:\.\d+){0,2})["']?(?=\s|$)/gm)) {
        const found = match[1]
        if (!found) throw new Error(`${file}: node-version capture missing`)
        const parsed = concreteVersion(found)
        if (parsed === null) continue
        expect(satisfiesNodeFloor(parsed, floor), `${file}: node-version ${found}`).toBe(true)
      }
      for (const match of text.matchAll(/^\s*node:\s*["']?(v?\d+(?:\.\d+){0,2})["']?(?=\s|$)/gm)) {
        const found = match[1]
        if (!found) throw new Error(`${file}: matrix node capture missing`)
        const parsed = concreteVersion(found)
        if (parsed === null) continue
        expect(satisfiesNodeFloor(parsed, floor), `${file}: matrix node ${found}`).toBe(true)
      }
    }

    const docker = readFileSync(join(repo, 'scripts', 'Dockerfile'), 'utf8')
    for (const match of docker.matchAll(/^\s*FROM\s+node:(\d+(?:\.\d+){0,2})(?=[-@])/gm)) {
      const found = match[1]
      if (!found) throw new Error('Dockerfile: Node version capture missing')
      const parsed = concreteVersion(found)
      if (parsed === null) continue
      expect(satisfiesNodeFloor(parsed, floor), `Dockerfile: node ${found}`).toBe(true)
    }
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
      expect(binary, `${file}: binary runtime`).not.toContain('node-version: 24.21.0')
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
