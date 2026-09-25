import { spawnSync } from 'node:child_process'
import type { ProgramLaunchPlan } from './executablePath'

const SERVE_HELP_TIMEOUT_MS = 5_000

export type OpenCodeServeLogMode = 'default' | 'all'

/** Keep the v1 log-level option when the resolved CLI supports it; v2 removed it. */
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
  if (!result.error && result.status === 0 && /^\s*--log-level(?:\s|=|$)/m.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) {
    args.push('--log-level', 'DEBUG')
  }
  return args
}
