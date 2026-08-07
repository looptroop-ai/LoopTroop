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
  opencode?: {
    baseUrl: string
    /** Only a daemon-started server may be stopped by the daemon. */
    owned: boolean
    pid?: number
  }
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
