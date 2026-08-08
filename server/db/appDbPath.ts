import { isAbsolute, resolve } from 'node:path'
import { resolveAppConfigDir } from '../lib/appConfigDir'

export const APP_DB_FILE_NAME = 'app.sqlite'

/**
 * Where the application database lives.
 *
 * Separate from `db/index` so a command that only needs to *name* the file — a
 * setup summary, a backup hint — does not have to import the driver, the schema
 * and Drizzle to learn one string.
 */
export function resolveAppDbPath(configDir = resolveAppConfigDir()): string {
  const configured = process.env.LOOPTROOP_APP_DB_PATH?.trim()
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured)
  }
  return resolve(configDir, APP_DB_FILE_NAME)
}
