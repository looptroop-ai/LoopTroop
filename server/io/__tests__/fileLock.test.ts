import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileLockTimeoutError, withFileLock } from '../fileLock'

const roots: string[] = []

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'looptroop-lock-test-'))
  roots.push(dir)
  return join(dir, 'index.json.lock')
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('withFileLock', () => {
  it('runs the section and removes the lock afterwards', async () => {
    const path = lockPath()
    expect(await withFileLock(path, () => 'done')).toBe('done')
    expect(existsSync(path)).toBe(false)
  })

  it('removes the lock when the section throws', async () => {
    const path = lockPath()
    await expect(withFileLock(path, () => { throw new Error('inner') })).rejects.toThrow('inner')
    expect(existsSync(path)).toBe(false)
  })

  it('serialises overlapping sections rather than interleaving them', async () => {
    const path = lockPath()
    const events: string[] = []
    const section = async (id: string) => withFileLock(path, async () => {
      events.push(`${id}:enter`)
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      events.push(`${id}:exit`)
    }, { retryMs: 5 })

    await Promise.all([section('a'), section('b')])

    // Whichever ran first, neither entered while the other was inside.
    expect(events).toHaveLength(4)
    expect(events[1]).toBe(`${events[0]!.split(':')[0]}:exit`)
    expect(events[3]).toBe(`${events[2]!.split(':')[0]}:exit`)
  })

  it('gives up rather than waiting forever on a live holder', async () => {
    const path = lockPath()
    writeFileSync(path, '{}')
    await expect(withFileLock(path, () => 'never', { timeoutMs: 60, retryMs: 10 }))
      .rejects.toBeInstanceOf(FileLockTimeoutError)
  })

  it('reclaims a lock left behind by a process that died holding it', async () => {
    const path = lockPath()
    writeFileSync(path, '{}')
    const longAgo = new Date(Date.now() - 120_000)
    utimesSync(path, longAgo, longAgo)
    expect(await withFileLock(path, () => 'reclaimed', { staleMs: 1_000, timeoutMs: 500, retryMs: 5 }))
      .toBe('reclaimed')
  })

  it('creates the lock directory when it does not exist yet', async () => {
    const path = join(lockPath(), '..', 'nested', 'deeper', 'index.json.lock')
    expect(await withFileLock(path, () => 'ok')).toBe('ok')
  })
})
