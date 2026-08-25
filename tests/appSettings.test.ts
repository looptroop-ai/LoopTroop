import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../server/test/tempDir'
import {
  DEFAULT_SETTINGS,
  getSettingsPath,
  readSettingsFile,
  resolveSettings,
  writeSettingsFile,
} from '../server/lib/appSettings'

/**
 * 2.4 contract: settings resolve flag > env > file > default, unknown keys in
 * config.json survive a write, and no host setting exists at all.
 */
describe('appSettings', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      removeTempDir(dir)
    }
  })

  function makeConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-settings-'))
    tempDirs.push(dir)
    return dir
  }

  describe('precedence', () => {
    it('prefers a flag over every other source', () => {
      const settings = resolveSettings({
        flags: { port: 4001 },
        env: { LOOPTROOP_BACKEND_PORT: '4002' },
        file: { port: 4003 },
      })

      expect(settings.port).toBe(4001)
      expect(settings.sources.port).toBe('flag')
    })

    it('prefers the environment over the file', () => {
      const settings = resolveSettings({
        env: { LOOPTROOP_BACKEND_PORT: '4002' },
        file: { port: 4003 },
      })

      expect(settings.port).toBe(4002)
      expect(settings.sources.port).toBe('env')
    })

    it('prefers the file over the default', () => {
      const settings = resolveSettings({ env: {}, file: { port: 4003 } })

      expect(settings.port).toBe(4003)
      expect(settings.sources.port).toBe('file')
    })

    it('falls back to the default when nothing is configured', () => {
      const settings = resolveSettings({ env: {}, file: {} })

      expect(settings.port).toBe(DEFAULT_SETTINGS.port)
      expect(settings.sources.port).toBe('default')
    })
  })

  describe('validation', () => {
    it('skips an invalid value rather than failing, so a lower source still applies', () => {
      const settings = resolveSettings({
        env: { LOOPTROOP_BACKEND_PORT: 'not-a-port' },
        file: { port: 4003 },
      })

      expect(settings.port).toBe(4003)
      expect(settings.sources.port).toBe('file')
    })

    it.each([
      ['0', 'below the valid range'],
      ['65536', 'above the valid range'],
      ['80.5', 'not an integer'],
      ['3e3', 'exponent notation'],
    ])('rejects port %s (%s)', (value) => {
      const settings = resolveSettings({ env: { LOOPTROOP_BACKEND_PORT: value }, file: {} })

      expect(settings.port).toBe(DEFAULT_SETTINGS.port)
    })

    it('normalises an OpenCode base URL to its origin', () => {
      const settings = resolveSettings({
        env: { LOOPTROOP_OPENCODE_BASE_URL: 'http://127.0.0.1:4096/some/path' },
        file: {},
      })

      expect(settings.opencodeBaseUrl).toBe('http://127.0.0.1:4096')
    })

    it('accepts only known enum values', () => {
      const valid = resolveSettings({ env: { LOOPTROOP_OPENCODE_MODE: 'mock' }, file: {} })
      expect(valid.opencodeMode).toBe('mock')

      const invalid = resolveSettings({ env: { LOOPTROOP_OPENCODE_MODE: 'pretend' }, file: {} })
      expect(invalid.opencodeMode).toBe(DEFAULT_SETTINGS.opencodeMode)
    })
  })

  describe('explicit port', () => {
    it('is not explicit when it came from the default', () => {
      expect(resolveSettings({ env: {}, file: {} }).portIsExplicit).toBe(false)
    })

    it.each(['flag', 'env', 'file'] as const)('is explicit when the user set it via %s', (source) => {
      const settings = resolveSettings({
        flags: source === 'flag' ? { port: 4100 } : {},
        env: source === 'env' ? { LOOPTROOP_BACKEND_PORT: '4100' } : {},
        file: source === 'file' ? { port: 4100 } : {},
      })

      expect(settings.portIsExplicit).toBe(true)
    })
  })

  describe('config.json', () => {
    it('preserves keys it does not recognise', () => {
      const configDir = makeConfigDir()
      writeFileSync(
        getSettingsPath(configDir),
        JSON.stringify({ port: 4200, futureFeature: { enabled: true } }),
      )

      writeSettingsFile({ logLevel: 'debug' }, configDir)

      const written = JSON.parse(readFileSync(getSettingsPath(configDir), 'utf8')) as Record<string, unknown>
      expect(written.futureFeature).toEqual({ enabled: true })
      expect(written.port).toBe(4200)
      expect(written.logLevel).toBe('debug')
    })

    it('treats a malformed file as absent instead of failing to start', () => {
      const configDir = makeConfigDir()
      writeFileSync(getSettingsPath(configDir), '{ not json')

      expect(readSettingsFile(configDir)).toEqual({})
      expect(resolveSettings({ env: {}, configDir }).port).toBe(DEFAULT_SETTINGS.port)
    })

    it('treats a non-object file as absent', () => {
      const configDir = makeConfigDir()
      writeFileSync(getSettingsPath(configDir), '["port", 4000]')

      expect(readSettingsFile(configDir)).toEqual({})
    })

    it('returns an empty object when no file exists', () => {
      expect(readSettingsFile(makeConfigDir())).toEqual({})
    })

    it.runIf(process.platform !== 'win32')('writes the file owner-only', () => {
      const configDir = makeConfigDir()
      writeSettingsFile({ port: 4300 }, configDir)

      expect(statSync(getSettingsPath(configDir)).mode & 0o777).toBe(0o600)
    })
  })

  it('exposes no host setting, so the control API cannot be published by config', () => {
    const settings = resolveSettings({
      env: { LOOPTROOP_BACKEND_HOST: '0.0.0.0' },
      file: { host: '0.0.0.0' },
    })

    expect(settings).not.toHaveProperty('host')
    expect(Object.keys(settings.sources)).not.toContain('host')
  })
})
