import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { readDaemonState, getDaemonLogPath, getDaemonLogDir, clearDaemonState, clearStaleDaemonState, readDaemonStartFailure, redactDaemonState, type DaemonState } from '../lib/daemonPaths'
import { resolveAppConfigDir, ensureSecureDir } from '../lib/appConfigDir'
import { rotateDaemonLog } from '../lib/daemonLog'
import { checkForUpdate, formatUpdateNotice } from '../lib/updateCheck'
import { clearLockOwnedBy, releaseStaleLock } from '../lib/daemonLock'
import { matchProcess } from '../lib/processIdentity'
import { isProcessAlive, killProcessTree, signalTermination, waitForExit } from './processControl'

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
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * A pid alone cannot prove the daemon is alive: the number may have been
 * recycled by an unrelated process. The instance id in the state file is
 * checked against the running daemon's own report before we act on it, so a
 * stale file can never point `stop` at somebody else's process.
 */
export async function readRunningDaemon(configDir?: string): Promise<DaemonState | null> {
  const state = readDaemonState(configDir)
  if (!state) return null
  if (!isProcessAlive(state.pid)) return null

  try {
    const response = await fetch(`http://${state.host}:${state.port}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) return null

    const body = await response.json() as { instanceId?: unknown }
    // An older daemon reports no id at all; a different one reports its own.
    // Only a mismatch is disqualifying.
    if (typeof body.instanceId === 'string' && body.instanceId !== state.instanceId) return null
  } catch {
    return null
  }

  return state
}

/**
 * Asks the running daemon for a fresh single-use nonce and builds the URL that
 * exchanges it for a browser session.
 *
 * The nonce is minted per call rather than kept anywhere: it is single-use and
 * expires in minutes, so a URL printed once cannot be reused, and nothing
 * durable ever holds a credential a browser could replay.
 */
export async function mintBootstrapUrl(state: DaemonState): Promise<string | null> {
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
    return `${origin}/#bootstrap=${body.nonce}`
  } catch {
    return null
  }
}

export async function startCommand(options: CliOptions = {}): Promise<number> {
  const configDir = resolveAppConfigDir()
  const existing = await readRunningDaemon(configDir)
  if (existing) {
    process.stdout.write(
      `LoopTroop is already running on http://${existing.host}:${existing.port} (pid ${existing.pid}).\n` +
      'Run `looptroop open` for a signed-in link.\n',
    )
    return 0
  }

  if (options.foreground) {
    const { runDaemonProcess } = await import('./daemonProcess')
    await runDaemonProcess({
      foreground: true,
      ...(options.port === undefined ? {} : { port: options.port }),
    })
    return 0
  }

  ensureSecureDir(getDaemonLogDir(configDir))
  // Rotated here rather than while the daemon runs: it holds an append handle
  // for its whole lifetime, and renaming underneath that handle would either
  // keep writing to the rotated file or fail outright on Windows.
  rotateDaemonLog(configDir)
  const logPath = getDaemonLogPath(configDir)
  // The detached child outlives this process, so its output goes to the log
  // file rather than to a pipe that dies with the parent.
  const logFd = openSync(logPath, 'a')

  const child = spawn(process.execPath, [resolve(moduleDir(), 'daemonProcess.js')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      ...(options.port === undefined ? {} : { LOOPTROOP_BACKEND_PORT: String(options.port) }),
    },
  })
  child.unref()

  const state = await waitForReady(configDir, child.pid ?? 0)
  if (!state) {
    // The child records a refusal it knows will recur before it exits. That
    // message says what happened; a log tail only shows where it was said.
    const failure = readDaemonStartFailure(configDir)
    process.stderr.write(failure
      ? `LoopTroop failed to start.\n\n${failure.message}\n\nFull log: ${logPath}\n`
      : 'LoopTroop failed to start. Recent log output:\n\n' +
        `${await tailLog(logPath, 20)}\n` +
        `Full log: ${logPath}\n`,
    )
    return 1
  }

  // Without a nonce the browser has no credential and every request 401s, so
  // the signed-in link is the useful thing to print — not the bare origin.
  const bootstrapUrl = await mintBootstrapUrl(state)

  process.stdout.write(
    'LoopTroop is running in the background.\n' +
    `  URL:   ${bootstrapUrl ?? `http://${state.host}:${state.port}`}\n` +
    `  PID:   ${state.pid}\n` +
    `  Logs:  ${logPath}\n` +
    `  Stop:  looptroop stop\n` +
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
      process.stdout.write('\nNo projects attached yet. Run `looptroop setup` to attach one.\n')
    }
  } catch {
    // Only a hint. A daemon that cannot answer has a real problem, and every
    // other command reports it far more usefully than a missing suggestion.
  }
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
 * `readRunningDaemon` proved the identity over HTTP before the escalation
 * started, but that proof expires the moment the daemon stops answering — which
 * is exactly what the graceful rung is waiting for. Between rungs the pid can be
 * released and handed to something else, and the next rung would signal that
 * instead. A pid we cannot vouch for is left alone: a daemon that outlives
 * `stop` is a nuisance, and killing an unrelated process is not.
 */
