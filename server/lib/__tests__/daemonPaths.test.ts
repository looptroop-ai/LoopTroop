import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../test/tempDir'
import {
  clearStaleDaemonState,
  getDaemonStatePath,
  readDaemonStartFailure,
  readDaemonState,
  writeDaemonStartFailure,
  writeDaemonState,
  type DaemonStartFailure,
  type DaemonState,
} from '../daemonPaths'

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
