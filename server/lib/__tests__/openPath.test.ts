import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { launch } = vi.hoisted(() => ({ launch: vi.fn(async (_program: string, _args: string[]) => ({ stdout: '' })) }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: launch }),
}))
vi.mock('../executablePath', () => ({ resolveTrustedExecutable: (name: string) => ({ path: `/trusted/${name}` }) }))

import { encodedInvokeItem, revealFolderInExplorer } from '../openPath'

const roots: string[] = []
beforeEach(() => {
  vi.stubEnv('WSL_DISTRO_NAME', '')
  vi.stubEnv('WSL_INTEROP', '')
  vi.spyOn(fs, 'readFile').mockResolvedValue('Linux')
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'looptroop-open-path-')))
  roots.push(root)
  const project = join(root, 'project')
  const outside = join(root, 'outside')
  mkdirSync(project)
  mkdirSync(outside)
  return { root, project, outside }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  launch.mockReset()
  launch.mockResolvedValue({ stdout: '' })
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('folder opener containment', () => {
  it('opens attached project folders, worktrees, and the parent of an existing file', async () => {
    const { project } = fixture()
    const worktree = join(project, '.looptroop', 'worktrees', 'ABC-1')
    mkdirSync(worktree, { recursive: true })
    const file = join(worktree, 'note.txt')
    writeFileSync(file, 'hello')
    for (const target of [project, worktree, file]) await revealFolderInExplorer(target, [project])
    expect(launch).toHaveBeenCalled()
    expect(launch.mock.calls.at(-1)?.[1]).toEqual([worktree])
  })

  it('refuses outside paths, traversal, missing paths and NUL before launching', async () => {
    const { project, outside } = fixture()
    for (const target of [outside, `${project}/../outside`, join(project, 'missing'), `${project}\0`, '../outside']) {
      await expect(revealFolderInExplorer(target, [project])).rejects.toThrow()
    }
    expect(launch).not.toHaveBeenCalled()
  })

  it('refuses an escaping directory link and accepts one that stays inside', async () => {
    const { project, outside } = fixture()
    const internal = join(project, 'internal')
    mkdirSync(internal)
    symlinkSync(outside, join(project, 'escape'), 'junction')
    symlinkSync(internal, join(project, 'alias'), 'junction')
    await expect(revealFolderInExplorer(join(project, 'escape'), [project])).rejects.toThrow()
    expect(launch).not.toHaveBeenCalled()
    await revealFolderInExplorer(join(project, 'alias'), [project])
    expect(launch.mock.calls.at(-1)?.[1]).toEqual([internal])
  })

  it('compares the canonical request with every allowed root', async () => {
    const { project, outside } = fixture()
    const alias = join(outside, 'project-alias')
    symlinkSync(project, alias, 'junction')
    await revealFolderInExplorer(alias, [project])
    expect(launch.mock.calls.at(-1)?.[1]).toEqual([project])
  })

  it('encodes spaces, apostrophes and PowerShell metacharacters as literal text', () => {
    const target = "C:\\project folder\\O'Brien’; Write-Output injected; #$x"
    const script = Buffer.from(encodedInvokeItem(target), 'base64').toString('utf16le')
    const encoded = Buffer.from(target, 'utf16le').toString('base64')
    expect(script).toBe(`Invoke-Item -LiteralPath ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')))`)
    expect(script).not.toContain('Write-Output')
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(target)
  })

  it.skipIf(process.platform !== 'linux')('rechecks the folder after WSL path translation and before PowerShell', async () => {
    const { project, outside } = fixture()
    const folder = join(project, 'folder')
    mkdirSync(folder)
    vi.stubEnv('WSL_DISTRO_NAME', 'test')
    launch.mockImplementationOnce(async () => {
      rmSync(folder, { recursive: true })
      symlinkSync(outside, folder, 'junction')
      return { stdout: "C:\\project folder\\O'Brien" }
    })
    await expect(revealFolderInExplorer(folder, [project])).rejects.toThrow()
    expect(launch).toHaveBeenCalledTimes(1)
  })
})
