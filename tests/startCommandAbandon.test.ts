import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { abandonFailedStart } from '../server/cli/commands'
import { getDaemonLockPath, getDaemonStatePath } from '../server/lib/daemonPaths'
import { readProcessStartToken } from '../server/lib/processIdentity'
import { isProcessAlive } from '../server/cli/processControl'
import { removeTempDir } from '../server/test/tempDir'

/**
 * 2.7 contract, the failure half: a start that times out must not leave the
 * process it spawned running.
 *
 * `waitForReady` giving up says nothing about the child. A daemon wedged on a
 * database or slow to bind is still alive, still holds the single-instance lock,
 * and may finish booting seconds after the CLI has told the user that nothing
 * started — leaving a daemon on a port nobody printed that the next `start`
 * refuses to replace. The CLI is the last thing holding that pid, so if it does
 * not end the process, nothing will.
 */
describe('abandoning a start that never reported ready', () => {
  const tempDirs: string[] = []
  const children: ChildProcess[] = []

  afterEach(() => {
    for (const child of children.splice(0)) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    for (const dir of tempDirs.splice(0)) removeTempDir(dir)
  })

  function makeConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-abandon-'))
    tempDirs.push(dir)
    return dir
  }

  /**
   * A stand-in for a daemon that spawned and then wedged. Detached so it leads
   * its own group, exactly as the real one does — which is what makes the
   * difference between signalling the pid and signalling the tree.
   */
  function spawnHungChild(options: { ignoresSigterm?: boolean } = {}): ChildProcess {
    const script = options.ignoresSigterm
      ? 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'
      : 'setInterval(() => {}, 1000)'
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' })
    child.unref()
    children.push(child)
    return child
  }

  /** The lock a daemon takes before it is ready, which is what a hang holds. */
  function writeLockFor(configDir: string, pid: number, startToken: string | null): void {
    writeFileSync(getDaemonLockPath(configDir), JSON.stringify({
      nonce: 'test-nonce',
      pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ...(startToken === null ? {} : { startToken }),
    }))
  }

  async function waitForDeath(pid: number, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) return true
      await new Promise((done) => setTimeout(done, 25))
    }
    return false
  }

  it('terminates a child that is still running when the start gives up', async () => {
    const configDir = makeConfigDir()
    const child = spawnHungChild()
    const pid = child.pid ?? 0
    const token = readProcessStartToken(pid)
    writeLockFor(configDir, pid, token)

    const message = await abandonFailedStart(configDir, child, token)

    expect(await waitForDeath(pid)).toBe(true)
    expect(message).toContain(String(pid))
    // The lock is the reason this matters: left behind, it makes the next start
    // refuse for the full stale window on behalf of a daemon that never was.
    expect(existsSync(getDaemonLockPath(configDir))).toBe(false)
  })

  it('escalates past a child that ignores the request to exit', async () => {
    const configDir = makeConfigDir()
    const child = spawnHungChild({ ignoresSigterm: true })
    const pid = child.pid ?? 0
    const token = readProcessStartToken(pid)
    writeLockFor(configDir, pid, token)

    await abandonFailedStart(configDir, child, token)

    expect(await waitForDeath(pid)).toBe(true)
  })

  it('says nothing when the child already exited on its own', async () => {
    const configDir = makeConfigDir()
    const child = spawnHungChild()
    const pid = child.pid ?? 0
    const token = readProcessStartToken(pid)

    child.kill('SIGKILL')
    expect(await waitForDeath(pid)).toBe(true)

    // The ordinary failed start: the child is gone and the CLI is about to print
    // why. Nothing to clean up and nothing worth adding to that message.
    expect(await abandonFailedStart(configDir, child, token)).toBeNull()
  })

  it('never signals a pid that now belongs to a different process', async () => {
    const configDir = makeConfigDir()
    const child = spawnHungChild()
    const pid = child.pid ?? 0

    // A token from a process that is not this one, standing in for the pid
    // having been released and reissued during the sixty-second timeout. A
    // failed start is not a licence to kill whatever holds the number now.
    const someoneElse = spawnHungChild()
    const foreignToken = readProcessStartToken(someoneElse.pid ?? 0)

    const message = await abandonFailedStart(configDir, child, foreignToken)

    expect(message).toBeNull()
    expect(isProcessAlive(pid)).toBe(true)
  })

  it('reports rather than guesses when the platform cannot confirm identity', async () => {
    const configDir = makeConfigDir()
    const child = spawnHungChild()
    const pid = child.pid ?? 0

    // No token recorded: an older platform, or one that cannot report start
    // times. Killing on the pid alone is the recycled-pid bug, so the process is
    // left alone and the user is told where to look.
    const message = await abandonFailedStart(configDir, child, null)

    expect(isProcessAlive(pid)).toBe(true)
    expect(message).toContain(String(pid))
    expect(message).toMatch(/may still be running/)
  })

  it('leaves the state file of a daemon that started while this one was timing out', async () => {
    const configDir = makeConfigDir()
    const child = spawnHungChild()
    const pid = child.pid ?? 0
    const token = readProcessStartToken(pid)

    // Two starts can race, and the sixty-second timeout is long enough for the
    // other one to have finished. Its state file is the record `stop` and
    // `status` read, and this call must not delete it on the way out.
    const winner = {
      instanceId: 'someone-else',
      pid: pid + 1,
      host: hostname(),
      port: 4321,
      startedAt: new Date().toISOString(),
      version: '0.0.0-test',
      apiToken: 'not-ours',
    }
    writeFileSync(getDaemonStatePath(configDir), JSON.stringify(winner))
    writeLockFor(configDir, pid, token)

    await abandonFailedStart(configDir, child, token)

    expect(JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8'))).toMatchObject({
      instanceId: 'someone-else',
    })
  })

  it('keeps the recorded start failure, which is the only account of what went wrong', async () => {
    const configDir = makeConfigDir()
    const child = spawnHungChild()
    const pid = child.pid ?? 0
    const token = readProcessStartToken(pid)

    // The child writes this before exiting when it refuses to start, and it is
    // what `start` prints. Cleaning up after the failure must not delete the
    // explanation of the failure.
    const record = {
      startFailure: {
        reason: 'schema-incompatible',
        at: new Date().toISOString(),
        version: '0.0.0-test',
        message: 'The database schema is newer than this build.',
        schema: {
          databaseLabel: 'app',
          databasePath: join(configDir, 'app.db'),
          found: 9,
          expected: 7,
          migratableFrom: 7,
        },
      },
    }
    writeFileSync(getDaemonStatePath(configDir), JSON.stringify(record))
    writeLockFor(configDir, pid, token)

    await abandonFailedStart(configDir, child, token)

    expect(JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8'))).toEqual(record)
  })
})
