import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { isProcessAlive, killProcessTree } from '../cli/processControl'
import { planProgramLaunch, resolveTrustedExecutable } from '../lib/executablePath'
import { createChildEnvironment } from '../lib/childEnvironment'
import { matchProcess, readProcessStartToken } from '../lib/processIdentity'
import { captureProcessGroup, hasCapturedProcessGroupMember, refreshProcessGroup, terminateProcessTree, type ProcessGroupSnapshot } from '../lib/processTree'
import { getErrorMessage } from '@shared/typeGuards'
import { hasOpenCodePassword, withOpenCodePasswordAliases } from '../../shared/opencodeAuth'
import { probeOpenCodeConnection, invalidateOpenCodeConnection, OpenCodeConnectionError } from './connection'

/** Attempts after a crash before the daemon stops trying and reports degraded. */
export const MAX_RESTART_ATTEMPTS = 3

const READY_TIMEOUT_MS = 30_000

/** Backoff between restart attempts, multiplied by the attempt number. */
const RESTART_BACKOFF_MS = 1_000

/**
 * How long a terminated OpenCode gets to exit on its own before it is killed,
 * and how long the kill itself gets to take effect.
 *
 * Both are bounded because the daemon awaits them during shutdown: the whole
 * point of waiting is that the lock outlives the process it protects, and a wait
 * with no ceiling would trade one hang for another.
 */
const GRACEFUL_EXIT_MS = 5_000
const FORCE_EXIT_MS = 5_000

/**
 * Windows has no process-group probe. A leader that disappeared is therefore
 * not enough to prove that its descendants are gone; only a successful,
 * completed taskkill tree operation supplies that boundary.
 */
const windowsTreeTermination = new Map<string, boolean>()
const windowsHandleTreeProof = new WeakSet<ChildProcess>()

function windowsTreeKey(pid: number, expectedStartToken: string): string {
  return `${pid}\u0000${expectedStartToken}`
}

function childHasExited(child: ChildProcess): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined)
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (childHasExited(child)) return true
    await delay(50)
  }
  return childHasExited(child)
}

async function waitForTreeCommand(command: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (command.exitCode !== null && command.exitCode !== undefined) return command.exitCode === 0
  return new Promise<boolean>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { command.kill() } catch { /* already gone */ }
      resolve(false)
    }, timeoutMs)
    const finish = (success: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(success)
    }
    command.once('exit', (code) => finish(code === 0))
    command.once('error', () => finish(false))
  })
}

export type OpenCodeStatus =
  | { kind: 'adopted'; baseUrl: string }
  | { kind: 'managed'; baseUrl: string; pid: number }
  | { kind: 'mock' }
  | { kind: 'degraded'; baseUrl: string; reason: string }

export class OpenCodeMissingError extends Error {
  /**
   * `refusal` is set when an `opencode` *was* found and the resolver would not
   * run it. The error stays the same class — it degrades exactly as a missing
   * binary does — but "not on PATH, install it" is the wrong thing to tell
   * someone whose OpenCode is installed in a directory this machine refuses.
   */
  constructor(baseUrl: string, refusal?: string) {
    super(refusal === undefined
      ? `OpenCode is not running at ${baseUrl} and the \`opencode\` command is not on PATH.\n`
        + 'Install it from https://opencode.ai, or start it yourself with `opencode serve`.'
      : `OpenCode is not running at ${baseUrl}, and the \`opencode\` that was found will not be run: ${refusal}\n`
        + 'Start it yourself with `opencode serve`, or move it somewhere owned by you or by root.')
    this.name = 'OpenCodeMissingError'
  }
}

/**
 * Everything the supervisor needs in order to end a process tree, named by what
 * it accomplishes rather than by how any one platform accomplishes it.
 *
 * The signals themselves are not portable. POSIX ends a tree by signalling a
 * negative pid; Windows has no process groups to signal and needs `taskkill /T`
 * to walk the real child tree. Code written against `process.kill(-pid)` is code
 * that only terminates OpenCode on two of the three platforms this ships to —
 * and tests written against it assert a POSIX implementation detail, so they fail
 * on Windows for describing the wrong machine rather than for finding a bug.
 */
