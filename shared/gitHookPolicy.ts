/**
 * What LoopTroop does about a project's git hooks during a run.
 *
 * The union, the default, the guard and the legacy-name migration all live
 * here because they are read from four directions — the SPA's settings and
 * plan parsing, the server's structured-output parsing, the worktree profile,
 * and two boot-time SQL migrations. Each of those used to spell the list out
 * again, so a renamed policy had four places to reach and three of them failed
 * silently.
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

/**
 * Names these policies used to carry, and what each became.
 *
 * Stored values are migrated in place at boot, but a worktree profile or a
 * model's output can still present an old name, so the mapping stays.
 */
export const LEGACY_GIT_HOOK_POLICIES: Readonly<Record<string, GitHookPolicy>> = {
  validate_explicitly: 'validate_advisory',
  ignore_internal_only: 'observe_only',
  use_on_internal_commits: 'use_native_hooks',
}

/** The current name for a stored policy, or null when the value is not one. */
export function migrateGitHookPolicy(value: unknown): GitHookPolicy | null {
  if (isGitHookPolicy(value)) return value
  if (typeof value === 'string' && value in LEGACY_GIT_HOOK_POLICIES) {
    return LEGACY_GIT_HOOK_POLICIES[value]!
  }
  return null
}

/**
 * The `UPDATE` that rewrites legacy policy names in one table.
 *
 * Generated from the mapping above rather than written out beside it: the app
 * and project databases each ran their own hand-written copy of this `CASE`,
 * and a mapping added to `migrateGitHookPolicy` reached neither.
 */
export function buildGitHookPolicyMigrationSql(table: string, column = 'git_hook_policy'): string {
  const legacyNames = Object.keys(LEGACY_GIT_HOOK_POLICIES)
  const cases = legacyNames
    .map((legacy) => `      WHEN '${legacy}' THEN '${LEGACY_GIT_HOOK_POLICIES[legacy]}'`)
    .join('\n')
  const inList = legacyNames.map((legacy) => `      '${legacy}'`).join(',\n')

  return `
    UPDATE ${table}
    SET ${column} = CASE ${column}
${cases}
      ELSE ${column}
    END
    WHERE ${column} IN (
${inList}
    );
  `
}
