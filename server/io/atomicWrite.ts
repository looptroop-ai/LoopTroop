import { createHash } from 'node:crypto'
import { writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync, unlinkSync, fchmodSync, lstatSync, constants, realpathSync, writeSync } from 'fs'
import { dirname, isAbsolute, win32 } from 'path'
import { randomBytes } from 'crypto'
import { ContainedPathError, resolveContainedPath } from '../lib/containedPath'

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
/** Twelve hex characters in the pattern below; the round trip is asserted in the tests. */
const ATOMIC_TMP_RANDOM_BYTES = 6
/** Case-insensitive on the suffix and the random half, for Windows. */
const ATOMIC_TMP_PATTERN = /^(.+)\.(\d+)\.([0-9a-f]{12})\.tmp$/i
const YAML_PROOF_SUFFIX = '.proof'

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

/** The sidecar is only evidence for recovery; it is never part of the file's content. */
export function atomicProofPath(tmpPath: string): string {
  return `${tmpPath}${YAML_PROOF_SUFFIX}`
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
 * Runs a file operation again while Windows says something else holds the file.
 *
 * On Windows the last step of an atomic write fails for reasons having nothing
 * to do with this process: a `daemon.json` rename failed a published-install
 * smoke with EPERM because something still had the previous file open. The
 * retries wait for that to end. Startup recovery promoting a temp file hits the
 * same class of failure, which is why this is shared rather than inlined.
 *
 * Deliberately *not* how this is usually worked around. The destination is
 * never unlinked first — that trades an atomic replace for a window where the
 * file does not exist, which is the property this module exists to provide. The
 * temporary file is not rewritten between attempts either: it is already
 * written, mode-matched and fsynced, and only the last step is being repeated.
 *
 * POSIX runs the operation once, with no retry loop at all, because it has no
 * such failure: replacing a file other processes have open is defined behaviour.
 */
export function retryWhileWindowsHoldsTheFile<T>(
  operation: () => T,
  deps: AtomicWriteDeps = defaultDeps,
): T {
  if (deps.platform !== 'win32') return operation()

  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation()
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
    const stat = lstatSync(filePath)
    return stat.isSymbolicLink() ? null : stat.mode & 0o777
  } catch {
    return null
  }
}

export interface SafeAtomicWriteOptions {
  /**
   * POSIX mode for the finished file. Passed to `open` when the temp file is
   * created, so the content never exists at the umask for even an instant, and
   * re-applied with `chmod` afterwards because the umask can only *remove* bits
   * at creation. Ignored on Windows, where modes are advisory.
   *
   * Without this, `safeAtomicWrite` only carries a mode a file already has, so
   * a caller replacing `writeFileSync(..., { mode })` would silently widen
   * every newly created file to the umask.
   */
  mode?: number
  /** Test seam for the Windows rename behaviour. */
  deps?: AtomicWriteDeps
}

/** Best-effort directory durability after a rename or promotion. */
export function fsyncDirectory(directory: string): void {
  try {
    const fd = openSync(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { fsyncSync(fd) } finally { closeSync(fd) }
  } catch {
    // Directory descriptors are not supported by every platform/filesystem.
  }
}

function writeAtomicProof(
  proofPath: string,
  content: string,
  assertContained?: (candidate: string, allowMissingParents?: boolean) => void,
): void {
  const proof = JSON.stringify({
    byteLength: Buffer.byteLength(content, 'utf8'),
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  })
  assertContained?.(proofPath, true)
  const fd = openSync(
    proofPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    const bytes = Buffer.from(proof, 'utf8')
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written === 0) throw new Error('Atomic proof write made no progress')
      offset += written
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  assertContained?.(proofPath)
}

export function safeAtomicWrite(
  filePath: string,
  content: string,
  options: SafeAtomicWriteOptions = {},
): void {
  atomicWrite(filePath, content, options)
}

/**
 * Writes below an independently trusted root, resolving contained symlinks once
 * and rejecting subsequent changes to the canonical destination.
 * Node exposes no directory-relative openat/renameat API: repeated checks and
 * an exclusive, no-follow temp descriptor narrow but cannot eliminate an
 * ancestor swap between a check and the following filesystem operation.
 */
export function safeAtomicWriteWithin(
  root: string,
  relativePath: string,
  content: string,
  options: SafeAtomicWriteOptions = {},
): void {
  if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw new ContainedPathError('Atomic write requires a relative path')
  }
  const canonicalRoot = realpathSync.native(root)
  const filePath = resolveContainedPath(canonicalRoot, relativePath, {
    allowMissing: true,
    allowMissingParents: true,
    rejectFinalSymlink: true,
  })
  atomicWrite(filePath, content, options, (candidate, allowMissingParents = false) => {
    if (realpathSync.native(canonicalRoot) !== canonicalRoot) {
      throw new ContainedPathError('Atomic write root changed')
    }
    if (resolveContainedPath(canonicalRoot, candidate, { allowMissing: true, allowMissingParents, rejectFinalSymlink: true }) !== candidate) {
      throw new ContainedPathError('Atomic write destination changed')
    }
  })
}

