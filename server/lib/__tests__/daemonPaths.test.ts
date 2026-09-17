import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../test/tempDir'
import { acquireDaemonLock } from '../daemonLock'
import {
  clearDaemonState,
  clearStaleDaemonState,
  daemonOrigin,
  getDaemonLockPath,
  getDaemonStatePath,
  readDaemonStartFailure,
  readDaemonState,
  writeDaemonStartFailure,
  writeDaemonState,
  type DaemonStartFailure,
  type DaemonState,
} from '../daemonPaths'

const readFileSyncMock = vi.hoisted(() => vi.fn())

/**
 * 2.16 contract: daemon.json answers "what is LoopTroop doing?" in both
 * directions. It either describes the running daemon or records why the last
 * start was refused, and a reader can always tell which without guessing.
 */
describe('daemon.json', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) removeTempDir(dir)
  })

  function makeConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-daemon-paths-'))
    tempDirs.push(dir)
    return dir
  }

  const state: DaemonState = {
    instanceId: 'instance-1',
    pid: 4242,
    port: 7788,
    host: '127.0.0.1',
    startedAt: '2026-01-01T00:00:00.000Z',
    version: '1.2.3',
    apiToken: 'token-value',
  }

  const failure: DaemonStartFailure = {
    reason: 'schema-incompatible',
    at: '2026-01-02T03:04:05.000Z',
    version: '1.2.3',
    message: 'The app database at /tmp/app.sqlite was created by a newer version of LoopTroop.',
    schema: {
      databaseLabel: 'app database',
      databasePath: '/tmp/app.sqlite',
      found: 9,
      expected: 1,
      migratableFrom: 1,
    },
  }

  it('round-trips a refusal with the numbers a later command needs', () => {
    const configDir = makeConfigDir()

    writeDaemonStartFailure(failure, configDir)

    // Not the message: a caller deciding whether to upgrade or move the file
    // aside must not have to parse prose that was written for a person.
    expect(readDaemonStartFailure(configDir)).toEqual(failure)
  })

  it('reports no running daemon when the file records a refusal', () => {
    const configDir = makeConfigDir()
    writeDaemonStartFailure(failure, configDir)

    // `status`, `stop` and `open` all key off this, so a refusal must never
    // read as a daemon they could try to talk to.
    expect(readDaemonState(configDir)).toBeNull()
  })

  it('reports no refusal when the file records a running daemon', () => {
    const configDir = makeConfigDir()
    writeDaemonState(state, configDir)

    expect(readDaemonStartFailure(configDir)).toBeNull()
    expect(readDaemonState(configDir)?.apiToken).toBe('token-value')
  })

  it('replaces a stale daemon record with the refusal', () => {
    const configDir = makeConfigDir()
    writeDaemonState(state, configDir)

    writeDaemonStartFailure(failure, configDir)

    expect(readDaemonState(configDir)).toBeNull()
    expect(readDaemonStartFailure(configDir)?.schema.found).toBe(9)
    // The token from the previous occupant must not survive in the file.
    expect(readFileSync(getDaemonStatePath(configDir), 'utf8')).not.toContain('token-value')
  })

  it('keeps a recorded refusal when stale state is cleared', () => {
    const configDir = makeConfigDir()
    writeDaemonStartFailure(failure, configDir)

    // `stop` is what someone runs right after a start that did not take.
    // Clearing debris there must not delete the only account of why.
    clearStaleDaemonState(configDir)

    expect(readDaemonStartFailure(configDir)).toEqual(failure)
  })

  it('clears only the instance that asked to be cleared', () => {
    const configDir = makeConfigDir()
    writeDaemonState({ ...state, instanceId: 'first' }, configDir)
    writeDaemonState({ ...state, instanceId: 'successor' }, configDir)

    clearDaemonState('first', configDir)

    expect(readDaemonState(configDir)?.instanceId).toBe('successor')
  })

  it('does not remove a successor published during the state read', async () => {
    const configDir = makeConfigDir()
    const statePath = getDaemonStatePath(configDir)
    writeDaemonState({ ...state, instanceId: 'old' }, configDir)
    const originalReadFileSync = readFileSync
    let published = false
    readFileSyncMock.mockImplementation((path: Parameters<typeof readFileSync>[0], options: Parameters<typeof readFileSync>[1]) => {
      const content = originalReadFileSync(path, options)
      if (!published && String(path) === statePath) {
        published = true
        writeDaemonState({ ...state, instanceId: 'successor' }, configDir)
      }
      return content
    })

    try {
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
        return { ...actual, readFileSync: readFileSyncMock }
      })
      vi.resetModules()
      const { clearDaemonState: clearWithMock } = await import('../daemonPaths')
      clearWithMock('old', configDir)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
      readFileSyncMock.mockReset()
    }

    expect(readDaemonState(configDir)?.instanceId).toBe('successor')
  })

  it('leaves state alone while a live daemon owns the lock', () => {
    const configDir = makeConfigDir()
    writeDaemonState({ ...state, instanceId: 'live' }, configDir)
    const lock = acquireDaemonLock(configDir)

    try {
      clearDaemonState('live', configDir)
      expect(readDaemonState(configDir)?.instanceId).toBe('live')
    } finally {
      lock.release()
    }
  })

  it('clears stale state after taking over a stale lock generation', () => {
    const configDir = makeConfigDir()
    writeDaemonState({ ...state, instanceId: 'stale' }, configDir)
    writeFileSync(getDaemonLockPath(configDir), JSON.stringify({
      nonce: 'dead-owner',
      pid: 2_147_483_647,
      host: hostname(),
      startedAt: '2026-01-01T00:00:00.000Z',
      heartbeatAt: '2026-01-01T00:00:00.000Z',
    }))

    clearDaemonState('stale', configDir)

    expect(readDaemonState(configDir)).toBeNull()
    expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
  })

  it('does not create a lock when there is no state to clear', () => {
    const configDir = makeConfigDir()

    clearDaemonState('missing', configDir)

    expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
  })

  it('clears state describing a daemon that is not running', () => {
    const configDir = makeConfigDir()
    writeDaemonState(state, configDir)

    clearStaleDaemonState(configDir)

    expect(readDaemonState(configDir)).toBeNull()
    expect(readDaemonStartFailure(configDir)).toBeNull()
  })

  it('keeps the file owner-only whichever record it carries', () => {
    const configDir = makeConfigDir()

    writeDaemonStartFailure(failure, configDir)

    // Windows has no POSIX mode bits; the ACL on the profile covers it there.
    if (process.platform !== 'win32') {
      expect(statSync(getDaemonStatePath(configDir)).mode & 0o777).toBe(0o600)
    }
  })

  it('ignores a record it cannot make sense of', () => {
    const configDir = makeConfigDir()
    writeDaemonState(state, configDir)

    for (const content of ['not json', '{}', '{"startFailure":{"reason":"other"}}']) {
      writeFileSync(getDaemonStatePath(configDir), content)
      // Half a record is worse than none: reporting a refusal with missing
      // numbers would send someone after a database no one named.
      expect(readDaemonState(configDir)).toBeNull()
      expect(readDaemonStartFailure(configDir)).toBeNull()
    }
  })
})

describe('daemon origin', () => {
  it('brackets bare and already-bracketed IPv6 hosts', () => {
    expect(daemonOrigin('::1', 3000)).toBe('http://[::1]:3000')
    expect(daemonOrigin('[::1]', 3000)).toBe('http://[::1]:3000')
    expect(daemonOrigin('127.0.0.1', 3000)).toBe('http://127.0.0.1:3000')
  })
})
