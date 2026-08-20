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
    profile: { ignoreMode: 'repo' | 'local' | 'skip' } | null
    nonce: string
    /** Overrides the reply to GET /api/projects, for a daemon that is unwell. */
    listFailure: number | null
    /** Overrides the reply to POST /api/projects. */
    createFailure: { status: number; message: string } | null
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
      profile: { ignoreMode: 'local' },
      nonce: 'nonce-value-that-must-not-be-printed',
      listFailure: null,
      createFailure: null,
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
        if (daemon.listFailure !== null) {
          reply(daemon.listFailure, { error: 'Internal error' })
          return
        }
        reply(200, daemon.attached)
        return
      }
      if (url.pathname === '/api/projects/check-git') {
        reply(200, daemon.gitCheck)
        return
      }
      if (url.pathname === '/api/profile') {
        reply(200, daemon.profile)
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
          if (daemon.createFailure) {
            reply(daemon.createFailure.status, { message: daemon.createFailure.message })
            return
          }
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
      open: () => ({ opened: true }),
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
      open: () => ({ opened: true }),
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
      open: () => ({ opened: true }),
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
      open: (url) => { opened.push(url); return { opened: true } },
    })

    expect(daemon.created[0]).toMatchObject({ folderPath: '/repos/demo', ignoreMode: 'local' })
    expect(opened).toHaveLength(1)
  })

  it('uses the configured folder-ignore default for an unanswered choice', async () => {
    const daemon = await startFakeDaemon()
    daemon.profile = { ignoreMode: 'repo' }
    const { prompt } = scripted(['y', '/repos/demo', '', '', '', 'n'])

    await setupCommand({
      configDir: daemon.configDir,
      cwd: '/repos/demo',
      prompt,
      out: capture().out,
      open: () => undefined,
    })

    expect(daemon.created[0]).toMatchObject({ ignoreMode: 'repo' })
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
      open: (url) => { opened.push(url); return { opened: true } },
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
      open: () => ({ opened: true }),
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

  /**
   * The exit code, which used to be 0 no matter what happened.
   *
   * `looptroop setup --yes` in a provisioning script read as a clean run when
   * the daemon had failed to start, when the daemon would not answer its own
   * API, and when the repository was rejected — so the next command in the
   * script ran against nothing. The distinction that matters is asked-for and
   * failed versus declined: declining is the documented way to use this
   * command, and must stay a success.
   */
  describe('what the exit code says happened', () => {
    it('fails when the daemon will not answer for its own projects', async () => {
      const daemon = await startFakeDaemon()
      daemon.listFailure = 500
      const output = capture()
      const { prompt } = scripted(['n'])

      const code = await setupCommand({
        configDir: daemon.configDir,
        cwd: '/repos/demo',
        prompt,
        out: output.out,
        open: () => ({ opened: true }),
      })

      expect(code).toBe(1)
      // Named, so a non-zero exit is never a mystery in a CI log.
      expect(output.text()).toContain('project list could not be read')
    })

    it('fails when the repository the user named was rejected', async () => {
      const daemon = await startFakeDaemon()
      daemon.gitCheck = { status: 'invalid', message: 'Not a git repository.' }
      const output = capture()
      const { prompt } = scripted(['y', '/repos/not-a-repo', 'n'])

      const code = await setupCommand({
        configDir: daemon.configDir,
        cwd: '/repos/not-a-repo',
        prompt,
        out: output.out,
        open: () => ({ opened: true }),
      })

      expect(code).toBe(1)
      expect(output.text()).toContain('/repos/not-a-repo could not be attached')
    })

    it('fails when the attach request is refused', async () => {
      const daemon = await startFakeDaemon()
      daemon.createFailure = { status: 409, message: 'That shortname is taken.' }
      const output = capture()
      const { prompt } = scripted(['y', '/repos/demo', 'Demo App', 'DEMO', '1', 'n'])

      const code = await setupCommand({
        configDir: daemon.configDir,
        cwd: '/repos/demo',
        prompt,
        out: output.out,
        open: () => ({ opened: true }),
      })

      expect(code).toBe(1)
      expect(output.text()).toContain('That shortname is taken.')
    })

    it('fails when a running daemon will not hand out a sign-in link', async () => {
      const daemon = await startFakeDaemon()
      // A daemon that mints nothing leaves no way into the interface at all.
      daemon.nonce = ''
      const output = capture()
      const { prompt } = scripted(['n', 'y'])

      const code = await setupCommand({
        configDir: daemon.configDir,
        cwd: '/repos/demo',
        prompt,
        out: output.out,
        open: () => { throw new Error('there is no link to open') },
      })

      expect(code).toBe(1)
      expect(output.text()).toContain('no sign-in link')
    })

    it('succeeds when the user declines everything, which is not a failure', async () => {
      const daemon = await startFakeDaemon()
      const output = capture()
      const { prompt } = scripted(['n', 'n'])

      const code = await setupCommand({
        configDir: daemon.configDir,
        cwd: '/repos/demo',
        prompt,
        out: output.out,
        open: () => ({ opened: true }),
      })

      expect(code).toBe(0)
      expect(output.text()).not.toContain('did not finish')
    })
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
