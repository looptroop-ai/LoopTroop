import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserOpener, openCommand } from '../server/cli/commands'
import { getDaemonStatePath, type DaemonState } from '../server/lib/daemonPaths'

/**
 * `open` starts the daemon when it is not running, so the interface is one
 * command away rather than two.
 *
 * The branch where it actually spawns a daemon is not exercised here: that
 * would run the real daemon, which needs OpenCode and a port. It is proven
 * end-to-end in `scripts/smoke-install.mjs`, against the installed shim. What
 * these cover is the decision — start or don't — and the credential handling
 * around it.
 */
describe('opening the interface', () => {
  const tempDirs: string[] = []
  const servers: Server[] = []
  const children: ChildProcess[] = []
  const originalConfigDir = process.env.LOOPTROOP_CONFIG_DIR

  afterEach(async () => {
    for (const child of children.splice(0)) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    for (const server of servers.splice(0)) {
      await new Promise<void>((done) => server.close(() => done()))
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    if (originalConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
    else process.env.LOOPTROOP_CONFIG_DIR = originalConfigDir
  })

  /** `openCommand` resolves its own config dir, so the env var is the seam. */
  function useConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-open-'))
    tempDirs.push(dir)
    process.env.LOOPTROOP_CONFIG_DIR = dir
    return dir
  }

  /** A process that outlives the call, so the recorded pid is genuinely alive. */
  function spawnStandIn(): number {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    children.push(child)
    return child.pid ?? 0
  }

  async function startFakeDaemon(options: {
    instanceId: string
    apiToken: string
    /** When false, minting a sign-in nonce fails the way a wedged daemon would. */
    mintsNonce?: boolean
    /**
     * Whether the minted nonce is reported as still waiting to be spent — which
     * is what a browser that never arrived looks like from the CLI.
     */
    staysPending?: boolean
  }): Promise<number> {
    const server = createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', instanceId: options.instanceId }))
        return
      }

      if (req.url === '/api/auth/bootstrap/status' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${options.apiToken}`) {
          res.writeHead(401).end('{}')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ pending: options.staysPending === true }))
        return
      }

      if (req.url === '/api/auth/bootstrap' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${options.apiToken}`) {
          res.writeHead(401).end('{}')
          return
        }
        if (options.mintsNonce === false) {
          res.writeHead(500).end('{}')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ nonce: 'nonce-under-test' }))
        return
      }

      res.writeHead(404).end()
    })
    servers.push(server)

    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    return (server.address() as { port: number }).port
  }

  function writeState(configDir: string, state: DaemonState): void {
    writeFileSync(getDaemonStatePath(configDir), JSON.stringify(state))
  }

  function makeState(overrides: Partial<DaemonState> & { pid: number; port: number }): DaemonState {
    return {
      instanceId: 'instance-under-test',
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
      version: '0.0.0-test',
      apiToken: 'test-api-token',
      ...overrides,
    }
  }

  it('opens a running daemon without starting a second one', async () => {
    const configDir = useConfigDir()
    const pid = spawnStandIn()
    const port = await startFakeDaemon({ instanceId: 'instance-under-test', apiToken: 'test-api-token' })
    writeState(configDir, makeState({ pid, port }))

    const opened: string[] = []
    const code = await openCommand({
      open: (url) => { opened.push(url); return { opened: true } },
    })

    expect(code).toBe(0)
    expect(opened).toHaveLength(1)
    // The nonce travels in the fragment, so it never reaches an access log.
    expect(opened[0]).toBe(`http://127.0.0.1:${port}/#bootstrap=nonce-under-test`)
  })

  it('explains that all-log mode needs a restart when the daemon is already running', async () => {
    const configDir = useConfigDir()
    const pid = spawnStandIn()
    const port = await startFakeDaemon({ instanceId: 'instance-under-test', apiToken: 'test-api-token' })
    writeState(configDir, makeState({ pid, port }))
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const code = await openCommand({ open: () => ({ opened: true }), opencodeLogs: 'all' })

    expect(code).toBe(0)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Run `looptroop stop`, then start it again'))
    stderr.mockRestore()
  })

  it('fails without opening a browser when the daemon will not mint a link', async () => {
    const configDir = useConfigDir()
    const pid = spawnStandIn()
    const port = await startFakeDaemon({
      instanceId: 'instance-under-test',
      apiToken: 'test-api-token',
      mintsNonce: false,
    })
    writeState(configDir, makeState({ pid, port }))

    const opened: string[] = []
    const code = await openCommand({
      open: (url) => { opened.push(url); return { opened: true } },
    })

    // A browser pointed at an unauthenticated origin would 401 on every
    // request, which reads as a broken app rather than a missing credential.
    expect(code).toBe(1)
    expect(opened).toEqual([])
  })

  /** stdout is the thing under test in the cases below. */
  function captureStdout(): { text: () => string; restore: () => void } {
    const original = process.stdout.write.bind(process.stdout)
    let text = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    }) as typeof process.stdout.write
    return { text: () => text, restore: () => { process.stdout.write = original } }
  }

  it('prints the sign-in link when no browser could be opened', async () => {
    const configDir = useConfigDir()
    const pid = spawnStandIn()
    const port = await startFakeDaemon({ instanceId: 'instance-under-test', apiToken: 'test-api-token' })
    writeState(configDir, makeState({ pid, port }))

    const stdout = captureStdout()
    let code: number
    try {
      code = await openCommand({
        open: () => ({ opened: false, reason: 'no application is associated with http' }),
      })
    } finally {
      stdout.restore()
    }

    // The whole point: a machine with no browser must still be able to get in.
    expect(code).toBe(0)
    expect(stdout.text()).toContain(`http://127.0.0.1:${port}/#bootstrap=nonce-under-test`)
    expect(stdout.text()).toContain('no application is associated with http')
  })

  it('prints the sign-in link when a browser opened and never signed in', async () => {
    const configDir = useConfigDir()
    const pid = spawnStandIn()
    const port = await startFakeDaemon({
      instanceId: 'instance-under-test',
      apiToken: 'test-api-token',
      staysPending: true,
    })
    writeState(configDir, makeState({ pid, port }))

    const stdout = captureStdout()
    let code: number
    try {
      code = await openCommand({ open: () => ({ opened: true }), waitMs: 400 })
    } finally {
      stdout.restore()
    }

    // Launching a browser is fire-and-forget, so "it exited 0" is not the same
    // as "someone is looking at LoopTroop".
    expect(code).toBe(0)
    expect(stdout.text()).toContain(`http://127.0.0.1:${port}/#bootstrap=nonce-under-test`)
  })

  it('keeps the nonce out of the terminal when the browser did sign in', async () => {
    const configDir = useConfigDir()
    const pid = spawnStandIn()
    const port = await startFakeDaemon({ instanceId: 'instance-under-test', apiToken: 'test-api-token' })
    writeState(configDir, makeState({ pid, port }))

    const stdout = captureStdout()
    let code: number
    try {
      code = await openCommand({ open: () => ({ opened: true }), waitMs: 2_000 })
    } finally {
      stdout.restore()
    }

    expect(code).toBe(0)
    expect(stdout.text()).toBe(`Opened http://127.0.0.1:${port}\n`)
    expect(stdout.text()).not.toContain('bootstrap=')
  })

  it('prints the link and opens nothing with --print-url', async () => {
    const configDir = useConfigDir()
    const pid = spawnStandIn()
    const port = await startFakeDaemon({ instanceId: 'instance-under-test', apiToken: 'test-api-token' })
    writeState(configDir, makeState({ pid, port }))

    const opened: string[] = []
    const stdout = captureStdout()
    let code: number
    try {
      code = await openCommand({
        open: (url) => { opened.push(url); return { opened: true } },
        printUrl: true,
      })
    } finally {
      stdout.restore()
    }

    expect(code).toBe(0)
    expect(opened).toEqual([])
    expect(stdout.text()).toContain(`http://127.0.0.1:${port}/#bootstrap=nonce-under-test`)
  })

  describe('the command that opens a URL', () => {
    it('gives Windows start an empty title so the URL is not taken for one', () => {
      const { command, args } = browserOpener('http://127.0.0.1:3000/#bootstrap=abc', 'win32')

      expect(command).toBe('cmd')
      expect(args).toEqual(['/c', 'start', '', 'http://127.0.0.1:3000/#bootstrap=abc'])
    })

    it('hands the URL straight to the opener everywhere else', () => {
      expect(browserOpener('http://x/#bootstrap=abc', 'darwin'))
        .toEqual({ command: 'open', args: ['http://x/#bootstrap=abc'] })
      expect(browserOpener('http://x/#bootstrap=abc', 'linux'))
        .toEqual({ command: 'xdg-open', args: ['http://x/#bootstrap=abc'] })
    })
  })
})
