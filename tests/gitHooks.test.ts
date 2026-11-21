import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOKS_PATH, installGitHooks, planHooks, runPrepareScript, type HookState } from '../scripts/install-git-hooks'

const repo = process.cwd()
const directories: string[] = []
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'looptroop-git-hooks-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
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
  const ready: HookState = { ci: false, hooksDirExists: true, insideWorkTree: true, current: null }

  it('sets the hooks path on a clone that has none', () => {
    expect(planHooks(ready)).toEqual({ action: 'set' })
  })

  it('keeps a hooks path that already points here', () => {
    expect(planHooks({ ...ready, current: HOOKS_PATH })).toEqual({ action: 'keep' })
  })

  it.each([
    [{ ci: true }, 'CI runs no git hooks.'],
    [{ hooksDirExists: false }, 'there is no .githooks/ directory.'],
    [{ insideWorkTree: false }, 'this is not a git work tree.'],
    [{ current: '/home/me/hooks' }, 'core.hooksPath is already /home/me/hooks, which is left as it is.'],
  ] as const)('skips when %o', (change, reason) => {
    expect(planHooks({ ...ready, ...change })).toEqual({ action: 'skip', reason })
  })
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

  it('does nothing, silently, in CI', () => {
    const directory = gitRepo({ hooksDir: true })
    const log: string[] = []
    expect(installGitHooks(directory, { CI: 'true' }, (line) => log.push(line)).action).toBe('skip')
    expect(hooksPath(directory)).toBeNull()
    expect(log).toEqual([])
  })

  it('does nothing outside a git work tree', () => {
    const directory = scratch()
    mkdirSync(join(directory, HOOKS_PATH))
    const log: string[] = []
    expect(installGitHooks(directory, {}, (line) => log.push(line))).toEqual({ action: 'skip', reason: 'this is not a git work tree.' })
    expect(log[0]).toContain('not installed')
  })

  it('reports, rather than fails, when git refuses to write the setting', () => {
    const directory = gitRepo({ hooksDir: true })
    const answers: Record<string, string | null> = { 'rev-parse': 'true', 'config --get': null, config: null }
    const log: string[] = []
    const plan = installGitHooks(directory, {}, (line) => log.push(line), (args) =>
      answers[args[0] === 'config' && args[1] === '--get' ? 'config --get' : String(args[0])] ?? null)
    expect(plan).toEqual({ action: 'skip', reason: 'git config failed.' })
    expect(log).toEqual(['git hooks: could not set core.hooksPath; lint and typecheck will not run before a push.'])
  })

  it('never lets an error escape the prepare script, so npm install cannot fail here', () => {
    const log: string[] = []
    runPrepareScript('/nowhere', () => { throw new Error('boom') }, (line) => log.push(line))
    runPrepareScript('/nowhere', () => { throw 'plain' }, (line) => log.push(line))
    expect(log).toEqual(['git hooks: not installed (boom).', 'git hooks: not installed (plain).'])
  })

  // `npm pack --json` runs the prepare script, and verify:package and the install
  // smoke parse npm's stdout as JSON: one line of ours there broke both.
  it('reports on stderr and keeps stdout empty', () => {
    const directory = gitRepo({ hooksDir: true })
    // A URL, because Windows reads an absolute path's drive letter as a URL scheme.
    const specifier = pathToFileURL(join(repo, 'scripts', 'install-git-hooks.ts')).href
    const script = `import { runPrepareScript } from ${JSON.stringify(specifier)}\nrunPrepareScript(${JSON.stringify(directory)})`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, CI: '' },
    })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toBe('')
    expect(child.stderr).toContain('git hooks: .githooks/pre-push now runs lint and typecheck')
    expect(hooksPath(directory)).toBe(HOOKS_PATH)
  })

  it('is the prepare script, so npm install sets it up', () => {
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string>; files?: string[] }
    expect(manifest.scripts.prepare).toBe('node scripts/install-git-hooks.ts')
    expect(manifest.files ?? [], 'the hook is for clones, not the published package').not.toContain(HOOKS_PATH)
  })
})

// The hook is a POSIX shell script that Git for Windows runs under its own sh;
// the test drives it with a stand-in npm, which is a shell script here too.
describe.skipIf(process.platform === 'win32')('the pre-push hook', () => {
  function push(stdin: string, failing?: string) {
    const bin = scratch()
    const calls = join(bin, 'calls')
    const npm = join(bin, 'npm')
    writeFileSync(npm, `#!/bin/sh\necho "$*" >> "${calls}"\n[ "$*" != "${failing ?? ''}" ]\n`)
    chmodSync(npm, 0o755)
    const result = spawnSync('sh', [join(repo, HOOKS_PATH, 'pre-push'), 'origin', 'https://example.invalid/repo.git'], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    })
    return { status: result.status, stderr: result.stderr, calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] }
  }

  const commit = 'refs/heads/topic 1111111111111111111111111111111111111111 refs/heads/topic 0000000000000000000000000000000000000000\n'
  const deletion = '(delete) 0000000000000000000000000000000000000000 refs/heads/old 2222222222222222222222222222222222222222\n'

  it('lints, then typechecks, before a push that carries commits', () => {
    const result = push(deletion + commit)
    expect(result.status, result.stderr).toBe(0)
    expect(result.calls).toEqual(['run lint', 'run typecheck'])
    expect(result.stderr).toContain('git push --no-verify')
  })

  it('stops the push at the first failure', () => {
    const result = push(commit, 'run lint')
    expect(result.status).not.toBe(0)
    expect(result.calls).toEqual(['run lint'])
  })

  it('fails the push when the typecheck fails', () => {
    const result = push(commit, 'run typecheck')
    expect(result.status).not.toBe(0)
    expect(result.calls).toEqual(['run lint', 'run typecheck'])
  })

  it('checks nothing for a push of deletions only, or of nothing', () => {
    expect(push(deletion)).toMatchObject({ status: 0, calls: [] })
    expect(push('')).toMatchObject({ status: 0, calls: [] })
  })
})
