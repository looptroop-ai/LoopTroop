import { spawnSync } from 'node:child_process'
import type { ProgramLaunchPlan } from './executablePath'

const SERVE_HELP_TIMEOUT_MS = 5_000

export type OpenCodeServeLogMode = 'default' | 'all'

function debugLogLevel(help: string): string | undefined {
  const option = help.split(/\r?\n/).find((line) => /^[ \t]*--log-level(?:[ \t]|=|$)/.test(line))
  if (!option) return undefined

  const values = option.match(/<([^<>]+)>/)?.[1]?.split('|').map((value) => value.trim())
  if (!values || (values.length === 1 && values[0]?.toLowerCase() === 'level')) return 'DEBUG'
  return values.find((value) => value.toLowerCase() === 'debug')
}

/** Use the debug spelling advertised by the resolved CLI, retaining v1's uppercase default. */
export function getOpenCodeServeLogArgs(
  mode: OpenCodeServeLogMode,
  helpLaunch: ProgramLaunchPlan,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args = mode === 'all' ? ['--print-logs'] : []
  if ('reason' in helpLaunch) return args

  const result = spawnSync(helpLaunch.file, helpLaunch.args, {
    encoding: 'utf8',
    env,
    maxBuffer: 1024 * 1024,
    timeout: SERVE_HELP_TIMEOUT_MS,
    windowsVerbatimArguments: helpLaunch.windowsVerbatimArguments,
  })
  if (!result.error && result.status === 0) {
    const level = debugLogLevel(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    if (level) args.push('--log-level', level)
  }
  return args
}
