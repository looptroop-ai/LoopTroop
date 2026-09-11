/**
 * Where a tool a build, dev or smoke script needs actually lives, and how to
 * start it.
 *
 * These scripts name `tar`, `npm`, `docker`, `7z` and a dozen others and let
 * `PATH` decide which file answers. That is the same hole the daemon had, in a
 * place that runs on release runners and on developer machines with whatever
 * happens to be on their `PATH` — so it gets the same answer, from the same
 * implementation. `server/lib/executablePath.ts` is written as erasable
 * TypeScript with no relative imports precisely so a `.mjs` script can import it
 * under Node's type stripping.
 *
 * Not `scripts/trusted-tool.ts`, which is stricter on purpose: that one guards
 * the jobs holding publishing credentials, where a tool outside `/usr/bin` is a
 * reason to stop. A build script running under someone's `nvm` is not.
 *
 * Throwing is the right failure here. A build or smoke script that cannot find
 * its tool has nothing to degrade to, and the message names the directory it
 * refused and the variable that would allow it.
 */
import { spawnSync, type StdioOptions } from 'node:child_process'
import { isAbsolute } from 'node:path'
import {
  bareNameSearchReachesWorkingDirectory,
  planProgramLaunch,
  resolveTrustedProgram,
  type ProgramLaunch,
  type ProgramLaunchPlan,
} from '../server/lib/executablePath.ts'

export interface ToolLookup {
  /**
   * The environment the child will be started with. Resolve against *that*, not
   * this process's: a smoke that puts a freshly installed `looptroop` at the
   * front of the child's PATH resolved against the parent's and exercised
   * whichever older one the runner already had.
   *
   * Only its `PATH` is read. The trust policy — the override, `PATHEXT`,
   * `ComSpec` — comes from this process's environment: the child's is what the
   * script is about to build, and a script that could vouch for a directory by
   * writing its own child env could vouch for anything.
   */
  env?: NodeJS.ProcessEnv
  /** Test seam: the platform whose rules apply. */
  platform?: NodeJS.Platform
}

/** The file `name` runs as. Throws with the reason if there is no trusted one. */
export function toolPath(name: string, lookup: ToolLookup = {}): string {
  const resolution = resolveTrustedProgram(name, lookup)
  if (resolution.path === undefined) throw new Error(resolution.reason)
  return resolution.path
}

/** As `toolPath`, but `null` for a probe whose whole question is whether the tool is there. */
export function findToolPath(name: string, lookup: ToolLookup = {}): string | null {
  return resolveTrustedProgram(name, lookup).path ?? null
}

/**
 * How to spawn `name` with `args`, or the reason it cannot be: for a caller
 * that reports a tool it cannot start rather than stopping on it.
 *
 * Resolved against the child's `PATH`, and started the way the daemon and the
 * installer start it. That matters on Windows, where `npm`, `yarn`, the
 * installed `looptroop` and an npm-installed OpenCode are command scripts: Node
 * will not launch one directly, and `shell: true` would have Node look cmd.exe
 * up by name and join the arguments unquoted. The launcher resolves cmd.exe and
 * escapes every argument for it. Pass all three fields to the spawn —
 * `windowsVerbatimArguments` included, or Node quotes the line a second time.
 */
export function planToolLaunch(name: string, args: readonly string[], lookup: ToolLookup = {}): ProgramLaunchPlan {
  const resolution = resolveTrustedProgram(name, lookup)
  if (resolution.path === undefined) {
    // `refusedAt` carried through, so a caller with a "not installed" path
    // does not send a refused tool down it.
    return resolution.refusedAt === undefined ? { reason: resolution.reason } : { reason: resolution.reason, refusedAt: resolution.refusedAt }
  }
  return planProgramLaunch(resolution.path, args, lookup)
}

/** As `planToolLaunch`, but throws with the reason: for a script that cannot go on without the tool. */
export function launchTool(name: string, args: readonly string[], lookup: ToolLookup = {}): ProgramLaunch {
  const launch = planToolLaunch(name, args, lookup)
  if (launch.reason !== undefined) throw new Error(launch.reason)
  return launch
}

export interface ExecToolOptions extends ToolLookup {
  cwd?: string
  /** Defaults to stdin ignored, stdout captured, stderr passed through. */
  stdio?: StdioOptions
  maxBuffer?: number
}

/**
 * `execFileSync` for a tool that may be a Windows command script.
 *
 * `execFileSync(toolPath('npm'), …)` is what the npm verifiers used, and it
 * cannot start `npm.cmd`: Node refuses a command script without a shell, so
 * `licenses:check` and `verify:package` failed on Windows with EINVAL. This
 * starts the tool through `launchTool` and keeps `execFileSync`'s contract: the
 * output is returned, and a failed start or a non-zero exit is thrown, with
 * `status`, `signal`, `stdout` and `stderr` on the error.
 */
export function execTool(name: string, args: readonly string[], options: ExecToolOptions = {}): string {
  const { env, platform, ...spawnOptions } = options
  const launch = launchTool(name, args, { env, platform })
  const result = spawnSync(launch.file, launch.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...spawnOptions,
    env,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw Object.assign(new Error(`${name} ${args.join(' ')} exited ${result.status ?? result.signal}`), {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    })
  }
  return result.stdout ?? ''
}

/**
 * The program to hand `spawn`, given the name a caller wrote — for a program
 * that is started directly. A Windows command script needs `launchTool`.
 *
 * The difference from `toolPath` is what happens when there is no answer, and
 * the failures are not alike:
 *
 * - **Not installed** falls back to the name, so the spawn's own ENOENT is the
 *   answer the caller already reports. That is only safe when the operating
 *   system's search cannot reach the working directory, which the resolver
 *   never searches: never on Windows, which looks there first whatever PATH
 *   says, and not on POSIX when the child's PATH has a relative or empty entry
 *   — `PATH=/usr/bin:`, a trailing colon, ran `./tool`. An absolute path falls
 *   back as itself, since nothing searches for it.
 * - **A relative path** is never handed back: it would be run from whatever the
 *   working directory is.
 * - **Found, and refused** throws. Falling back there would spawn the exact file
 *   this is meant to refuse.
 */
export function spawnProgram(command: string, options: ToolLookup = {}): string {
  const resolution = resolveTrustedProgram(command, options)
  if (resolution.path !== undefined) return resolution.path
  if (resolution.refusedAt !== undefined) throw new Error(resolution.reason)
  if (isAbsolute(command)) return command
  if (/[\\/]/.test(command)) {
    throw new Error(`${command} is a relative path, and it would run from the current directory: ${resolution.reason}`)
  }
  if (bareNameSearchReachesWorkingDirectory(options.env ?? process.env, options.platform)) {
    throw new Error(`${resolution.reason} Not falling back to the name: the operating system would look for it in the current directory.`)
  }
  return command
}
