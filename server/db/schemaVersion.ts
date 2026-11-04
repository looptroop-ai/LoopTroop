/**
 * Schema versioning for both SQLite databases.
 *
 * LoopTroop is in alpha and does not upgrade data written by another version.
 * A database is either fresh (created and stamped now) or at exactly the version
 * this build writes; anything else, older or newer, is refused before any DDL runs,
 * with a message that says what to delete to start fresh.
 *
 * The two databases version independently: they evolve in separate code paths
 * and a project database can be older than the app database that opens it.
 */

/** Bump when the app database schema changes. Every other version is refused. */
export const APP_SCHEMA_VERSION = 3

/** Bump when the project database schema changes. Every other version is refused. */
export const PROJECT_SCHEMA_VERSION = 3

/** What `PRAGMA user_version` reads before anything was stamped. */
export const UNVERSIONED_SCHEMA_VERSION = 0

/** The names the operator messages use for the two databases. */
export const APP_DATABASE_LABEL = 'app database'
export const PROJECT_DATABASE_LABEL = 'project database'

export type SchemaCompatibility =
  | { kind: 'fresh' }
  | { kind: 'current' }
  | { kind: 'older'; found: number }
  | { kind: 'newer'; found: number }

export interface SchemaVersionInspection {
  found: number
  hasExistingTables: boolean
}

/**
 * Classifies a database before anything mutates it.
 *
 * `hasExistingTables` tells a brand-new file (version 0, no tables) from one
 * written before versions were stamped (version 0, tables present): only the
 * first is fresh; the second is older and refused.
 */
export function classifySchemaVersion(
  inspection: SchemaVersionInspection,
  expected: number,
): SchemaCompatibility {
  const { found, hasExistingTables } = inspection
  if (found === UNVERSIONED_SCHEMA_VERSION && !hasExistingTables) return { kind: 'fresh' }
  if (found === expected) return { kind: 'current' }
  if (found > expected) return { kind: 'newer', found }
  return { kind: 'older', found }
}

/** True when the boot DDL should stamp the current version after it runs. */
export function shouldStampAfterInit(compatibility: SchemaCompatibility): boolean {
  return compatibility.kind === 'fresh'
}

/** How to start fresh after the app database was refused. */
export function appDatabaseResetInstructions(databasePath: string): string {
  return `To start fresh, delete ${databasePath} and the -wal and -shm files next to it, then attach your projects again.`
}

/**
 * How to start fresh after a project database was refused. The whole `.looptroop`
 * folder goes, because its ticket folders belong to the old tickets; old ticket
 * branches would otherwise be picked up by new tickets that get the same IDs.
 */
export function projectDatabaseResetInstructions(projectRoot: string): string {
  return [
    `To start fresh, delete the .looptroop folder in ${projectRoot}, run "git worktree prune" there,`,
    'delete the old ticket branches you no longer need (new tickets reuse a branch with their ID), and attach the project again.',
  ].join(' ')
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

export function buildOlderSchemaMessage(
  databaseLabel: string,
  databasePath: string,
  found: number,
  expected: number,
  resetInstructions: string,
): string {
  const written = found === UNVERSIONED_SCHEMA_VERSION ? 'carries no schema version' : `reports schema version ${found}`
  return [
    `The ${databaseLabel} at ${databasePath} was created by an older version of LoopTroop: it ${written}, and this build uses version ${expected}.`,
    'LoopTroop is in alpha and does not convert data from older versions, so it stopped without changing anything.',
    resetInstructions,
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
  /** What to delete to start fresh; empty for a newer database, which only needs a newer LoopTroop. */
  resetInstructions: string
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
  readonly resetInstructions: string

  constructor(message: string, details: IncompatibleSchemaDetails) {
    super(message)
    this.name = 'IncompatibleSchemaVersionError'
    this.databaseLabel = details.databaseLabel
    this.databasePath = details.databasePath
    this.found = details.found
    this.expected = details.expected
    this.resetInstructions = details.resetInstructions
  }
}

export interface AssertSchemaCompatibleArgs {
  store: SchemaVersionStore
  databaseLabel: string
  databasePath: string
  expected: number
  /** What the refusal tells the operator to delete; see the reset-instruction helpers. */
  resetInstructions: string
}

/**
 * Shared guard for both database boot paths: classifies before anything
 * mutates, refuses every database not written by this schema version, and
 * returns the compatibility so the caller knows whether to stamp after its DDL.
 */
export function assertSchemaCompatible(args: AssertSchemaCompatibleArgs): SchemaCompatibility {
  const { store, databaseLabel, databasePath, expected, resetInstructions } = args
  const compatibility = classifySchemaVersion(inspectSchemaVersion(store), expected)

  if (compatibility.kind === 'newer') {
    throw new IncompatibleSchemaVersionError(
      buildNewerSchemaMessage(databaseLabel, databasePath, compatibility.found, expected),
      { databaseLabel, databasePath, found: compatibility.found, expected, resetInstructions: '' },
    )
  }

  if (compatibility.kind === 'older') {
    throw new IncompatibleSchemaVersionError(
      buildOlderSchemaMessage(databaseLabel, databasePath, compatibility.found, expected, resetInstructions),
      { databaseLabel, databasePath, found: compatibility.found, expected, resetInstructions },
    )
  }

  return compatibility
}
