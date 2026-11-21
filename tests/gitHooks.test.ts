import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOOKS_PATH, installGitHooks, isCi, planHooks, runHookInstaller, type HookState } from '../scripts/install-git-hooks'

const repo = process.cwd()
const directories: string[] = []
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'looptroop-git-hooks-'))
  directories.push(directory)
  return directory
}

// A contributor's own global or system git config (a global core.hooksPath,
// say) must not decide these tests. Child processes inherit the stubbed env.
beforeEach(() => {
  const config = join(scratch(), 'gitconfig')
  writeFileSync(config, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function gitRepo(options: { hooksDir: boolean }) {
  const directory = scratch()
  execFileSync('git', ['init', '--quiet', directory])
  if (options.hooksDir) mkdirSync(join(directory, HOOKS_PATH))
  return directory
}

function hooksPath(directory: string) {
  const result = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: directory, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

describe('planHooks', () => {
  const ready: HookState = { ci: false, hooksDirExists: true, ownWorkTree: true, current: null, existingHooks: [] }

  it('sets the hooks path on a clone that has none', () => {
    expect(planHooks(ready)).toEqual({ action: 'set' })
  })

  it('keeps a hooks path that already points here', () => {
    expect(planHooks({ ...ready, current: HOOKS_PATH })).toEqual({ action: 'keep' })
  })

  it.each([
    [{ ci: true }, 'CI runs no git hooks.'],
    [{ hooksDirExists: false }, 'there is no .githooks/ directory.'],
    [{ ownWorkTree: false }, 'this directory is not the top of its own git work tree.'],
    [{ current: '/home/me/hooks' }, 'core.hooksPath is already /home/me/hooks, which is left as it is.'],
    [{ existingHooks: ['commit-msg', 'pre-commit'] }, 'your own hooks (commit-msg, pre-commit) would stop running; to use .githooks/ anyway, run git config core.hooksPath .githooks.'],
  ] as const)('skips when %o', (change, reason) => {
    expect(planHooks({ ...ready, ...change })).toEqual({ action: 'skip', reason })
  })
})

describe('isCi', () => {
  it.each([['true', true], ['TRUE', true], ['1', true], ['false', false], ['0', false], ['', false], [undefined, false]] as const)(
    'reads CI=%s as %s',
    (value, expected) => {
      expect(isCi(value === undefined ? {} : { CI: value })).toBe(expected)
    },
  )
})

describe('installGitHooks', () => {
  it('points a fresh clone at .githooks and says how to skip the hook', () => {
    const directory = gitRepo({ hooksDir: true })
    const log: string[] = []
    expect(installGitHooks(directory, {}, (line) => log.push(line))).toEqual({ action: 'set' })
    expect(hooksPath(directory)).toBe(HOOKS_PATH)
    expect(log).toEqual([expect.stringContaining('git push --no-verify')])
    expect(installGitHooks(directory, {}, () => {})).toEqual({ action: 'keep' })
  })

  it('leaves someone else\'s hooks path alone, and says so', () => {
    const directory = gitRepo({ hooksDir: true })
    execFileSync('git', ['config', 'core.hooksPath', 'custom-hooks'], { cwd: directory })
    const log: string[] = []
    expect(installGitHooks(directory, {}, (line) => log.push(line)).action).toBe('skip')
    expect(hooksPath(directory)).toBe('custom-hooks')
    expect(log[0]).toContain('core.hooksPath is already custom-hooks')
  })

  it('keeps hooks of your own in .git/hooks running, and says how to switch anyway', () => {
    const directory = gitRepo({ hooksDir: true })
    writeFileSync(join(directory, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n')
    const log: string[] = []
    const plan = installGitHooks(directory, {}, (line) => log.push(line))
    expect(plan).toEqual({ action: 'skip', reason: expect.stringContaining('your own hooks (pre-commit)') })
    expect(hooksPath(directory)).toBeNull()
    expect(log[0]).toContain('git config core.hooksPath .githooks')
  })

  it('does not count the samples git init writes as hooks of your own', () => {
    const directory = gitRepo({ hooksDir: true })
    writeFileSync(join(directory, '.git', 'hooks', 'pre-push.sample'), '#!/bin/sh\n')
    expect(installGitHooks(directory, {}, () => {})).toEqual({ action: 'set' })
  })

  it('does nothing, silently, in CI', () => {
    const directory = gitRepo({ hooksDir: true })
    const log: string[] = []
    expect(installGitHooks(directory, { CI: 'true' }, (line) => log.push(line)).action).toBe('skip')
    expect(hooksPath(directory)).toBeNull()
    expect(log).toEqual([])
  })

  it('treats CI=false as not CI', () => {
    const directory = gitRepo({ hooksDir: true })
    expect(installGitHooks(directory, { CI: 'false' }, () => {})).toEqual({ action: 'set' })
  })

  it('does nothing outside a git work tree', () => {
    const directory = scratch()
    mkdirSync(join(directory, HOOKS_PATH))
    const log: string[] = []
    expect(installGitHooks(directory, {}, (line) => log.push(line))).toEqual({
      action: 'skip',
      reason: 'this directory is not the top of its own git work tree.',
    })
    expect(log[0]).toContain('not installed')
  })

  // A source copy unpacked inside another repository is "inside a work tree",
  // but that work tree and its hooks belong to someone else.
  it('leaves the enclosing repository alone when the project is only a folder inside it', () => {
    const outer = gitRepo({ hooksDir: false })
    const copy = join(outer, 'vendor', 'looptroop')
    mkdirSync(join(copy, HOOKS_PATH), { recursive: true })
    expect(installGitHooks(copy, {}, () => {})).toEqual({ action: 'skip', reason: 'this directory is not the top of its own git work tree.' })
    expect(hooksPath(outer)).toBeNull()
  })

  it('reports, rather than fails, when git refuses to write the setting', () => {
    const directory = gitRepo({ hooksDir: true })
    const answers: Record<string, string | null> = {
      'rev-parse --show-toplevel': directory,
      'config --get': null,
      'rev-parse --git-path': '.git/hooks',
      'config --local': null,
    }
    const log: string[] = []
    const plan = installGitHooks(directory, {}, (line) => log.push(line), (args) => answers[`${args[0]} ${args[1]}`] ?? null)
    expect(plan).toEqual({ action: 'skip', reason: 'git config failed.' })
    expect(log).toEqual(['git hooks: could not set core.hooksPath; lint and typecheck will not run before a push.'])
  })

  it('never lets an error escape, so npm run dev cannot fail here', () => {
    const log: string[] = []
    runHookInstaller('/nowhere', () => { throw new Error('boom') }, (line) => log.push(line))
    runHookInstaller('/nowhere', () => { throw 'plain' }, (line) => log.push(line))
    expect(log).toEqual(['git hooks: not installed (boom).', 'git hooks: not installed (plain).'])
  })

  // Run as a script, the way npm runs it; its lines stay out of stdout, which
  // tools that wrap npm commands parse.
  it('reports on stderr and keeps stdout empty', () => {
    const directory = gitRepo({ hooksDir: true })
    // A URL, because Windows reads an absolute path's drive letter as a URL scheme.
    const specifier = pathToFileURL(join(repo, 'scripts', 'install-git-hooks.ts')).href
    const script = `import { runHookInstaller } from ${JSON.stringify(specifier)}\nrunHookInstaller(${JSON.stringify(directory)})`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, CI: '' },
    })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toBe('')
    expect(child.stderr).toContain('git hooks: .githooks/pre-push now runs lint and typecheck')
    expect(hooksPath(directory)).toBe(HOOKS_PATH)
  })

  // npm keeps every script in the published manifest. An install script there
  // makes npm 12 warn whoever installs the tarball that a script was blocked,
  // and fail a strict install; the hook installer is not even shipped.
  it('runs before npm run dev, and the published manifest has no install script', () => {
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string>; files?: string[] }
    expect(manifest.scripts.hooks).toBe('node scripts/install-git-hooks.ts')
    expect(manifest.scripts.predev).toContain('npm run hooks')
    for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
      expect(Object.hasOwn(manifest.scripts, lifecycle), `scripts.${lifecycle}`).toBe(false)
    }
    expect(manifest.files ?? [], 'the hook is for clones, not the published package').not.toContain(HOOKS_PATH)
  })

  // Git ignores a hook that is not executable, with one easily missed warning.
  it('keeps the hook executable in git', () => {
    const entry = execFileSync('git', ['ls-files', '--stage', '--', join(HOOKS_PATH, 'pre-push')], { cwd: repo, encoding: 'utf8' })
    expect(entry.split(' ')[0]).toBe('100755')
  })
})

// The hook is a POSIX shell script that Git for Windows runs under its own sh;
// the test drives it with a stand-in npm, which is a shell script here too.
describe.skipIf(process.platform === 'win32')('the pre-push hook', () => {
  function push(stdin: string, options: { failing?: string; cwd?: string } = {}) {
    const bin = scratch()
    const calls = join(bin, 'calls')
    const npm = join(bin, 'npm')
    writeFileSync(npm, `#!/bin/sh\necho "$*" >> "${calls}"\n[ "$*" != "${options.failing ?? ''}" ]\n`)
    chmodSync(npm, 0o755)
    const result = spawnSync('sh', [join(repo, HOOKS_PATH, 'pre-push'), 'origin', 'https://example.invalid/repo.git'], {
      cwd: options.cwd ?? repo,
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    })
    return { status: result.status, stderr: result.stderr, calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] }
  }

  const commit = 'refs/heads/topic 1111111111111111111111111111111111111111 refs/heads/topic 0000000000000000000000000000000000000000\n'
  const deletion = '(delete) 0000000000000000000000000000000000000000 refs/heads/old 2222222222222222222222222222222222222222\n'
  const tag = 'refs/tags/v9.9.9 3333333333333333333333333333333333333333 refs/tags/v9.9.9 0000000000000000000000000000000000000000\n'

  it('lints, then typechecks, before a push that carries commits', () => {
    const result = push(deletion + tag + commit)
    expect(result.status, result.stderr).toBe(0)
    expect(result.calls).toEqual(['run lint', 'run typecheck'])
    expect(result.stderr).toContain('git push --no-verify')
  })

  it('stops the push at the first failure', () => {
    const result = push(commit, { failing: 'run lint' })
    expect(result.status).not.toBe(0)
    expect(result.calls).toEqual(['run lint'])
  })

  it('fails the push when the typecheck fails', () => {
    const result = push(commit, { failing: 'run typecheck' })
    expect(result.status).not.toBe(0)
    expect(result.calls).toEqual(['run lint', 'run typecheck'])
  })

  it('checks nothing for a push of deletions or tags only, or of nothing', () => {
    expect(push(deletion)).toMatchObject({ status: 0, calls: [] })
    expect(push(tag)).toMatchObject({ status: 0, calls: [] })
    expect(push('')).toMatchObject({ status: 0, calls: [] })
  })

  it('skips, and says why, in a checkout with no dependencies installed', () => {
    const result = push(commit, { cwd: scratch() })
    expect(result).toMatchObject({ status: 0, calls: [] })
    expect(result.stderr).toContain('no dependencies installed')
  })
})
