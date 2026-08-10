import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  cleanCommand,
  inspectOrphanedOpenCode,
  planWorktreeCleanup,
} from '../server/cli/cleanCommand'
import { initializeDatabase } from '../server/db/init'
import { sqlite } from '../server/db/index'
import { clearProjectDatabaseCache, getProjectDatabase } from '../server/db/project'
import { projects, tickets } from '../server/db/schema'
import { applyIgnoreMode } from '../server/git/repository'
import { getDaemonStatePath, type DaemonState } from '../server/lib/daemonPaths'
import { readProcessStartToken } from '../server/lib/processIdentity'
import { normalizeFolderPath } from '../server/storage/paths'
import { attachProject } from '../server/storage/projects'
import {
  ensureWorktreeOwnerMarker,
  getWorktreeOwnerMarkerPath,
} from '../server/storage/worktreeOwnership'

/** Runs TypeScript sources directly, so the first-run test needs no build. */
const TSX_BIN = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
const CLI_ENTRY = resolve(process.cwd(), 'server/cli/cli.ts')

/**
 * 2.17 contract: `clean` lists by default and acts only under --apply; it needs
 * a managed-ownership marker before it will delete anything; it refuses dirty,
 * unpushed and apparently-live worktrees; and it never signals a pid just
 * because an old JSON file names one.
 */
