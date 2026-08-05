import { describe, expect, it, vi } from 'vitest'
import {
  APP_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  UNVERSIONED_SCHEMA_VERSION,
  assertSchemaCompatible,
  buildNewerSchemaMessage,
  buildUnsupportedSchemaMessage,
  buildUnversionedResetMessage,
  classifySchemaVersion,
  hasAnyUserTable,
  inspectSchemaVersion,
  readUserVersion,
  shouldStampAfterInit,
  writeUserVersion,
  type SchemaVersionStore,
} from '../schemaVersion'

function fakeStore(userVersion: number, tables: string[]): SchemaVersionStore {
  let current = userVersion
  return {
    pragma(source: string) {
      const assignment = source.match(/^user_version\s*=\s*(\d+)$/)
      if (assignment?.[1] !== undefined) {
        current = Number(assignment[1])
        return undefined
      }
      return [{ user_version: current }]
    },
    prepare() {
      return { all: () => tables.map((name) => ({ name })) }
    },
  }
}

describe('classifySchemaVersion', () => {
  it('reports a brand-new database as fresh', () => {
    expect(classifySchemaVersion({ found: 0, hasExistingTables: false }, 1))
      .toEqual({ kind: 'fresh' })
  })

  it('distinguishes a pre-0.5 database from a fresh one', () => {
    expect(classifySchemaVersion({ found: 0, hasExistingTables: true }, 1))
      .toEqual({ kind: 'unversioned' })
  })

  it('reports a matching version as current', () => {
    expect(classifySchemaVersion({ found: 3, hasExistingTables: true }, 3))
      .toEqual({ kind: 'current' })
  })

  it('reports a newer database with the version it found', () => {
    expect(classifySchemaVersion({ found: 9, hasExistingTables: true }, 3))
      .toEqual({ kind: 'newer', found: 9 })
  })

  it('reports an older versioned database as older', () => {
    expect(classifySchemaVersion({ found: 2, hasExistingTables: true }, 5))
      .toEqual({ kind: 'older', found: 2 })
  })

  it('reports databases below the migration floor as unsupported', () => {
    expect(classifySchemaVersion({ found: 2, hasExistingTables: true }, 5, 3))
      .toEqual({ kind: 'unsupported', found: 2 })
  })

  it('still upgrades a database sitting exactly on the floor', () => {
    expect(classifySchemaVersion({ found: 3, hasExistingTables: true }, 5, 3))
      .toEqual({ kind: 'older', found: 3 })
  })
})

describe('shouldStampAfterInit', () => {
  // The gap that shipped: `older` was classified but never stamped, so an
  // upgraded database kept its previous version number.
  it('stamps whenever DDL brought the schema forward', () => {
    expect(shouldStampAfterInit({ kind: 'fresh' })).toBe(true)
    expect(shouldStampAfterInit({ kind: 'unversioned' })).toBe(true)
    expect(shouldStampAfterInit({ kind: 'older', found: 1 })).toBe(true)
  })

  it('does not rewrite a database that was already current', () => {
    expect(shouldStampAfterInit({ kind: 'current' })).toBe(false)
  })
})

describe('assertSchemaCompatible', () => {
  const base = {
    databaseLabel: 'app database',
    databasePath: '/tmp/app.sqlite',
    expected: 5,
    migratableFrom: 3,
  }

  it('refuses a newer database', () => {
    const onNotice = vi.fn()
    expect(() => assertSchemaCompatible({ ...base, store: fakeStore(9, ['t']), onNotice }))
      .toThrow(/created by a newer version/)
    expect(onNotice).not.toHaveBeenCalled()
  })

  it('refuses a database below the migration floor rather than half-upgrading it', () => {
    const onNotice = vi.fn()
    expect(() => assertSchemaCompatible({ ...base, store: fakeStore(1, ['t']), onNotice }))
      .toThrow(/can only upgrade databases from version 3/)
  })

  it('allows an older database through and announces the upgrade', () => {
    const onNotice = vi.fn()
    const result = assertSchemaCompatible({ ...base, store: fakeStore(3, ['t']), onNotice })
    expect(result).toEqual({ kind: 'older', found: 3 })
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('from version 3 to 5'))
  })

  it('announces an unversioned database once', () => {
    const onNotice = vi.fn()
    const result = assertSchemaCompatible({ ...base, store: fakeStore(0, ['t']), onNotice })
    expect(result).toEqual({ kind: 'unversioned' })
    expect(onNotice).toHaveBeenCalledTimes(1)
  })

  it('says nothing for a fresh or current database', () => {
    const fresh = vi.fn()
    expect(assertSchemaCompatible({ ...base, store: fakeStore(0, []), onNotice: fresh }))
      .toEqual({ kind: 'fresh' })
    expect(fresh).not.toHaveBeenCalled()

    const current = vi.fn()
    expect(assertSchemaCompatible({ ...base, store: fakeStore(5, ['t']), onNotice: current }))
      .toEqual({ kind: 'current' })
    expect(current).not.toHaveBeenCalled()
  })
})

