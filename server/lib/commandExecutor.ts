import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { CommandSpec, RuntimeEnvironment } from '../../shared/commandSpec'
import type { CommandShellKind, HostPlatform } from '../../shared/hostContext'
import { createBoundedOutputCollector } from './commandOutput'
import { planProgramLaunch, resolveTrustedExecutable, resolveTrustedProgram, type TrustedExecutableResolution } from './executablePath'
import { FORCE_KILL_DELAY_MS, PROCESS_ABANDON_GRACE_MS } from './constants'
import { terminateProcessTreeWithEscalation } from './processTree'
import { escapesRoot, resolveContainedPath } from './containedPath'

// Guarded with Test-Path so an unset $LASTEXITCODE cannot turn a clean cmdlet
// run into a strict-mode failure. Matches the launcher script in
// phases/executionSetup/runtimeLauncher.ts.
const POWERSHELL_EXIT_CODE_SUFFIX =
  '\nif (Test-Path -LiteralPath variable:\\LASTEXITCODE) { exit $LASTEXITCODE }'

export interface CommandInvocation {
  bin: string
  args: string[]
}

export interface CommandExecutionResult extends CommandInvocation {
  command: CommandSpec
  cwd: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export interface CommandExecutorOptions {
  platform?: HostPlatform
  env?: NodeJS.ProcessEnv
  shellBinaries?: Partial<Record<CommandShellKind, string>>
  pathExists?: (path: string) => boolean
  spawnProcess?: typeof spawn
  /**
   * Injected by tests, which describe what a command *does* rather than which
   * tools the machine running the suite happens to have installed.
   */
  resolveProgram?: (program: string, context: ProgramResolutionContext) => TrustedExecutableResolution
  runtimeEnvironment?: RuntimeEnvironment
}

export function resolveCommandCwd(repoRoot: string, cwd: string): string {
  if (isAbsolute(cwd) || /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.replace(/\\/g, '/').split('/').includes('..')) {
    throw new Error('Command working directory must stay within the repository root')
  }
  try {
    return resolveContainedPath(repoRoot, cwd, { allowMissingParents: true })
  } catch {
    throw new Error('Command working directory must stay within the repository root')
  }
}

function resolvePowerShell(
  pathExists: (path: string) => boolean,
  configured?: string,
): string {
  if (configured) return configured
  return pathExists('/usr/bin/pwsh') ? '/usr/bin/pwsh' : 'powershell.exe'
}

export function buildCommandInvocation(
  command: CommandSpec,
  options: CommandExecutorOptions = {},
): CommandInvocation {
  if (command.mode === 'process') {
    return { bin: command.program, args: command.args }
  }

  const pathExists = options.pathExists ?? existsSync
  if (command.shell === 'cmd') {
    return {
      bin: options.shellBinaries?.cmd ?? options.env?.ComSpec ?? process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', command.script],
    }
  }
  if (command.shell === 'powershell') {
    return {
      bin: resolvePowerShell(pathExists, options.shellBinaries?.powershell),
      // Windows PowerShell 5.1 reports its own status from -Command, not the
      // status of the last native program, so `node -e "process.exit(4)"`
      // arrives as 1. Re-exporting $LASTEXITCODE restores the real code. It is
      // $null when no native program ran, and `exit $null` is exit 0, so
      // pure-cmdlet scripts keep their previous behaviour.
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${command.script}${POWERSHELL_EXIT_CODE_SUFFIX}`,
      ],
    }
  }
  return {
    bin: options.shellBinaries?.posix ?? (pathExists('/bin/sh') ? '/bin/sh' : 'sh'),
    args: ['-c', command.script],
  }
}

export interface ProgramResolutionContext {
  /** The child's environment, PATH prepends included. */
  env: NodeJS.ProcessEnv
  /**
   * The daemon's own environment, where the trust policy is read: the override,
   * the Windows system root, `PATHEXT` and `ComSpec`. Never the child's — a
   * plan's `command.env` could otherwise set `LOOPTROOP_TRUSTED_EXECUTABLE_DIRS`
   * and vouch for any directory it liked. Defaults to `process.env`.
   */
  policyEnv?: NodeJS.ProcessEnv
  /** The command's working directory, already proven to be inside the repository. */
  cwd: string
  repoRoot: string
}

/**
 * Which file a command's program names.
 *
 * Three shapes, and the middle one is the reason this is not a single call:
 *
 * - **A bare name** (`npm`, `pre-commit`) is resolved through the trusted
 *   directory list against *the child's* environment, not the daemon's — the
 *   plan's `pathPrepend` puts a project's own `node_modules/.bin` on that PATH,
 *   and resolving against `process.env` would refuse every project-local tool
 *   while claiming to support them.
 * - **A relative path** (`./tools/check`, `tools\check.exe`) is resolved
 *   against the command's working directory and required to stay inside the
 *   repository. Letting it resolve against whatever the daemon's current
 *   directory happens to be is how the path-separator exception turns into a
 *   second injection route — the containment check is the point, not a
 *   formality.
 * - **An absolute path** is taken as an executable file, if it is one and it
 *   passes the ownership rule. No containment check: a plan naming
 *   `/usr/bin/make` is naming a tool, not escaping a root, and a
 *   repository-containment rule would refuse every one of them. This departs
 *   from the cleanup plan's text, which reads containment onto every
 *   path-shaped program.
 *
 * Where these programs come from, since it decides how much the rules above
 * are worth: an execution setup plan is **written by a model** and approved by
 * a person at a gate. It is not the project's own configuration. Refusing
 * absolute programs would still buy nothing, because the same approved plan can
 * say `mode: 'shell'` and run any script at all — and inside a shell script,
 * `sh` resolves the tools itself, against the child's PATH, with none of these
 * checks. The approval gate is the control for what a plan runs; this function
 * only stops PATH, the working directory, or a link from quietly choosing a
 * different file than the one the plan named.
 */
export function resolveCommandProgram(
  program: string,
  context: ProgramResolutionContext,
): TrustedExecutableResolution {
  const hasSeparator = /[\\/]/.test(program)
  const trust = { env: context.env, policyEnv: context.policyEnv }
  if (!hasSeparator) return resolveTrustedExecutable(program, trust)
  if (isAbsolute(program)) return resolveTrustedProgram(program, trust)

  let contained: string
  try {
    // Check the absolute candidate against both root spellings: cwd is already
    // canonical, while an attached repository may still be named by an alias.
    contained = resolve(context.cwd, program)
    resolveContainedPath(context.repoRoot, contained, { allowMissingParents: true })
  } catch {
    // Refused, not missing: a caller that falls back on "not found" must not
    // fall back onto a program that points out of the repository.
    return { reason: `Command program must stay within the repository root: ${program}`, refusedAt: program }
  }
  const resolution = resolveTrustedProgram(contained, trust)
  if (resolution.path === undefined) return resolution
  // Checked again *after* `realpath`, against the repository's own real path.
  // The lexical check above passes `tools/check`, and `resolveTrustedProgram`
  // then follows it — so a link at `tools/check` pointing at `/tmp/anything`
  // passed containment and ran outside the repository. The root is
  // canonicalised too, or a repository reached through a symlinked parent (the
  // macOS `/var` → `/private/var` case) would reject its own files.
  const root = realpathOrSelf(context.repoRoot)
  // `target`, not `path`: the resolver spawns the entry it found — a tool may
  // work out where it lives from how it was started — so `path` is the link and
  // only `target` says where it leads.
  const leadsTo = resolution.target ?? resolution.path
  if (relative(root, leadsTo) === '' || escapesRoot(root, leadsTo)) {
    return { reason: `Command program must stay within the repository root: ${program} leads to ${leadsTo}`, refusedAt: contained }
  }
  return resolution
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The command interpreter a Windows command script is run with.
 *
 * Resolved like any other program, and from the daemon's environment: `ComSpec`
 * names it when Windows set it, and is held to the same rules as a program a
 * plan names by path; otherwise `cmd.exe` is found through the system
 * directories. There is no bare-name fallback — handing `cmd.exe` to the
 * operating system's own search after the resolver declined is the one lookup
 * this module exists to avoid — and a plan's `command.env` cannot choose it.
 */
function commandInterpreter(
  resolveProgram: (program: string, context: ProgramResolutionContext) => TrustedExecutableResolution,
  context: ProgramResolutionContext,
): TrustedExecutableResolution {
  const policyEnv = context.policyEnv ?? process.env
  const named = policyEnv.ComSpec?.trim() || policyEnv.COMSPEC?.trim()
  return resolveProgram(named || 'cmd.exe', { ...context, env: policyEnv })
}

export async function executeCommand(
  command: CommandSpec,
  input: CommandExecutorOptions & { repoRoot: string },
): Promise<CommandExecutionResult> {
  const startedAt = Date.now()
  const cwd = resolveCommandCwd(input.repoRoot, command.cwd)
  const invocation = buildCommandInvocation(command, input)
  const platform = input.platform ?? (
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  )
  const spawnProcess = input.spawnProcess ?? spawn
  const baseEnvironment = input.env ?? process.env
  const pathSeparator = platform === 'windows' ? ';' : ':'
  const pathPrepend = input.runtimeEnvironment?.pathPrepend.map((path) =>
    resolveCommandCwd(input.repoRoot, path),
  ) ?? []
  const environment = {
    ...baseEnvironment,
    ...input.runtimeEnvironment?.variables,
    ...command.env,
  }
  if (pathPrepend.length > 0) {
    // Prepended to the PATH the command will actually get, which is the merged
    // one: reading the base environment here discarded a `PATH` the command or
    // the runtime variables had set on purpose.
    environment.PATH = [
      ...pathPrepend,
      environment.PATH ?? environment.Path ?? '',
    ].filter(Boolean).join(pathSeparator)
  }

  // Resolved after the environment is built, so a project-local tool put on the
  // child's PATH by `pathPrepend` is found the way the child would find it.
  // A program that cannot be resolved ends as a run that could not start:
  // exit code null with the reason on stderr, which is byte-for-byte the shape
  // a spawn error already produced for a missing tool.
  const resolveProgram = input.resolveProgram ?? resolveCommandProgram
  // The daemon's environment, before the plan's variables are merged in: that
  // is where the trust policy is read.
  const context = { env: environment, policyEnv: baseEnvironment, cwd, repoRoot: input.repoRoot }
  const resolvedProgram = resolveProgram(invocation.bin, context)
  if (resolvedProgram.path === undefined) {
    return {
      command,
      cwd,
      ...invocation,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: resolvedProgram.reason,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    }
  }

  // The resolver returns `npm.cmd` for `npm` on Windows, because that is what
  // `npm` is there, and Node refuses to launch a command script directly — a
  // process-mode `npm test` resolved correctly and then failed with EINVAL. The
  // shared launcher starts it through cmd.exe, found through the same seam as
  // the program, with every argument escaped for cmd.exe.
  const launch = planProgramLaunch(resolvedProgram.path, invocation.args, {
    platform: platform === 'windows' ? 'win32' : platform === 'macos' ? 'darwin' : 'linux',
    // What cmd.exe will run with, the plan's variables included: they decide
    // what a `%…%` in an argument could expand to.
    env: environment,
    resolveInterpreter: () => commandInterpreter(resolveProgram, context),
  })
  if (launch.reason !== undefined) {
    return {
      command,
      cwd,
      ...invocation,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: launch.reason,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    }
  }

  return await new Promise<CommandExecutionResult>((resolveExecution) => {
    const child = spawnProcess(launch.file, launch.args, {
      cwd,
      env: environment,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: platform !== 'windows',
    })
    const stdoutCollector = createBoundedOutputCollector()
    const stderrCollector = createBoundedOutputCollector()
    let settled = false
    let timedOut = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let abandonHandle: ReturnType<typeof setTimeout> | undefined

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (abandonHandle) clearTimeout(abandonHandle)
      resolveExecution({
        command,
        cwd,
        ...invocation,
        exitCode,
        signal,
        stdout: stdoutCollector.end(),
        stderr: stderrCollector.end(),
        durationMs: Date.now() - startedAt,
        timedOut,
      })
    }

    child.stdout?.on('data', (chunk: Buffer | string) => stdoutCollector.append(chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => stderrCollector.append(chunk))
    child.on('error', (error) => {
      // Through the collector so a spawn failure cannot push stderr past the cap.
      stderrCollector.appendText(error.message)
      finish(null, null)
    })
    child.on('close', finish)

    if (command.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        terminateProcessTreeWithEscalation(child, platform)
        // Killing the tree is a request, not a guarantee, so the timeout has to
        // be able to end without one. `close` fires only once every pipe is
        // closed, and a grandchild that outlives `taskkill` keeps them open —
        // which is how a 200 ms command sat unresolved until the caller's own
        // deadline. Reported as the timeout it is, with whatever output arrived.
        abandonHandle = setTimeout(() => {
          child.unref()
          finish(null, 'SIGKILL')
        }, FORCE_KILL_DELAY_MS + PROCESS_ABANDON_GRACE_MS)
        abandonHandle.unref?.()
      }, command.timeoutMs)
    }
  })
}
