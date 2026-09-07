import appConfig from './drizzle.app.config'

/**
 * The default Drizzle target for ad-hoc CLI usage, which is the *app* database.
 *
 * There are two, and they are not interchangeable:
 *
 * - `drizzle.app.config.ts` → `app.sqlite` in the config directory
 *   `resolveAppConfigDir()` picks — `%APPDATA%\looptroop` on Windows,
 *   `$XDG_CONFIG_HOME/looptroop` or `~/.config/looptroop` elsewhere, or
 *   `LOOPTROOP_CONFIG_DIR` when it is set. One per machine, holding projects,
 *   profiles and settings. `LOOPTROOP_APP_DB_PATH` overrides the file outright.
 * - `drizzle.project.config.ts` → `<project>/.looptroop/db.sqlite`, one per
 *   project, holding that project's tickets and their state.
 *
 * A `drizzle-kit` command run without `--config` lands here, so it lands on the
 * app database. Pass the project config explicitly for per-project commands.
 */
export default appConfig
