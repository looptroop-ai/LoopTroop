import { createReadStream, existsSync, statSync, watch } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { getDaemonLogPath } from '../lib/daemonPaths'

export interface LogsOptions {
  follow: boolean
  lines?: number
}

const DEFAULT_LINES = 50

const TAIL_CHUNK_BYTES = 64 * 1024
const NEWLINE_BYTE = 0x0a

interface TailRead {
  text: string
  offset: number
  /** Bytes held by the initial decoder until the first follow window arrives. */
  decoderSeed: Buffer
  /** Whether the original tail ended with a complete newline. */
  endsWithNewline: boolean
}

/**
 * The last `lines` lines, read backwards from the end of the file.
 *
 * Reading the whole file and slicing loaded a long-running daemon's entire log
 * into memory to print fifty lines of it.
 */
async function readTail(logPath: string, lines: number): Promise<TailRead> {
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
    const raw = Buffer.concat(chunks)
    const decoderSeed = incompleteUtf8Suffix(raw)
    const complete = decoderSeed.length === 0 ? raw : raw.subarray(0, -decoderSeed.length)
    const all = complete.toString('utf8').split('\n')
    // A trailing newline yields an empty final element that would print as a blank line.
    if (all.at(-1) === '') all.pop()
    return {
      text: all.slice(-lines).join('\n'),
      offset: size,
      decoderSeed,
      // A complete newline may precede an incomplete character on the next
      // line. Preserve that separator before the seeded decoder emits the
      // character; only the incomplete bytes themselves are withheld.
      endsWithNewline: complete.at(-1) === NEWLINE_BYTE,
    }
  } finally {
    await handle.close()
  }
}

/** Returns a valid, incomplete UTF-8 sequence at the end of a byte window. */
function incompleteUtf8Suffix(buffer: Buffer): Buffer {
  let continuationBytes = 0
  let index = buffer.length - 1
  while (index >= 0 && (buffer[index]! & 0xc0) === 0x80) {
    continuationBytes += 1
    index -= 1
  }
  if (index < 0) return Buffer.alloc(0)

  const lead = buffer[index]!
  const expectedBytes = lead >= 0xc2 && lead <= 0xdf
    ? 2
    : lead >= 0xe0 && lead <= 0xef
      ? 3
      : lead >= 0xf0 && lead <= 0xf4
        ? 4
        : 0
  return expectedBytes > 0 && continuationBytes + 1 < expectedBytes
    ? buffer.subarray(index)
    : Buffer.alloc(0)
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
  if (tail.text) process.stdout.write(tail.text)
  if (tail.endsWithNewline) process.stdout.write('\n')

  if (!options.follow) return 0

  await followLog(logPath, tail.offset, tail.decoderSeed)
  return 0
}

/**
 * Streams appended bytes. Tracks the offset rather than re-reading the file so
 * a long-running daemon's log is not read from the start on every change, and
 * resets when the file shrinks so rotation does not leave us reading past the end.
 */
function followLog(logPath: string, initialOffset: number, initialDecoderSeed: Buffer): Promise<void> {
  return new Promise((resolveFollow) => {
    // The tail reader recorded its file size before decoding. Register the
    // watcher before draining that offset so bytes written in the handoff gap
    // are read once rather than silently skipped.
    let offset = initialOffset
    let reading = false
    let decoder = new StringDecoder('utf8')
    // `readTail` may have ended on the first byte(s) of a character. Feed the
    // incomplete sequence into the same decoder that will consume follow-up
    // bytes; decoding the two windows independently would print replacements.
    if (initialDecoderSeed.length > 0) decoder.write(initialDecoderSeed)

    const drain = (): void => {
      if (reading) return
      let size: number
      try {
        size = statSync(logPath).size
      } catch {
        return
      }

      if (size < offset) {
        offset = 0
        decoder = new StringDecoder('utf8')
      }
      if (size === offset) return

      reading = true
      const stream = createReadStream(logPath, { start: offset, end: size - 1 })
      // Keep one decoder across watcher windows. A writer can split a UTF-8
      // character across appends, and each stream is only one such window.
      stream.on('data', (chunk) => process.stdout.write(decoder.write(chunk)))
      stream.on('end', () => {
        offset = size
        reading = false
        // Watch events that arrived while this read was in flight were dropped
        // by the guard above, so without this the bytes they were about to
        // report wait for the *next* write — and on a daemon that has gone
        // quiet, forever. Terminates: a drain with nothing new returns at the
        // `size === offset` check.
        drain()
      })
      stream.on('error', () => { reading = false })
    }

    const watcher = watch(logPath, { persistent: true }, drain)
    drain()

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
