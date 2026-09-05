import { spawn, type ChildProcess } from 'node:child_process'
import { openSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { readDaemonState, getDaemonLogPath, getDaemonLogDir, clearDaemonState, clearStaleDaemonState, readDaemonStartFailure, redactDaemonState, type DaemonState } from '../lib/daemonPaths'
import { resolveAppConfigDir, ensureSecureDir } from '../lib/appConfigDir'
import { rotateDaemonLog } from '../lib/daemonLog'
import { summarizeUpdateStatus, type UpdateStatus } from '../lib/updateCheck'
import { isDevStackRunning } from '../lib/devStack'
import { LOOPTROOP_OPENCODE_LOGS_ENV } from '@shared/opencodeLogMode'
import { clearLockOwnedBy, releaseStaleLock } from '../lib/daemonLock'
import { matchProcess, readProcessStartToken } from '../lib/processIdentity'
import { daemonArgv } from './daemonHandoff'
import { isProcessAlive, killProcessTree, signalTermination, waitForExit } from './processControl'
import { getErrorMessage } from '@shared/typeGuards'

/** A start is abandoned rather than hanging forever if the child never reports. */
const READY_TIMEOUT_MS = 60_000

/**
 * Budget for each rung of the stop escalation. Every rung is bounded, so a
 * daemon that ignores all of them still returns control to the shell.
 */
export interface StopBudgets {
  /** Waiting on the daemon's own graceful shutdown. */
  gracefulMs: number
  /** Waiting on SIGTERM, which the daemon handles the same way. */
  signalMs: number
  /** Waiting on the kill, which the OS does not negotiate. */
  forceMs: number
}

export const DEFAULT_STOP_BUDGETS: StopBudgets = {
  gracefulMs: 15_000,
  signalMs: 10_000,
  forceMs: 5_000,
}

export interface CliOptions {
  port?: number
  foreground?: boolean
  /** Include full DEBUG output from an OpenCode server this daemon starts. */
  opencodeLogs?: 'all'
}

/** How long the health probe waits before it gives up on an answer. */
const HEALTH_PROBE_MS = 2_000

/**
 * What the recorded daemon actually is, as opposed to whether it answered.
 *
 * A single nullable state cannot carry this. "The health probe timed out" and
 * "there is no daemon" are the same `null`, and treating them as the same thing
 * is what let `stop` delete a live daemon's state file — taking its API token
 * with it, so nothing could ever stop it again, and leaving `clean` free to
 * remove worktrees it was using.
 *
 * The distinction that matters to a caller about to signal something is whether
 * the pid's identity is *proven*. `running` proves it over HTTP. `not-answering`
 * proves it with the start token taken when the daemon was spawned. `unverifiable`
 * proves nothing — the pid is alive, but it may have been recycled since the
 * record was written, so it must be left alone.
 */
export type DaemonProbe =
  /** Answered, and reported the instance id in the record. */
  | { kind: 'running'; state: DaemonState }
  /** Did not answer, but the pid is provably still the process we recorded. */
  | { kind: 'not-answering'; state: DaemonState }
  /** Alive, but nothing can prove it is still our daemon. Do not signal it. */
  | { kind: 'unverifiable'; state: DaemonState; reason: string }
  /** Alive and provably somebody else, or answering as a different instance. */
  | { kind: 'different'; state: DaemonState; reason: string }
  /** No record at all, or the recorded pid is gone. */
  | { kind: 'not-running' }

/**
 * A pid alone cannot prove the daemon is alive: the number may have been
 * recycled by an unrelated process. Identity is established over HTTP where the
 * daemon answers, and from the recorded start token where it does not.
 */
export async function probeRecordedDaemon(configDir?: string): Promise<DaemonProbe> {
  const state = readDaemonState(configDir)
  if (!state) return { kind: 'not-running' }
  if (!isProcessAlive(state.pid)) return { kind: 'not-running' }

  try {
    const response = await fetch(`http://${state.host}:${state.port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_MS),
    })
    if (response.ok) {
      const body = await response.json() as { instanceId?: unknown }
      // An older daemon reports no id at all; a different one reports its own.
      // Only a mismatch is disqualifying.
      if (typeof body.instanceId === 'string' && body.instanceId !== state.instanceId) {
        return {
          kind: 'different',
          state,
          reason: 'the daemon answering on that port reports a different instance',
        }
      }
      return { kind: 'running', state }
    }
  } catch {
    // Unreachable, refused, or slower than the probe allows. Which of those it
    // was does not change the next question, which is whose pid this is.
  }

  // Not answering. The pid is alive, so the only remaining question is whether
  // it is still the process the record describes.
  const match = matchProcess(state.pid, state.startToken)
  if (match.kind === 'same') return { kind: 'not-answering', state }
  if (match.kind === 'different') {
    return { kind: 'different', state, reason: 'the pid now belongs to a different process' }
  }
  return { kind: 'unverifiable', state, reason: match.reason }
}

/**
 * The daemon, but only when it answered — the shape every caller that just wants
 * to talk to a daemon needs.
 *
 * Callers that are about to *act* on the process rather than talk to it want
 * `probeRecordedDaemon` instead: this collapses "not answering" into `null`, and
 * that collapse is exactly what must not reach `stop`.
 */
export async function readRunningDaemon(configDir?: string): Promise<DaemonState | null> {
  const probe = await probeRecordedDaemon(configDir)
  return probe.kind === 'running' ? probe.state : null
}

/** A sign-in link, and the nonce inside it that says whether it was used. */
export interface BootstrapLink {
  url: string
  nonce: string
}

/**
 * Asks the running daemon for a fresh single-use nonce and builds the URL that
 * exchanges it for a browser session.
 *
 * The nonce is minted per call rather than kept anywhere: it is single-use and
 * expires in minutes, so a URL printed once cannot be reused, and nothing
 * durable ever holds a credential a browser could replay.
 *
 * The nonce is returned alongside the URL so the caller can ask the daemon
 * whether a browser ever spent it; see `waitForSignIn`.
 */
export async function mintBootstrapUrl(state: DaemonState): Promise<BootstrapLink | null> {
  const origin = `http://${state.host}:${state.port}`
  try {
    const response = await fetch(`${origin}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.apiToken}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return null

    const body = await response.json() as { nonce?: unknown }
    if (typeof body.nonce !== 'string' || !body.nonce) return null
    // The fragment is never sent to the server as part of the request line, so
    // the nonce cannot reach an access log on the way in.
    return { url: `${origin}/#bootstrap=${body.nonce}`, nonce: body.nonce }
  } catch {
    return null
  }
}

/** A daemon this process spawned and waited for. */
interface LaunchedDaemon {
  state: DaemonState
  logPath: string
}

/**
 * Spawns the daemon and waits for it to report ready, printing nothing on
 * success.
 *
 * Split out of `startCommand` so `open` can start a daemon without also
 * printing a start report and minting a sign-in nonce it would immediately
 * throw away. Failures are still written to stderr here, because the diagnosis
 * — the recorded refusal, the log tail, the abandoned-process note — is the
 * same whichever command asked for the start.
 *
 * Returns null when the daemon did not come up; the caller only has to choose
 * an exit code.
 */
async function launchDaemon(configDir: string, options: CliOptions): Promise<LaunchedDaemon | null> {
  ensureSecureDir(getDaemonLogDir(configDir))
  // Rotated here rather than while the daemon runs: it holds an append handle
  // for its whole lifetime, and renaming underneath that handle would either
  // keep writing to the rotated file or fail outright on Windows.
  rotateDaemonLog(configDir)
  const logPath = getDaemonLogPath(configDir)
  // The detached child outlives this process, so its output goes to the log
  // file rather than to a pipe that dies with the parent.
  const logFd = openSync(logPath, 'a')

  const child = spawn(process.execPath, daemonArgv(), {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      ...(options.port === undefined ? {} : { LOOPTROOP_BACKEND_PORT: String(options.port) }),
      ...(options.opencodeLogs === 'all' ? { [LOOPTROOP_OPENCODE_LOGS_ENV]: 'all' } : {}),
    },
  })
  child.unref()
  // Recorded now, while the child is certainly itself. On timeout this is what
  // separates "our hung daemon" from "a pid the OS has since handed to someone
  // else", and by then there is nothing else left that can tell them apart.
  const childToken = readProcessStartToken(child.pid ?? 0)

  const state = await waitForReady(configDir, child.pid ?? 0)
  if (!state) {
    // A start that timed out leaves a real process running: it holds the daemon
    // lock, and it may still finish booting seconds after the CLI reported
    // failure — at which point there is a daemon nobody was told about, on a
    // port nobody printed, that the next `looptroop start` will refuse to
    // replace. Reporting the failure is not enough; the failure has to be true.
    const abandoned = await abandonFailedStart(configDir, child, childToken)

    // The child records a refusal it knows will recur before it exits. That
    // message says what happened; a log tail only shows where it was said.
    const failure = readDaemonStartFailure(configDir)
    process.stderr.write(failure
      ? `LoopTroop failed to start.\n\n${failure.message}\n\nFull log: ${logPath}\n`
      : 'LoopTroop failed to start. Recent log output:\n\n' +
        `${await tailLog(logPath, 20)}\n` +
        `Full log: ${logPath}\n`,
    )
    if (abandoned !== null) process.stderr.write(`\n${abandoned}\n`)
    return null
  }

  return { state, logPath }
}

export async function startCommand(options: CliOptions = {}): Promise<number> {
  const configDir = resolveAppConfigDir()
  const existing = await probeRecordedDaemon(configDir)
  if (existing.kind === 'running') {
    process.stdout.write(
      `LoopTroop is already running on http://${existing.state.host}:${existing.state.port} ` +
      `(pid ${existing.state.pid}).\n` +
      'Run `looptroop open` for a signed-in link.\n',
    )
    if (options.opencodeLogs === 'all') writeAllLogsRequiresRestart()
    return 0
  }

  // A daemon that is alive but not answering is still a daemon holding the
  // single-instance lock. Starting would fail on that lock anyway; saying so
  // here names the actual situation instead of reporting a refused start.
  if (existing.kind === 'not-answering' || existing.kind === 'unverifiable') {
    process.stderr.write(
      `LoopTroop is already running on http://${existing.state.host}:${existing.state.port} ` +
      `(pid ${existing.state.pid}) but is not answering` +
      `${existing.kind === 'unverifiable' ? `, and ${existing.reason}` : ''}. ` +
      'Nothing was started. Run `looptroop stop` and try again, or `looptroop doctor` to see ' +
      'what that process is.\n',
    )
    return 1
  }

  if (options.foreground) {
    const { runDaemonProcess } = await import('./daemonProcess')
    await runDaemonProcess({
      foreground: true,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.opencodeLogs === 'all' ? { opencodeLogs: 'all' } : {}),
    })
    return 0
  }

  const launched = await launchDaemon(configDir, options)
  if (!launched) return 1
  const { state, logPath } = launched

  // Without a nonce the browser has no credential and every request 401s, so
  // the signed-in link is the useful thing to print — not the bare origin.
  const bootstrapUrl = await mintBootstrapUrl(state)

  process.stdout.write(
    'LoopTroop is running in the background.\n' +
    `  URL:   ${bootstrapUrl?.url ?? `http://${state.host}:${state.port}`}\n` +
    `  PID:   ${state.pid}\n` +
    `  Logs:  ${logPath}\n` +
    '  Follow: looptroop logs --follow\n' +
    `  Stop:  looptroop stop\n` +
    (options.opencodeLogs === 'all'
      ? '  OpenCode: full managed DEBUG output enabled\n'
      : '  OpenCode: start with --opencode-logs=all for full managed DEBUG output\n') +
    (bootstrapUrl
      ? '\nThe link signs this browser in once and then expires. Run `looptroop open` for a new one.\n'
      : '\nCould not mint a sign-in link; run `looptroop open` to try again.\n'),
  )

  await hintFirstRun(state)
  return 0
}

/**
 * Names the next step for a daemon that has nothing to work on yet.
 *
 * Asked over HTTP rather than read from the database: the daemon holds that
 * file open, and a second process opening it to answer a cosmetic question is
 * not worth the contention.
 */
async function hintFirstRun(state: DaemonState): Promise<void> {
  try {
    const response = await fetch(`http://${state.host}:${state.port}/api/projects`, {
      headers: { Authorization: `Bearer ${state.apiToken}` },
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) return

    const projects = await response.json() as unknown
    if (Array.isArray(projects) && projects.length === 0) {
      // Points at the interface, not at `looptroop setup`. LoopTroop is used
      // through its interface; attaching a project is a thing you do there, and
      // sending a new user back to the terminal for it teaches the wrong shape
      // of the application.
      process.stdout.write('\nNo projects attached yet. Add one in the interface.\n')
    }
  } catch {
    // Only a hint. A daemon that cannot answer has a real problem, and every
    // other command reports it far more usefully than a missing suggestion.
  }
}

/**
 * Ends a daemon that never reported ready, and removes only what it left.
 *
 * `waitForReady` returning null means one of two very different things. The
 * child may already be gone, which is the ordinary failed start and needs no
 * termination. Or it may still be running — booting slowly, wedged on a
 * database, stuck opening a port — in which case the CLI is about to tell the
 * user that nothing started while a process holding the daemon lock says
 * otherwise. That one has to be ended here, because after this function returns
 * nothing anywhere holds its pid.
 *
 * Identity is re-checked against the token taken at spawn before anything is
 * signalled. The pid may have been released and reissued during the timeout, and
 * a start that failed is no licence to kill a stranger's process. Where identity
 * cannot be established the process is left alone and the user is told what to
 * look at, which is worse than cleaning up and much better than the alternative.
 *
 * Returns a line to show the user, or null when there was nothing to clean up.
 */
export async function abandonFailedStart(
  configDir: string,
  child: ChildProcess,
  childToken: string | null,
): Promise<string | null> {
  const pid = child.pid
  if (pid === undefined || pid <= 0 || !isProcessAlive(pid)) return null

  const match = matchProcess(pid, childToken ?? undefined)
  if (match.kind === 'different') return null
  if (match.kind === 'unknown') {
    return `A process started by this command (pid ${pid}) may still be running, and ${match.reason}. ` +
      'Check it before starting again; `looptroop stop` will not touch it.'
  }

  // Same escalation as `stop`, and bounded for the same reason: a start that
  // already failed must not also hang. The tree, not the pid — the daemon may
  // have spawned an OpenCode of its own before it wedged.
  if (!(signalTermination(pid) && await waitForExit(pid, DEFAULT_STOP_BUDGETS.signalMs))) {
    await killProcessTree(pid)
    if (!await waitForExit(pid, DEFAULT_STOP_BUDGETS.forceMs)) {
      return `A daemon that never finished starting (pid ${pid}) could not be stopped. ` +
        'It may still hold the single-instance lock.'
    }
  }

  // Scoped to this pid and this instance, so a daemon that started in the
  // meantime keeps both. `clearLockOwnedBy` re-checks identity itself, and by
  // now the process is gone, which is the case it is written for.
  clearLockOwnedBy(pid, configDir)
  // A state file naming somebody else is somebody else's: two `start` calls can
  // race, and the one that succeeded must not have its record deleted by the one
  // that timed out. A recorded start failure is kept by clearStaleDaemonState
  // itself, since it is the only account of why there is no daemon.
  const recorded = readDaemonState(configDir)
  if (recorded === null || recorded.pid === pid) clearStaleDaemonState(configDir)

  return `Stopped the daemon that never finished starting (pid ${pid}).`
}

/**
 * Polls for the state file the daemon writes only after it is genuinely
 * serving. Also watches the child, so a start that dies immediately fails fast
 * instead of waiting out the full timeout.
 */
async function waitForReady(configDir: string, childPid: number): Promise<DaemonState | null> {
  const deadline = Date.now() + READY_TIMEOUT_MS

  while (Date.now() < deadline) {
    const state = await readRunningDaemon(configDir)
    if (state) return state
    if (childPid > 0 && !isProcessAlive(childPid)) return null
    await delay(150)
  }

  return null
}

async function tailLog(logPath: string, lines: number): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises')
    const content = await readFile(logPath, 'utf8')
    return content.split('\n').slice(-lines).join('\n')
  } catch {
    return '(no log output)'
  }
}

export type StopOutcome =
  | { kind: 'not-running' }
  | { kind: 'stopped'; forced: boolean }
  | { kind: 'failed'; pid: number }
  /** The pid is alive but is no longer the daemon, so nothing was signalled. */
  | { kind: 'not-ours'; pid: number; reason: string }

/**
 * Whether the pid recorded for this daemon still belongs to it.
 *
 * `probeRecordedDaemon` proved the identity before the escalation started —
 * over HTTP for a daemon that answered, from the recorded start token for one
 * that did not — but that proof expires the moment the daemon stops answering,
 * which is exactly what the graceful rung is waiting for. Between rungs the pid
 * can be released and handed to something else, and the next rung would signal
 * that instead. A pid we cannot vouch for is left alone: a daemon that outlives
 * `stop` is a nuisance, and killing an unrelated process is not.
 */
function stillTheDaemon(state: DaemonState): 'gone' | 'ours' | { reason: string } {
  if (!isProcessAlive(state.pid)) return 'gone'

  const match = matchProcess(state.pid, state.startToken)
  if (match.kind === 'same') return 'ours'
  if (match.kind === 'different') return { reason: 'the pid now belongs to a different process' }
  // Older daemons recorded no token. Reaching here at all means the daemon
  // answered over HTTP when this call began — a tokenless record that never
  // answered is stopped by nobody, because `probeRecordedDaemon` reports it as
  // `unverifiable` and the escalation is never entered. Refusing these as well
  // would leave no way to stop an old daemon that is working perfectly.
  return state.startToken === undefined ? 'ours' : { reason: match.reason }
}

/**
 * Asks the daemon to shut itself down, and escalates only as far as it must.
 *
 * The HTTP request is first because it is the only rung that works everywhere:
 * it reaches the daemon's own graceful path, which closes the server, stops an
 * OpenCode it owns and releases the lock, and Windows has no SIGTERM to fall
 * back on. Each later rung is bounded, so an unresponsive daemon still ends, and
 * each is preceded by a fresh identity check because a pid freed by the previous
 * rung can be reissued before the next one runs.
 */
export async function stopRunningDaemon(
  state: DaemonState,
  options: { configDir?: string; budgets?: StopBudgets } = {},
): Promise<StopOutcome> {
  const budgets = options.budgets ?? DEFAULT_STOP_BUDGETS

  const accepted = await requestShutdown(state)
  if (accepted && await waitForExit(state.pid, budgets.gracefulMs)) {
    return finishStop(state, options.configDir, false)
  }

  const beforeSignal = stillTheDaemon(state)
  if (beforeSignal === 'gone') return finishStop(state, options.configDir, false)
  if (beforeSignal !== 'ours') {
    return { kind: 'not-ours', pid: state.pid, reason: beforeSignal.reason }
  }

  if (signalTermination(state.pid) && await waitForExit(state.pid, budgets.signalMs)) {
    return finishStop(state, options.configDir, false)
  }

  const beforeKill = stillTheDaemon(state)
  if (beforeKill === 'gone') return finishStop(state, options.configDir, false)
  if (beforeKill !== 'ours') {
    return { kind: 'not-ours', pid: state.pid, reason: beforeKill.reason }
  }

  await killProcessTree(state.pid)
  if (!await waitForExit(state.pid, budgets.forceMs)) {
    return { kind: 'failed', pid: state.pid }
  }

  return finishStop(state, options.configDir, true)
}

/**
 * Clears what a daemon that did not shut itself down left behind.
 *
 * Both writes are scoped to this daemon's own identity, so a daemon that started
 * in the meantime keeps its lock and its state file. A daemon that exited
 * cleanly has already removed both and these are no-ops.
 *
 * Every rung that confirms the process is gone ends here, including the two that
 * used to return without it. Those were written for a daemon that answered and
 * therefore ran its own cleanup on the way out — but `stop` now also reaches a
 * daemon that never answered, and a wedged process does not run its shutdown
 * handler. Leaving its records behind would mean a successful `stop` reporting
 * success while `status` still described a daemon.
 */
function finishStop(state: DaemonState, configDir: string | undefined, forced: boolean): StopOutcome {
  clearLockOwnedBy(state.pid, configDir)
  clearDaemonState(state.instanceId, configDir)
  return { kind: 'stopped', forced }
}

/** True when the daemon accepted the request; false for any failure to reach it. */
async function requestShutdown(state: DaemonState): Promise<boolean> {
  try {
    const response = await fetch(`http://${state.host}:${state.port}/api/daemon/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.apiToken}` },
      signal: AbortSignal.timeout(5_000),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function stopCommand(): Promise<number> {
  const configDir = resolveAppConfigDir()
  const probe = await probeRecordedDaemon(configDir)

  // Alive, and provably still ours: stop it. That the health probe timed out
  // changes nothing about whose process it is — the start token says that, and
  // the escalation re-checks it before every rung it can act on.
  if (probe.kind === 'running' || probe.kind === 'not-answering') {
    return reportStopOutcome(await stopRunningDaemon(probe.state, { configDir }))
  }

  // Alive, but nothing proves it is still the daemon the record describes. The
  // record and the lock are both left exactly as they are: the state file holds
  // the only copy of this daemon's API token, and deleting it would strand a
  // process that may well be a working daemon whose health probe was merely
  // slow — unstoppable afterwards, because the credential to ask it to stop
  // would be gone.
  if (probe.kind === 'unverifiable') {
    process.stderr.write(
      `LoopTroop is not answering, and pid ${probe.state.pid} was left alone because ${probe.reason}. ` +
      'Nothing was stopped, and its records were left in place so a working daemon is not stranded. ' +
      'Run `looptroop doctor` to see what that process is.\n',
    )
    return 1
  }

  if (probe.kind === 'different') {
    // The recorded pid is provably not our daemon, so the record describes
    // nothing that is running and clearing it is safe.
    process.stderr.write(`The recorded daemon is gone: ${probe.reason}.\n`)
  }

  // Clear debris so the next start is not blocked by a lock whose owner died.
  // A recorded start failure survives: `stop` is what someone runs after a
  // start that did not take, and it is the only account of why.
  clearStaleDaemonState(configDir)
  const lock = releaseStaleLock(configDir)

  if (lock.kind === 'held') {
    // A daemon that is not answering is still a daemon. Removing its lock here
    // would let the next start run a second one on the same databases.
    process.stderr.write(
      `LoopTroop is not answering, but pid ${lock.owner.pid} still holds its single-instance lock ` +
      `(started ${lock.owner.startedAt}). Nothing was stopped, and the lock was left in place so a ` +
      'second daemon cannot start alongside it. Run `looptroop doctor` to see what that process is.\n',
    )
    return 1
  }

  if (lock.kind === 'unreadable') {
    // The lock file is there but names nobody yet — most likely a daemon
    // partway through writing its record. Saying "not running" would be a
    // lie, and removing it would let the next start run a second daemon
    // alongside the one currently starting.
    process.stderr.write(
      'LoopTroop is not answering, and its single-instance lock exists but does not yet name an owner — ' +
      'most likely a daemon still starting up. Nothing was stopped, and the lock was left in place. ' +
      'Try again in a moment, or run `looptroop doctor` if it persists.\n',
    )
    return 1
  }

  process.stdout.write('LoopTroop is not running.\n')
  return 0
}

/** Turns the escalation's outcome into what the user sees and the shell reads. */
function reportStopOutcome(outcome: StopOutcome): number {
  if (outcome.kind === 'failed') {
    process.stderr.write(
      `LoopTroop (pid ${outcome.pid}) did not stop and could not be killed. ` +
      'Check whether it belongs to another user.\n',
    )
    return 1
  }

  if (outcome.kind === 'not-ours') {
    // The daemon released the pid partway through the escalation and something
    // else took it. Whatever that is, it is not ours to signal.
    process.stderr.write(
      `LoopTroop stopped answering, and pid ${outcome.pid} was left alone because ${outcome.reason}. ` +
      'Run `looptroop status` to confirm nothing is still running.\n',
    )
    return 1
  }

  if (outcome.kind === 'not-running') {
    process.stdout.write('LoopTroop is not running.\n')
    return 0
  }

  process.stdout.write(outcome.forced
    ? 'LoopTroop did not shut down cleanly and was killed.\n'
    : 'LoopTroop stopped.\n')
  return 0
}

/**
 * One line about OpenCode for `status`.
 *
 * Worth a line of its own because a LoopTroop whose OpenCode has given up is
 * still a LoopTroop that is running, and `status` answered only that narrower
 * question — leaving the daemon looking healthy while every coding operation
 * it exists to perform would fail.
 */
export function describeOpenCodeForStatus(opencode: DaemonState['opencode']): string {
  if (opencode === undefined) return 'mock mode (no server)'

  switch (opencode.status) {
    case 'degraded':
      return `unavailable — ${opencode.detail ?? 'the server stopped responding'}`
    case 'managed':
      return `${opencode.baseUrl} (started by LoopTroop, pid ${opencode.pid ?? 'unknown'})`
    case 'adopted':
      return `${opencode.baseUrl} (started elsewhere)`
    default:
      // A record from a build that predates the status field. `owned` is all it
      // said, and guessing beyond that would be inventing the answer.
      return `${opencode.baseUrl}${opencode.owned ? ' (started by LoopTroop)' : ''}`
  }
}

export async function statusCommand(json: boolean, update?: UpdateStatus): Promise<number> {
  const configDir = resolveAppConfigDir()
  const probe = await probeRecordedDaemon(configDir)
  const state = probe.kind === 'running' ? probe.state : null
  // Only meaningful when nothing is running: a live daemon overwrote the record
  // when it started, so anything still there describes an earlier attempt.
  const failure = state ? null : readDaemonStartFailure(configDir)
  // A process that is there but not talking. Reported separately rather than
  // folded into `running`, which every installer and smoke reads as "answering"
  // and which must keep meaning exactly that.
  const unresponsive = probe.kind === 'not-answering' || probe.kind === 'unverifiable'
    ? { pid: probe.state.pid, reason: probe.kind === 'unverifiable' ? probe.reason : null }
    : null

  if (json) {
    // Redacted: the token is a credential for this daemon, and status output is
    // routinely piped, pasted into issues, and captured by CI logs.
    process.stdout.write(`${JSON.stringify({
      running: state !== null,
      daemon: state ? redactDaemonState(state) : null,
      notAnswering: unresponsive,
      lastStartFailure: failure,
      ...(update === undefined ? {} : { update: summarizeUpdateStatus(update) }),
    }, null, 2)}\n`)
    return state ? 0 : 1
  }

  if (unresponsive) {
    // "Not running" would be a lie that sends someone to `start`, which the
    // lock then refuses for reasons that read as unrelated.
    process.stdout.write(
      `LoopTroop is not answering, but pid ${unresponsive.pid} is still running` +
      `${unresponsive.reason === null ? '' : `, and ${unresponsive.reason}`}.\n\n` +
      'Run `looptroop stop` to end it, or `looptroop doctor` to see what it is.\n',
    )
    return 1
  }

  if (!state) {
    if (failure) {
      process.stdout.write('LoopTroop is not running.\n\n' +
        `The last start was refused at ${failure.at}:\n${failure.message}\n\n` +
        'Run `looptroop doctor` to check whether that is still the case.\n')
      return 1
    }

    // Someone running from a checkout has the interface open in a browser while
    // being told nothing is running, and both statements are true of different
    // things. Say which one this is rather than leaving them to distrust the
    // answer — this is the report people said looked broken.
    process.stdout.write(await isDevStackRunning()
      ? 'LoopTroop is not running.\n\n' +
        'A development server is serving the interface on this machine. `status`\n' +
        'reports the installed daemon; `npm run dev` registers none.\n'
      : 'LoopTroop is not running.\n')
    return 1
  }

  const uptimeMs = Date.now() - Date.parse(state.startedAt)
  process.stdout.write(
    'LoopTroop is running.\n' +
    `  URL:      http://${state.host}:${state.port}\n` +
    `  PID:      ${state.pid}\n` +
    `  Version:  ${state.version}\n` +
    `  Uptime:   ${formatDuration(uptimeMs)}\n` +
    `  OpenCode: ${describeOpenCodeForStatus(state.opencode)}\n`,
  )

  return 0
}

export async function restartCommand(options: CliOptions = {}): Promise<number> {
  // A forced kill still counts as stopped, and `stop` has already cleared the
  // lock in that case; only a daemon that survived every rung blocks a restart.
  const stopped = await stopCommand()
  if (stopped !== 0) return stopped
  return startCommand(options)
}

/** What became of an attempt to hand a URL to the desktop's browser. */
export interface BrowserLaunch {
  opened: boolean
  /** Present only on a failure, and only when the opener said something. */
  reason?: string
}

/** How long an opener gets to fail before it is assumed to have worked. */
const OPENER_GRACE_MS = 1_500

/**
 * Hands a URL to the desktop's browser, and reports whether that worked.
 *
 * It still never throws: a headless server or a bare container has no opener at
 * all, and an unhandled spawn error would take the whole CLI down over a
 * convenience the caller can always perform by hand. But it no longer discards
 * the answer either. `cmd /c start` and macOS `open` both exit as soon as they
 * have handed the URL over, so within the grace period their exit code is a real
 * verdict — including the case that started this, a Windows machine with no
 * browser registered for http, where the launch failed silently and the CLI
 * cheerfully reported success. `xdg-open` may keep running instead; still being
 * alive at the deadline counts as opened, because it got far enough to try.
 *
 * stderr is captured rather than discarded so the failure can be quoted back.
 */
/**
 * The command that opens a URL on this platform.
 *
 * Separated from the spawn so the shapes can be asserted without launching
 * anything. Windows uses the URL protocol handler directly: unlike `cmd /c
 * start`, it does not send the URL through a command interpreter first.
 */
export function browserOpener(url: string, platform: NodeJS.Platform): {
  command: string
  args: string[]
} {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') {
    return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
  }
  return { command: 'xdg-open', args: [url] }
}

export function openInBrowser(url: string): Promise<BrowserLaunch> {
  const { command: opener, args } = browserOpener(url, process.platform)

  return new Promise<BrowserLaunch>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(opener, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      resolve({ opened: false, reason: getErrorMessage(error) })
      return
    }

    let complaint = ''
    // Bounded: an opener that decides to narrate must not be able to hold a
    // growing buffer for the lifetime of the CLI.
    child.stderr?.on('data', (chunk: Buffer) => {
      if (complaint.length < 500) complaint += chunk.toString()
    })

    let settled = false
    const finish = (result: BrowserLaunch): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.unref()
      resolve(result)
    }

    const timer = setTimeout(() => { finish({ opened: true }) }, OPENER_GRACE_MS)
    // Nothing else keeps the CLI waiting on this timer if the command is done.
    timer.unref?.()

    child.on('error', (error) => {
      finish({ opened: false, reason: error.message })
    })
    child.on('exit', (code) => {
      const detail = complaint.trim().split('\n')[0]?.trim()
      finish(code === 0 || code === null
        ? { opened: true }
        : { opened: false, ...(detail ? { reason: detail } : {}) })
    })
  })
}

