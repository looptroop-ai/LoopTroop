/**
 * The one place LoopTroop spawns `git` and `gh`.
 *
 * Every runner in the codebase used to be a local copy of the same six lines,
 * and the copies had drifted: some set a timeout, most did not; two set the
 * non-interactive environment, the rest let git open a credential prompt; one
 * raised `maxBuffer` to 16 MiB and the others inherited Node's 1 MiB, so the
 * same large diff succeeded in one phase and failed in another. A command with
 * no timeout that stops on a credential prompt or an unreachable remote holds
 * the daemon thread for as long as the prompt waits — which is forever — and
 * with it HTTP, SSE and every ticket actor.
 *
 * Two execution modes, and the choice is deliberate per call site:
 *
 * - **Async** (`runGit`, `runCommand`) for anything that talks to a network:
 *   `gh` API calls, `fetch`, `push`, `ls-remote`. These are the calls that can
 *   block for the entire timeout, so they must not sit on the event loop.
 * - **Sync** (`runGitSync`, `runCommandSync`) for bounded read-only plumbing —
 *   `rev-parse`, `status`, `diff`, and availability probes. These keep their
 *   callers synchronous because they only inspect local state.
 * - **Async mutations** (`runGitMutation`) for `add`, `commit`, `checkout`,
 *   `reset`, `merge`, `worktree`, and similar commands. Hooks, filters, LFS,
 *   and a large checkout can all take minutes even without a network, so these
 *   calls need the SIGTERM/SIGKILL timeout path too.
 *
 * A timeout bounds the wait but a synchronous call still blocks for its whole
 * duration, so on the sync path this turns a permanent freeze into a bounded
 * one rather than removing it.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { resolveTrustedProgram } from '../lib/executablePath'
import * as commandLogger from '../log/commandLogger'
import { terminateProcessTree } from '../lib/processTree'

/** Matches the timeout `server/git/repository.ts` has always used. */
export const GIT_DEFAULT_TIMEOUT_MS = 30_000

/** Local Git mutations may run hooks, filters, or a large checkout. */
export const GIT_MUTATION_TIMEOUT_MS = 5 * 60_000

/** Shared short probe budget for checking whether a command is installed. */
export const COMMAND_AVAILABILITY_TIMEOUT_MS = 5_000

/** The ceiling the established runner in `phases/execution/gitOps.ts` used. */
export const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024

/** How long a timed-out child gets to exit on SIGTERM before SIGKILL. */
const TIMEOUT_KILL_GRACE_MS = 2_000

/** How long after SIGKILL to wait for `close` before settling without it. */
const TIMEOUT_ABANDON_GRACE_MS = 2_000

/** Async commands outlive their caller unless shutdown owns their child too. */
const activeAsyncChildren = new Set<ChildProcess>()
const closedAsyncChildren = new WeakSet<ChildProcess>()
type WindowsTreeCleanup = 'pending' | 'succeeded' | 'failed'
const windowsTreeCleanup = new WeakMap<ChildProcess, WindowsTreeCleanup>()
let stoppingActiveChildren: Promise<void> | null = null

function childHasExited(child: ChildProcess): boolean {
  return closedAsyncChildren.has(child)
    || child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const taskkill = terminateProcessTree(child, signal)
  if (process.platform !== 'win32') return
  if (!taskkill) {
    windowsTreeCleanup.set(child, 'failed')
    return
  }
  windowsTreeCleanup.set(child, 'pending')
  taskkill.once('error', () => windowsTreeCleanup.set(child, 'failed'))
  taskkill.once('close', (status) => windowsTreeCleanup.set(child, status === 0 ? 'succeeded' : 'failed'))
}

function childCleanupConfirmed(child: ChildProcess): boolean {
  if (!childHasExited(child)) return false
  if (process.platform === 'win32') return windowsTreeCleanup.get(child) === 'succeeded'
  return !processGroupHasMembers(child)
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true)
  return new Promise((resolveWait) => {
    let settled = false
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('close', onClose)
      child.removeListener('error', onError)
      resolveWait(exited)
    }
    const onClose = () => finish(true)
    const onError = () => {
      // An error from a live child can mean signalling or pipe failure; it is
      // not proof that the process (or its descendants) has closed. A failed
      // spawn has no pid and is the only error that can prove absence here.
      if (!child.pid) finish(true)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('close', onClose)
    child.once('error', onError)
  })
}

/**
 * On POSIX, a detached child owns a process group. A close event only proves
 * that the group leader exited; checking the group lets a plain child settle
 * promptly while keeping a hook/filter descendant owned for reconciliation.
 * Windows has no equivalent that is safe to probe here, so it keeps the
 * conservative bounded wait.
 */
type ProcessGroupState = 'alive' | 'gone' | 'unknown'

