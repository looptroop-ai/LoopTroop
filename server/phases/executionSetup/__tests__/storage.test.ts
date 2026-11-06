import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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

  function canceledLeftovers(root: string, externalIds: string[]): Record<string, string> {
    const folders: Record<string, string> = {}
    for (const externalId of externalIds) {
      const folder = join(root, `.looptroop/worktrees/${externalId}/.ticket/runtime/execution-setup`)
      mkdirSync(join(folder, 'tool-cache'), { recursive: true })
      writeFileSync(join(folder, 'tool-cache', 'package.tgz'), 'cached\n')
      folders[externalId] = folder
    }
    vi.spyOn(tickets, 'getTicketStorageContext').mockImplementation((ticketRef) => (
      { projectRoot: root, externalId: ticketRef.split(':')[1]! } as ReturnType<typeof tickets.getTicketStorageContext>
    ))
    vi.spyOn(tickets, 'resolveTicketContainedPath').mockImplementation((ticketId, path, kind) => {
      if (ticketId === '1:BROKEN-1') throw new Error('Path escapes root')
      return resolveProjectTicketContainedPath(root, ticketId.split(':')[1]!, path, kind)
    })
    return folders
  }

  it('retries leftover setup folders of canceled tickets and keeps going past one it cannot reach', async () => {
    const root = makeFreshRepo()
    const folders = canceledLeftovers(root, ['BROKEN-1', 'TEST-2'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const asked: string[] = []

    await expect(sweepCanceledExecutionSetupFolders(['1:BROKEN-1', '1:TEST-2', '1:TEST-3'], (ref) => {
      asked.push(ref)
      return true
    })).resolves.toBe(1)

    expect(existsSync(folders['TEST-2']!)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1:BROKEN-1'), expect.any(Error))
    // TEST-3 has no folder, so it is never asked about (no synchronous checks).
    expect(asked).toEqual(['1:BROKEN-1', '1:TEST-2'])
  })

  it('leaves the folder of a ticket whose cancel is not confirmed, or that is no longer canceled', async () => {
    const root = makeFreshRepo()
    const folders = canceledLeftovers(root, ['TEST-4'])

    await expect(sweepCanceledExecutionSetupFolders(['1:TEST-4'], () => false)).resolves.toBe(0)

    expect(existsSync(folders['TEST-4']!)).toBe(true)
  })

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('removes a read-only package cache by making it writable first', async () => {
    const root = makeFreshRepo()
    const folders = canceledLeftovers(root, ['TEST-5'])
    chmodSync(join(folders['TEST-5']!, 'tool-cache'), 0o555)

    await expect(removeCanceledExecutionSetupFolder('1:TEST-5')).resolves.toBe(true)

    expect(existsSync(folders['TEST-5']!)).toBe(false)
  })
})
