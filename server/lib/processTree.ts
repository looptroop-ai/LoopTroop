import { spawn, type ChildProcess } from 'node:child_process'
import type { HostPlatform } from '@shared/hostContext'
import { FORCE_KILL_DELAY_MS } from './constants'

function currentPlatform(): HostPlatform {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  return 'linux'
}

/**
 * Signals a spawned command and everything it started.
 *
 * A shell command's children are the point: killing only the shell leaves a
 * test runner or a dev server holding the port. POSIX gets the negated pid, so
 * the signal goes to the process group the runner asked for when it spawned
 * detached; Windows has no such thing, so it goes through `taskkill /T`.
 * Falling back to `child.kill` covers the case where the group is already gone.
 */
export function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: HostPlatform = currentPlatform(),
): void {
  if (!child.pid) return

  if (platform === 'windows') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      .on('error', () => undefined)
    return
  }

  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

/**
 * Asks a process tree to stop, then makes it.
 *
 * The delay is what separates "would not stop" from "was not given a chance
 * to": SIGTERM lets a runner flush its output and remove its own temporary
 * files, and SIGKILL after the grace period covers the one that ignores it.
 * The timer is unref'd so a command that exits on the first signal does not
 * hold the event loop open for the remainder of the delay.
 */
export function terminateProcessTreeWithEscalation(
  child: ChildProcess,
  platform?: HostPlatform,
): void {
  terminateProcessTree(child, 'SIGTERM', platform)
  setTimeout(() => terminateProcessTree(child, 'SIGKILL', platform), FORCE_KILL_DELAY_MS).unref()
}
