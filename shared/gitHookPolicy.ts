/**
 * What LoopTroop does about a project's git hooks during a run.
 *
 * The union, the default and the guard live here because they are read from
 * several directions — the SPA's settings and plan parsing, the server's
 * structured-output parsing and the worktree profile — and each copy of the
 * list was one more place a renamed policy could fail to reach.
 */
export const GIT_HOOK_POLICIES = [
  'observe_only',
  'validate_advisory',
  'validate_required',
  'use_native_hooks',
] as const

export type GitHookPolicy = (typeof GIT_HOOK_POLICIES)[number]

export const DEFAULT_GIT_HOOK_POLICY: GitHookPolicy = 'validate_advisory'

export function isGitHookPolicy(value: unknown): value is GitHookPolicy {
  return (GIT_HOOK_POLICIES as readonly unknown[]).includes(value)
}