export interface ProcessTermination {
  /**
   * Asks the tree to exit. False when this platform cannot ask — Windows has no
   * SIGTERM — or the identity no longer proves a live target, which sends the
   * caller straight to `force`; an already-gone leader is stopped only when
   * the platform also proves that its owned tree is gone.
   */
  request(pid: number, expectedStartToken: string | null): boolean
  /** Ends the tree outright. */
  force(pid: number, expectedStartToken: string | null): Promise<void>
  /** Whether the process is gone. */
  hasExited(pid: number, expectedStartToken: string | null): boolean
}

function matchesExpectedProcess(pid: number, expectedStartToken: string | null): boolean {
  if (expectedStartToken === null || !isProcessAlive(pid)) return false
  return matchProcess(pid, expectedStartToken).kind === 'same'
}

/** Signal 0 probes whether a POSIX process group still has a member. */
function isProcessGroupAlive(pid: number): boolean {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    // Only ESRCH proves that the group is gone. EPERM and every unexpected
    // probe failure leave ownership unknown, so shutdown must keep the lock.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const capturedGroups = new Map<string, ProcessGroupSnapshot>()

function capturedGroupKey(pid: number, expectedStartToken: string): string {
  return `${pid}\u0000${expectedStartToken}`
}

export const defaultTermination: ProcessTermination = {
  request(pid, expectedStartToken) {
    if (process.platform === 'win32' || expectedStartToken === null) return false
    if (!matchesExpectedProcess(pid, expectedStartToken)) return false
    const key = capturedGroupKey(pid, expectedStartToken)
    const captured = captureProcessGroup(pid, 'linux', expectedStartToken)
    if (captured !== null) capturedGroups.set(key, captured)
    try {
      // Negative pid signals the group, so OpenCode's own children go too.
      process.kill(-pid, 'SIGTERM')
      return true
    } catch {
      // The group may not exist for a foreground launch. Revalidate the
      // original process before falling back to a direct signal: the pid may
      // have exited and been reused while the group signal was attempted.
      if (!matchesExpectedProcess(pid, expectedStartToken)) return false
      try {
        process.kill(pid, 'SIGTERM')
        return true
      } catch {
        return false
      }
    }
  },
  async force(pid, expectedStartToken) {
    if (expectedStartToken !== null) {
      const key = capturedGroupKey(pid, expectedStartToken)
      const captured = capturedGroups.get(key)
      if (captured !== undefined && !isProcessAlive(pid)) {
        if (hasCapturedProcessGroupMember(captured)) {
          try { process.kill(-captured.groupId, 'SIGKILL') } catch { /* best effort */ }
        }
        return
      }
    }
    const proven = await killProcessTree(pid, expectedStartToken)
    if (process.platform === 'win32' && expectedStartToken !== null) {
      windowsTreeTermination.set(windowsTreeKey(pid, expectedStartToken), proven)
    }
  },
  hasExited: (pid, expectedStartToken) => {
    if (isProcessAlive(pid)) {
      // A live replacement is no longer ours. Treat it as exited from this
      // supervisor's point of view; force() is still guarded and will refuse it.
      // An unknown identity is not confirmation: shutdown reports that stop was
      // unverified instead of silently claiming the process is gone.
      if (expectedStartToken === null) return false
      const kind = matchProcess(pid, expectedStartToken).kind
      if (kind === 'different') {
        const key = capturedGroupKey(pid, expectedStartToken)
        const captured = capturedGroups.get(key)
        if (process.platform === 'win32') {
          const key = windowsTreeKey(pid, expectedStartToken)
          const proven = windowsTreeTermination.get(key) === true
          if (proven) windowsTreeTermination.delete(key)
          capturedGroups.delete(key)
          return proven
        }
        // A recycled leader proves only that the original leader is gone. If
        // a detached group was captured, require its own absence; otherwise
        // there is no evidence that surviving descendants are not still ours.
        if (captured !== undefined) {
          try {
            process.kill(-captured.groupId, 0)
            return false
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              capturedGroups.delete(key)
              return true
            }
            return false
          }
        }
        return false
      }
      const captured = capturedGroups.get(capturedGroupKey(pid, expectedStartToken))
      if (kind === 'same' && captured !== undefined) {
        capturedGroups.set(capturedGroupKey(pid, expectedStartToken), refreshProcessGroup(captured))
      }
      return false
    }

    // A detached POSIX child can exit while its descendants keep the process
    // group alive. Do not release the daemon lock until that group is gone.
    // Tokenless cleanup owns only the direct ChildProcess handle, so it cannot
    // safely infer ownership of a numeric group here.
    if (expectedStartToken === null) return false
    if (process.platform === 'win32') {
      const key = windowsTreeKey(pid, expectedStartToken)
      const proven = windowsTreeTermination.get(key) === true
      if (proven) windowsTreeTermination.delete(key)
      return proven
    }
    const key = capturedGroupKey(pid, expectedStartToken)
    const captured = capturedGroups.get(key)
    const alive = captured === undefined
      ? isProcessGroupAlive(pid)
      : hasCapturedProcessGroupMember(captured)
    if (!alive) capturedGroups.delete(key)
    return !alive
  },
}

