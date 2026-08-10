/**
 * Schema versioning for both SQLite databases.
 *
 * Pre-0.5 databases carry no version marker. They are disposable test data and
 * are stamped with the current version on first open. From 0.5.0 onward the
 * version is authoritative: a database written by a newer LoopTroop is refused
 * rather than opened, because the boot path mutates schema destructively
 * (migrateLegacyProfilesTable drops and recreates `profiles`) and an older
 * binary cannot know what a newer one added.
 *
 * The two databases version independently: they evolve in separate code paths
 * and a project database can be much older than the app database that opens it.
 */

/** Bump when the app database schema changes in a way older builds cannot read. */
export const APP_SCHEMA_VERSION = 1

/** Bump when the project database schema changes in a way older builds cannot read. */
export const PROJECT_SCHEMA_VERSION = 1

/** Version recorded for databases created before schema versioning existed. */
export const UNVERSIONED_SCHEMA_VERSION = 0

/**
 * Oldest version the idempotent boot DDL can still bring forward.
 *
 * Raise this in the same change that introduces a schema step needing real data
 * migration rather than additive DDL. Databases below the floor are refused
 * instead of being half-upgraded.
 */
export const APP_MIGRATABLE_FROM = 1
export const PROJECT_MIGRATABLE_FROM = 1

export type SchemaCompatibility =
  | { kind: 'fresh' }
  | { kind: 'unversioned' }
  | { kind: 'current' }
  | { kind: 'older'; found: number }
  | { kind: 'unsupported'; found: number }
  | { kind: 'newer'; found: number }

export interface SchemaVersionInspection {
  found: number
  hasExistingTables: boolean
}

/**
 * Classifies a database before anything mutates it.
 *
 * `hasExistingTables` distinguishes a brand-new file (version 0, no tables)
 * from a pre-0.5 database (version 0, tables present). Both read as 0, but only
 * the latter needs the reset message.
 */
export function classifySchemaVersion(
  inspection: SchemaVersionInspection,
  expected: number,
  migratableFrom: number = 1,
): SchemaCompatibility {
  const { found, hasExistingTables } = inspection

  if (found === UNVERSIONED_SCHEMA_VERSION) {
    if (!hasExistingTables) return { kind: 'fresh' }
    return { kind: 'unversioned' }
  }

  if (found === expected) return { kind: 'current' }
  if (found > expected) return { kind: 'newer', found }
  if (found < migratableFrom) return { kind: 'unsupported', found }
  return { kind: 'older', found }
}

/** True when the boot DDL should stamp the current version after it runs. */
export function shouldStampAfterInit(compatibility: SchemaCompatibility): boolean {
  return compatibility.kind === 'fresh'
    || compatibility.kind === 'unversioned'
    || compatibility.kind === 'older'
}

export function buildNewerSchemaMessage(
  databaseLabel: string,
  databasePath: string,
  found: number,
  expected: number,
): string {
  return [
    `The ${databaseLabel} at ${databasePath} was created by a newer version of LoopTroop.`,
    `It reports schema version ${found}; this build supports version ${expected}.`,
    'Opening it with this build could corrupt or delete data, so LoopTroop stopped instead.',
    'Upgrade LoopTroop to the version that created this database, or point LoopTroop at a different location.',
  ].join('\n')
}

export function buildUnversionedResetMessage(
  databaseLabel: string,
  databasePath: string,
): string {
  return [
    `The ${databaseLabel} at ${databasePath} predates LoopTroop 0.5.0 and carries no schema version.`,
    'Its schema will be reconciled by the standard startup DDL, which only adds missing',
    'tables and columns; no data migration is attempted. It is then stamped with the current',
    'schema version. If LoopTroop misbehaves, delete that file and restart to begin clean.',
  ].join('\n')
}

export function buildOlderSchemaMessage(
  databaseLabel: string,
  found: number,
  expected: number,
): string {
  return `Upgrading ${databaseLabel} schema from version ${found} to ${expected}.`
}

