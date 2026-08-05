import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq, sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Behavioural contract for the SQLite driver.
 *
 * These tests exist to be run unchanged against `node:sqlite` after the driver
 * swap. They pin the behaviour the application actually depends on — especially
 * value conversion, where a driver difference produces wrong data rather than an
 * error, and would otherwise surface as a subtle bug far from its cause.
 *
 * Deliberately excluded: statement caching, busy timeout and WAL checkpoint
 * mechanics. Those are implementation details asserted where the code that
 * depends on them lives, not here.
 */

const contractTable = sqliteTable('contract_rows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull(),
  count: integer('count').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  note: text('note'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

const uniqueTable = sqliteTable('contract_unique', {
  key: text('key').primaryKey(),
  hits: integer('hits').notNull().default(0),
})

let tempDir: string
let dbPath: string
let sqlite: Database.Database
let db: ReturnType<typeof drizzle>

function createSchema(connection: Database.Database) {
  connection.exec(`
    CREATE TABLE contract_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE contract_unique (
      key TEXT PRIMARY KEY,
      hits INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE contract_parent (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );

    CREATE TABLE contract_child (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER NOT NULL REFERENCES contract_parent(id) ON DELETE CASCADE
    );
  `)
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'looptroop-sqlite-contract-'))
  dbPath = join(tempDir, 'contract.sqlite')
  sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode=WAL')
  createSchema(sqlite)
  db = drizzle({ client: sqlite })
})

afterEach(() => {
  try { sqlite.close() } catch { /* already closed by a test */ }
  rmSync(tempDir, { recursive: true, force: true })
})

