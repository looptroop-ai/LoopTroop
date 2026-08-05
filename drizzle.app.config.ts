import { defineConfig } from 'drizzle-kit'
import { isAbsolute, resolve } from 'node:path'
import { resolveAppConfigDir } from './server/lib/appConfigDir.js'

function resolveAppDbPath(): string {
  const configuredDbPath = process.env.LOOPTROOP_APP_DB_PATH?.trim()
  if (configuredDbPath) {
    return isAbsolute(configuredDbPath) ? configuredDbPath : resolve(process.cwd(), configuredDbPath)
  }
  return resolve(resolveAppConfigDir(), 'app.sqlite')
}

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: resolveAppDbPath(),
  },
})
