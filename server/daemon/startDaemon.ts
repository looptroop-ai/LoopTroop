import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { createRuntime, type LoopTroopRuntime } from '../createRuntime'
import { IncompatibleSchemaVersionError } from '../db/schemaVersion'
import { acquireDaemonLock, type AcquiredLock } from '../lib/daemonLock'
import {
  clearDaemonState,
  daemonBrowserOrigin,
  getDaemonStatePath,
  writeDaemonStartFailure,
  writeDaemonState,
  type DaemonStartFailure,
  type DaemonState,
  readDaemonState,
  readDaemonStartFailure,
} from '../lib/daemonPaths'
import { assertPublicOriginRemoteAccess, resolveSettings, type ResolvedSettings } from '../lib/appSettings'
import { isProcessAlive } from '../cli/processControl'
import { matchProcess, readProcessStartToken } from '../lib/processIdentity'
import { createSessionCredentials, BootstrapNonceStore, type SessionCredentials } from '../middleware/sessionAuth'
import { OpenCodeSupervisor, type OpenCodeStatus } from '../opencode/supervisor'
import { resetOpenCodeAdapterTransport } from '../opencode/factory'
import { getErrorMessage } from '@shared/typeGuards'

/** Keeps the lock's heartbeat ahead of the staleness window. */
const HEARTBEAT_INTERVAL_MS = 15_000
const SHUTDOWN_RETRY_DELAY_MS = 500
const SHUTDOWN_RETRY_MAX_DELAY_MS = 10_000

export interface DaemonHandle {
  state: DaemonState
  credentials: SessionCredentials
  /** Mints the single-use nonces a browser exchanges for a session cookie. */
  bootstrapNonces: BootstrapNonceStore
  /**
   * One-time URL that exchanges a bootstrap nonce for a browser session.
   *
   * Reading it mints a nonce, so it must be handed to a person rather than
   * written anywhere durable — the daemon log is a file that outlives the run.
   */
  bootstrapUrl(): string
  /**
   * Registers a listener for "something asked this daemon to exit" — a signal,
   * or an authenticated call to the shutdown endpoint. The daemon process turns
   * that into a real exit; an embedder decides for itself.
   */
  onShutdownRequest(listener: (reason: string) => void): void
  stop(): Promise<void>
}

/** Shutdown could not prove that an owned OpenCode tree has gone away. */
export class DaemonShutdownIncompleteError extends Error {
  constructor() {
    super('Daemon shutdown is incomplete: the owned OpenCode process may still be running; retry shutdown before releasing the daemon lock.')
    this.name = 'DaemonShutdownIncompleteError'
  }
}

/** A previous start retained an owned OpenCode process for an explicit retry. */
export class DaemonStartBlockedError extends Error {
  constructor(readonly failure: Extract<DaemonStartFailure, { reason: 'startup-cleanup-incomplete' }>) {
    super(
      `LoopTroop cannot start while its previous startup still owns OpenCode at ${failure.openCode.baseUrl} `
      + `(pid ${failure.openCode.pid}). Run \`looptroop stop\` and retry the start.`,
    )
    this.name = 'DaemonStartBlockedError'
  }
}

/** A prior runtime close retained ownership for an explicit retry. */
export class DaemonShutdownPendingError extends Error {
  constructor(readonly state: DaemonState) {
    super(
      `LoopTroop cannot start while its previous daemon shutdown is incomplete `
      + `(pid ${state.pid}). Run \`looptroop stop\` and retry the start.`,
    )
    this.name = 'DaemonShutdownPendingError'
  }
}

export interface StartDaemonOptions {
  configDir?: string
  settings?: ResolvedSettings
  version: string
  /** Reported to the parent once the daemon is genuinely serving requests. */
  onReady?: (state: DaemonState) => void
  /** Include full DEBUG output from an OpenCode server this daemon starts. */
  opencodeLogs?: 'all'
}

