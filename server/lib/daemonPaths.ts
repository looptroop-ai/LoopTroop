import { dirname, resolve } from 'node:path'
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs'
import { CONFIG_FILE_MODE, ensureSecureDir, resolveAppConfigDir, secureFile } from './appConfigDir'
import { safeAtomicWrite } from '../io/atomicWrite'

/**
 * Informational record of the running daemon. Never the locking primitive:
 * exclusive ownership belongs to daemon.lock, which is created with 'wx'.
 */
export interface DaemonState {
  /** Distinguishes this run from a recycled pid. */
  instanceId: string
  pid: number
  port: number
  host: string
  startedAt: string
  version: string
  /**
   * Identifies the process that held `pid` when this record was written.
   *
   * `instanceId` is the stronger check, but it only answers while the daemon is
   * still serving: it comes back over HTTP. `stop` escalates over tens of
   * seconds, and the daemon stops answering partway through by design — this is
   * what says whether the pid it is about to signal is still that daemon.
   * Opaque, and safe to print. Absent when the platform could not say, which
   * reads as "do not signal this pid".
   */
  startToken?: string
  /**
   * Bearer token for talking to this daemon. It lives here because the CLI has
   * no other way to reach a daemon it did not spawn, and the file is written
   * owner-only for exactly that reason. Never print it: `status --json` and the
   * daemon log both redact it.
   */
  apiToken: string
  opencode?: {
    baseUrl: string
    /** Only a daemon-started server may be stopped by the daemon. */
    owned: boolean
    pid?: number
    /**
     * Identifies the process that held `pid` when this record was written, so a
     * later `clean` can tell the orphaned server from whatever inherited the
     * number after it exited. Opaque, and safe to print. Absent when the
     * platform could not say, which reads as "do not signal this pid".
     */
    startToken?: string
  }
}

/** The same record with the token removed, for anything user-facing. */
export type RedactedDaemonState = Omit<DaemonState, 'apiToken'>

export function redactDaemonState(state: DaemonState): RedactedDaemonState {
  const { apiToken: _apiToken, ...rest } = state
  return rest
}

/**
 * Why the last start was refused, kept after the process that hit it is gone.
 *
 * A daemon that cannot open its database exits, and everything it knew exits
 * with it: the user is left with a command that returned non-zero and a log
 * file they were not told to read. Recording the refusal lets `status` and
 * `doctor` answer the question afterwards, with the numbers rather than prose.
 *
 * Only a schema incompatibility is recorded. It is a fixed, machine-checkable
 * shape with nothing sensitive in it — unlike an arbitrary start error, whose
 * message could carry anything the code below it chose to put there.
 */
export interface DaemonStartFailure {
  reason: 'schema-incompatible'
  /** ISO timestamp of the refused start. */
  at: string
  /** The build that refused it, which is half of the version mismatch. */
  version: string
  /** The operator message the guard produced, already written for a person. */
  message: string
  schema: {
    databaseLabel: string
    databasePath: string
    found: number
    expected: number
    migratableFrom: number
  }
}

/** What daemon.json holds: a live daemon, or the reason there is not one. */
type DaemonRecord = DaemonState | { startFailure: DaemonStartFailure }

export function getDaemonStatePath(configDir = resolveAppConfigDir()): string {
  return resolve(configDir, 'daemon.json')
}

export function getDaemonLockPath(configDir = resolveAppConfigDir()): string {
  return resolve(configDir, 'daemon.lock')
}

export function getDaemonLogDir(configDir = resolveAppConfigDir()): string {
  return resolve(configDir, 'logs')
}

export function getDaemonLogPath(configDir = resolveAppConfigDir()): string {
  return resolve(getDaemonLogDir(configDir), 'daemon.log')
}

function isDaemonState(value: unknown): value is DaemonState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.instanceId === 'string'
    && typeof candidate.pid === 'number'
    && typeof candidate.port === 'number'
    && typeof candidate.apiToken === 'string'
}

function isDaemonStartFailure(value: unknown): value is DaemonStartFailure {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (candidate.reason !== 'schema-incompatible') return false
  if (typeof candidate.message !== 'string') return false
  const schema = candidate.schema
  if (typeof schema !== 'object' || schema === null) return false
  const details = schema as Record<string, unknown>
  return typeof details.databasePath === 'string'
    && typeof details.found === 'number'
    && typeof details.expected === 'number'
}

function readDaemonRecord(configDir?: string): DaemonRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8'))
  } catch {
    return null
  }

  if (isDaemonState(parsed)) return parsed
  const failure = (parsed as { startFailure?: unknown } | null)?.startFailure
  return isDaemonStartFailure(failure) ? { startFailure: failure } : null
}

/**
 * Writes daemon.json owner-only, whatever it is carrying.
 *
 * The atomic write inherits the mode of an existing target, so the file is
 * created owner-only first. Without this the API token would sit in a
 * world-readable file for the moment between rename and chmod.
 */
function writeDaemonRecord(record: DaemonRecord, configDir?: string): void {
  const statePath = getDaemonStatePath(configDir)
  ensureSecureDir(dirname(statePath))
  if (!existsSync(statePath)) {
    closeSync(openSync(statePath, 'a', CONFIG_FILE_MODE))
    secureFile(statePath)
  }
  safeAtomicWrite(statePath, `${JSON.stringify(record, null, 2)}\n`)
  secureFile(statePath)
}

/** Records the live daemon: its API token, port and instance id. */
export function writeDaemonState(state: DaemonState, configDir?: string): void {
  writeDaemonRecord(state, configDir)
}

/**
 * Replaces whatever daemon.json held with the reason this start was refused.
 *
 * Written where the state file would have gone, because it answers the same
 * question — "what is LoopTroop doing?" — for the case where the answer is
 * nothing, and because a reader that finds it has by definition found no
 * running daemon.
 */
export function writeDaemonStartFailure(failure: DaemonStartFailure, configDir?: string): void {
  writeDaemonRecord({ startFailure: failure }, configDir)
}

/** Returns null for every failure mode: absent, unreadable, or malformed. */
export function readDaemonState(configDir?: string): DaemonState | null {
  const record = readDaemonRecord(configDir)
  return record !== null && isDaemonState(record) ? record : null
}

export function readDaemonStartFailure(configDir?: string): DaemonStartFailure | null {
  const record = readDaemonRecord(configDir)
  return record !== null && !isDaemonState(record) ? record.startFailure : null
}

/**
 * Removes a state file left behind by a daemon that was killed before it could
 * clean up. Matched on the instance id so a state file written by a daemon that
 * started in the meantime is left alone.
 */
export function clearDaemonState(instanceId: string, configDir?: string): void {
  if (readDaemonState(configDir)?.instanceId !== instanceId) return
  rmSync(getDaemonStatePath(configDir), { force: true })
}

/**
 * Clears a state file describing a daemon that is not running, so the next
 * start is not misled by it.
 *
 * A recorded start failure is kept: it is the only account of why there is no
 * daemon, and `stop` is exactly the command someone reaches for after a start
 * that did not take — deleting the diagnosis at that moment would leave them
 * with nothing to read.
 */
export function clearStaleDaemonState(configDir?: string): void {
  if (readDaemonStartFailure(configDir) !== null) return
  rmSync(getDaemonStatePath(configDir), { force: true })
}
