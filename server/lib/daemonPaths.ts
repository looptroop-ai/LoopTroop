import { dirname, resolve } from 'node:path'
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs'
import { CONFIG_FILE_MODE, ensureSecureDir, resolveAppConfigDir, secureFile } from './appConfigDir'
import { safeAtomicWrite } from '../io/atomicWrite'
import { acquireDaemonLock, type AcquiredLock } from './daemonLock'

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
  /** Set before runtime shutdown starts; retained while a close retry is needed. */
  shutdownPending?: boolean
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
    /**
     * Which of the three non-mock outcomes this is.
     *
     * `owned` alone collapsed "someone else's server, running fine" and "ours,
     * dead, and we gave up restarting it" into the same record — so `status`
     * reported a healthy adopted server for a daemon that could not run a
     * single coding operation. Absent in a record written by an older build,
     * which is why every reader treats it as unknown rather than as `adopted`.
     */
    status?: 'adopted' | 'managed' | 'degraded'
    /** Why it is degraded, already written for a person. Never set otherwise. */
    detail?: string
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
export type DaemonStartFailure =
  | {
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
  | {
    /** Startup retained an owned OpenCode process that was not proven stopped. */
    reason: 'startup-cleanup-incomplete'
    /** ISO timestamp of the failed start. */
    at: string
    /** The build that started the cleanup. */
    version: string
    /** The operator message produced by the failed start. */
    message: string
    openCode: {
      baseUrl: string
      pid: number
      /** Absent when the platform could not provide process identity. */
      startToken?: string
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

/** Builds the daemon's HTTP origin, including brackets for IPv6 literals. */
export function daemonOrigin(host: string, port: number): string {
  const address = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host
  return `http://${address.includes(':') ? `[${address}]` : address}:${port}`
}

function isDaemonState(value: unknown): value is DaemonState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.instanceId === 'string'
    && typeof candidate.pid === 'number'
    && typeof candidate.port === 'number'
    && typeof candidate.apiToken === 'string'
    && (candidate.shutdownPending === undefined || typeof candidate.shutdownPending === 'boolean')
}

function isDaemonStartFailure(value: unknown): value is DaemonStartFailure {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.message !== 'string'
    || typeof candidate.at !== 'string'
    || typeof candidate.version !== 'string') return false

  if (candidate.reason === 'schema-incompatible') {
    const schema = candidate.schema
    if (typeof schema !== 'object' || schema === null) return false
    const details = schema as Record<string, unknown>
    return typeof details.databasePath === 'string'
      && typeof details.found === 'number'
      && typeof details.expected === 'number'
  }

  if (candidate.reason !== 'startup-cleanup-incomplete') return false
  const openCode = candidate.openCode
  if (typeof openCode !== 'object' || openCode === null) return false
  const owned = openCode as Record<string, unknown>
  return typeof owned.baseUrl === 'string'
    && typeof owned.pid === 'number'
    && (owned.startToken === undefined || typeof owned.startToken === 'string')
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
  // Dirname-relative writing is safe here: daemon.json is constant under trusted configDir.
  safeAtomicWrite(statePath, `${JSON.stringify(record, null, 2)}\n`)
  secureFile(statePath)
}

/**
 * Records the live daemon: its API token, port and instance id.
 *
 * Production callers hold `daemon.lock` for the whole publication window;
 * cleanup takes that same lock before deciding whether to remove this record.
 */
export function writeDaemonState(state: DaemonState, configDir?: string): void {
  writeDaemonRecord(state, configDir)
}

/**
 * Replaces whatever daemon.json held with the reason this start was refused.
 *
 * Written where the state file would have gone, because it answers the same
 * question — "what is LoopTroop doing?" — for the case where the answer is
 * nothing, and because a reader that finds it has by definition found no
 * running daemon. The daemon-start caller holds `daemon.lock` while publishing
 * it, just as it does for a live state record.
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
export function clearDaemonState(
  instanceId: string,
  configDir?: string,
  options: { confirmedShutdown?: boolean } = {},
): void {
  // Take the same lock used by every daemon state writer. The first read is a
  // cheap no-op for the common absent/successor case; the second read is the
  // decision made while this cleanup owns the lock, so a writer that won the
  // race cannot be deleted by the old generation.
  const beforeLock = readDaemonState(configDir)
  if (beforeLock?.instanceId !== instanceId) return
  if (beforeLock.shutdownPending && options.confirmedShutdown !== true) return

  let lock: AcquiredLock
  try {
    lock = acquireDaemonLock(configDir)
  } catch {
    // A live daemon owns the lock, or the lock cannot be judged. Either way,
    // refusing to remove state is safer than touching a record we cannot
    // serialize against.
    return
  }

  try {
    const current = readDaemonState(configDir)
    if (current?.instanceId !== instanceId) return
    if (current.shutdownPending && options.confirmedShutdown !== true) return
    rmSync(getDaemonStatePath(configDir), { force: true })
  } finally {
    lock.release()
  }
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
  const state = readDaemonState(configDir)
  if (!state) return
  // State is shared with a daemon writer. Route the stale cleanup through the
  // same lock and instance re-check as ordinary cleanup; an unconditional
  // rmSync here could delete a successor that published between the read and
  // the removal.
  clearDaemonState(state.instanceId, configDir)
}

/**
 * Removes one retained startup-cleanup record after its owned child is gone.
 *
 * The comparison is deliberately narrow: a later start failure must not be
 * deleted by a stop that is finishing an older generation. The same daemon
 * lock used by writers serializes the final re-read and removal.
 */
export function clearDaemonStartFailure(
  expected: DaemonStartFailure,
  configDir?: string,
): boolean {
  const matches = (current: DaemonStartFailure | null): boolean => {
    if (current === null || current.reason !== expected.reason || current.at !== expected.at) return false
    if (current.reason !== 'startup-cleanup-incomplete' || expected.reason !== 'startup-cleanup-incomplete') return false
    return current.openCode.baseUrl === expected.openCode.baseUrl
      && current.openCode.pid === expected.openCode.pid
      && current.openCode.startToken === expected.openCode.startToken
  }

  if (!matches(readDaemonStartFailure(configDir))) return false

  let lock: AcquiredLock
  try {
    lock = acquireDaemonLock(configDir)
  } catch {
    return false
  }

  try {
    if (!matches(readDaemonStartFailure(configDir))) return false
    rmSync(getDaemonStatePath(configDir), { force: true })
    return true
  } finally {
    lock.release()
  }
}
