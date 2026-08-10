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

/**
 * Windows gets its own, far larger bound.
 *
 * `/proc` is a file read and `ps` is a tiny static binary; both answer in
 * single-digit milliseconds. Windows has no equivalent, so the answer costs a
 * whole PowerShell start — around a second on a hosted CI runner, and several
 * under load. At the shared 5s bound that turned into an intermittent `null`,
 * which every caller is required to read as "cannot verify": a suspended daemon
 * looked unverifiable, and an expired heartbeat was then enough to let a second
 * daemon reclaim a lock its owner was still holding.
 *
 * Bounding it at 20s does not make the lookup fast. It makes a slow answer a
 * slow answer instead of a wrong one, which is the only distinction the callers
 * of this module can act on.
 */
const WINDOWS_COMMAND_TIMEOUT_MS = 20_000

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
          timeout: process.platform === 'win32' ? WINDOWS_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
          windowsHide: true,
        }).trim()
      } catch {
        return null
      }
    },
  }
}

const defaultDeps = createDefaultDeps()

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

/**
 * The one thing PowerShell is asked, written without a single double quote.
 *
 * `execFileSync` escapes an argument containing `"` as `\"`, and PowerShell's
 * own command-line parser does not agree with that convention — the script
 * arrives mangled and the answer comes back empty. Single quotes throughout
 * sidestep the disagreement rather than trying to win it.
 *
 * CIM is asked first because it answers for processes this user does not own,
 * where `Get-Process(...).StartTime` throws Access Denied — and a lock owner is
 * exactly the process most likely to belong to somebody else. `Get-Process` is
 * the fallback for a host where the CIM service is not answering. Both are
 * normalised to UTC ticks, so the two sources cannot disagree about a machine
 * that changed timezone or crossed a DST boundary since the token was written.
 */
function windowsStartTimeScript(pid: number): string {
  return [
    '$ErrorActionPreference=\'SilentlyContinue\'',
    `$c=Get-CimInstance Win32_Process -Filter ('ProcessId=' + ${pid})`,
    'if ($c -and $c.CreationDate) { $c.CreationDate.ToUniversalTime().Ticks; exit 0 }',
    `$p=Get-Process -Id ${pid}`,
    'if ($p) { try { $p.StartTime.ToUniversalTime().Ticks } catch { } }',
  ].join('; ')
}

/**
 * The first line of output that is a bare integer.
 *
 * PowerShell may prepend a byte-order mark, ends its lines with CRLF, and — on
 * a host where the first query failed — can emit a warning before the number.
 * A stricter parser read all of those as "this platform cannot say", which is
 * the answer that makes callers refuse to act. `trim` covers the BOM as well as
 * the CR, since U+FEFF counts as whitespace to it.
 */
function parseWindowsTicks(output: string | null): string | null {
  if (output === null) return null

  for (const line of output.split(/\r?\n/)) {
    const candidate = line.trim()
    if (/^\d+$/.test(candidate)) return candidate
  }
  return null
}

function readWindowsIdentity(pid: number, deps: ProcessIdentityDeps): string | null {
  const ticks = parseWindowsTicks(deps.runCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    windowsStartTimeScript(pid),
  ]))
  if (ticks === null) return null
  return `win32:${pid}:${ticks}`
}

/**
 * This process's own token, computed once.
 *
 * Only ever our own pid: a token is (pid, start time), and for any *other* pid
 * both halves can change between two calls, so a cache there would answer
 * `same` about a process that had exited and had its number reissued — the one
 * mistake this module exists to prevent. Our own pid cannot be reissued while
 * we are the one asking, so the answer is immutable for as long as the cache
 * lives.
 *
 * Worth caching because the Windows lookup costs a PowerShell start, and the
 * hot callers ask about themselves repeatedly: every contention check on the
 * single-instance lock reads the asker's identity. A failure is not cached —
 * null means "could not tell this time", and a transient one must not become
 * this process's permanent answer.
 */
let selfToken: string | null = null

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
  deps: ProcessIdentityDeps = defaultDeps,
): string | null {
  // 0 and negatives address a process group, which has no single start time.
  if (!Number.isInteger(pid) || pid <= 0) return null

  // Injected deps describe an invented machine, so the real answer about this
  // process is neither what they mean nor safe to seed the cache from.
  const cacheable = deps === defaultDeps && pid === process.pid
  if (cacheable && selfToken !== null) return selfToken

  const raw = deps.platform === 'linux'
    ? readLinuxIdentity(pid, deps)
    : deps.platform === 'win32'
      ? readWindowsIdentity(pid, deps)
      : readDarwinIdentity(pid, deps)

  if (raw === null) return null
  const token = createHash('sha256').update(raw).digest('hex').slice(0, 32)
  if (cacheable) selfToken = token
  return token
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

  const current = readProcessStartToken(pid, deps ?? defaultDeps)
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