function processGroupState(child: ChildProcess): ProcessGroupState {
  if (process.platform === 'win32' || !child.pid) return 'unknown'
  try {
    process.kill(-child.pid, 0)
    return 'alive'
  } catch (error) {
    // ESRCH proves that no member remains. EPERM and any unexpected platform
    // error do not prove absence, so keep the child owned by shutdown.
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown'
  }
}

function processGroupHasMembers(child: ChildProcess): boolean {
  return processGroupState(child) !== 'gone'
}

async function stopActiveChildrenNow(): Promise<void> {
  const children = [...activeAsyncChildren]
  if (!children.length) return

  const terminations = children.map((child) => waitForChildClose(child, TIMEOUT_KILL_GRACE_MS))
  for (const child of children) {
    // Once the leader has closed, its numeric pid can be reused. Do not send
    // a group signal without the start-token proof owned by the CLI layer.
    if (childHasExited(child)) continue
    try { signalProcessTree(child, 'SIGTERM') } catch { /* process already exited */ }
  }
  const exitedAfterTerm = await Promise.all(terminations)
  const survivors = children.filter((child, index) => !exitedAfterTerm[index] && activeAsyncChildren.has(child))
  if (!survivors.length) {
    for (const child of children) {
      if (activeAsyncChildren.has(child) && childCleanupConfirmed(child)) activeAsyncChildren.delete(child)
    }
    if (activeAsyncChildren.size > 0) {
      throw new Error(`Git command shutdown is incomplete: ${activeAsyncChildren.size} child process remains unverified.`)
    }
    return
  }

  const forceTerminations = survivors.map((child) => waitForChildClose(child, TIMEOUT_KILL_GRACE_MS))
  for (const child of survivors) {
    if (childHasExited(child)) continue
    try { signalProcessTree(child, 'SIGKILL') } catch { /* process already exited */ }
  }
  await Promise.all(forceTerminations)
  for (const child of survivors) {
    // A missing `close` is not proof that the process group is gone. Keep an
    // unresolved child owned by the shutdown drain so a later drain can retry
    // the group check instead of forgetting a possibly-live descendant.
    if (childCleanupConfirmed(child)) activeAsyncChildren.delete(child)
    child.unref()
  }
  if (activeAsyncChildren.size > 0) {
    throw new Error(`Git command shutdown is incomplete: ${activeAsyncChildren.size} child process remains unverified.`)
  }
}

/** Stop every detached async command currently owned by the daemon. */
export function stopActiveCommands(): Promise<void> {
  stoppingActiveChildren ??= stopActiveChildrenNow().finally(() => { stoppingActiveChildren = null })
  return stoppingActiveChildren
}

/**
 * Keeps git from blocking on interactive input.
 *
 * `GIT_TERMINAL_PROMPT=0` refuses the terminal prompt outright; `GIT_ASKPASS`
 * pointing at `echo` makes the graphical fallback answer with an empty string
 * instead of opening a dialog nobody is looking at.
 *
 * By absolute path on POSIX, because git looks a bare name up on `PATH`, and a
 * bare name is the search this module's callers stopped doing. A system without
 * `/bin/echo` (NixOS) gets an askpass that fails, which git treats as no answer
 * — the same outcome. Windows keeps the name: `echo` there is Git for Windows'
 * own `usr\bin\echo.exe`, found through the PATH git sets up for itself.
 */
export const NON_INTERACTIVE_GIT_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: process.platform === 'win32' ? 'echo' : '/bin/echo',
})

export interface RunCommandOptions {
  /** Defaults to `GIT_DEFAULT_TIMEOUT_MS`. There is no way to ask for none. */
  timeoutMs?: number
  /** Merged over `process.env` and the non-interactive git variables. */
  env?: NodeJS.ProcessEnv
  /** Defaults to `GIT_MAX_BUFFER_BYTES`. */
  maxBuffer?: number
  /** Written to the child's stdin, which is then closed. */
  input?: string
  cwd?: string
  /** Set false for probes that would otherwise flood the command log. */
  log?: boolean
  /**
   * Trims surrounding whitespace off `stdout`. On by default, because most
   * callers want the one value a command printed.
   *
   * **Set this false for NUL-delimited or column-aligned output.** A
   * `status --porcelain -z` record starts with a space when only the worktree
   * changed (` D path`), and trimming eats it — which shifts the whole record
   * and turns `hello.ts` into `ello.ts`.
   */
  trimOutput?: boolean
  /** Internal: let Git's configured core.sshCommand win over our fallback. */
  preserveCoreSshCommand?: boolean
}

interface RunOutcome<TOut> {
  ok: boolean
  status: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  stdout: TOut
  stderr: string
  /** Present when the process could not be spawned, timed out, or overran `maxBuffer`. */
  spawnError?: Error
  /**
   * What to put in front of a user when the call failed: the spawn error, else
   * the trimmed output, else the exit code. Undefined when `ok`.
   */
  errorDetail?: string
}

