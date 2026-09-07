/**
 * Where a release-mutating tool actually lives, resolved once and checked.
 *
 * `execFileSync('gh', …)` and `spawnSync('choco', …)` name a tool and let the
 * operating system search `PATH` for it. `shell: false` stops the *arguments*
 * being re-parsed, but it does nothing about which file gets run: the first
 * directory on `PATH` decides, and in a job that can edit a GitHub release or
 * push to a package feed, that is a credential handed to whatever answered to
 * the name.
 *
 * So the file is resolved here and the resolution is refused unless it comes
 * from a directory the runner owns. The tools this guards are provided by the
 * runner image; nothing about them lives in a writable working directory or in
 * anything this repository unpacks.
 *
 * An override exists because a self-hosted runner or a container image can
 * legitimately put `gh` somewhere this list does not know about, and refusing to
 * release on that basis would be worse than the risk. It has to be set
 * deliberately, by name, which is the distinction: an operator choosing a path
 * is not the same as a path being chosen by whatever happened to be first on
 * `PATH`.
 */
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'

/**
 * Directory prefixes a tool may be resolved from.
 *
 * Everything here is either root-owned on a hosted runner or the standard
 * installation root for the tool on that platform. The working directory, the
 * temporary directory and anything under the checkout are deliberately absent —
 * those are the ones a job's own inputs can write to.
 *
 * The hosted tool cache is absent for the same reason, and it is worth naming:
 * `/opt/hostedtoolcache` looks like system infrastructure but is written by
 * every `setup-*` action, so the job can put files there. Neither tool this
 * guards comes from it — `gh` is preinstalled at `/usr/bin` or under Program
 * Files, `choco` under ProgramData — so trusting the cache would have widened
 * the guard to a writable tree for nothing. A runner that genuinely keeps a
 * tool there names it through the override.
 */
export function defaultTrustedPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
  // `??` is not enough: it falls back for null and undefined and *not* for the
  // empty string, and an unset-but-present variable is exactly what a trimmed
  // container environment gives. `ProgramFiles: ''` produced the prefix `''`,
  // which `resolve()` turns into the current working directory — so the entire
  // checkout became a trusted location and the guard trusted anything the job
  // could write. Anything not absolute is dropped instead.
  // `win32.isAbsolute`, not the host's: these are Windows roots whether or not
  // this is running on Windows, and `isAbsolute('C:\\Program Files')` is false
  // on POSIX — which would have discarded every real value and kept the
  // fallbacks, silently, on the platform the tests run on.
  const root = (value: string | undefined, fallback: string) => {
    const candidate = value?.trim()
    return candidate !== undefined && candidate !== '' && win32.isAbsolute(candidate) ? candidate : fallback
  }

  const programFiles = root(env.ProgramFiles, 'C:\\Program Files')
  const programFilesX86 = root(env['ProgramFiles(x86)'], 'C:\\Program Files (x86)')
  const programData = root(env.ProgramData, 'C:\\ProgramData')
  const systemRoot = root(env.SystemRoot, 'C:\\Windows')

  return [
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/usr/sbin',
    '/bin',
    '/sbin',
    '/opt/homebrew/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    programFiles,
    programFilesX86,
    win32.join(programData, 'chocolatey'),
    win32.join(systemRoot, 'system32'),
  ]
}

/**
 * Whether `path` is inside one of `prefixes`.
 *
 * By path segment, not by string. `startsWith` was the first version and it is
 * a hole: `/usr/bin-of-mine/gh` starts with `/usr/bin`, so a directory that
 * merely *shares a prefix* with a trusted one was trusted — which is the whole
 * check, defeated by naming a directory carefully. `relative()` answers the
 * question actually being asked: is this under that directory.
 */
function withinTrustedPrefix(path: string, platform: NodeJS.Platform, prefixes: readonly string[]): boolean {
  const normalise = (value: string) => (platform === 'win32' ? value.toLowerCase() : value)
  const directory = normalise(dirname(resolve(path)))

  return prefixes.some((prefix) => {
    const root = normalise(resolve(prefix))
    if (directory === root) return true
    const step = relative(root, directory)
    // Inside it, and not reached by climbing out of it first.
    return step !== '' && !step.startsWith('..') && !isAbsolute(step)
  })
}