describe('readUserVersion', () => {
  it('reads the pragma value', () => {
    expect(readUserVersion(fakeStore(7, []))).toBe(7)
  })

  it('treats a missing or malformed value as unversioned', () => {
    const store: SchemaVersionStore = {
      pragma: () => [{}],
      prepare: () => ({ all: () => [] }),
    }
    expect(readUserVersion(store)).toBe(UNVERSIONED_SCHEMA_VERSION)
  })

  it('rejects negative and non-integer values', () => {
    const negative: SchemaVersionStore = {
      pragma: () => [{ user_version: -4 }],
      prepare: () => ({ all: () => [] }),
    }
    expect(readUserVersion(negative)).toBe(UNVERSIONED_SCHEMA_VERSION)

    const fractional: SchemaVersionStore = {
      pragma: () => [{ user_version: 1.5 }],
      prepare: () => ({ all: () => [] }),
    }
    expect(readUserVersion(fractional)).toBe(UNVERSIONED_SCHEMA_VERSION)
  })
})

describe('writeUserVersion', () => {
  it('round-trips through the store', () => {
    const store = fakeStore(0, [])
    writeUserVersion(store, 4)
    expect(readUserVersion(store)).toBe(4)
  })

  it('refuses invalid versions rather than interpolating them into the pragma', () => {
    const store = fakeStore(0, [])
    expect(() => writeUserVersion(store, -1)).toThrow(/invalid schema version/i)
    expect(() => writeUserVersion(store, 1.5)).toThrow(/invalid schema version/i)
  })
})

describe('hasAnyUserTable', () => {
  it('is false for an empty database', () => {
    expect(hasAnyUserTable(fakeStore(0, []))).toBe(false)
  })

  it('is true when user tables exist', () => {
    expect(hasAnyUserTable(fakeStore(0, ['profiles']))).toBe(true)
  })
})

describe('inspectSchemaVersion', () => {
  it('classifies an existing pre-0.5 database as unversioned', () => {
    const inspection = inspectSchemaVersion(fakeStore(0, ['profiles', 'app_meta']))
    expect(inspection).toEqual({ found: 0, hasExistingTables: true })
    expect(classifySchemaVersion(inspection, 1)).toEqual({ kind: 'unversioned' })
  })

  it('classifies an empty file as fresh', () => {
    const inspection = inspectSchemaVersion(fakeStore(0, []))
    expect(classifySchemaVersion(inspection, 1)).toEqual({ kind: 'fresh' })
  })
})

describe('operator messages', () => {
  it('names the database, both versions, and a way forward when refusing', () => {
    const message = buildNewerSchemaMessage('app database', '/tmp/app.sqlite', 9, 3)
    expect(message).toContain('/tmp/app.sqlite')
    expect(message).toContain('9')
    expect(message).toContain('3')
    expect(message).toMatch(/upgrade/i)
  })

  it('tells the user how to reset a pre-0.5 database', () => {
    const message = buildUnversionedResetMessage('project database', '/tmp/db.sqlite')
    expect(message).toContain('/tmp/db.sqlite')
    expect(message).toMatch(/0\.5\.0/)
    expect(message).toMatch(/delete/i)
    // Must not claim the schema is untouched: the boot DDL does reconcile it.
    expect(message).toMatch(/no data migration is attempted/i)
  })

  it('explains why a too-old database is refused rather than upgraded', () => {
    const message = buildUnsupportedSchemaMessage('app database', '/tmp/app.sqlite', 1, 4)
    expect(message).toContain('/tmp/app.sqlite')
    expect(message).toContain('1')
    expect(message).toContain('4')
    expect(message).toMatch(/partially modified/i)
  })
})

describe('declared versions', () => {
  it('versions both databases independently from a positive baseline', () => {
    expect(APP_SCHEMA_VERSION).toBeGreaterThan(UNVERSIONED_SCHEMA_VERSION)
    expect(PROJECT_SCHEMA_VERSION).toBeGreaterThan(UNVERSIONED_SCHEMA_VERSION)
  })
})
