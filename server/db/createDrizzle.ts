import type { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
import * as schema from './schema'

/**
 * Builds a Drizzle instance bound to the full schema.
 *
 * Drizzle 1.0 RC dropped `schema` from the config type while still accepting it
 * at runtime, so every construction site needs the same assertion. Doing it once
 * here means the day the published types catch up there is a single line to
 * change instead of one compile error per call site — and no `@ts-expect-error`
 * left behind to go stale silently.
 */
export type DrizzleDatabase = ReturnType<typeof drizzle>

export function createDrizzle(client: DatabaseSync): DrizzleDatabase {
  // @ts-expect-error Drizzle 1.0 RC removes `schema` from the config type but accepts it at runtime
  return drizzle({ client, schema })
}
