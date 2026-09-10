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
 * **What this does and does not promise.** The guarantee is that the *file* is
 * chosen once, here, and spawned by path — `PATH` never gets to decide at spawn
 * time, and the current directory never wins. On POSIX there is one further
 * check: the directory, and the file it resolves to, must be owned by root or
 * by this user, so a directory belonging to somebody else cannot supply the
 * tool.
 *
 * It deliberately does **not** judge permission bits. That rule was here and it
 * was wrong in practice: GitHub's Ubuntu runners ship a world-writable
 * `/usr/local/bin`, so LoopTroop refused its own `npm` inside a container, and
 * every hosted Windows runner keeps npm in `C:\hostedtoolcache`, which no
 * location list was going to predict. A control that refuses the standard
 * layout of the platforms we ship on is not a control, it is an outage. If a
 * machine's `/usr/local/bin` is world-writable, the resolver refusing to run is
 * not what saves it.
 *
 * On Windows there is no equivalent check at all, and pretending otherwise was
 * the second mistake: `fs.stat` reports mode `0777` and uid `0` for everything
 * on NTFS, so neither the mode nor the owner means anything. Windows gets
 * `PATHEXT` handling and the structural rules; an operator who wants the search
 * narrowed uses the override.
 *
 * `scripts/trusted-tool.ts` answers the same question with a *stricter* policy,
 * and the two are separate on purpose: it guards release jobs that hold
 * publishing credentials, where a hosted runner's `gh` genuinely does live in
 * `/usr/bin` and anything else is a reason to stop. This one guards a developer
 * machine and a container, where it is not.
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

/** The fields that tell one file apart from another at the same path. */
export interface FileIdentity {
  dev: number
  ino: number
  mtimeMs: number
}

/**
 * A resolved path, and enough about how it was reached to notice it moved.
 *
 * Caching the path alone survives `brew upgrade git`: the daemon keeps spawning
 * a path whose file is now a different program, or on Windows one that no
 * longer exists. So the entry keeps the file's identity, the `PATH` candidate
 * that led to it with the link's own identity — a retargeted link leaves the
 * old target untouched — and the search directory, so the ownership rule can be
 * re-run on a hit. A handful of `stat`s is noise beside the `spawn` they
 * precede.
 */
export interface CachedResolution extends FileIdentity {
  path: string
  size: number
  /** The `PATH` entry that was found — a link, often, rather than the file. */
  candidate: string
  candidateIdentity: FileIdentity
  directory: string
}

/**
 * Lives as long as the process does, and starts empty, so there is nothing to
 * clear on daemon start. There used to be a reset function whose comment said
 * it was called then; nothing called it, and the tests inject their own map.
 */
const processCache = new Map<string, CachedResolution>()

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
  const platform = options.platform ?? process.platform
  const p = pathFor(platform)
  const pathValue = env.PATH ?? env.Path ?? ''
  const entries = [
    ...(env[TRUSTED_EXECUTABLE_DIRS_ENV] ?? '').split(p.delimiter),
    ...windowsSystemDirectories(platform, env),
    ...pathValue.split(p.delimiter),
  ]

  return searchEntries(entries, platform)
}

/**
 * Raw search-list entries to directories, by the rules of `platform`.
 *
 * Parsing follows the platform being described — its separator, what counts as
 * absolute, whether case matters when deciding two entries are the same — but
 * the value is only trimmed, never rewritten. `path.win32.normalize` turns
 * `/tmp/x` into `\\tmp\\x`, which is correct for Windows and names nothing on
 * the Linux host the Windows rules are tested from; the file lookup is always
 * the host's.
 */
function searchEntries(entries: readonly string[], platform: NodeJS.Platform): string[] {
  const p = pathFor(platform)
  const seen = new Set<string>()
  const directories: string[] = []
  for (const entry of entries) {
    // Windows tolerates `"C:\\Program Files\\x"` in PATH and strips the quotes
    // itself; `join` does not, and the quoted form resolves to nothing.
    let directory = entry.trim().replace(/^"(.*)"$/, '$1')
    // Relative entries are dropped, never resolved: `.` and an empty segment
    // both mean the current directory, which for a daemon is a checkout.
    if (directory === '' || !p.isAbsolute(directory)) continue
    const root = p.parse(directory).root
    while (directory.length > root.length && /[\\/]$/.test(directory)) directory = directory.slice(0, -1)
    const key = platform === 'win32' ? directory.toLowerCase() : directory
    if (seen.has(key)) continue
    seen.add(key)
    directories.push(directory)
  }
  return directories
}

