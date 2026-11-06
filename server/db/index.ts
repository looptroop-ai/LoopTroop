import { Database } from './sqliteShim'
import { createDrizzle, type DrizzleDatabase } from './createDrizzle'
import { dirname } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { SQLITE_BUSY_TIMEOUT_MS, WAL_CHECKPOINT_INTERVAL_MS } from '../lib/constants'
import { ensureSecureDir, resolveAppConfigDir, secureFile } from '../lib/appConfigDir'
import { resolveAppDbPath } from './appDbPath'
import { getErrorMessage } from '@shared/typeGuards'
import { APP_SCHEMA_VERSION, classifySchemaVersion, inspectSchemaVersion } from './schemaVersion'

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
    const instance = new Database(DB_PATH)
    try {
      // Connection-level settings first; they change nothing in the file.
      instance.pragma(`busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`)
      instance.pragma('foreign_keys=ON')
      // Writes to the file (permissions, journal mode) only for a database this
      // build may use: `initializeDatabase` refuses any other, and it must find
      // the file as it was.
      const { kind } = classifySchemaVersion(inspectSchemaVersion(instance), APP_SCHEMA_VERSION)
      if (kind === 'fresh' || kind === 'current') {
        // The database carries project paths and session state, so restrict it as
        // soon as SQLite has created the file.
        secureFile(DB_PATH)
        instance.pragma('journal_mode=WAL')
        instance.pragma('locking_mode=NORMAL')
        instance.pragma('synchronous=NORMAL')
        instance.pragma('wal_autocheckpoint=1000')
      }
    } catch (error) {
      // A file that is not a database would otherwise stay open, and Windows
      // cannot delete an open file.
      instance.close()
      throw error
    }
    sqliteInstance = instance
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