function atomicWrite(
  filePath: string,
  content: string,
  options: SafeAtomicWriteOptions,
  assertContained?: (candidate: string, allowMissingParents?: boolean) => void,
): void {
  const deps = options.deps ?? defaultDeps
  const tmpPath = makeAtomicTmpPath(filePath)
  const dir = dirname(filePath)
  const proofPath = atomicProofPath(tmpPath)
  // Whole-file JSONL writes have the same recovery hazard as YAML: a valid
  // prefix (including an empty file) is not evidence that the generation
  // finished. Keep a hash sidecar until the rename makes the bytes visible.
  const needsProof = /\.(?:ya?ml|jsonl)$/i.test(filePath)

  // Captured before the write so replacing a 0600 file cannot silently widen it
  // to the default 0644 that the fresh temp file would carry through rename.
  const existingMode = currentMode(filePath)

  assertContained?.(filePath, true)
  mkdirSync(dir, { recursive: true })
  assertContained?.(filePath)

  const requestedMode = SUPPORTS_POSIX_MODES ? options.mode : undefined

  let tmpCreated = false
  let proofCreated = false
  try {
    // The mode goes to `open`, so the content is never on disk at the umask —
    // not even under the temp name, which is where a `chmod` afterwards would
    // leave it exposed.
    assertContained?.(tmpPath)
    const fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), requestedMode ?? existingMode ?? 0o666)
    tmpCreated = true
    try {
      writeFileSync(fd, content, 'utf-8')
      // Apply modes on the opened descriptor, never through a replaceable path.
      if (requestedMode !== undefined) {
        fchmodSync(fd, requestedMode)
      } else if (existingMode !== null) {
        try { fchmodSync(fd, existingMode) } catch { /* best-effort */ }
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }

    if (needsProof) {
      try {
        writeAtomicProof(proofPath, content, assertContained)
        proofCreated = true
      } catch (error) {
        try {
          assertContained?.(proofPath)
          unlinkSync(proofPath)
        } catch { /* best-effort cleanup; never follow an escaped parent */ }
        throw error
      }
    }

    retryWhileWindowsHoldsTheFile(() => {
      assertContained?.(tmpPath)
      assertContained?.(filePath)
      deps.rename(tmpPath, filePath)
    }, deps)
    tmpCreated = false

    if (proofCreated) {
      try {
        assertContained?.(proofPath)
        unlinkSync(proofPath)
      } catch { /* recovery cleans a proof left after a completed rename */ }
      proofCreated = false
    }

    // Best-effort parent-directory fsync for crash durability on Linux/macOS.
    assertContained?.(filePath)
    fsyncDirectory(dir)
  } finally {
    if (tmpCreated) {
      try {
        assertContained?.(tmpPath)
        unlinkSync(tmpPath)
      } catch { /* best-effort cleanup; never follow an escaped parent */ }
    }
    if (proofCreated) {
      try {
        assertContained?.(proofPath)
        unlinkSync(proofPath)
      } catch { /* best-effort cleanup; never follow an escaped parent */ }
    }
  }
}
