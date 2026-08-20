import type { GitHookPolicy } from '@/lib/executionSetupPlan'

export type GitHookPolicyOverride = GitHookPolicy | null

export function normalizeGitHookPolicySetting(value: unknown): GitHookPolicy | null {
  if (
    value === 'observe_only'
    || value === 'validate_advisory'
    || value === 'validate_required'
    || value === 'use_native_hooks'
  ) return value
  if (value === 'validate_explicitly') return 'validate_advisory'
  if (value === 'ignore_internal_only') return 'observe_only'
  if (value === 'use_on_internal_commits') return 'use_native_hooks'
  return null
}