interface ManagedChild {
  process: ChildProcess
  pid: number
  startToken: string | null
}

export interface OwnedOpenCodeProcess {
  pid: number
  startToken: string | null
}

export interface OpenCodeSupervisorOptions {
  baseUrl: string
  mock?: boolean
  /** Pass full DEBUG output through stdout/stderr for a managed server. */
  printLogs?: boolean
  /** Injected by tests so no real process is spawned. */
  spawnProcess?: typeof spawn
  /**
   * Where `opencode` is, injected by tests alongside `spawnProcess`.
   *
   * The suite describes what a launch does; it must not also require OpenCode
   * to be installed on the machine running it, which resolving for real would.
   */
  resolveProgram?: (name: string) => string | null
  probe?: (baseUrl: string) => Promise<boolean>
  /**
   * Injected by tests, which hold fake children carrying invented pids. Real
   * termination would otherwise aim at whatever process happens to hold that
   * number on the machine running the suite.
   */
  termination?: ProcessTermination
  /** Injected by tests, so a launch that never comes up fails in milliseconds. */
  readyTimeoutMs?: number
  /** Injected by tests, so the restart budget is spent in milliseconds. */
  restartBackoffMs?: number
  /** Injected by tests, so termination escalates without real waiting. */
  exitBudgets?: { gracefulMs: number; forceMs: number }
  /**
   * Reports every status change after start() has returned: a crash, a restart
   * onto a new pid, or the point where the supervisor gives up.
   *
   * The daemon writes its state file once, from the status start() returned. A
   * server that dies an hour later, or comes back under a different pid, leaves
   * that record describing something that is no longer true — and it is the
   * record `clean` reaps orphans from.
   */
  onStatusChange?: (status: OpenCodeStatus) => void
}

export async function probeOpenCode(baseUrl: string): Promise<boolean> {
  try {
    await probeOpenCodeConnection(baseUrl)
    return true
  } catch {
    return false
  }
}

/**
 * Runs OpenCode for the daemon's lifetime.
 *
 * An already-running server is adopted, never restarted and never stopped: it
 * may belong to another tool or hold work we know nothing about. Only a server
 * this supervisor started is ours to terminate.
 */
export class OpenCodeSupervisor {
  private child: ManagedChild | null = null
  private status: OpenCodeStatus
  private restartAttempts = 0
  private stopping = false
  /** Gates change reports: start() hands its result back to the caller instead. */
  private startReported = false

  constructor(private readonly options: OpenCodeSupervisorOptions) {
    this.status = options.mock ? { kind: 'mock' } : { kind: 'degraded', baseUrl: options.baseUrl, reason: 'not started' }
  }

  get current(): OpenCodeStatus {
    return this.status
  }

  /**
   * The direct handle still held for an owned process. This is deliberately a
   * small identity record rather than the ChildProcess itself: startup failure
   * evidence may outlive this supervisor, but it must never turn into a raw-pid
   * permission to signal an unrelated process.
   */
  get ownedProcess(): OwnedOpenCodeProcess | null {
    if (this.child === null) return null
    return { pid: this.child.pid, startToken: this.child.startToken }
  }

