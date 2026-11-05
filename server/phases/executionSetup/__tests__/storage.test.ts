import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import * as tickets from '../../../storage/tickets'
import { resolveProjectTicketContainedPath } from '../../../ticket/containedPath'
import { join } from 'node:path'
import { makeTempDir, pinGitLineEndings, removeTempDir } from '../../../test/tempDir'
import {
  createExecutionSetupPathSnapshot,
  clearExecutionSetupRuntimeArtifacts,
  removeCanceledExecutionSetupFolder,
  sweepCanceledExecutionSetupFolders,
  validateExecutionSetupPaths,
} from '../storage'

function createGitRepo(): string {
  const dir = makeTempDir('execution-setup-storage-')
  execFileSync('git', ['-C', dir, 'init'], { stdio: 'pipe' })
  pinGitLineEndings(dir)
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' })
  writeFileSync(join(dir, 'hello.ts'), 'export const hello = 1\n')
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial'], { stdio: 'pipe' })
  return dir
}

describe('execution setup storage tracking', () => {
  const repoDirs: string[] = []
  afterEach(() => vi.restoreAllMocks())

  function makeFreshRepo(): string {
    const dir = createGitRepo()
    repoDirs.push(dir)
    return dir
  }

  afterAll(() => {
    for (const dir of repoDirs) {
      removeTempDir(dir)
    }
  })

  it.each([false, true])('unlinks setup directory aliases without traversing them (dangling: %s)', (dangling) => {
    const root = makeFreshRepo()
    const runtime = join(root, '.looptroop/worktrees/TEST-1/.ticket/runtime')
    const outside = makeFreshRepo()
    const alias = join(runtime, 'execution-setup')
    mkdirSync(runtime, { recursive: true })
    symlinkSync(dangling ? join(outside, 'missing') : outside, alias, 'junction')
    vi.spyOn(tickets, 'resolveTicketContainedPath').mockImplementation((_id, path, kind) =>
      resolveProjectTicketContainedPath(root, 'TEST-1', path, kind),
    )
    expect(clearExecutionSetupRuntimeArtifacts('1:TEST-1', { preserveToolCache: true })).toContain(alias)
    expect(() => lstatSync(alias)).toThrow()
    expect(readFileSync(join(outside, 'hello.ts'), 'utf8')).toBe('export const hello = 1\n')
  })

  it('allows setup to change tracked repository files outside runtime paths', () => {
    const dir = makeFreshRepo()
    writeFileSync(join(dir, 'hello.ts'), 'export const hello = 2\n')

    const validation = validateExecutionSetupPaths(dir)

    expect(validation.ok).toBe(true)
    expect(validation.violations).toEqual([])
    expect(validation.changedPaths).toContain('hello.ts')
  })

  it('allows setup to create non-ignored untracked files outside runtime paths', () => {
    const dir = makeFreshRepo()
    writeFileSync(join(dir, 'scratch.ts'), 'temporary\n')

    const validation = validateExecutionSetupPaths(dir)

    expect(validation.ok).toBe(true)
    expect(validation.violations).toEqual([])
    expect(validation.changedPaths).toContain('scratch.ts')
  })

  it('allows newly created ignored setup outputs outside runtime paths', () => {
    const dir = makeFreshRepo()
    writeFileSync(join(dir, '.gitignore'), 'tool-cache/\n')
    execFileSync('git', ['-C', dir, 'add', '.gitignore'], { stdio: 'pipe' })
    execFileSync('git', ['-C', dir, 'commit', '-m', 'ignore tool cache'], { stdio: 'pipe' })
    const baseline = createExecutionSetupPathSnapshot(dir)

    mkdirSync(join(dir, 'tool-cache', 'deps'), { recursive: true })
    writeFileSync(join(dir, 'tool-cache', 'deps', 'state.txt'), 'warm\n')

    const validation = validateExecutionSetupPaths(dir, baseline)

    expect(validation.ok).toBe(true)
    expect(validation.violations).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('keeps unusual Git paths opaque in setup snapshots', () => {
    const dir = makeFreshRepo()
    const baseline = createExecutionSetupPathSnapshot(dir)
    const names = ['a\tb', 'sp ace ', 'back\\slash', 'ünï', 'line\nfeed']
    for (const name of names) writeFileSync(join(dir, name), `content for ${name}\n`)

    const validation = validateExecutionSetupPaths(dir, baseline)

    expect(validation.changedPaths).toEqual(expect.arrayContaining(names))
  })

  it('removes a canceled ticket\'s setup folder and caches but keeps its setup profile', async () => {
    const root = makeFreshRepo()
    const runtime = join(root, '.looptroop/worktrees/TEST-1/.ticket/runtime')
    mkdirSync(join(runtime, 'execution-setup', 'tool-cache', 'deps'), { recursive: true })
    writeFileSync(join(runtime, 'execution-setup', 'tool-cache', 'deps', 'package.tgz'), 'cached\n')
    writeFileSync(join(runtime, 'execution-setup', 'launcher.sh'), '#!/bin/sh\n')
    writeFileSync(join(runtime, 'execution-setup-profile.json'), '{"status":"ready"}\n')
    vi.spyOn(tickets, 'resolveTicketContainedPath').mockImplementation((_id, path, kind) =>
      resolveProjectTicketContainedPath(root, 'TEST-1', path, kind),
    )

    await expect(removeCanceledExecutionSetupFolder('1:TEST-1')).resolves.toBe(true)
    expect(existsSync(join(runtime, 'execution-setup'))).toBe(false)
    expect(readFileSync(join(runtime, 'execution-setup-profile.json'), 'utf8')).toContain('"ready"')
    await expect(removeCanceledExecutionSetupFolder('1:TEST-1')).resolves.toBe(false)
  })

  it('does nothing for a ticket it cannot resolve', async () => {
    vi.spyOn(tickets, 'resolveTicketContainedPath').mockReturnValue(undefined)
    await expect(removeCanceledExecutionSetupFolder('1:GONE-1')).resolves.toBe(false)
  })

  it('retries leftover setup folders of canceled tickets and keeps going past one it cannot reach', async () => {
    const root = makeFreshRepo()
    const leftover = join(root, '.looptroop/worktrees/TEST-2/.ticket/runtime/execution-setup')
    mkdirSync(join(leftover, 'tool-cache'), { recursive: true })
    writeFileSync(join(leftover, 'tool-cache', 'package.tgz'), 'cached\n')
    vi.spyOn(tickets, 'resolveTicketContainedPath').mockImplementation((ticketId, path, kind) => {
      if (ticketId === '1:BROKEN-1') throw new Error('Path escapes root')
      return resolveProjectTicketContainedPath(root, ticketId.split(':')[1]!, path, kind)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(sweepCanceledExecutionSetupFolders(['1:BROKEN-1', '1:TEST-2', '1:TEST-3'])).resolves.toBe(1)

    expect(existsSync(leftover)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1:BROKEN-1'), expect.any(Error))
  })
})
