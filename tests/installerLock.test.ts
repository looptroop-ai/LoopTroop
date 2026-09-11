import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withInstallLock } from '../scripts/installer-core.mjs'
import { removeTempDir } from '../server/test/tempDir'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) removeTempDir(dir)
})

function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'looptroop-install-lock-'))
  dirs.push(dir)
  return dir
}

function oldLock(dir: string, owner = `${process.pid}-live-owner`) {
  const lock = join(dir, '.install.lock')
  writeFileSync(lock, `${owner} timestamp\n`)
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
  utimesSync(lock, old, old)
  return lock
}

describe('installer lock ownership and recovery', () => {
  it('keeps an old lock owned by a live process and never runs the action', () => {
    const dir = directory()
    const lock = oldLock(dir)
    const before = readFileSync(lock, 'utf8')
    const action = vi.fn()
    expect(() => withInstallLock(dir, action)).toThrow('Another install is already running')
    expect(action).not.toHaveBeenCalled()
    expect(readFileSync(lock, 'utf8')).toBe(before)
    expect(existsSync(`${lock}.claim`)).toBe(false)
  })

  it.each(['EPERM', 'EACCES', 'UNKNOWN'])('keeps an old lock when checking its owner fails with %s', (code) => {
    const dir = directory()
    const lock = oldLock(dir)
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(code), { code }) })
    expect(() => withInstallLock(dir, () => undefined)).toThrow('owner cannot be checked')
    expect(existsSync(lock)).toBe(true)
  })

  it('keeps a malformed old lock whose owner cannot be established', () => {
    const dir = directory()
    const lock = oldLock(dir, 'missing-owner')
    const kill = vi.spyOn(process, 'kill')
    expect(() => withInstallLock(dir, () => undefined)).toThrow('owner cannot be checked')
    expect(kill).not.toHaveBeenCalled()
    expect(existsSync(lock)).toBe(true)
  })

  it('serializes recovery, then protects the new owner through the entire action', () => {
    const dir = directory()
    const lock = oldLock(dir, '999999-dead-owner')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      expect(() => withInstallLock(dir, () => { throw new Error('overlap') })).toThrow('acquiring or recovering')
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    expect(withInstallLock(dir, () => {
      expect(existsSync(`${lock}.claim`)).toBe(false)
      expect(readFileSync(lock, 'utf8')).toMatch(new RegExp(`^${process.pid}-`))
      expect(() => withInstallLock(dir, () => { throw new Error('overlap') })).toThrow('Another install is already running')
      return 'installed'
    })).toBe('installed')
    expect(existsSync(lock)).toBe(false)
    expect(existsSync(`${lock}.claim`)).toBe(false)
  })

  it('leaves an abandoned recovery claim for manual cleanup even when old', () => {
    const dir = directory()
    const lock = oldLock(dir, '999999-dead-owner')
    const claim = `${lock}.claim`
    writeFileSync(claim, 'abandoned')
    const old = new Date(0)
    utimesSync(claim, old, old)
    expect(() => withInstallLock(dir, () => undefined)).toThrow('acquiring or recovering')
    expect(readFileSync(claim, 'utf8')).toBe('abandoned')
    expect(existsSync(lock)).toBe(true)
  })

  it('releases its lock when the action throws', () => {
    const dir = directory()
    expect(() => withInstallLock(dir, () => { throw new Error('install failed') })).toThrow('install failed')
    expect(existsSync(join(dir, '.install.lock'))).toBe(false)
    expect(existsSync(join(dir, '.install.lock.claim'))).toBe(false)
  })
})
