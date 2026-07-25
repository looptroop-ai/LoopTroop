import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverGitHooks } from '../hookDiscovery'

const roots: string[] = []

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'looptroop-hooks-'))
  roots.push(root)
  execFileSync('git', ['init', root], { stdio: 'ignore' })
  return root
}

function writeExecutable(path: string, content = '#!/bin/sh\nexit 0\n') {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('discoverGitHooks', () => {
  it('discovers an executable standard hook from the Git hooks directory', () => {
    const root = createRepository()
    const hooksDirRaw = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim()
    const hooksDir = isAbsolute(hooksDirRaw) ? hooksDirRaw : resolve(root, hooksDirRaw)
    writeExecutable(join(hooksDir, 'pre-commit'))

    expect(discoverGitHooks(root).detected).toContainEqual(expect.objectContaining({
      name: 'pre-commit',
      source: 'git-hooks-directory',
      kind: 'hook',
      runnable: process.platform === 'win32' ? 'unknown' : 'yes',
    }))
  })

  it('honors core.hooksPath and recognizes Husky without assuming a language', () => {
    const root = createRepository()
    mkdirSync(join(root, '.husky'))
    writeExecutable(join(root, '.husky', 'pre-push'))
    execFileSync('git', ['-C', root, 'config', 'core.hooksPath', '.husky'])

    const result = discoverGitHooks(root)
    expect(result.configuredHooksPath).toBe('.husky')
    expect(result.detected).toContainEqual(expect.objectContaining({
      name: 'pre-push',
      path: '.husky/pre-push',
      source: 'core.hooksPath',
      kind: 'hook',
      managerHint: 'husky',
    }))
  })

  it('records known manager manifests and suggests explicit commands', () => {
    const root = createRepository()
    writeFileSync(join(root, '.pre-commit-config.yaml'), 'repos: []\n')
    writeFileSync(join(root, 'lefthook.yml'), 'pre-commit: {}\n')

    const result = discoverGitHooks(root)
    expect(result.detected).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'manager_config', managerHint: 'pre-commit', runnable: 'no' }),
      expect.objectContaining({ kind: 'manager_config', managerHint: 'lefthook', runnable: 'no' }),
    ]))
    expect(result.suggestedValidationCommands.map((command) => command.command)).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 'process', program: 'pre-commit', args: ['run', '--all-files'] }),
      expect.objectContaining({ mode: 'process', program: 'lefthook', args: ['run', 'pre-commit'] }),
    ]))
  })

  it('keeps an unknown custom hook visible without inventing a validation command', () => {
    const root = createRepository()
    mkdirSync(join(root, '.githooks'))
    writeExecutable(join(root, '.githooks', 'commit-msg'), '#!/bin/sh\ncustom-validator "$1"\n')

    const result = discoverGitHooks(root)
    expect(result.detected).toContainEqual(expect.objectContaining({ name: 'commit-msg', path: '.githooks/commit-msg' }))
    expect(result.suggestedValidationCommands).toEqual([])
  })

  it('reports a non-runnable hook without treating it as manager configuration', () => {
    const root = createRepository()
    const hooksDirRaw = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim()
    const hooksDir = isAbsolute(hooksDirRaw) ? hooksDirRaw : resolve(root, hooksDirRaw)
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 0\n')

    expect(discoverGitHooks(root).detected).toContainEqual(expect.objectContaining({
      name: 'pre-commit',
      kind: 'hook',
      runnable: process.platform === 'win32' ? 'unknown' : 'no',
    }))
  })
})
