import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/**
 * A pid is not an identity. The number is recycled, so a record that names one
 * cannot tell the process it was written about from an unrelated process that
 * inherited the number later — and acting on that difference means signalling
 * something that was never ours.
 *
 * The kernel does know when a process started, to a resolution far finer than a
 * pid can be reused in, so pid plus start time identifies a process for as long
 * as it lives. This module turns that pair into a token a JSON file can carry
 * and a later run can compare.
 *
 * The token is hashed rather than stored raw: on Linux the input contains the
 * boot id, and `status --json` output is routinely piped into issues and CI
 * logs. Equality is all any caller needs, and a hash still answers that.
 */

export interface ProcessIdentityDeps {
  platform: NodeJS.Platform
  readTextFile: (path: string) => string | null
  runCommand: (file: string, args: string[]) => string | null
}

/** Bounded so a wedged process lister cannot hang the command that asked. */
const COMMAND_TIMEOUT_MS = 5_000

function createDefaultDeps(): ProcessIdentityDeps {
  return {
    platform: process.platform,
    readTextFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    runCommand: (file, args) => {
      try {
        return execFileSync(file, args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: COMMAND_TIMEOUT_MS,
          windowsHide: true,
        }).trim()
      } catch {
        return null
      }
    },
  }
}

/**
 * Start time in clock ticks since boot, from field 22 of /proc/<pid>/stat.
 *
 * The fields are split after the last ')' because field 2 is the executable
 * name, which may itself contain spaces and parentheses.
 */
function readLinuxStartTime(pid: number, deps: ProcessIdentityDeps): string | null {
  const stat = deps.readTextFile(`/proc/${pid}/stat`)
  if (stat === null) return null

  const commEnd = stat.lastIndexOf(')')
  if (commEnd === -1) return null

  const fields = stat.slice(commEnd + 1).trim().split(/\s+/)
  // state is field 3, so field 22 sits at index 19 of what follows the name.
  const startTime = fields[19]
  return startTime !== undefined && /^\d+$/.test(startTime) ? startTime : null
}

/**
 * Ticks since boot restart at every boot, and so do pids, so the pair repeats
 * across reboots. The boot id makes a token from a previous boot fail to match
 * rather than match the wrong process.
 */
function readLinuxIdentity(pid: number, deps: ProcessIdentityDeps): string | null {
  const startTime = readLinuxStartTime(pid, deps)
  if (startTime === null) return null

  const bootId = deps.readTextFile('/proc/sys/kernel/random/boot_id')?.trim()
  return `linux:${bootId ?? 'unknown-boot'}:${pid}:${startTime}`
}

function readDarwinIdentity(pid: number, deps: ProcessIdentityDeps): string | null {
  // lstart is an absolute wall-clock start time, so it needs no boot anchor.
  const started = deps.runCommand('ps', ['-o', 'lstart=', '-p', String(pid)])
  if (started === null || started === '') return null
  return `darwin:${pid}:${started.replace(/\s+/g, ' ')}`
}

function readWindowsIdentity(pid: number, deps: ProcessIdentityDeps): string | null {
  const started = deps.runCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
  ])
  if (started === null || !/^\d+$/.test(started)) return null
  return `win32:${pid}:${started}`
}

/**
 * An opaque token identifying the process currently holding this pid, or null
 * when it cannot be determined — because the process is gone, or because this
 * platform gave no usable answer.
 *
 * Null is never an invitation to fall back to the pid alone. A caller that
 * cannot verify must decline to act.
 */
export function readProcessStartToken(
  pid: number,
  deps: ProcessIdentityDeps = createDefaultDeps(),
): string | null {
  // 0 and negatives address a process group, which has no single start time.
  if (!Number.isInteger(pid) || pid <= 0) return null

  const raw = deps.platform === 'linux'
    ? readLinuxIdentity(pid, deps)
    : deps.platform === 'win32'
      ? readWindowsIdentity(pid, deps)
      : readDarwinIdentity(pid, deps)

  if (raw === null) return null
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

/**
 * Whether this pid is still the process a recorded token was taken from.
 *
 * `unknown` is deliberately not folded into `different`. Both mean "do not
 * signal", so the decision is the same, but the caller has to explain itself to
 * a user staring at a process that is still running, and "we cannot tell" and
 * "that is somebody else's process now" send them to different places.
 */
export type ProcessMatch =
  | { kind: 'same' }
  | { kind: 'different' }
  | { kind: 'unknown', reason: string }

export function matchProcess(
  pid: number,
  recordedToken: string | undefined,
  deps?: ProcessIdentityDeps,
): ProcessMatch {
  if (recordedToken === undefined || recordedToken === '') {
    return { kind: 'unknown', reason: 'no start-identity token was recorded for it' }
  }

  const current = readProcessStartToken(pid, deps ?? createDefaultDeps())
  if (current === null) {
    return { kind: 'unknown', reason: 'this platform cannot report when a process started' }
  }
  return current === recordedToken ? { kind: 'same' } : { kind: 'different' }
}

/**
 * True only when this pid is still the process the token was taken from.
 *
 * False for every uncertainty: no token was recorded, the process is gone, or
 * this platform cannot say. The caller is about to signal something, so the
 * unverifiable case must be indistinguishable from a mismatch.
 */
export function isSameProcess(
  pid: number,
  recordedToken: string | undefined,
  deps?: ProcessIdentityDeps,
): boolean {
  return matchProcess(pid, recordedToken, deps).kind === 'same'
}
