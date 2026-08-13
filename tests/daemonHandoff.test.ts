import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolve } from 'node:path'

/**
 * How `start` re-invokes this program to become the daemon.
 *
 * The bug this replaces: `spawn(process.execPath, [resolve(moduleDir(),
 * 'daemonProcess.js')])`. Under npm that is `node <dir>/daemonProcess.js`,
 * which works only because npm unpacks a directory of files. Inside a
 * single-file build `process.execPath` is the executable and there is no second
 * file, so it re-invoked LoopTroop with a path that does not exist as its first
 * argument — `start` then waited out its readiness timeout and reported a
 * failure with no cause in the log.
 */
const seaMock = vi.hoisted(() => ({ value: false }))
vi.mock('../server/lib/isSea', () => ({ isSea: () => seaMock.value }))

const { DAEMON_ARGV, daemonArgv } = await import('../server/cli/daemonHandoff')

afterEach(() => {
  seaMock.value = false
})

describe('handing off to the daemon', () => {
  it('names the entry script as well as the argument under npm', () => {
    const argv = process.argv
    process.argv = ['/usr/bin/node', '/usr/local/lib/node_modules/looptroop/dist/server/cli/cli.js']

    try {
      expect(daemonArgv()).toEqual([
        resolve('/usr/local/lib/node_modules/looptroop/dist/server/cli/cli.js'),
        DAEMON_ARGV,
      ])
    } finally {
      process.argv = argv
    }
  })

  /**
   * In a single-file build `argv[1]` is the executable rather than a script, so
   * passing it along would run the binary against itself.
   */
  it('passes only the argument in a single-file build', () => {
    seaMock.value = true
    const argv = process.argv
    process.argv = ['/usr/local/bin/looptroop', '/usr/local/bin/looptroop']

    try {
      expect(daemonArgv()).toEqual([DAEMON_ARGV])
    } finally {
      process.argv = argv
    }
  })

  /** Whatever it is called and wherever it was installed. */
  it('follows the entry script rather than assuming a file name', () => {
    const argv = process.argv
    process.argv = ['/usr/bin/node', '/opt/elsewhere/looptroop-cli.mjs']

    try {
      expect(daemonArgv()[0]).toBe(resolve('/opt/elsewhere/looptroop-cli.mjs'))
    } finally {
      process.argv = argv
    }
  })

  it('refuses rather than spawning something meaningless when there is no entry script', () => {
    const argv = process.argv
    process.argv = ['/usr/bin/node']

    try {
      expect(() => daemonArgv()).toThrow(/no entry script/)
    } finally {
      process.argv = argv
    }
  })

  /** Never a real command, and never printed in the usage text. */
  it('uses an argument no user would type', () => {
    expect(DAEMON_ARGV).toBe('__daemon')
  })
})