describe('clean command', () => {
  const tempDirs: string[] = []
  const children: ChildProcess[] = []

  /** A pid that is certainly nobody's, for records describing a dead daemon. */
  let departedPid = 0

  beforeEach(async () => {
    clearProjectDatabaseCache()
    initializeDatabase()
    sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
    departedPid = await makeDepartedPid()
  })

  afterEach(() => {
    for (const child of children.splice(0)) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    clearProjectDatabaseCache()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * Far enough ahead that every fixture reads as long idle, so the live-window
   * guard never has to be defeated by sleeping.
   */
  const LONG_AFTERWARDS = Date.now() + 60 * 60_000

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  }

  function makeTempDir(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `looptroop-clean-${label}-`))
    tempDirs.push(dir)
    return normalizeFolderPath(dir)
  }

  /**
   * A project repository with an "origin" it can push to, so the upstream checks
   * have something real to answer rather than being skipped, and with LoopTroop's
   * own ignore rules committed exactly as attaching a project writes them —
   * without those, `.ticket/` reads as untracked work in every worktree.
   */
  function makeProject(): string {
    const remote = makeTempDir('remote')
    git(remote, ['init', '--bare', '--initial-branch=main'])

    const root = makeTempDir('project')
    git(root, ['init', '--initial-branch=main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    writeFileSync(resolve(root, 'README.md'), '# project\n')
    applyIgnoreMode(root, 'repo')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'initial'])
    git(root, ['remote', 'add', 'origin', remote])
    git(root, ['push', '-u', 'origin', 'main'])
    return root
  }

  /** A real git worktree under the managed root, with its ownership marker. */
  function addWorktree(projectRoot: string, externalId: string): string {
    const worktreesRoot = resolve(projectRoot, '.looptroop', 'worktrees')
    mkdirSync(worktreesRoot, { recursive: true })
    const worktreePath = resolve(worktreesRoot, externalId)
    git(projectRoot, ['worktree', 'add', '-b', externalId, worktreePath, 'main'])
    mkdirSync(resolve(worktreePath, '.ticket', 'runtime'), { recursive: true })
    ensureWorktreeOwnerMarker(worktreePath, { projectRoot, externalId })
    return worktreePath
  }

  /**
   * The directory a daemon killed mid-setup leaves behind: LoopTroop made it and
   * vouched for it, but `git worktree add` never ran.
   */
  function addSkeleton(projectRoot: string, externalId: string): string {
    const worktreePath = resolve(projectRoot, '.looptroop', 'worktrees', externalId)
    mkdirSync(resolve(worktreePath, '.ticket', 'runtime'), { recursive: true })
    ensureWorktreeOwnerMarker(worktreePath, { projectRoot, externalId })
    return worktreePath
  }

  /** Strips the admin directory, leaving a checkout git can no longer speak for. */
  function unregister(projectRoot: string, externalId: string): void {
    rmSync(resolve(projectRoot, '.git', 'worktrees', externalId), { recursive: true, force: true })
  }

  /**
   * Ages every timestamp the live-window guard consults, for the tests that run
   * the real command and so cannot pass it a clock.
   */
  function backdate(worktreePath: string): void {
    const old = new Date(Date.now() - 24 * 60 * 60_000)
    const markerPath = getWorktreeOwnerMarkerPath(worktreePath)
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>
      writeFileSync(markerPath, JSON.stringify({ ...marker, createdAt: old.toISOString() }))
    }
    // Newest first: writing the marker above touched the directory holding it.
    for (const path of [
      resolve(worktreePath, '.ticket', 'runtime'),
      resolve(worktreePath, '.ticket'),
      worktreePath,
    ]) {
      if (existsSync(path)) utimesSync(path, old, old)
    }
  }

  function planFor(projectRoot: string, closedTicketIds: string[] = []) {
    return planWorktreeCleanup([{ projectRoot, closedTicketIds }], { now: LONG_AFTERWARDS })
  }

  describe('what it will delete', () => {
    it('removes a worktree whose ticket is finished, even though git still lists it', () => {
      const project = makeProject()
      const worktree = addWorktree(project, 'ticket-done')
      git(worktree, ['push', '-u', 'origin', 'ticket-done'])

      // Registration alone keeps it: only the ticket's terminal status makes it
      // debris a dead daemon never got to clear.
      expect(planFor(project)).toEqual([])
      expect(planFor(project, ['ticket-done'])).toMatchObject([{ path: worktree, removable: true }])
    })

    it('removes a skeleton whose worktree was never created', () => {
      const project = makeProject()
      const worktree = addSkeleton(project, 'ticket-stillborn')

      expect(planFor(project)).toMatchObject([
        { path: worktree, removable: true, reason: 'not registered with git' },
      ])
    })

    it('leaves a live registered worktree out of the plan entirely', () => {
      const project = makeProject()
      addWorktree(project, 'ticket-live')

      expect(planFor(project)).toEqual([])
    })
  })

  describe('what it refuses to delete', () => {
    it('refuses a directory with no ownership marker', () => {
      const project = makeProject()
      const worktree = addSkeleton(project, 'ticket-unmarked')
      // Every worktree created before this check existed looks like this.
      rmSync(getWorktreeOwnerMarkerPath(worktree), { force: true })

      expect(planFor(project)).toMatchObject([
        { path: worktree, removable: false, reason: 'no LoopTroop ownership marker' },
      ])
    })

    it('refuses a marker that vouches for a different directory', () => {
      const project = makeProject()
      const worktree = addSkeleton(project, 'ticket-mismarked')
      // A marker copied in from elsewhere authorises nothing.
      writeFileSync(getWorktreeOwnerMarkerPath(worktree), JSON.stringify({
        kind: 'looptroop-worktree',
        projectRoot: project,
        externalId: 'some-other-ticket',
        createdAt: new Date(0).toISOString(),
      }))

      const [candidate] = planFor(project)
      expect(candidate?.removable).toBe(false)
      expect(candidate?.reason).toContain('different worktree')
    })

    it('refuses a marker naming another project', () => {
      const project = makeProject()
      const elsewhere = makeProject()
      const worktree = addSkeleton(project, 'ticket-foreign')
      writeFileSync(getWorktreeOwnerMarkerPath(worktree), JSON.stringify({
        kind: 'looptroop-worktree',
        projectRoot: elsewhere,
        externalId: 'ticket-foreign',
        createdAt: new Date(0).toISOString(),
      }))

      expect(planFor(project)[0]?.removable).toBe(false)
    })

    it('refuses a worktree with uncommitted changes', () => {
      const project = makeProject()
      const worktree = addWorktree(project, 'ticket-dirty')
      git(worktree, ['push', '-u', 'origin', 'ticket-dirty'])
      writeFileSync(resolve(worktree, 'work-in-progress.txt'), 'not saved anywhere else\n')

      const [candidate] = planFor(project, ['ticket-dirty'])
      expect(candidate?.removable).toBe(false)
      expect(candidate?.reason).toContain('uncommitted')
    })

    it('refuses a worktree with unpushed commits', () => {
      const project = makeProject()
      const worktree = addWorktree(project, 'ticket-ahead')
      git(worktree, ['push', '-u', 'origin', 'ticket-ahead'])
      writeFileSync(resolve(worktree, 'work.txt'), 'committed but only here\n')
      git(worktree, ['add', '.'])
      git(worktree, ['commit', '-m', 'local work'])

      const [candidate] = planFor(project, ['ticket-ahead'])
      expect(candidate?.removable).toBe(false)
      expect(candidate?.reason).toContain('unpushed')
    })

    it('refuses a branch that was never pushed anywhere', () => {
      const project = makeProject()
      addWorktree(project, 'ticket-local-only')

      const [candidate] = planFor(project, ['ticket-local-only'])
      expect(candidate?.removable).toBe(false)
      expect(candidate?.reason).toContain('upstream')
    })

    it('refuses a checkout git can no longer speak for', () => {
      const project = makeProject()
      const worktree = addWorktree(project, 'ticket-detached')
      git(worktree, ['push', '-u', 'origin', 'ticket-detached'])
      // Without its admin directory nothing can be asked about this checkout —
      // not its status, not its upstream — so it is never safe to delete, however
      // certainly it was pushed a moment ago.
      unregister(project, 'ticket-detached')

      const [candidate] = planFor(project)
      expect(candidate?.removable).toBe(false)
      expect(candidate?.reason).toContain('files of its own')
    })

    it('refuses a directory that only just appeared', () => {
      const project = makeProject()
      addSkeleton(project, 'ticket-newborn')

      // A worktree exists on disk before `git worktree add` registers it, so a
      // clean racing a start must not mistake one being born for one abandoned.
      const [candidate] = planWorktreeCleanup([{ projectRoot: project }])
      expect(candidate?.removable).toBe(false)
      expect(candidate?.reason).toContain('may still be in use')
    })

    it('refuses a non-worktree directory that holds files of its own', () => {
      const project = makeProject()
      const worktree = addSkeleton(project, 'ticket-occupied')
      writeFileSync(resolve(worktree, 'someones-notes.txt'), 'no history to check this against\n')

      const [candidate] = planFor(project)
      expect(candidate?.removable).toBe(false)
      expect(candidate?.reason).toContain('files of its own')
    })

    it('does not judge a directory by the state of the project around it', () => {
      const project = makeProject()
      // The project itself is dirty. A skeleton inside it is still just a
      // skeleton — but git run from inside one answers about the project, so
      // without anchoring, this project's mess would protect its debris.
      writeFileSync(resolve(project, 'project-scratch.txt'), 'dirty project\n')
      const worktree = addSkeleton(project, 'ticket-inside-a-mess')

      expect(planFor(project)).toMatchObject([{ path: worktree, removable: true }])
    })

    it('ignores a file sitting in the worktrees root', () => {
      const project = makeProject()
      const worktreesRoot = resolve(project, '.looptroop', 'worktrees')
      mkdirSync(worktreesRoot, { recursive: true })
      writeFileSync(resolve(worktreesRoot, 'stray.log'), 'not a worktree\n')

      expect(planFor(project)).toEqual([])
    })

    it('survives a worktrees root that does not exist', () => {
      expect(planFor(makeProject())).toEqual([])
    })
  })

  describe('applying the plan', () => {
    it('deletes nothing without --apply', async () => {
      const project = makeProject()
      const worktree = addSkeleton(project, 'ticket-listed')
      backdate(worktree)
      attach(project)

      const output = await runClean({ apply: false, configDir: makeTempDir('config') })

      expect(output).toContain('would remove')
      expect(existsSync(worktree)).toBe(true)
    })

    it('explains why an unmarked worktree was left alone', async () => {
      const project = makeProject()
      const worktree = addSkeleton(project, 'ticket-unowned')
      rmSync(getWorktreeOwnerMarkerPath(worktree), { force: true })
      backdate(worktree)
      attach(project)

      const output = await runClean({ apply: false, configDir: makeTempDir('config') })

      expect(output).toContain('no LoopTroop ownership marker')
      expect(output).toContain('Remove them by hand')
    })

    it('deletes the removable ones under --apply and keeps the rest', async () => {
      const project = makeProject()
      const project2 = attach(project)

      const doomed = addWorktree(project, 'ticket-finished')
      git(doomed, ['push', '-u', 'origin', 'ticket-finished'])
      finishTicket(project, project2, 'ticket-finished')
      backdate(doomed)

      const spared = addWorktree(project, 'ticket-unsaved')
      git(spared, ['push', '-u', 'origin', 'ticket-unsaved'])
      writeFileSync(resolve(spared, 'unsaved.txt'), 'work\n')
      finishTicket(project, project2, 'ticket-unsaved')
      backdate(spared)

      const output = await runClean({ apply: true, configDir: makeTempDir('config') })

      expect(output).toContain('Removed 1 worktree(s)')
      expect(existsSync(doomed)).toBe(false)
      expect(existsSync(spared)).toBe(true)
      // Removed through git, not by deleting the directory behind its back.
      expect(git(project, ['worktree', 'list', '--porcelain'])).not.toContain('ticket-finished')
    })

    /**
     * Runs the real CLI in its own process, because the contract is about a
     * machine where nothing has ever booted: this test's own process has already
     * created and migrated a database, so it cannot observe a first run.
     */
    it('works on a machine where LoopTroop has never started', () => {
      const configDir = makeTempDir('fresh')
      const run = (): { stdout: string, code: number } => {
        try {
          return {
            stdout: execFileSync(process.execPath, [TSX_BIN, CLI_ENTRY, 'clean'], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, LOOPTROOP_CONFIG_DIR: configDir },
            }),
            code: 0,
          }
        } catch (error) {
          const failure = error as { status?: number, stdout?: string, stderr?: string }
          return { stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, code: failure.status ?? 1 }
        }
      }

      const { stdout, code } = run()

      expect(code).toBe(0)
      expect(stdout).toContain('Nothing to clean')
      // Nor may it leave one behind: a diagnostic that creates the database it
      // was asked to inspect has changed the machine it was reporting on.
      expect(existsSync(resolve(configDir, 'app.sqlite'))).toBe(false)
    })

    it('refuses to run while a LoopTroop process is still alive', async () => {
      const project = makeProject()
      const worktree = addSkeleton(project, 'ticket-guarded')
      backdate(worktree)
      attach(project)

      const configDir = makeTempDir('config')
      // A daemon that is alive but not answering: `readRunningDaemon` reports
      // nothing for it, and cleanup must still keep its hands off.
      writeState(configDir, { pid: spawnStandIn(), port: 1 })

      const { code, output } = await captureClean({ apply: true, configDir })

      expect(code).toBe(1)
      expect(output).toContain('still alive')
      expect(existsSync(worktree)).toBe(true)
    })
  })

  describe('an OpenCode server the daemon left behind', () => {
    it('offers to stop one whose recorded identity still matches', () => {
      const configDir = makeTempDir('config')
      const pid = spawnStandIn()
      writeState(configDir, {
        pid: departedPid,
        opencode: { baseUrl: 'http://127.0.0.1:4096', owned: true, pid, startToken: tokenFor(pid) },
      })

      expect(inspectOrphanedOpenCode(configDir)).toEqual({ kind: 'stoppable', pid })
    })

    it('never signals a pid the record cannot prove', () => {
      const configDir = makeTempDir('config')
      const pid = spawnStandIn()
      // The daemon that wrote this predates start tokens, so the number in it is
      // all there is — and a number is not an identity.
      writeState(configDir, {
        pid: departedPid,
        opencode: { baseUrl: 'http://127.0.0.1:4096', owned: true, pid },
      })

      const verdict = inspectOrphanedOpenCode(configDir)
      expect(verdict.kind).toBe('kept')
      expect(verdict.kind === 'kept' ? verdict.reason : '').toContain('no start-identity token')
    })

    it('never signals a pid that now belongs to something else', () => {
      const configDir = makeTempDir('config')
      const pid = spawnStandIn()
      writeState(configDir, {
        pid: departedPid,
        opencode: {
          baseUrl: 'http://127.0.0.1:4096',
          owned: true,
          pid,
          startToken: 'the-token-of-a-process-that-has-exited',
        },
      })

      const verdict = inspectOrphanedOpenCode(configDir)
      expect(verdict.kind).toBe('kept')
      expect(verdict.kind === 'kept' ? verdict.reason : '').toContain('different process')
    })

    it('leaves an adopted server alone however it is recorded', () => {
      const configDir = makeTempDir('config')
      const pid = spawnStandIn()
      writeState(configDir, {
        pid: departedPid,
        opencode: { baseUrl: 'http://127.0.0.1:4096', owned: false, pid, startToken: tokenFor(pid) },
      })

      expect(inspectOrphanedOpenCode(configDir).kind).toBe('nothing')
    })

    it('says nothing about a server that already exited', () => {
      const configDir = makeTempDir('config')
      writeState(configDir, {
        pid: departedPid,
        opencode: {
          baseUrl: 'http://127.0.0.1:4096',
          owned: true,
          pid: departedPid,
          startToken: 'anything',
        },
      })

      expect(inspectOrphanedOpenCode(configDir).kind).toBe('nothing')
    })

    it('stops a verified orphan under --apply and clears the record', async () => {
      const configDir = makeTempDir('config')
      const pid = spawnStandIn()
      writeState(configDir, {
        pid: departedPid,
        opencode: { baseUrl: 'http://127.0.0.1:4096', owned: true, pid, startToken: tokenFor(pid) },
      })

      const { code, output } = await captureClean({ apply: true, configDir })

      expect(code).toBe(0)
      expect(output).toContain(`Stopped the orphaned OpenCode server (pid ${pid})`)
      expect(isAlive(pid)).toBe(false)
      expect(existsSync(getDaemonStatePath(configDir))).toBe(false)
    })

    it('exits nonzero when the orphan it tried to stop is still running', async () => {
      const configDir = makeTempDir('config')
      const pid = spawnStandIn()
      writeState(configDir, {
        pid: departedPid,
        opencode: { baseUrl: 'http://127.0.0.1:4096', owned: true, pid, startToken: tokenFor(pid) },
      })

      const { code, output } = await captureClean({
        apply: true,
        configDir,
        // A process that ignores SIGKILL cannot be produced on demand; what is
        // being tested is what `clean` reports when the stop does not take.
        stopProcess: async () => false,
      })

      // Reported as success, this sends a provisioning script on to a `start`
      // that cannot have the port, with nothing in the exit code to say why.
      expect(code).toBe(1)
      expect(output).toContain(`Could not stop the orphaned OpenCode server (pid ${pid})`)
      // The server it names is still the truth about this machine.
      expect(existsSync(getDaemonStatePath(configDir))).toBe(true)
    })

    it('leaves an unverifiable process running under --apply', async () => {
      const configDir = makeTempDir('config')
      const pid = spawnStandIn()
      writeState(configDir, {
        pid: departedPid,
        opencode: { baseUrl: 'http://127.0.0.1:4096', owned: true, pid },
      })

      const { code, output } = await captureClean({ apply: true, configDir })

      expect(output).toContain('keeping')
      expect(isAlive(pid)).toBe(true)
      // Nothing was attempted, so nothing failed: refusing to signal a pid whose
      // identity cannot be proved is this command working exactly as designed,
      // and must not read as a failed cleanup.
      expect(code).toBe(0)
      // The record is the only account of what happened, so it stays.
      expect(existsSync(getDaemonStatePath(configDir))).toBe(true)
    })
  })

  /** Registers the project the way the app does, so `clean` can discover it. */
  function attach(projectRoot: string): number {
    attachProject({ folderPath: projectRoot, name: 'LoopTroop', shortname: 'LOOP' })
    const { db } = getProjectDatabase(projectRoot)
    const local = db.select().from(projects).all()[0]
    expect(local, 'attachProject did not create a local project row').toBeTruthy()
    return local?.id ?? 0
  }

  /** A ticket in a terminal state, which is what makes its worktree debris. */
  function finishTicket(projectRoot: string, projectId: number, externalId: string): void {
    const { db } = getProjectDatabase(projectRoot)
    db.insert(tickets).values({
      externalId,
      projectId,
      title: externalId,
      status: 'COMPLETED',
    }).run()
  }

  /**
   * A process that outlives the call, detached so it leads its own process group
   * exactly as a supervised OpenCode server does.
   */
  function spawnStandIn(): number {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    children.push(child)
    return child.pid ?? 0
  }

  /** A pid that has certainly been released, for records of a daemon that died. */
  async function makeDepartedPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const pid = child.pid ?? 0
    await new Promise<void>((done) => { child.once('exit', () => done()) })
    return pid
  }

  function tokenFor(pid: number): string {
    const token = readProcessStartToken(pid)
    expect(token, 'this platform cannot report process start times').toBeTruthy()
    return token ?? ''
  }

  function writeState(configDir: string, overrides: Partial<DaemonState> & { pid: number }): void {
    const state: DaemonState = {
      instanceId: 'instance-under-test',
      port: 1,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
      version: '0.0.0-test',
      apiToken: 'test-api-token',
      ...overrides,
    }
    writeFileSync(getDaemonStatePath(configDir), JSON.stringify(state))
  }

  async function captureClean(options: {
    apply: boolean
    configDir: string
    stopProcess?: (pid: number, startToken: string | undefined) => Promise<boolean>
  }): Promise<{ code: number, output: string }> {
    let output = ''
    const restoreOut = process.stdout.write.bind(process.stdout)
    const restoreErr = process.stderr.write.bind(process.stderr)
    const capture = ((chunk: string) => { output += String(chunk); return true }) as typeof process.stdout.write
    process.stdout.write = capture
    process.stderr.write = capture

    try {
      const code = await cleanCommand(options)
      return { code, output }
    } finally {
      process.stdout.write = restoreOut
      process.stderr.write = restoreErr
    }
  }

  async function runClean(options: { apply: boolean, configDir: string }): Promise<string> {
    return (await captureClean(options)).output
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
})
