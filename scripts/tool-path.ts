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
