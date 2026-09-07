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
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * Directory prefixes a tool may be resolved from.
 *
 * Everything here is either root-owned on a hosted runner or the standard
 * installation root for the tool on that platform. The working directory, the
 * temporary directory and anything under the checkout are deliberately absent —
 * those are the ones a job's own inputs can write to.
 */
const TRUSTED_PREFIXES = [
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/bin',
  '/sbin',
  '/opt/hostedtoolcache',
  '/opt/homebrew/bin',
  '/home/linuxbrew/.linuxbrew/bin',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData\\chocolatey',
  'C:\\hostedtoolcache',
  'C:\\Windows\\system32',
]

/** Windows compares paths case-insensitively; POSIX does not. */
function withinTrustedPrefix(path: string): boolean {
  const normalise = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const candidate = normalise(path)
  return TRUSTED_PREFIXES.some((prefix) => candidate.startsWith(normalise(prefix)))
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
    pathValue = process.env.PATH ?? process.env.Path ?? '',
    pathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    platform = process.platform,
  }: {
    env?: NodeJS.ProcessEnv
    pathValue?: string
    pathExt?: string
    platform?: NodeJS.Platform
  } = {},
): { path: string } | { refusal: string } {
  // Named outright by an operator. Still has to exist and be executable; what
  // it does not have to be is inside a prefix this file knows about.
  const override = env[`LOOPTROOP_${command.toUpperCase()}_PATH`]?.trim()
  if (override) {
    if (!isAbsolute(override)) return { refusal: `LOOPTROOP_${command.toUpperCase()}_PATH must be an absolute path, and is '${override}'.` }
    if (!isExecutableFile(override)) return { refusal: `LOOPTROOP_${command.toUpperCase()}_PATH points at '${override}', which is not an executable file.` }
    return { path: override }
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
      if (!isExecutableFile(candidate)) continue
      if (withinTrustedPrefix(candidate)) return { path: candidate }
      return {
        refusal: `${command} resolves to ${candidate}, which is not in a directory this release trusts.`
          + ` Set LOOPTROOP_${command.toUpperCase()}_PATH if that location is deliberate.`,
      }
    }
  }

  return { refusal: `${command} was not found on PATH.` }
}

function isExecutableFile(path: string): boolean {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return false
  // Windows has no execute bit; the extension is what decides, and PATHEXT has
  // already chosen it by the time this runs.
  if (process.platform === 'win32') return true
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
