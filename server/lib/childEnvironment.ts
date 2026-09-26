/** Credentials never belong in a project/tool child. */
const PRIVATE_ENV_NAMES = new Set([
  'LOOPTROOP_API_TOKEN',
  'LOOPTROOP_DEV_EVENT_TOKEN',
  'OPENCODE_PASSWORD',
  'OPENCODE_SERVER_PASSWORD',
])

const OPENCODE_AUTH_ENV_NAMES = new Set(['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD'])
const OPENCODE_AUTH_ENV_KEYS = ['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD'] as const

/** Drops OpenCode passwords from a child environment without changing its other settings. */
export function withoutOpenCodeCredentials(
  source: NodeJS.ProcessEnv,
  windows = process.platform === 'win32',
): NodeJS.ProcessEnv {
  const environment = { ...source }
  for (const name of Object.keys(environment)) {
    if (OPENCODE_AUTH_ENV_NAMES.has(name)
      || (windows && OPENCODE_AUTH_ENV_NAMES.has(name.toUpperCase()))) {
      delete environment[name]
    }
  }
  return environment
}

/** Masks OpenCode passwords so an env overlay can remove them from an inherited parent env. */
export function maskOpenCodeCredentials(
  source: NodeJS.ProcessEnv,
  windows = process.platform === 'win32',
): NodeJS.ProcessEnv {
  const environment = withoutOpenCodeCredentials(source, windows)
  for (const name of Object.keys(source)) {
    if (OPENCODE_AUTH_ENV_NAMES.has(name)
      || (windows && OPENCODE_AUTH_ENV_NAMES.has(name.toUpperCase()))) {
      environment[name] = undefined
    }
  }
  environment.OPENCODE_PASSWORD = undefined
  environment.OPENCODE_SERVER_PASSWORD = undefined
  return environment
}

/**
 * Copies an environment and removes LoopTroop and OpenCode credentials from a
 * project/tool child. Windows environment names are case-insensitive; POSIX
 * names are not.
 */
export function createChildEnvironment(
  source: NodeJS.ProcessEnv,
  windows = process.platform === 'win32',
): NodeJS.ProcessEnv {
  const environment = withoutOpenCodeCredentials(source, windows)
  for (const name of Object.keys(environment)) {
    if (PRIVATE_ENV_NAMES.has(name)
      || (windows && PRIVATE_ENV_NAMES.has(name.toUpperCase()))) {
      delete environment[name]
    }
  }
  return environment
}

/** Creates the sanitized child environment with only OpenCode server auth restored. */
export function createOpenCodeServerEnvironment(
  source: NodeJS.ProcessEnv,
  windows = process.platform === 'win32',
): NodeJS.ProcessEnv {
  const environment = createChildEnvironment(source, windows)
  for (const name of OPENCODE_AUTH_ENV_KEYS) {
    const sourceName = Object.keys(source).find((key) => windows ? key.toUpperCase() === name : key === name)
    const value = sourceName === undefined ? undefined : source[sourceName]
    if (value !== undefined) environment[name] = value
  }
  return environment
}
