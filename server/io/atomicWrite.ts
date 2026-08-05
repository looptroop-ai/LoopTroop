import { writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync, unlinkSync, chmodSync, statSync } from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'crypto'

/** POSIX modes are advisory on Windows, where ACLs already restrict the profile. */
const SUPPORTS_POSIX_MODES = process.platform !== 'win32'

function currentMode(filePath: string): number | null {
  if (!SUPPORTS_POSIX_MODES) return null
  try {
    return statSync(filePath).mode & 0o777
  } catch {
    return null
  }
}

export function safeAtomicWrite(filePath: string, content: string): void {
  // Unique suffix: a fixed ".tmp" collides when concurrent processes write the
  // same target, and one rename then clobbers the other's partial file.
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const dir = dirname(filePath)

  // Captured before the write so replacing a 0600 file cannot silently widen it
  // to the default 0644 that the fresh temp file would carry through rename.
  const existingMode = currentMode(filePath)

  mkdirSync(dir, { recursive: true })

  let tmpCreated = false
  try {
    writeFileSync(tmpPath, content, 'utf-8')
    tmpCreated = true

    if (existingMode !== null) {
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

    renameSync(tmpPath, filePath)
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
