import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { runGitSync } from './runCommand'
import type { DetectedGitHookPayload, GitHookValidationCommandPayload } from '../structuredOutput/types'

const STANDARD_HOOKS = new Set([
  'applypatch-msg', 'commit-msg', 'fsmonitor-watchman', 'post-applypatch', 'post-checkout',
  'post-commit', 'post-merge', 'post-receive', 'post-rewrite', 'post-update', 'pre-applypatch',
  'pre-auto-gc', 'pre-commit', 'pre-merge-commit', 'pre-push', 'pre-rebase', 'pre-receive',
  'prepare-commit-msg', 'push-to-checkout', 'reference-transaction', 'update',
])

/** Local plumbing; a non-zero exit is an expected answer here, hence `null`. */
function runGit(worktreePath: string, args: string[]): string | null {
  const result = runGitSync(worktreePath, args)
  return result.ok ? result.stdout || null : null
}

function displayPath(worktreePath: string, path: string): string {
  const rel = relative(worktreePath, path).replace(/\\/g, '/')
  return rel && !rel.startsWith('../') ? rel : path.replace(/\\/g, '/')
}

function runnable(path: string): 'yes' | 'no' | 'unknown' {
  if (process.platform === 'win32') return 'unknown'
  try {
    return (statSync(path).mode & 0o111) !== 0 ? 'yes' : 'no'
  } catch {
    return 'unknown'
  }
}

function managerHintForPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  if (normalized.includes('/.husky/')) return 'husky'
  if (normalized.includes('lefthook')) return 'lefthook'
  if (normalized.includes('pre-commit')) return 'pre-commit'
  if (normalized.includes('overcommit')) return 'overcommit'
  return undefined
}

function listHookFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.endsWith('.sample') && STANDARD_HOOKS.has(entry.name))
      .map((entry) => resolve(directory, entry.name))
  } catch {
    return []
  }
}

export interface GitHookDiscoveryResult {
  configuredHooksPath: string | null
  detected: DetectedGitHookPayload[]
  suggestedValidationCommands: GitHookValidationCommandPayload[]
}

/**
 * Reads the hook evidence recorded on an approved execution-setup profile.
 *
 * The integration boundary compared its own ad-hoc read of this list against a
 * fresh discovery with `JSON.stringify`, which makes the comparison depend on
 * array order and on the order the keys happen to be serialised in. Two runs
 * that found exactly the same hooks could therefore be reported as drift.
 */
export function readApprovedGitHookEvidence(profileContent: string): DetectedGitHookPayload[] {
  try {
    const profile = JSON.parse(profileContent) as Record<string, unknown>
    const hooks = (profile.git_hooks ?? profile.gitHooks) as Record<string, unknown> | undefined
    return normalizeGitHookEvidence(hooks?.detected)
  } catch {
    return []
  }
}

/**
 * A stable projection of hook evidence: known fields only, in a fixed key
 * order, sorted by the identity of the hook. Malformed entries are dropped
 * rather than compared, so a legacy or hand-edited profile cannot register as
 * drift purely by being unreadable.
 */
export function normalizeGitHookEvidence(value: unknown): DetectedGitHookPayload[] {
  if (!Array.isArray(value)) return []
  const entries = value.flatMap((entry): DetectedGitHookPayload[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name : ''
    const path = typeof record.path === 'string' ? record.path : ''
    if (!name || !path) return []
    const kind = record.kind === 'manager_config' ? 'manager_config' as const : 'hook' as const
    const runnableValue = record.runnable
    const managerHint = typeof record.managerHint === 'string' ? record.managerHint : undefined
    return [{
      name,
      path,
      source: typeof record.source === 'string' ? record.source : '',
      kind,
      runnable: runnableValue === 'yes' || runnableValue === 'no' ? runnableValue : 'unknown',
      ...(managerHint ? { managerHint } : {}),
    }]
  })
  return entries.sort((left, right) => (
    left.path.localeCompare(right.path) || left.name.localeCompare(right.name)
  ))
}

