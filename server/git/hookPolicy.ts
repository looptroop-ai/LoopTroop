import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_GIT_HOOK_POLICY, isGitHookPolicy, type GitHookPolicy } from '@shared/gitHookPolicy'

export {
  DEFAULT_GIT_HOOK_POLICY,
  isGitHookPolicy,
  migrateGitHookPolicy,
  type GitHookPolicy,
} from '@shared/gitHookPolicy'

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