/**
 * The directories Windows itself searches before `PATH`.
 *
 * `CreateProcess` looks in the system directories first, which is why
 * `taskkill`, `explorer.exe`, `rundll32.exe` and `powershell.exe` work from a
 * shell whose `PATH` never mentions them. Searching `PATH` alone made those
 * built-ins disappear on any machine with a trimmed `PATH` — a resolver that is
 * *narrower* than the OS it replaces, which is a regression rather than a
 * hardening. Empty on every other platform.
 */
function windowsSystemDirectories(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return []
  const systemRoot = env.SystemRoot?.trim() || env.windir?.trim() || 'C:\\Windows'
  if (!trustedPath.win32.isAbsolute(systemRoot)) return []
  return [
    trustedPath.win32.join(systemRoot, 'System32'),
    systemRoot,
    trustedPath.win32.join(systemRoot, 'System32', 'Wbem'),
    trustedPath.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
  ]
}

/**
 * `node:path` for the platform being *described*, not the one running.
 *
 * `platform` is a test seam, and it was only half a seam: PATHEXT and the trust
 * branch honoured it while `delimiter`, `isAbsolute`, `resolve` and `relative`
 * came from the host. A `platform: 'win32'` case on Linux therefore split PATH
 * on `:` and compared `C:\...` with POSIX rules, so the Windows semantics were
 * never actually exercised — the exact defect class `scripts/trusted-tool.ts`
 * takes `platform` to avoid.
 */
function pathFor(platform: NodeJS.Platform): trustedPath.PlatformPath {
  return platform === 'win32' ? trustedPath.win32 : trustedPath.posix
}

/**
 * `statSync` that answers `null` for every reason a path cannot be inspected.
 *
 * `throwIfNoEntry: false` suppresses ENOENT and nothing else. An unreadable
 * `PATH` entry — EACCES, a dead network mount, EPERM under a sandbox — still
 * threw, out of a function whose entire contract is to return a resolution or a
 * reason. One bad directory on `PATH` crashed the lookup instead of being
 * skipped, which is neither of the two answers this module is allowed to give.
 */
function statOrNull(path: string): trustedFs.Stats | null {
  try {
    return trustedFs.statSync(path, { throwIfNoEntry: false }) ?? null
  } catch {
    return null
  }
}

/** `lstatSync` with the same contract, for identifying the link itself. */
function lstatOrNull(path: string): trustedFs.Stats | null {
  try {
    return trustedFs.lstatSync(path, { throwIfNoEntry: false }) ?? null
  } catch {
    return null
  }
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
  if (!statOrNull(path)?.isFile()) return false
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
 * Whether `path` sits on a Windows drive mounted into WSL.
 *
 * DrvFs invents its ownership: every file shows the uid the mount was made
 * with, which is this user by default but `root` for an elevated mount and
 * whatever `uid=` said for a custom one. The owner there describes a mount
 * option, not a person, so the ownership check is skipped on these mounts and
 * only on these.
 *
 * Decided from the mount table rather than by matching `/mnt/`, because `/mnt`
 * is an ordinary directory that anything may be mounted under, and a rule that
 * trusts a path prefix is a rule anyone can satisfy with a `mkdir`. The longest
 * matching mount point wins, as the kernel would resolve it.
 */
function isWindowsDriveMount(path: string, mountTable: string): boolean {
  let bestPoint = ''
  let bestType = ''
  for (const line of mountTable.split('\n')) {
    const fields = line.split(' ')
    const point = fields[1]
    const type = fields[2]
    if (point === undefined || type === undefined) continue
    // /proc/mounts octal-escapes spaces and tabs in mount points.
    const decoded = point.replace(/\\(\d{3})/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 8)))
    const covers = decoded === '/' || path === decoded || path.startsWith(`${decoded}/`)
    if (!covers || decoded.length < bestPoint.length) continue
    bestPoint = decoded
    bestType = type
  }
  // `drvfs` is WSL1 and WSL2's default; `9p` and `virtiofs` are what WSL2 has
  // used for the same mounts across builds.
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

