import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../server/test/tempDir'

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
      removeTempDir(dir)
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

/**
 * 2.5 contract: a port the user named must fail loudly when taken rather than
 * relocate somewhere they are not pointing at. Only the untouched default may
 * fall back to an OS-assigned port, so a first run never fails on a busy 3000.
 */
describe('createRuntime port allocation', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  async function occupyPort(): Promise<number> {
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
    return (server.address() as { port: number }).port
  }

  it('rejects with the requested port and its origin when an explicit port is taken', async () => {
    const taken = await occupyPort()
    const { createRuntime } = await import('../server/createRuntime')
    const { resolveSettings } = await import('../server/lib/appSettings')

    const runtime = createRuntime({
      skipStartupSequence: true,
      hostname: '127.0.0.1',
      settings: resolveSettings({ env: {}, file: { port: taken } }),
    })

    await expect(runtime.start()).rejects.toThrow(`Port ${taken} is already in use`)
    expect(runtime.address).toBeNull()
  })

  it('names config.json as the origin of an explicit port', async () => {
    const taken = await occupyPort()
    const { createRuntime } = await import('../server/createRuntime')
    const { resolveSettings } = await import('../server/lib/appSettings')

    const runtime = createRuntime({
      skipStartupSequence: true,
      hostname: '127.0.0.1',
      settings: resolveSettings({ env: {}, file: { port: taken } }),
    })

    await expect(runtime.start()).rejects.toThrow('config.json')
  })

  it('falls back to an OS-assigned port when only the default is taken', async () => {
    const taken = await occupyPort()
    const { createRuntime } = await import('../server/createRuntime')
    const { resolveSettings } = await import('../server/lib/appSettings')

    // A default-sourced port may relocate, so a first run never fails on a busy 3000.
    const settings = resolveSettings({ env: {}, file: {} })
    const runtime = createRuntime({
      skipStartupSequence: true,
      hostname: '127.0.0.1',
      settings: { ...settings, port: taken, portIsExplicit: false },
    })

    const address = await runtime.start()
    cleanups.push(() => runtime.close())

    expect(address.port).toBeGreaterThan(0)
    expect(address.port).not.toBe(taken)
  })
})
