import { Database } from './sqliteShim'
import { createDrizzle, type DrizzleDatabase } from './createDrizzle'
import { dirname } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { SQLITE_BUSY_TIMEOUT_MS, WAL_CHECKPOINT_INTERVAL_MS } from '../lib/constants'
import { ensureSecureDir, resolveAppConfigDir, secureFile } from '../lib/appConfigDir'
import { resolveAppDbPath } from './appDbPath'
import { getErrorMessage } from '@shared/typeGuards'

type AppStorageConfigSource = 'default' | 'LOOPTROOP_CONFIG_DIR' | 'LOOPTROOP_APP_DB_PATH'

interface AppStorageBootFacts {
  configDir: string
  dbPath: string
  source: AppStorageConfigSource
  dbExistedBeforeBoot: boolean
}

function resolveAppStorageBootFacts(): AppStorageBootFacts {
  const configDir = resolveAppConfigDir()
  const dbPath = resolveAppDbPath(configDir)
  const source: AppStorageConfigSource = process.env.LOOPTROOP_APP_DB_PATH?.trim()
    ? 'LOOPTROOP_APP_DB_PATH'
    : process.env.LOOPTROOP_CONFIG_DIR?.trim()
      ? 'LOOPTROOP_CONFIG_DIR'
      : 'default'

  return {
    configDir,
    dbPath,
    source,
    dbExistedBeforeBoot: existsSync(dbPath),
  }
}

const APP_STORAGE_BOOT_FACTS = resolveAppStorageBootFacts()
const APP_CONFIG_DIR = APP_STORAGE_BOOT_FACTS.configDir
const DB_PATH = APP_STORAGE_BOOT_FACTS.dbPath

let storageDirsReady = false

/**
 * Deferred so that importing this module writes nothing: an embedded host (and
 * `looptroop --version`) must be able to load the runtime without touching disk.
 */
function ensureStorageDirs(): void {
  if (storageDirsReady) return
  mkdirSync(APP_CONFIG_DIR, { recursive: true })
  mkdirSync(dirname(DB_PATH), { recursive: true })
  ensureSecureDir(APP_CONFIG_DIR)
  storageDirsReady = true
}

let sqliteInstance: Database | null = null
let dbInstance: DrizzleDatabase | null = null

function getOrCreateSqlite(): Database {
  if (!sqliteInstance) {
    ensureStorageDirs()
    sqliteInstance = new Database(DB_PATH)
    // The database carries project paths and session state, so restrict it as
    // soon as SQLite has created the file.
    secureFile(DB_PATH)
    sqliteInstance.pragma('journal_mode=WAL')
    sqliteInstance.pragma('locking_mode=NORMAL')
    sqliteInstance.pragma('synchronous=NORMAL')
    sqliteInstance.pragma(`busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`)
    sqliteInstance.pragma('wal_autocheckpoint=1000')
    sqliteInstance.pragma('foreign_keys=ON')
  }
  return sqliteInstance
}

function getOrCreateDb(): DrizzleDatabase {
  if (!dbInstance) {
    dbInstance = createDrizzle(getOrCreateSqlite().client)
  }
  return dbInstance
}

// Lazy-initializing proxies — the actual SQLite connection is only opened on
// first access, not at module-import time. This prevents test environments
// that transitively import this module from creating spurious database files.
export const sqlite = new Proxy({} as Database, {
  get(_target, prop: string | symbol) {
    const real = getOrCreateSqlite()
    const value = (real as unknown as Record<string | symbol, unknown>)[prop]
    return typeof value === 'function' ? value.bind(real) : value
  },
})

export const db = new Proxy({} as DrizzleDatabase, {
  get(_target, prop: string | symbol) {
    const real = getOrCreateDb()
    const value = (real as unknown as Record<string | symbol, unknown>)[prop]
    return typeof value === 'function' ? value.bind(real) : value
  },
})

export {
  DB_PATH as APP_DB_PATH,
  APP_CONFIG_DIR,
  APP_STORAGE_BOOT_FACTS,
  ensureStorageDirs,
  type AppStorageBootFacts,
  type AppStorageConfigSource,
}

let checkpointInterval: ReturnType<typeof setInterval> | null = null

export function startWalCheckpoint() {
  // Called twice — by two overlapping starts, or a start after a failed one —
  // this used to allocate a second interval and lose the handle to the first,
  // leaving a timer nothing could ever stop.
  if (checkpointInterval) return
  checkpointInterval = setInterval(() => {
    try {
      sqlite.pragma('wal_checkpoint(PASSIVE)')
    } catch (error) {
      const message = getErrorMessage(error)
      console.error(`[db] WAL checkpoint failed: ${message}`)
    }
  }, WAL_CHECKPOINT_INTERVAL_MS)
  // Housekeeping should never be the reason the process stays alive.
  checkpointInterval.unref?.()
}

export function stopWalCheckpoint() {
  if (checkpointInterval) {
    clearInterval(checkpointInterval)
    checkpointInterval = null
  }
}

export function closeDatabase() {
  stopWalCheckpoint()
  if (sqliteInstance) {
    sqliteInstance.close()
    sqliteInstance = null
  }
  dbInstance = null
}
