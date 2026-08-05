import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONFIG_DIR_MODE,
  CONFIG_FILE_MODE,
  ensureSecureDir,
  resolveAppConfigDir,
  secureFile,
  type AppConfigDirDetection,
} from '../appConfigDir'
import { safeAtomicWrite } from '../../io/atomicWrite'

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('config directory permissions', () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'looptroop-perms-'))
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  function modeOf(target: string): number {
    return statSync(target).mode & 0o777
  }

  it('creates the config directory owner-only', () => {
    const dir = join(scratch, 'config')
    ensureSecureDir(dir)
    expect(modeOf(dir)).toBe(CONFIG_DIR_MODE)
  })

  it('tightens a directory left world-readable by an earlier version', () => {
    const dir = join(scratch, 'legacy')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o755)

    ensureSecureDir(dir)
    expect(modeOf(dir)).toBe(CONFIG_DIR_MODE)
  })

  it('restricts an existing file to owner-only', () => {
    const file = join(scratch, 'app.sqlite')
    writeFileSync(file, 'x')
    chmodSync(file, 0o644)

    secureFile(file)
    expect(modeOf(file)).toBe(CONFIG_FILE_MODE)
  })

  it('does not throw when the file is missing', () => {
    expect(() => secureFile(join(scratch, 'absent'))).not.toThrow()
  })

  it('preserves a restricted mode when atomically replaced', () => {
    const file = join(scratch, 'secret.json')
    safeAtomicWrite(file, '{"a":1}')
    secureFile(file)
    expect(modeOf(file)).toBe(CONFIG_FILE_MODE)

    // Rename brings the temp file's mode with it, so a naive implementation
    // silently widens the target back to the default.
    safeAtomicWrite(file, '{"a":2}')
    expect(modeOf(file)).toBe(CONFIG_FILE_MODE)
  })
})

describe('resolveAppConfigDir', () => {
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    // Clear test-runtime env vars so detection bypasses the test-runtime path
    delete process.env.NODE_ENV
    delete process.env.VITEST
  })

  afterEach(() => {
    process.env = originalEnv
  })
  it('respects LOOPTROOP_CONFIG_DIR override on every platform', () => {
    const override = '/custom/config'
    const detection: AppConfigDirDetection = {
      platform: 'linux',
      env: { LOOPTROOP_CONFIG_DIR: override },
      homeDir: '/home/user',
    }
    expect(resolveAppConfigDir(detection)).toBe(override)

    detection.platform = 'win32'
    expect(resolveAppConfigDir(detection)).toBe(override)

    detection.platform = 'darwin'
    expect(resolveAppConfigDir(detection)).toBe(override)
  })

  it('resolves relative LOOPTROOP_CONFIG_DIR against cwd', () => {
    const detection: AppConfigDirDetection = {
      platform: 'linux',
      env: { LOOPTROOP_CONFIG_DIR: 'relative/config' },
      homeDir: '/home/user',
    }
    expect(resolveAppConfigDir(detection)).toMatch(/\/relative\/config$/)
  })

  // These assert the suffix rather than the full path: the POSIX `path` module
  // used when running tests on Linux does not treat `C:/...` as absolute, so it
  // resolves against cwd. On real Windows `path.win32` handles it correctly.
  it('uses %APPDATA%\\looptroop on Windows when APPDATA is set', () => {
    const detection: AppConfigDirDetection = {
      platform: 'win32',
      env: { APPDATA: 'C:/Users/user/AppData/Roaming' },
      homeDir: 'C:/Users/user',
    }
    expect(resolveAppConfigDir(detection)).toMatch(/AppData\/Roaming\/looptroop$/)
  })

  it('falls back to %USERPROFILE%\\AppData\\Roaming\\looptroop on Windows without APPDATA', () => {
    const detection: AppConfigDirDetection = {
      platform: 'win32',
      env: {},
      homeDir: 'C:/Users/user',
    }
    expect(resolveAppConfigDir(detection)).toMatch(/AppData\/Roaming\/looptroop$/)
  })

  it('ignores XDG_CONFIG_HOME on Windows', () => {
    const detection: AppConfigDirDetection = {
      platform: 'win32',
      env: { XDG_CONFIG_HOME: '/unix/config', APPDATA: 'C:/Users/user/AppData/Roaming' },
      homeDir: 'C:/Users/user',
    }
    const resolved = resolveAppConfigDir(detection)
    expect(resolved).toMatch(/AppData\/Roaming\/looptroop$/)
    expect(resolved).not.toContain('/unix/config')
  })

  it('uses $XDG_CONFIG_HOME/looptroop on Unix when set', () => {
    const detection: AppConfigDirDetection = {
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/custom/xdg' },
      homeDir: '/home/user',
    }
    expect(resolveAppConfigDir(detection)).toBe('/custom/xdg/looptroop')
  })

  it('falls back to ~/.config/looptroop on Unix without XDG_CONFIG_HOME', () => {
    const detection: AppConfigDirDetection = {
      platform: 'linux',
      env: {},
      homeDir: '/home/user',
    }
    expect(resolveAppConfigDir(detection)).toBe('/home/user/.config/looptroop')
  })

  it('resolves relative XDG_CONFIG_HOME against cwd on Unix', () => {
    const detection: AppConfigDirDetection = {
      platform: 'linux',
      env: { XDG_CONFIG_HOME: 'relative/xdg' },
      homeDir: '/home/user',
    }
    expect(resolveAppConfigDir(detection)).toMatch(/\/relative\/xdg\/looptroop$/)
  })

  it('works on macOS exactly like Linux', () => {
    const detection: AppConfigDirDetection = {
      platform: 'darwin',
      env: { XDG_CONFIG_HOME: '/Users/user/.config' },
      homeDir: '/Users/user',
    }
    expect(resolveAppConfigDir(detection)).toBe('/Users/user/.config/looptroop')

    detection.env = {}
    expect(resolveAppConfigDir(detection)).toBe('/Users/user/.config/looptroop')
  })
})