describe('value conversion', () => {
  it('round-trips integers without turning them into strings or BigInt', () => {
    db.insert(contractTable).values({ label: 'ints', count: 42 }).run()
    const row = db.select().from(contractTable).where(eq(contractTable.label, 'ints')).get()

    expect(row?.count).toBe(42)
    expect(typeof row?.count).toBe('number')
  })

  it('round-trips large integers within the safe range exactly', () => {
    const large = Number.MAX_SAFE_INTEGER
    db.insert(contractTable).values({ label: 'large', count: large }).run()
    const row = db.select().from(contractTable).where(eq(contractTable.label, 'large')).get()

    expect(row?.count).toBe(large)
    expect(typeof row?.count).toBe('number')
  })

  it('round-trips zero and negative integers', () => {
    db.insert(contractTable).values({ label: 'zero', count: 0 }).run()
    db.insert(contractTable).values({ label: 'negative', count: -17 }).run()

    const zero = db.select().from(contractTable).where(eq(contractTable.label, 'zero')).get()
    const negative = db.select().from(contractTable).where(eq(contractTable.label, 'negative')).get()

    expect(zero?.count).toBe(0)
    expect(negative?.count).toBe(-17)
  })

  it('round-trips booleans as real booleans, not 0/1', () => {
    db.insert(contractTable).values({ label: 'on', enabled: true }).run()
    db.insert(contractTable).values({ label: 'off', enabled: false }).run()

    const on = db.select().from(contractTable).where(eq(contractTable.label, 'on')).get()
    const off = db.select().from(contractTable).where(eq(contractTable.label, 'off')).get()

    expect(on?.enabled).toBe(true)
    expect(off?.enabled).toBe(false)
  })

  it('distinguishes NULL from empty string', () => {
    db.insert(contractTable).values({ label: 'null-note', note: null }).run()
    db.insert(contractTable).values({ label: 'empty-note', note: '' }).run()

    const nullNote = db.select().from(contractTable).where(eq(contractTable.label, 'null-note')).get()
    const emptyNote = db.select().from(contractTable).where(eq(contractTable.label, 'empty-note')).get()

    expect(nullNote?.note).toBeNull()
    expect(emptyNote?.note).toBe('')
  })

  it('applies SQL-side defaults, including datetime(now)', () => {
    db.insert(contractTable).values({ label: 'defaults' }).run()
    const row = db.select().from(contractTable).where(eq(contractTable.label, 'defaults')).get()

    expect(row?.count).toBe(0)
    expect(row?.enabled).toBe(false)
    expect(row?.note).toBeNull()
    expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('preserves unicode and embedded newlines in text', () => {
    const awkward = 'héllo\n\t"world" \\ 🎯'
    db.insert(contractTable).values({ label: 'unicode', note: awkward }).run()
    const row = db.select().from(contractTable).where(eq(contractTable.label, 'unicode')).get()

    expect(row?.note).toBe(awkward)
  })
})

describe('autoincrement ids', () => {
  it('assigns increasing ids and does not reuse them after delete', () => {
    const first = db.insert(contractTable).values({ label: 'a' }).returning().get()
    const second = db.insert(contractTable).values({ label: 'b' }).returning().get()

    expect(second!.id).toBeGreaterThan(first!.id)

    db.delete(contractTable).where(eq(contractTable.id, second!.id)).run()
    const third = db.insert(contractTable).values({ label: 'c' }).returning().get()

    // AUTOINCREMENT guarantees monotonicity even across deletes.
    expect(third!.id).toBeGreaterThan(second!.id)
  })
})

describe('returning', () => {
  it('returns the inserted row including generated and default columns', () => {
    const row = db.insert(contractTable).values({ label: 'ret' }).returning().get()

    expect(row?.id).toBeGreaterThan(0)
    expect(row?.label).toBe('ret')
    expect(row?.count).toBe(0)
    expect(row?.enabled).toBe(false)
  })

  it('returns updated rows', () => {
    const inserted = db.insert(contractTable).values({ label: 'upd' }).returning().get()
    const updated = db
      .update(contractTable)
      .set({ count: 5 })
      .where(eq(contractTable.id, inserted!.id))
      .returning()
      .get()

    expect(updated?.count).toBe(5)
  })

  it('returns deleted rows', () => {
    const inserted = db.insert(contractTable).values({ label: 'del' }).returning().get()
    const deleted = db
      .delete(contractTable)
      .where(eq(contractTable.id, inserted!.id))
      .returning()
      .get()

    expect(deleted?.id).toBe(inserted!.id)
    expect(db.select().from(contractTable).all()).toHaveLength(0)
  })

  it('returns every row when several are affected', () => {
    db.insert(contractTable).values([{ label: 'm1' }, { label: 'm2' }, { label: 'm3' }]).run()
    const updated = db.update(contractTable).set({ count: 1 }).returning().all()

    expect(updated).toHaveLength(3)
  })
})

describe('conflict handling', () => {
  it('onConflictDoNothing leaves the existing row untouched', () => {
    db.insert(uniqueTable).values({ key: 'k', hits: 1 }).run()
    db.insert(uniqueTable).values({ key: 'k', hits: 99 }).onConflictDoNothing().run()

    const row = db.select().from(uniqueTable).where(eq(uniqueTable.key, 'k')).get()
    expect(row?.hits).toBe(1)
  })

  it('onConflictDoUpdate overwrites the conflicting row', () => {
    db.insert(uniqueTable).values({ key: 'k', hits: 1 }).run()
    db.insert(uniqueTable)
      .values({ key: 'k', hits: 2 })
      .onConflictDoUpdate({ target: uniqueTable.key, set: { hits: 2 } })
      .run()

    const row = db.select().from(uniqueTable).where(eq(uniqueTable.key, 'k')).get()
    expect(row?.hits).toBe(2)
  })

  it('onConflictDoUpdate can reference the excluded row', () => {
    db.insert(uniqueTable).values({ key: 'k', hits: 10 }).run()
    db.insert(uniqueTable)
      .values({ key: 'k', hits: 5 })
      .onConflictDoUpdate({
        target: uniqueTable.key,
        set: { hits: sql`${uniqueTable.hits} + excluded.hits` },
      })
      .run()

    const row = db.select().from(uniqueTable).where(eq(uniqueTable.key, 'k')).get()
    expect(row?.hits).toBe(15)
  })

  it('raises on a genuine constraint violation rather than silently ignoring it', () => {
    db.insert(uniqueTable).values({ key: 'k' }).run()
    expect(() => db.insert(uniqueTable).values({ key: 'k' }).run()).toThrow()
  })
})

describe('transactions', () => {
  it('commits on success', () => {
    db.transaction((tx) => {
      tx.insert(contractTable).values({ label: 'committed' }).run()
    })

    expect(db.select().from(contractTable).all()).toHaveLength(1)
  })

  it('rolls back every statement when the callback throws', () => {
    expect(() => {
      db.transaction((tx) => {
        tx.insert(contractTable).values({ label: 'first' }).run()
        tx.insert(contractTable).values({ label: 'second' }).run()
        throw new Error('abort')
      })
    }).toThrow('abort')

    expect(db.select().from(contractTable).all()).toHaveLength(0)
  })

  it('propagates the original error, not a transaction wrapper', () => {
    const boom = new Error('specific failure')
    expect(() => {
      db.transaction(() => { throw boom })
    }).toThrow('specific failure')
  })

  it('rolls back only the inner savepoint on nested rollback', () => {
    db.transaction((tx) => {
      tx.insert(contractTable).values({ label: 'outer' }).run()
      try {
        tx.transaction((inner) => {
          inner.insert(contractTable).values({ label: 'inner' }).run()
          throw new Error('inner abort')
        })
      } catch {
        // Swallowed so the outer transaction still commits.
      }
    })

    const labels = db.select().from(contractTable).all().map((row) => row.label)
    expect(labels).toEqual(['outer'])
  })

  it('commits nested savepoints that succeed', () => {
    db.transaction((tx) => {
      tx.insert(contractTable).values({ label: 'outer' }).run()
      tx.transaction((inner) => {
        inner.insert(contractTable).values({ label: 'inner' }).run()
      })
    })

    const labels = db.select().from(contractTable).all().map((row) => row.label).sort()
    expect(labels).toEqual(['inner', 'outer'])
  })

  it('supports raw BEGIN/COMMIT and BEGIN/ROLLBACK on the connection', () => {
    sqlite.exec('BEGIN')
    sqlite.prepare('INSERT INTO contract_rows (label) VALUES (?)').run('raw-commit')
    sqlite.exec('COMMIT')

    sqlite.exec('BEGIN')
    sqlite.prepare('INSERT INTO contract_rows (label) VALUES (?)').run('raw-rollback')
    sqlite.exec('ROLLBACK')

    const labels = db.select().from(contractTable).all().map((row) => row.label)
    expect(labels).toEqual(['raw-commit'])
  })
})

describe('foreign keys', () => {
  it('enforces references once foreign_keys is ON', () => {
    sqlite.pragma('foreign_keys=ON')
    expect(() =>
      sqlite.prepare('INSERT INTO contract_child (parent_id) VALUES (?)').run(999),
    ).toThrow()
  })

  it('does not enforce references while foreign_keys is OFF', () => {
    sqlite.pragma('foreign_keys=OFF')
    expect(() =>
      sqlite.prepare('INSERT INTO contract_child (parent_id) VALUES (?)').run(999),
    ).not.toThrow()
  })

  it('cascades deletes', () => {
    sqlite.pragma('foreign_keys=ON')
    const parent = sqlite.prepare('INSERT INTO contract_parent (name) VALUES (?) RETURNING id').get('p') as { id: number }
    sqlite.prepare('INSERT INTO contract_child (parent_id) VALUES (?)').run(parent.id)

    sqlite.prepare('DELETE FROM contract_parent WHERE id = ?').run(parent.id)

    const remaining = sqlite.prepare('SELECT COUNT(*) AS n FROM contract_child').get() as { n: number }
    expect(remaining.n).toBe(0)
  })
})

describe('persistence', () => {
  it('sees committed rows after closing and reopening the file', () => {
    db.insert(contractTable).values({ label: 'durable', count: 7, enabled: true }).run()
    sqlite.close()

    const reopened = new Database(dbPath)
    try {
      const row = reopened
        .prepare('SELECT label, count, enabled FROM contract_rows WHERE label = ?')
        .get('durable') as { label: string, count: number, enabled: number }

      expect(row.label).toBe('durable')
      expect(row.count).toBe(7)
      // Storage is integer; the boolean mapping is a driver/ORM concern.
      expect(row.enabled).toBe(1)
    } finally {
      reopened.close()
    }
  })

  it('preserves user_version across reopen', () => {
    sqlite.pragma('user_version = 3')
    sqlite.close()

    const reopened = new Database(dbPath)
    try {
      const result = reopened.pragma('user_version') as Array<{ user_version: number }>
      expect(result[0]?.user_version).toBe(3)
    } finally {
      reopened.close()
    }
  })
})

describe('read-only access', () => {
  it('permits reads and rejects writes', () => {
    db.insert(contractTable).values({ label: 'readonly' }).run()
    sqlite.close()

    const readonly = new Database(dbPath, { readonly: true })
    try {
      const row = readonly.prepare('SELECT label FROM contract_rows WHERE label = ?').get('readonly')
      expect(row).toBeDefined()

      expect(() =>
        readonly.prepare('INSERT INTO contract_rows (label) VALUES (?)').run('nope'),
      ).toThrow()
    } finally {
      readonly.close()
    }
  })
})

describe('statement surface', () => {
  it('supports all(), get() and run() with bound parameters', () => {
    const insert = sqlite.prepare('INSERT INTO contract_rows (label, count) VALUES (?, ?)')
    const info = insert.run('bound', 3)
    expect(info.changes).toBe(1)

    const one = sqlite.prepare('SELECT label FROM contract_rows WHERE count = ?').get(3)
    expect(one).toMatchObject({ label: 'bound' })

    const many = sqlite.prepare('SELECT label FROM contract_rows WHERE count = ?').all(3)
    expect(many).toHaveLength(1)
  })

  it('reports the number of changed rows', () => {
    db.insert(contractTable).values([{ label: 'x' }, { label: 'y' }]).run()
    const info = sqlite.prepare('UPDATE contract_rows SET count = 1').run()

    expect(info.changes).toBe(2)
  })

  it('exposes the last inserted row id', () => {
    const info = sqlite.prepare('INSERT INTO contract_rows (label) VALUES (?)').run('rowid')
    expect(Number(info.lastInsertRowid)).toBeGreaterThan(0)
  })

  it('returns an empty array rather than throwing when nothing matches', () => {
    expect(sqlite.prepare('SELECT * FROM contract_rows WHERE label = ?').all('missing')).toEqual([])
    expect(sqlite.prepare('SELECT * FROM contract_rows WHERE label = ?').get('missing')).toBeUndefined()
  })

  it('reads PRAGMA table_info, which column introspection depends on', () => {
    const columns = sqlite.prepare('PRAGMA table_info(contract_rows)').all() as Array<{ name: string }>
    const names = columns.map((column) => column.name)

    expect(names).toContain('id')
    expect(names).toContain('label')
    expect(names).toContain('created_at')
  })
})