  private async probeState(): Promise<'ready' | 'absent' | 'starting'> {
    if (this.options.probe) return await this.options.probe(this.options.baseUrl) ? 'ready' : 'absent'
    try {
      await probeOpenCodeConnection(this.options.baseUrl)
      return 'ready'
    } catch (error) {
      if (error instanceof OpenCodeConnectionError && error.failureKind === 'network') {
        if (error.canStartManagedServer) return 'absent'
        if (error.status !== undefined) return 'starting'
      }
      throw error
    }
  }

  /**
   * Records a status and tells the host, once there is a host to tell. A
   * listener that throws is swallowed: reporting a crash must not turn into a
   * second one.
   */
  private setStatus(status: OpenCodeStatus): void {
    this.status = status
    if (!this.startReported) return
    try {
      this.options.onStatusChange?.(status)
    } catch {
      // The status is already recorded; a bad listener changes nothing here.
    }
  }

  async start(): Promise<OpenCodeStatus> {
    if (this.options.mock) {
      this.status = { kind: 'mock' }
      this.startReported = true
      return this.status
    }

    invalidateOpenCodeConnection(this.options.baseUrl)
    const initial = await this.probeState()
    if (initial === 'ready') {
      this.status = { kind: 'adopted', baseUrl: this.options.baseUrl }
      this.startReported = true
      return this.status
    }

    // An HTTP response proves another process owns the address. Give a server
    // that is still booting time to become healthy; never launch over it.
    if (initial === 'starting') {
      await this.waitForHealth()
      this.status = { kind: 'adopted', baseUrl: this.options.baseUrl }
      this.startReported = true
      return this.status
    }

    this.status = await this.spawnAndWait()
    this.startReported = true
    return this.status
  }

  private async spawnAndWait(): Promise<OpenCodeStatus> {
    invalidateOpenCodeConnection(this.options.baseUrl)
    // A failed launch keeps its handle until termination is confirmed. Do not
    // overwrite that ownership with a restart attempt while the old process
    // may still hold the port.
    if (this.child) {
      const previous = this.child
      if (!await this.terminate(previous.process, previous.startToken)) {
        throw new Error(`OpenCode process ${previous.pid} is still running at ${this.options.baseUrl}.`)
      }
      if (this.child?.process === previous.process) this.child = null
    }

    const url = new URL(this.options.baseUrl)
    const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    // A parsed URL does not make a hostname safe: `new URL('http://foo&bar:1')`
    // has the hostname `foo&bar`, and on Windows an npm-installed OpenCode is
    // started through cmd.exe. The launcher escapes every argument for cmd.exe,
    // so this is not what stands between a URL and a second command any more;
    // it is the plainer rule that a host name, an IPv4 address or a bracketed
    // IPv6 one is all this can be.
    if (!/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/.test(host)) {
      throw new Error(`OpenCode's address has a host name LoopTroop will not start a server for: ${JSON.stringify(host)}. Check LOOPTROOP_OPENCODE_BASE_URL.`)
    }
    const spawnProcess = this.options.spawnProcess ?? spawn

    this.ensureManagedAuthentication()

    const logArgs = this.options.printLogs ? ['--print-logs', '--log-level', 'DEBUG'] : []
    const serveHost = host.startsWith('[') ? host.slice(1, -1) : host
    const argv = ['serve', ...logArgs, '--hostname', serveHost, '--port', port]

    // Resolved rather than left to `PATH`. The resolver applies PATHEXT itself,
    // which is what the Windows shell used to be here for: `opencode` is only
    // an `.exe` when it came from the official installer or Scoop, and installed
    // with npm, bun or pnpm it is `opencode.cmd`, which `CreateProcess` cannot
    // find because it appends `.exe` and ignores PATHEXT. Every Windows user who
    // installed OpenCode from npm used to get `OpenCodeMissingError` for a
    // server sitting on their PATH.
    //
    // An unresolvable `opencode` raises the same error a missing one already
    // does, so nothing that used to degrade becomes a new kind of failure.
    let program: string | null
    let refusal: string | undefined
    if (this.options.resolveProgram) {
      program = this.options.resolveProgram('opencode')
    } else {
      const resolution = resolveTrustedExecutable('opencode')
      program = resolution.path ?? null
      refusal = resolution.refusedAt === undefined ? undefined : resolution.reason
    }
    if (program === null) throw new OpenCodeMissingError(this.options.baseUrl, refusal)

    // Node has refused to launch a `.cmd` or `.bat` directly since the BatBadBut
    // hardening, so an npm-installed OpenCode still goes through cmd.exe — one
    // the resolver found, not one `shell: true` would have Node look up, with
    // the shim's path and every argument escaped by the launcher the rest of
    // LoopTroop uses. On any other platform, and for a real `.exe`, it is a
    // direct spawn. The test seam answers for cmd.exe as well as for OpenCode.
    const seam = this.options.resolveProgram
    const launch = planProgramLaunch(program, argv, seam === undefined ? {} : {
      resolveInterpreter: () => {
        const interpreter = seam('cmd.exe')
        return interpreter === null ? { reason: 'cmd.exe was not found.' } : { path: interpreter }
      },
    })
    if (launch.reason !== undefined) throw new OpenCodeMissingError(this.options.baseUrl, launch.reason)
    const child = spawnProcess(launch.file, launch.args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: createChildEnvironment(process.env),
      // Its own group, so terminating the daemon can take the whole tree down
      // rather than orphaning children of OpenCode.
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    })
    const pid = child.pid
    // Capture the identity at spawn time. A pid alone can be recycled while a
    // health wait or shutdown is in progress, so every later termination check
    // must compare against this original token rather than infer one late.
    // A supplied spawn seam is test-only; its invented pids must never reach a
    // real PowerShell/ps identity probe (or a real termination target).
    const startToken = pid === undefined || this.options.spawnProcess === undefined
      ? (pid === undefined ? null : readProcessStartToken(pid))
      : null

