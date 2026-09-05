import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectInstallChannel,
  getInstallInfo,
  isNewerVersion,
  readRecordedInstall,
  resolveInstallInfo,
} from '../server/lib/installChannel'
import { INSTALL_CHANNEL_MARKER } from '../shared/installChannel'
import { checkForUpdate, CHECK_INTERVAL_MS, formatUpdateNotice, getUpdateStatus } from '../server/lib/updateCheck'
import { removeTempDir } from '../server/test/tempDir'

/**
 * 2.13 contract: the upgrade command shown must match how this copy was
 * actually installed, and the check must never block a command or nag a user
 * who is offline.
 */
describe('install channel detection', () => {
  const previousContainer = process.env.LOOPTROOP_CONTAINER
  const tempDirs: string[] = []

  afterEach(() => {
    if (previousContainer === undefined) delete process.env.LOOPTROOP_CONTAINER
    else process.env.LOOPTROOP_CONTAINER = previousContainer
    for (const dir of tempDirs.splice(0)) removeTempDir(dir)
  })

  /** A package root with a real `package.json`, which is what detection anchors on. */
  function makeInstallTree(marker?: string): string {
    const root = mkdtempSync(join(tmpdir(), 'looptroop-tree-'))
    tempDirs.push(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'looptroop' }))
    if (marker !== undefined) writeFileSync(join(root, INSTALL_CHANNEL_MARKER), marker)
    mkdirSync(join(root, 'dist', 'server', 'lib'), { recursive: true })
    return root
  }

  it.each([
    ['/usr/local/lib/node_modules/looptroop/dist/server/cli', 'npm'],
    ['/opt/homebrew/Cellar/looptroop/9.9.9/libexec/dist/server/cli', 'homebrew'],
    ['/home/linuxbrew/.linuxbrew/Cellar/looptroop/9.9.9/libexec/dist/server/cli', 'homebrew'],
    ['/home/u/scoop/apps/looptroop/current/dist/server/cli', 'scoop'],
    ['/c/ProgramData/chocolatey/lib/looptroop/dist/server/cli', 'chocolatey'],
    // WinGet unpacks a portable archive and runs nothing afterwards, so unlike
    // the other three it cannot leave a marker file. The path is the only
    // evidence, and WinGet owns this directory outright.
    ['/c/Users/u/AppData/Local/Microsoft/WinGet/Packages/LoopTroopAI.LoopTroop_Microsoft.Winget.Source_8wekyb3d8bbwe/looptroop/dist/server/cli', 'winget'],
    // A portable is reached through the alias WinGet puts in `Links`, and the
    // running executable resolves to that rather than to the unpacked copy.
    ['/c/Users/u/AppData/Local/Microsoft/WinGet/Links', 'winget'],
    // Machine scope, which is a different path entirely: no `Microsoft` in it
    // at all. Matching only the user-scope path reported every machine-wide
    // install as a plain downloaded binary, and handed those users an upgrade
    // command that would not upgrade anything.
    ['/c/Program Files/WinGet/Links', 'winget'],
    ['/c/Program Files/WinGet/Packages/LoopTroopAI.LoopTroop_Microsoft.Winget.Source_8wekyb3d8bbwe/looptroop/dist/server/cli', 'winget'],
    // Both of these paths were taken from real global installs, not invented:
    // `bun add -g looptroop` and `pnpm add -g looptroop` were run and the
    // resolved module directory read back. Both used to answer `npm`, and so
    // told the user to run `npm install -g`, which does not upgrade either of
    // them — it installs a second copy under npm's prefix.
    //
    // bun keeps its global tree at `<BUN_INSTALL>/install/global`.
    ['/home/u/.bun/install/global/node_modules/looptroop/dist/server/cli', 'bun'],
    // pnpm links the package out of its content-addressable store, and Node
    // resolves the symlink when it loads the module — so what detection sees is
    // the store path, not the `global/v11/…` directory pnpm's shim names.
    ['/home/u/.local/share/pnpm/store/v11/links/@/looptroop/9.9.9/abc123/node_modules/looptroop/dist/server/cli', 'pnpm'],
    ['/home/u/.local/share/pnpm/global/v11/node_modules/.pnpm/looptroop@9.9.9/node_modules/looptroop/dist/server/cli', 'pnpm'],
    // Yarn Classic, taken the same way: `yarn global dir` reports
    // `…/.config/yarn/global`, and the module resolves to `<that>/node_modules`.
    // Only the directory above `node_modules` separates it from an npm install.
    ['/usr/local/share/.config/yarn/global/node_modules/looptroop/dist/server/cli', 'yarn'],
    ['/home/u/.config/yarn/global/node_modules/looptroop/dist/server/cli', 'yarn'],
    // Windows, where Yarn Classic keeps the same tree under `Yarn/Data/global`.
    ['/c/Users/u/AppData/Local/Yarn/Data/global/node_modules/looptroop/dist/server/cli', 'yarn'],
  ])('detects %s as %s', (moduleDir, expected) => {
    expect(detectInstallChannel(moduleDir)).toBe(expected)
  })

  /**
   * The upgrade command is the whole reason detection exists, so assert the
   * commands themselves rather than only the channel names. Each manager keeps
   * its global tree somewhere the other two do not look.
   */
  it.each([
    ['/usr/local/lib/node_modules/looptroop/dist/server/cli', 'npm', 'npm install -g looptroop@latest'],
    ['/home/u/.bun/install/global/node_modules/looptroop/dist/server/cli', 'bun', 'bun add -g looptroop@latest'],
    ['/home/u/.local/share/pnpm/store/v11/links/@/looptroop/9.9.9/abc123/node_modules/looptroop/dist/server/cli', 'pnpm', 'pnpm add -g looptroop@latest'],
    ['/home/u/.config/yarn/global/node_modules/looptroop/dist/server/cli', 'yarn', 'yarn global upgrade looptroop@latest'],
  ])('upgrades a %s install as %s with its own command', (moduleDir, channel, expected) => {
    const info = getInstallInfo(moduleDir)
    expect(info.channel).toBe(channel)
    expect(info.upgradeCommand).toBe(expected)
  })

  /**
   * The bug this narrowing fixes: Homebrew's own Node puts global npm packages
   * under the brew prefix, so `/homebrew/` matched an install brew knows nothing
   * about, and the user was told to run `brew upgrade looptroop`.
   */
  it.each([
    '/opt/homebrew/lib/node_modules/looptroop/dist/server/lib',
    '/usr/local/lib/node_modules/looptroop/dist/server/lib',
    '/home/linuxbrew/.linuxbrew/lib/node_modules/looptroop/dist/server/lib',
  ])('calls a global npm install under a brew prefix npm: %s', (moduleDir) => {
    expect(detectInstallChannel(moduleDir)).toBe('npm')
  })

  /**
   * The matching risk that came with covering machine scope. Anchoring on the
   * word `WinGet` alone would read a checkout that merely sits inside a
   * directory of that name as an install — and `winget-pkgs` is exactly what
   * somebody working on this package has checked out.
   */
  it('does not read a checkout beside the word winget as a WinGet install', () => {
    expect(detectInstallChannel('/home/u/src/winget-pkgs/looptroop/dist/server/lib')).not.toBe('winget')
    expect(detectInstallChannel('/home/u/WinGet/notes/looptroop/dist/server/lib')).not.toBe('winget')
  })

  it('detects a container from the build-time marker', () => {
    process.env.LOOPTROOP_CONTAINER = '1'
    expect(detectInstallChannel('/app/dist/server/cli')).toBe('container')
  })

  it('returns unknown rather than guessing for an unrecognised location', () => {
    expect(detectInstallChannel('/some/unexpected/place')).toBe('unknown')
  })

  it('reads the marker an installer left at the package root', () => {
    // A Scoop root the path pattern cannot recognise, which is the whole reason
    // the marker exists: only the installer knows who unpacked these files.
    const root = makeInstallTree('scoop\n')
    expect(detectInstallChannel(join(root, 'dist', 'server', 'lib'))).toBe('scoop')
  })

  it.each(['homebrew', 'scoop', 'chocolatey'])('honours a %s marker', (channel) => {
    const root = makeInstallTree(channel)
    expect(detectInstallChannel(join(root, 'dist', 'server', 'lib'))).toBe(channel)
  })

  it('lets the container marker outrank a marker file', () => {
    process.env.LOOPTROOP_CONTAINER = '1'
    const root = makeInstallTree('homebrew')
    expect(detectInstallChannel(join(root, 'dist', 'server', 'lib'))).toBe('container')
  })

  it('lets a marker file outrank the path shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'looptroop-shape-'))
    tempDirs.push(root)
    // Deliberately a path the shape rules read as chocolatey.
    const packageRoot = join(root, 'ProgramData', 'chocolatey', 'lib', 'looptroop')
    mkdirSync(join(packageRoot, 'dist', 'server', 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), '{}')
    writeFileSync(join(packageRoot, INSTALL_CHANNEL_MARKER), 'scoop')

    expect(detectInstallChannel(join(packageRoot, 'dist', 'server', 'lib'))).toBe('scoop')
  })

  it.each(['', 'apt-get', 'unknown', 'x'.repeat(400)])('ignores the unusable marker %j', (contents) => {
    const root = makeInstallTree(contents)
    // Falls through to the shape rules, which have nothing to say about a temp
    // directory — better than honouring a truncated or garbage file.
    expect(detectInstallChannel(join(root, 'dist', 'server', 'lib'))).toBe('unknown')
  })

  it('pairs every channel with a usable upgrade command', () => {
    expect(getInstallInfo('/usr/local/lib/node_modules/looptroop/dist/server/cli').upgradeCommand)
      .toBe('npm install -g looptroop@latest')
    expect(getInstallInfo('/opt/homebrew/Cellar/looptroop/9.9.9/libexec/dist/server/cli').upgradeCommand)
      .toBe('brew upgrade looptroop')
  })

  it('explains what must happen to the running process after each kind of upgrade', () => {
    expect(getInstallInfo('/usr/local/lib/node_modules/looptroop/dist/server/cli').postUpgradeCommand)
      .toBe('looptroop restart')

    process.env.LOOPTROOP_CONTAINER = '1'
    const container = getInstallInfo('/app/dist/server/cli')
    expect(container.postUpgradeCommand).toBeUndefined()
    expect(container.upgradeNote).toContain('recreate')
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
      removeTempDir(dir)
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

  it('reuses the recorded answer where detection has nothing to say', () => {
    const configDir = makeConfigDir()
    const CUSTOM_DIR = '/opt/tools/looptroop-app/dist/server/lib'
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ install: { channel: 'scoop', path: CUSTOM_DIR } }),
    )

    // Detection reads this path as `unknown`, which is silence rather than
    // disagreement: the record is the only thing that knows, so it stands.
    expect(resolveInstallInfo({ configDir, moduleDir: CUSTOM_DIR }).channel).toBe('scoop')
  })

  /**
   * 0.5.0 wrote `homebrew` for paths under `node_modules` on any Mac whose Node
   * came from Homebrew. Reinstalling puts the files back at the same path, so
   * without this the record pins that wrong answer forever and no later fix to
   * detection can ever reach those users.
   */
  it('heals a record that contradicts the path it was written for', () => {
    const configDir = makeConfigDir()
    const BREW_NODE_NPM_DIR = '/opt/homebrew/lib/node_modules/looptroop/dist/server/lib'
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ install: { channel: 'homebrew', path: BREW_NODE_NPM_DIR } }),
    )

    const info = resolveInstallInfo({ configDir, moduleDir: BREW_NODE_NPM_DIR })

    expect(info.channel).toBe('npm')
    expect(info.upgradeCommand).toBe('npm install -g looptroop@latest')
    expect(readRecordedInstall(configDir)).toEqual({ channel: 'npm', path: BREW_NODE_NPM_DIR })
  })

  it('lets a marker file outrank a record written before it existed', () => {
    const configDir = makeConfigDir()
    const root = mkdtempSync(join(tmpdir(), 'looptroop-marked-'))
    tempDirs.push(root)
    writeFileSync(join(root, 'package.json'), '{}')
    writeFileSync(join(root, INSTALL_CHANNEL_MARKER), 'chocolatey')
    const moduleDir = join(root, 'dist', 'server', 'lib')
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ install: { channel: 'npm', path: moduleDir } }))

    expect(resolveInstallInfo({ configDir, moduleDir }).channel).toBe('chocolatey')
    expect(readRecordedInstall(configDir)).toEqual({ channel: 'chocolatey', path: moduleDir })
  })

  it('does not rewrite a record the path agrees with', () => {
    const configDir = makeConfigDir()
    // Compact JSON: a rewrite pretty-prints, so the bytes are what proves the
    // common case touches no disk.
    const original = JSON.stringify({ install: { channel: 'npm', path: NPM_DIR } })
    writeFileSync(join(configDir, 'config.json'), original)

    expect(resolveInstallInfo({ configDir, moduleDir: NPM_DIR }).channel).toBe('npm')
    expect(readFileSync(join(configDir, 'config.json'), 'utf8')).toBe(original)
  })

  it('ignores a channel inherited from Object.prototype', () => {
    const configDir = makeConfigDir()
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ install: { channel: 'constructor' } }))

    expect(readRecordedInstall(configDir)).toBeNull()
    expect(typeof resolveInstallInfo({ configDir, moduleDir: NPM_DIR }).upgradeCommand).toBe('string')
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
      removeTempDir(dir)
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

  it('returns full GitHub release details and lifecycle guidance for the UI', async () => {
    const configDir = makeConfigDir()
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ install: { channel: 'npm' } }))
    const status = await getUpdateStatus({
      currentVersion: '0.4.1',
      configDir,
      fetchRelease: async () => ({
        version: '0.5.0',
        name: 'LoopTroop 0.5.0',
        url: 'https://github.com/looptroop-ai/LoopTroop/releases/tag/v0.5.0',
        publishedAt: '2026-08-16T08:00:00.000Z',
        notes: 'Everything in the GitHub release body.',
      }),
    })

    expect(status).toMatchObject({
      currentVersion: '0.4.1',
      latestVersion: '0.5.0',
      updateAvailable: true,
      installChannel: 'npm',
      upgradeCommand: 'npm install -g looptroop@latest',
      postUpgradeCommand: 'looptroop restart',
      release: { notes: 'Everything in the GitHub release body.' },
    })
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
   * What a machine that cannot reach GitHub paid.
   *
   * Only answers were cached, so a failed lookup left no timestamp to compare
   * against and every command tried again — a fresh request, and its full
   * timeout, on every single `looptroop status` for as long as the machine
   * stayed offline.
   */
  describe('when GitHub cannot be reached', () => {
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
      // installed copy back to GitHub on its next command.
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

  it('prints post-upgrade and channel notes as separate cross-shell-safe lines', () => {
    const text = formatUpdateNotice({
      currentVersion: '0.4.1',
      latestVersion: '0.5.0',
      upgradeFirst: 'looptroop stop',
      upgradeCommand: 'winget upgrade LoopTroopAI.LoopTroop',
      postUpgradeCommand: 'looptroop open',
      upgradeNote: 'Restart guidance.',
    })

    expect(text).toContain('  looptroop stop\n  winget upgrade LoopTroopAI.LoopTroop\n  looptroop open\n')
    expect(text).toContain('Restart guidance.')
  })
})
