import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectInstallChannel,
  getInstallInfo,
  isNewerVersion,
  readRecordedInstall,
  resolveInstallInfo,
} from '../server/lib/installChannel'
import { checkForUpdate, CHECK_INTERVAL_MS, formatUpdateNotice } from '../server/lib/updateCheck'

/**
 * 2.13 contract: the upgrade command shown must match how this copy was
 * actually installed, and the check must never block a command or nag a user
 * who is offline.
 */
describe('install channel detection', () => {
  const previousContainer = process.env.LOOPTROOP_CONTAINER

  afterEach(() => {
    if (previousContainer === undefined) delete process.env.LOOPTROOP_CONTAINER
    else process.env.LOOPTROOP_CONTAINER = previousContainer
  })

  it.each([
    ['/usr/local/lib/node_modules/looptroop/dist/server/cli', 'npm'],
    ['/opt/homebrew/Cellar/looptroop/0.5.0/libexec/dist/server/cli', 'homebrew'],
    ['/home/u/scoop/apps/looptroop/current/dist/server/cli', 'scoop'],
    ['/c/ProgramData/chocolatey/lib/looptroop/dist/server/cli', 'chocolatey'],
  ])('detects %s as %s', (moduleDir, expected) => {
    expect(detectInstallChannel(moduleDir)).toBe(expected)
  })

  it('detects a container from the build-time marker', () => {
    process.env.LOOPTROOP_CONTAINER = '1'
    expect(detectInstallChannel('/app/dist/server/cli')).toBe('container')
  })

  it('returns unknown rather than guessing for an unrecognised location', () => {
    expect(detectInstallChannel('/some/unexpected/place')).toBe('unknown')
  })

  it('pairs every channel with a usable upgrade command', () => {
    expect(getInstallInfo('/usr/local/lib/node_modules/looptroop/dist/server/cli').upgradeCommand)
      .toBe('npm install -g looptroop@latest')
    expect(getInstallInfo('/opt/homebrew/Cellar/looptroop/0.5.0/dist/server/cli').upgradeCommand)
      .toBe('brew upgrade looptroop')
  })
})

/**
 * 2.13 contract: the channel is inferred from a path, which is both fragile and
 * wasteful to redo on every command, so the first confident answer is written to
 * config.json and reused until this copy moves.
 */
