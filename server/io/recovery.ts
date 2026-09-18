import {
  readdirSync,
  readFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  readSync,
  writeSync,
  fsyncSync,
  fchmodSync,
  openSync,
  linkSync,
  renameSync,
  readlinkSync,
  symlinkSync,
  ftruncateSync,
  closeSync,
  unlinkSync,
  realpathSync,
  constants as fsConstants,
} from 'fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, extname, isAbsolute, join, relative, sep } from 'path'
import * as jsYaml from 'js-yaml'
import { atomicProofPath, fsyncDirectory, parseAtomicTmpPath, retryWhileWindowsHoldsTheFile } from './atomicWrite'
import { openFileNoFollowSync, readFileNoFollowSync } from './readFile'

/** Files below this threshold are loaded entirely into memory (safe for Node's string limit). */
const MAX_DIRECT_READ_BYTES = 256 * 1024 * 1024 // 256 MB
/** Chunk size used when scanning large files backwards. */
const SCAN_CHUNK_SIZE = 8 * 1024 // 8 KB
/** Maximum bytes to scan backwards when looking for the start of the last line. */
const MAX_LAST_LINE_SCAN = 4 * 1024 * 1024 // 4 MB
const LINK_UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  'EPERM', 'EACCES', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP', 'ENOTSUP', 'EMLINK',
])
const RECOVERY_MARKER_SUFFIX = '.recovery'

const KNOWN_CONFIG_ROOT_ARTIFACTS = new Set([
  'config.json',
  'daemon.json',
  'tool-versions.json',
  'update-check.json',
])

const KNOWN_TICKET_ROOT_ARTIFACTS = new Set([
  '.gitignore',
  'interview.yaml',
  'prd.yaml',
  'relevant-files.yaml',
  'runtime/cancellation-pending.json',
  'runtime/opencode-pending-sessions.json',
])

interface AtomicProof {
  byteLength: number
  sha256: string
}

interface RecoveryMarker {
  version: 1
  targetPath: string
  source: FileIdentity
  target?: FileIdentity
  /** True only after the fallback target contains the complete source bytes. */
  complete?: boolean
}

export interface RecoveryDeps {
  rename: (from: string, to: string) => void
  link: (from: string, to: string) => void
}

/**
 * A durable recovery marker exists, but the bytes it describes cannot be
 * proved to be one complete generation. Startup must stop before readers can
 * hydrate a partial document or silently choose an older orphan.
 */
export class RecoveryBlockedError extends Error {
  readonly code = 'RECOVERY_BLOCKED'

  constructor(
    readonly targetPath: string,
    readonly tmpPath: string,
    readonly reason: string,
  ) {
    super(
      `Recovery is blocked for ${targetPath}: ${reason}. `
        + `Preserved ${tmpPath} and any existing target for manual recovery.`,
    )
    this.name = 'RecoveryBlockedError'
  }
}

function blockRecovery(targetPath: string, tmpPath: string, reason: string): never {
  const error = new RecoveryBlockedError(targetPath, tmpPath, reason)
  console.warn(`[recovery] ${error.message}`)
  throw error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const defaultRecoveryDeps: RecoveryDeps = {
  rename: (from, to) => renameSync(from, to),
  link: (from, to) => linkSync(from, to),
}

/**
 * What to do with a leftover temp file, judged on its content.
 *
 * A temp file exists precisely because a write did not finish, so its content
 * is the one thing that cannot be assumed. Promoting on the strength of the
 * name alone replaces nothing with a document that stops mid-sentence — and it
 * looks complete afterwards, because the name is the only thing anyone sees.
 *
 * `discard` is for content proved wrong; `leave` is for content that cannot be
 * judged at all. The difference matters: deleting a file nobody has read is a
 * worse answer than leaving it where somebody can look at it.
 */
type TmpVerdict =
  | { action: 'promote' }
  | { action: 'discard'; reason: string }
  | { action: 'leave'; reason: string }

const PROMOTE: TmpVerdict = { action: 'promote' }

function judgeTmpContent(fd: number, tmpPath: string, targetPath: string): TmpVerdict {
  const { size } = fstatSync(fd)
  const extension = extname(targetPath).toLowerCase()
  if (size === 0) {
    if (extension === '.jsonl') {
      if (verifyAtomicProof(Buffer.alloc(0), tmpPath)) return PROMOTE
      return { action: 'leave', reason: 'it has no matching complete-write proof' }
    }
    return { action: 'discard', reason: 'it is empty' }
  }

  // Everything below has to read the file to judge it. Past this size that is
  // not something to do at boot, and promoting unread would be the name-alone
  // rule this function exists to replace — so it is left for a person.
  if (size > MAX_DIRECT_READ_BYTES) {
    return { action: 'leave', reason: `it is too large to check (${size} bytes)` }
  }

  if (extension === '.json') {
    try {
      JSON.parse(readFileSync(fd, 'utf8'))
    } catch {
      return { action: 'discard', reason: 'it is not readable JSON' }
    }
    return PROMOTE
  }

  if (extension === '.jsonl') {
    const content = readFileSync(fd)
    if (!verifyAtomicProof(content, tmpPath)) {
      return { action: 'leave', reason: 'it has no matching complete-write proof' }
    }
    if (content.length === 0 || content[content.length - 1] !== 0x0a) {
      return { action: 'leave', reason: 'it has no complete trailing newline' }
    }
    const lines = content.toString('utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        JSON.parse(line)
      } catch {
        return { action: 'leave', reason: 'it contains an incomplete JSONL record' }
      }
    }
    return PROMOTE
  }

  if (extension === '.yaml' || extension === '.yml') {
    const content = readFileSync(fd)
    if (!verifyAtomicProof(content, tmpPath)) {
      return { action: 'leave', reason: 'it has no matching complete-write proof' }
    }
    let document: unknown
    try {
      document = jsYaml.load(content.toString('utf8'))
    } catch {
      return { action: 'discard', reason: 'it is not a readable YAML document' }
    }
    // Proof covers the complete bytes; this only catches an empty YAML
    // document. Never infer missing keys from a partial mapping.
    if (document === undefined || document === null) {
      return { action: 'discard', reason: 'it holds no YAML document' }
    }
    return PROMOTE
  }

  return PROMOTE
}

