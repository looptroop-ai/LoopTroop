import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GitHookPolicy } from '../structuredOutput/types'

export const DEFAULT_GIT_HOOK_POLICY: GitHookPolicy = 'validate_advisory'

export function isGitHookPolicy(value: unknown): value is GitHookPolicy {
  return value === 'observe_only'
    || value === 'validate_advisory'
    || value === 'validate_required'
    || value === 'use_native_hooks'
}

export function migrateGitHookPolicy(value: unknown): GitHookPolicy | null {
  if (isGitHookPolicy(value)) return value
  if (value === 'validate_explicitly') return 'validate_advisory'
  if (value === 'ignore_internal_only') return 'observe_only'
  if (value === 'use_on_internal_commits') return 'use_native_hooks'
  return null
}

export function readWorktreeGitHookPolicy(worktreePath: string): GitHookPolicy {
  try {
    const parsed = JSON.parse(readFileSync(
      resolve(worktreePath, '.ticket/runtime/execution-setup-profile.json'),
      'utf8',
    )) as { git_hooks?: { policy?: unknown }; gitHooks?: { policy?: unknown } }
    const value = parsed.git_hooks?.policy ?? parsed.gitHooks?.policy
    return isGitHookPolicy(value) ? value : DEFAULT_GIT_HOOK_POLICY
  } catch {
    return DEFAULT_GIT_HOOK_POLICY
  }
}

export function shouldBypassGitHooks(policy: GitHookPolicy): boolean {
  return policy !== 'use_native_hooks'
}