/**
 * The executable for `command`, or the reason there is none to trust.
 *
 * `pathValue` and `pathExt` are parameters so the rules can be tested off the
 * platform they describe.
 */
export function resolveTrustedTool(
  command: string,
  {
    env = process.env,
    pathValue = process.env.PATH || process.env.Path || '',
    // `||`, not `??`: an empty PATHEXT would leave no extensions to try.
    pathExt = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    platform = process.platform,
    trustedPrefixes = defaultTrustedPrefixes(env),
  }: {
    env?: NodeJS.ProcessEnv
    pathValue?: string
    pathExt?: string
    platform?: NodeJS.Platform
    /** Injectable so the rules can be exercised without depending on this machine's layout. */
    trustedPrefixes?: readonly string[]
  } = {},
): { path: string } | { refusal: string } {
  // Named outright by an operator. Still has to exist and be executable; what
  // it does not have to be is inside a prefix this file knows about.
  const override = env[`LOOPTROOP_${command.toUpperCase()}_PATH`]?.trim()
  if (override) {
    if (!isAbsolute(override)) return { refusal: `LOOPTROOP_${command.toUpperCase()}_PATH must be an absolute path, and is '${override}'.` }
    if (!isExecutableFile(override, platform)) return { refusal: `LOOPTROOP_${command.toUpperCase()}_PATH points at '${override}', which is not an executable file.` }
    return runnable(command, override)
  }

  // The same search the operating system would do, so the answer is the file
  // that *would* have run — and can therefore be judged before it does.
  const named = /\.[^\\/.]+$/.test(command)
  const extensions = platform === 'win32' ? (named ? [''] : pathExt.split(';').filter(Boolean)) : ['']

  for (const entry of pathValue.split(delimiter).filter(Boolean)) {
    const directory = entry.replace(/^"(.*)"$/, '$1')
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      if (!isExecutableFile(candidate, platform)) continue
      if (!withinTrustedPrefix(candidate, platform, trustedPrefixes)) {
        return {
          refusal: `${command} resolves to ${candidate}, which is not in a directory this release trusts.`
            + ` Set LOOPTROOP_${command.toUpperCase()}_PATH if that location is deliberate.`,
        }
      }
      return runnable(command, candidate)
    }
  }

  return { refusal: `${command} was not found on PATH.` }
}

/**
 * A resolution the callers can actually spawn, or the reason they cannot.
 *
 * Every caller hands the answer to `execFileSync` without a shell, and Node has
 * refused to spawn a Windows command script that way since the BatBadBut fix —
 * it fails with `EINVAL`, which says nothing about why. PATHEXT lists `.BAT` and
 * `.CMD`, and an operator override can name one outright, so a shim can reach
 * here even though `.EXE` wins under the default ordering.
 *
 * Refused rather than routed through `cmd.exe`: none of the tools this guards
 * ships as a script on a runner, so a shim here means something unexpected, and
 * a message naming the override is more use than a shell invocation nobody
 * asked for. `installer-core.mjs` does route through `cmd.exe`, because `npm`
 * genuinely is a shim there and it has no choice.
 */
function runnable(command: string, path: string): { path: string } | { refusal: string } {
  if (!/\.(cmd|bat)$/i.test(path)) return { path }
  return {
    refusal: `${command} resolves to ${path}, a Windows command script, which cannot be run without a shell.`
      + ` Point LOOPTROOP_${command.toUpperCase()}_PATH at the executable itself.`,
  }
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return false
  // Windows has no execute bit; the extension is what decides, and PATHEXT has
  // already chosen it by the time this runs. Taken from the platform passed in
  // rather than the real one, so the rules can be exercised off Windows —
  // reading `process.platform` here made every injected-platform case answer
  // for the machine running the test instead of the one being described.
  if (platform === 'win32') return true
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