/**
 * `${target}.tmp-${pid}-${milliseconds}`, written by the private Manual QA
 * checkpoint writer that now goes through `safeAtomicWrite`. It does not end in
 * `.tmp`, so nothing has ever swept it — a pre-upgrade crash leaves one sitting
 * in `.ticket/` unmentioned. Reported for the same reason as the plain
 * `${target}.tmp` family: neither name says what the file was becoming.
 */
const LEGACY_TMP_NAME = /\.tmp-\d+-\d+$/

type FileIdentity = Pick<ReturnType<typeof fstatSync>, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'birthtimeMs'>

type RecoveryPathGuard = (path: string, allowMissingTail?: boolean) => void

/**
 * Recovery works from names rather than directory descriptors. Revalidate the
 * entire ancestor chain immediately before each open/publish/delete operation
 * and reject symlink substitutions instead of following a redirected tree.
 */
function assertRecoveryPath(canonicalRoot: string, candidate: string, allowMissingTail = false): void {
  if (realpathSync.native(canonicalRoot) !== canonicalRoot) {
    throw new Error('Recovery root changed while scanning')
  }
  const offset = relative(canonicalRoot, candidate)
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new Error('Recovery path escapes its root')
  }
  if (!offset) return
  let current = canonicalRoot
  const parts = offset.split(sep)
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!)
    let entry
    try {
      entry = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissingTail) return
      throw error
    }
    if (entry.isSymbolicLink()) throw new Error(`Recovery path contains a symlink: ${current}`)
    if (index < parts.length - 1 && !entry.isDirectory()) {
      throw new Error(`Recovery path parent is not a directory: ${current}`)
    }
  }
}

function recoveryMarkerPath(tmpPath: string): string {
  return `${tmpPath}${RECOVERY_MARKER_SUFFIX}`
}

function cleanupSidecar(path: string): void {
  try { unlinkSync(path) } catch { /* best effort */ }
}

function readAtomicProof(tmpPath: string): AtomicProof | null {
  try {
    const parsed = JSON.parse(readFileNoFollowSync(atomicProofPath(tmpPath))) as Partial<AtomicProof>
    if (typeof parsed.byteLength !== 'number' || !Number.isSafeInteger(parsed.byteLength) || parsed.byteLength < 0) return null
    if (typeof parsed.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.sha256)) return null
    return { byteLength: parsed.byteLength, sha256: parsed.sha256 }
  } catch {
    return null
  }
}

function verifyAtomicProof(content: Buffer, tmpPath: string): boolean {
  const proof = readAtomicProof(tmpPath)
  if (!proof) return false
  return content.length === proof.byteLength
    && createHash('sha256').update(content).digest('hex') === proof.sha256
}

function writeRecoveryMarkerWithDeps(
  path: string,
  marker: RecoveryMarker,
  replace: boolean,
  deps: RecoveryDeps,
  guard: RecoveryPathGuard,
): void {
  const staging = `${path}.write-${process.pid}-${randomUUID()}`
  const cleanupStaging = () => {
    try {
      guard(staging, true)
      cleanupSidecar(staging)
    } catch { /* preserve an entry whose parent changed */ }
  }
  guard(path, true)
  guard(staging, true)
  const fd = openSync(
    staging,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    const content = Buffer.from(JSON.stringify(marker), 'utf8')
    let offset = 0
    while (offset < content.length) {
      const written = writeSync(fd, content, offset, content.length - offset)
      if (written === 0) throw new Error('Recovery marker write made no progress')
      offset += written
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    guard(staging)
    guard(path, true)
    if (replace) {
      // Replacement is a single atomic rename; a crash leaves either the old
      // complete marker or this complete staged marker, never an O_TRUNC hole.
      deps.rename(staging, path)
    } else {
      try {
        // Hardlink publication gives the initial marker the same no-overwrite
        // property as the target fallback. The staged inode is ours alone.
        deps.link(staging, path)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!LINK_UNSUPPORTED_CODES.has(code ?? '')) throw error
        // A filesystem without hardlinks still gets an exclusive marker. A
        // crash during this first write leaves no target behind, so recovery
        // fails closed instead of overwriting a later marker.
        const exclusive = openSync(
          path,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
          0o600,
        )
        try {
          const content = readFileSync(staging)
          let offset = 0
          while (offset < content.length) {
            const written = writeSync(exclusive, content, offset, content.length - offset)
            if (written === 0) throw new Error('Recovery marker write made no progress')
            offset += written
          }
          fsyncSync(exclusive)
        } finally {
          closeSync(exclusive)
        }
      }
      cleanupStaging()
    }
    fsyncDirectory(dirname(path))
  } finally {
    cleanupStaging()
  }
}