export type RunCommandResult = RunOutcome<string>
/** `stdout` left undecoded, for callers reading binary output such as `diff --binary`. */
export type RunCommandBinaryResult = RunOutcome<Buffer>

/** A mutation timed out before its process state was verified. */
export class RunCommandTimeoutError extends Error {
  readonly timedOut = true

  constructor(detail: string | undefined) {
    super(detail ?? 'The command timed out before its process state was verified.')
    this.name = 'RunCommandTimeoutError'
  }
}

// Tolerates partial vi.mock() factories that omit logCommand.
function logCmd(
  bin: string,
  args: string[],
  result:
    | { ok: true; stdin?: string; stdout?: string; stderr?: string }
    | { ok: false; error: string; stdin?: string; stdout?: string; stderr?: string },
) {
  commandLogger.logCommand?.(bin, args, result)
}

function buildEnv(extra: NodeJS.ProcessEnv | undefined, preserveCoreSshCommand = false): NodeJS.ProcessEnv {
  // `gh` shells out to git, so the non-interactive pair is applied to both.
  const env = { ...process.env, ...NON_INTERACTIVE_GIT_ENV, ...extra }
  // Preserve an explicitly configured SSH wrapper/command; otherwise make
  // Git's SSH transport fail closed instead of opening /dev/tty for prompts.
  // Check the values rather than property presence: callers sometimes carry
  // an `undefined` ProcessEnv key through a config merge, and Node omits that
  // key from the child environment anyway. An empty string remains an
  // intentional override, while undefined gets the safe default.
  if (!preserveCoreSshCommand
    && typeof env.GIT_SSH_COMMAND !== 'string'
    && typeof env.GIT_SSH !== 'string') {
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  }
  return env
}

function hasExplicitSshOverride(options: RunCommandOptions | undefined): boolean {
  const explicitEnvironment = options?.env
  return typeof explicitEnvironment?.GIT_SSH_COMMAND === 'string'
    || typeof explicitEnvironment?.GIT_SSH === 'string'
    || typeof process.env.GIT_SSH_COMMAND === 'string'
    || typeof process.env.GIT_SSH === 'string'
}

function timeoutMessage(bin: string, args: string[], timeoutMs: number): string {
  return `${bin} command timed out after ${timeoutMs / 1000}s: ${bin} ${args.join(' ')}`
}

interface RawOutcome<TOut> {
  status: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  stdout: TOut
  stderr: string
  spawnError?: Error
  timeoutDetail?: string
}

function finish<TOut>(
  raw: RawOutcome<TOut>,
  bin: string,
  args: string[],
  options: RunCommandOptions | undefined,
): RunOutcome<TOut> {
  const timeoutMs = options?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS
  const ok = !raw.timedOut && !raw.spawnError && raw.status === 0
  let errorDetail: string | undefined
  if (!ok) {
    if (raw.timedOut) {
      errorDetail = [timeoutMessage(bin, args, timeoutMs), raw.timeoutDetail].filter(Boolean).join(' ')
    } else if (raw.spawnError) {
      errorDetail = raw.spawnError.message
    } else {
      const stdout = typeof raw.stdout === 'string' ? raw.stdout : ''
      errorDetail = [stdout, raw.stderr].filter(Boolean).join(' | ') || `exit code ${raw.status ?? '?'}`
    }
  }
  const result: RunOutcome<TOut> = { ...raw, ok, errorDetail }

  if (options?.log !== false) {
    const stdout = typeof raw.stdout === 'string' ? raw.stdout : ''
    const stdin = options?.input?.trim() || undefined
    if (ok) {
      logCmd(bin, args, { ok: true, stdin, stdout: stdout || undefined, stderr: raw.stderr || undefined })
    } else {
      // The log records why the process ended; `errorDetail` also carries the
      // command's output, so the two strings differ on purpose.
      const error = raw.timedOut
        ? timeoutMessage(bin, args, timeoutMs)
        : raw.spawnError?.message ?? `exit code ${raw.status ?? '?'}`
      logCmd(bin, args, { ok: false, error, stdin, stdout: stdout || undefined, stderr: raw.stderr || undefined })
    }
  }
  return result
}

/**
 * True when Node killed the child for exceeding the timeout.
 *
 * Both a timeout and a `maxBuffer` overrun end as `SIGTERM` with a null exit
 * status, so the signal alone cannot tell them apart — only the error code can.
 */
