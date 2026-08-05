import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, realpathSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { resolveBaseBranch } from '../git/repository'
import { logCommand } from '../log/commandLogger'

function logCmd(
  bin: string,
  args: string[],
  result:
    | { ok: true; stdin?: string; stdout?: string; stderr?: string }
    | { ok: false; error: string; stdin?: string; stdout?: string; stderr?: string },
) {
  logCommand(bin, args, result)
}

export function normalizeFolderPath(input: string): string {
  let output = input.trim().replace(/[\\/]+$/, '')
  output = output.replace(/\\/g, '/')
  // Drive letters only map to /mnt/<drive> under WSL. On native Windows the
  // drive-letter path is already correct and rewriting it breaks every lookup.
  if (process.platform !== 'win32') {
    const driveMatch = output.match(/^([A-Za-z]):\/(.*)$/)
    if (driveMatch && driveMatch[1] && driveMatch[2] !== undefined) {
      output = `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`
    }
  }
  if (!isAbsolute(output)) {
    output = resolve(process.cwd(), output)
  }
  // Canonicalise symlinks so one directory always compares equal to itself:
  // macOS maps /var to /private/var, so a stored path and the output of
  // `git rev-parse --show-toplevel` otherwise disagree.
  try {
    output = realpathSync(output).replace(/\\/g, '/')
  } catch {
    // Not created yet, so the lexical form is the best available answer.
  }
  return output
}

export function resolveGitRepoRoot(folderPath: string): string | null {
  const normalized = normalizeFolderPath(folderPath)
  if (!existsSync(normalized)) return null
  const fullArgs = ['-C', normalized, 'rev-parse', '--show-toplevel']
  const result = spawnSync('git', fullArgs, { encoding: 'utf8' })
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  if (result.status !== 0 || result.error) {
    logCmd('git', fullArgs, {
      ok: false,
      error: result.error?.message ?? `exit code ${result.status ?? '?'}`,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    })
    return null
  }
  logCmd('git', fullArgs, { ok: true, stdout: stdout || undefined, stderr: stderr || undefined })
  return normalizeFolderPath(stdout)
}

export function detectGitBaseBranch(projectRoot: string): string {
  return resolveBaseBranch(projectRoot)
}

export function getProjectLoopTroopDir(projectRoot: string): string {
  return resolve(projectRoot, '.looptroop')
}

export function getProjectDbPath(projectRoot: string): string {
  return resolve(getProjectLoopTroopDir(projectRoot), 'db.sqlite')
}

export function getProjectWorktreesRoot(projectRoot: string): string {
  return resolve(getProjectLoopTroopDir(projectRoot), 'worktrees')
}

export function getTicketWorktreePath(projectRoot: string, externalId: string): string {
  return resolve(getProjectWorktreesRoot(projectRoot), externalId)
}

export function getTicketDir(projectRoot: string, externalId: string): string {
  return resolve(getTicketWorktreePath(projectRoot, externalId), '.ticket')
}

export function getTicketRuntimeDir(projectRoot: string, externalId: string): string {
  return resolve(getTicketDir(projectRoot, externalId), 'runtime')
}

export function getTicketExecutionLogPath(projectRoot: string, externalId: string): string {
  return resolve(getTicketRuntimeDir(projectRoot, externalId), 'execution-log.jsonl')
}

export function getTicketDebugLogPath(projectRoot: string, externalId: string): string {
  return resolve(getTicketRuntimeDir(projectRoot, externalId), 'execution-log.debug.jsonl')
}

export function getTicketAiLogPath(projectRoot: string, externalId: string): string {
  return resolve(getTicketRuntimeDir(projectRoot, externalId), 'execution-log.ai.jsonl')
}

export function getTicketExecutionSetupDir(projectRoot: string, externalId: string): string {
  return resolve(getTicketRuntimeDir(projectRoot, externalId), 'execution-setup')
}

export function getTicketExecutionSetupProfilePath(projectRoot: string, externalId: string): string {
  return resolve(getTicketRuntimeDir(projectRoot, externalId), 'execution-setup-profile.json')
}

export function ensureProjectStorageDirs(projectRoot: string) {
  mkdirSync(getProjectLoopTroopDir(projectRoot), { recursive: true })
  mkdirSync(getProjectWorktreesRoot(projectRoot), { recursive: true })
}