function isMarkerIdentity(value: unknown): value is FileIdentity {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<FileIdentity>
  return [candidate.dev, candidate.ino, candidate.size, candidate.mtimeMs, candidate.birthtimeMs]
    .every((entry) => typeof entry === 'number' && Number.isFinite(entry))
}

function readRecoveryMarker(tmpPath: string): RecoveryMarker | null {
  try {
    const value = JSON.parse(readFileNoFollowSync(recoveryMarkerPath(tmpPath))) as Partial<RecoveryMarker>
    if (value.version !== 1 || typeof value.targetPath !== 'string' || !isMarkerIdentity(value.source)) return null
    if (value.target !== undefined && !isMarkerIdentity(value.target)) return null
    if (value.complete !== undefined && typeof value.complete !== 'boolean') return null
    return value as RecoveryMarker
  } catch {
    return null
  }
}

function hasRecoveryMarker(tmpPath: string): boolean {
  try { lstatSync(recoveryMarkerPath(tmpPath)); return true } catch { return false }
}

function isKnownArtifactTarget(rootDir: string, targetPath: string, rootKind: 'config' | 'ticket'): boolean {
  const path = relative(rootDir, targetPath).split(sep).join('/')
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) return false
  const artifactPath = process.platform === 'win32' ? path.toLowerCase() : path
  if (rootKind === 'config') return KNOWN_CONFIG_ROOT_ARTIFACTS.has(artifactPath)
  if (KNOWN_TICKET_ROOT_ARTIFACTS.has(artifactPath)) return true
  if (/^meta\/(?:ticket\.meta|manual-qa-origin)\.json$/.test(artifactPath)) return true
  if (/^beads\/.+\/\.beads\/issues\.jsonl$/.test(artifactPath)) return true
  if (/^runtime\/(?:owner\.json|state\.yaml|execution-setup-profile\.json|execution-log(?:\.debug|\.ai)?\.jsonl)$/.test(artifactPath)) return true
  if (artifactPath === 'manual-qa/events.jsonl') return true
  if (/^manual-qa\/(?:generation-reservation|workspace-baseline)-v[1-9]\d*\.json$/.test(artifactPath)) return true
  if (/^manual-qa\/workspace-drift-[0-9a-f]{64}\.json$/.test(artifactPath)) return true
  if (/^manual-qa\/v[1-9]\d*\/(?:checklist|results|summary|coverage|skip-receipt|bead-creation-receipt|fix-beads|improvement-ticket-receipt|submission-operation|manual-qa-draft|model-capability)\.(?:yaml|json)$/.test(artifactPath)) return true
  if (/^manual-qa\/v[1-9]\d*\/evidence\/(?:index\.json|operations\/[0-9a-f]{64}\.json)$/.test(artifactPath)) return true
  if (/^manual-qa\/v[1-9]\d*\/improvement-operations\/[0-9a-f]{64}\.json$/.test(artifactPath)) return true
  if (/^ui\/(?:refinement-diffs|artifact-companions)\/[^/]+\.json$/.test(artifactPath)) return true
  if (/^origin\/manual-qa\/source-receipt\.json$/.test(artifactPath)) return true
  return false
}

function sameOptionalTimestamp(left: number | bigint, right: number | bigint): boolean {
  if (typeof left === 'bigint' || typeof right === 'bigint') return left === right
  return !Number.isFinite(left) || !Number.isFinite(right) || left === right
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && sameOptionalTimestamp(left.mtimeMs, right.mtimeMs)
    && sameOptionalTimestamp(left.birthtimeMs, right.birthtimeMs)
}

/** Compare an entry's ownership identity without treating copy progress as replacement. */
function sameEntryIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && sameOptionalTimestamp(left.birthtimeMs, right.birthtimeMs)
}

function reportLegacyTmpFile(tmpPath: string): void {
  // Left in place: the pre-upgrade crash that produced it is exactly the case
  // someone would want to look at, and vaulting it silently is worse than
  // either promoting it or saying so.
  let modified = 'an unknown time'
  try {
    modified = lstatSync(tmpPath).mtime.toISOString()
  } catch { /* reported without it */ }
  console.warn(
    `[recovery] Ignoring ${tmpPath} (last modified ${modified}): its name predates the current ` +
      'atomic-write suffix, so the file it was meant to become cannot be derived',
  )
}

function discardTmpFile(tmpPath: string, reason: string, opened?: FileIdentity, deps = defaultRecoveryDeps): void {
  try {
    if (opened && !removeMatchingEntry(tmpPath, opened, deps)) {
      console.warn(`[recovery] Preserved changed temp file ${tmpPath}: ${reason}`)
      return
    }
    if (!opened) unlinkSync(tmpPath)
    cleanupSidecar(atomicProofPath(tmpPath))
    cleanupSidecar(recoveryMarkerPath(tmpPath))
    console.warn(`[recovery] Discarded temp file ${tmpPath}: ${reason}`)
  } catch (error) {
    console.error(`[recovery] Failed to remove temp file ${tmpPath} (${reason}):`, error)
  }
}