/**
 * Opens the interface, starting the daemon first if it is not running.
 *
 * `open` is the command people reach for, and refusing it with the name of
 * another command made starting LoopTroop a two-step ritual for no reason a
 * user could see. Starting is idempotent and already bounded, so doing it here
 * costs nothing when the daemon is already up.
 */
export interface OpenOptions {
  /** Injected by tests, which must not launch a real browser. */
  open?: (url: string) => BrowserLaunch | Promise<BrowserLaunch>
  /** Print the sign-in link instead of opening anything. */
  printUrl?: boolean
  /** How long to wait for the browser to sign in. Shortened by tests. */
  waitMs?: number
  /** Include full DEBUG output from an OpenCode server this command starts. */
  opencodeLogs?: 'all'
}


function writeAllLogsRequiresRestart(): void {
  process.stderr.write(
    '`--opencode-logs=all` only applies when LoopTroop starts the daemon. ' +
    'Run `looptroop stop`, then start it again with that option.\n',
  )
}

function writeLogHint(opencodeLogs: OpenOptions['opencodeLogs']): void {
  process.stdout.write(
    'Logs: run `looptroop logs --follow` to stream them. ' +
    (opencodeLogs === 'all'
      ? 'Full managed OpenCode DEBUG output is enabled.\n'
      : 'Start with `--opencode-logs=all` for full managed OpenCode DEBUG output.\n'),
  )
}