/**
 * The record daemon.json should hold after OpenCode changes status, or null when
 * it must be left exactly as it is.
 *
 * Separate from the write so the decision can be tested without a real
 * `opencode serve` to crash. Two cases must not write, and both are the kind
 * that only shows up under a race: there is no record yet to patch, and the
 * daemon is already shutting down — where a refresh would recreate the file
 * `stop` had just removed, leaving the next start to trust a dead daemon.
 */
export function nextStateForOpenCode(
  current: DaemonState | null,
  status: OpenCodeStatus,
  baseUrl: string,
  options: { released: boolean },
): DaemonState | null {
  if (current === null || options.released) return null

  const opencode = describeOpenCode(status, baseUrl)
  // Mock mode has no server to describe, and nothing about it can change.
  if (opencode === undefined) return null

  return { ...current, opencode }
}

/**
 * Turns a refused start into a record worth keeping, or into nothing.
 *
 * Most things that stop a start are transient and already reported while the
 * user is watching: a bound port frees up, a missing OpenCode gets installed,
 * and a note about either would be a lie by the time anyone read it back. A
 * database this build cannot open is different — it refuses the same file every
 * time, and the process that discovered it is gone before the question is
 * asked. Only that one is written down.
 */
export function describeStartFailure(
  error: unknown,
  context: { version: string, at: string },
): DaemonStartFailure | null {
  if (!(error instanceof IncompatibleSchemaVersionError)) return null

  return {
    reason: 'schema-incompatible',
    at: context.at,
    version: context.version,
    message: error.message,
    schema: {
      databaseLabel: error.databaseLabel,
      databasePath: error.databasePath,
      found: error.found,
      expected: error.expected,
      migratableFrom: error.migratableFrom,
    },
  }
}

/**
 * Leaves daemon.json describing the truth: either why this start was refused,
 * or nothing at all. Recording is best effort, because the start failure is the
 * error worth reporting and must not be replaced by a failure to write it down.
 */
function recordStartFailure(
  error: unknown,
  version: string,
  configDir?: string,
  retainedOpenCode?: { baseUrl: string; pid: number; startToken: string | null },
): void {
  // Retained process ownership is stronger than the original startup error:
  // never replace recovery evidence with a schema diagnosis that cannot name
  // the still-live child.
  if (retainedOpenCode !== undefined) {
    try {
      writeDaemonStartFailure({
        reason: 'startup-cleanup-incomplete',
        at: new Date().toISOString(),
        version,
        message: getErrorMessage(error),
        openCode: {
          baseUrl: retainedOpenCode.baseUrl,
          pid: retainedOpenCode.pid,
          ...(retainedOpenCode.startToken === null ? {} : { startToken: retainedOpenCode.startToken }),
        },
      }, configDir)
      return
    } catch {
      // Never clear an existing state or failure record when the recovery
      // witness could not be persisted. The child is still ours to account for;
      // the original startup error remains the only safe thing to surface.
      console.error('[daemon] Could not persist retained OpenCode startup ownership; leaving existing state untouched.')
      return
    }
  }

  const failure = describeStartFailure(error, { version, at: new Date().toISOString() })
  if (failure) {
    try {
      writeDaemonStartFailure(failure, configDir)
      return
    } catch {
      // Fall through and clear the file rather than leave a partial record.
    }
  }
  rmSync(getDaemonStatePath(configDir), { force: true })
}

/**
 * What the state file should say about OpenCode, or nothing at all in mock mode
 * where there is no server to describe.
 *
 * A managed server is recorded with a start-identity token as well as its pid,
 * because this daemon can be killed outright — and when it is, it takes no
 * cleanup with it and OpenCode is left running in its own process group. The
 * token is what lets a later `clean` reap that orphan without ever signalling an
 * unrelated process that happened to inherit the number.
 *
 * A degraded server is recorded as itself rather than folded in with an adopted
 * one. Both are "not ours to stop", but only one of them means coding
 * operations are unavailable, and a reader that cannot tell them apart reports
 * a healthy server for a daemon that has given up.
 */
