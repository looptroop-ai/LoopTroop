/**
 * Where an external tool actually lives, decided here rather than by `PATH`.
 *
 * `spawn('git', …)` names a tool and lets the operating system pick the file.
 * `shell: false` stops the *arguments* being re-parsed; it says nothing about
 * which binary runs. The first directory on `PATH` decides that, and this
 * daemon spawns `git`, `gh` and `opencode` inside a repository whose contents
 * it does not control — so "whatever answered to the name" is a decision worth
 * taking away from the environment.
 *
 * The rule is deliberately not "system directories only". Developers install
 * `git`, `gh`, `node` and `opencode` under a version manager's directory in
 * `~/.nvm`, under `~/.cargo/bin`, `~/.local/bin`, Homebrew and Nix; a resolver
 * that insists on `/usr/bin` closes a static-analysis rule by breaking every
 * version manager. What is refused is a directory anyone on the machine can
 * write to, because that is the case where the name and the file can be made
 * to disagree.
 *
 * `scripts/trusted-tool.ts` answers the same question with a *stricter* policy,
 * and the two are separate on purpose: it guards release jobs that hold
 * publishing credentials, where a hosted runner's `gh` genuinely does live in
 * `/usr/bin` and anything else is a reason to stop. This one guards a developer
 * machine, where it is not.
 *
 * What it does not promise: resolution is followed by a spawn, and the file can
 * be replaced in between. `LOOPTROOP_TRUSTED_EXECUTABLE_DIRS` is an operator
 * telling the daemon where its tools are — it is not a defence against an
 * attacker who can already set this process's environment, and nothing here
 * pretends otherwise.
 *
 * Erasable TypeScript only, and no relative imports. `scripts` modules import
 * this file under Node's type stripping, which rejects `enum`, `namespace` and
 * parameter properties, and `scripts/sync-installers.mjs` strips it into
 * `scripts/installer-core.mjs`, which runs with no repository around it.
 * Neither `tsc` nor vitest catches a violation of either constraint.
 */
import * as trustedFs from 'node:fs'
import * as trustedPath from 'node:path'

/** Directories to search ahead of `PATH`, delimiter-separated, absolute. */
export const TRUSTED_EXECUTABLE_DIRS_ENV = 'LOOPTROOP_TRUSTED_EXECUTABLE_DIRS'

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * A resolution, or the reason there is not one. Never both.
 *
 * `refusedAt` separates the two failures that must not be treated alike: a tool
 * that is *not installed*, where falling back to the bare name only reproduces
 * the ENOENT a caller already reports, and a tool that *is* there in a directory
 * this machine will not run from, where falling back would spawn the very file
 * this module exists to refuse.
 */
export type TrustedExecutableResolution =
  | { path: string; reason?: undefined; refusedAt?: undefined }
  | { path?: undefined; reason: string; refusedAt?: string }

export interface TrustedExecutableOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Test seam: the mount table consulted to recognise a Windows drive mount under WSL. */
  readMountTable?: () => string
  /** Test seam: `null` bypasses the process-wide cache entirely. */
  cache?: Map<string, CachedResolution> | null
}

/**
 * A resolved path plus enough of its identity to notice it was replaced.
 *
 * Caching the path alone survives `brew upgrade git`: the daemon keeps spawning
 * a path whose file is now a different program, or on Windows one that no
 * longer exists. Four fields is what it takes to see an in-place upgrade, and a
 * `stat` is noise beside the `spawn` it precedes.
 */
export interface CachedResolution {
  path: string
  dev: number
  ino: number
  mtimeMs: number
  size: number
}

const processCache = new Map<string, CachedResolution>()

/** Drops every cached resolution. Called on daemon start; otherwise for tests. */
export function resetTrustedExecutableCache(): void {
  processCache.clear()
}

/**
 * The directories a tool may be resolved from, in search order.
 *
 * The override is *prepended*, not used to filter `PATH`: an operator naming a
 * directory is telling the daemon where a tool is, and a tool that is not on
 * `PATH` at all is exactly the case they are answering. Filtering `PATH` by the
 * override — the shape this had when it was first written — resolves nothing
 * for the person who set it.
 *
 * Relative entries are dropped rather than resolved. `PATH` conventionally
 * carries `.` and empty segments, both of which mean the current directory, and
 * for a daemon whose current directory is a checkout that is the one location
 * that must never win.
 */
