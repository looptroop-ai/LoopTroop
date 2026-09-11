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
 * **What this does and does not promise.** The *file* is chosen once, here,
 * and `PATH` never gets to choose at spawn time; the current directory never
 * wins. On POSIX there is one further check: the directory a tool was found in,
 * the real file behind it, and every directory above both, must belong to root,
 * to this user, or to whoever owns the Node binary running LoopTroop — so a
 * directory somebody else controls cannot supply the tool.
 *
 * What gets *spawned* is the `PATH` entry, not the real file behind it. The
 * real file is what is judged; the entry is what runs. A tool that works out
 * where it lives from how it was invoked breaks otherwise: Homebrew takes its
 * prefix from `$0`, so `brew` run by its real path decided it lived in
 * `.linuxbrew/Homebrew`, found no bottles, and compiled Node from source for
 * forty minutes. Rustup's `cargo`, mise and Volta shims and busybox all dispatch
 * on the name they were started by, for the same reason.
 *
 * It deliberately does **not** judge permission bits. That rule was here and it
 * was wrong in practice: GitHub's Ubuntu runners ship a world-writable
 * `/usr/local/bin`, so LoopTroop refused its own `npm` inside a container, and
 * every hosted Windows runner keeps npm in `C:\hostedtoolcache`, which no
 * location list was going to predict. A control that refuses the standard
 * layout of the platforms we ship on is not a control, it is an outage.
 *
 * On Windows there is no ownership check either: `fs.stat` reports mode `0777`
 * and uid `0` for everything on NTFS, so neither means anything. Windows gets
 * `PATHEXT` handling, the system directories searched first as `CreateProcess`
 * searches them, and the structural rules. The override adds directories to
 * search; it cannot narrow the search, on Windows or anywhere else.
 *
 * The policy inputs — the override, the Windows system root, `PATHEXT` and
 * `ComSpec` — are read from this process's environment (`policyEnv`), never
 * from the one a child is being given. A command that could set its own
 * `LOOPTROOP_TRUSTED_EXECUTABLE_DIRS` could vouch for any directory it liked.
 *
 * `scripts/trusted-tool.ts` answers the same question with a *stricter* policy,
 * and the two are separate on purpose: it guards release jobs that hold
 * publishing credentials, where a hosted runner's `gh` genuinely does live in
 * `/usr/bin` and anything else is a reason to stop. This one guards a developer
 * machine and a container, where it is not.
 *
 * What it does not promise: resolution is followed by a spawn, and the file can
 * change in between. Spawning the entry rather than the real file widens that a
 * little: a link in the entry's path can be pointed somewhere else after the
 * check, and the operating system follows it again at spawn time. Whoever can do
 * that owns a directory on the way, which the ownership rule has already
 * refused — it walks the path as written as well as the real one — so the
 * window is open to root, this user and the Node binary's owner, who could
 * replace the tool outright anyway. `LOOPTROOP_TRUSTED_EXECUTABLE_DIRS` is an
 * operator telling the daemon where its tools are — it is not a defence against
 * an attacker who can already set this process's environment, and nothing here
 * pretends otherwise.
 *
 * Nor does it choose the Node that runs it. `looptroop` starts through
 * `#!/usr/bin/env node`, the bundle's wrappers call `node`, and the install
 * scripts look `node` up before any of this code exists — the one lookup this
 * module cannot make, because its answer is what runs the module. The install
 * scripts drop empty and relative `PATH` entries before theirs; beyond that, the
 * interpreter is whichever one the user's shell finds, and it is the root every
 * later decision here trusts.
 *
 * Erasable TypeScript only, and `node:` imports only. `scripts` modules import
 * this file under Node's type stripping, which rejects `enum`, `namespace` and
 * parameter properties, and `scripts/sync-installers.mjs` strips it into
 * `scripts/installer-core.mjs`, which runs with no repository around it.
 * `installers:check` refuses a violation of either.
 */
import * as trustedFs from 'node:fs'
import * as trustedPath from 'node:path'

/** Directories to search ahead of `PATH`, delimiter-separated, absolute. */
export const TRUSTED_EXECUTABLE_DIRS_ENV = 'LOOPTROOP_TRUSTED_EXECUTABLE_DIRS'

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * A resolution, or the reason there is not one. Never both.
 *
 * `path` is what to spawn: the entry `PATH` offered, or the absolute path the
 * caller named. `target` is the real file behind it — the one that was judged,
 * and the one to check containment against.
 *
 * `refusedAt` separates the two failures that must not be treated alike: a tool
 * that is *not installed*, and a tool that *is* there somewhere this machine
 * will not run it from. Falling back to the bare name after a refusal would
 * spawn the very file this module exists to refuse.
 */