function isTimeoutError(error: Error | undefined): boolean {
  return Boolean(error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT')
}

/**
 * The file `bin` names, or the outcome shape that says why it could not run.
 *
 * A tool that cannot be resolved has to look exactly like a tool that is not
 * installed, because to every caller here it is the same condition: `git` is
 * missing, `gh` is missing, and the call site's own fallback applies. Reporting
 * it as a spawn error does that — `finish` already turns one into
 * `ok: false` with the message in `errorDetail`, and the message here names the
 * directory and the override rather than saying ENOENT.
 */
function resolveBin(bin: string, options: RunCommandOptions | undefined): { path: string; failure?: undefined } | { path?: undefined; failure: Error } {
  // Against the environment the child will actually get. Resolving against
  // `process.env` while spawning with a caller's `env` let the two disagree:
  // a caller that narrowed PATH on purpose had it ignored.
  const resolution = resolveTrustedProgram(bin, { env: buildEnv(options?.env, options?.preserveCoreSshCommand) })
  return resolution.path === undefined ? { failure: new Error(resolution.reason) } : { path: resolution.path }
}

function unresolvedOutcome<TOut>(failure: Error, empty: TOut): RawOutcome<TOut> {
  return { status: null, signal: null, timedOut: false, stdout: empty, stderr: '', spawnError: failure }
}

function runSyncRaw(bin: string, args: string[], options: RunCommandOptions | undefined): RawOutcome<Buffer> {
  const resolved = resolveBin(bin, options)
  if (resolved.path === undefined) return unresolvedOutcome(resolved.failure, Buffer.alloc(0))

  let spawned: ReturnType<typeof spawnSync>
  try {
    spawned = spawnSync(resolved.path, args, {
      cwd: options?.cwd,
      input: options?.input,
      env: buildEnv(options?.env, options?.preserveCoreSshCommand),
      maxBuffer: options?.maxBuffer ?? GIT_MAX_BUFFER_BYTES,
      timeout: options?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
      // spawnSync blocks until the child exits and never escalates, so a child
      // that traps SIGTERM would defeat the timeout on this path too. There is
      // nothing to negotiate with a command that has already outrun its budget.
      killSignal: 'SIGKILL',
    })
  } catch (error) {
    return {
      status: null,
      signal: null,
      timedOut: false,
      stdout: Buffer.alloc(0),
      stderr: '',
      spawnError: error instanceof Error ? error : new Error(String(error)),
    }
  }
  // Asking spawnSync for Buffers rather than utf8 keeps one code path for both
  // output shapes; the string variant decodes below.
  const stdout = typeof spawned.stdout === 'string'
    ? Buffer.from(spawned.stdout)
    : (spawned.stdout ?? Buffer.alloc(0))
  return {
    status: spawned.status,
    signal: spawned.signal,
    timedOut: isTimeoutError(spawned.error ?? undefined),
    stdout,
    stderr: (spawned.stderr ?? Buffer.alloc(0)).toString('utf8').trim(),
    spawnError: spawned.error ?? undefined,
  }
}

function decode(stdout: Buffer, options: RunCommandOptions | undefined): string {
  const text = stdout.toString('utf8')
  return options?.trimOutput === false ? text : text.trim()
}

/** Local plumbing only. Blocks the event loop for up to `timeoutMs`. */
export function runCommandSync(bin: string, args: string[], options?: RunCommandOptions): RunCommandResult {
  const raw = runSyncRaw(bin, args, options)
  return finish({ ...raw, stdout: decode(raw.stdout, options) }, bin, args, options)
}

/** As `runCommandSync`, with stdout left undecoded for binary output. */
export function runCommandBinarySync(bin: string, args: string[], options?: RunCommandOptions): RunCommandBinaryResult {
  const raw = runSyncRaw(bin, args, options)
  return finish(raw, bin, args, options)
}

/**
 * The directory handed to `git -C`, or why it cannot be one.
 *
 * Every `runGit*` call uses a caller's path as its working directory, and
 * several of those paths trace back to a request. So it is held to what a
 * working directory has to be: a non-empty absolute path with no NUL in it.
 * Absolute is the rule that matters — a relative one would be read against the
 * daemon's own working directory, which is never the project anyone meant.
 *
 * A path that fails is reported the way a missing `git` is — `ok: false` with
 * the reason — and never thrown, because every caller already handles a failed
 * git command and none of them expects this function to raise. Ticket callers
 * obtain contained worktree paths from storage/paths against their project
 * root. This standalone runner also serves selected-folder inspection before
 * attachment, so it cannot require every directory to be an attached project.
 */
function gitWorkingDirectory(projectPath: string): { path: string; failure?: undefined } | { path?: undefined; failure: Error } {
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    return { failure: new Error('git needs a working directory, and none was given.') }
  }
  if (projectPath.includes('\0')) return { failure: new Error('A git working directory cannot contain a NUL byte.') }
  if (!isAbsolute(projectPath)) {
    return { failure: new Error(`A git working directory must be an absolute path, and '${projectPath}' is not.`) }
  }
  // Validated, not rewritten. `resolve('/repo')` on Windows is `D:\repo`, and
  // handing git a different string than the caller passed was a behaviour
  // change dressed as a check.
  return { path: projectPath }
}

