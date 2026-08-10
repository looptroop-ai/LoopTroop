import { createReadStream, existsSync, statSync, watch } from 'node:fs'
import { getDaemonLogPath } from '../lib/daemonPaths'

export interface LogsOptions {
  follow: boolean
  lines?: number
}

const DEFAULT_LINES = 50

async function readTail(logPath: string, lines: number): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const content = await readFile(logPath, 'utf8')
  const all = content.split('\n')
  // A trailing newline yields an empty final element that would print as a blank line.
  if (all.at(-1) === '') all.pop()
  return all.slice(-lines).join('\n')
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
      const stream = createReadStream(logPath, { start: offset, end: size - 1, encoding: 'utf8' })
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
      resolveFollow()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}
