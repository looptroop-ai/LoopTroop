import { writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync, unlinkSync, chmodSync, statSync } from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'crypto'

/** POSIX modes are advisory on Windows, where ACLs already restrict the profile. */
const SUPPORTS_POSIX_MODES = process.platform !== 'win32'

/**
 * What Windows reports when something else still holds a handle to the target.
 *
 * POSIX replaces a file that other processes have open; Windows refuses while
 * the handle exists, and the refusal arrives as one of these three depending on
 * how the holder opened it. All three are transient by nature — a reader
 * finishing, a virus scanner releasing the file it just indexed — which is what
 * makes them worth waiting on and everything else worth failing on.
 */
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Matches the budget `rmSync` is already given against this same class of
 * Windows lock in the test fixtures — 500ms total, in short steps.
 */
const RENAME_ATTEMPTS = 10
const RENAME_RETRY_DELAY_MS = 50

/**
 * The temp-file naming contract, in one place.
 *
 * `${target}.${pid}.${12 hex}.tmp`. The pid and the random half both matter: a
 * fixed `.tmp` collides when two processes write the same target, and one
 * rename then clobbers the other's partial file.
 *
 * Startup recovery has to reverse this to know what an orphan temp was on its
 * way to becoming, so the parser lives beside the builder. A private regex on
 * the recovery side is how the two drifted apart in the first place — it
 * stripped four characters and promoted `ticket.meta.json.4821.a1b2c3` as a
 * finished document.
 */
const ATOMIC_TMP_SUFFIX = '.tmp'
const ATOMIC_TMP_RANDOM_BYTES = 6
/** Case-insensitive on the suffix and the random half, for Windows. */
const ATOMIC_TMP_PATTERN = new RegExp(`^(.+)\\.(\\d+)\\.([0-9a-f]{${ATOMIC_TMP_RANDOM_BYTES * 2}})\\.tmp$`, 'i')

/** The temp path `safeAtomicWrite` will write for `target`. */
export function makeAtomicTmpPath(target: string): string {
  return `${target}.${process.pid}.${randomBytes(ATOMIC_TMP_RANDOM_BYTES).toString('hex')}${ATOMIC_TMP_SUFFIX}`
}

/**
 * The target a temp path was written for, or `null` when the name was not
 * produced by `makeAtomicTmpPath` — including the pre-upgrade `${target}.tmp`,
 * whose target is genuinely underivable from the name alone.
 */
export function parseAtomicTmpPath(tmpPath: string): string | null {
  const match = ATOMIC_TMP_PATTERN.exec(tmpPath)
  return match?.[1] ?? null
}

/**
 * The platform-dependent parts, injectable so the Windows behaviour can be
 * tested somewhere other than Windows.
 */
export interface AtomicWriteDeps {
  platform: NodeJS.Platform
  rename: (from: string, to: string) => void
  wait: (ms: number) => void
}

const defaultDeps: AtomicWriteDeps = {
  platform: process.platform,
  rename: renameSync,
  // `Atomics.wait` blocks without a busy loop. Deliberately not a spin: this is
  // a synchronous API, so there is no event loop to yield to, and spinning
  // would steal the core from whatever process is holding the handle we are
  // waiting on.
  wait: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
}

/**
 * Replaces the target, waiting out a Windows handle that has not been let go.
 *
 * The rename is the atomic step, and on Windows it is also the step that fails
 * for reasons having nothing to do with this process: a `daemon.json` rename
 * failed a published-install smoke with EPERM because something still had the
 * previous file open. The retries wait for that to end.
 *
 * Deliberately *not* how this is usually worked around. The destination is
 * never unlinked first — that trades an atomic replace for a window where the
 * file does not exist, which is the property this module exists to provide. The
 * temporary file is not rewritten between attempts either: it is already
 * written, mode-matched and fsynced, and only the last step is being repeated.
 *
 * POSIX gets the bare rename with no retry loop at all, because it has no such
 * failure: replacing a file other processes have open is defined behaviour.
 */
function renameWithRetry(tmpPath: string, filePath: string, deps: AtomicWriteDeps): void {
  if (deps.platform !== 'win32') {
    deps.rename(tmpPath, filePath)
    return
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      deps.rename(tmpPath, filePath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Anything else is a real failure — a missing directory, a full disk, a
      // read-only volume — and waiting 500ms to report it helps nobody. The
      // original error is rethrown rather than one describing the retries,
      // because it is the one that says what actually went wrong.
      if (attempt >= RENAME_ATTEMPTS || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) {
        throw error
      }
      deps.wait(RENAME_RETRY_DELAY_MS)
    }
  }
}

function currentMode(filePath: string): number | null {
  if (!SUPPORTS_POSIX_MODES) return null
  try {
    return statSync(filePath).mode & 0o777
  } catch {
    return null
  }
}

export interface SafeAtomicWriteOptions {
  /**
   * POSIX mode for the finished file, applied to the temp file *before* the
   * rename. A post-rename `chmod` would leave a window in which a 0600 file
   * exists at the default umask, which for a file worth restricting is the
   * whole exposure. Ignored on Windows, where modes are advisory.
   *
   * Without this, `safeAtomicWrite` only carries a mode a file already has, so
   * a caller replacing `writeFileSync(..., { mode })` would silently widen
   * every newly created file to the umask.
   */
  mode?: number
  /** Test seam for the Windows rename behaviour. */
  deps?: AtomicWriteDeps
}

export function safeAtomicWrite(
  filePath: string,
  content: string,
  options: SafeAtomicWriteOptions = {},
): void {
  const deps = options.deps ?? defaultDeps
  const tmpPath = makeAtomicTmpPath(filePath)
  const dir = dirname(filePath)

  // Captured before the write so replacing a 0600 file cannot silently widen it
  // to the default 0644 that the fresh temp file would carry through rename.
  const existingMode = currentMode(filePath)

  mkdirSync(dir, { recursive: true })

  let tmpCreated = false
  try {
    writeFileSync(tmpPath, content, 'utf-8')
    tmpCreated = true

    // A requested mode is a requirement, not a preference: swallowing the
    // failure is how a checkpoint that must be 0600 lands world-readable and
    // nothing says so. The `finally` below removes the temp, so the target
    // keeps whatever it had.
    if (SUPPORTS_POSIX_MODES && options.mode !== undefined) {
      chmodSync(tmpPath, options.mode)
    } else if (existingMode !== null) {
      try { chmodSync(tmpPath, existingMode) } catch { /* best-effort */ }
    }

    // 'r+' not 'r': Windows FlushFileBuffers needs a writable handle and fails
    // with EPERM otherwise.
    const fd = openSync(tmpPath, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }

    renameWithRetry(tmpPath, filePath, deps)
    tmpCreated = false

    // Best-effort parent-directory fsync for crash durability on Linux/macOS.
    // Not all platforms support opening directories; failures are silently ignored.
    try {
      const dirFd = openSync(dir, 'r')
      try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
    } catch {
      // Ignored — not critical and not supported on all filesystems
    }
  } finally {
    if (tmpCreated) {
      try { unlinkSync(tmpPath) } catch { /* best-effort cleanup */ }
    }
  }
}
