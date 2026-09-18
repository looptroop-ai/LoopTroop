/** Internal daemon credentials never belong in a project/tool child. */
const DAEMON_SECRET_ENV_NAMES = new Set([
  'LOOPTROOP_API_TOKEN',
  'LOOPTROOP_DEV_EVENT_TOKEN',
])

/**
 * Copies an environment and removes only LoopTroop's own control credentials.
 * Windows environment names are case-insensitive; POSIX names are not.
 */
export function createChildEnvironment(
  source: NodeJS.ProcessEnv,
  windows = process.platform === 'win32',
): NodeJS.ProcessEnv {
  const environment = { ...source }
  for (const name of Object.keys(environment)) {
    if (DAEMON_SECRET_ENV_NAMES.has(name)
      || (windows && DAEMON_SECRET_ENV_NAMES.has(name.toUpperCase()))) {
      delete environment[name]
    }
  }
  return environment
}
