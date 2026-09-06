import { LOOPTROOP_OPENCODE_LOGS_ENV } from '../shared/opencodeLogMode.ts'

export const NPM_CONFIG_OPENCODE_LOGS = 'npm_config_opencode_logs'

export type OpenCodeLogMode = 'default' | 'all'
export type OpenCodeLogModeSource = 'npm-config' | 'env'

export type ResolvedOpenCodeLogMode = {
  mode: OpenCodeLogMode
  requested: boolean
  serveArgs: string[]
  source?: OpenCodeLogModeSource
}

type ResolveOpenCodeLogModeOptions = {
  env?: Partial<Record<string, string | undefined>>
}

const ALL_LOGS_VALUE = 'all'

function normalizeLogModeValue(value: string) {
  return value.trim().toLowerCase()
}

function assertAllLogsValue(value: string, source: OpenCodeLogModeSource) {
  const normalized = normalizeLogModeValue(value)
  if (normalized === ALL_LOGS_VALUE) {
    return normalized
  }

  let sourceHint: string
  if (source === 'npm-config') {
    sourceHint = 'npm run dev --opencode-logs=all'
  } else {
    sourceHint = `${LOOPTROOP_OPENCODE_LOGS_ENV}=all`
  }
  throw new Error(`Invalid OpenCode log mode "${value}". Use ${sourceHint}.`)
}

export function resolveOpenCodeLogMode({
  env = process.env,
}: ResolveOpenCodeLogModeOptions = {}): ResolvedOpenCodeLogMode {
  const npmConfigValue = env[NPM_CONFIG_OPENCODE_LOGS]?.trim()
  if (npmConfigValue) {
    assertAllLogsValue(npmConfigValue, 'npm-config')
    return {
      mode: 'all',
      requested: true,
      serveArgs: ['--print-logs', '--log-level', 'DEBUG'],
      source: 'npm-config',
    }
  }

  const envValue = env[LOOPTROOP_OPENCODE_LOGS_ENV]?.trim()
  if (envValue) {
    assertAllLogsValue(envValue, 'env')
    return {
      mode: 'all',
      requested: true,
      serveArgs: ['--print-logs', '--log-level', 'DEBUG'],
      source: 'env',
    }
  }

  return {
    mode: 'default',
    requested: false,
    serveArgs: ['--log-level', 'DEBUG'],
  }
}