/** What the ownership rule needs to know about the call it is judging. */
interface TrustContext {
  platform: NodeJS.Platform
  readMountTable: () => string
  /** The search directory came from the operator's override. */
  namedByOperator: boolean
}

/**
 * Why `path` fails the ownership rule, or `null` when it passes.
 *
 * Owned by root or by this user, and nothing else. Permission bits are not
 * consulted — see the module comment for why that rule was withdrawn. Windows
 * answers `null` because NTFS ownership is invisible to `fs.stat`, which
 * reports uid 0 for every file. A directory the operator named is excused: the
 * override is exactly how someone says "this directory belongs to a service
 * account and that is deliberate".
 */
function ownershipRefusal(path: string, what: string, context: TrustContext): string | null {
  if (context.platform === 'win32' || context.namedByOperator) return null
  const stats = statOrNull(path)
  if (stats === null) return `its ${what} could not be inspected`
  const uid = process.getuid?.()
  if (uid === undefined || stats.uid === 0 || stats.uid === uid) return null
  if (isWindowsDriveMount(path, context.readMountTable())) return null
  return `its ${what} is owned by uid ${stats.uid}, which is neither root nor you`
}

/**
 * Why the file behind `directory` may not be run, or `null` when it may.
 *
 * Judged on both sides of the link: the search directory, which is what `PATH`
 * offered, and the real file with its own directory. Checking only the first
 * was the gap — a link in a trusted directory could point into a tree someone
 * else owns, and the resolver returned the file there. Homebrew and Nix still
 * pass, because their stores belong to the user who installed them or to root.
 */
function candidateRefusal(directory: string, resolved: string, context: TrustContext): string | null {
  if (!statOrNull(directory)?.isDirectory()) return 'its directory is not a directory'
  return ownershipRefusal(directory, 'directory', context)
    ?? ownershipRefusal(trustedPath.dirname(resolved), 'target directory', context)
    ?? ownershipRefusal(resolved, 'file', context)
}

function realpathOrNull(path: string): string | null {
  try {
    return trustedFs.realpathSync(path)
  } catch {
    return null
  }
}

function identityMatches(stats: trustedFs.Stats | null, entry: FileIdentity & { size?: number }): boolean {
  return stats !== null
    && stats.dev === entry.dev
    && stats.ino === entry.ino
    && stats.mtimeMs === entry.mtimeMs
    && (entry.size === undefined || stats.size === entry.size)
}

/**
 * Whether a cached answer still describes what `PATH` would pick, now.
 *
 * Three things can move under a long-lived daemon, and the first version of
 * this cache watched only the last of them:
 *
 * - **The link.** An upgrade that retargets `bin/git` from `store/1.0` to
 *   `store/2.0` while keeping the old version on disk left the old target
 *   untouched, so a cache that stat'ed only the target kept spawning the old
 *   program. The link is compared with `lstat` and resolved again.
 * - **The trust.** A directory that changed owner after the first lookup kept
 *   serving the cached answer. The ownership rule is re-run on every hit.
 * - **The file.** Replaced in place — `brew upgrade` writing a new file at the
 *   same path — which dev/ino/mtime/size catch.
 */
function cachedResolutionHolds(entry: CachedResolution, context: TrustContext): boolean {
  if (!identityMatches(lstatOrNull(entry.candidate), entry.candidateIdentity)) return false
  if (realpathOrNull(entry.candidate) !== entry.path) return false
  const stats = statOrNull(entry.path)
  if (!stats?.isFile() || !identityMatches(stats, entry)) return false
  return candidateRefusal(entry.directory, entry.path, context) === null
}

/**
 * The file `name` would run as, if it is one this daemon is willing to spawn.
 *
 * A hit that fails the ownership rule is refused rather than skipped. Carrying
 * on down `PATH` would resolve to a *different* program than the one the
 * operating system would have run — silently, and differently from every other
 * tool on the machine, which is worse than saying no.
 */
