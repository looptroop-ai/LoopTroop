import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { FileLockTimeoutError, withFileLock } from '../fileLock'

type LockHolder = ChildProcessByStdio<null, Readable, Readable>

const roots: string[] = []

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'looptroop-lock-test-'))
  roots.push(dir)
  return join(dir, 'index.json.lock')
}

function startLockHolder(path: string): LockHolder {
  const script = [
    "import { DatabaseSync } from 'node:sqlite'",
    "const database = new DatabaseSync(process.argv[1], { timeout: 0 })",
    "database.exec('BEGIN IMMEDIATE')",
    "process.stdout.write('ready')",
    'setInterval(() => {}, 1000)',
  ].join('\n')
  return spawn(process.execPath, ['--input-type=module', '-e', script, path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function waitForExit(child: LockHolder): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => { child.once('exit', () => resolve()) })
}

async function waitForReady(child: LockHolder): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      if (!chunk.toString().includes('ready')) return
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(`lock holder exited before acquiring (${code ?? signal ?? 'unknown'})`))
    }
    const cleanup = () => {
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function stopLockHolder(child: LockHolder, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.exitCode === null) child.kill(signal)
  await waitForExit(child)
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('withFileLock', () => {
  it('runs the section and keeps a reusable SQLite lock database', async () => {
    const path = lockPath()
    expect(await withFileLock(path, () => 'done')).toBe('done')
    expect(existsSync(path)).toBe(true)

    const database = new DatabaseSync(path)
    database.exec('BEGIN IMMEDIATE')
    database.exec('ROLLBACK')
    database.close()
  })

  it('rolls back and releases the connection when the section throws', async () => {
    const path = lockPath()
    await expect(withFileLock(path, () => { throw new Error('inner') })).rejects.toThrow('inner')
    await expect(withFileLock(path, () => 'after error')).resolves.toBe('after error')
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

    expect(events).toHaveLength(4)
    expect(events[1]).toBe(`${events[0]!.split(':')[0]}:exit`)
    expect(events[3]).toBe(`${events[2]!.split(':')[0]}:exit`)
  })

  it.runIf(process.platform !== 'win32')('does not enter while another process holds the transaction', async () => {
    const path = lockPath()
    const holder = startLockHolder(path)
    try {
      await waitForReady(holder)
      let entered = false
      const started = Date.now()
      const timer = new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve()
        }, 10)
      })
      const attempt = withFileLock(path, () => {
        entered = true
      }, { timeoutMs: 80, retryMs: 5 })
      await expect(Promise.race([
        timer.then(() => 'timer'),
        attempt.then(() => 'acquired', () => 'timed out'),
      ])).resolves.toBe('timer')
      expect(Date.now() - started).toBeLessThan(60)
      await expect(attempt).rejects.toBeInstanceOf(FileLockTimeoutError)
      await timer
      expect(entered).toBe(false)
    } finally {
      await stopLockHolder(holder)
    }
  })

  it.runIf(process.platform !== 'win32')('releases the transaction after the holder process dies', async () => {
    const path = lockPath()
    const holder = startLockHolder(path)
    try {
      await waitForReady(holder)
      await stopLockHolder(holder, 'SIGKILL')
      await expect(withFileLock(path, () => 'recovered', { timeoutMs: 500, retryMs: 5 }))
        .resolves.toBe('recovered')
    } finally {
      await stopLockHolder(holder)
    }
  })

  it.runIf(process.platform !== 'win32')('gives up rather than waiting forever on a live holder', async () => {
    const path = lockPath()
    const holder = startLockHolder(path)
    try {
      await waitForReady(holder)
      await expect(withFileLock(path, () => 'never', { timeoutMs: 60, retryMs: 10 }))
        .rejects.toBeInstanceOf(FileLockTimeoutError)
    } finally {
      await stopLockHolder(holder)
    }
  })

  it('creates parent directories for the lock database', async () => {
    const path = join(lockPath(), '..', 'nested', 'deeper', 'index.json.lock')
    expect(await withFileLock(path, () => 'ok')).toBe('ok')
    expect(existsSync(path)).toBe(true)
  })
})