export function buildUnsupportedSchemaMessage(
  databaseLabel: string,
  databasePath: string,
  found: number,
  migratableFrom: number,
): string {
  return [
    `The ${databaseLabel} at ${databasePath} reports schema version ${found}.`,
    `This build can only upgrade databases from version ${migratableFrom} onward.`,
    'Upgrading it here would leave it partially modified, so LoopTroop stopped instead.',
    'Delete that file to start from a clean database, or run an older LoopTroop first.',
  ].join('\n')
}

/** Minimal surface shared by better-sqlite3 and node:sqlite, to ease the 0.9 swap. */
export interface SchemaVersionStore {
  pragma(source: string): unknown
  prepare(source: string): { all(...params: unknown[]): unknown[] }
}

export function readUserVersion(store: SchemaVersionStore): number {
  const result = store.pragma('user_version')
  const row = Array.isArray(result) ? result[0] : result
  const value = typeof row === 'object' && row !== null
    ? (row as { user_version?: unknown }).user_version
    : row
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

export function writeUserVersion(store: SchemaVersionStore, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Refusing to write invalid schema version: ${version}`)
  }
  // Interpolated because PRAGMA does not accept bound parameters; the guard
  // above constrains this to a non-negative integer.
  store.pragma(`user_version = ${version}`)
}

export function hasAnyUserTable(store: SchemaVersionStore): boolean {
  const rows = store
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .all()
  return rows.length > 0
}

export function inspectSchemaVersion(store: SchemaVersionStore): SchemaVersionInspection {
  return {
    found: readUserVersion(store),
    hasExistingTables: hasAnyUserTable(store),
  }
}

export interface IncompatibleSchemaDetails {
  /** Which of the two databases, in the words the operator messages use. */
  databaseLabel: string
  databasePath: string
  found: number
  expected: number
  migratableFrom: number
}

/**
 * Carries the facts, not only the prose.
 *
 * The message is written for a person, but the same refusal has to outlive the
 * process that hit it: the daemon dies, and a later `status` or `doctor` has to
 * be able to say which database was refused, what it reports, and what this
 * build accepts — and to re-check whether that is still true. Re-deriving any
 * of that by parsing the message would break the first time the wording did.
 */
export class IncompatibleSchemaVersionError extends Error {
  readonly databaseLabel: string
  readonly databasePath: string
  readonly found: number
  readonly expected: number
  readonly migratableFrom: number

  constructor(message: string, details: IncompatibleSchemaDetails) {
    super(message)
    this.name = 'IncompatibleSchemaVersionError'
    this.databaseLabel = details.databaseLabel
    this.databasePath = details.databasePath
    this.found = details.found
    this.expected = details.expected
    this.migratableFrom = details.migratableFrom
  }
}

export interface AssertSchemaCompatibleArgs {
  store: SchemaVersionStore
  databaseLabel: string
  databasePath: string
  expected: number
  migratableFrom: number
  onNotice: (message: string) => void
}

/**
 * Shared guard for both database boot paths: classifies before anything
 * mutates, refuses what cannot be upgraded safely, and returns the
 * compatibility so the caller knows whether to stamp once DDL has run.
 */
export function assertSchemaCompatible(args: AssertSchemaCompatibleArgs): SchemaCompatibility {
  const { store, databaseLabel, databasePath, expected, migratableFrom, onNotice } = args
  const compatibility = classifySchemaVersion(inspectSchemaVersion(store), expected, migratableFrom)

  if (compatibility.kind === 'newer') {
    throw new IncompatibleSchemaVersionError(
      buildNewerSchemaMessage(databaseLabel, databasePath, compatibility.found, expected),
      { databaseLabel, databasePath, found: compatibility.found, expected, migratableFrom },
    )
  }

  if (compatibility.kind === 'unsupported') {
    throw new IncompatibleSchemaVersionError(
      buildUnsupportedSchemaMessage(databaseLabel, databasePath, compatibility.found, migratableFrom),
      { databaseLabel, databasePath, found: compatibility.found, expected, migratableFrom },
    )
  }

  if (compatibility.kind === 'unversioned') {
    onNotice(buildUnversionedResetMessage(databaseLabel, databasePath))
  }

  if (compatibility.kind === 'older') {
    onNotice(buildOlderSchemaMessage(databaseLabel, compatibility.found, expected))
  }

  return compatibility
}