    const spawnFailed = new Promise<never>((_, reject) => {
      child.once('error', () => reject(new OpenCodeMissingError(this.options.baseUrl)))
    })

    // An immediate exit almost always means the binary is missing — including
    // through cmd.exe above, where a shim whose target is gone is not a spawn
    // error at all: cmd.exe starts, prints "is not recognized" and exits 9009.
    const exitedEarly = new Promise<never>((_, reject) => {
      child.once('exit', (code) => {
        if (!this.stopping) reject(new OpenCodeMissingError(this.options.baseUrl))
        else reject(new Error(`OpenCode exited with code ${code ?? 'unknown'}`))
      })
    })

    // Assigned before the wait, so a stop() arriving mid-launch still finds the
    // child. Everything that can go wrong from here leaves a process running
    // that nobody has a handle to unless this is cleaned up on the way out.
    this.child = pid === undefined ? null : { process: child, pid, startToken }

    try {
      await Promise.race([this.waitForHealth(), spawnFailed, exitedEarly])
    } catch (error) {
      // A launch that never came up is the case that leaks: the binary is alive
      // and unresponsive, and the throw unwinds past every caller that could
      // have stopped it. `opencode serve` also holds the port, so the next
      // start would adopt this broken process rather than replace it.
      const terminated = await this.terminate(child, startToken)
      if (terminated && this.child?.process === child) this.child = null
      throw error
    }

    child.removeAllListeners('exit')
    child.once('exit', () => {
      // Keep the handle until terminate() proves the whole tree is gone. A
      // healthy leader can exit while a descendant still owns the port;
      // dropping it here would make stop() report success and release the
      // daemon lock on leader exit alone. The restart path uses the same
      // retained handle and either proves cleanup or stays degraded.
      void this.handleUnexpectedExit()
    })