/**
 * How a `runGit*` call reaches git: the directory as the working directory,
 * and the familiar `-C <dir>` form only in what is shown.
 *
 * The directory is not put in git's argument vector at all. `git -C <dir>` and
 * running git *in* `<dir>` are the same to git, and a caller's path that never
 * enters argv cannot be read as an option or an argument by anything — which is
 * what SonarCloud's S6350 was tracing from a request into `git -C`. The command
 * log and the error text keep showing `git -C <dir> …`, so nothing a person
 * reads changes.
 */
function gitInvocation(directory: string, args: string[], options: RunCommandOptions | undefined): {
  args: string[]
  displayArgs: string[]
  options: RunCommandOptions
} {
  let preserveCoreSshCommand = false
  if (!hasExplicitSshOverride(options)) {
    // GIT_SSH_COMMAND takes precedence over every Git config scope. Inspect
    // the effective config before adding our non-interactive fallback so a
    // repository's configured key, wrapper, or agent remains authoritative.
    const configured = runSyncRaw('git', ['config', '--get', 'core.sshCommand'], {
      ...options,
      cwd: directory,
      log: false,
      timeoutMs: Math.min(options?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS, COMMAND_AVAILABILITY_TIMEOUT_MS),
      preserveCoreSshCommand: false,
    })
    preserveCoreSshCommand = configured.status === 0 && configured.stdout.toString('utf8').trim().length > 0
  }
  return {
    args,
    displayArgs: ['-C', directory, ...args],
    options: { ...options, cwd: directory, preserveCoreSshCommand },
  }
}

/** Async counterpart to `gitInvocation`; config lookup must not block the event loop. */
async function gitInvocationAsync(directory: string, args: string[], options: RunCommandOptions | undefined): Promise<{
  args: string[]
  displayArgs: string[]
  options: RunCommandOptions
}> {
  let preserveCoreSshCommand = false
  if (!hasExplicitSshOverride(options)) {
    // GIT_SSH_COMMAND takes precedence over every Git config scope. Inspect
    // the effective config before adding our non-interactive fallback so a
    // repository's configured key, wrapper, or agent remains authoritative.
    // This is intentionally a fresh probe for every async invocation: config
    // can change while the daemon is running and a forever cache would turn a
    // later update into a silent transport failure.
    const configured = await runAsyncRaw('git', ['config', '--get', 'core.sshCommand'], {
      env: options?.env,
      cwd: directory,
      log: false,
      timeoutMs: Math.min(options?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS, COMMAND_AVAILABILITY_TIMEOUT_MS),
      preserveCoreSshCommand: false,
    })
    preserveCoreSshCommand = configured.status === 0 && configured.stdout.trim().length > 0
  }
  return {
    args,
    displayArgs: ['-C', directory, ...args],
    options: { ...options, cwd: directory, preserveCoreSshCommand },
  }
}

/**
 * A spawn that failed because the working directory is not there reads as
 * `spawnSync git ENOENT` — indistinguishable from git not being installed.
 *
 * Said as what it is: git never started. This used to borrow git's own
 * `cannot change to …` wording, which sent anyone searching for it into git's
 * sources for a message git never printed.
 */
