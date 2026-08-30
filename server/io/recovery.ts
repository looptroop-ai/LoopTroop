import {
  readdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  ftruncateSync,
  closeSync,
  linkSync,
  unlinkSync,
} from 'fs'
import { extname, join } from 'path'
import * as jsYaml from 'js-yaml'
import { parseAtomicTmpPath } from './atomicWrite'

/** Files below this threshold are loaded entirely into memory (safe for Node's string limit). */
const MAX_DIRECT_READ_BYTES = 256 * 1024 * 1024 // 256 MB
/** Chunk size used when scanning large files backwards. */
const SCAN_CHUNK_SIZE = 8 * 1024 // 8 KB
/** Maximum bytes to scan backwards when looking for the start of the last line. */
const MAX_LAST_LINE_SCAN = 4 * 1024 * 1024 // 4 MB

/**
 * Filesystems that do not implement `link` at all, or refuse it for this
 * caller. Only for these does promotion fall back to the check-then-rename
 * that `link` exists to avoid.
 */
const LINK_UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  'EPERM', 'EACCES', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP', 'ENOTSUP', 'EMLINK',
])

/**
 * Whether a leftover temp file is worth putting back.
 *
 * A temp file exists precisely because a write did not finish, so its content
 * is the one thing that cannot be assumed. Promoting on the strength of the
 * name alone replaces nothing with a document that stops mid-sentence — and it
 * looks complete afterwards, because the name is the only thing anyone sees.
 */
function describeUnusableContent(tmpPath: string, targetPath: string): string | null {
  let size: number
  try {
    size = statSync(tmpPath).size
  } catch {
    return 'it could not be read'
  }
  if (size === 0) return 'it is empty'
  // Too large to hold as a string; the extension checks below cannot run, and
  // a partial write of this size is a JSONL log whose tail is repaired by
  // `fixTrailingLineCorruption` once the file is back under its own name.
  if (size > MAX_DIRECT_READ_BYTES) return null

  const extension = extname(targetPath).toLowerCase()
  if (extension === '.json') {
    try {
      JSON.parse(readFileSync(tmpPath, 'utf-8'))
    } catch {
      return 'it is not readable JSON'
    }
    return null
  }
  if (extension === '.yaml' || extension === '.yml') {
    try {
      jsYaml.load(readFileSync(tmpPath, 'utf-8'))
    } catch {
      return 'it is not a readable YAML document'
    }
    return null
  }
  // `.jsonl` deliberately gets the non-empty check only: a truncated final line
  // is the expected shape of an interrupted append, and repairing it is
  // `fixTrailingLineCorruption`'s job, running right after this on the same
  // files.
  return null
}

function discardTmpFile(tmpPath: string, reason: string): void {
  try {
    unlinkSync(tmpPath)
    console.warn(`[recovery] Discarded temp file ${tmpPath}: ${reason}`)
  } catch (error) {
    console.error(`[recovery] Failed to remove temp file ${tmpPath} (${reason}):`, error)
  }
}

/**
 * Puts a temp file back under its real name, refusing to replace a target that
 * already exists.
 *
 * "Check that it is missing, then rename" is a race, and POSIX `rename`
 * replaces silently — so a complete document can be overwritten by a partial
 * one written before the crash. Node exposes no `renameat2(RENAME_NOREPLACE)`,
 * which leaves `link` as the portable primitive that fails rather than
 * replaces. Temp and target always share a directory, so they are always on one
 * filesystem, which is what makes `link` available at all.
 */
function promoteTmpFile(tmpPath: string, targetPath: string): boolean {
  try {
    linkSync(tmpPath, targetPath)
    try {
      unlinkSync(tmpPath)
    } catch (error) {
      console.warn(`[recovery] Promoted ${targetPath} but could not remove ${tmpPath}:`, error)
    }
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      discardTmpFile(tmpPath, 'its target already exists')
      return false
    }
    if (code === undefined || !LINK_UNSUPPORTED_CODES.has(code)) {
      console.error(`[recovery] Failed to promote ${tmpPath}:`, error)
      return false
    }
    if (existsSync(targetPath)) {
      discardTmpFile(tmpPath, 'its target already exists')
      return false
    }
    try {
      renameSync(tmpPath, targetPath)
      return true
    } catch (renameError) {
      console.error(`[recovery] Failed to promote ${tmpPath}:`, renameError)
      return false
    }
  }
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
export function recoverOrphanTmpFiles(rootDir: string): string[] {
  const recovered: string[] = []

  function scanDir(dir: string) {
    if (!existsSync(dir)) return
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          scanDir(fullPath)
          continue
        }
        if (!entry.isFile()) continue
        if (!entry.name.toLowerCase().endsWith('.tmp')) continue

        const targetPath = parseAtomicTmpPath(fullPath)
        if (targetPath === null) {
          // Left in place: the pre-upgrade crash that produced it is exactly
          // the case someone would want to look at, and vaulting it silently
          // is worse than either promoting it or saying so.
          let modified = 'an unknown time'
          try {
            modified = statSync(fullPath).mtime.toISOString()
          } catch { /* reported without it */ }
          console.warn(
            `[recovery] Ignoring ${fullPath} (last modified ${modified}): its name predates the ` +
              'current atomic-write suffix, so the file it was meant to become cannot be derived',
          )
          continue
        }

        if (existsSync(targetPath)) {
          discardTmpFile(fullPath, 'its target already exists')
          continue
        }

        const unusable = describeUnusableContent(fullPath, targetPath)
        if (unusable !== null) {
          discardTmpFile(fullPath, `${unusable}, so it cannot be the finished ${targetPath}`)
          continue
        }

        if (promoteTmpFile(fullPath, targetPath)) {
          recovered.push(targetPath)
        }
      }
    } catch {
      // Ignore unreadable directories
    }
  }

  scanDir(rootDir)
  return recovered
}

// Fix trailing-line corruption in JSONL files
export function fixTrailingLineCorruption(filePath: string): boolean {
  if (!existsSync(filePath)) return false

  const { size: fileSize } = statSync(filePath)
  if (fileSize === 0) return false

  if (fileSize > MAX_DIRECT_READ_BYTES) {
    return fixCorruptionLarge(filePath, fileSize)
  }

  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')

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
        // Last line is corrupt, remove it
        console.warn(`[recovery] Truncating corrupt last line in ${filePath}`)
        lines.pop()
        writeFileSync(filePath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8')
        return true
      }
    }
  }

  return false
}

/**
 * Large-file variant: scans backward in byte chunks to find the last line without
 * loading the whole file into memory. Only truncates — never re-encodes — to avoid
 * UTF-8 boundary issues.
 */
function fixCorruptionLarge(filePath: string, fileSize: number): boolean {
  const fd = openSync(filePath, 'r+')
  try {
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
      return true
    }
  } finally {
    closeSync(fd)
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
