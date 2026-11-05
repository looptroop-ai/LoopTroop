import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { Database } from '../sqliteShim'
import { sqlite as appSqlite } from '../index'
import { initializeDatabase } from '../init'
import { clearProjectDatabaseCache, getProjectDatabase } from '../project'
import * as schema from '../schema'
import * as schemaVersion from '../schemaVersion'
import { IncompatibleSchemaVersionError, PROJECT_SCHEMA_VERSION, readUserVersion } from '../schemaVersion'
import { getProjectDbPath } from '../../storage/paths'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

const APP_TABLES = new Set(['profiles', 'app_meta', 'attached_projects'])

/** Every table schema.ts declares, derived rather than listed so a new one is covered. */
function declaredTables(): Array<{ name: string; columns: string[] }> {
  return Object.values(schema).flatMap((candidate) => {
    try {
      const config = getTableConfig(candidate as SQLiteTable)
      return [{ name: config.name, columns: config.columns.map((column) => column.name).sort() }]
    } catch {
      return []
    }
  })
}

function createdColumns(store: { prepare(sql: string): { all(): unknown[] } }, table: string): string[] {
  return (store.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name)
    .sort()
}

describe('project database', () => {
  const roots: string[] = []
  afterEach(() => {
    clearProjectDatabaseCache()
    for (const root of roots.splice(0)) removeTempDir(root)
  })

  function makeRoot(): string {
    const root = makeTempDir('looptroop-project-db-')
    roots.push(root)
    return root
  }

  it('finds the latest artifact of a type for a ticket through the ticket+type index', () => {
    const { sqlite } = getProjectDatabase(makeRoot())
    const plan = (sql: string) => (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 'cleanup_report') as Array<{ detail: string }>)
      .map((row) => row.detail)
      .join(' | ')

    expect(plan('SELECT * FROM phase_artifacts WHERE ticket_id = ? AND artifact_type = ? ORDER BY id DESC LIMIT 1'))
      .toContain('USING INDEX idx_phase_artifacts_ticket_type (ticket_id=? AND artifact_type=?)')
    expect(plan('SELECT * FROM phase_artifacts WHERE ticket_id = ? AND artifact_type = ? ORDER BY id DESC LIMIT 1'))
      .not.toContain('TEMP B-TREE')
  })

  // Nothing adds a missing column after creation any more, so the CREATE TABLE
  // statements alone must give every column the ORM reads and writes.
  it('creates every column schema.ts declares, in both databases', () => {
    initializeDatabase()
    const { sqlite } = getProjectDatabase(makeRoot())
    const tables = declaredTables()
    expect(tables.length).toBeGreaterThan(APP_TABLES.size)

    for (const table of tables) {
      const store = APP_TABLES.has(table.name) ? appSqlite : sqlite
      expect(createdColumns(store, table.name), table.name).toEqual(table.columns)
    }
  })

  it('stamps a fresh database with the current version', () => {
    const { sqlite } = getProjectDatabase(makeRoot())
    expect(readUserVersion(sqlite)).toBe(PROJECT_SCHEMA_VERSION)
  })

  it('refuses a database from an older version without touching it, and says what to delete', () => {
    const root = makeRoot()
    const dbPath = getProjectDbPath(root)
    mkdirSync(dirname(dbPath), { recursive: true })
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE tickets (id INTEGER PRIMARY KEY)')
    seed.pragma(`user_version = ${PROJECT_SCHEMA_VERSION - 1}`)
    seed.close()

    let refusal: unknown
    try {
      getProjectDatabase(root)
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(IncompatibleSchemaVersionError)
    const message = (refusal as Error).message
    expect(message).toContain(dbPath)
    expect(message).toContain(`delete the .looptroop folder in ${root}`)
    expect(message).toContain('git worktree prune')

    const reopened = new Database(dbPath, { readonly: true })
    try {
      expect(readUserVersion(reopened)).toBe(PROJECT_SCHEMA_VERSION - 1)
      expect(createdColumns(reopened, 'tickets')).toEqual(['id'])
      expect(reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'phase_artifacts'").all()).toEqual([])
      // Not even switched to WAL, which would rewrite the file header.
      expect(reopened.pragma('journal_mode')).toEqual([{ journal_mode: 'delete' }])
    } finally {
      reopened.close()
    }
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
  })

  it('leaves a first start that failed before its version stamp retryable, not refused as older', () => {
    const root = makeRoot()
    const stamp = vi.spyOn(schemaVersion, 'writeUserVersion').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    try {
      expect(() => getProjectDatabase(root)).toThrow('disk full')
    } finally {
      stamp.mockRestore()
    }

    // The tables were rolled back with the stamp, so the file is still fresh.
    const { sqlite } = getProjectDatabase(root)
    expect(readUserVersion(sqlite)).toBe(PROJECT_SCHEMA_VERSION)
    expect(createdColumns(sqlite, 'tickets')).toContain('external_id')
  })
})
