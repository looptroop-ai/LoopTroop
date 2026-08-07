import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 2.1 contract: importing the runtime module and constructing a runtime must not
 * create files, timers, signal handlers, sockets, or child processes. A global
 * install runs `looptroop --version` through this module, so any import-time side
 * effect turns a metadata command into a server boot.
 */
describe('createRuntime side-effect freedom', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-runtime-'))
    tempDirs.push(dir)
    return dir
  }

  it('writes nothing to the config directory on import or construction', async () => {
    const configDir = makeConfigDir()
    const previous = process.env.LOOPTROOP_CONFIG_DIR
    process.env.LOOPTROOP_CONFIG_DIR = configDir

    try {
      const { createRuntime } = await import('../server/createRuntime')
      const runtime = createRuntime({ skipStartupSequence: true })

      expect(runtime.app).toBeDefined()
      expect(runtime.address).toBeNull()
      expect(existsSync(configDir)).toBe(true)
      expect(readdirSync(configDir)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
      else process.env.LOOPTROOP_CONFIG_DIR = previous
    }
  })

  it('installs no signal handlers', async () => {
    const before = {
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGINT: process.listenerCount('SIGINT'),
    }

    const { createRuntime } = await import('../server/createRuntime')
    createRuntime({ skipStartupSequence: true })

    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM)
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT)
  })

  it('starts no timer until start() runs', async () => {
    const { broadcaster } = await import('../server/sse/broadcaster')
    const { createRuntime } = await import('../server/createRuntime')

    createRuntime({ skipStartupSequence: true })

    // A live interval keeps its handle on the broadcaster; construction must not set one.
    expect(Reflect.get(broadcaster, 'cleanupInterval')).toBeNull()
  })

  it('binds no socket until start() runs, then reports the real port', async () => {
    const configDir = makeConfigDir()
    const previous = process.env.LOOPTROOP_CONFIG_DIR
    process.env.LOOPTROOP_CONFIG_DIR = configDir

    try {
      const { createRuntime } = await import('../server/createRuntime')
      const runtime = createRuntime({ skipStartupSequence: true, port: 0, hostname: '127.0.0.1' })

      expect(runtime.address).toBeNull()

      const address = await runtime.start()
      try {
        expect(address.port).toBeGreaterThan(0)
        expect(address.hostname).toBe('127.0.0.1')
        expect(runtime.address).toEqual(address)
      } finally {
        await runtime.close()
      }

      expect(runtime.address).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
      else process.env.LOOPTROOP_CONFIG_DIR = previous
    }
  })
})