export function resolveTrustedExecutable(
  name: string,
  options: TrustedExecutableOptions = {},
): TrustedExecutableResolution {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const p = pathFor(platform)
  const readMountTable = options.readMountTable ?? readMountTableFromProc

  if (name === '') return { reason: 'An empty program name cannot be resolved.' }
  if (/[\\/]/.test(name) || p.isAbsolute(name)) {
    return { reason: `'${name}' is a path, not a program name; resolve it against its intended root instead.` }
  }

  const override = env[TRUSTED_EXECUTABLE_DIRS_ENV] ?? ''
  const directories = trustedSearchDirectories({ env, platform })
  const namedByOperator = new Set(searchEntries(override.split(p.delimiter), platform))
  const extensions = candidateExtensions(name, platform, env)
  const cache = options.cache === undefined ? processCache : options.cache
  // The override is in the key as well as in the directory list, because a
  // directory can be on both and only the override excuses the ownership rule:
  // without it, an answer trusted *because* the operator named a directory
  // outlived the operator un-naming it.
  const cacheKey = [platform, name, extensions.join(';'), override, directories.join(p.delimiter)].join('\u0000')

  const cached = cache?.get(cacheKey)
  if (cached) {
    const context = { platform, readMountTable, namedByOperator: namedByOperator.has(cached.directory) }
    if (cachedResolutionHolds(cached, context)) return { path: cached.path }
    // Moved, retargeted, replaced or no longer trusted. Resolve again rather
    // than reporting any of those.
    cache?.delete(cacheKey)
  }

  for (const directory of directories) {
    const context = { platform, readMountTable, namedByOperator: namedByOperator.has(directory) }
    for (const extension of extensions) {
      // The host's `join`: whatever the platform being described, the file is
      // looked up on the filesystem this process is running on.
      const candidate = trustedPath.join(directory, `${name}${extension}`)
      if (!isExecutableFile(candidate, platform)) continue
      // `realpath` before judging, so what is judged is the file that will run
      // and the cache can tell when an upgrade replaced it.
      const resolved = realpathOrNull(candidate)
      const refusal = resolved === null
        ? 'it could not be resolved to a real file'
        : candidateRefusal(directory, resolved, context)
      if (resolved === null || refusal !== null) {
        return {
          reason: `${name} resolves to ${candidate}, which this daemon will not run: ${refusal}.`
            + ` Set ${TRUSTED_EXECUTABLE_DIRS_ENV} to the directory holding it if that location is deliberate.`,
          refusedAt: candidate,
        }
      }
      const stats = statOrNull(resolved)
      const candidateStats = lstatOrNull(candidate)
      if (!stats?.isFile() || candidateStats === null) continue
      cache?.set(cacheKey, {
        path: resolved,
        dev: stats.dev,
        ino: stats.ino,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        candidate,
        candidateIdentity: { dev: candidateStats.dev, ino: candidateStats.ino, mtimeMs: candidateStats.mtimeMs },
        directory,
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
  const resolved = realpathOrNull(program)
  if (resolved === null) return { reason: `${program} could not be resolved to a real path.` }
  // No search to hijack, but the ownership rule still applies to the file and
  // where it really lives: a program named outright is no more trustworthy for
  // sitting in somebody else's directory than one `PATH` found there. Refused
  // with `refusedAt`, so a caller that falls back on "not found" does not fall
  // back onto this.
  const context = { platform, readMountTable: options.readMountTable ?? readMountTableFromProc, namedByOperator: false }
  const refusal = ownershipRefusal(trustedPath.dirname(resolved), 'directory', context) ?? ownershipRefusal(resolved, 'file', context)
  if (refusal !== null) return { reason: `${program} will not be run: ${refusal}.`, refusedAt: program }
  return { path: resolved }
}

/** The path to `name`, or an error saying why there is not one. */
export function requireTrustedExecutablePath(name: string, options: TrustedExecutableOptions = {}): string {
  const resolution = resolveTrustedExecutable(name, options)
  if (resolution.path === undefined) throw new Error(resolution.reason)
  return resolution.path
}
