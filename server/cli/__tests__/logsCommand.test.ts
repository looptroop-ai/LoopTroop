import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getDaemonLogPath } from '../../lib/daemonPaths'

const TAIL_CHUNK_BYTES = 64 * 1024

const watchMock = vi.fn()
const createReadStreamMock = vi.fn()

const roots: string[] = []
const originalConfigDir = process.env.LOOPTROOP_CONFIG_DIR

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('node:fs')
  vi.resetModules()
  watchMock.mockReset()
  createReadStreamMock.mockReset()
  if (originalConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
  else process.env.LOOPTROOP_CONFIG_DIR = originalConfigDir
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function loadLogsCommand(): Promise<typeof import('../logsCommand').logsCommand> {
  return (await import('../logsCommand')).logsCommand
}

function mockFollowIO(): void {
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return { ...actual, watch: watchMock, createReadStream: createReadStreamMock }
  })
  vi.resetModules()
}

/** Points the CLI at a throwaway config dir and writes `content` as the log. */
function withDaemonLog(content: string | Uint8Array): void {
  const root = mkdtempSync(join(tmpdir(), 'looptroop-logs-test-'))
  roots.push(root)
  process.env.LOOPTROOP_CONFIG_DIR = root
  const logPath = getDaemonLogPath()
  mkdirSync(dirname(logPath), { recursive: true })
  if (typeof content === 'string') writeFileSync(logPath, content, 'utf8')
  else writeFileSync(logPath, content)
}

/** Everything the command wrote to stdout. */
function captureStdout(): { text: () => string } {
  const written: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  })
  return { text: () => written.join('') }
}

describe('logsCommand', () => {
  it('prints the last lines of the log', async () => {
    withDaemonLog('one\ntwo\nthree\nfour\n')
    const stdout = captureStdout()
    const logsCommand = await loadLogsCommand()

    expect(await logsCommand({ follow: false, lines: 2 })).toBe(0)
    expect(stdout.text()).toBe('three\nfour\n')
  })

  it('keeps a multi-byte character that straddles a read boundary intact', async () => {
    // The tail is read backwards in 64 KiB chunks. Decoding each chunk on its
    // own turned whatever character sat on the boundary into two replacement
    // characters, so a log with any non-ASCII text in it corrupted every 64 KiB.
    // `é` is placed so its two bytes land either side of the first boundary.
    const trailer = '\nsecond\nthird\n'
    const filler = 'a'.repeat(TAIL_CHUNK_BYTES - 1 - Buffer.byteLength(trailer))
    withDaemonLog(`first line\né${filler}${trailer}`)
    const stdout = captureStdout()
    const logsCommand = await loadLogsCommand()

    expect(await logsCommand({ follow: false, lines: 3 })).toBe(0)
    const [firstTailLine] = stdout.text().split('\n')
    expect(firstTailLine?.startsWith('é')).toBe(true)
    expect(stdout.text()).not.toContain('�')
  })

  it('reports a missing log file rather than printing nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'looptroop-logs-test-'))
    roots.push(root)
    process.env.LOOPTROOP_CONFIG_DIR = root
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const logsCommand = await loadLogsCommand()

    expect(await logsCommand({ follow: false })).toBe(1)
  })

  it('reads the handoff gap once and joins UTF-8 split across follow windows', async () => {
    withDaemonLog('tail\n')
    const stdout = captureStdout()
    const logPath = getDaemonLogPath()
    mockFollowIO()
    const logsCommand = await loadLogsCommand()
    let drain: (() => void) | undefined
    let reads = 0

    watchMock.mockImplementation((_path: string, _options: { persistent: boolean }, listener: () => void) => {
      drain = listener
      // This write happens after the initial tail's stat but before the watcher
      // exists. The explicit first drain must pick it up.
      writeFileSync(logPath, Buffer.from([0xe2]), { flag: 'a' })
      return { close: vi.fn() }
    })

    createReadStreamMock.mockImplementation((path: string, options: { start: number, end: number }) => {
      const stream = new EventEmitter()
      const contents = Buffer.from(readFileSync(path))
      const bytes = contents.subarray(options.start, options.end + 1)
      reads += 1
      stream.once('end', () => {
        if (reads === 1) {
          // Complete the character in a later watcher window. StringDecoder
          // must retain the leading byte from the first window.
          writeFileSync(logPath, Buffer.from([0x82, 0xac]), { flag: 'a' })
          drain?.()
        } else {
          process.emit('SIGINT')
        }
      })
      queueMicrotask(() => {
        if (bytes.length > 0) stream.emit('data', bytes)
        stream.emit('end')
      })
      return stream as unknown as ReturnType<typeof import('node:fs').createReadStream>
    })

    expect(await logsCommand({ follow: true, lines: 1 })).toBe(0)
    expect(stdout.text()).toBe('tail\n€')
  })

  it('carries an incomplete initial line and UTF-8 character into follow', async () => {
    // The initial tail ends after the first byte of `€`. It must not finalize
    // that decoder or add a newline before the writer supplies the rest.
    withDaemonLog(Buffer.concat([Buffer.from('partial'), Buffer.from([0xe2])]))
    const stdout = captureStdout()
    const logPath = getDaemonLogPath()
    mockFollowIO()
    const logsCommand = await loadLogsCommand()
    let drain: (() => void) | undefined
    let reads = 0

    watchMock.mockImplementation((_path: string, _options: { persistent: boolean }, listener: () => void) => {
      drain = listener
      // Complete the character in the watcher handoff window. The first read
      // then appends the remainder of the line for a second follow window.
      writeFileSync(logPath, Buffer.from([0x82, 0xac]), { flag: 'a' })
      return { close: vi.fn() }
    })

    createReadStreamMock.mockImplementation((path: string, options: { start: number, end: number }) => {
      const stream = new EventEmitter()
      const contents = Buffer.from(readFileSync(path))
      const bytes = contents.subarray(options.start, options.end + 1)
      reads += 1
      stream.once('end', () => {
        if (reads === 1) {
          writeFileSync(logPath, Buffer.from(' rest\n'), { flag: 'a' })
          drain?.()
        } else {
          process.emit('SIGINT')
        }
      })
      queueMicrotask(() => {
        if (bytes.length > 0) stream.emit('data', bytes)
        stream.emit('end')
      })
      return stream as unknown as ReturnType<typeof import('node:fs').createReadStream>
    })

    expect(await logsCommand({ follow: true, lines: 1 })).toBe(0)
    expect(stdout.text()).toBe('partial€ rest\n')
  })
})
