import { describe, expect, it } from 'vitest'
import {
  APP_SCHEMA_VERSION,
  IncompatibleSchemaVersionError,
  PROJECT_SCHEMA_VERSION,
  UNVERSIONED_SCHEMA_VERSION,
  appDatabaseResetInstructions,
  assertSchemaCompatible,
  buildNewerSchemaMessage,
  buildOlderSchemaMessage,
  classifySchemaVersion,
  hasAnyUserTable,
  inspectSchemaVersion,
  projectDatabaseResetInstructions,
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

  it('reports a database with tables but no version as older, not fresh', () => {
    expect(classifySchemaVersion({ found: 0, hasExistingTables: true }, 1))
      .toEqual({ kind: 'older', found: 0 })
  })

  it('reports a matching version as current', () => {
    expect(classifySchemaVersion({ found: 3, hasExistingTables: true }, 3))
      .toEqual({ kind: 'current' })
  })

  it('reports a newer database with the version it found', () => {
    expect(classifySchemaVersion({ found: 9, hasExistingTables: true }, 3))
      .toEqual({ kind: 'newer', found: 9 })
  })

  it('reports every lower version as older, including the one just below', () => {
    expect(classifySchemaVersion({ found: 4, hasExistingTables: true }, 5))
      .toEqual({ kind: 'older', found: 4 })
    expect(classifySchemaVersion({ found: 1, hasExistingTables: true }, 5))
      .toEqual({ kind: 'older', found: 1 })
  })
})

describe('shouldStampAfterInit', () => {
  it('stamps only a database this boot created', () => {
    expect(shouldStampAfterInit({ kind: 'fresh' })).toBe(true)
    expect(shouldStampAfterInit({ kind: 'current' })).toBe(false)
    expect(shouldStampAfterInit({ kind: 'older', found: 1 })).toBe(false)
    expect(shouldStampAfterInit({ kind: 'newer', found: 9 })).toBe(false)
  })
})

describe('assertSchemaCompatible', () => {
  const base = {
    databaseLabel: 'app database',
    databasePath: '/tmp/app.sqlite',
    expected: 5,
    resetInstructions: 'Delete the test database.',
  }

  function refusal(store: SchemaVersionStore): IncompatibleSchemaVersionError {
    try {
      assertSchemaCompatible({ ...base, store })
    } catch (error) {
      if (error instanceof IncompatibleSchemaVersionError) return error
      throw error
    }
    throw new Error('expected the database to be refused')
  }

  it('refuses a newer database without reset instructions', () => {
    const error = refusal(fakeStore(9, ['t']))
    expect(error.message).toMatch(/created by a newer version/)
    expect(error).toMatchObject({ databaseLabel: 'app database', databasePath: '/tmp/app.sqlite', found: 9, expected: 5, resetInstructions: '' })
  })

  it('refuses an older database and says what to delete', () => {
    const error = refusal(fakeStore(4, ['t']))
    expect(error.message).toMatch(/created by an older version/)
    expect(error.message).toContain('does not convert data')
    expect(error.message).toContain('Delete the test database.')
    expect(error).toMatchObject({ found: 4, expected: 5, resetInstructions: 'Delete the test database.' })
  })

  it('refuses a database that has tables but was never stamped', () => {
    const error = refusal(fakeStore(0, ['t']))
    expect(error.message).toContain('carries no schema version')
    expect(error.found).toBe(0)
  })

  it('never stamps a database it refused', () => {
    const store = fakeStore(4, ['t'])
    expect(() => assertSchemaCompatible({ ...base, store })).toThrow(IncompatibleSchemaVersionError)
    expect(readUserVersion(store)).toBe(4)
  })

  it('lets a fresh or current database through', () => {
    expect(assertSchemaCompatible({ ...base, store: fakeStore(0, []) })).toEqual({ kind: 'fresh' })
    expect(assertSchemaCompatible({ ...base, store: fakeStore(5, ['t']) })).toEqual({ kind: 'current' })
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
  it('classifies an existing unstamped database as older', () => {
    const inspection = inspectSchemaVersion(fakeStore(0, ['profiles', 'app_meta']))
    expect(inspection).toEqual({ found: 0, hasExistingTables: true })
    expect(classifySchemaVersion(inspection, 1)).toEqual({ kind: 'older', found: 0 })
  })

  it('classifies an empty file as fresh', () => {
    const inspection = inspectSchemaVersion(fakeStore(0, []))
    expect(classifySchemaVersion(inspection, 1)).toEqual({ kind: 'fresh' })
  })
})

describe('operator messages', () => {
  it('names the database, both versions, and a way forward when refusing a newer one', () => {
    const message = buildNewerSchemaMessage('app database', '/tmp/app.sqlite', 9, 3)
    expect(message).toContain('/tmp/app.sqlite')
    expect(message).toContain('9')
    expect(message).toContain('3')
    expect(message).toMatch(/upgrade/i)
  })

  it('names both versions and ends with the reset instructions when refusing an older one', () => {
    const message = buildOlderSchemaMessage('project database', '/tmp/db.sqlite', 2, 3, 'RESET STEPS')
    expect(message).toContain('/tmp/db.sqlite')
    expect(message).toContain('schema version 2')
    expect(message).toContain('version 3')
    expect(message).toMatch(/alpha/)
    expect(message.endsWith('RESET STEPS')).toBe(true)
  })

  it('tells the user what to delete for each database', () => {
    const app = appDatabaseResetInstructions('/cfg/app.sqlite')
    expect(app).toContain('delete /cfg/app.sqlite')
    expect(app).toContain('-wal and -shm')
    expect(app).toMatch(/attach your projects again/)

    const project = projectDatabaseResetInstructions('/repo')
    expect(project).toContain('delete the .looptroop folder in /repo')
    expect(project).toContain('git worktree prune')
    expect(project).toMatch(/ticket branches/)
    expect(project).toMatch(/attach the project again/)
  })
})

describe('declared versions', () => {
  it('versions both databases independently from a positive baseline', () => {
    expect(APP_SCHEMA_VERSION).toBeGreaterThan(UNVERSIONED_SCHEMA_VERSION)
    expect(PROJECT_SCHEMA_VERSION).toBeGreaterThan(UNVERSIONED_SCHEMA_VERSION)
  })
})
