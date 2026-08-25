import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logsCommand } from '../server/cli/logsCommand'
import { getDaemonLogDir, getDaemonLogPath } from '../server/lib/daemonPaths'
import { removeTempDir } from '../server/test/tempDir'

/**
 * 2.11 contract: `logs` shows recent output without loading the whole file into
 * the terminal, and reports clearly when there is nothing to show yet.
 */
describe('logs command', () => {
  const tempDirs: string[] = []
  const previousConfigDir = process.env.LOOPTROOP_CONFIG_DIR

  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) {
      removeTempDir(dir)
    }
    if (previousConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
    else process.env.LOOPTROOP_CONFIG_DIR = previousConfigDir
  })

  function useConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-logscmd-'))
    tempDirs.push(dir)
    process.env.LOOPTROOP_CONFIG_DIR = dir
    mkdirSync(getDaemonLogDir(dir), { recursive: true })
    return dir
  }

  function captureStdout(): { text: () => string } {
    let captured = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    })
    return { text: () => captured }
  }

  function captureStderr(): { text: () => string } {
    let captured = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    })
    return { text: () => captured }
  }

  it('reports a missing log rather than failing silently', async () => {
    useConfigDir()
    const stderr = captureStderr()

    const code = await logsCommand({ follow: false })

    expect(code).toBe(1)
    expect(stderr.text()).toContain('No log file yet')
  })

  it('prints the log contents', async () => {
    const configDir = useConfigDir()
    writeFileSync(getDaemonLogPath(configDir), 'first line\nsecond line\n')
    const stdout = captureStdout()

    const code = await logsCommand({ follow: false })

    expect(code).toBe(0)
    expect(stdout.text()).toContain('first line')
    expect(stdout.text()).toContain('second line')
  })

  it('shows only the requested number of trailing lines', async () => {
    const configDir = useConfigDir()
    const logPath = getDaemonLogPath(configDir)
    for (let index = 1; index <= 100; index += 1) {
      appendFileSync(logPath, `line ${index}\n`)
    }
    const stdout = captureStdout()

    await logsCommand({ follow: false, lines: 3 })

    const text = stdout.text()
    expect(text).toContain('line 100')
    expect(text).toContain('line 98')
    expect(text).not.toContain('line 97')
  })

  it('ignores a nonsensical line count instead of printing nothing', async () => {
    const configDir = useConfigDir()
    writeFileSync(getDaemonLogPath(configDir), 'only line\n')
    const stdout = captureStdout()

    await logsCommand({ follow: false, lines: 0 })

    expect(stdout.text()).toContain('only line')
  })
})
