/**
 * Where a tool a build, dev or smoke script needs actually lives.
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
import { isAbsolute } from 'node:path'
import { bareNameSearchReachesWorkingDirectory, resolveTrustedProgram } from '../server/lib/executablePath.ts'

export interface ToolLookup {
  /**
   * The environment the child will be started with. Resolve against *that*, not
   * this process's: a smoke that puts a freshly installed `looptroop` at the
   * front of the child's PATH resolved against the parent's and exercised
   * whichever older one the runner already had.
   */
  env?: NodeJS.ProcessEnv
  /** Test seam: the platform whose rules apply. */
  platform?: NodeJS.Platform
}

/** The file `name` runs as. Throws with the reason if there is no trusted one. */
export function toolPath(name: string, lookup: ToolLookup = {}): string {
  const resolution = resolveTrustedProgram(name, { env: lookup.env })
  if (resolution.path === undefined) throw new Error(resolution.reason)
  return resolution.path
}

/** As `toolPath`, but `null` for a probe whose whole question is whether the tool is there. */
export function findToolPath(name: string, lookup: ToolLookup = {}): string | null {
  return resolveTrustedProgram(name, { env: lookup.env }).path ?? null
}

/**
 * The resolved path as one token of a shell command line.
 *
 * Always quoted, not only when it holds a space: `C:\Tools&CI` has no space and
 * is two commands to cmd.exe, and a POSIX path with `$` or a backtick expands
 * inside double quotes. cmd.exe gets double quotes, which it does not re-parse
 * inside and which no Windows path can contain; `sh` gets single quotes, inside
 * which nothing is special, with any `'` in the path closed and re-opened.
 */
export function quoteProgramForShell(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `"${path}"`
  return `'${path.replace(/'/g, `'\\''`)}'`
}

/**
 * The program to hand `spawn`, given the name a caller wrote.
 *
 * The difference from `toolPath` is what happens when there is no answer, and
 * the failures are not alike:
 *
 * - **Not installed** falls back to the name, so the spawn's own ENOENT is the
 *   answer the caller already reports — `smoke-published.mjs` probes whether
 *   `yarn` exists. That is only safe when the operating system's search cannot
 *   reach the working directory, which the resolver never searches: never on
 *   Windows, which looks there first whatever PATH says, and not on POSIX when
 *   the child's PATH has a relative or empty entry — `PATH=/usr/bin:`, a
 *   trailing colon, ran `./tool`.
 * - **A relative path** is never handed back: it would be run from whatever the
 *   working directory is.
 * - **Found, and refused** throws. Falling back there would spawn the exact file
 *   this is meant to refuse.
 *
 * The trust policy is read from this process's environment, not the child's:
 * the child's is what the script is about to build, and a script that could
 * vouch for a directory by writing its own child env could vouch for anything.
 *
 * `shell` quotes the result with `quoteProgramForShell`. Pass the raw path, not
 * one that is already quoted.
 */
export function spawnProgram(command: string, options: ToolLookup & { shell?: boolean | string } = {}): string {
  const resolution = resolveTrustedProgram(command, { env: options.env, platform: options.platform })
  if (resolution.path === undefined) {
    if (resolution.refusedAt !== undefined) throw new Error(resolution.reason)
    if (/[\\/]/.test(command) && !isAbsolute(command)) {
      throw new Error(`${command} is a relative path, and it would run from the current directory: ${resolution.reason}`)
    }
    if (bareNameSearchReachesWorkingDirectory(options.env ?? process.env, options.platform)) {
      throw new Error(`${resolution.reason} Not falling back to the name: the operating system would look for it in the current directory.`)
    }
    return command
  }
  return options.shell ? quoteProgramForShell(resolution.path) : resolution.path
}

/**
 * One argument as a token of a shell command line, quoted only when leaving it
 * bare would change it.
 *
 * Quoting everything is wrong for cmd.exe: it hands a `.cmd` shim its arguments
 * with the quotes still on, so a shim comparing `%1` stops matching. So cmd gets
 * the same rule `installer-core.mjs` uses — quote what would split or be read as
 * syntax — and `sh` gets single quotes for anything outside a conservative safe
 * set.
 */
export function quoteArgForShell(value: string, platform: NodeJS.Platform = process.platform): string {
  // An empty argument is still an argument; left bare it vanishes from the line.
  if (platform === 'win32') return value === '' || /[\s&|<>^()"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The whole command line for a `shell: true` spawn.
 *
 * Handing Node an argument array with `shell: true` makes it join them with
 * spaces and quote none of them — so a tarball under a directory with a space
 * arrived as two arguments, and since DEP0190 Node also warns about doing it.
 * Built here instead, with the program and every argument quoted for the shell
 * that will read them.
 */
export function shellCommandLine(program: string, args: readonly string[], platform: NodeJS.Platform = process.platform): string {
  return [quoteProgramForShell(program, platform), ...args.map((arg) => quoteArgForShell(arg, platform))].join(' ')
}
