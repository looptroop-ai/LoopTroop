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
    jobs: Record<string, { steps?: { run?: string }[] }>
  },
}))

describe('dependency install script policy', () => {
  it('approves exactly the locked esbuild scripts, with no production install hooks', () => {
    const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; hasInstallScript?: boolean; dev?: boolean }>
    }
    const approved = new Set<string>()
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!entry.hasInstallScript) continue
      const name = path.split('node_modules/').at(-1)
      expect(entry.dev, path).toBe(true)
      if (name !== 'esbuild') {
        expect(name, path).toBe('fsevents')
        expect(manifest.allowScripts[`${name}@${entry.version}`]).toBeUndefined()
        continue
      }
      approved.add(`${name}@${entry.version}`)
    }
    expect(approved.size).toBeGreaterThan(0)
    expect(manifest.allowScripts).toEqual(Object.fromEntries([...approved].map((name) => [name, true])))
  })

  it('checks npm policy before every workflow dependency install', () => {
    let installs = 0
    for (const { file, document } of workflows) {
      for (const [job, { steps = [] }] of Object.entries(document.jobs)) {
        let checked = false
        for (const { run = '' } of steps) {
          for (const line of run.split('\n')) {
            if (/^\s*node scripts\/pin-npm\.mjs(?: --check-policy)?\s*$/.test(line)) checked = true
            if (!/^\s*npm ci(?:\s|$)/.test(line)) continue
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
        dependencies, allowScripts: { [dependencies['approved-hook']!]: true },
      }))
      npm(['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], root)
      const output = npm(['ci', '--offline', '--no-audit', '--no-fund'], root)
      expect(existsSync(join(root, 'node_modules/approved-hook/ran')), output).toBe(true)
      expect(existsSync(join(root, 'node_modules/unapproved-hook/package.json'))).toBe(true)
      expect(existsSync(join(root, 'node_modules/unapproved-hook/ran'))).toBe(false)
    } finally {
      removeTempDir(root)
    }
  }, 60_000)
})
