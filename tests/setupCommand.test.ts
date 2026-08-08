import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDaemonStatePath, type DaemonState } from '../server/lib/daemonPaths'
import { setupCommand, suggestShortname, type SetupPrompt } from '../server/cli/setupCommand'

/**
 * 2.14 contract: setup walks a fresh install through what it cannot infer, and
 * every step can be declined. Re-running it is the normal case — a second
 * project, a second machine, a half-finished first attempt — so it must never
 * duplicate or overwrite what a previous run established.
 */
describe('setup command', () => {
  const tempDirs: string[] = []
  const servers: Server[] = []

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((done) => server.close(() => done()))
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  interface FakeDaemon {
    configDir: string
    attached: { name: string; shortname: string; folderPath: string }[]
    /** Bodies of every POST /api/projects this run made. */
    created: Record<string, unknown>[]
    gitCheck: { status: string; repoRoot?: string; message?: string }
    nonce: string
  }

  /**
   * A real HTTP daemon rather than a mocked fetch: the command's contract is
   * that it reaches the running daemon over the API with its bearer token, and
   * a stub would let a missing Authorization header pass unnoticed.
   */
  async function startFakeDaemon(): Promise<FakeDaemon> {
    const configDir = mkdtempSync(join(tmpdir(), 'looptroop-setup-'))
    tempDirs.push(configDir)

    const daemon: FakeDaemon = {
      configDir,
      attached: [],
      created: [],
      gitCheck: { status: 'valid', repoRoot: '/repos/demo' },
      nonce: 'nonce-value-that-must-not-be-printed',
    }
    const apiToken = 'token-for-the-fake-daemon'
    const instanceId = 'instance-under-test'

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const reply = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }

      if (url.pathname === '/api/health') {
        reply(200, { status: 'ok', instanceId })
        return
      }

      if (req.headers.authorization !== `Bearer ${apiToken}`) {
        reply(401, { error: 'Unauthorized' })
        return
      }

      if (url.pathname === '/api/projects' && req.method === 'GET') {
        reply(200, daemon.attached)
        return
      }
      if (url.pathname === '/api/projects/check-git') {
        reply(200, daemon.gitCheck)
        return
      }
      if (url.pathname === '/api/auth/bootstrap') {
        reply(200, { nonce: daemon.nonce })
        return
      }
      if (url.pathname === '/api/projects' && req.method === 'POST') {
        let raw = ''
        req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
        req.on('end', () => {
          const body = JSON.parse(raw) as Record<string, unknown>
          daemon.created.push(body)
          daemon.attached.push({
            name: String(body.name),
            shortname: String(body.shortname),
            folderPath: String(body.folderPath),
          })
          reply(201, body)
        })
        return
      }

      reply(404, { error: 'Not found' })
    })
    servers.push(server)
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))

    const state: DaemonState = {
      instanceId,
      // This process really is alive, so the liveness check passes and the
      // instance id then proves the state file describes the server above.
      pid: process.pid,
      port: (server.address() as { port: number }).port,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
      version: '0.0.0-test',
      apiToken,
    }
    writeFileSync(getDaemonStatePath(configDir), JSON.stringify(state))
    return daemon
  }

  /** Answers questions in order; anything unscripted takes its default. */
  function scripted(answers: string[]): { prompt: SetupPrompt; asked: string[] } {
    const asked: string[] = []
    let index = 0
    return {
      asked,
      prompt: async (question, fallback) => {
        asked.push(question)
        const answer = answers[index++]
        return answer === undefined || answer === '' ? fallback : answer
      },
    }
  }

  function capture(): { out: (text: string) => void; text: () => string } {
    let captured = ''
    return { out: (text) => { captured += text }, text: () => captured }
  }

  it('attaches the repository the user picks, with the ignore rule they chose', async () => {
    const daemon = await startFakeDaemon()
    const output = capture()
    const { prompt } = scripted(['y', '/repos/demo', 'Demo App', 'DEMO', '2', 'n'])

    const code = await setupCommand({
      configDir: daemon.configDir,
      cwd: '/repos/demo',
      prompt,
      out: output.out,
      open: () => { throw new Error('the browser step was declined') },
    })

    expect(code).toBe(0)
    expect(daemon.created).toEqual([{
      name: 'Demo App',
      shortname: 'DEMO',
      folderPath: '/repos/demo',
      ignoreMode: 'local',
    }])
    expect(output.text()).toContain('Attached Demo App (DEMO)')
  })

  it('attaches the repository root rather than the subfolder that was typed', async () => {
    const daemon = await startFakeDaemon()
    daemon.gitCheck = { status: 'valid', repoRoot: '/repos/demo' }
    const { prompt } = scripted(['y', '/repos/demo/server/lib', '', '', '1', 'n'])

    await setupCommand({
      configDir: daemon.configDir,
      cwd: '/tmp',
      prompt,
      out: capture().out,
      open: () => undefined,
    })

    // Attaching a subfolder would attach the same repository twice under two
    // names, which nothing downstream can reconcile.
    expect(daemon.created[0]).toMatchObject({ folderPath: '/repos/demo', name: 'demo', shortname: 'DEMO' })
  })

  it('reports an already-attached repository instead of attaching it again', async () => {
    const daemon = await startFakeDaemon()
    daemon.attached.push({ name: 'Demo App', shortname: 'DEMO', folderPath: '/repos/demo' })
    const output = capture()
    const { prompt } = scripted(['y', '/repos/demo', 'n'])

    await setupCommand({
      configDir: daemon.configDir,
      cwd: '/repos/demo',
      prompt,
      out: output.out,
      open: () => undefined,
    })

    expect(daemon.created).toHaveLength(0)
    expect(output.text()).toContain('Already attached as Demo App (DEMO)')
  })

  it('changes nothing when every step is declined', async () => {
    const daemon = await startFakeDaemon()
    const output = capture()
    const { prompt } = scripted(['n', 'n'])

    const code = await setupCommand({
      configDir: daemon.configDir,
      cwd: '/repos/demo',
      prompt,
      out: output.out,
      open: () => { throw new Error('the browser step was declined') },
    })

    expect(code).toBe(0)
    expect(daemon.created).toHaveLength(0)
    // The paths are the one step with nothing to decline, so they are still
    // reported: a user who skips everything still learns where their data is.
    expect(output.text()).toContain('Where things live')
  })

  it('explains a folder that cannot be attached, and attaches nothing', async () => {
    const daemon = await startFakeDaemon()
    daemon.gitCheck = { status: 'invalid', message: 'Git repository found, but origin must resolve to github.com.' }
    const output = capture()
    const { prompt } = scripted(['y', '/repos/not-github', 'n'])

    await setupCommand({
      configDir: daemon.configDir,
      cwd: '/repos/not-github',
      prompt,
      out: output.out,
      open: () => undefined,
    })

    expect(daemon.created).toHaveLength(0)
    expect(output.text()).toContain('origin must resolve to github.com')
    expect(output.text()).toContain('Nothing was attached')
  })

  it('reports rather than asks when there is no terminal to answer', async () => {
    const daemon = await startFakeDaemon()
    const output = capture()

    // Piped into a script or run from CI: a question here would hang forever.
    const code = await setupCommand({
      configDir: daemon.configDir,
      cwd: '/repos/demo',
      prompt: null,
      out: output.out,
      open: () => { throw new Error('nothing may be opened without an answer') },
    })

    expect(code).toBe(0)
    expect(daemon.created).toHaveLength(0)
    expect(output.text()).toContain('Nothing attached yet')
    expect(output.text()).toContain('Where things live')
  })

  it('takes every default under --yes', async () => {
    const daemon = await startFakeDaemon()
    const opened: string[] = []

    await setupCommand({
      configDir: daemon.configDir,
      cwd: '/repos/demo',
      yes: true,
      out: capture().out,
      open: (url) => opened.push(url),
    })

    expect(daemon.created[0]).toMatchObject({ folderPath: '/repos/demo', ignoreMode: 'repo' })
    expect(opened).toHaveLength(1)
  })

  it('opens the sign-in link without printing it', async () => {
    const daemon = await startFakeDaemon()
    const output = capture()
    const opened: string[] = []
    const { prompt } = scripted(['n', 'y'])

    await setupCommand({
      configDir: daemon.configDir,
      cwd: '/repos/demo',
      prompt,
      out: output.out,
      open: (url) => opened.push(url),
    })

    expect(opened[0]).toContain(`#bootstrap=${daemon.nonce}`)
    // The nonce buys a session. Terminal scrollback is pasted into issues.
    expect(output.text()).not.toContain(daemon.nonce)
    expect(output.text()).toContain('Opened http://127.0.0.1:')
  })

  it('names the settings file, the database and the log', async () => {
    const daemon = await startFakeDaemon()
    const output = capture()

    await setupCommand({
      configDir: daemon.configDir,
      cwd: '/repos/demo',
      prompt: null,
      out: output.out,
      open: () => undefined,
    })

    expect(output.text()).toContain(join(daemon.configDir, 'config.json'))
    expect(output.text()).toContain(join(daemon.configDir, 'app.sqlite'))
    expect(output.text()).toContain(join(daemon.configDir, 'logs', 'daemon.log'))
  })

  it('skips the daemon-dependent steps when nothing is running', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'looptroop-setup-'))
    tempDirs.push(configDir)
    const output = capture()

    const code = await setupCommand({
      configDir,
      cwd: '/repos/demo',
      prompt: null,
      out: output.out,
      open: () => { throw new Error('there is nothing to open') },
    })

    expect(code).toBe(0)
    expect(output.text()).toContain('Not running')
    expect(output.text()).toContain('needs a running daemon')
  })

  it.each([
    ['LoopTroop', 'LOOP'],
    ['my-api', 'MYAP'],
    ['x', 'XXX'],
    ['2048', '2048'],
  ])('suggests %s as %s', (name, expected) => {
    expect(suggestShortname(name)).toBe(expected)
  })
})
