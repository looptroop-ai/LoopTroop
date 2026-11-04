import { isGitHookPolicy, type GitHookPolicy } from '@shared/gitHookPolicy'

export type GitHookPolicyOverride = GitHookPolicy | null

export function normalizeGitHookPolicySetting(value: unknown): GitHookPolicy | null {
  return isGitHookPolicy(value) ? value : null
}
