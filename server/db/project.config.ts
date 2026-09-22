import { defineConfig } from 'drizzle-kit'
import { resolve, isAbsolute, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rawDbPath = process.env.LOOPTROOP_PROJECT_DB_PATH?.trim() || '.looptroop/db.sqlite'
const projectDbPath = isAbsolute(rawDbPath) ? rawDbPath : resolve(__dirname, '..', '..', rawDbPath)

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: projectDbPath,
  },
})
