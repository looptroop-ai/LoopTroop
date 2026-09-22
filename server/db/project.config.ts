import { defineConfig } from 'drizzle-kit'
import { isAbsolute, resolve } from 'node:path'

const rawDbPath = process.env.LOOPTROOP_PROJECT_DB_PATH?.trim() || '.looptroop/db.sqlite'
const projectDbPath = isAbsolute(rawDbPath) ? rawDbPath : resolve(process.cwd(), rawDbPath)

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: projectDbPath,
  },
})
