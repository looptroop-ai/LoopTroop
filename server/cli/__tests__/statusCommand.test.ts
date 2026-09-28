import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mintBootstrapUrl,
  startCommand,
  statusCommand,
} from '../commands'
import {
  writeDaemonStartFailure,
  writeDaemonState,
  type DaemonState,
} from '../../lib/daemonPaths'
import { removeTempDir } from '../../test/tempDir'

describe('CLI daemon status', () => {
  const dirs: string[] = []
  const originalConfigDir = process.env.LOOPTROOP_CONFIG_DIR
  const originalFrontendPort = process.env.LOOPTROOP_FRONTEND_PORT
  let restoreStdout = (): void => {}

  afterEach(() => {
    restoreStdout()
    restoreStdout = () => {}
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (originalConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
    else process.env.LOOPTROOP_CONFIG_DIR = originalConfigDir
    if (originalFrontendPort === undefined) delete process.env.LOOPTROOP_FRONTEND_PORT
    else process.env.LOOPTROOP_FRONTEND_PORT = originalFrontendPort
    for (const dir of dirs.splice(0)) removeTempDir(dir)
  })

  function useConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-status-'))
    dirs.push(dir)
    process.env.LOOPTROOP_CONFIG_DIR = dir
    return dir
  }

  function captureStdout(): { text: () => string } {
    const original = process.stdout.write.bind(process.stdout)
    let text = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    }) as typeof process.stdout.write
    restoreStdout = () => { process.stdout.write = original }
    return { text: () => text }
  }

  function makeState(overrides: Partial<DaemonState> = {}): DaemonState {
    return {
      instanceId: 'status-instance',
      pid: process.pid,
      host: '127.0.0.1',
      port: 4317,
      startedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      version: '1.2.3',
      apiToken: 'secret-token',
      ...overrides,
    }
  }

  it('prints a non-running JSON status without a stored daemon', async () => {
    useConfigDir()
    const stdout = captureStdout()

    expect(await statusCommand(true)).toBe(1)
    expect(JSON.parse(stdout.text())).toMatchObject({
      running: false,
      daemon: null,
      notAnswering: null,
      shutdownPending: false,
      lastStartFailure: null,
    })
  })

  it('reports an answering daemon and removes its token from JSON', async () => {
    const configDir = useConfigDir()
    writeDaemonState(makeState(), configDir)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ instanceId: 'status-instance' }), { status: 200 }),
    ))
    const stdout = captureStdout()

    expect(await statusCommand(true)).toBe(0)
    const result = JSON.parse(stdout.text()) as { running: boolean; daemon: Record<string, unknown> }
    expect(result.running).toBe(true)
    expect(result.daemon).not.toHaveProperty('apiToken')
    expect(result.daemon).toMatchObject({ instanceId: 'status-instance', pid: process.pid })
  })

  it('prints human status for a running daemon, including long uptime', async () => {
    const configDir = useConfigDir()
    writeDaemonState(makeState({ opencode: { baseUrl: 'http://127.0.0.1:4096', owned: true } }), configDir)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ instanceId: 'status-instance' }), { status: 200 }),
    ))
    const stdout = captureStdout()

    expect(await statusCommand(false)).toBe(0)
    expect(stdout.text()).toContain('LoopTroop is running.')
    expect(stdout.text()).toContain('1h 30m')
    expect(stdout.text()).toContain('http://127.0.0.1:4096 (started by LoopTroop)')
  })

  it('explains a retained shutdown when its daemon process is gone', async () => {
    const configDir = useConfigDir()
    writeDaemonState(makeState({ pid: 2_000_000_000, shutdownPending: true }), configDir)
    const stdout = captureStdout()

    expect(await statusCommand(false)).toBe(1)
    expect(stdout.text()).toContain('A previous daemon shutdown retained ownership')
    expect(stdout.text()).toContain('Run `looptroop stop` again before starting.')
  })

  it('reports both supported reasons a previous start was refused', async () => {
    const configDir = useConfigDir()
    const stdout = captureStdout()
    writeDaemonStartFailure({
      reason: 'schema-incompatible',
      at: '2026-09-27T00:00:00.000Z',
      version: '1.2.3',
      message: 'Database needs an upgrade.',
      schema: { databaseLabel: 'app', databasePath: '/tmp/app.sqlite', found: 1, expected: 2, migratableFrom: 1 },
    }, configDir)

    expect(await statusCommand(false)).toBe(1)
    expect(stdout.text()).toContain('Database needs an upgrade.')
    expect(stdout.text()).toContain('looptroop doctor')

    writeDaemonStartFailure({
      reason: 'startup-cleanup-incomplete',
      at: '2026-09-27T00:00:00.000Z',
      version: '1.2.3',
      message: 'OpenCode shutdown could not be verified.',
      openCode: { baseUrl: 'http://127.0.0.1:4096', pid: 9876 },
    }, configDir)
    expect(await statusCommand(false)).toBe(1)
    expect(stdout.text()).toContain('previous startup still owns OpenCode')
    expect(stdout.text()).toContain('pid 9876')
  })

  it('reports a live process that no longer answers instead of calling it stopped', async () => {
    const configDir = useConfigDir()
    writeDaemonState(makeState(), configDir)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    const stdout = captureStdout()

    expect(await statusCommand(false)).toBe(1)
    expect(stdout.text()).toContain(`LoopTroop is not answering, but pid ${process.pid} is still running`)
    expect(stdout.text()).toContain('Run `looptroop stop`')
  })

  it('keeps start idempotent when the recorded daemon is answering', async () => {
    const configDir = useConfigDir()
    writeDaemonState(makeState(), configDir)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ instanceId: 'status-instance' }), { status: 200 }),
    ))
    const stdout = captureStdout()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(await startCommand({ opencodeLogs: 'all' })).toBe(0)
    expect(stdout.text()).toContain('LoopTroop is already running')
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('only applies when LoopTroop starts the daemon'))
  })

  it('refuses start while the previous startup still owns OpenCode', async () => {
    const configDir = useConfigDir()
    writeDaemonStartFailure({
      reason: 'startup-cleanup-incomplete',
      at: '2026-09-27T00:00:00.000Z',
      version: '1.2.3',
      message: 'OpenCode cleanup could not be verified.',
      openCode: { baseUrl: 'http://127.0.0.1:4096', pid: 9876 },
    }, configDir)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(await startCommand()).toBe(1)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('previous startup still owns OpenCode'))
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('pid 9876'))
  })
})

describe('minting browser sign-in links', () => {
  const state: DaemonState = {
    instanceId: 'status-instance',
    pid: process.pid,
    host: '127.0.0.1',
    port: 4317,
    startedAt: new Date().toISOString(),
    version: '1.2.3',
    apiToken: 'secret-token',
  }

  afterEach(() => vi.unstubAllGlobals())

  it('puts the one-time nonce in the URL fragment', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ nonce: 'nonce-value' }), { status: 200 }),
    ))

    await expect(mintBootstrapUrl(state)).resolves.toEqual({
      url: 'http://127.0.0.1:4317/#bootstrap=nonce-value',
      nonce: 'nonce-value',
    })
  })

  it.each([
    ['non-OK response', () => Promise.resolve(new Response('{}', { status: 503 }))],
    ['empty nonce', () => Promise.resolve(new Response(JSON.stringify({ nonce: '' }), { status: 200 }))],
    ['wrong nonce type', () => Promise.resolve(new Response(JSON.stringify({ nonce: 12 }), { status: 200 }))],
    ['network error', () => Promise.reject(new Error('offline'))],
  ])('returns null for a %s', async (_label, respond) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(respond))
    await expect(mintBootstrapUrl(state)).resolves.toBeNull()
  })
})
