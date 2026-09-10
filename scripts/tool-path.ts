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
import { resolveTrustedProgram } from '../server/lib/executablePath.ts'

/** The file `name` runs as. Throws with the reason if there is no trusted one. */
export function toolPath(name: string): string {
  const resolution = resolveTrustedProgram(name)
  if (resolution.path === undefined) throw new Error(resolution.reason)
  return resolution.path
}

/** As `toolPath`, but `null` for a probe whose whole question is whether the tool is there. */
export function findToolPath(name: string): string | null {
  return resolveTrustedProgram(name).path ?? null
}

/**
 * The program to hand `spawn`, given the name a caller wrote.
 *
 * The difference from `toolPath` is what happens when there is no answer, and
 * the two failures are not alike:
 *
 * - **Not installed** falls back to the name. Every caller of this already
 *   reports a missing tool from the spawn's own `ENOENT`, often as the thing
 *   being tested — `smoke-published.mjs` probes whether `yarn` exists — and
 *   turning that into a throw would change what those scripts measure.
 * - **Found, in a directory this machine will not run from** throws. Falling
 *   back there would spawn the exact file this is meant to refuse.
 *
 * `shell` quotes the result, because a resolved path is usually longer than the
 * name it replaced and `C:\Program Files\nodejs\npm.cmd` handed to a shell
 * unquoted stops at the first space.
 */
export function spawnProgram(command: string, options: { shell?: boolean | string } = {}): string {
  const resolution = resolveTrustedProgram(command)
  if (resolution.path === undefined) {
    if (resolution.refusedAt !== undefined) throw new Error(resolution.reason)
    return command
  }
  const quoted = options.shell && /\s/.test(resolution.path) ? `"${resolution.path}"` : resolution.path
  return quoted
}