function explainMissingDirectory<TOut>(raw: RawOutcome<TOut>, directory: string): RawOutcome<TOut> {
  const code = (raw.spawnError as NodeJS.ErrnoException | undefined)?.code
  if ((code !== 'ENOENT' && code !== 'ENOTDIR') || isDirectory(directory)) return raw
  return { ...raw, spawnError: new Error(`git was not started: its working directory ${directory} does not exist or is not a directory.`) }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function gitIndexLockPath(projectPath: string): string | null {
  const gitEntry = resolve(projectPath, '.git')
  try {
    const stat = lstatSync(gitEntry)
    if (stat.isDirectory()) return resolve(gitEntry, 'index.lock')
    if (!stat.isFile()) return null

    const gitdirLine = readFileSync(gitEntry, 'utf8').split(/\r?\n/).find((line) => /^gitdir:\s*/i.test(line))
    if (!gitdirLine) return null
    const gitdir = gitdirLine.replace(/^gitdir:\s*/i, '').trim()
    return gitdir ? resolve(projectPath, gitdir, 'index.lock') : null
  } catch {
    return null
  }
}

function explainTimedOutGit<TOut>(raw: RawOutcome<TOut>, projectPath: string): RawOutcome<TOut> {
  if (!raw.timedOut) return raw
  const lockPath = gitIndexLockPath(projectPath)
  if (!lockPath || !existsSync(lockPath)) return raw
  return {
    ...raw,
    timeoutDetail: `A timed-out git command left ${lockPath}; remove the lock only after confirming no git process is still running.`,
  }
}

/**
 * Runs git in `projectPath` synchronously, shown as `git -C <projectPath> <args>`.
 *
 * Never throws on a non-zero exit — each call site keeps its own contract for
 * that, and they differ on purpose (`hookDiscovery` returns null where
 * `repository` throws).
 */
export function runGitSync(projectPath: string, args: string[], options?: RunCommandOptions): RunCommandResult {
  const directory = gitWorkingDirectory(projectPath)
  if (directory.path === undefined) return finish(unresolvedOutcome(directory.failure, ''), 'git', args, options)
  const call = gitInvocation(directory.path, args, options)
  const raw = explainTimedOutGit(
    explainMissingDirectory(runSyncRaw('git', call.args, call.options), directory.path),
    directory.path,
  )
  return finish({ ...raw, stdout: decode(raw.stdout, options) }, 'git', call.displayArgs, options)
}

/** As `runGitSync`, with stdout left undecoded. */
export function runGitBinarySync(projectPath: string, args: string[], options?: RunCommandOptions): RunCommandBinaryResult {
  const directory = gitWorkingDirectory(projectPath)
  if (directory.path === undefined) return finish(unresolvedOutcome(directory.failure, Buffer.alloc(0)), 'git', args, options)
  const call = gitInvocation(directory.path, args, options)
  return finish(
    explainTimedOutGit(
      explainMissingDirectory(runSyncRaw('git', call.args, call.options), directory.path),
      directory.path,
    ),
    'git',
    call.displayArgs,
    options,
  )
}

/** Throwing wrapper for the callers whose contract is "throw on failure". */
export function runGitSyncOrThrow(projectPath: string, args: string[], options?: RunCommandOptions): string {
  const result = runGitSync(projectPath, args, options)
  if (!result.ok) throw new Error(result.errorDetail)
  return result.stdout
}

/** True when the command exited zero. For probes whose failure is expected. */
export function gitSyncSucceeds(projectPath: string, args: string[], options?: RunCommandOptions): boolean {
  return runGitSync(projectPath, args, options).ok
}

/** Runs a local Git mutation on the async runner with a long, named budget. */
export function runGitMutation(projectPath: string, args: string[], options?: RunCommandOptions): Promise<RunCommandResult> {
  return runGit(projectPath, args, {
    ...options,
    timeoutMs: options?.timeoutMs ?? GIT_MUTATION_TIMEOUT_MS,
  })
}

export async function runGitMutationOrThrow(projectPath: string, args: string[], options?: RunCommandOptions): Promise<string> {
  const result = await runGitMutation(projectPath, args, options)
  if (!result.ok) {
    if (result.timedOut) throw new RunCommandTimeoutError(result.errorDetail)
    throw new Error(result.errorDetail)
  }
  return result.stdout
}

export function isCommandAvailable(bin: string, env?: NodeJS.ProcessEnv): boolean {
  return runCommandSync(bin, ['--version'], {
    timeoutMs: COMMAND_AVAILABILITY_TIMEOUT_MS,
    ...(env ? { env } : {}),
    log: false,
  }).ok
}

function runAsyncRaw(bin: string, args: string[], options: RunCommandOptions | undefined): Promise<RawOutcome<string>> {
  const timeoutMs = options?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS
  const maxBuffer = options?.maxBuffer ?? GIT_MAX_BUFFER_BYTES

  const resolved = resolveBin(bin, options)
  if (resolved.path === undefined) return Promise.resolve(unresolvedOutcome(resolved.failure, ''))

  return new Promise((settleWith) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(resolved.path, args, {
        cwd: options?.cwd,
        env: buildEnv(options?.env, options?.preserveCoreSshCommand),
        // `terminateProcessTree` signals the negative pid on POSIX. A detached
        // child starts its own process group, so Git hooks, filters, and their
        // descendants receive the same timeout signal instead of surviving
        // after the runner has returned.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      settleWith({
        status: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        spawnError: error instanceof Error ? error : new Error(String(error)),
      })
      return
    }

    activeAsyncChildren.add(child)

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let overranBuffer = false
    let settled = false
    let closeObserved = false
    let timeoutCleanupComplete = false
    let processStateUnverified = false
    let childError: Error | undefined
    let pendingTimeoutOutcome: RawOutcome<string> | undefined
    let forceKillSent = false

    // `spawn` has no `maxBuffer`, so the ceiling is enforced here to match what
    // the synchronous path does — including killing the child on overrun.
    const collect = (chunks: Buffer[], chunk: Buffer, bytes: number): number => {
      const next = bytes + chunk.length
      if (next > maxBuffer) {
        if (!overranBuffer) {
          overranBuffer = true
          if (!closeObserved && !childHasExited(child)) signalProcessTree(child, 'SIGKILL')
          // The same abandon the timeout path carries, for the same reason: a
          // grandchild holding the pipes means `close` never fires, and an
          // overrun that waits for it hangs the caller exactly as a timeout
          // did. Killing is a request either way.
          abandonOverrun()
        }
        return next
      }
      chunks.push(chunk)
      return next
    }

    child.stdout?.on('data', (chunk: Buffer) => { stdoutBytes = collect(stdoutChunks, chunk, stdoutBytes) })
    child.stderr?.on('data', (chunk: Buffer) => { stderrBytes = collect(stderrChunks, chunk, stderrBytes) })

    /** Settles the overrun without `close`, once the kill has had its chance. */
    const abandonOverrun = () => {
      const timer = setTimeout(() => {
        if (processGroupHasMembers(child)) processStateUnverified = true
        child.unref()
        settle({
          status: null,
          // The child never emitted `close`, so this is a bounded abandonment,
          // not an observed signal. The overrun remains authoritative, but
          // claiming SIGKILL here would turn a synthetic fallback into false
          // process-state evidence.
          signal: null,
          timedOut,
          stdout: decode(Buffer.concat(stdoutChunks), options),
          stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
          spawnError: new Error(`${bin} output exceeded ${maxBuffer} bytes`),
        })
      }, TIMEOUT_ABANDON_GRACE_MS)
      overrunTimer = timer
    }

    // SIGTERM first, then SIGKILL, then give up waiting.
    //
    // A timeout that only asks politely is not a timeout: `git` with a
    // credential helper attached, or any child that traps SIGTERM, ignored it
    // and left this promise pending for as long as the child felt like running
    // — the exact hang the mandatory timeout exists to bound. The escalation
    // covers a child that ignores the signal; settling without `close` covers
    // one that cannot be killed at all, because a process LoopTroop cannot
    // reap must still not hold an actor open.
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let abandonTimer: ReturnType<typeof setTimeout> | undefined
    let overrunTimer: ReturnType<typeof setTimeout> | undefined
    const forceKill = () => {
      // A close event ends the leader's ownership of this numeric process
      // group. The later CLI shutdown layer can reconcile a surviving
      // descendant with its start token; this runner must not signal a reused
      // pid merely because the old leader timed out.
      if (forceKillSent || closeObserved || childHasExited(child)) return
      forceKillSent = true
      signalProcessTree(child, 'SIGKILL')
    }
    const retainDescendantAfterClose = (): boolean => {
      // A normal Windows close is authoritative for this runner: taskkill is
      // only a best-effort tree operation and there is no portable liveness
      // probe to turn a known close into a permanent unknown state. POSIX can
      // prove a surviving detached group and keeps it owned for reconciliation.
      if (process.platform === 'win32') {
        const cleanup = windowsTreeCleanup.get(child)
        if (!cleanup || cleanup === 'succeeded') return false
        processStateUnverified = true
        return true
      }
      if (!child.pid || processGroupState(child) === 'gone') return false
      processStateUnverified = true
      // Do not signal here. The leader has already exited and its numeric pid
      // may belong to a different process group now. Keep ownership visible
      // to stopActiveCommands, which reports the unresolved descendant until
      // a caller with start-token evidence can reconcile it.
      return true
    }
    const timer = setTimeout(() => {
      // An output overrun already owns termination and its diagnostic. Do not
      // race it into a timeout while waiting for the bounded overrun fallback.
      if (overranBuffer) return
      timedOut = true
      if (!closeObserved && !childHasExited(child)) signalProcessTree(child, 'SIGTERM')
      killTimer = setTimeout(forceKill, TIMEOUT_KILL_GRACE_MS)
      abandonTimer = setTimeout(() => {
        // Nothing here can reap the child, so it must not be what keeps the
        // process alive either.
        timeoutCleanupComplete = true
        const windowsCleanupConfirmed = process.platform === 'win32'
          && windowsTreeCleanup.get(child) === 'succeeded'
          && closeObserved
        if (!windowsCleanupConfirmed && processGroupHasMembers(child)) processStateUnverified = true
        child.unref()
        settle(pendingTimeoutOutcome ?? {
          status: null,
          // The child never emitted `close`, so this is a bounded abandonment,
          // not an observed signal. The timeout remains authoritative, but
          // claiming SIGKILL here would turn a synthetic fallback into false
          // process-state evidence.
          signal: null,
          timedOut: true,
          // Through `decode`, like the `close` path: a caller that asked for
          // untrimmed output is reading NUL-delimited records, and an abandoned
          // timeout is no reason to hand it a different shape.
          stdout: decode(Buffer.concat(stdoutChunks), options),
          stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
          spawnError: Object.assign(new Error(`spawn ${bin} ETIMEDOUT`), { code: 'ETIMEDOUT' }),
        })
      }, TIMEOUT_KILL_GRACE_MS + TIMEOUT_ABANDON_GRACE_MS)
    }, timeoutMs)

    const settle = (outcome: RawOutcome<string>) => {
      if (settled) return
      if (timedOut && !timeoutCleanupComplete) {
        // Git can close while a hook or filter descendant is still alive with
        // redirected stdio. Keep the timeout escalation and its bounded
        // abandonment window alive; otherwise this direct close would clear
        // the SIGKILL timer and return while that descendant can still mutate.
        pendingTimeoutOutcome ??= outcome
        const windowsCleanupConfirmed = process.platform === 'win32'
          && windowsTreeCleanup.get(child) === 'succeeded'
          && closeObserved
        if (windowsCleanupConfirmed || !processGroupHasMembers(child)) {
          // No descendant remains in the detached group, so the close event
          // (or a successful Windows taskkill tree walk) is sufficient
          // evidence that termination completed. Avoid making every ordinary
          // timeout pay the full SIGKILL/abandon grace.
          timeoutCleanupComplete = true
          processStateUnverified = false
          settle(pendingTimeoutOutcome)
        } else {
          forceKill()
          // The returned promise is still pending while close waits for the
          // bounded tree cleanup. Keep these timers referenced so a short-lived
          // CLI cannot exit before the promised timeout result is settled.
          killTimer?.ref?.()
          abandonTimer?.ref?.()
        }
        return
      }
      const retainedDescendant = closeObserved && !timedOut
        ? retainDescendantAfterClose()
        : false
      settled = true
      if (!retainedDescendant && !processStateUnverified) activeAsyncChildren.delete(child)
      clearTimeout(timer)
      if (killTimer && !retainedDescendant) clearTimeout(killTimer)
      if (abandonTimer && !retainedDescendant) clearTimeout(abandonTimer)
      if (overrunTimer) clearTimeout(overrunTimer)
      settleWith(outcome)
    }

    child.on('error', (error) => {
      childError = error
      if (!child.pid) {
        settle({ status: null, signal: null, timedOut, stdout: '', stderr: '', spawnError: error })
      }
    })

    child.on('close', (status, signal) => {
      closeObserved = true
      closedAsyncChildren.add(child)
      const timeoutError: NodeJS.ErrnoException | undefined = timedOut
        ? Object.assign(new Error(`spawn ${bin} ETIMEDOUT`), { code: 'ETIMEDOUT' })
        : undefined
      settle({
        status,
        signal,
        timedOut,
        stdout: decode(Buffer.concat(stdoutChunks), options),
        stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
        spawnError: timeoutError
          ?? childError
          ?? (overranBuffer ? new Error(`${bin} output exceeded ${maxBuffer} bytes`) : undefined),
      })
    })

    if (options?.input !== undefined) {
      // A child that exits before reading stdin raises EPIPE here; the close
      // handler already reports why it exited, so this needs no second report.
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.input)
    } else {
      child.stdin?.end()
    }
  })
}