export function describeOpenCode(
  status: OpenCodeStatus,
  baseUrl: string,
): DaemonState['opencode'] {
  if (status.kind === 'mock') return undefined
  if (status.kind === 'degraded') {
    return { baseUrl, owned: false, status: 'degraded', detail: status.reason }
  }
  if (status.kind === 'adopted') return { baseUrl, owned: false, status: 'adopted' }

  const startToken = readProcessStartToken(status.pid)
  return {
    baseUrl,
    owned: true,
    status: 'managed',
    pid: status.pid,
    ...(startToken === null ? {} : { startToken }),
  }
}

/**
 * Brings up the daemon in the order a supervisor can trust: the lock is taken
 * before any port is bound, and state is durable before ready is reported. A
 * normal failure unwinds everything that already succeeded. If an owned
 * OpenCode child cannot be proven stopped, startup leaves durable ownership
 * evidence instead of allowing a later run to adopt that child.
 */
export async function startDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
  const settings = options.settings ?? resolveSettings({ configDir: options.configDir })
  assertPublicOriginRemoteAccess(settings.publicOrigin)

  // A previous startup may have exited while its owned OpenCode child was
  // still live. Keep that durable ownership boundary ahead of lock recovery:
  // reclaiming the stale daemon lock alone would let a new daemon adopt the
  // old server and strand it outside any supervisor.
  const blockedStart = readDaemonStartFailure(options.configDir)
  if (blockedStart?.reason === 'startup-cleanup-incomplete') {
    throw new DaemonStartBlockedError(blockedStart)
  }
  const pendingShutdown = readDaemonState(options.configDir)
  if (pendingShutdown?.shutdownPending) {
    throw new DaemonShutdownPendingError(pendingShutdown)
  }

  // First, so a second daemon is refused before it can bind a port or touch
  // the database that the running one owns.
  const lock: AcquiredLock = acquireDaemonLock(options.configDir)

  // Recheck while this generation owns the lock. Another failed startup may
  // have published its retained child after the cheap pre-lock read above;
  // releasing our provisional lock here prevents us from starting alongside
  // that durable owner.
  const blockedAfterLock = readDaemonStartFailure(options.configDir)
  if (blockedAfterLock?.reason === 'startup-cleanup-incomplete') {
    lock.release()
    throw new DaemonStartBlockedError(blockedAfterLock)
  }
  const pendingShutdownAfterLock = readDaemonState(options.configDir)
  if (pendingShutdownAfterLock?.shutdownPending) {
    lock.release()
    throw new DaemonShutdownPendingError(pendingShutdownAfterLock)
  }

  // A dead daemon may have left its owned OpenCode child behind. Reconcile the
  // old record before the new supervisor can adopt that child and lose the
  // only identity-safe route to clean it up.
  const previousState = readDaemonState(options.configDir)
  if (previousState !== null) {
    if (isProcessAlive(previousState.pid)) {
      const daemonIdentity = matchProcess(previousState.pid, previousState.startToken)
      if (daemonIdentity.kind !== 'different') {
        lock.release()
        const detail = daemonIdentity.kind === 'same'
          ? 'the previous daemon is still running'
          : `its process identity cannot be verified because ${daemonIdentity.reason}`
        throw new Error(
          `LoopTroop cannot safely replace its previous daemon record (pid ${previousState.pid}; ${detail}). ` +
          'The record was preserved. Run `looptroop stop` or `looptroop doctor` before retrying.',
        )
      }
    }

    const previousOpenCode = previousState.opencode
    if (previousOpenCode?.owned) {
      if (previousOpenCode.pid === undefined) {
        lock.release()
        throw new Error(
          'LoopTroop cannot safely replace its previous daemon record because its owned OpenCode server has no recorded pid. ' +
          'The record was preserved; inspect it with `looptroop doctor` before retrying.',
        )
      }

      if (isProcessAlive(previousOpenCode.pid)) {
        const childIdentity = matchProcess(previousOpenCode.pid, previousOpenCode.startToken)
        if (childIdentity.kind === 'unknown') {
          lock.release()
          throw new Error(
            `LoopTroop cannot safely replace its previous daemon record because OpenCode pid ${previousOpenCode.pid} ` +
            `is alive but ${childIdentity.reason}. The record was preserved and nothing was signalled; ` +
            'run `looptroop doctor` to inspect it before retrying.',
          )
        }

        if (childIdentity.kind === 'same') {
          const failure: Extract<DaemonStartFailure, { reason: 'startup-cleanup-incomplete' }> = {
            reason: 'startup-cleanup-incomplete',
            at: new Date().toISOString(),
            version: options.version,
            message: 'The previous daemon ended while its owned OpenCode server was still running.',
            openCode: {
              baseUrl: previousOpenCode.baseUrl,
              pid: previousOpenCode.pid,
              ...(previousOpenCode.startToken === undefined ? {} : { startToken: previousOpenCode.startToken }),
            },
          }
          try {
            writeDaemonStartFailure(failure, options.configDir)
          } catch (error) {
            lock.release()
            throw new Error(
              `LoopTroop found its previous owned OpenCode server (pid ${previousOpenCode.pid}) but could not save its cleanup record: ` +
              `${getErrorMessage(error)}. The previous daemon record was left untouched; run ` +
              '`looptroop doctor` to inspect it before retrying.',
            )
          }
          lock.release()
          throw new DaemonStartBlockedError(failure)
        }
      }
    }
  }

  let runtime: LoopTroopRuntime | null = null
  let heartbeat: NodeJS.Timeout | null = null
  let opencode: OpenCodeSupervisor | null = null
  const credentials = createSessionCredentials()
  const bootstrapNonces = new BootstrapNonceStore()
  // Minted before the app is built so /api/health can report it, which is what
  // lets a client tell this daemon from a process that inherited its pid.
  const instanceId = randomUUID()

  // The record the state file currently holds, so an OpenCode status change can
  // be folded into it rather than rebuilt from scratch. Null until it is written.
  let recordedState: DaemonState | null = null
  // Set the moment shutdown begins: a late refresh would recreate daemon.json
  // for a daemon that is no longer there, and the next start would trust it.
  let stateFileReleased = false

  /**
   * Keeps daemon.json honest about OpenCode for as long as the daemon runs.
   *
   * Written once at startup, the record describes the server that was running
   * then. A crash-and-restart moves the server to a new pid, and the old one is
   * what `clean` would go looking for — a pid that is dead, or worse, reused.
   * Giving up entirely is the other case, where the file kept claiming a
   * reachable server for a daemon that could not run a single coding operation.
   */
  const recordOpenCodeStatus = (status: OpenCodeStatus): void => {
    // A managed restart may launch a different CLI protocol. Drop only the
    // cached transport so in-flight calls retain theirs and later calls can
    // resolve the now-ready server again.
    if (status.kind === 'managed') resetOpenCodeAdapterTransport()
    const next = nextStateForOpenCode(recordedState, status, settings.opencodeBaseUrl, {
      released: stateFileReleased,
    })
    if (next === null) return

    try {
      writeDaemonState(next, options.configDir)
      recordedState = next
    } catch {
      // Best effort: the daemon is still serving, and a refresh that failed
      // must not take it down. The record stays stale, which every reader of
      // it already has to tolerate — `clean` verifies identity before signalling.
    }
  }

  const shutdownListeners = new Set<(reason: string) => void>()
  // Assigned once `stop` exists below. A shutdown requested before then can only
  // come from a caller that has not been told the daemon is ready yet.
  let stopRuntime: () => Promise<void> = async () => undefined
  const requestShutdown = (reason: string): void => {
    // With no listener there is no process to exit — an embedder gets its
    // runtime closed rather than a request that silently does nothing.
    if (shutdownListeners.size === 0) {
      void stopRuntime().catch((error: unknown) => {
        console.error(`[daemon] Shutdown failed: ${getErrorMessage(error)}`)
      })
      return
    }
    for (const listener of shutdownListeners) listener(reason)
  }

  try {
    // Before the server binds: a missing OpenCode is fatal, and failing here
    // avoids a half-started daemon that cannot do any work.
    opencode = new OpenCodeSupervisor({
      baseUrl: settings.opencodeBaseUrl,
      mock: settings.opencodeMode === 'mock',
      printLogs: options.opencodeLogs === 'all',
      onStatusChange: recordOpenCodeStatus,
    })
    const opencodeStatus = await opencode.start()

    runtime = createRuntime({
      settings,
      mode: 'production',
      credentials,
      bootstrapNonces,
      instanceId,
      publicOrigin: settings.publicOrigin,
      onShutdownRequest: () => requestShutdown('an API request'),
    })
    const address = await runtime.start()

    const opencodeState = describeOpenCode(opencodeStatus, settings.opencodeBaseUrl)
    // Recorded so `stop` can tell this process from whatever inherits its pid
    // once it stops answering /api/health partway through its own shutdown.
    const startToken = readProcessStartToken(process.pid)
    const state: DaemonState = {
      instanceId,
      pid: process.pid,
      port: address.port,
      host: address.hostname,
      ...(settings.publicOrigin === null ? {} : { publicOrigin: settings.publicOrigin }),
      startedAt: new Date().toISOString(),
      version: options.version,
      ...(startToken === null ? {} : { startToken }),
      // Persisted so `stop`, `open` and `doctor` can authenticate against a
      // daemon they did not start. The file is owner-only.
      apiToken: credentials.apiToken,
      ...(opencodeState === undefined ? {} : { opencode: opencodeState }),
    }

    writeDaemonState(state, options.configDir)
    // After the write, so a status change arriving from here on patches a record
    // that exists rather than inventing one.
    recordedState = state

    // The nonce travels in the fragment so it is never sent to the server as
    // part of the request line, and so it stays out of access logs. A fresh one
    // is minted per call: a nonce is single-use and expires, so a URL captured
    // once cannot be replayed or reused later.
    const bootstrapUrl = (): string =>
      `${daemonBrowserOrigin({ ...state, host: address.hostname, port: address.port })}/#bootstrap=${bootstrapNonces.issue()}`

    heartbeat = setInterval(() => lock.heartbeat(), HEARTBEAT_INTERVAL_MS)
    // The daemon's own timer must not be the reason the process stays alive.
    heartbeat.unref()

    options.onReady?.(state)

    let stopping: Promise<void> | null = null
    const markShutdownPending = (): void => {
      if (recordedState === null || recordedState.shutdownPending) return
      const pending = { ...recordedState, shutdownPending: true }
      try {
        writeDaemonState(pending, options.configDir)
        recordedState = pending
      } catch (error) {
        // Do not close the runtime without first publishing the retry guard:
        // once the listener closes, the CLI must know not to force-kill this
        // generation when runtime cleanup is still unresolved.
        throw new Error(`Could not record pending daemon shutdown: ${getErrorMessage(error)}`)
      }
    }
    const stop = (): Promise<void> => {
      if (stopping !== null) return stopping
      const attempt = (async () => {
        // An incomplete stop must keep a referenced event-loop handle. The
        // normal heartbeat is unref'd so an idle daemon can exit naturally;
        // during shutdown it is the retry anchor if runtime.close later drops
        // the HTTP listener before the owned process is proven gone.
        heartbeat?.ref()
        markShutdownPending()
        // Keep the heartbeat and daemon.json while either half of shutdown is
        // unresolved. A failed OpenCode stop is retried by the same handle and
        // must not leave a successor free to adopt its still-live server.
        // Only stops a server this daemon started; an adopted one is left alone.
        const stopped = await opencode?.stop() ?? true
        if (!stopped) throw new DaemonShutdownIncompleteError()

        await runtime?.close()

        // Before releasing the lock, prevent a final status callback from
        // recreating daemon.json after the cleanup below.
        stateFileReleased = true
        if (heartbeat) {
          clearInterval(heartbeat)
          heartbeat = null
        }
        // The state cleanup takes the existing lock itself. Release this
        // generation first so a successor can never be mistaken for it.
        lock.release()
        clearDaemonState(instanceId, options.configDir, { confirmedShutdown: true })
      })()
      // A failed attempt must not poison the retry path. In particular, a
      // caller may receive the failure after the HTTP listener has closed and
      // then retry through the signal handler or the returned handle.
      stopping = attempt.catch((error: unknown) => {
        stopping = null
        throw error
      })
      return stopping
    }
    stopRuntime = stop

    return {
      state,
      credentials,
      bootstrapNonces,
      bootstrapUrl,
      onShutdownRequest: (listener) => { shutdownListeners.add(listener) },
      stop,
    }
  } catch (error) {
    // Nothing from here on may write daemon.json after cleanup has completed.
    // If an owned OpenCode tree cannot be stopped, retain the lock and the
    // ownership boundary instead of claiming that startup fully unwound.
    stateFileReleased = true
    let cleanupComplete = true
    try {
      await runtime?.close()
    } catch {
      cleanupComplete = false
      // The start failure is the useful error; a close failure would mask it.
    }
    try {
      if (opencode !== null && !await opencode.stop()) cleanupComplete = false
    } catch {
      cleanupComplete = false
      // The start failure is the useful error; a close failure would mask it.
    }
    const retainedOpenCode = opencode?.ownedProcess
    // The daemon is about to exit, taking the reason with it. A refusal that
    // will recur on every start is left behind for `status` and `doctor`.
    recordStartFailure(
      error,
      options.version,
      options.configDir,
      cleanupComplete || retainedOpenCode === null || retainedOpenCode === undefined
        ? undefined
        : { baseUrl: settings.opencodeBaseUrl, ...retainedOpenCode },
    )
    if (cleanupComplete) {
      if (heartbeat) clearInterval(heartbeat)
      lock.release()
    } else {
      console.error('[daemon] Startup cleanup was incomplete; the daemon lock was retained for stale-owner recovery.')
    }
    throw error
  }
}