    // On Windows this is the cmd.exe wrapper's pid rather than OpenCode's, and
    // that is safe on every use it is put to: `cmd /c` waits for the command it
    // ran, so liveness and the exit event still describe OpenCode, and both stop
    // paths escalate to `killProcessTree`, which is `taskkill /T` and reaches
    // through the wrapper. Only `status` is affected, where it is the pid of the
    // process LoopTroop actually started.
    // A child with no pid never started. Recording 0 produced a status that
    // claimed a live managed server, while `isProcessAlive(0)` is false and no
    // stop path could ever reach it.
    if (pid === undefined) {
      this.child = null
      child.kill('SIGKILL')
      throw new Error('OpenCode process was started but reported no process id.')
    }

    return { kind: 'managed', baseUrl: this.options.baseUrl, pid }
  }

  private async waitForHealth(): Promise<void> {
    const timeout = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try {
        if (await this.probeState() === 'ready') return
      } catch (error) {
        if (!(error instanceof OpenCodeConnectionError) || error.failureKind !== 'network') throw error
      }
      await delay(250)
    }
    throw new Error(`OpenCode did not become reachable at ${this.options.baseUrl} within ${timeout / 1000}s.`)
  }

  private ensureManagedAuthentication(): void {
    withOpenCodePasswordAliases(process.env)
    if (!hasOpenCodePassword(process.env)) {
      const password = randomBytes(32).toString('base64url')
      process.env.OPENCODE_PASSWORD = password
      process.env.OPENCODE_SERVER_PASSWORD = password
    }
  }

  /**
   * Restarts a crashed server, up to the documented budget, then gives up.
   *
   * The budget counts attempts, not deaths. An earlier version incremented on
   * each unexpected exit and degraded the moment one relaunch threw, so a server
   * whose binary was broken got exactly one attempt while a server that started
   * cleanly and crashed again got three — the opposite of what the policy says,
   * and the case where retrying actually helps is the first one. A failed launch
   * and a launch that succeeds and dies again now cost the same: one attempt.
   */
  private async handleUnexpectedExit(): Promise<void> {
    if (this.stopping) return

    const backoff = this.options.restartBackoffMs ?? RESTART_BACKOFF_MS

    while (this.restartAttempts < MAX_RESTART_ATTEMPTS) {
      this.restartAttempts += 1
      const attempt = this.restartAttempts

      console.error(`[opencode] Exited unexpectedly; restarting (attempt ${attempt}/${MAX_RESTART_ATTEMPTS}).`)
      await delay(backoff * attempt)

      // The wait above is long enough for a shutdown to have started meanwhile,
      // and a restart then would spawn a server nothing is left to stop.
      if (this.stopping) return

      try {
        // Through setStatus, because a restart lands on a new pid: the daemon's
        // record still names the process that just died, which is the one thing
        // `clean` must not go looking for later.
        this.setStatus(await this.spawnAndWait())
        return
      } catch (error) {
        // Reported after every attempt, not only the last: a daemon that spends
        // the next several seconds retrying should not still be describing the
        // server that already died.
        this.setStatus({
          kind: 'degraded',
          baseUrl: this.options.baseUrl,
          reason: getErrorMessage(error),
        })
        console.error(`[opencode] Restart attempt ${attempt} failed: ${this.describeStatusReason()}`)
      }
    }

    // Retrying forever would hide a broken install behind a restart loop.
    this.setStatus({
      kind: 'degraded',
      baseUrl: this.options.baseUrl,
      reason: `OpenCode exited ${MAX_RESTART_ATTEMPTS} times; giving up. Coding operations are unavailable.`,
    })
    console.error(`[opencode] ${this.describeStatusReason()}`)
  }

  private describeStatusReason(): string {
    return this.status.kind === 'degraded' ? this.status.reason : 'unknown'
  }

  /**
   * Ends a child this supervisor spawned, and does not return until it is gone
   * or the budget for making it go is spent.
   *
   * Awaiting matters because of what the caller does next. `stop()` runs during
   * daemon shutdown, immediately before the daemon releases its single-instance
   * lock and clears its state file — so a fire-and-forget signal means the next
   * `looptroop start` can acquire the lock while the previous OpenCode is still
   * alive and still holding its port. The new daemon then adopts that server as
   * though it were somebody else's, and it never gets stopped by anyone.
   *
   * Separate from stop() because a launch that never became healthy needs the
   * same treatment: it is a real `opencode serve`, holding the port, and by then
   * the status says `degraded` rather than `managed`.
   */
  private async terminate(child: ChildProcess, expectedStartToken: string | null): Promise<boolean> {
    const pid = child.pid
    if (pid === undefined) return true

    const termination = this.options.termination ?? defaultTermination
    const budgets = this.options.exitBudgets ?? { gracefulMs: GRACEFUL_EXIT_MS, forceMs: FORCE_EXIT_MS }

    // A tokenless handle is not proof for a numeric pid once its leader has
    // exited. Let the injected termination seam answer in tests; the default
    // implementation remains conservative when no tree proof exists.
    if (expectedStartToken === null && childHasExited(child)) {
      if (windowsHandleTreeProof.has(child)) return true
      return termination.hasExited(pid, null)
    }

    // A null token is not proof for a numeric pid, but this ChildProcess is a
    // handle to the process this supervisor spawned. On Windows the returned
    // taskkill handle must finish successfully before leader exit is accepted
    // as tree cleanup; a direct kill alone can orphan descendants.
    if (expectedStartToken === null && process.platform === 'win32'
      && termination === defaultTermination && typeof child.kill === 'function') {
      const gracefulTree = terminateProcessTree(child, 'SIGTERM', 'windows')
      if (gracefulTree !== undefined && await waitForTreeCommand(gracefulTree, budgets.gracefulMs)) {
        windowsHandleTreeProof.add(child)
        if (await waitForChildExit(child, budgets.gracefulMs)) return true
      }

      const forceTree = terminateProcessTree(child, 'SIGKILL', 'windows')
      if (forceTree !== undefined && await waitForTreeCommand(forceTree, budgets.forceMs)) {
        windowsHandleTreeProof.add(child)
        if (await waitForChildExit(child, budgets.forceMs)) return true
      }

      console.error(`[opencode] pid ${pid} did not exit; it may still be holding ${this.options.baseUrl}.`)
      return false
    }

    if (expectedStartToken === null && typeof child.kill === 'function') {
      try {
        if (process.platform === 'win32') terminateProcessTree(child, 'SIGTERM', 'windows')
        else child.kill('SIGTERM')
      } catch { /* best effort; the guarded path below may still know it is gone */ }
      if (await this.waitForExit(termination, pid, null, budgets.gracefulMs)) return true
      try {
        if (process.platform === 'win32') terminateProcessTree(child, 'SIGKILL', 'windows')
        else child.kill('SIGKILL')
      } catch { /* best effort */ }
      if (await this.waitForExit(termination, pid, null, budgets.forceMs)) return true
      console.error(`[opencode] pid ${pid} did not exit; it may still be holding ${this.options.baseUrl}.`)
      return false
    }

    if (termination.request(pid, expectedStartToken)
      && await this.waitForExit(termination, pid, expectedStartToken, budgets.gracefulMs)) return true

    await termination.force(pid, expectedStartToken)
    if (await this.waitForExit(termination, pid, expectedStartToken, budgets.forceMs)) return true

    // Reported rather than thrown here: the daemon owns the handle and must
    // retain its lock when the tree could not be verified as gone.
    console.error(`[opencode] pid ${pid} did not exit; it may still be holding ${this.options.baseUrl}.`)
    return false
  }

  private async waitForExit(
    termination: ProcessTermination,
    pid: number,
    expectedStartToken: string | null,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (termination.hasExited(pid, expectedStartToken)) return true
      await delay(50)
    }
    return termination.hasExited(pid, expectedStartToken)
  }

  /** Only ever stops a server this supervisor started. */
  async stop(): Promise<boolean> {
    this.stopping = true
    const child = this.child

    if (child === null) return true

    // Ownership is the child handle, not the status. A launch that timed out
    // or a restart that failed leaves the status `degraded` while the process
    // is still running — gating on `managed` orphaned exactly those. An adopted
    // server never sets a child in the first place, so it stays out of reach.
    if (await this.terminate(child.process, child.startToken)
      && this.child?.process === child.process) {
      this.child = null
    }
    return this.child?.process !== child.process
  }
}