/**
 * True for anything at this path, including a symlink pointing nowhere.
 *
 * `existsSync` follows the link and reports `false` for a broken one, which
 * would make recovery treat an occupied name as free.
 */
function pathIsTaken(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function restoreMovedEntryNoOverwrite(path: string, movedPath: string, deps = defaultRecoveryDeps): boolean {
  try {
    // Hardlinking captures the exact moved inode at the canonical name without
    // replacing a newer entry that won the race while we inspected it.
    deps.link(movedPath, path)
    unlinkSync(movedPath)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      // A newer entry already occupies the original path. Keep both
      // generations: the moved copy is not ours to delete merely because the
      // no-overwrite restoration lost its race.
      return false
    }
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOSYS'
      && code !== 'EOPNOTSUPP' && code !== 'ENOTSUP') throw error

    const moved = lstatSync(movedPath)
    if (moved.isSymbolicLink()) {
      symlinkSync(readlinkSync(movedPath), path)
      unlinkSync(movedPath)
      return true
    }
    if (!moved.isFile()) return false

    const sourceFd = openFileNoFollowSync(movedPath)
    let targetFd: number | undefined
    try {
      targetFd = openSync(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        moved.mode & 0o777,
      )
      copyValidatedSource(sourceFd, moved, targetFd, false)
    } finally {
      if (targetFd !== undefined) closeSync(targetFd)
      closeSync(sourceFd)
    }
    unlinkSync(movedPath)
    return true
  }
}

function removeMatchingEntry(path: string, opened: FileIdentity, deps = defaultRecoveryDeps): boolean {
  const entry = lstatSync(path)
  if (!sameFileIdentity(entry, opened)) return false
  const movedPath = `${path}.remove-${randomUUID()}`
  try {
    deps.rename(path, movedPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    const moved = lstatSync(movedPath)
    if (sameFileIdentity(moved, opened)) {
      unlinkSync(movedPath)
      return true
    }
    restoreMovedEntryNoOverwrite(path, movedPath, deps)
    return false
  } catch {
    try { restoreMovedEntryNoOverwrite(path, movedPath, deps) } catch { /* preserve the safer outcome */ }
    return false
  }
}

function copyValidatedSource(sourceFd: number, source: FileIdentity, targetFd: number, truncate: boolean): void {
  if (truncate) ftruncateSync(targetFd, 0)
  const sourceSize = typeof source.size === 'bigint' ? Number(source.size) : source.size
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 0) throw new Error('Temporary file is too large to recover safely')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  while (position < sourceSize) {
    const count = readSync(sourceFd, buffer, 0, Math.min(buffer.length, sourceSize - position), position)
    if (count === 0) throw new Error('Temporary file changed during recovery')
    let written = 0
    while (written < count) {
      const bytes = writeSync(targetFd, buffer, written, count - written)
      if (bytes === 0) throw new Error('Recovery write made no progress')
      written += bytes
    }
    position += count
  }
  if (!sameFileIdentity(fstatSync(sourceFd), source)) {
    throw new Error('Temporary file changed during recovery')
  }
  fsyncSync(targetFd)
}

function targetContainsSourcePrefix(sourceFd: number, source: FileIdentity, targetFd: number, target: FileIdentity): boolean {
  const sourceSize = typeof source.size === 'bigint' ? Number(source.size) : source.size
  const targetSize = typeof target.size === 'bigint' ? Number(target.size) : target.size
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 0
    || !Number.isSafeInteger(targetSize) || targetSize < 0 || targetSize > sourceSize) return false
  const sourceBuffer = Buffer.allocUnsafe(64 * 1024)
  const targetBuffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  while (position < targetSize) {
    const length = Math.min(sourceBuffer.length, targetSize - position)
    let sourceRead = 0
    while (sourceRead < length) {
      const count = readSync(sourceFd, sourceBuffer, sourceRead, length - sourceRead, position + sourceRead)
      if (count === 0) return false
      sourceRead += count
    }
    let targetRead = 0
    while (targetRead < length) {
      const count = readSync(targetFd, targetBuffer, targetRead, length - targetRead, position + targetRead)
      if (count === 0) return false
      targetRead += count
    }
    if (!sourceBuffer.subarray(0, length).equals(targetBuffer.subarray(0, length))) return false
    position += length
  }
  return sameFileIdentity(fstatSync(sourceFd), source)
}

function targetContainsSource(sourceFd: number, source: FileIdentity, targetFd: number, target: FileIdentity): boolean {
  const sourceSize = typeof source.size === 'bigint' ? Number(source.size) : source.size
  const targetSize = typeof target.size === 'bigint' ? Number(target.size) : target.size
  return Number.isSafeInteger(sourceSize) && sourceSize >= 0
    && sourceSize === targetSize
    && targetContainsSourcePrefix(sourceFd, source, targetFd, target)
}

type ResumeResult = 'promoted' | 'unmarked' | 'retry'