/** True when two hook-evidence lists describe the same hooks. */
export function gitHookEvidenceMatches(approved: unknown, current: unknown): boolean {
  return JSON.stringify(normalizeGitHookEvidence(approved))
    === JSON.stringify(normalizeGitHookEvidence(current))
}

/** Read-only, language-agnostic audit of Git hooks and common hook-manager manifests. */
export function discoverGitHooks(worktreePath: string): GitHookDiscoveryResult {
  const configuredHooksPath = runGit(worktreePath, ['config', '--get', 'core.hooksPath'])
  const resolvedConfiguredPath = configuredHooksPath
    ? (isAbsolute(configuredHooksPath) ? configuredHooksPath : resolve(worktreePath, configuredHooksPath))
    : null
  const gitHooksPathRaw = runGit(worktreePath, ['rev-parse', '--git-path', 'hooks'])
  const gitHooksPath = gitHooksPathRaw
    ? (isAbsolute(gitHooksPathRaw) ? gitHooksPathRaw : resolve(worktreePath, gitHooksPathRaw))
    : null

  const candidates = new Map<string, {
    source: string
    kind: 'hook' | 'manager_config'
    managerHint?: string
  }>()
  const addHooks = (directory: string | null, source: string) => {
    if (!directory) return
    for (const path of listHookFiles(directory)) {
      if (!candidates.has(path)) {
        candidates.set(path, { source, kind: 'hook', managerHint: managerHintForPath(path) })
      }
    }
  }
  addHooks(resolvedConfiguredPath, configuredHooksPath ? 'core.hooksPath' : 'git-hooks-directory')
  if (!resolvedConfiguredPath || resolvedConfiguredPath !== gitHooksPath) {
    addHooks(gitHooksPath, 'git-hooks-directory')
  }
  for (const directory of ['.husky', '.githooks']) {
    addHooks(resolve(worktreePath, directory), 'committed-hook-directory')
  }

  const manifests = [
    { names: ['.pre-commit-config.yaml', '.pre-commit-config.yml'], hook: 'pre-commit', manager: 'pre-commit', program: 'pre-commit', args: ['run', '--all-files'] },
    { names: ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml'], hook: 'pre-commit', manager: 'lefthook', program: 'lefthook', args: ['run', 'pre-commit'] },
    { names: ['.overcommit.yml'], hook: 'pre-commit', manager: 'overcommit', program: 'overcommit', args: ['--run'] },
  ]
  const suggestedValidationCommands: GitHookValidationCommandPayload[] = []
  for (const manifest of manifests) {
    const found = manifest.names.map((name) => resolve(worktreePath, name)).find(existsSync)
    if (!found) continue
    candidates.set(found, {
      source: 'hook-manager-config',
      kind: 'manager_config',
      managerHint: manifest.manager,
    })
    suggestedValidationCommands.push({
      id: `validate-${manifest.manager}`,
      hook: manifest.hook,
      command: {
        mode: 'process',
        program: manifest.program,
        args: manifest.args,
        cwd: '.',
        env: {},
      },
      purpose: `Run the repository's ${manifest.manager} validation explicitly.`,
    })
  }

  const detected = [...candidates.entries()]
    .map(([path, metadata]) => ({
      name: STANDARD_HOOKS.has(path.split(/[\\/]/).pop() ?? '')
        ? (path.split(/[\\/]/).pop() as string)
        : `${metadata.managerHint ?? 'hook-manager'}-config`,
      path: displayPath(worktreePath, path),
      source: metadata.source,
      kind: metadata.kind,
      runnable: metadata.kind === 'manager_config' ? 'no' as const : runnable(path),
      ...(metadata.managerHint ? { managerHint: metadata.managerHint } : {}),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))

  return { configuredHooksPath, detected, suggestedValidationCommands }
}
