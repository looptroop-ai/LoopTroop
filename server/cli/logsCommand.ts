import { createReadStream, existsSync, statSync, watch } from 'node:fs'
import { getDaemonLogPath } from '../lib/daemonPaths'

export interface LogsOptions {
  follow: boolean
  lines?: number
}

const DEFAULT_LINES = 50

const TAIL_CHUNK_BYTES = 64 * 1024
const NEWLINE_BYTE = 0x0a

/**
 * The last `lines` lines, read backwards from the end of the file.
 *
 * Reading the whole file and slicing loaded a long-running daemon's entire log
 * into memory to print fifty lines of it.
 */
async function readTail(logPath: string, lines: number): Promise<string> {
  const { open } = await import('node:fs/promises')
  const handle = await open(logPath, 'r')
  try {
    const size = (await handle.stat()).size
    let position = size
    const chunks: Buffer[] = []
    let newlines = 0
    // One more newline than lines requested: the first is the end of the line
    // *before* the window, which is what makes the count exact.
    while (position > 0 && newlines <= lines) {
      const length = Math.min(TAIL_CHUNK_BYTES, position)
      position -= length
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, position)
      // Kept as bytes and decoded once at the end. Decoding each chunk on its
      // own split whatever multi-byte character straddled the 64 KiB boundary
      // into a pair of replacement characters, so a log with any non-ASCII text
      // in it grew mojibake every 64 KiB.
      chunks.unshift(buffer)
      newlines += countNewlines(buffer)
    }
    const all = Buffer.concat(chunks).toString('utf8').split('\n')
    // A trailing newline yields an empty final element that would print as a blank line.
    if (all.at(-1) === '') all.pop()
    return all.slice(-lines).join('\n')
  } finally {
    await handle.close()
  }
}

/**
 * Counted over bytes, which UTF-8 makes safe: 0x0A cannot appear inside a
 * multi-byte sequence, so a byte scan and a character scan agree.
 */
function countNewlines(buffer: Buffer): number {
  let count = 0
  for (let index = buffer.indexOf(NEWLINE_BYTE); index !== -1; index = buffer.indexOf(NEWLINE_BYTE, index + 1)) count += 1
  return count
}

export async function logsCommand(options: LogsOptions): Promise<number> {
  const logPath = getDaemonLogPath()

  if (!existsSync(logPath)) {
    process.stderr.write(`No log file yet at ${logPath}.\nStart the daemon with \`looptroop start\`.\n`)
    return 1
  }

  const lines = Number.isInteger(options.lines) && (options.lines ?? 0) > 0
    ? options.lines as number
    : DEFAULT_LINES

  const tail = await readTail(logPath, lines)
  if (tail) process.stdout.write(`${tail}\n`)

  if (!options.follow) return 0

  await followLog(logPath)
  return 0
}

/**
 * Streams appended bytes. Tracks the offset rather than re-reading the file so
 * a long-running daemon's log is not read from the start on every change, and
 * resets when the file shrinks so rotation does not leave us reading past the end.
 */
function followLog(logPath: string): Promise<void> {
  return new Promise((resolveFollow) => {
    let offset = statSync(logPath).size
    let reading = false

    const drain = (): void => {
      if (reading) return
      let size: number
      try {
        size = statSync(logPath).size
      } catch {
        return
      }

      if (size < offset) offset = 0
      if (size === offset) return

      reading = true
      // Bytes straight through, no decoding. Each `drain` opened its own
      // stream, so a decoder could only ever see one window of the file, and a
      // multi-byte character split across two windows came out as replacement
      // characters. stdout wants bytes anyway.
      const stream = createReadStream(logPath, { start: offset, end: size - 1 })
      stream.on('data', (chunk) => process.stdout.write(chunk))
      stream.on('end', () => {
        offset = size
        reading = false
      })
      stream.on('error', () => { reading = false })
    }

    const watcher = watch(logPath, { persistent: true }, drain)

    const stop = (): void => {
      watcher.close()
      // Removed with the watcher. Left installed, these accumulated one pair
      // per follow and kept the process referenced after it had stopped.
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolveFollow()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}
