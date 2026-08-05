import { describe, expect, it } from 'vitest'
import {
  APP_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  UNVERSIONED_SCHEMA_VERSION,
  buildNewerSchemaMessage,
  buildUnversionedResetMessage,
  classifySchemaVersion,
  hasAnyUserTable,
  inspectSchemaVersion,
  readUserVersion,
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
  })
})

describe('declared versions', () => {
  it('versions both databases independently from a positive baseline', () => {
    expect(APP_SCHEMA_VERSION).toBeGreaterThan(UNVERSIONED_SCHEMA_VERSION)
    expect(PROJECT_SCHEMA_VERSION).toBeGreaterThan(UNVERSIONED_SCHEMA_VERSION)
  })
})
