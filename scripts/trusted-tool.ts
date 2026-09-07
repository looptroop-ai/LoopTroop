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
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Directory prefixes a tool may be resolved from.
 *
 * Everything here is either root-owned on a hosted runner or the standard
 * installation root for the tool on that platform. The working directory, the
 * temporary directory and anything under the checkout are deliberately absent —
 * those are the ones a job's own inputs can write to.
 */
export function defaultTrustedPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
  // The Windows roots come from the environment rather than a literal `C:\`.
  // The system drive is not always C on a hosted runner, and a hardcoded letter
  // would silently refuse every tool on a machine where it is not.
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const programData = env.ProgramData ?? 'C:\\ProgramData'
  const systemDrive = env.SystemDrive ?? 'C:'

  return [
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/usr/sbin',
    '/bin',
    '/sbin',
    '/opt/hostedtoolcache',
    '/opt/homebrew/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    programFiles,
    programFilesX86,
    join(programData, 'chocolatey'),
    join(systemDrive, 'hostedtoolcache'),
    join(systemRoot, 'system32'),
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
    pathValue = process.env.PATH ?? process.env.Path ?? '',
    pathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
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
      if (!isExecutableFile(candidate, platform)) continue
      if (withinTrustedPrefix(candidate, platform, trustedPrefixes)) return { path: candidate }
      return {
        refusal: `${command} resolves to ${candidate}, which is not in a directory this release trusts.`
          + ` Set LOOPTROOP_${command.toUpperCase()}_PATH if that location is deliberate.`,
      }
    }
  }

  return { refusal: `${command} was not found on PATH.` }
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
