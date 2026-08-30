import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  lstatSync,
  openSync,
  readSync,
  ftruncateSync,
  closeSync,
  linkSync,
  copyFileSync,
  unlinkSync,
  constants as fsConstants,
} from 'fs'
import { extname, join } from 'path'
import * as jsYaml from 'js-yaml'
import { parseAtomicTmpPath, retryWhileWindowsHoldsTheFile } from './atomicWrite'

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

function judgeTmpContent(tmpPath: string, targetPath: string): TmpVerdict {
  let size: number
  try {
    size = statSync(tmpPath).size
  } catch {
    return { action: 'leave', reason: 'it could not be read' }
  }
  if (size === 0) return { action: 'discard', reason: 'it is empty' }

  const extension = extname(targetPath).toLowerCase()

  // A truncated final line is the expected shape of an interrupted append, and
  // repairing it is `fixTrailingLineCorruption`'s job — which runs right after
  // this, on these same files. Size is no obstacle: it never holds the whole
  // file in memory.
  if (extension === '.jsonl') return PROMOTE

  // Everything below has to read the file to judge it. Past this size that is
  // not something to do at boot, and promoting unread would be the name-alone
  // rule this function exists to replace — so it is left for a person.
  if (size > MAX_DIRECT_READ_BYTES) {
    return { action: 'leave', reason: `it is too large to check (${size} bytes)` }
  }

  if (extension === '.json') {
    try {
      JSON.parse(readFileSync(tmpPath, 'utf-8'))
    } catch {
      return { action: 'discard', reason: 'it is not readable JSON' }
    }
    return PROMOTE
  }

  if (extension === '.yaml' || extension === '.yml') {
    let document: unknown
    try {
      document = jsYaml.load(readFileSync(tmpPath, 'utf-8'))
    } catch {
      return { action: 'discard', reason: 'it is not a readable YAML document' }
    }
    // This proves the file is readable, not that it is complete. A block mapping
    // has no closing delimiter, so the first half of an interrupted YAML write
    // usually parses as a smaller, valid document — where the first half of a
    // JSON object cannot, which is what makes the branch above the stronger
    // check. What this catches is the interrupted write that produced no
    // document at all: `undefined` for a file that is blank or all comments,
    // `null` for one that got as far as `---` and stopped. Every YAML file this
    // project writes is a mapping, so neither is ever the real thing.
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

function reportLegacyTmpFile(tmpPath: string): void {
  // Left in place: the pre-upgrade crash that produced it is exactly the case
  // someone would want to look at, and vaulting it silently is worse than
  // either promoting it or saying so.
  let modified = 'an unknown time'
  try {
    modified = statSync(tmpPath).mtime.toISOString()
  } catch { /* reported without it */ }
  console.warn(
    `[recovery] Ignoring ${tmpPath} (last modified ${modified}): its name predates the current ` +
      'atomic-write suffix, so the file it was meant to become cannot be derived',
  )
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
 *
 * Where the filesystem has no `link` — FAT volumes, some network shares — the
 * fallback is `copyFile` with `COPYFILE_EXCL`, which opens the target
 * `O_CREAT|O_EXCL` and so fails on an existing name (a dangling symlink
 * included) rather than replacing it. It copies rather than renames, which
 * costs a pass over the bytes on a path that is already rare.
 */
function promoteTmpFile(tmpPath: string, targetPath: string): boolean {
  const removeTmp = () => {
    try {
      unlinkSync(tmpPath)
    } catch (error) {
      console.warn(`[recovery] Promoted ${targetPath} but could not remove ${tmpPath}:`, error)
    }
  }

  try {
    retryWhileWindowsHoldsTheFile(() => { linkSync(tmpPath, targetPath) })
    removeTmp()
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
    try {
      retryWhileWindowsHoldsTheFile(() => {
        copyFileSync(tmpPath, targetPath, fsConstants.COPYFILE_EXCL)
      })
      removeTmp()
      return true
    } catch (copyError) {
      if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') {
        discardTmpFile(tmpPath, 'its target already exists')
        return false
      }
      console.error(`[recovery] Failed to promote ${tmpPath}:`, copyError)
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
        const name = entry.name.toLowerCase()
        if (!name.endsWith('.tmp') && !LEGACY_TMP_NAME.test(name)) continue

        const targetPath = parseAtomicTmpPath(fullPath)
        if (targetPath === null) {
          reportLegacyTmpFile(fullPath)
          continue
        }

        if (pathIsTaken(targetPath)) {
          discardTmpFile(fullPath, 'its target already exists')
          continue
        }

        const verdict = judgeTmpContent(fullPath, targetPath)
        if (verdict.action === 'discard') {
          discardTmpFile(fullPath, `${verdict.reason}, so it cannot be the finished ${targetPath}`)
          continue
        }
        if (verdict.action === 'leave') {
          console.warn(
            `[recovery] Leaving ${fullPath} where it is: ${verdict.reason}, so it cannot be ` +
              `confirmed as the finished ${targetPath}`,
          )
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
