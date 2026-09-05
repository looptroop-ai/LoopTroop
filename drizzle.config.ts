import appConfig from './drizzle.app.config'

/**
 * The default Drizzle target for ad-hoc CLI usage, which is the *app* database.
 *
 * There are two, and they are not interchangeable:
 *
 * - `drizzle.app.config.ts` → `~/.looptroop/app.sqlite`, one per machine, holding
 *   projects, profiles and settings.
 * - `drizzle.project.config.ts` → `<project>/.looptroop/db.sqlite`, one per
 *   project, holding that project's tickets and their state.
 *
 * A `drizzle-kit` command run without `--config` lands here, so it lands on the
 * app database. Pass the project config explicitly for per-project commands.
 */
export default appConfig
