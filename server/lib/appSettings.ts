import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveAppConfigDir, ensureSecureDir, secureFile } from './appConfigDir'
import { safeAtomicWrite } from '../io/atomicWrite'
import { DEFAULT_BACKEND_PORT, DEFAULT_OPENCODE_BASE_URL } from '../../shared/appConfig'

export const SETTINGS_FILE_NAME = 'config.json'

export const DEFAULT_SETTINGS = {
  port: DEFAULT_BACKEND_PORT,
  opencodeBaseUrl: DEFAULT_OPENCODE_BASE_URL,
  opencodeMode: 'live' as const,
  logLevel: 'info' as const,
} satisfies Omit<ResolvedSettings, 'portIsExplicit' | 'sources'>

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const
const OPENCODE_MODES = ['live', 'mock'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]
export type OpenCodeMode = (typeof OPENCODE_MODES)[number]

/** Where a resolved value came from, so `doctor` can explain the outcome. */
export type SettingSource = 'flag' | 'env' | 'file' | 'default'

export interface ResolvedSettings {
  port: number
  opencodeBaseUrl: string
  opencodeMode: OpenCodeMode
  logLevel: LogLevel
  /**
   * True when the user named a port. An explicit port must fail loudly if taken;
   * only the default may quietly fall back to an OS-assigned one.
   */
  portIsExplicit: boolean
  sources: Record<'port' | 'opencodeBaseUrl' | 'opencodeMode' | 'logLevel', SettingSource>
}

/** Only these keys are interpreted; anything else is preserved untouched. */
export interface SettingsFile {
  port?: unknown
  opencodeBaseUrl?: unknown
  opencodeMode?: unknown
  logLevel?: unknown
  [key: string]: unknown
}

export interface SettingsFlags {
  port?: number
  opencodeBaseUrl?: string
  opencodeMode?: OpenCodeMode
  logLevel?: LogLevel
}

export interface ResolveSettingsInput {
  flags?: SettingsFlags
  env?: NodeJS.ProcessEnv
  configDir?: string
  /** Injected by tests; otherwise read from disk. */
  file?: SettingsFile
}

export function getSettingsPath(configDir = resolveAppConfigDir()): string {
  return resolve(configDir, SETTINGS_FILE_NAME)
}

function parsePort(value: unknown): number | null {
  const candidate = typeof value === 'string' ? value.trim() : value
  if (typeof candidate === 'string' && !/^\d+$/.test(candidate)) return null
  const parsed = Number(candidate)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null
}

function parseOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    return new URL(value.trim()).origin
  } catch {
    return null
  }
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase() as T
  return allowed.includes(normalized) ? normalized : null
}

/**
 * Reads `config.json`. A malformed or unreadable file is treated as absent
 * rather than fatal: the daemon must still start so `doctor` can report why.
 */
export function readSettingsFile(configDir = resolveAppConfigDir()): SettingsFile {
  let raw: string
  try {
    raw = readFileSync(getSettingsPath(configDir), 'utf8')
  } catch {
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as SettingsFile
      : {}
  } catch {
    console.warn(`[config] Ignoring malformed ${getSettingsPath(configDir)}; using defaults.`)
    return {}
  }
}

/**
 * Merges a patch into `config.json`, preserving keys this version does not know
 * about so a newer LoopTroop's settings survive a downgrade.
 */
export function writeSettingsFile(patch: SettingsFile, configDir = resolveAppConfigDir()): void {
  const existing = readSettingsFile(configDir)
  const merged = { ...existing, ...patch }
  const settingsPath = getSettingsPath(configDir)

  ensureSecureDir(configDir)
  safeAtomicWrite(settingsPath, `${JSON.stringify(merged, null, 2)}\n`)
  secureFile(settingsPath)
}

/**
 * Resolves effective settings with precedence flag > env > file > default.
 *
 * Deliberately has no `host`: the control API binds loopback only, and a
 * persistent file value or casual flag must not be able to expose it. Container
 * deployments opt in through LOOPTROOP_ALLOW_REMOTE_API, which also demands a token.
 */
export function resolveSettings(input: ResolveSettingsInput = {}): ResolvedSettings {
  const env = input.env ?? process.env
  const file = input.file ?? readSettingsFile(input.configDir)
  const flags = input.flags ?? {}

  function pick<T>(
    flagValue: T | undefined,
    envValue: unknown,
    fileValue: unknown,
    fallback: T,
    parse: (value: unknown) => T | null,
  ): { value: T; source: SettingSource } {
    if (flagValue !== undefined) return { value: flagValue, source: 'flag' }

    const fromEnv = envValue === undefined ? null : parse(envValue)
    if (fromEnv !== null) return { value: fromEnv, source: 'env' }

    const fromFile = fileValue === undefined ? null : parse(fileValue)
    if (fromFile !== null) return { value: fromFile, source: 'file' }

    return { value: fallback, source: 'default' }
  }

  const port = pick(flags.port, env.LOOPTROOP_BACKEND_PORT, file.port, DEFAULT_SETTINGS.port, parsePort)
  const opencodeBaseUrl = pick(
    flags.opencodeBaseUrl,
    env.LOOPTROOP_OPENCODE_BASE_URL,
    file.opencodeBaseUrl,
    DEFAULT_SETTINGS.opencodeBaseUrl,
    parseOrigin,
  )
  const opencodeMode = pick(
    flags.opencodeMode,
    env.LOOPTROOP_OPENCODE_MODE,
    file.opencodeMode,
    DEFAULT_SETTINGS.opencodeMode,
    (value) => parseEnum(value, OPENCODE_MODES),
  )
  const logLevel = pick(
    flags.logLevel,
    env.LOOPTROOP_LOG_LEVEL,
    file.logLevel,
    DEFAULT_SETTINGS.logLevel,
    (value) => parseEnum(value, LOG_LEVELS),
  )

  return {
    port: port.value,
    opencodeBaseUrl: opencodeBaseUrl.value,
    opencodeMode: opencodeMode.value,
    logLevel: logLevel.value,
    portIsExplicit: port.source !== 'default',
    sources: {
      port: port.source,
      opencodeBaseUrl: opencodeBaseUrl.source,
      opencodeMode: opencodeMode.source,
      logLevel: logLevel.source,
    },
  }
}