function resumeMarkedCopy(fd: number, tmpPath: string, targetPath: string, deps: RecoveryDeps, guard: RecoveryPathGuard): ResumeResult {
  if (!hasRecoveryMarker(tmpPath)) return 'unmarked'
  const marker = readRecoveryMarker(tmpPath)
  if (!marker) {
    return blockRecovery(
      targetPath,
      tmpPath,
      'its fallback ownership marker is invalid',
    )
  }
  if (marker.targetPath !== targetPath) {
    return blockRecovery(
      targetPath,
      tmpPath,
      'its fallback ownership marker names another target',
    )
  }

  const source = fstatSync(fd)
  if (!sameFileIdentity(source, marker.source)) {
    return blockRecovery(
      targetPath,
      tmpPath,
      `its fallback ownership marker does not match ${tmpPath}`,
    )
  }

  if (!marker.target) {
    let targetFd: number | undefined
    let target: FileIdentity | undefined
    let complete = false
    let targetMissing = false
    try {
      guard(targetPath)
      targetFd = openFileNoFollowSync(targetPath)
      target = fstatSync(targetFd)
      complete = targetContainsSource(fd, source, targetFd, target)
        && sameEntryIdentity(lstatSync(targetPath), target)
    } catch (error) {
      // A source-only marker is durable ownership of the validated temp. If
      // the destination disappeared before this check, retry the exclusive
      // publication with that same source instead of discarding it. An
      // existing but incomplete destination remains blocked below because its
      // ownership cannot be proved from the source-only marker.
      targetMissing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      complete = false
    } finally {
      if (targetFd !== undefined) closeSync(targetFd)
    }
    if (targetMissing) return 'retry'
    if (!complete) {
      return blockRecovery(
        targetPath,
        tmpPath,
        'its prepared fallback target is incomplete or changed',
      )
    }
    try {
      guard(targetPath)
      guard(tmpPath)
      if (removeMatchingEntry(tmpPath, source, deps)) {
        cleanupSidecar(atomicProofPath(tmpPath))
        cleanupSidecar(recoveryMarkerPath(tmpPath))
      } else {
        console.warn(`[recovery] Recovered ${targetPath} but preserved changed ${tmpPath}`)
      }
    } catch (error) {
      console.warn(`[recovery] Recovered ${targetPath} but could not remove ${tmpPath}:`, error)
    }
    return 'promoted'
  }

  let targetFd: number | undefined
  try {
    guard(targetPath)
    targetFd = openSync(targetPath, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0))
    const target = fstatSync(targetFd)
    if (!sameEntryIdentity(target, marker.target)) {
      return blockRecovery(
        targetPath,
        tmpPath,
        'its fallback target identity no longer matches the ownership marker',
      )
    }
    if (marker.complete === true) {
      if (!sameFileIdentity(target, marker.target)) {
        return blockRecovery(
          targetPath,
          tmpPath,
          'its completed fallback target changed after publication',
        )
      }
    } else {
      const sourceSize = typeof source.size === 'bigint' ? Number(source.size) : source.size
      const targetSize = typeof target.size === 'bigint' ? Number(target.size) : target.size
      if (!Number.isSafeInteger(sourceSize) || !Number.isSafeInteger(targetSize) || targetSize > sourceSize) {
        return blockRecovery(
          targetPath,
          tmpPath,
          'its incomplete fallback target contains newer data',
        )
      }
      if (!targetContainsSourcePrefix(fd, source, targetFd, target)) {
        return blockRecovery(
          targetPath,
          tmpPath,
          'its incomplete fallback target changed before recovery resumed',
        )
      }
      copyValidatedSource(fd, source, targetFd, true)
    }
    const currentTarget = lstatSync(targetPath)
    if (marker.complete === true
      ? !sameFileIdentity(currentTarget, target)
      : !sameEntryIdentity(currentTarget, target)) {
      return blockRecovery(
        targetPath,
        tmpPath,
        'its fallback target changed while it was being resumed',
      )
    }
    fsyncDirectory(dirname(targetPath))
    // Recheck after the directory durability point too. A replacement between
    // copy and cleanup must never make the recovery sidecar delete a different
    // target on the next boot.
    if (!sameEntryIdentity(lstatSync(targetPath), target)) {
      return blockRecovery(
        targetPath,
        tmpPath,
        'its fallback target changed before recovery cleanup',
      )
    }
  } catch (error) {
    if (error instanceof RecoveryBlockedError) throw error
    return blockRecovery(
      targetPath,
      tmpPath,
      `its fallback target could not be resumed (${errorMessage(error)})`,
    )
  } finally {
    if (targetFd !== undefined) closeSync(targetFd)
  }

  try {
    guard(tmpPath)
    if (removeMatchingEntry(tmpPath, source, deps)) {
      cleanupSidecar(atomicProofPath(tmpPath))
      cleanupSidecar(recoveryMarkerPath(tmpPath))
    } else {
      console.warn(`[recovery] Recovered ${targetPath} but preserved changed ${tmpPath}`)
    }
  } catch (error) {
    console.warn(`[recovery] Recovered ${targetPath} but could not remove ${tmpPath}:`, error)
  }
  return 'promoted'
}

