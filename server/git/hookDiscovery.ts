import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { DetectedGitHookPayload, GitHookValidationCommandPayload } from '../structuredOutput/types'

const STANDARD_HOOKS = new Set([
  'applypatch-msg', 'commit-msg', 'fsmonitor-watchman', 'post-applypatch', 'post-checkout',
  'post-commit', 'post-merge', 'post-receive', 'post-rewrite', 'post-update', 'pre-applypatch',
  'pre-auto-gc', 'pre-commit', 'pre-merge-commit', 'pre-push', 'pre-rebase', 'pre-receive',
  'prepare-commit-msg', 'push-to-checkout', 'reference-transaction', 'update',
])

function runGit(worktreePath: string, args: string[]): string | null {
  const result = spawnSync('git', ['-C', worktreePath, ...args], { encoding: 'utf8' })
  if (result.status !== 0 || result.error) return null
  return (result.stdout ?? '').trim() || null
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
