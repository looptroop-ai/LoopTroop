import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, pinGitLineEndings } from '../../../test/tempDir'
import {
  captureBeadDiff,
  commitBeadChanges,
  filterAllowedFiles,
  getExecutionSetupCommitExcludedRoots,
  isAllowedFile,
  recordBeadStartCommit,
  resetToBeadStart,
} from '../gitOps'
import { TEST } from '../../../test/factories'

const BRANCH = TEST.externalId

describe('gitOps worktree change classification', () => {
  it('allows language-agnostic project files without an extension allowlist', () => {
    expect(isAllowedFile('src/app.ts')).toBe(true)
    expect(isAllowedFile('src/style.css')).toBe(true)
    expect(isAllowedFile('src/Program.cs')).toBe(true)
    expect(isAllowedFile('package.json')).toBe(true)
    expect(isAllowedFile('Makefile')).toBe(true)
    expect(isAllowedFile('image.png')).toBe(true)
    expect(isAllowedFile('data.bin')).toBe(true)
  })

  it('allows .jsonl files', () => {
    expect(isAllowedFile('issues.jsonl')).toBe(true)
    expect(isAllowedFile('reports/issues.jsonl')).toBe(true)
  })

  it('blocks all .ticket paths from commit capture', () => {
    expect(isAllowedFile('.ticket/interview.yaml')).toBe(false)
    expect(isAllowedFile('.ticket/prd.yaml')).toBe(false)
    expect(isAllowedFile('.ticket/codebase-map.yaml')).toBe(false)
    expect(isAllowedFile('.ticket/beads/master/.beads/issues.jsonl')).toBe(false)
    expect(isAllowedFile('.ticket/meta/ticket.meta.json')).toBe(false)
    expect(isAllowedFile('.ticket/ui/artifact-companions/beads_expanded.json')).toBe(false)
  })

  it('blocks LoopTroop runtime/internal paths', () => {
    expect(isAllowedFile('.ticket/runtime/state.json')).toBe(false)
    expect(isAllowedFile('.ticket/locks/main.lock')).toBe(false)
    expect(isAllowedFile('.ticket/sessions/abc.json')).toBe(false)
    expect(isAllowedFile('.ticket/streams/live.json')).toBe(false)
    expect(isAllowedFile('.ticket/tmp/scratch.ts')).toBe(false)
  })

  it('treats common generated and local-only outputs as noise only while untracked', () => {
    expect(isAllowedFile('node_modules/foo/bar.js')).toBe(false)
    expect(isAllowedFile('dist/bundle.js')).toBe(false)
    expect(isAllowedFile('.env')).toBe(false)
    expect(isAllowedFile('.env.local')).toBe(false)
    expect(isAllowedFile('.env.example')).toBe(true)

    expect(isAllowedFile('dist/bundle.js', { untracked: false })).toBe(true)
    expect(isAllowedFile('node_modules/foo/bar.js', { untracked: false })).toBe(true)
    expect(isAllowedFile('.env', { untracked: false })).toBe(true)
  })

  it('blocks legacy execution setup cache paths even when tracked', () => {
    expect(isAllowedFile('.cache/project-tooling/go/src/runtime.go')).toBe(false)
    expect(isAllowedFile('.cache/project-tooling-extra/go/src/runtime.go')).toBe(false)
    expect(isAllowedFile('.cache/project-tooling-extra/go/src/runtime.go', { untracked: false })).toBe(true)
  })

  it('filterAllowedFiles returns only allowed files', () => {
    const files = ['src/app.ts', 'node_modules/foo.js', '.ticket/runtime/x.json', 'issues.jsonl']
    expect(filterAllowedFiles(files)).toEqual(['src/app.ts', 'issues.jsonl'])
  })

  it('filters caller-provided execution setup roots', () => {
    const files = [
      'src/app.ts',
      '.ticket/runtime/execution-setup/tool-cache/go/src/runtime.go',
      'issues.jsonl',
    ]

    expect(filterAllowedFiles(files, {
      excludedRoots: ['.ticket/runtime/execution-setup/tool-cache'],
    })).toEqual(['src/app.ts', 'issues.jsonl'])
  })
})

// ---------------------------------------------------------------------------
// Helpers for integration tests — real git repos in OS temp directories
// ---------------------------------------------------------------------------

