import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { logsCommand } from '../logsCommand'
import { getDaemonLogPath } from '../../lib/daemonPaths'

const TAIL_CHUNK_BYTES = 64 * 1024

const roots: string[] = []
const originalConfigDir = process.env.LOOPTROOP_CONFIG_DIR

afterEach(() => {
  vi.restoreAllMocks()
  if (originalConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
  else process.env.LOOPTROOP_CONFIG_DIR = originalConfigDir
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Points the CLI at a throwaway config dir and writes `content` as the log. */
function withDaemonLog(content: string): void {
  const root = mkdtempSync(join(tmpdir(), 'looptroop-logs-test-'))
  roots.push(root)
  process.env.LOOPTROOP_CONFIG_DIR = root
  const logPath = getDaemonLogPath()
  mkdirSync(dirname(logPath), { recursive: true })
  writeFileSync(logPath, content, 'utf8')
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

    expect(await logsCommand({ follow: false })).toBe(1)
  })
})