/** Publish with a hardlink when possible; the fallback is resumable and no-follow. */
function promoteTmpFile(fd: number, tmpPath: string, targetPath: string, deps: RecoveryDeps, guard: RecoveryPathGuard): boolean {
  let targetFd: number | undefined
  let publishedIdentity: FileIdentity | undefined
  let copyCompleted = false
  const markerPath = recoveryMarkerPath(tmpPath)
  try {
    guard(tmpPath)
    guard(targetPath, true)
    const source = fstatSync(fd)
    let markerPresent = hasRecoveryMarker(tmpPath)
    let existingMarker = markerPresent ? readRecoveryMarker(tmpPath) : null
    if (markerPresent && !existingMarker && !pathIsTaken(targetPath)) {
      // A torn marker beside a validated temp cannot authorize overwriting an
      // existing destination when the destination is absent. Retire that
      // unusable sidecar and let the exclusive publication recreate the
      // target; if a writer occupies the name during this check, the normal
      // identity guard below keeps the artifact blocked.
      cleanupSidecar(markerPath)
      markerPresent = hasRecoveryMarker(tmpPath)
      existingMarker = markerPresent ? readRecoveryMarker(tmpPath) : null
    }
    if (markerPresent && (!existingMarker
      || existingMarker.targetPath !== targetPath
      || !sameFileIdentity(existingMarker.source, source))) {
      return blockRecovery(
        targetPath,
        tmpPath,
        'its fallback ownership marker is invalid or does not match the temporary file',
      )
    }
    let linked = false
    try {
      retryWhileWindowsHoldsTheFile(() => {
        guard(tmpPath)
        guard(targetPath, true)
        const entry = lstatSync(tmpPath)
        if (entry.isSymbolicLink() || !sameFileIdentity(entry, source)) {
          throw new Error('Temporary file changed before recovery promotion')
        }
        // Narrow the validation-to-link window; Node cannot link an opened fd.
        deps.link(tmpPath, targetPath)
      })
      linked = true
    } catch (error) {
      if (!LINK_UNSUPPORTED_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    if (linked) {
      const entry = lstatSync(targetPath)
      if (entry.isSymbolicLink() || !sameFileIdentity(entry, source)) {
        // This entry may have been installed by another writer after linkSync.
        // A mismatch cannot establish ownership, so preserve both names.
        throw new Error('Temporary file changed before recovery promotion')
      }
      publishedIdentity = entry
      fsyncDirectory(dirname(targetPath))
    } else {
      if (!existingMarker) {
        guard(markerPath, true)
        writeRecoveryMarkerWithDeps(markerPath, { version: 1, targetPath, source }, false, deps, guard)
      }
      retryWhileWindowsHoldsTheFile(() => {
        guard(targetPath, true)
        targetFd = openSync(
          targetPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
          source.mode & 0o777,
        )
      })
      fchmodSync(targetFd!, source.mode & 0o777)
      const target = fstatSync(targetFd!)
      publishedIdentity = target
      // Record ownership as soon as the exclusive destination exists, before
      // copying any bytes. If a crash interrupts the copy, the next boot can
      // verify this exact inode and resume it instead of seeing a marker with
      // no target identity and blocking forever.
      guard(markerPath, true)
      writeRecoveryMarkerWithDeps(markerPath, { version: 1, targetPath, source, target, complete: false }, true, deps, guard)
      copyValidatedSource(fd, source, targetFd!, false)
      copyCompleted = true
      const completedTarget = fstatSync(targetFd!)
      publishedIdentity = completedTarget
      if (!sameEntryIdentity(lstatSync(targetPath), completedTarget)) {
        throw new Error('Recovery target changed during promotion')
      }
      fsyncDirectory(dirname(targetPath))
      // Publish identity only after the visible fallback contains complete,
      // fsynced bytes. A crash before this atomic marker replacement therefore
      // leaves a complete target beside the prepared marker, never an empty
      // final artifact with no durable ownership record.
      writeRecoveryMarkerWithDeps(markerPath, {
        version: 1,
        targetPath,
        source,
        target: completedTarget,
        complete: true,
      }, true, deps, guard)
    }
  } catch (error) {
    if (error instanceof RecoveryBlockedError) throw error
    // A marker may have been published during this invocation. Once it exists,
    // an incomplete visible target is an unresolved generation, not an
    // ordinary orphan that this process may remove.
    const markerIsDurable = hasRecoveryMarker(tmpPath)
    if (markerIsDurable && !copyCompleted) {
      return blockRecovery(
        targetPath,
        tmpPath,
        `its fallback copy stopped before complete publication (${errorMessage(error)})`,
      )
    }
    if (targetFd !== undefined && !copyCompleted) {
      try {
        removeMatchingEntry(targetPath, fstatSync(targetFd), deps)
      } catch (cleanupError) {
        console.warn(`[recovery] Could not remove incomplete ${targetPath}:`, cleanupError)
      }
    }
    console.error(`[recovery] Failed to promote ${tmpPath}:`, error)
    return false
  } finally {
    if (targetFd !== undefined) closeSync(targetFd)
  }
  try {
    guard(targetPath)
    if (!publishedIdentity || !sameEntryIdentity(lstatSync(targetPath), publishedIdentity)) {
      throw new Error('Recovery target changed before temp cleanup')
    }
  } catch (error) {
    console.error(`[recovery] Failed to confirm promoted target ${targetPath}:`, error)
    return false
  }
  try {
    guard(tmpPath)
    if (removeMatchingEntry(tmpPath, fstatSync(fd), deps)) {
      cleanupSidecar(atomicProofPath(tmpPath))
      cleanupSidecar(markerPath)
    } else {
      console.warn(`[recovery] Promoted ${targetPath} but preserved changed ${tmpPath}`)
    }
  } catch (error) {
    console.warn(`[recovery] Promoted ${targetPath} but could not remove ${tmpPath}:`, error)
  }
  return true
}

/**
 * Puts back writes that a crash interrupted, and clears away the ones it cannot.
 *
 * Only names `safeAtomicWrite` produced are recognised. The pre-upgrade writer
 * used a plain `${target}.tmp`, whose target cannot be derived — a
 * `report.json.tmp` is as consistent with `report.json` as with a file someone
 * named `report.json.tmp` on purpose — so those are reported and left alone
 * rather than guessed at.
 */
export function recoverOrphanTmpFiles(
  rootDir: string,
  rootKind: 'config' | 'ticket' = 'ticket',
  deps: RecoveryDeps = defaultRecoveryDeps,
): string[] {
  const recovered: string[] = []

  let canonicalRoot: string
  try {
    canonicalRoot = realpathSync.native(rootDir)
  } catch {
    return recovered
  }

  // Recovery scans the canonical tree for safety, but callers and tests need
  // paths in the spelling they supplied. On macOS `realpathSync.native` can
  // add `/private`, and on Windows it can expand a short 8.3 component; those
  // are the same files, not different recoveries.
  const reportedPath = (canonicalPath: string): string => {
    const relativePath = relative(canonicalRoot, canonicalPath)
    return relativePath ? join(rootDir, relativePath) : rootDir
  }

  const guard: RecoveryPathGuard = (candidate, allowMissingTail = false) => {
    assertRecoveryPath(canonicalRoot, candidate, allowMissingTail)
  }

  function scanDir(dir: string) {
    if (!existsSync(dir)) return
    try {
      guard(dir)
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          scanDir(fullPath)
          continue
        }
        const name = entry.name.toLowerCase()
        if (name.endsWith('.tmp.proof')) {
          const tmpPath = fullPath.slice(0, -'.proof'.length)
          const targetPath = parseAtomicTmpPath(tmpPath)
          // A proof without its temp is no longer useful. Only clean one when
          // its derived target is a known artifact; arbitrary `.proof` files
          // remain untouched.
          if (targetPath !== null
            && isKnownArtifactTarget(canonicalRoot, targetPath, rootKind)) {
            try {
              guard(fullPath)
              guard(tmpPath, true)
              if (!pathIsTaken(tmpPath)) cleanupSidecar(fullPath)
            } catch (error) {
              console.warn(`[recovery] Leaving proof sidecar ${fullPath}: its path containment could not be proved (${errorMessage(error)})`)
            }
          }
          continue
        }
        if (!name.endsWith('.tmp') && !LEGACY_TMP_NAME.test(name)) continue
        if (entry.isSymbolicLink()) {
          console.warn(`[recovery] Ignoring symbolic-link temp file ${fullPath}`)
          continue
        }
        if (!entry.isFile()) continue

        const targetPath = parseAtomicTmpPath(fullPath)
        if (targetPath === null) {
          reportLegacyTmpFile(fullPath)
          continue
        }

        if (!isKnownArtifactTarget(canonicalRoot, targetPath, rootKind)) {
          console.warn(`[recovery] Leaving ${fullPath}: target is not a known LoopTroop artifact`)
          continue
        }

        try {
          guard(fullPath)
          guard(targetPath, true)
        } catch (error) {
          console.warn(`[recovery] Leaving ${fullPath}: its path containment could not be proved (${errorMessage(error)})`)
          continue
        }

        if (pathIsTaken(targetPath)) {
          let fd: number | undefined
          try {
            fd = openFileNoFollowSync(fullPath)
            const resumed = resumeMarkedCopy(fd, fullPath, targetPath, deps, guard)
            if (resumed === 'promoted') recovered.push(reportedPath(targetPath))
            else if (resumed === 'unmarked') {
              discardTmpFile(fullPath, 'its target already exists', fstatSync(fd), deps)
            } else if (promoteTmpFile(fd, fullPath, targetPath, deps, guard)) {
              recovered.push(reportedPath(targetPath))
            }
          } catch (error) {
            if (error instanceof RecoveryBlockedError) throw error
            console.warn(`[recovery] Leaving ${fullPath} beside its existing target:`, error)
          } finally {
            if (fd !== undefined) closeSync(fd)
          }
          continue
        }

        let fd: number | undefined
        try {
          guard(fullPath)
          guard(targetPath, true)
          fd = openFileNoFollowSync(fullPath)
          const judgedSource = fstatSync(fd)
          const verdict = judgeTmpContent(fd, fullPath, targetPath)
          if (verdict.action === 'discard') {
            if (removeMatchingEntry(fullPath, fstatSync(fd), deps)) {
              cleanupSidecar(atomicProofPath(fullPath))
              cleanupSidecar(recoveryMarkerPath(fullPath))
              console.warn(`[recovery] Discarded temp file ${fullPath}: ${verdict.reason}`)
            } else {
              console.warn(`[recovery] Preserved changed temp file ${fullPath}: ${verdict.reason}`)
            }
          } else if (verdict.action === 'leave') {
            console.warn(
              `[recovery] Leaving ${fullPath} where it is: ${verdict.reason}, so it cannot be ` +
                `confirmed as the finished ${targetPath}`,
            )
          } else if (!sameFileIdentity(fstatSync(fd), judgedSource)) {
            console.warn(`[recovery] Leaving ${fullPath}: it changed while being checked`)
          } else if (promoteTmpFile(fd, fullPath, targetPath, deps, guard)) {
            recovered.push(reportedPath(targetPath))
          }
        } catch (error) {
          if (error instanceof RecoveryBlockedError) throw error
          console.warn(`[recovery] Leaving unreadable temp file ${fullPath}:`, error)
        } finally {
          if (fd !== undefined) closeSync(fd)
        }
      }
    } catch (error) {
      if (error instanceof RecoveryBlockedError) throw error
      // Ignore unreadable directories
    }
  }

  scanDir(canonicalRoot)
  return recovered
}

