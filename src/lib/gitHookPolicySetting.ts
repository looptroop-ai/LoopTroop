import { migrateGitHookPolicy, type GitHookPolicy } from '@shared/gitHookPolicy'

export type GitHookPolicyOverride = GitHookPolicy | null

export function normalizeGitHookPolicySetting(value: unknown): GitHookPolicy | null {
  return migrateGitHookPolicy(value)
}