describe('recorded install channel', () => {
  const tempDirs: string[] = []
  const NPM_DIR = '/usr/local/lib/node_modules/looptroop/dist/server/cli'
  const BREW_DIR = '/opt/homebrew/Cellar/looptroop/0.5.0/libexec/dist/server/cli'

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-install-'))
    tempDirs.push(dir)
    return dir
  }

  function readConfig(configDir: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as Record<string, unknown>
  }

  it('records the detected channel on first use', () => {
    const configDir = makeConfigDir()

    const info = resolveInstallInfo({ configDir, moduleDir: NPM_DIR })

    expect(info.channel).toBe('npm')
    expect(readRecordedInstall(configDir)).toEqual({ channel: 'npm', path: NPM_DIR })
  })

  it('reuses the recorded answer instead of detecting again', () => {
    const configDir = makeConfigDir()
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ install: { channel: 'homebrew', path: NPM_DIR } }),
    )

    // The path says npm; the recorded channel is what must win, which is only
    // observable because the two disagree.
    expect(resolveInstallInfo({ configDir, moduleDir: NPM_DIR }).channel).toBe('homebrew')
  })

  it('detects again once this copy has moved', () => {
    const configDir = makeConfigDir()
    resolveInstallInfo({ configDir, moduleDir: NPM_DIR })

    // Same config directory, different location: reinstalled by another manager.
    expect(resolveInstallInfo({ configDir, moduleDir: BREW_DIR }).channel).toBe('homebrew')
    expect(readRecordedInstall(configDir)).toEqual({ channel: 'homebrew', path: BREW_DIR })
  })

  it('honours a hand-written pin wherever the files live', () => {
    const configDir = makeConfigDir()
    // No path: a user correcting a bad guess should not have to know where the
    // package manager put the files.
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ install: { channel: 'scoop' } }))

    const info = resolveInstallInfo({ configDir, moduleDir: NPM_DIR })

    expect(info.channel).toBe('scoop')
    expect(info.upgradeCommand).toBe('scoop update looptroop')
    // Overwriting the pin would undo the correction on the very next command.
    expect(readRecordedInstall(configDir)).toEqual({ channel: 'scoop' })
  })

  it('does not record an unknown channel, so a later run can still settle it', () => {
    const configDir = makeConfigDir()

    expect(resolveInstallInfo({ configDir, moduleDir: '/some/unexpected/place' }).channel).toBe('unknown')
    expect(readRecordedInstall(configDir)).toBeNull()
  })

  it('ignores a malformed record rather than trusting it', () => {
    const configDir = makeConfigDir()
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ install: { channel: 'apt-get' } }))

    expect(readRecordedInstall(configDir)).toBeNull()
    expect(resolveInstallInfo({ configDir, moduleDir: NPM_DIR }).channel).toBe('npm')
  })

  it('preserves unrelated settings when recording', () => {
    const configDir = makeConfigDir()
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ port: 4711, logLevel: 'debug' }))

    resolveInstallInfo({ configDir, moduleDir: NPM_DIR })

    expect(readConfig(configDir)).toMatchObject({ port: 4711, logLevel: 'debug' })
  })

  it('still answers when the config directory cannot be written', () => {
    const configDir = makeConfigDir()
    // A read-only install (2.20) or a locked-down home directory: the answer is
    // still correct, it just cannot be remembered.
    writeFileSync(join(configDir, 'blocker'), '')

    const info = resolveInstallInfo({ configDir: join(configDir, 'blocker', 'nested'), moduleDir: NPM_DIR })

    expect(info.channel).toBe('npm')
    expect(info.upgradeCommand).toBe('npm install -g looptroop@latest')
  })

  /**
   * The image sets LOOPTROOP_CONTAINER=1, and the config directory is a named
   * volume that outlives any one container. Those two facts together are why the
   * marker has to beat the record: the volume can have been written by a global
   * npm install before it was ever mounted here, and `npm install -g` inside a
   * container upgrades a tree the next `docker run` discards.
   */
  describe('inside the container image', () => {
    const CONTAINER_DIR = '/opt/looptroop/lib/node_modules/looptroop/dist/server/cli'
    const previousContainer = process.env.LOOPTROOP_CONTAINER

    beforeEach(() => {
      process.env.LOOPTROOP_CONTAINER = '1'
    })

    afterEach(() => {
      if (previousContainer === undefined) delete process.env.LOOPTROOP_CONTAINER
      else process.env.LOOPTROOP_CONTAINER = previousContainer
    })

    it('records the container channel on a fresh volume', () => {
      const configDir = makeConfigDir()

      const info = resolveInstallInfo({ configDir, moduleDir: CONTAINER_DIR })

      expect(info.channel).toBe('container')
      expect(info.upgradeCommand).toBe('docker pull looptroopai/looptroop:latest')
      expect(readRecordedInstall(configDir)).toEqual({ channel: 'container', path: CONTAINER_DIR })
    })

    it('corrects a volume that recorded npm before it was mounted here', () => {
      const configDir = makeConfigDir()
      // The path matches, so without the marker override this record would be
      // reused verbatim and the user told to run `npm install -g`.
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({ install: { channel: 'npm', path: CONTAINER_DIR } }),
      )

      expect(resolveInstallInfo({ configDir, moduleDir: CONTAINER_DIR }).channel).toBe('container')
      expect(readRecordedInstall(configDir)).toEqual({ channel: 'container', path: CONTAINER_DIR })
    })

    it('overrides a hand-written pin, which was never a claim about the runtime', () => {
      const configDir = makeConfigDir()
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ install: { channel: 'homebrew' } }))

      expect(resolveInstallInfo({ configDir, moduleDir: CONTAINER_DIR }).channel).toBe('container')
    })

    it('does not rewrite a record that already agrees', () => {
      const configDir = makeConfigDir()
      // Deliberately without `path`: a re-record would add one, so the absence
      // afterwards is what proves the volume was not written to.
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ install: { channel: 'container' } }))

      expect(resolveInstallInfo({ configDir, moduleDir: CONTAINER_DIR }).channel).toBe('container')
      expect(readRecordedInstall(configDir)).toEqual({ channel: 'container' })
    })

    it('still answers container when the volume is read-only', () => {
      const configDir = makeConfigDir()
      writeFileSync(join(configDir, 'blocker'), '')

      const info = resolveInstallInfo({
        configDir: join(configDir, 'blocker', 'nested'),
        moduleDir: CONTAINER_DIR,
      })

      expect(info.channel).toBe('container')
      expect(info.upgradeCommand).toBe('docker pull looptroopai/looptroop:latest')
    })
  })
})