// Fix trailing-line corruption in JSONL files
export function fixTrailingLineCorruption(filePath: string): boolean {
  let fd: number
  try {
    fd = openFileNoFollowSync(filePath, fsConstants.O_RDWR)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    const { size: fileSize } = fstatSync(fd)
    if (fileSize === 0) return false

    if (fileSize > MAX_DIRECT_READ_BYTES) {
      return fixCorruptionLarge(fd, filePath, fileSize)
    }

    const content = readFileSync(fd)
    const lines = content.toString('utf-8').split('\n')

    // Remove empty trailing lines
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
      lines.pop()
    }

    // Check last line is valid JSON
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1]
      if (lastLine) {
        try {
          JSON.parse(lastLine)
        } catch {
          console.warn(`[recovery] Truncating corrupt last line in ${filePath}`)
          lines.pop()
          // Truncate original bytes on the verified descriptor; never reopen by name.
          let retainedBytes = 0
          for (let line = 0; line < lines.length; line++) retainedBytes = content.indexOf(0x0a, retainedBytes) + 1
          ftruncateSync(fd, retainedBytes)
          fsyncSync(fd)
          return true
        }
      }
    }

    return false
  } finally {
    closeSync(fd)
  }
}

/**
 * Large-file variant: scans backward in byte chunks to find the last line without
 * loading the whole file into memory. Only truncates — never re-encodes — to avoid
 * UTF-8 boundary issues.
 */