/**
 * Installs signal handling for a daemon process. Kept out of startDaemon so an
 * embedding host is never given process-wide handlers it did not ask for.
 */
export function installShutdownHandlers(handle: DaemonHandle): void {
  let shuttingDown = false

  const shutdown = (reason: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[daemon] Shutting down (${reason}).`)

    let attempts = 0
    const attempt = (): void => {
      attempts += 1
      handle.stop().then(() => {
        process.exit(0)
      }).catch((error: unknown) => {
        // Keep retrying with a capped backoff: the user's shutdown intent must
        // survive a closed Windows listener until the runtime drain settles,
        // without flooding logs or spinning the event loop.
        const delayMs = Math.min(
          SHUTDOWN_RETRY_MAX_DELAY_MS,
          SHUTDOWN_RETRY_DELAY_MS * (2 ** Math.min(attempts - 1, 5)),
        )
        console.error(
          `[daemon] Shutdown attempt ${attempts} failed: ${getErrorMessage(error)}; retrying in ${delayMs}ms.`,
        )
        const timer = setTimeout(attempt, delayMs)
        timer.unref()
      })
    }
    attempt()
  }

  // `looptroop stop` asks over HTTP first, which works on Windows where there
  // is no real SIGTERM, and proves the daemon answered before anything is
  // signalled at the process.
  handle.onShutdownRequest(shutdown)
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
