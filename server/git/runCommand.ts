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
 * - **Sync** (`runGitSync`, `runCommandSync`) for local plumbing —
 *   `rev-parse`, `status`, `diff`, `add`, `commit`, `worktree prune`. These
 *   cannot reach a credential prompt and finish in milliseconds; keeping them
 *   synchronous keeps their callers synchronous.
 *
 * A timeout bounds the wait but a synchronous call still blocks for its whole
 * duration, so on the sync path this turns a permanent freeze into a bounded
 * one rather than removing it.
 */

import { spawn, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { resolveTrustedProgram } from '../lib/executablePath'
import * as commandLogger from '../log/commandLogger'

/** Matches the timeout `server/git/repository.ts` has always used. */
export const GIT_DEFAULT_TIMEOUT_MS = 30_000

/** The ceiling the established runner in `phases/execution/gitOps.ts` used. */
export const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024

/** How long a timed-out child gets to exit on SIGTERM before SIGKILL. */
const TIMEOUT_KILL_GRACE_MS = 2_000

/** How long after SIGKILL to wait for `close` before settling without it. */
const TIMEOUT_ABANDON_GRACE_MS = 2_000

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

function buildEnv(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  // `gh` shells out to git, so the non-interactive pair is applied to both.
  return { ...process.env, ...NON_INTERACTIVE_GIT_ENV, ...extra }
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
      errorDetail = timeoutMessage(bin, args, timeoutMs)
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
  const resolution = resolveTrustedProgram(bin, { env: buildEnv(options?.env) })
  return resolution.path === undefined ? { failure: new Error(resolution.reason) } : { path: resolution.path }
}

function unresolvedOutcome<TOut>(failure: Error, empty: TOut): RawOutcome<TOut> {
  return { status: null, signal: null, timedOut: false, stdout: empty, stderr: '', spawnError: failure }
}

function runSyncRaw(bin: string, args: string[], options: RunCommandOptions | undefined): RawOutcome<Buffer> {
  const resolved = resolveBin(bin, options)
  if (resolved.path === undefined) return unresolvedOutcome(resolved.failure, Buffer.alloc(0))

  const spawned = spawnSync(resolved.path, args, {
    cwd: options?.cwd,
    input: options?.input,
    env: buildEnv(options?.env),
    maxBuffer: options?.maxBuffer ?? GIT_MAX_BUFFER_BYTES,
    timeout: options?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
    // spawnSync blocks until the child exits and never escalates, so a child
    // that traps SIGTERM would defeat the timeout on this path too. There is
    // nothing to negotiate with a command that has already outrun its budget.
    killSignal: 'SIGKILL',
  })
  // Asking spawnSync for Buffers rather than utf8 keeps one code path for both
  // output shapes; the string variant decodes below.
  return {
    status: spawned.status,
    signal: spawned.signal,
    timedOut: isTimeoutError(spawned.error ?? undefined),
    stdout: spawned.stdout ?? Buffer.alloc(0),
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
 * Every `runGit*` call puts a caller's path straight into git's argument
 * vector, and several of those paths trace back to a request. So it is held to
 * what a working directory has to be: a non-empty absolute path with no NUL in
 * it. Absolute is the rule that matters — a relative one would be read against
 * the daemon's own working directory, which is never the project anyone meant,
 * and it is the only way a value could start with `-` and be read as an option.
 *
 * A path that fails is reported the way a missing `git` is — `ok: false` with
 * the reason — and never thrown, because every caller already handles a failed
 * git command and none of them expects this function to raise. Containing the
 * path inside a known project is PR-16's work; this is the shape check.
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
  return { args, displayArgs: ['-C', directory, ...args], options: { ...options, cwd: directory } }
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
  const raw = explainMissingDirectory(runSyncRaw('git', call.args, call.options), directory.path)
  return finish({ ...raw, stdout: decode(raw.stdout, options) }, 'git', call.displayArgs, options)
}

/** As `runGitSync`, with stdout left undecoded. */
export function runGitBinarySync(projectPath: string, args: string[], options?: RunCommandOptions): RunCommandBinaryResult {
  const directory = gitWorkingDirectory(projectPath)
  if (directory.path === undefined) return finish(unresolvedOutcome(directory.failure, Buffer.alloc(0)), 'git', args, options)
  const call = gitInvocation(directory.path, args, options)
  return finish(explainMissingDirectory(runSyncRaw('git', call.args, call.options), directory.path), 'git', call.displayArgs, options)
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

function runAsyncRaw(bin: string, args: string[], options: RunCommandOptions | undefined): Promise<RawOutcome<string>> {
  const timeoutMs = options?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS
  const maxBuffer = options?.maxBuffer ?? GIT_MAX_BUFFER_BYTES

  const resolved = resolveBin(bin, options)
  if (resolved.path === undefined) return Promise.resolve(unresolvedOutcome(resolved.failure, ''))

  return new Promise((settleWith) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(resolved.path, args, { cwd: options?.cwd, env: buildEnv(options?.env) })
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

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let overranBuffer = false
    let settled = false

    // `spawn` has no `maxBuffer`, so the ceiling is enforced here to match what
    // the synchronous path does — including killing the child on overrun.
    const collect = (chunks: Buffer[], chunk: Buffer, bytes: number): number => {
      const next = bytes + chunk.length
      if (next > maxBuffer) {
        if (!overranBuffer) {
          overranBuffer = true
          child.kill('SIGKILL')
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
        child.unref()
        settle({
          status: null,
          signal: 'SIGKILL',
          timedOut,
          stdout: decode(Buffer.concat(stdoutChunks), options),
          stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
          spawnError: new Error(`${bin} output exceeded ${maxBuffer} bytes`),
        })
      }, TIMEOUT_ABANDON_GRACE_MS)
      timer.unref?.()
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
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_KILL_GRACE_MS)
      killTimer.unref?.()
      abandonTimer = setTimeout(() => {
        // Nothing here can reap the child, so it must not be what keeps the
        // process alive either.
        child.unref()
        settle({
          status: null,
          signal: 'SIGKILL',
          timedOut: true,
          // Through `decode`, like the `close` path: a caller that asked for
          // untrimmed output is reading NUL-delimited records, and an abandoned
          // timeout is no reason to hand it a different shape.
          stdout: decode(Buffer.concat(stdoutChunks), options),
          stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
          spawnError: Object.assign(new Error(`spawn ${bin} ETIMEDOUT`), { code: 'ETIMEDOUT' }),
        })
      }, TIMEOUT_KILL_GRACE_MS + TIMEOUT_ABANDON_GRACE_MS)
      abandonTimer.unref?.()
    }, timeoutMs)
    // A pending timer must not hold the process open during shutdown.
    timer.unref?.()

    const settle = (outcome: RawOutcome<string>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (abandonTimer) clearTimeout(abandonTimer)
      if (overrunTimer) clearTimeout(overrunTimer)
      settleWith(outcome)
    }

    child.on('error', (error) => {
      settle({ status: null, signal: null, timedOut, stdout: '', stderr: '', spawnError: error })
    })

    child.on('close', (status, signal) => {
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
  const call = gitInvocation(directory.path, args, options)
  return runAsyncRaw('git', call.args, call.options)
    .then((raw) => finish(explainMissingDirectory(raw, directory.path), 'git', call.displayArgs, options))
}

/** Throwing wrapper for the async callers whose contract is "throw on failure". */
export async function runGitOrThrow(projectPath: string, args: string[], options?: RunCommandOptions): Promise<string> {
  const result = await runGit(projectPath, args, options)
  if (!result.ok) throw new Error(result.errorDetail)
  return result.stdout
}

/** True when the command exited zero. Async counterpart of `gitSyncSucceeds`. */
export async function gitSucceeds(projectPath: string, args: string[], options?: RunCommandOptions): Promise<boolean> {
  return (await runGit(projectPath, args, options)).ok
}
