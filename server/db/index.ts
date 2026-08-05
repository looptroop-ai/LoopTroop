import { Database } from './sqliteShim'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { dirname, isAbsolute, resolve } from 'path'
import { existsSync, mkdirSync } from 'fs'
import * as schema from './schema'
import { SQLITE_BUSY_TIMEOUT_MS } from '../lib/constants'
import { resolveAppConfigDir } from '../lib/appConfigDir'

type AppStorageConfigSource = 'default' | 'LOOPTROOP_CONFIG_DIR' | 'LOOPTROOP_APP_DB_PATH'

interface AppStorageBootFacts {
  configDir: string
  dbPath: string
  source: AppStorageConfigSource
  dbExistedBeforeBoot: boolean
}

function resolveAppStorageBootFacts(): AppStorageBootFacts {
  const configDir = resolveAppConfigDir()
  const configuredDbPath = process.env.LOOPTROOP_APP_DB_PATH?.trim()
  const dbPath = configuredDbPath
    ? (isAbsolute(configuredDbPath) ? configuredDbPath : resolve(process.cwd(), configuredDbPath))
    : resolve(configDir, 'app.sqlite')
  const source: AppStorageConfigSource = configuredDbPath
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

mkdirSync(APP_CONFIG_DIR, { recursive: true })
mkdirSync(dirname(DB_PATH), { recursive: true })

let sqliteInstance: Database | null = null
let dbInstance: ReturnType<typeof drizzle> | null = null

function getOrCreateSqlite(): Database {
  if (!sqliteInstance) {
    sqliteInstance = new Database(DB_PATH)
    sqliteInstance.pragma('journal_mode=WAL')
    sqliteInstance.pragma('locking_mode=NORMAL')
    sqliteInstance.pragma('synchronous=NORMAL')
    sqliteInstance.pragma(`busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`)
    sqliteInstance.pragma('wal_autocheckpoint=1000')
    sqliteInstance.pragma('foreign_keys=ON')
  }
  return sqliteInstance
}

function getOrCreateDb(): ReturnType<typeof drizzle> {
  if (!dbInstance) {
    // @ts-expect-error Drizzle 1.0 RC removes `schema` from the config type but accepts it at runtime
    dbInstance = drizzle({ client: getOrCreateSqlite().client, schema })
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

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
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
  type AppStorageBootFacts,
  type AppStorageConfigSource,
}

let checkpointInterval: ReturnType<typeof setInterval> | null = null

export function startWalCheckpoint() {
  checkpointInterval = setInterval(() => {
    try {
      sqlite.pragma('wal_checkpoint(PASSIVE)')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[db] WAL checkpoint failed: ${message}`)
    }
  }, 30000)
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
