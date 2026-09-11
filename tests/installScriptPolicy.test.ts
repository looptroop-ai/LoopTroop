import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { launchTool } from '../scripts/tool-path.ts'
import { makeTempDir, removeTempDir } from '../server/test/tempDir'

const repo = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
  allowScripts: Record<string, boolean>
}
const workflowDir = join(repo, '.github/workflows')
const workflows = readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file)).map((file) => ({
  file,
  document: yaml.load(readFileSync(join(workflowDir, file), 'utf8')) as {
    jobs: Record<string, {
      strategy?: { matrix?: { manager?: string[]; include?: { manager: string; package: string }[] } }
      steps?: { run?: string; env?: Record<string, string> }[]
    }>
  },
}))

describe('dependency install script policy', () => {
  it('approves exactly the locked esbuild scripts, with no production install hooks', () => {
    const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; hasInstallScript?: boolean; dev?: boolean }>
    }
    const policy: Record<string, boolean> = {}
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!entry.hasInstallScript) continue
      const name = path.split('node_modules/').at(-1)
      expect(entry.dev, path).toBe(true)
      if (name !== 'esbuild') {
        expect(name, path).toBe('fsevents')
        policy[`${name}@${entry.version}`] = false
        continue
      }
      policy[`${name}@${entry.version}`] = true
    }
    expect(Object.values(policy)).toContain(true)
    expect(manifest.allowScripts).toEqual(policy)
  })

  it('checks npm policy before every workflow dependency install', () => {
    let installs = 0
    for (const { file, document } of workflows) {
      for (const [job, { steps = [] }] of Object.entries(document.jobs)) {
        let checked = false
        for (const { run = '' } of steps) {
          for (const line of run.split('\n')) {
            if (/^\s*node scripts\/pin-npm\.mjs(?: --check-policy)?\s*$/.test(line)) {
              expect(line.trim()).toBe(`node scripts/pin-npm.mjs${file === 'ci.yml' && job === 'early-warning' ? ' --check-policy' : ''}`)
              checked = true
            }
            if (!/^\s*npm (?:ci|install|i)(?:\s|$)/.test(line) || /(?:^|\s)(?:-g|--global)(?:\s|$)/.test(line)) continue
            installs++
            expect(checked, `${file}: ${job} installs dependencies before checking npm policy`).toBe(true)
          }
        }
      }
    }
    expect(installs).toBeGreaterThan(0)
  })

  it('limits global OpenCode lifecycle approval to the exact installed version', () => {
    const commands = workflows.flatMap(({ document }) => Object.values(document.jobs)
      .flatMap(({ steps = [] }) => steps.map(({ run = '' }) => run)))
      .filter((run) => /^npm install --global .*opencode-ai@/m.test(run))
    expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) {
      const match = /^npm install --global --allow-scripts=(opencode-ai@\d+\.\d+\.\d+) (opencode-ai@\d+\.\d+\.\d+)$/m.exec(command)
      expect(match, command).not.toBeNull()
      expect(match?.[1]).toBe(match?.[2])
    }
  })

  it('keeps global manager approvals version-pinned to the closed manager list', () => {
    const ci = workflows.find(({ file }) => file === 'ci.yml')!.document
    const smoke = workflows.find(({ file }) => file === 'published-smoke.yml')!.document
    const managers = ci.jobs['node-managers']!
    expect(managers.strategy?.matrix?.manager).toEqual(['bun', 'pnpm', 'yarn'])
    const pins = managers.strategy!.matrix!.include!
    expect(pins.map(({ manager }) => manager)).toEqual(['bun', 'pnpm', 'yarn'])
    for (const { manager, package: spec } of pins) {
      expect(spec.split('@')[0]).toBe(manager)
      expect(spec.split('@')[1]).toMatch(/^\d+\.\d+\.\d+$/)
    }
    expect(managers.steps?.some(({ run }) => run === 'npm install -g --allow-scripts=${{ matrix.package }} ${{ matrix.package }}')).toBe(true)
    const install = Object.values(smoke.jobs).flatMap(({ steps = [] }) => steps).find(({ env }) => env?.PINS)
    expect(install?.env?.PINS).toBe(pins.map(({ manager, package: spec }) => `${manager}=${spec}`).join(' '))
    expect(install?.run).toContain('npm install --global --allow-scripts="${pin#*=}" "${pin#*=}"')
    expect(install?.run).toContain('if [ -z "${installed}" ]; then')
    expect(install?.run).toContain('exit 1')
  })

  it('pins the Renovate validator and keeps npm bootstraps script-free', () => {
    const commands = workflows.flatMap(({ document }) => Object.values(document.jobs)
      .flatMap(({ steps = [] }) => steps.map(({ run = '' }) => run)))
    const validators = commands.filter((run) => run.includes('renovate-config-validator'))
    expect(validators).toHaveLength(1)
    expect(validators[0]).toMatch(/^npx --yes --package renovate@\d+\.\d+\.\d+ renovate-config-validator --strict$/)
    const bootstraps = commands.filter((run) => /npm install --global .*npm@/.test(run))
    expect(bootstraps).toHaveLength(2)
    for (const run of bootstraps) expect(run).toMatch(/npm install --global --ignore-scripts npm@\d+\.\d+\.\d+/)
    expect(readFileSync(join(repo, 'scripts/pin-npm.mjs'), 'utf8')).toContain("npm(['install', '--global', '--ignore-scripts', `npm@${declared}`])")
  })

  it('executes an approved local tarball hook and blocks an unapproved one offline', () => {
    const root = makeTempDir('looptroop-install-policy-')
    const npm = (args: string[], cwd: string) => {
      const launch = launchTool('npm', args)
      const result = spawnSync(launch.file, launch.args, {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        env: { ...process.env, npm_config_cache: join(root, 'cache'), npm_config_userconfig: join(root, 'npmrc') },
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      return `${result.stdout}\n${result.stderr}`.trim()
    }
    try {
      writeFileSync(join(root, 'npmrc'), '')
      expect(npm(['--version'], root)).toMatch(/^12\./)
      const dependencies: Record<string, string> = {}
      for (const name of ['approved-hook', 'unapproved-hook']) {
        const directory = join(root, name)
        mkdirSync(directory)
        writeFileSync(join(directory, 'package.json'), JSON.stringify({
          name, version: '1.0.0', scripts: { postinstall: 'node postinstall.cjs' },
        }))
        writeFileSync(join(directory, 'postinstall.cjs'), "require('node:fs').writeFileSync('ran', 'yes')\n")
        npm(['pack', '--offline', '--ignore-scripts', '--pack-destination', root], directory)
        dependencies[name] = `file:${join(root, `${name}-1.0.0.tgz`).replaceAll('\\', '/')}`
      }
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'install-policy-fixture', version: '1.0.0', private: true,
        // npm matches tarball identities by file spec, not their untrusted package name.
        dependencies,
      }))
      npm(['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], root)
      // npm writes its resolved tarball identity, including native Windows paths.
      npm(['install-scripts', 'approve', 'approved-hook', '--allow-scripts-pin', '--offline'], root)
      const output = npm(['ci', '--offline', '--no-audit', '--no-fund'], root)
      expect(existsSync(join(root, 'node_modules/approved-hook/ran')), output).toBe(true)
      expect(existsSync(join(root, 'node_modules/unapproved-hook/package.json'))).toBe(true)
      expect(existsSync(join(root, 'node_modules/unapproved-hook/ran'))).toBe(false)
      expect(output).toContain('unapproved-hook@1.0.0')
      npm(['install-scripts', 'deny', 'unapproved-hook', '--allow-scripts-pin', '--offline'], root)
      const denied = npm(['ci', '--offline', '--no-audit', '--no-fund'], root)
      expect(existsSync(join(root, 'node_modules/unapproved-hook/ran'))).toBe(false)
      expect(denied).not.toContain('install-scripts')
    } finally {
      removeTempDir(root)
    }
  }, 60_000)
})