/** How long a launched browser gets to spend its nonce before `open` gives up. */
const SIGN_IN_WAIT_MS = 8_000

/**
 * Waits for a browser to spend the nonce, and says whether one did.
 *
 * Polled rather than pushed because the daemon has no way to reach back into
 * the CLI, and it is the only honest signal available: no operating system
 * reports whether the browser it launched ever loaded the page.
 *
 * Any failure to ask counts as signed in. This decides nothing but whether to
 * print a link, and a daemon that has stopped answering is not a problem a
 * sign-in link solves.
 */
async function waitForSignIn(state: DaemonState, nonce: string, waitMs: number): Promise<boolean> {
  const origin = `http://${state.host}:${state.port}`
  const deadline = Date.now() + waitMs

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/auth/bootstrap/status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
        signal: AbortSignal.timeout(2_000),
      })
      if (!response.ok) return true

      const body = await response.json() as { pending?: unknown }
      if (body.pending !== true) return true
    } catch {
      return true
    }
    await delay(250)
  }

  return false
}

/**
 * Prints the sign-in link, for the cases where the browser cannot be reached.
 *
 * `open` withholds this URL by default, and should: the nonce in it is a live
 * credential, and this line lands in scrollback, in screenshots and in pasted
 * bug reports. But withholding it unconditionally is what turned a browser that
 * did not open into a dead end — the page says to run `looptroop open`, and
 * `looptroop open` is what just failed. `start` has always printed this same
 * link; the cost is identical, and it is only paid when the alternative is no
 * way in at all.
 */