export function trustedSearchDirectories(options: TrustedExecutableOptions = {}): string[] {
  const env = options.env ?? process.env
  const pathValue = env.PATH ?? env.Path ?? ''
  const entries = [
    ...(env[TRUSTED_EXECUTABLE_DIRS_ENV] ?? '').split(trustedPath.delimiter),
    ...pathValue.split(trustedPath.delimiter),
  ]

  const seen = new Set<string>()
  const directories: string[] = []
  for (const entry of entries) {
    // Windows tolerates `"C:\Program Files\x"` in PATH and strips the quotes
    // itself; `join` does not, and the quoted form resolves to nothing.
    const directory = entry.trim().replace(/^"(.*)"$/, '$1')
    if (directory === '' || !trustedPath.isAbsolute(directory)) continue
    const normalised = trustedPath.resolve(directory)
    if (seen.has(normalised)) continue
    seen.add(normalised)
    directories.push(normalised)
  }
  return directories
}

/**
 * The extensions to try for `name`, on this platform.
 *
 * Windows has no execute bit; `PATHEXT` is what decides that a file is a
 * program, and `CreateProcess` never reads it — which is why a bare `npm`, an
 * `npm.cmd`, is invisible to a direct spawn. A name that already carries an
 * extension is taken as given.
 */
