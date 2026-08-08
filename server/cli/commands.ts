import { spawn } from 'node:child_process'
import { openSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { readDaemonState, getDaemonLogPath, getDaemonLogDir, getDaemonStatePath, redactDaemonState, type DaemonState } from '../lib/daemonPaths'
import { resolveAppConfigDir, ensureSecureDir } from '../lib/appConfigDir'
import { rotateDaemonLog } from '../lib/daemonLog'
import { checkForUpdate, formatUpdateNotice } from '../lib/updateCheck'
import { getDaemonLockPath } from '../lib/daemonPaths'

/** A start is abandoned rather than hanging forever if the child never reports. */
const READY_TIMEOUT_MS = 60_000

/** Graceful stop budget before escalating to a forceful kill. */
const STOP_TIMEOUT_MS = 30_000

export interface CliOptions {
  port?: number
  foreground?: boolean
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
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
    process.stderr.write(
      'LoopTroop failed to start. Recent log output:\n\n' +
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
  return 0
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

export async function stopCommand(): Promise<number> {
  const configDir = resolveAppConfigDir()
  const state = await readRunningDaemon(configDir)

  if (!state) {
    // Clear debris so the next start is not blocked by a lock whose owner died.
    rmSync(getDaemonStatePath(configDir), { force: true })
    rmSync(getDaemonLockPath(configDir), { force: true })
    process.stdout.write('LoopTroop is not running.\n')
    return 0
  }

  process.kill(state.pid, 'SIGTERM')

  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!isProcessAlive(state.pid)) {
      process.stdout.write('LoopTroop stopped.\n')
      return 0
    }
    await delay(150)
  }

  process.stderr.write(`LoopTroop did not stop within ${STOP_TIMEOUT_MS / 1000}s; sending SIGKILL.\n`)
  try {
    process.kill(state.pid, 'SIGKILL')
  } catch {
    // Already gone between the check and the signal.
  }
  return 1
}

export async function statusCommand(json: boolean): Promise<number> {
  const configDir = resolveAppConfigDir()
  const state = await readRunningDaemon(configDir)

  if (json) {
    // Redacted: the token is a credential for this daemon, and status output is
    // routinely piped, pasted into issues, and captured by CI logs.
    process.stdout.write(`${JSON.stringify({
      running: state !== null,
      daemon: state ? redactDaemonState(state) : null,
    }, null, 2)}\n`)
    return state ? 0 : 1
  }

  if (!state) {
    process.stdout.write('LoopTroop is not running.\n')
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
  const stopped = await stopCommand()
  if (stopped !== 0) return stopped
  return startCommand(options)
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

  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
      : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]

  spawn(opener, args, { detached: true, stdio: 'ignore' }).unref()
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
