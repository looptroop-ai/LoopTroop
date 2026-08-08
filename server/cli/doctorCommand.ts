import { execFileSync } from 'node:child_process'
import { existsSync, accessSync, constants } from 'node:fs'
import { resolveAppConfigDir } from '../lib/appConfigDir'
import { resolveSettings } from '../lib/appSettings'
import { readRunningDaemon } from './commands'

type Status = 'ok' | 'warn' | 'fail'

interface Check {
  name: string
  status: Status
  detail: string
  /** Shown only when the check is not ok. */
  remedy?: string
}

const REQUIRED_NODE_MAJOR = 24
const REQUIRED_NODE_MINOR = 15

function installHint(tool: string): string {
  switch (process.platform) {
    case 'darwin': return `brew install ${tool}`
    case 'win32': return `winget install ${tool}`
    default: return `Use your package manager, e.g. apt install ${tool}`
  }
}

function checkNode(): Check {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  const supported = major > REQUIRED_NODE_MAJOR
    || (major === REQUIRED_NODE_MAJOR && minor >= REQUIRED_NODE_MINOR)

  return supported
    ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
    : {
        name: 'node',
        status: 'fail',
        detail: `v${process.versions.node}`,
        remedy: `LoopTroop needs Node ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.0 or newer. Install it with nvm: nvm install ${REQUIRED_NODE_MAJOR}`,
      }
}

function checkBinary(name: string, args: string[], required: boolean): Check {
  try {
    const output = execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return { name, status: 'ok', detail: output.trim().split('\n')[0] ?? 'present' }
  } catch {
    return {
      name,
      status: required ? 'fail' : 'warn',
      detail: 'not found on PATH',
      remedy: installHint(name),
    }
  }
}

function checkGitHubAuth(): Check {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' })
    return { name: 'gh auth', status: 'ok', detail: 'authenticated' }
  } catch {
    return {
      name: 'gh auth',
      status: 'warn',
      detail: 'not authenticated',
      remedy: 'Run `gh auth login`. Only needed for pull-request delivery.',
    }
  }
}

function checkConfigDir(): Check {
  const configDir = resolveAppConfigDir()
  if (!existsSync(configDir)) {
    // Created on first start, so its absence is not itself a problem.
    return { name: 'config dir', status: 'ok', detail: `${configDir} (not created yet)` }
  }

  try {
    accessSync(configDir, constants.R_OK | constants.W_OK)
    return { name: 'config dir', status: 'ok', detail: configDir }
  } catch {
    return {
      name: 'config dir',
      status: 'fail',
      detail: `${configDir} is not writable`,
      remedy: 'Fix the directory permissions, or set LOOPTROOP_CONFIG_DIR to a writable path.',
    }
  }
}

async function checkOpenCode(): Promise<Check> {
  const settings = resolveSettings()
  if (settings.opencodeMode === 'mock') {
    return { name: 'opencode', status: 'ok', detail: 'mock mode' }
  }

  try {
    const response = await fetch(`${settings.opencodeBaseUrl}/config`, {
      signal: AbortSignal.timeout(2_000),
    })
    return response.ok
      ? { name: 'opencode', status: 'ok', detail: `reachable at ${settings.opencodeBaseUrl}` }
      : {
          name: 'opencode',
          status: 'warn',
          detail: `responded ${response.status} at ${settings.opencodeBaseUrl}`,
          remedy: 'Check the OpenCode server logs.',
        }
  } catch {
    return {
      name: 'opencode',
      status: 'warn',
      detail: `not reachable at ${settings.opencodeBaseUrl}`,
      remedy: 'Start it with `opencode serve`, or install it from https://opencode.ai',
    }
  }
}

async function checkDaemon(): Promise<Check> {
  const state = await readRunningDaemon()
  return state
    ? { name: 'daemon', status: 'ok', detail: `running on http://${state.host}:${state.port} (pid ${state.pid})` }
    : { name: 'daemon', status: 'ok', detail: 'not running' }
}

export async function runChecks(): Promise<Check[]> {
  return [
    checkNode(),
    checkBinary('git', ['--version'], true),
    checkBinary('gh', ['--version'], false),
    checkGitHubAuth(),
    checkConfigDir(),
    await checkOpenCode(),
    await checkDaemon(),
  ]
}

export async function doctorCommand(json: boolean): Promise<number> {
  const checks = await runChecks()
  const failed = checks.some((check) => check.status === 'fail')

  if (json) {
    // Only JSON on stdout, so the output can be piped into a parser.
    process.stdout.write(`${JSON.stringify({ ok: !failed, checks }, null, 2)}\n`)
    return failed ? 1 : 0
  }

  const symbol: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗' }
  for (const check of checks) {
    process.stdout.write(`${symbol[check.status]} ${check.name.padEnd(12)} ${check.detail}\n`)
    if (check.status !== 'ok' && check.remedy) {
      process.stdout.write(`  ↳ ${check.remedy}\n`)
    }
  }

  process.stdout.write(failed
    ? '\nLoopTroop cannot run until the failures above are fixed.\n'
    : '\nThis machine can run LoopTroop.\n')

  return failed ? 1 : 0
}