function printSignInLink(url: string, lead: string): void {
  process.stdout.write(`${lead}\n  ${url}\nIt signs one browser in and then expires.\n`)
}

export async function openCommand(options: OpenOptions = {}): Promise<number> {
  const launchBrowser = options.open ?? openInBrowser
  const configDir = resolveAppConfigDir()
  let state = await readRunningDaemon(configDir)
  let started = false

  if (state && options.opencodeLogs === 'all') writeAllLogsRequiresRestart()

  if (!state) {
    process.stdout.write('LoopTroop is not running. Starting it...\n')
    const launched = await launchDaemon(configDir, options.opencodeLogs === 'all' ? { opencodeLogs: 'all' } : {})
    // launchDaemon has already said why, in more detail than this command could.
    if (!launched) return 1
    state = launched.state
    started = true
  }

  const link = await mintBootstrapUrl(state)
  if (!link) {
    process.stderr.write('Could not obtain a sign-in link from the running daemon.\n')
    return 1
  }

  if (options.printUrl === true) {
    printSignInLink(link.url, 'Sign in to LoopTroop with this link:')
    if (started) {
      writeLogHint(options.opencodeLogs)
      await hintFirstRun(state)
    }
    return 0
  }

  const launch = await launchBrowser(link.url)

  if (!launch.opened) {
    printSignInLink(
      link.url,
      `No browser could be opened${launch.reason === undefined ? '' : ` (${launch.reason})`}. Sign in with this link:`,
    )
  } else if (await waitForSignIn(state, link.nonce, options.waitMs ?? SIGN_IN_WAIT_MS)) {
    // The origin, not the URL: the nonce belongs in the browser, not in a
    // terminal scrollback or a shell history file.
    process.stdout.write(`Opened http://${state.host}:${state.port}\n`)
  } else {
    // A browser was launched and never arrived. It happens on a machine with no
    // default browser, over SSH, in WSL, and in a fresh VM whose browser is
    // still finishing its first run when the nonce expires.
    printSignInLink(link.url, 'No browser signed in. If none opened, use this link:')
  }

  // Printed once, whichever way the browser went: it describes the daemon this
  // command started, not how the browser was signed in.
  if (started) writeLogHint(options.opencodeLogs)

  // Only after a start we performed: an already-running daemon has been asked
  // this question before, and the answer is on the screen the browser just
  // opened anyway.
  if (started) await hintFirstRun(state)
  return 0
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