export type TrustedExecutableResolution =
  | { path: string; target?: string; reason?: undefined; refusedAt?: undefined }
  | { path?: undefined; target?: undefined; reason: string; refusedAt?: string }

export interface TrustedExecutableOptions {
  /** The environment whose `PATH` is searched: the child's. */
  env?: NodeJS.ProcessEnv
  /**
   * Where the trust policy comes from — the override, the Windows system root,
   * `PATHEXT` and `ComSpec`. **Defaults to this process's environment, never to
   * `env`.** It used to default to `env`, which meant every caller resolving for
   * a child had to remember to split the two, and three of them did not: a
   * child environment carrying `LOOPTROOP_TRUSTED_EXECUTABLE_DIRS` vouched for
   * itself. Pass it only to describe a different operator, as tests do.
   */
  policyEnv?: NodeJS.ProcessEnv
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
 * A resolution, and enough about how it was reached to notice it moved.
 *
 * The file's identity catches an in-place upgrade. The candidate's own lstat
 * identity catches a link retargeted while the old version stayed on disk. The
 * directory and extension let a hit prove that nothing earlier in the search
 * now answers first, and let the ownership rule be re-run. A handful of `stat`s
 * is noise beside the `spawn` they precede.
 */
export interface CachedResolution extends FileIdentity {
  /** The real file. */
  path: string
  size: number
  /** The `PATH` entry that was found and is what gets spawned. */
  candidate: string
  candidateIdentity: FileIdentity
  directory: string
  extension: string
}

/**
 * Lives as long as the process does, and starts empty, so there is nothing to
 * clear on daemon start. Keyed per name, platform, extensions, override and
 * search list — and every project's `pathPrepend` is a different search list —
 * so it is bounded, dropping the oldest entry once it holds this many. A miss
 * costs one fresh resolution, never a wrong answer.
 */
const processCache = new Map<string, CachedResolution>()
const CACHE_LIMIT = 256

function remember(cache: Map<string, CachedResolution>, key: string, entry: CachedResolution): void {
  cache.delete(key)
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, entry)
}

/** `node:path` for the platform being *described*, not the one running. */
function pathFor(platform: NodeJS.Platform): trustedPath.PlatformPath {
  return platform === 'win32' ? trustedPath.win32 : trustedPath.posix
}

/**
 * The directories a tool may be resolved from, in search order.
 *
 * The override is *prepended*, not used to filter `PATH`: an operator naming a
 * directory is telling the daemon where a tool is, and a tool that is not on
 * `PATH` at all is exactly the case they are answering.
 *
 * Relative entries are dropped rather than resolved. `PATH` conventionally
 * carries `.` and empty segments, both of which mean the current directory, and
 * for a daemon whose current directory is a checkout that is the one location
 * that must never win.
 */
export function trustedSearchDirectories(options: TrustedExecutableOptions = {}): string[] {
  const env = options.env ?? process.env
  const policyEnv = options.policyEnv ?? process.env
  const platform = options.platform ?? process.platform
  const p = pathFor(platform)
  const pathValue = env.PATH ?? env.Path ?? ''
  return searchEntries([
    ...(policyEnv[TRUSTED_EXECUTABLE_DIRS_ENV] ?? '').split(p.delimiter),
    ...windowsSystemDirectories(platform, policyEnv),
    ...pathValue.split(p.delimiter),
  ], platform)
}

/**
 * Whether spawning a *bare name* would let the operating system look in the
 * current directory — so whether a caller may fall back to one after the
 * resolver found nothing.
 *
 * The resolver never searches the working directory. The operating system's own
 * search, which a bare-name spawn hands the choice to, sometimes does:
 *
 * - **POSIX** searches `PATH` exactly as written, and an empty or relative entry
 *   is the working directory: `PATH=/usr/bin:` — a trailing colon, the everyday
 *   result of `PATH=$PATH:` — ran `./tool`.
 * - **Windows** looks in the current directory *before* `PATH`, whatever `PATH`
 *   says. Both `CreateProcess` and libuv's own search (`src/win/process.c`,
 *   "look in cwd first, then scan path") do it, and so does cmd.exe. The one
 *   off switch is `NoDefaultCurrentDirectoryInExePath` in the environment of the
 *   process doing the spawning — this one, which is why `callerEnv` is
 *   `process.env` and not the child's.
 */
export function bareNameSearchReachesWorkingDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  callerEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform === 'win32' && callerEnv.NoDefaultCurrentDirectoryInExePath === undefined) return true
  const p = pathFor(platform)
  const pathValue = env.PATH ?? env.Path ?? ''
  return pathValue.split(p.delimiter).some((entry) => {
    const directory = asSearchDirectory(entry, platform)
    return directory === '' || !p.isAbsolute(directory)
  })
}

