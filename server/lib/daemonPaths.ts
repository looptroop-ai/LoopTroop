import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { resolveAppConfigDir } from './appConfigDir'

/**
 * Informational record of the running daemon. Never the locking primitive:
 * exclusive ownership belongs to daemon.lock, which is created with 'wx'.
 */
export interface DaemonState {
  /** Distinguishes this run from a recycled pid. */
  instanceId: string
  pid: number
  port: number
  host: string
  startedAt: string
  version: string
  /**
   * Bearer token for talking to this daemon. It lives here because the CLI has
   * no other way to reach a daemon it did not spawn, and the file is written
   * owner-only for exactly that reason. Never print it: `status --json` and the
   * daemon log both redact it.
   */
  apiToken: string
  opencode?: {
    baseUrl: string
    /** Only a daemon-started server may be stopped by the daemon. */
    owned: boolean
    pid?: number
  }
}

/** The same record with the token removed, for anything user-facing. */
export type RedactedDaemonState = Omit<DaemonState, 'apiToken'>

export function redactDaemonState(state: DaemonState): RedactedDaemonState {
  const { apiToken: _apiToken, ...rest } = state
  return rest
}

export function getDaemonStatePath(configDir = resolveAppConfigDir()): string {
  return resolve(configDir, 'daemon.json')
}

export function getDaemonLockPath(configDir = resolveAppConfigDir()): string {
  return resolve(configDir, 'daemon.lock')
}

export function getDaemonLogDir(configDir = resolveAppConfigDir()): string {
  return resolve(configDir, 'logs')
}

export function getDaemonLogPath(configDir = resolveAppConfigDir()): string {
  return resolve(getDaemonLogDir(configDir), 'daemon.log')
}

function isDaemonState(value: unknown): value is DaemonState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.instanceId === 'string'
    && typeof candidate.pid === 'number'
    && typeof candidate.port === 'number'
    && typeof candidate.apiToken === 'string'
}

/** Returns null for every failure mode: absent, unreadable, or malformed. */
export function readDaemonState(configDir?: string): DaemonState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getDaemonStatePath(configDir), 'utf8'))
    return isDaemonState(parsed) ? parsed : null
  } catch {
    return null
  }
}
