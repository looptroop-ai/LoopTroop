type EnvLike = Record<string, string | undefined>

export interface OpenCodeBasicAuthConfig {
  username: string
  password: string
}

export function getOpenCodeBasicAuthConfig(env: EnvLike = process.env): OpenCodeBasicAuthConfig | null {
  const password = env.OPENCODE_SERVER_PASSWORD?.trim()
  if (!password) return null

  return {
    username: env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode',
    password,
  }
}

export function getOpenCodeBasicAuthHeader(env: EnvLike = process.env): string | undefined {
  const auth = getOpenCodeBasicAuthConfig(env)
  if (!auth) return undefined
  if (auth.username.includes(':')) {
    console.warn('[opencodeAuth] Basic auth username contains ":" — this will produce an invalid Authorization header. Please use a username without colons.')
    return undefined
  }
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
}

/** V2 fixes the Basic-auth username to `opencode` and prefers its new alias. */
export function getOpenCodeV2BasicAuthHeader(env: EnvLike = process.env): string | undefined {
  const password = env.OPENCODE_PASSWORD !== undefined
    ? env.OPENCODE_PASSWORD
    : env.OPENCODE_SERVER_PASSWORD
  if (password === undefined) return undefined
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
}

/** Fill only a missing alias so managed child processes work with either CLI line. */
export function withOpenCodePasswordAliases<T extends EnvLike>(env: T): T {
  const mutable = env as EnvLike
  const password = mutable.OPENCODE_PASSWORD
  const serverPassword = mutable.OPENCODE_SERVER_PASSWORD
  if (password !== undefined && serverPassword === undefined) mutable.OPENCODE_SERVER_PASSWORD = password
  if (serverPassword !== undefined && password === undefined) mutable.OPENCODE_PASSWORD = serverPassword
  return env
}