/**
 * One raw `PATH` entry as a directory name.
 *
 * On Windows, trimmed and unquoted: `PATH` there is edited by hand in a dialog,
 * and `"C:\Program Files\x"` is how Windows itself tolerates a space. On POSIX,
 * exactly as written. An entry there is a directory name, byte for byte, and
 * ` /usr/bin` with a leading space is a *relative* directory — one in the
 * working directory. Trimming it made the resolver search `/usr/bin` while
 * `execvp` searched the checkout.
 */
function asSearchDirectory(entry: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? entry.trim().replace(/^"(.*)"$/, '$1') : entry
}

/**
 * Raw search-list entries to directories, by the rules of `platform`.
 *
 * Parsing follows the platform being described — its separator, what counts as
 * absolute, whether case matters when deciding two entries are the same — but
 * the value is never rewritten beyond that: `path.win32.normalize` turns
 * `/tmp/x` into `\tmp\x`, which is correct for Windows and names nothing on the
 * Linux host the Windows rules are tested from. The file lookup is always the
 * host's.
 */
function searchEntries(entries: readonly string[], platform: NodeJS.Platform): string[] {
  const p = pathFor(platform)
  const seen = new Set<string>()
  const directories: string[] = []
  for (const entry of entries) {
    let directory = asSearchDirectory(entry, platform)
    if (directory === '' || !p.isAbsolute(directory)) continue
    const root = p.parse(directory).root
    while (directory.length > root.length && /[\\/]$/.test(directory)) directory = directory.slice(0, -1)
    // Windows treats `/` and `\` alike, so `C:/Tools` and `C:\Tools` are one
    // directory there and should be searched once.
    const key = platform === 'win32' ? directory.toLowerCase().replace(/\//g, '\\') : directory
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
 * shell whose `PATH` never mentions them. Read from the policy environment: a
 * child that could set `SystemRoot` could point the "system directories" at
 * anything. Empty on every other platform.
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
 * `statSync` that answers `null` for every reason a path cannot be inspected.
 *
 * `throwIfNoEntry: false` suppresses ENOENT and ENOTDIR and nothing else. An
 * unreadable `PATH` entry — EACCES, ELOOP, a dead network mount — threw out of a
 * function whose contract is to return a resolution or a reason.
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

function realpathOrNull(path: string): string | null {
  try {
    return trustedFs.realpathSync(path)
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
 *
 * Read from the policy environment: which extensions make a file a program is
 * part of deciding which file runs, and a child's `PATHEXT` putting `.JS` or
 * `.PS1` ahead of `.EXE` would otherwise choose it.
 */
function candidateExtensions(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return ['']
  if (/\.[^\\/.]+$/.test(name)) return ['']
  // `||`, not `??`: an empty PATHEXT would leave no extensions to try at all.
  return (env.PATHEXT || DEFAULT_PATHEXT).split(';').map((value) => value.trim()).filter(Boolean)
}

/**
 * Whether `path` is a Windows App Execution Alias — `winget.exe`, or the Store's
 * `python.exe` — in `%LOCALAPPDATA%\Microsoft\WindowsApps`.
 *
 * Store and App Installer packages put these reparse points on `PATH`, and
 * `CreateProcess` runs one by its path, but Node cannot follow one: `fs.stat`
 * throws EACCES, and so does `fs.realpath`, which stats on the way
 * (nodejs/node#36790; the libuv fix, libuv#4663, is still open). `lstat` sees the
 * reparse point. So an alias is a path `lstat` reports and `stat` refuses with
 * EACCES in particular; a dangling link fails with ENOENT and is not one.
 *
 * It is taken as the program at its own path rather than followed: the package
 * behind it lives under `C:\Program Files\WindowsApps`, which is locked down,
 * and Windows has no ownership rule here to apply to it anyway. Running that
 * path is what the operating system's own search did before LoopTroop resolved
 * names — until it did, `winget` on a hosted runner was "not installed".
 */
function isWindowsAppAlias(path: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false
  try {
    trustedFs.statSync(path)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EACCES') return false
  }
  const link = lstatOrNull(path)
  return link !== null && !link.isDirectory()
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  if (!statOrNull(path)?.isFile()) return isWindowsAppAlias(path, platform)
  // Windows has no execute bit and PATHEXT has already chosen the extension by
  // the time this runs.
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
 * with — this user by default, root for an elevated mount, anything for a
 * custom `uid=`. The owner there describes a mount option, not a person, so the
 * ownership check is skipped on these mounts and only on these.
 *
 * Positively identified, not guessed from the filesystem type. `drvfs` is
 * unambiguous. WSL2 has also shown the same drives as `9p` and `virtiofs`, but
 * those types are QEMU shares and Docker Desktop volumes too — so for them the
 * mount must also say it is a Windows drive: a source like `C:\`, or the
 * `aname=drvfs` option WSL gives its 9p drive mounts. A `virtiofs` root that is
 * not a Windows drive is not exempt.
 *
 * Decided from the mount table rather than by matching `/mnt/`, and the longest
 * matching mount point wins, as the kernel would resolve it.
 */
function isWindowsDriveMount(path: string, mountTable: string): boolean {
  const decode = (value: string): string => value.replace(/\\(\d{3})/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 8)))
  let best: { point: string; source: string; type: string; options: string } | null = null
  for (const line of mountTable.split('\n')) {
    const [source, point, type, options] = line.split(' ')
    if (source === undefined || point === undefined || type === undefined) continue
    const decoded = decode(point)
    const covers = decoded === '/' || path === decoded || path.startsWith(`${decoded}/`)
    if (!covers || (best !== null && decoded.length < best.point.length)) continue
    best = { point: decoded, source: decode(source), type, options: options ?? '' }
  }
  if (best === null) return false
  if (best.type === 'drvfs') return true
  if (best.type !== '9p' && best.type !== 'virtiofs') return false
  // WSL writes the 9p option as `aname=drvfs;path=C:\;uid=1000;…` — one
  // comma-separated field with its own semicolons — so it is matched as a prefix.
  return /^[A-Za-z]:/.test(best.source)
    || best.options.split(',').some((option) => option === 'aname=drvfs' || option.startsWith('aname=drvfs;'))
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
 * The uids whose files LoopTroop may run: root, this process, and whoever owns
 * the Node binary running it.
 *
 * The third is what makes `sudo "$(which node)" …` work with a toolchain that
 * belongs to the invoking user — under sudo this process is root, and root
 * refusing the user's `/opt/hostedtoolcache/.../npm` refused the Node it was
 * itself running from. Trusting that owner widens nothing that matters: whoever
 * can replace the interpreter already controls every line this process runs.
 */
function trustedOwners(): Set<number> {
  const owners = new Set<number>([0])
  const uid = process.getuid?.()
  if (uid !== undefined) owners.add(uid)
  const interpreter = realpathOrNull(process.execPath)
  const interpreterOwner = interpreter === null ? undefined : statOrNull(interpreter)?.uid
  if (interpreterOwner !== undefined) owners.add(interpreterOwner)
  return owners
}

/** What the ownership rule needs to know about the call it is judging. */
interface TrustContext {
  platform: NodeJS.Platform
  readMountTable: () => string
  /** The search directory came from the operator's override. */
  namedByOperator: boolean
  /** Computed once per resolution: it costs a `realpath` and a `stat` of the Node binary. */
  owners: Set<number>
}

/**
 * Why `path` or a directory above it fails the ownership rule, or `null`.
 *
 * Every directory up to the root, not only the last one: ownership is the only
 * control now that mode bits are not read, and a directory can be renamed out
 * from under a tool by whoever owns its *parent*. A root-owned `bin/tool` inside
 * somebody else's directory is theirs to replace.
 *
 * Walked twice — along the path as written, and along the real path behind it.
 * The spawned path is the one written, so its own parents decide who can
 * retarget a link in it: a trusted `/usr/bin/git` reached through
 * `/home/other/link -> /usr/bin` passed a walk of the real path alone, and
 * `/home/other` could point the link anywhere between the check and the spawn.
 *
 * Windows answers `null` because NTFS ownership is invisible to `fs.stat`. A
 * directory the operator named is excused, with everything above it — the
 * override is exactly how someone says "this belongs to a service account and
 * that is deliberate".
 */
function ownershipRefusal(path: string, what: string, context: TrustContext): string | null {
  if (context.platform === 'win32' || context.namedByOperator) return null
  const real = realpathOrNull(path)
  if (real === null) return `its ${what} could not be inspected`
  return ancestorRefusal(trustedPath.resolve(path), what, context) ?? ancestorRefusal(real, what, context)
}

function ancestorRefusal(start: string, what: string, context: TrustContext): string | null {
  let current = start
  for (;;) {
    const stats = statOrNull(current)
    if (stats === null) return `its ${what} could not be inspected`
    if (!context.owners.has(stats.uid) && !isWindowsDriveMount(current, context.readMountTable())) {
      const whose = current === start ? `its ${what}` : `${current}, above its ${what},`
      return `${whose} is owned by uid ${stats.uid}, which is neither root, you, nor the owner of the Node running LoopTroop`
    }
    const parent = trustedPath.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Why `candidate` — and `target`, the real file behind it — may not be run, or
 * `null` when it may.
 *
 * Judged on both sides of the link: the search directory, which is what `PATH`
 * offered, the path that will be spawned, and the real file with its own
 * directory. Checking only the first was a gap — a link in a trusted directory
 * could point into a tree someone else owns. Homebrew and Nix still pass,
 * because their stores belong to the user who installed them or to root.
 */
function candidateRefusal(directory: string, candidate: string, target: string, context: TrustContext): string | null {
  if (!statOrNull(directory)?.isDirectory()) return 'its directory is not a directory'
  return ownershipRefusal(directory, 'directory', context)
    ?? ownershipRefusal(trustedPath.dirname(target), 'target directory', context)
    ?? ownershipRefusal(candidate, 'file', context)
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
 * Everything that can move under a long-lived daemon is checked, because each
 * of these was a way the first versions of this cache kept serving a stale
 * answer:
 *
 * - **Something earlier now answers first.** A newer `git` installed into
 *   `~/.local/bin`, ahead of `/usr/bin`, or a `tool.EXE` appearing beside a
 *   cached `tool.CMD`. Every earlier directory and extension is checked for a
 *   candidate before the hit is served.
 * - **The link.** Retargeted from `store/1.0` to `store/2.0` with the old
 *   version kept on disk. Compared with `lstat` and resolved again.
 * - **The file.** Replaced in place, or no longer executable.
 * - **The trust.** A directory that changed owner. The rule is re-run.
 */
function cachedResolutionHolds(
  entry: CachedResolution,
  name: string,
  directories: readonly string[],
  extensions: readonly string[],
  platform: NodeJS.Platform,
  context: TrustContext,
): boolean {
  const position = directories.indexOf(entry.directory)
  if (position === -1) return false
  for (const directory of directories.slice(0, position + 1)) {
    for (const extension of extensions) {
      // Everything before the cached candidate, in search order, and nothing
      // after it.
      if (directory === entry.directory && extension === entry.extension) return entryStillHolds(entry, platform, context)
      if (isExecutableFile(trustedPath.join(directory, `${name}${extension}`), platform)) return false
    }
  }
  return false
}

function entryStillHolds(entry: CachedResolution, platform: NodeJS.Platform, context: TrustContext): boolean {
  if (!identityMatches(lstatOrNull(entry.candidate), entry.candidateIdentity)) return false
  if (!isExecutableFile(entry.candidate, platform)) return false
  const alias = isWindowsAppAlias(entry.candidate, platform)
  if ((alias ? entry.candidate : realpathOrNull(entry.candidate)) !== entry.path) return false
  const stats = alias ? lstatOrNull(entry.path) : statOrNull(entry.path)
  if (stats === null || !(alias || stats.isFile()) || !identityMatches(stats, entry)) return false
  return candidateRefusal(entry.directory, entry.candidate, entry.path, context) === null
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
  const policyEnv = options.policyEnv ?? process.env
  const platform = options.platform ?? process.platform
  const p = pathFor(platform)
  const readMountTable = options.readMountTable ?? readMountTableFromProc
  const owners = trustedOwners()

  if (name === '') return { reason: 'An empty program name cannot be resolved.' }
  if (/[\\/]/.test(name) || p.isAbsolute(name)) {
    return { reason: `'${name}' is a path, not a program name; resolve it against its intended root instead.` }
  }

  const override = policyEnv[TRUSTED_EXECUTABLE_DIRS_ENV] ?? ''
  const directories = trustedSearchDirectories({ env, policyEnv, platform })
  const namedByOperator = new Set(searchEntries(override.split(p.delimiter), platform))
  const extensions = candidateExtensions(name, platform, policyEnv)
  const cache = options.cache === undefined ? processCache : options.cache
  // The override is in the key as well as in the directory list, because a
  // directory can be on both and only the override excuses the ownership rule.
  const cacheKey = [platform, name, extensions.join(';'), override, directories.join(p.delimiter)].join('\u0000')

  const cached = cache?.get(cacheKey)
  if (cached) {
    const context = { platform, readMountTable, namedByOperator: namedByOperator.has(cached.directory), owners }
    if (cachedResolutionHolds(cached, name, directories, extensions, platform, context)) {
      return { path: cached.candidate, target: cached.path }
    }
    cache?.delete(cacheKey)
  }

  for (const directory of directories) {
    const context = { platform, readMountTable, namedByOperator: namedByOperator.has(directory), owners }
    for (const extension of extensions) {
      // The host's `join`: whatever the platform being described, the file is
      // looked up on the filesystem this process is running on.
      const candidate = trustedPath.join(directory, `${name}${extension}`)
      if (!isExecutableFile(candidate, platform)) continue
      // An App Execution Alias is the program at its own path; see isWindowsAppAlias.
      const alias = isWindowsAppAlias(candidate, platform)
      const target = alias ? candidate : realpathOrNull(candidate)
      const refusal = target === null
        ? 'it could not be resolved to a real file'
        : candidateRefusal(directory, candidate, target, context)
      if (target === null || refusal !== null) {
        return {
          reason: `${name} resolves to ${candidate}, which this daemon will not run: ${refusal}.`
            + ` Set ${TRUSTED_EXECUTABLE_DIRS_ENV} to the directory holding it if that location is deliberate.`,
          refusedAt: candidate,
        }
      }
      const stats = alias ? lstatOrNull(target) : statOrNull(target)
      const candidateStats = lstatOrNull(candidate)
      if (stats === null || !(alias || stats.isFile()) || candidateStats === null) continue
      if (cache) remember(cache, cacheKey, {
        path: target,
        dev: stats.dev,
        ino: stats.ino,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        candidate,
        candidateIdentity: { dev: candidateStats.dev, ino: candidateStats.ino, mtimeMs: candidateStats.mtimeMs },
        directory,
        extension,
      })
      return { path: candidate, target }
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
 * A `null` means the tool is unavailable — the same condition as it not being
 * installed, reported through whatever the caller already does about that.
 */
export function findTrustedExecutablePath(name: string, options: TrustedExecutableOptions = {}): string | null {
  return resolveTrustedExecutable(name, options).path ?? null
}

/**
 * As `resolveTrustedExecutable`, but accepting a program a caller named by
 * absolute path.
 *
 * The trust question is mostly about `PATH` choosing the file. An absolute path
 * is the caller choosing it — `process.execPath`, a plan that names a tool
 * outright — so there is no search to hijack, but the ownership rule still
 * applies to the file and where it really lives, and so does the override.
 * The path is returned as named, for the same reason a `PATH` entry is: a tool
 * may work out where it lives from how it was started.
 *
 * A *relative* path is refused rather than resolved. Which directory it is
 * relative to is the caller's decision and differs per call site: the daemon's
 * working directory is a checkout, and quietly picking that would be the
 * current-directory hole in a different shape.
 */
export function resolveTrustedProgram(
  program: string,
  options: TrustedExecutableOptions = {},
): TrustedExecutableResolution {
  const platform = options.platform ?? process.platform
  const p = pathFor(platform)
  if (!p.isAbsolute(program)) return resolveTrustedExecutable(program, options)
  if (!isExecutableFile(program, platform)) return { reason: `${program} is not an executable file.` }
  const target = isWindowsAppAlias(program, platform) ? program : realpathOrNull(program)
  if (target === null) return { reason: `${program} could not be resolved to a real path.` }
  const policyEnv = options.policyEnv ?? process.env
  const named = new Set(searchEntries((policyEnv[TRUSTED_EXECUTABLE_DIRS_ENV] ?? '').split(p.delimiter), platform))
  const directory = trustedPath.dirname(program)
  const context = {
    platform,
    readMountTable: options.readMountTable ?? readMountTableFromProc,
    namedByOperator: named.has(directory),
    owners: trustedOwners(),
  }
  // The path as named is judged as well as the real one: it is what gets
  // spawned, so a link on the way to it is followed again at spawn time.
  const refusal = candidateRefusal(directory, program, target, context)
  if (refusal !== null) {
    return {
      reason: `${program} will not be run: ${refusal}. Set ${TRUSTED_EXECUTABLE_DIRS_ENV} to its directory if that location is deliberate.`,
      refusedAt: program,
    }
  }
  return { path: program, target }
}

/** The path to `name`, or an error saying why there is not one. */
export function requireTrustedExecutablePath(name: string, options: TrustedExecutableOptions = {}): string {
  const resolution = resolveTrustedExecutable(name, options)
  if (resolution.path === undefined) throw new Error(resolution.reason)
  return resolution.path
}

/**
 * How to start a resolved program: the file to spawn, its arguments, and whether
 * Node must pass those arguments through untouched.
 */
export interface ProgramLaunch {
  file: string
  args: string[]
  windowsVerbatimArguments: boolean
}

/** A launch, or the reason a program cannot be started faithfully. Never both. */
export type ProgramLaunchPlan =
  | (ProgramLaunch & { reason?: undefined; refusedAt?: undefined })
  | { file?: undefined; args?: undefined; windowsVerbatimArguments?: undefined; reason: string; refusedAt?: string }

/**
 * Whether `program` can only be started through cmd.exe.
 *
 * Windows starts `.exe` and `.com` images itself. A `.cmd` or `.bat` is a script
 * for cmd.exe, and Node has refused to spawn one directly since the BatBadBut
 * fix (CVE-2024-27980) — which is how a correctly resolved `npm.cmd` failed to
 * start with EINVAL. Only those two go through cmd.exe. cross-spawn sends every
 * non-image there, but cmd.exe given a name without an extension looks for it
 * with each `PATHEXT` extension added, and would run a sibling `tool.cmd`
 * rather than the `tool` that was resolved.
 */
export function needsCommandInterpreter(program: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(?:bat|cmd)$/i.test(program)
}

/**
 * cmd.exe, found the way any other program is.
 *
 * `ComSpec` names it when Windows set it — read from the policy environment, so
 * a child's cannot choose it — and is held to the rules for a program named by
 * path. Otherwise `cmd.exe` is found through the system directories, which are
 * searched first. There is no bare-name fallback: `shell: true` would have Node
 * look `cmd.exe` up itself, and that is the lookup this module exists to remove.
 */
export function resolveCommandInterpreter(options: TrustedExecutableOptions = {}): TrustedExecutableResolution {
  const policyEnv = options.policyEnv ?? process.env
  const named = policyEnv.ComSpec?.trim() || policyEnv.COMSPEC?.trim()
  return named ? resolveTrustedProgram(named, options) : resolveTrustedExecutable('cmd.exe', options)
}

/** cmd.exe's metacharacters, the set qntm.org/cmd and cross-spawn escape. */
const CMD_METACHARACTERS = /[()\][%!^"`<>&|;, *?]/g

/**
 * An argument that reaches the program unchanged with no quoting at all: not
 * empty, and holding nothing either parser acts on — no whitespace, no quote, no
 * cmd.exe metacharacter, and none of the `=`, `,` or `;` a batch file's own `%1`
 * splits on.
 *
 * Left bare, where cross-spawn quotes every argument: a quoted `--version`
 * arrives in a batch file as `"--version"`, quotes included, and a script
 * comparing `if "%1"=="--version"` stops matching.
 */
const PLAIN_ARGUMENT = /^[^\s"()[\]%!^`<>&|;,*?=\u00ff]+$/

function escapeForCmd(value: string): string {
  return value.replace(CMD_METACHARACTERS, '^$&')
}

/**
 * `value` wrapped for `CommandLineToArgvW`, which the program splits its command
 * line with: in quotes, with backslashes literal except in a run that ends at a
 * quote, and such a run doubled.
 *
 * The backslashes are counted in a loop. cross-spawn 7.0.6 does this step with a
 * regular expression rewritten to avoid backtracking, which keeps only one
 * backslash of a run: `x\\` arrived as `x\"`.
 */
function quoteForArgv(value: string): string {
  let quoted = ''
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    quoted += '\\'.repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character
    backslashes = 0
  }
  return `"${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/**
 * One argument, written so the program started through cmd.exe receives it
 * unchanged.
 *
 * Two parsers read it, and each gets its own layer (qntm.org/cmd): the quoting
 * `CommandLineToArgvW` needs, then a `^` before every cmd.exe metacharacter,
 * the quotes included, so cmd.exe never enters a quoted section and never reads
 * `&` or `|` as anything but text. `%` is escaped too, which covers every case
 * but two — `planProgramLaunch` refuses those.
 *
 * A `node_modules\.bin` shim reads its line through cmd.exe a second time — the
 * `%*` in npm's shims — so its arguments are escaped twice, as cross-spawn does.
 */
function quoteArgumentForCmd(value: string, escapeTwice: boolean): string {
  if (PLAIN_ARGUMENT.test(value)) return value
  const escaped = escapeForCmd(quoteForArgv(value))
  return escapeTwice ? escapeForCmd(escaped) : escaped
}

/** Whether `script` reads its own command line again, and gets its arguments escaped twice. */
function readsItsLineAgain(script: string): boolean {
  return /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(script)
}

/** What goes inside `cmd.exe /c "…"`: the script's path, then its arguments. */
function commandLineForCmd(program: string, args: readonly string[]): string {
  const script = trustedPath.win32.normalize(program)
  const escapeTwice = readsItsLineAgain(script)
  return [escapeForCmd(script), ...args.map((arg) => quoteArgumentForCmd(arg, escapeTwice))].join(' ')
}

/**
 * The spawn that runs the command script `program` through `interpreter`.
 *
 * `/d` skips the AutoRun commands the registry can attach to every cmd.exe, and
 * `/v:off` the delayed expansion it can switch on for all of them, which would
 * expand `!NAME!` after the carets are gone. `/s /c` with the whole line in one
 * pair of quotes has cmd.exe strip exactly that pair and run what is inside, and
 * `windowsVerbatimArguments` stops Node quoting the line a second time. The
 * script's own path gets the metacharacter escape only: cmd.exe reads it as the
 * command, not as an argument, and the space in `C:\Program Files` would
 * otherwise end it.
 *
 * Builds the line and nothing more. `planProgramLaunch` is what refuses an
 * argument this cannot carry.
 */
export function launchThroughInterpreter(interpreter: string, program: string, args: readonly string[]): ProgramLaunch {
  return {
    file: interpreter,
    args: ['/d', '/v:off', '/s', '/c', `"${commandLineForCmd(program, args)}"`],
    windowsVerbatimArguments: true,
  }
}

/**
 * A `%…%` reference cmd.exe would still expand in `line`, or `null`.
 *
 * The caret before every `%` works by moving the name cmd.exe looks up:
 * `%PATH%` becomes a lookup of `PATH^`, which is not defined, and on a command
 * line cmd.exe leaves an undefined reference alone. Two things defeat that, and
 * there is no escape for either:
 *
 * - The name is defined after all. Windows allows `^` in a variable's name, and
 *   a plan chooses its command's environment.
 * - The edit forms, `%PATH:a=b%` and `%PATH:~0,4%`, look the name up before the
 *   colon, where no caret lands — and `CD`, `DATE` and the other dynamic names
 *   exist without being in any environment.
 *
 * Every pair of neighbouring `%` is checked, because which pairs cmd.exe forms
 * depends on which names it found.
 */
function expandableReference(line: string, env: NodeJS.ProcessEnv): string | null {
  const defined = new Set(Object.keys(env).map((name) => name.toLowerCase()))
  let opening = line.indexOf('%')
  while (opening !== -1) {
    const closing = line.indexOf('%', opening + 1)
    if (closing === -1) return null
    const content = line.slice(opening + 1, closing)
    const colon = content.indexOf(':')
    const name = colon === -1 ? content : content.slice(0, colon)
    if ((colon !== -1 && !name.endsWith('^')) || defined.has(name.toLowerCase())) return `%${content.replace(/\^/g, '')}%`
    opening = closing
  }
  return null
}

/**
 * Whether cmd.exe, reading `quoted` a second time, would find a metacharacter
 * outside quotes.
 *
 * A command script that passes its arguments on with `%*` — npm's global shims
 * and `npm.cmd` itself do — has cmd.exe read them again. The first read removed
 * the carets, and the second tracks quotes without knowing that `\"` is an
 * escaped one, so the text after an embedded quote is outside quotes to it and
 * a `&` there runs a second command. A `node_modules\.bin` shim is escaped twice
 * instead, as cross-spawn does; anything else cannot be told apart, so such an
 * argument is refused. One with a quote and nothing else to act on is left
 * alone.
 */
function exposedOnSecondRead(value: string): boolean {
  let inQuotes = false
  for (const character of quoteForArgv(value)) {
    if (character === '"') inQuotes = !inQuotes
    else if (!inQuotes && '&|<>^()'.includes(character)) return true
  }
  return false
}

/** Why cmd.exe cannot be trusted to pass `args` to `program` unchanged, or `null`. */
function commandLineRefusal(program: string, args: readonly string[], env: NodeJS.ProcessEnv): string | null {
  // A line break ends a cmd.exe command line and would drop every argument
  // after it without a word.
  if (args.some((arg) => /[\r\n]/.test(arg))) return 'cannot pass it an argument that contains a line break'
  if (!readsItsLineAgain(trustedPath.win32.normalize(program))) {
    const exposed = args.find(exposedOnSecondRead)
    if (exposed !== undefined) {
      return `would read ${JSON.stringify(exposed)} a second time with part of it outside quotes, where \`&\`, \`|\`, \`<\`, \`>\`, \`^\` and parentheses act`
    }
  }
  const expanded = expandableReference(commandLineForCmd(program, args), env)
  return expanded === null ? null : `would expand ${expanded} in its arguments, and no escaping prevents that`
}

export interface ProgramLaunchOptions extends TrustedExecutableOptions {
  /** Test seam, and the daemon's own resolver seam: how to find cmd.exe. */
  resolveInterpreter?: () => TrustedExecutableResolution
}

/**
 * How to start `program`, already resolved, with `args`: directly, or for a
 * Windows command script through a resolved cmd.exe. Every launcher in the
 * daemon, the scripts and the installer goes through here, so cmd.exe is quoted
 * one way.
 *
 * A reason instead of a launch when the program cannot be started as asked:
 * cmd.exe cannot be used, or it would not pass an argument through unchanged —
 * a line break, a `%…%` it would expand whatever the escaping, or a quote that
 * leaves a metacharacter exposed to a script that reads its line again. `env`
 * is the environment cmd.exe will run with, which decides what it can expand.
 */
export function planProgramLaunch(program: string, args: readonly string[], options: ProgramLaunchOptions = {}): ProgramLaunchPlan {
  if (!needsCommandInterpreter(program, options.platform ?? process.platform)) {
    return { file: program, args: [...args], windowsVerbatimArguments: false }
  }
  const refusal = commandLineRefusal(program, args, options.env ?? process.env)
  if (refusal !== null) return { reason: `${program} is a command script, and cmd.exe ${refusal}.` }
  const interpreter = options.resolveInterpreter?.() ?? resolveCommandInterpreter(options)
  if (interpreter.path === undefined) {
    return { reason: `${program} is a command script, which needs cmd.exe to run, and cmd.exe could not be used: ${interpreter.reason}` }
  }
  return launchThroughInterpreter(interpreter.path, program, args)
}