function fixCorruptionLarge(fd: number, filePath: string, fileSize: number): boolean {
  const contentEnd = findContentEnd(fd, fileSize)
  if (contentEnd <= 0) return false

  const lineStart = findLineStart(fd, contentEnd)
  if (lineStart === null) {
    console.warn(
      `[recovery] Skipping large-file corruption check for ${filePath}: ` +
        `last line exceeds ${MAX_LAST_LINE_SCAN / 1024 / 1024} MB scan limit`,
    )
    return false
  }

  const lineLen = contentEnd - lineStart
  const lineBuf = Buffer.allocUnsafe(lineLen)
  const bytesRead = readSync(fd, lineBuf, 0, lineLen, lineStart)
  const lastLine = lineBuf.subarray(0, bytesRead).toString('utf-8')

  try {
    JSON.parse(lastLine)
    return false
  } catch {
    console.warn(`[recovery] Truncating corrupt last line in ${filePath} (large file)`)
    ftruncateSync(fd, lineStart)
    fsyncSync(fd)
    return true
  }
}

/** Returns the byte offset one past the last non-newline byte, or 0 if the file is all newlines. */
function findContentEnd(fd: number, fileSize: number): number {
  let pos = fileSize
  while (pos > 0) {
    const readSize = Math.min(SCAN_CHUNK_SIZE, pos)
    pos -= readSize
    const buf = Buffer.allocUnsafe(readSize)
    const bytesRead = readSync(fd, buf, 0, readSize, pos)
    for (let i = bytesRead - 1; i >= 0; i--) {
      if (buf[i] !== 0x0a && buf[i] !== 0x0d) {
        return pos + i + 1
      }
    }
  }
  return 0
}

/**
 * Returns the byte offset of the first byte of the last line (the byte right after
 * its preceding newline), scanning backward from `contentEnd`.
 * Returns `null` if the last line is longer than MAX_LAST_LINE_SCAN (too big to validate safely).
 */
function findLineStart(fd: number, contentEnd: number): number | null {
  const scanStart = Math.max(0, contentEnd - MAX_LAST_LINE_SCAN)
  let pos = contentEnd
  while (pos > scanStart) {
    const readSize = Math.min(SCAN_CHUNK_SIZE, pos - scanStart)
    pos -= readSize
    const buf = Buffer.allocUnsafe(readSize)
    const bytesRead = readSync(fd, buf, 0, readSize, pos)
    for (let i = bytesRead - 1; i >= 0; i--) {
      if (buf[i] === 0x0a) {
        return pos + i + 1
      }
    }
  }
  // Scanned all the way to the beginning of the file (or scan limit)
  if (scanStart === 0) return 0
  return null
}
