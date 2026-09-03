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
import * as commandLogger from '../log/commandLogger'

/** Matches the timeout `server/git/repository.ts` has always used. */
export const GIT_DEFAULT_TIMEOUT_MS = 30_000

/** The ceiling the established runner in `phases/execution/gitOps.ts` used. */
export const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024

/**
 * Keeps git from blocking on interactive input.
 *
 * `GIT_TERMINAL_PROMPT=0` refuses the terminal prompt outright; `GIT_ASKPASS`
 * pointing at `echo` makes the graphical fallback answer with an empty string
 * instead of opening a dialog nobody is looking at.
 */
export const NON_INTERACTIVE_GIT_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
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

function runSyncRaw(bin: string, args: string[], options: RunCommandOptions | undefined): RawOutcome<Buffer> {
  const spawned = spawnSync(bin, args, {
    cwd: options?.cwd,
    input: options?.input,
    env: buildEnv(options?.env),
    maxBuffer: options?.maxBuffer ?? GIT_MAX_BUFFER_BYTES,
    timeout: options?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
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
 * Runs `git -C <projectPath> <args>` synchronously.
 *
 * Never throws on a non-zero exit — each call site keeps its own contract for
 * that, and they differ on purpose (`hookDiscovery` returns null where
 * `repository` throws).
 */
export function runGitSync(projectPath: string, args: string[], options?: RunCommandOptions): RunCommandResult {
  return runCommandSync('git', ['-C', projectPath, ...args], options)
}

/** As `runGitSync`, with stdout left undecoded. */
export function runGitBinarySync(projectPath: string, args: string[], options?: RunCommandOptions): RunCommandBinaryResult {
  return runCommandBinarySync('git', ['-C', projectPath, ...args], options)
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

  return new Promise((settleWith) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { cwd: options?.cwd, env: buildEnv(options?.env) })
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
        }
        return next
      }
      chunks.push(chunk)
      return next
    }

    child.stdout?.on('data', (chunk: Buffer) => { stdoutBytes = collect(stdoutChunks, chunk, stdoutBytes) })
    child.stderr?.on('data', (chunk: Buffer) => { stderrBytes = collect(stderrChunks, chunk, stderrBytes) })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    // A pending timer must not hold the process open during shutdown.
    timer.unref?.()

    const settle = (outcome: RawOutcome<string>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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

/** Runs `git -C <projectPath> <args>` without blocking the event loop. */
export function runGit(projectPath: string, args: string[], options?: RunCommandOptions): Promise<RunCommandResult> {
  return runCommand('git', ['-C', projectPath, ...args], options)
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