/**
 * Runs a command without blocking the event loop.
 *
 * This is the variant for anything network-bound — `gh` API calls, `fetch`,
 * `push`, `ls-remote` — where the wait is measured in seconds and a stalled
 * remote would otherwise freeze the daemon.
 */
export async function runCommand(bin: string, args: string[], options?: RunCommandOptions): Promise<RunCommandResult> {
  return finish(await runAsyncRaw(bin, args, options), bin, args, options)
}

/** Runs git in `projectPath` without blocking the event loop. */
export function runGit(projectPath: string, args: string[], options?: RunCommandOptions): Promise<RunCommandResult> {
  const directory = gitWorkingDirectory(projectPath)
  if (directory.path === undefined) return Promise.resolve(finish(unresolvedOutcome(directory.failure, ''), 'git', args, options))
  return gitInvocationAsync(directory.path, args, options).then((call) => runAsyncRaw('git', call.args, call.options)
    .then((raw) => finish(
      explainTimedOutGit(explainMissingDirectory(raw, directory.path), directory.path),
      'git',
      call.displayArgs,
      options,
    )))
}

/** Throwing wrapper for the async callers whose contract is "throw on failure". */
export async function runGitOrThrow(projectPath: string, args: string[], options?: RunCommandOptions): Promise<string> {
  const result = await runGit(projectPath, args, options)
  if (!result.ok) {
    if (result.timedOut) throw new RunCommandTimeoutError(result.errorDetail)
    throw new Error(result.errorDetail)
  }
  return result.stdout
}

/** True when the command exited zero. Async counterpart of `gitSyncSucceeds`. */
export async function gitSucceeds(projectPath: string, args: string[], options?: RunCommandOptions): Promise<boolean> {
  return (await runGit(projectPath, args, options)).ok
}