function stillTheDaemon(state: DaemonState): 'gone' | 'ours' | { reason: string } {
  if (!isProcessAlive(state.pid)) return 'gone'

  const match = matchProcess(state.pid, state.startToken)
  if (match.kind === 'same') return 'ours'
  if (match.kind === 'different') return { reason: 'the pid now belongs to a different process' }
  // Older daemons recorded no token. Their pid was confirmed over HTTP at the
  // start of this call, and refusing every one of them would leave no way to
  // stop them at all.
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
    return { kind: 'stopped', forced: false }
  }

  const beforeSignal = stillTheDaemon(state)
  if (beforeSignal === 'gone') return finishStop(state, options.configDir, false)
  if (beforeSignal !== 'ours') {
    return { kind: 'not-ours', pid: state.pid, reason: beforeSignal.reason }
  }

  if (signalTermination(state.pid) && await waitForExit(state.pid, budgets.signalMs)) {
    return { kind: 'stopped', forced: false }
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
  const state = await readRunningDaemon(configDir)

  if (!state) {
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

    process.stdout.write('LoopTroop is not running.\n')
    return 0
  }

  const outcome = await stopRunningDaemon(state, { configDir })

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

  process.stdout.write(outcome.kind === 'stopped' && outcome.forced
    ? 'LoopTroop did not shut down cleanly and was killed.\n'
    : 'LoopTroop stopped.\n')
  return 0
}

export async function statusCommand(json: boolean): Promise<number> {
  const configDir = resolveAppConfigDir()
  const state = await readRunningDaemon(configDir)
  // Only meaningful when nothing is running: a live daemon overwrote the record
  // when it started, so anything still there describes an earlier attempt.
  const failure = state ? null : readDaemonStartFailure(configDir)

  if (json) {
    // Redacted: the token is a credential for this daemon, and status output is
    // routinely piped, pasted into issues, and captured by CI logs.
    process.stdout.write(`${JSON.stringify({
      running: state !== null,
      daemon: state ? redactDaemonState(state) : null,
      lastStartFailure: failure,
    }, null, 2)}\n`)
    return state ? 0 : 1
  }

  if (!state) {
    process.stdout.write(failure
      ? 'LoopTroop is not running.\n\n' +
        `The last start was refused at ${failure.at}:\n${failure.message}\n\n` +
        'Run `looptroop doctor` to check whether that is still the case.\n'
      : 'LoopTroop is not running.\n')
    return 1
  }

  const uptimeMs = Date.now() - Date.parse(state.startedAt)
  process.stdout.write(
    'LoopTroop is running.\n' +
    `  URL:     http://${state.host}:${state.port}\n` +
    `  PID:     ${state.pid}\n` +
    `  Version: ${state.version}\n` +
    `  Uptime:  ${formatDuration(uptimeMs)}\n`,
  )

  // After the status itself, so a notice never obscures the answer that was
  // asked for, and never blocks it if the registry is slow or unreachable.
  const notice = await checkForUpdate({ currentVersion: state.version, configDir })
  if (notice) process.stdout.write(formatUpdateNotice(notice))

  return 0
}

export async function restartCommand(options: CliOptions = {}): Promise<number> {
  // A forced kill still counts as stopped, and `stop` has already cleared the
  // lock in that case; only a daemon that survived every rung blocks a restart.
  const stopped = await stopCommand()
  if (stopped !== 0) return stopped
  return startCommand(options)
}

/**
 * Hands a URL to the desktop's browser.
 *
 * The failure is swallowed on purpose: a headless server or a bare container
 * has no opener at all, and an unhandled spawn error would take the whole CLI
 * down over a convenience the caller can always perform by hand.
 */
export function openInBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
      : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]

  const child = spawn(opener, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}

export async function openCommand(): Promise<number> {
  const state = await readRunningDaemon()
  if (!state) {
    process.stderr.write('LoopTroop is not running. Start it with `looptroop start`.\n')
    return 1
  }

  const url = await mintBootstrapUrl(state)
  if (!url) {
    process.stderr.write('Could not obtain a sign-in link from the running daemon.\n')
    return 1
  }

  openInBrowser(url)
  // The origin, not the URL: the nonce belongs in the browser, not in a
  // terminal scrollback or a shell history file.
  process.stdout.write(`Opened http://${state.host}:${state.port}\n`)
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