describe('version comparison', () => {
  it.each([
    ['0.5.0', '0.4.1', true],
    ['0.4.2', '0.4.1', true],
    ['1.0.0', '0.9.9', true],
    ['0.4.1', '0.4.1', false],
    ['0.4.0', '0.4.1', false],
    ['0.10.0', '0.9.0', true],
  ])('%s newer than %s is %s', (candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected)
  })

  it('treats a release as newer than its own prerelease', () => {
    expect(isNewerVersion('0.5.0', '0.5.0-rc.1')).toBe(true)
    expect(isNewerVersion('0.5.0-rc.1', '0.5.0')).toBe(false)
  })

  it('tolerates a leading v', () => {
    expect(isNewerVersion('v0.5.0', '0.4.1')).toBe(true)
  })
})

describe('update check', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-update-'))
    tempDirs.push(dir)
    return dir
  }

  it('reports a notice when a newer version exists', async () => {
    const notice = await checkForUpdate({
      currentVersion: '0.4.1',
      configDir: makeConfigDir(),
      fetchLatest: async () => '0.5.0',
    })

    expect(notice?.latestVersion).toBe('0.5.0')
    expect(notice?.currentVersion).toBe('0.4.1')
  })

  it('stays silent when already current', async () => {
    const notice = await checkForUpdate({
      currentVersion: '0.5.0',
      configDir: makeConfigDir(),
      fetchLatest: async () => '0.5.0',
    })

    expect(notice).toBeNull()
  })

  it('stays silent when the lookup fails, rather than nagging an offline user', async () => {
    const notice = await checkForUpdate({
      currentVersion: '0.4.1',
      configDir: makeConfigDir(),
      fetchLatest: async () => null,
    })

    expect(notice).toBeNull()
  })

  it('does not query again within the check interval', async () => {
    const configDir = makeConfigDir()
    let calls = 0
    const fetchLatest = async (): Promise<string> => {
      calls += 1
      return '0.5.0'
    }

    await checkForUpdate({ currentVersion: '0.4.1', configDir, fetchLatest })
    await checkForUpdate({ currentVersion: '0.4.1', configDir, fetchLatest })

    expect(calls).toBe(1)
  })

  it('queries again once the interval has elapsed', async () => {
    const configDir = makeConfigDir()
    let calls = 0
    const fetchLatest = async (): Promise<string> => {
      calls += 1
      return '0.5.0'
    }

    const start = Date.now()
    await checkForUpdate({ currentVersion: '0.4.1', configDir, fetchLatest, now: () => start })
    await checkForUpdate({
      currentVersion: '0.4.1',
      configDir,
      fetchLatest,
      now: () => start + CHECK_INTERVAL_MS + 1,
    })

    expect(calls).toBe(2)
  })

  it('treats a corrupt cache as absent', async () => {
    const configDir = makeConfigDir()
    writeFileSync(join(configDir, 'update-check.json'), '{ not json')

    const notice = await checkForUpdate({
      currentVersion: '0.4.1',
      configDir,
      fetchLatest: async () => '0.5.0',
    })

    expect(notice?.latestVersion).toBe('0.5.0')
  })

  /**
   * What a machine that cannot reach the registry paid.
   *
   * Only answers were cached, so a failed lookup left no timestamp to compare
   * against and every command tried again — a fresh request, and its full
   * timeout, on every single `looptroop status` for as long as the machine
   * stayed offline.
   */
  describe('when the registry cannot be reached', () => {
    it('does not try again within the interval', async () => {
      const configDir = makeConfigDir()
      let calls = 0
      const fetchLatest = async (): Promise<null> => {
        calls += 1
        return null
      }

      const start = Date.now()
      await checkForUpdate({ currentVersion: '0.4.1', configDir, fetchLatest, now: () => start })
      await checkForUpdate({ currentVersion: '0.4.1', configDir, fetchLatest, now: () => start + 1_000 })
      await checkForUpdate({ currentVersion: '0.4.1', configDir, fetchLatest, now: () => start + 2_000 })

      expect(calls).toBe(1)
    })

    it('tries again once the interval has elapsed', async () => {
      const configDir = makeConfigDir()
      let calls = 0
      const fetchLatest = async (): Promise<null> => {
        calls += 1
        return null
      }

      const start = Date.now()
      await checkForUpdate({ currentVersion: '0.4.1', configDir, fetchLatest, now: () => start })
      await checkForUpdate({
        currentVersion: '0.4.1',
        configDir,
        fetchLatest,
        now: () => start + CHECK_INTERVAL_MS + 1,
      })

      // Rationing the attempts must not become never making them again.
      expect(calls).toBe(2)
    })

    it('keeps reporting the last version it did learn', async () => {
      const configDir = makeConfigDir()
      const start = Date.now()

      await checkForUpdate({ currentVersion: '0.4.1', configDir, fetchLatest: async () => '0.5.0', now: () => start })
      const notice = await checkForUpdate({
        currentVersion: '0.4.1',
        configDir,
        fetchLatest: async () => null,
        now: () => start + CHECK_INTERVAL_MS + 1,
      })

      // A failed lookup is not evidence the update went away, and the whole
      // point of the cache is to still have an answer when offline.
      expect(notice?.latestVersion).toBe('0.5.0')
    })

    it('does not let a failure pass for a successful check', async () => {
      const configDir = makeConfigDir()
      const start = Date.now()

      await checkForUpdate({ currentVersion: '0.4.1', configDir, fetchLatest: async () => null, now: () => start })
      const cached = JSON.parse(readFileSync(join(configDir, 'update-check.json'), 'utf8')) as {
        lastAttemptAt?: string
        lastCheckedAt?: string
        latestVersion?: string
      }

      // The attempt is recorded; the answer is not, because there was none.
      expect(cached.lastAttemptAt).toBe(new Date(start).toISOString())
      expect(cached.lastCheckedAt).toBeUndefined()
      expect(cached.latestVersion).toBeUndefined()
    })

    it('still honours a cache written before failures were recorded', async () => {
      const configDir = makeConfigDir()
      const start = Date.now()
      // The shape shipped in 0.4.x: a success timestamp and nothing else.
      writeFileSync(join(configDir, 'update-check.json'), JSON.stringify({
        lastCheckedAt: new Date(start).toISOString(),
        latestVersion: '0.5.0',
      }))

      let calls = 0
      const notice = await checkForUpdate({
        currentVersion: '0.4.1',
        configDir,
        fetchLatest: async () => { calls += 1; return '0.6.0' },
        now: () => start + 1_000,
      })

      // Upgrading LoopTroop must not invalidate the cache and send every
      // installed copy back to the registry on its next command.
      expect(calls).toBe(0)
      expect(notice?.latestVersion).toBe('0.5.0')
    })
  })

  it('names the version and the upgrade command in the notice', () => {
    const text = formatUpdateNotice({
      currentVersion: '0.4.1',
      latestVersion: '0.5.0',
      upgradeCommand: 'npm install -g looptroop@latest',
    })

    expect(text).toContain('0.5.0')
    expect(text).toContain('0.4.1')
    expect(text).toContain('npm install -g looptroop@latest')
  })
})