function createGitRepo(): string {
  const dir = makeTempDir('gitops-test-')
  execFileSync('git', ['-C', dir, 'init'], { stdio: 'pipe' })
  pinGitLineEndings(dir)
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' })
  writeFileSync(join(dir, 'hello.ts'), 'const x = 1\n')
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial'], { stdio: 'pipe' })
  return dir
}

function headSha(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

function createBareRemote(): string {
  const dir = makeTempDir('gitops-remote-')
  execFileSync('git', ['init', '--bare', dir], { stdio: 'pipe' })
  pinGitLineEndings(dir)
  return dir
}

// ---------------------------------------------------------------------------
// recordBeadStartCommit
// ---------------------------------------------------------------------------

describe('recordBeadStartCommit', () => {
  let repoDir: string

  beforeAll(() => {
    repoDir = createGitRepo()
  })

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('returns a valid 40-char hex SHA', () => {
    expect(recordBeadStartCommit(repoDir)).toMatch(/^[0-9a-f]{40}$/)
  })

  it('matches git rev-parse HEAD', () => {
    expect(recordBeadStartCommit(repoDir)).toBe(headSha(repoDir))
  })
})

// ---------------------------------------------------------------------------
// resetToBeadStart
// ---------------------------------------------------------------------------

describe('resetToBeadStart', () => {
  const repoDirs: string[] = []

  function makeFreshRepo(): [dir: string, sha: string] {
    const dir = createGitRepo()
    repoDirs.push(dir)
    return [dir, headSha(dir)]
  }

  afterAll(() => {
    for (const dir of repoDirs) rmSync(dir, { recursive: true, force: true })
  })

  it('reverts uncommitted file changes to tracked files', () => {
    const [dir, sha] = makeFreshRepo()
    writeFileSync(join(dir, 'hello.ts'), 'const x = CHANGED\n')
    resetToBeadStart(dir, sha)
    expect(readFileSync(join(dir, 'hello.ts'), 'utf8')).toBe('const x = 1\n')
  })

  it('removes untracked files (git clean -fd)', () => {
    const [dir, sha] = makeFreshRepo()
    writeFileSync(join(dir, 'untracked.ts'), 'export const y = 2\n')
    resetToBeadStart(dir, sha)
    expect(() => readFileSync(join(dir, 'untracked.ts'), 'utf8')).toThrow()
  })

  it('removes untracked directories created by local bootstrap steps', () => {
    const [dir, sha] = makeFreshRepo()
    mkdirSync(join(dir, '.tools', 'go', 'bin'), { recursive: true })
    mkdirSync(join(dir, '.cache', 'go-mod'), { recursive: true })
    writeFileSync(join(dir, '.tools', 'go', 'bin', 'go'), 'binary\n')
    writeFileSync(join(dir, '.cache', 'go-mod', 'state.txt'), 'cached\n')
    resetToBeadStart(dir, sha)
    expect(() => readFileSync(join(dir, '.tools', 'go', 'bin', 'go'), 'utf8')).toThrow()
    expect(() => readFileSync(join(dir, '.cache', 'go-mod', 'state.txt'), 'utf8')).toThrow()
  })

  it('leaves git status clean after reset', () => {
    const [dir, sha] = makeFreshRepo()
    writeFileSync(join(dir, 'hello.ts'), 'modified content\n')
    writeFileSync(join(dir, 'extra.ts'), 'extra\n')
    resetToBeadStart(dir, sha)
    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim()
    expect(status).toBe('')
  })

  it('preserves ignored files (git clean -fd does NOT remove .gitignore entries)', () => {
    // Demonstrates that `clean -fd` (without -x) leaves ignored files intact.
    // Only `clean -fdx` would remove them — a future accidental change to -fdx
    // would cause this test to fail, surfacing the semantic regression.
    const [dir] = makeFreshRepo()
    // Commit a .gitignore so *.log files are ignored from this point on
    writeFileSync(join(dir, '.gitignore'), '*.log\n')
    execFileSync('git', ['-C', dir, 'add', '.gitignore'], { stdio: 'pipe' })
    execFileSync('git', ['-C', dir, 'commit', '-m', 'add gitignore'], { stdio: 'pipe' })
    const shaWithGitignore = headSha(dir)

    // Create an ignored file — it should survive resetToBeadStart
    writeFileSync(join(dir, 'debug.log'), 'log content\n')

    resetToBeadStart(dir, shaWithGitignore)

    expect(readFileSync(join(dir, 'debug.log'), 'utf8')).toBe('log content\n')
  })

  it('preserves LoopTroop ticket artifacts when the .ticket exclusion is supplied', () => {
    const [dir, sha] = makeFreshRepo()
    mkdirSync(join(dir, '.ticket', 'beads', 'master', '.beads'), { recursive: true })
    mkdirSync(join(dir, '.ticket', 'meta'), { recursive: true })
    mkdirSync(join(dir, '.ticket', 'approvals'), { recursive: true })
    mkdirSync(join(dir, '.ticket', 'ui', 'artifact-companions'), { recursive: true })
    mkdirSync(join(dir, '.ticket', 'runtime', 'execution-setup'), { recursive: true })
    writeFileSync(join(dir, '.ticket', 'beads', 'master', '.beads', 'issues.jsonl'), '{"id":"bead-1"}\n')
    writeFileSync(join(dir, '.ticket', 'prd.yaml'), 'artifact: prd\n')
    writeFileSync(join(dir, '.ticket', 'relevant-files.yaml'), 'files: []\n')
    writeFileSync(join(dir, '.ticket', 'meta', 'ticket.meta.json'), '{"baseBranch":"master"}\n')
    writeFileSync(join(dir, '.ticket', 'approvals', 'beads.json'), '{"approved":true}\n')
    writeFileSync(join(dir, '.ticket', 'ui', 'artifact-companions', 'beads_expanded.json'), '{"ok":true}\n')
    writeFileSync(join(dir, '.ticket', 'runtime', 'execution-log.jsonl'), '{"message":"kept"}\n')
    writeFileSync(join(dir, '.ticket', 'runtime', 'execution-setup-profile.json'), '{"status":"ready"}\n')
    writeFileSync(join(dir, '.ticket', 'runtime', 'execution-setup', 'cache.txt'), 'warm\n')
    writeFileSync(join(dir, 'scratch.ts'), 'throw new Error("remove")\n')

    resetToBeadStart(dir, sha, {
      preservePaths: ['.ticket'],
    })

    expect(readFileSync(join(dir, '.ticket', 'beads', 'master', '.beads', 'issues.jsonl'), 'utf8')).toContain('bead-1')
    expect(readFileSync(join(dir, '.ticket', 'prd.yaml'), 'utf8')).toContain('artifact: prd')
    expect(readFileSync(join(dir, '.ticket', 'relevant-files.yaml'), 'utf8')).toContain('files: []')
    expect(readFileSync(join(dir, '.ticket', 'meta', 'ticket.meta.json'), 'utf8')).toContain('master')
    expect(readFileSync(join(dir, '.ticket', 'approvals', 'beads.json'), 'utf8')).toContain('approved')
    expect(readFileSync(join(dir, '.ticket', 'ui', 'artifact-companions', 'beads_expanded.json'), 'utf8')).toContain('ok')
    expect(readFileSync(join(dir, '.ticket', 'runtime', 'execution-log.jsonl'), 'utf8')).toContain('"kept"')
    expect(readFileSync(join(dir, '.ticket', 'runtime', 'execution-setup-profile.json'), 'utf8')).toContain('"ready"')
    expect(readFileSync(join(dir, '.ticket', 'runtime', 'execution-setup', 'cache.txt'), 'utf8')).toBe('warm\n')
    expect(() => readFileSync(join(dir, 'scratch.ts'), 'utf8')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// captureBeadDiff
// ---------------------------------------------------------------------------

describe('captureBeadDiff', () => {
  const repoDirs: string[] = []

  function makeFreshRepo(): [dir: string, sha: string] {
    const dir = createGitRepo()
    repoDirs.push(dir)
    return [dir, headSha(dir)]
  }

  afterAll(() => {
    for (const dir of repoDirs) rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty string when there are no changes since the start commit', () => {
    const [dir, sha] = makeFreshRepo()
    expect(captureBeadDiff(dir, sha)).toBe('')
  })

  it('returns non-empty diff when files are changed and committed after the start commit', () => {
    const [dir, sha] = makeFreshRepo()
    writeFileSync(join(dir, 'hello.ts'), 'const x = 2\n')
    execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' })
    execFileSync('git', ['-C', dir, 'commit', '-m', 'update hello'], { stdio: 'pipe' })
    const diff = captureBeadDiff(dir, sha)
    expect(diff.length).toBeGreaterThan(0)
    expect(diff).toContain('hello.ts')
  })

  it('excludes .ticket/ paths from the diff (pathspec :!.ticket)', () => {
    const [dir, sha] = makeFreshRepo()
    // Commit a regular file change
    writeFileSync(join(dir, 'feature.ts'), 'export const f = true\n')
    execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' })
    execFileSync('git', ['-C', dir, 'commit', '-m', 'add feature'], { stdio: 'pipe' })
    // Commit a .ticket/ file alongside it
    mkdirSync(join(dir, '.ticket'), { recursive: true })
    writeFileSync(join(dir, '.ticket', 'prd.yaml'), 'title: test\n')
    execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' })
    execFileSync('git', ['-C', dir, 'commit', '-m', 'add ticket artifact'], { stdio: 'pipe' })
    const diff = captureBeadDiff(dir, sha)
    expect(diff).toContain('feature.ts')
    expect(diff).not.toContain('.ticket')
  })
})

// ---------------------------------------------------------------------------
// commitBeadChanges
// ---------------------------------------------------------------------------

describe('commitBeadChanges', () => {
  const repoDirs: string[] = []

  function makeFreshRepo(): string {
    const dir = createGitRepo()
    repoDirs.push(dir)
    return dir
  }

  afterAll(() => {
    for (const dir of repoDirs) rmSync(dir, { recursive: true, force: true })
  })

  it('returns { committed: false, pushed: false } when there are no changes', () => {
    const dir = makeFreshRepo()
    expect(commitBeadChanges(dir, 'bead-1', 'No changes')).toEqual({
      committed: false,
      pushed: false,
    })
  })

  it('commits allowed files and reports committed:true, pushed:false when no remote', () => {
    const dir = makeFreshRepo()
    writeFileSync(join(dir, 'feature.ts'), 'export const feature = true\n')
    const result = commitBeadChanges(dir, 'bead-2', 'Add feature')
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(false)
    expect(result.error).toMatch(/push failed/)
  })

  it.each(['observe_only', 'validate_advisory', 'validate_required'] as const)('bypasses failing internal hooks for %s', (policy) => {
    const dir = makeFreshRepo()
    const hookPath = join(dir, '.git', 'hooks', 'pre-commit')
    writeFileSync(hookPath, '#!/bin/sh\nexit 7\n')
    chmodSync(hookPath, 0o755)
    mkdirSync(join(dir, '.ticket/runtime'), { recursive: true })
    writeFileSync(join(dir, '.ticket/runtime/execution-setup-profile.json'), JSON.stringify({ git_hooks: { policy } }))
    writeFileSync(join(dir, 'feature.ts'), `export const policy = '${policy}'\n`)

    expect(commitBeadChanges(dir, 'bead-hook', 'Hook policy')).toMatchObject({ committed: true })
  })

  it('runs failing internal hooks for use_native_hooks', () => {
    const dir = makeFreshRepo()
    const hookPath = join(dir, '.git', 'hooks', 'pre-commit')
    writeFileSync(hookPath, '#!/bin/sh\nexit 7\n')
    chmodSync(hookPath, 0o755)
    mkdirSync(join(dir, '.ticket/runtime'), { recursive: true })
    writeFileSync(join(dir, '.ticket/runtime/execution-setup-profile.json'), JSON.stringify({
      git_hooks: { policy: 'use_native_hooks' },
    }))
    writeFileSync(join(dir, 'feature.ts'), 'export const policy = true\n')

    const result = commitBeadChanges(dir, 'bead-hook', 'Hook policy')
    expect(result).toMatchObject({ committed: false, pushed: false })
    expect(result.error).toContain('git commit failed')
  })

  it('pushes the current ticket branch explicitly to origin without an upstream', () => {
    const dir = makeFreshRepo()
    const remoteDir = createBareRemote()
    repoDirs.push(remoteDir)

    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remoteDir], { stdio: 'pipe' })
    const baseBranch = execFileSync('git', ['-C', dir, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
    execFileSync('git', ['-C', dir, 'push', '-u', 'origin', baseBranch], { stdio: 'pipe' })
    execFileSync('git', ['-C', dir, 'checkout', '-b', BRANCH], { stdio: 'pipe' })
    writeFileSync(join(dir, 'feature.ts'), 'export const feature = 42\n')

    const result = commitBeadChanges(dir, 'bead-remote', 'Push explicitly')

    expect(result).toMatchObject({ committed: true, pushed: true })
    const remoteSha = execFileSync('git', ['-C', dir, 'ls-remote', '--heads', 'origin', `refs/heads/${BRANCH}`], {
      encoding: 'utf8',
    }).trim().split(/\s+/)[0]
    expect(remoteSha).toBe(headSha(dir))
  })

  it('returns no commit and records skipped files when only generated noise exists', () => {
    const dir = makeFreshRepo()
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')

    const result = commitBeadChanges(dir, 'bead-3', 'Generated only')

    expect(result).toMatchObject({
      committed: false,
      pushed: false,
    })
    expect(result.skippedFiles).toEqual(['node_modules/pkg/index.js'])
    expect(result.generatedNoiseWarning).toContain('Suggested .gitignore entries: node_modules/')
  })

  it('returns { committed: false, pushed: false } when only .ticket files changed', () => {
    const dir = makeFreshRepo()
    mkdirSync(join(dir, '.ticket', 'beads', 'master', '.beads'), { recursive: true })
    mkdirSync(join(dir, '.ticket', 'ui', 'artifact-companions'), { recursive: true })
    writeFileSync(join(dir, '.ticket', 'beads', 'master', '.beads', 'issues.jsonl'), '{"id":"bead-1"}\n')
    writeFileSync(join(dir, '.ticket', 'prd.yaml'), 'artifact: prd\n')
    writeFileSync(join(dir, '.ticket', 'ui', 'artifact-companions', 'beads_expanded.json'), '{"ok":true}\n')

    const result = commitBeadChanges(dir, 'bead-ticket-only', 'Skip ticket state')

    expect(result).toMatchObject({
      committed: false,
      pushed: false,
    })
    expect(result.skippedFiles).toEqual(expect.arrayContaining([
      '.ticket/beads/master/.beads/issues.jsonl',
      '.ticket/prd.yaml',
      '.ticket/ui/artifact-companions/beads_expanded.json',
    ]))

    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })
    expect(status).toContain('.ticket/')
  })

  it('formats the commit message as bead(<beadId>): <beadTitle>', () => {
    const dir = makeFreshRepo()
    writeFileSync(join(dir, 'msg-test.ts'), 'export const m = 1\n')
    commitBeadChanges(dir, 'bead-42', 'My Feature Title')
    const log = execFileSync('git', ['-C', dir, 'log', '--oneline', '-1'], {
      encoding: 'utf8',
    }).trim()
    expect(log).toContain('bead(bead-42): My Feature Title')
  })

  it('stages only committable files, leaving untracked generated noise alone', () => {
    const dir = makeFreshRepo()
    writeFileSync(join(dir, 'app.ts'), 'export const app = 1\n')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'generated.js'), 'module.exports = true\n')
    const result = commitBeadChanges(dir, 'bead-5', 'Mixed files')

    expect(result.skippedFiles).toEqual(['node_modules/generated.js'])
    // app.ts should be in the commit
    const showFiles = execFileSync('git', ['-C', dir, 'show', '--name-only', 'HEAD'], {
      encoding: 'utf8',
    })
    expect(showFiles).toContain('app.ts')
    // node_modules/generated.js should remain untracked
    const untrackedFiles = execFileSync('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' })
    expect(untrackedFiles).toContain('node_modules/generated.js')
  })

  it('commits code changes while leaving .ticket files untracked', () => {
    const dir = makeFreshRepo()
    mkdirSync(join(dir, '.ticket', 'beads', 'master', '.beads'), { recursive: true })
    writeFileSync(join(dir, 'app.ts'), 'export const app = 1\n')
    writeFileSync(join(dir, '.ticket', 'beads', 'master', '.beads', 'issues.jsonl'), '{"id":"bead-1"}\n')

    const result = commitBeadChanges(dir, 'bead-mixed-ticket', 'Commit code only')

    expect(result.committed).toBe(true)
    const committedFiles = execFileSync('git', [
      '-C',
      dir,
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      'HEAD',
    ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    expect(committedFiles).toEqual(['app.ts'])

    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })
    expect(status).toContain('.ticket/')
  })

  it('does not commit pre-staged LoopTroop files alongside project changes', () => {
    const dir = makeFreshRepo()
    mkdirSync(join(dir, '.ticket', 'runtime'), { recursive: true })
    writeFileSync(join(dir, '.ticket', 'runtime', 'secret.bin'), 'do not commit\n')
    execFileSync('git', ['-C', dir, 'add', '.ticket/runtime/secret.bin'], { stdio: 'pipe' })
    writeFileSync(join(dir, 'app.ts'), 'export const app = 1\n')

    const result = commitBeadChanges(dir, 'bead-6', 'Skip staged LoopTroop file')

    expect(result.committed).toBe(true)
    const committedFiles = execFileSync('git', [
      '-C',
      dir,
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      'HEAD',
    ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    expect(committedFiles).toContain('app.ts')
    expect(committedFiles).not.toContain('.ticket/runtime/secret.bin')

    const treeFiles = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', 'HEAD'], {
      encoding: 'utf8',
    })
    expect(treeFiles).not.toContain('.ticket/runtime/secret.bin')

    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })
    expect(status).toContain('.ticket/runtime/secret.bin')
  })

  it('commits arbitrary project file extensions and extensionless files', () => {
    const dir = makeFreshRepo()
    writeFileSync(join(dir, 'asset.bin'), 'binary data\n')
    writeFileSync(join(dir, 'Makefile'), 'test:\n\t@echo ok\n')

    const result = commitBeadChanges(dir, 'bead-any-file', 'Commit arbitrary project files')

    expect(result.committed).toBe(true)
    const committedFiles = execFileSync('git', [
      '-C',
      dir,
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      'HEAD',
    ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    expect(committedFiles).toEqual(expect.arrayContaining(['asset.bin', 'Makefile']))
  })

  it('commits tracked generated-output changes but skips untracked generated noise', () => {
    const dir = makeFreshRepo()
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'tracked baseline\n')
    execFileSync('git', ['-C', dir, 'add', 'dist/bundle.js'], { stdio: 'pipe' })
    execFileSync('git', ['-C', dir, 'commit', '-m', 'track bundle'], { stdio: 'pipe' })

    writeFileSync(join(dir, 'dist', 'bundle.js'), 'tracked change\n')
    writeFileSync(join(dir, 'dist', 'scratch.js'), 'untracked scratch\n')

    const result = commitBeadChanges(dir, 'bead-tracked-generated', 'Commit tracked generated file')

    expect(result.committed).toBe(true)
    expect(result.skippedFiles).toEqual(['dist/scratch.js'])
    const committedFiles = execFileSync('git', [
      '-C',
      dir,
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      'HEAD',
    ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    expect(committedFiles).toEqual(['dist/bundle.js'])
  })

  it('commits deleted project files', () => {
    const dir = makeFreshRepo()
    rmSync(join(dir, 'hello.ts'))

    const result = commitBeadChanges(dir, 'bead-delete', 'Delete file')

    expect(result.committed).toBe(true)
    const committedFiles = execFileSync('git', [
      '-C',
      dir,
      'diff-tree',
      '--no-commit-id',
      '--name-status',
      '-r',
      'HEAD',
    ], { encoding: 'utf8' }).trim()
    expect(committedFiles).toContain('D\thello.ts')
  })

  it('does not commit files under execution setup profile temp roots or reusable artifacts', () => {
    const dir = makeFreshRepo()
    mkdirSync(join(dir, '.ticket', 'runtime'), { recursive: true })
    mkdirSync(join(dir, '.ticket', 'runtime', 'execution-setup', 'tool-cache', 'go', 'src'), { recursive: true })
    mkdirSync(join(dir, '.repo-tool-cache', 'deps'), { recursive: true })
    writeFileSync(join(dir, '.ticket', 'runtime', 'execution-setup-profile.json'), JSON.stringify({
      schema_version: 1,
      ticket_id: 'T-1',
      artifact: 'execution_setup_profile',
      status: 'ready',
      summary: 'runtime roots',
      temp_roots: ['.ticket/runtime/execution-setup/tool-cache'],
      tooling_probe_commands: [],
      reusable_artifacts: [
        { path: '.repo-tool-cache', kind: 'cache', purpose: 'repository-required cache' },
      ],
      project_commands: {
        prepare: [],
        test_full: [],
        lint_full: [],
        typecheck_full: [],
      },
      quality_gate_policy: {
        tests: 'bead-test-commands-first',
        lint: 'impacted-or-package',
        typecheck: 'impacted-or-package',
        full_project_fallback: 'never-block-on-unrelated-baseline',
      },
      cautions: [],
    }))
    writeFileSync(join(dir, 'app.ts'), 'export const app = 1\n')
    writeFileSync(join(dir, '.ticket', 'runtime', 'execution-setup', 'tool-cache', 'go', 'src', 'runtime.go'), 'package runtime\n')
    writeFileSync(join(dir, '.repo-tool-cache', 'deps', 'state.ts'), 'export const cache = true\n')

    expect(getExecutionSetupCommitExcludedRoots(dir)).toEqual(expect.arrayContaining([
      '.cache/project-tooling',
      '.ticket/runtime/execution-setup/tool-cache',
      '.repo-tool-cache',
    ]))

    const result = commitBeadChanges(dir, 'bead-setup-roots', 'Skip setup roots')

    expect(result.committed).toBe(true)
    const committedFiles = execFileSync('git', [
      '-C',
      dir,
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      'HEAD',
    ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    expect(committedFiles).toEqual(['app.ts'])

    const untrackedFiles = execFileSync('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' })
    expect(untrackedFiles).toContain('.repo-tool-cache/deps/state.ts')
    expect(untrackedFiles).toContain('.ticket/runtime/execution-setup-profile.json')
  })

  it('classifies approved workspace inputs as setup-only and excludes them from commits', () => {
    const dir = makeFreshRepo()
    mkdirSync(join(dir, '.ticket', 'runtime'), { recursive: true })
    mkdirSync(join(dir, 'local-config'), { recursive: true })
    writeFileSync(join(dir, '.ticket', 'runtime', 'execution-setup-profile.json'), JSON.stringify({
      schema_version: 1,
      ticket_id: 'T-1',
      artifact: 'execution_setup_profile',
      status: 'ready',
      summary: 'approved workspace inputs',
      temp_roots: ['.ticket/runtime/execution-setup'],
      workspace_inputs: [
        {
          path: 'local-config',
          kind: 'directory',
          source_status: 'untracked',
          reason: 'The workspace needs local generated configuration.',
        },
      ],
      tooling_probe_commands: [],
      reusable_artifacts: [],
      project_commands: {
        prepare: [],
        test_full: [],
        lint_full: [],
        typecheck_full: [],
      },
      quality_gate_policy: {
        tests: 'bead-test-commands-first',
        lint: 'impacted-or-package',
        typecheck: 'impacted-or-package',
        full_project_fallback: 'never-block-on-unrelated-baseline',
      },
      cautions: [],
    }))
    writeFileSync(join(dir, 'local-config', 'project.json'), '{"local":true}\n')
    writeFileSync(join(dir, 'app.ts'), 'export const app = 1\n')

    expect(getExecutionSetupCommitExcludedRoots(dir)).toContain('local-config')

    const result = commitBeadChanges(dir, 'bead-workspace-inputs', 'Skip approved workspace inputs')

    expect(result.committed).toBe(true)
    expect(result.skippedFiles).toContain('local-config/project.json')
    const committedFiles = execFileSync('git', [
      '-C',
      dir,
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      'HEAD',
    ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    expect(committedFiles).toEqual(['app.ts'])
    expect(execFileSync('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }))
      .toContain('local-config/project.json')
  })

  it('does not commit legacy .cache/project-tooling files even without a setup profile', () => {
    const dir = makeFreshRepo()
    mkdirSync(join(dir, '.cache', 'project-tooling', 'go', 'src'), { recursive: true })
    writeFileSync(join(dir, '.cache', 'project-tooling', 'go', 'src', 'runtime.go'), 'package runtime\n')

    const result = commitBeadChanges(dir, 'bead-cache', 'Skip legacy cache')

    expect(result).toMatchObject({
      committed: false,
      pushed: false,
    })
    expect(result.skippedFiles).toEqual(['.cache/project-tooling/go/src/runtime.go'])

    const untrackedFiles = execFileSync('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' })
    expect(untrackedFiles).toContain('.cache/project-tooling/go/src/runtime.go')
  })
})
