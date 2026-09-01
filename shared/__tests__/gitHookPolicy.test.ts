import { describe, expect, it } from 'vitest'
import {
  buildGitHookPolicyMigrationSql,
  DEFAULT_GIT_HOOK_POLICY,
  GIT_HOOK_POLICIES,
  isGitHookPolicy,
  migrateGitHookPolicy,
} from '../gitHookPolicy'

describe('isGitHookPolicy', () => {
  it.each(GIT_HOOK_POLICIES)('accepts %s', (policy) => {
    expect(isGitHookPolicy(policy)).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isGitHookPolicy('nonsense')).toBe(false)
    expect(isGitHookPolicy(null)).toBe(false)
    expect(isGitHookPolicy(['validate_required'])).toBe(false)
  })
})

describe('migrateGitHookPolicy', () => {
  it.each(GIT_HOOK_POLICIES)('passes %s through unchanged', (policy) => {
    expect(migrateGitHookPolicy(policy)).toBe(policy)
  })

  it.each([
    ['validate_explicitly', 'validate_advisory'],
    ['ignore_internal_only', 'observe_only'],
    ['use_on_internal_commits', 'use_native_hooks'],
  ])('maps the legacy name %s to %s', (legacy, current) => {
    expect(migrateGitHookPolicy(legacy)).toBe(current)
  })

  it('returns null for an unrecognised value', () => {
    expect(migrateGitHookPolicy('nonsense')).toBeNull()
    expect(migrateGitHookPolicy(undefined)).toBeNull()
    expect(migrateGitHookPolicy(42)).toBeNull()
  })

  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf'])(
    'returns null for the inherited property name %s',
    (name) => {
      // `in` walks the prototype chain, so these used to come back as
      // `Object`, `Object.prototype.toString` and friends — functions typed as
      // a policy, truthy enough to skip every caller's fallback.
      expect(migrateGitHookPolicy(name)).toBeNull()
    },
  )
})

describe('buildGitHookPolicyMigrationSql', () => {
  it('rewrites every legacy name for the named table', () => {
    const sql = buildGitHookPolicyMigrationSql('profiles')
    expect(sql).toContain('UPDATE profiles')
    for (const legacy of ['validate_explicitly', 'ignore_internal_only', 'use_on_internal_commits']) {
      expect(sql).toContain(`WHEN '${legacy}'`)
      expect(sql).toContain(`'${legacy}'`)
    }
  })

  it('accepts a non-default column', () => {
    expect(buildGitHookPolicyMigrationSql('projects', 'git_hook_policy')).toContain('UPDATE projects')
  })

  it.each(["profiles; DROP TABLE tickets", 'profiles"', '1profiles', ''])(
    'refuses the unsafe identifier %s',
    (identifier) => {
      expect(() => buildGitHookPolicyMigrationSql(identifier)).toThrow(/unsafe identifier/i)
    },
  )
})

describe('DEFAULT_GIT_HOOK_POLICY', () => {
  it('is one of the declared policies', () => {
    expect(isGitHookPolicy(DEFAULT_GIT_HOOK_POLICY)).toBe(true)
  })
})