function candidateExtensions(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return ['']
  if (/\.[^\\/.]+$/.test(name)) return ['']
  // `||`, not `??`: an empty PATHEXT would leave no extensions to try at all.
  return (env.PATHEXT || DEFAULT_PATHEXT).split(';').map((value) => value.trim()).filter(Boolean)
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  if (!trustedFs.statSync(path, { throwIfNoEntry: false })?.isFile()) return false
  // Windows has no execute bit and PATHEXT has already chosen the extension by
  // the time this runs. Read from the platform passed in rather than the real
  // one, so the rules can be exercised off the platform they describe.
  if (platform === 'win32') return true
  try {
    trustedFs.accessSync(path, trustedFs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Whether `directory` sits on a Windows drive mounted into WSL.
 *
 * DrvFs reports mode `0777` for every file it shows, so a world-writable test
 * fails for a Windows-side Git under `/mnt/c` and for every other Windows tool
 * a WSL developer uses — the mode is not describing permissions, it is
 * describing a filesystem that has none to report. The mode check is therefore
 * skipped here, and only here.
 *
 * Decided from the mount table rather than by matching `/mnt/`, because `/mnt`
 * is an ordinary directory that anything may be mounted under, and a rule that
 * trusts a path prefix is a rule an attacker can satisfy with a `mkdir`. The
 * longest matching mount point wins, as the kernel would resolve it.
 */
function isWindowsDriveMount(directory: string, mountTable: string): boolean {
  let bestPoint = ''
  let bestType = ''
  for (const line of mountTable.split('\n')) {
    const fields = line.split(' ')
    const point = fields[1]
    const type = fields[2]
    if (point === undefined || type === undefined) continue
    // /proc/mounts octal-escapes spaces and tabs in mount points.
    const decoded = point.replace(/\\(\d{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)))
    const covers = decoded === '/' || directory === decoded || directory.startsWith(`${decoded}/`)
    if (!covers || decoded.length < bestPoint.length) continue
    bestPoint = decoded
    bestType = type
  }
  // `drvfs` is WSL1 and WSL2's default; `9p` and `virtiofs` are what WSL2 has
  // used for the same mounts across builds. All three are a Windows filesystem
  // seen through a translation layer, and none of them reports a real mode.
  return bestType === 'drvfs' || bestType === '9p' || bestType === 'virtiofs'
}

function readMountTableFromProc(): string {
  try {
    return trustedFs.readFileSync('/proc/mounts', 'utf8')
  } catch {
    // No mount table is not WSL. Falling back to "trust it" here would make an
    // unreadable file the way past the check.
    return ''
  }
}

/**
 * Directories Windows programs are legitimately installed into.
 *
 * `fs.stat` mode is meaningless on NTFS — everything reports `0777` — so
 * "user-owned and not world-writable" cannot be the Windows test. What is left
 * that Node can see is *where* the file is, so the rule is a location one: the
 * system roots, or somewhere under this user's own profile, which is where
 * every Windows version manager puts things (scoop, nvm-windows, npm's global
 * prefix, `%LOCALAPPDATA%\Programs`). Anything else — `C:\temp`, a network
 * share, a directory inside a checkout — is refused, and named by the override
 * if it is deliberate.
 */
function windowsTrustedRoots(env: NodeJS.ProcessEnv): string[] {
  const root = (value: string | undefined, fallback: string): string => {
    const candidate = value?.trim()
    // `??` is not enough: an unset-but-present variable is the empty string,
    // and `resolve('')` is the current working directory — which would make the
    // checkout a trusted root.
    return candidate !== undefined && candidate !== '' && trustedPath.win32.isAbsolute(candidate) ? candidate : fallback
  }
  const userProfile = root(env.USERPROFILE, 'C:\\Users\\Default')
  return [
    root(env.ProgramFiles, 'C:\\Program Files'),
    root(env['ProgramFiles(x86)'], 'C:\\Program Files (x86)'),
    root(env.ProgramData, 'C:\\ProgramData'),
    root(env.SystemRoot, 'C:\\Windows'),
    userProfile,
    root(env.LOCALAPPDATA, trustedPath.win32.join(userProfile, 'AppData\\Local')),
    root(env.APPDATA, trustedPath.win32.join(userProfile, 'AppData\\Roaming')),
  ]
}

/**
 * Whether `path` is inside `root`, by path segment.
 *
 * `startsWith` is a hole: `/usr/bin-of-mine` starts with `/usr/bin`, so a
 * directory that merely shares a prefix with a trusted one passes. `relative()`
 * asks the question actually being asked.
 */
function isWithin(root: string, path: string, platform: NodeJS.Platform): boolean {
  const fold = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value)
  const from = fold(trustedPath.resolve(root))
  const to = fold(path)
  if (from === to) return true
  const step = trustedPath.relative(from, to)
  return step !== '' && !step.startsWith('..') && !trustedPath.isAbsolute(step)
}

/** Why a directory is not trusted, or `null` when it is. */
function directoryRefusal(
  directory: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  readMountTable: () => string,
  namedByOperator: boolean,
): string | null {
  const stats = trustedFs.statSync(directory, { throwIfNoEntry: false })
  if (!stats?.isDirectory()) return 'it is not a directory'

  if (platform === 'win32') {
    // "A known-safe *or explicitly configured* directory" — and on Windows the
    // second half carries real weight, because there is no permission check to
    // fall back on. `fs.stat` mode is 0777 for everything on NTFS, so an
    // operator naming a directory is the only signal available for a tool that
    // lives somewhere this list does not know about. On POSIX the override is
    // *not* excused the mode check, because there the mode means something.
    if (namedByOperator) return null
    return windowsTrustedRoots(env).some((root) => isWithin(root, directory, platform))
      ? null
      : 'it is outside the system and user-profile directories'
  }

  const worldWritable = (stats.mode & 0o002) !== 0
  if (worldWritable && !isWindowsDriveMount(directory, readMountTable())) return 'it is writable by any user on this machine'

  // A directory owned by neither root nor this user is one somebody else can
  // refill. `getuid` is absent only on Windows, which returned above.
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== 0 && stats.uid !== uid) return `it is owned by uid ${stats.uid}`
  return null
}

/**
 * The file `name` would run as, if it is one this daemon is willing to spawn.
 *
 * A hit in an untrusted directory is refused rather than skipped. Carrying on
 * down `PATH` would resolve to a *different* program than the one the operating
 * system would have run — silently, and differently from every other tool on
 * the machine, which is worse than saying no.
 */
export function resolveTrustedExecutable(
  name: string,
  options: TrustedExecutableOptions = {},
): TrustedExecutableResolution {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const readMountTable = options.readMountTable ?? readMountTableFromProc

  if (name === '') return { reason: 'An empty program name cannot be resolved.' }
  if (/[\\/]/.test(name) || trustedPath.isAbsolute(name)) {
    return { reason: `'${name}' is a path, not a program name; resolve it against its intended root instead.` }
  }

  const directories = trustedSearchDirectories({ env })
  const namedByOperator = new Set(
    trustedSearchDirectories({ env: { [TRUSTED_EXECUTABLE_DIRS_ENV]: env[TRUSTED_EXECUTABLE_DIRS_ENV] ?? '', PATH: '' } }),
  )
  const extensions = candidateExtensions(name, platform, env)
  const cache = options.cache === undefined ? processCache : options.cache
  const cacheKey = `${platform}\u0000${name}\u0000${extensions.join(';')}\u0000${directories.join(trustedPath.delimiter)}`

  const cached = cache?.get(cacheKey)
  if (cached) {
    const stats = trustedFs.statSync(cached.path, { throwIfNoEntry: false })
    if (
      stats?.isFile()
      && stats.dev === cached.dev
      && stats.ino === cached.ino
      && stats.mtimeMs === cached.mtimeMs
      && stats.size === cached.size
    ) {
      return { path: cached.path }
    }
    // Replaced in place, or gone. Resolve again rather than reporting either.
    cache?.delete(cacheKey)
  }

  for (const directory of directories) {
    const refusal = directoryRefusal(directory, platform, env, readMountTable, namedByOperator.has(directory))
    for (const extension of extensions) {
      const candidate = trustedPath.join(directory, `${name}${extension}`)
      if (!isExecutableFile(candidate, platform)) continue
      if (refusal !== null) {
        return {
          reason: `${name} resolves to ${candidate}, in a directory this daemon does not trust: ${refusal}.`
            + ` Set ${TRUSTED_EXECUTABLE_DIRS_ENV} to a directory holding a trusted ${name} if that location is deliberate.`,
          refusedAt: candidate,
        }
      }
      // The *search* directory is what has to be trusted, not the symlink's
      // target: Homebrew and Nix both put a link in a trusted directory
      // pointing into a store nobody would list. `realpath` afterwards, so the
      // path that gets spawned is the file itself and the cache can tell when
      // an upgrade replaced it.
      let resolved: string
      try {
        resolved = trustedFs.realpathSync(candidate)
      } catch {
        continue
      }
      const stats = trustedFs.statSync(resolved, { throwIfNoEntry: false })
      if (!stats?.isFile()) continue
      cache?.set(cacheKey, {
        path: resolved,
        dev: stats.dev,
        ino: stats.ino,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      })
      return { path: resolved }
    }
  }

  return {
    reason: `${name} was not found in any trusted directory on PATH.`
      + ` Install it, or set ${TRUSTED_EXECUTABLE_DIRS_ENV} to the directory holding it.`,
  }
}

/**
 * The path to `name`, or `null` if there is not a trusted one.
 *
 * Callers pass the result straight to `spawn`, and a `null` means the tool is
 * unavailable — the same condition as it not being installed, reported through
 * whatever the caller already does about that. Nothing that used to degrade
 * becomes fatal because of this module.
 */
export function findTrustedExecutablePath(name: string, options: TrustedExecutableOptions = {}): string | null {
  return resolveTrustedExecutable(name, options).path ?? null
}

/**
 * As `resolveTrustedExecutable`, but accepting a program a caller named by
 * absolute path.
 *
 * The trust question is about `PATH` choosing the file. An absolute path is the
 * caller choosing it — `process.execPath`, a plan that names a tool outright —
 * and there is no search to hijack, so what is checked is only that the path
 * names an executable file. It is still `realpath`ed, so the spawn and any
 * later diagnostic agree on which file ran.
 *
 * A *relative* path is refused rather than resolved. Which directory it is
 * relative to is the caller's decision and differs per call site: the daemon's
 * working directory is a checkout, and quietly picking that would be the
 * current-directory hole in a different shape. Callers that have an intended
 * root resolve against it and pass the absolute result.
 */
export function resolveTrustedProgram(
  program: string,
  options: TrustedExecutableOptions = {},
): TrustedExecutableResolution {
  const platform = options.platform ?? process.platform
  if (!trustedPath.isAbsolute(program)) return resolveTrustedExecutable(program, options)
  if (!isExecutableFile(program, platform)) return { reason: `${program} is not an executable file.` }
  // Named outright and present: there is no search to hijack, so the only
  // question left was whether it is a program at all.
  try {
    return { path: trustedFs.realpathSync(program) }
  } catch {
    return { reason: `${program} could not be resolved to a real path.` }
  }
}

/** The path to `name`, or an error saying why there is not one. */
export function requireTrustedExecutablePath(name: string, options: TrustedExecutableOptions = {}): string {
  const resolution = resolveTrustedExecutable(name, options)
  if (resolution.path === undefined) throw new Error(resolution.reason)
  return resolution.path
}
