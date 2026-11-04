import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GIT_HOOK_POLICY,
  GIT_HOOK_POLICIES,
  isGitHookPolicy,
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

describe('DEFAULT_GIT_HOOK_POLICY', () => {
  it('is one of the declared policies', () => {
    expect(isGitHookPolicy(DEFAULT_GIT_HOOK_POLICY)).toBe(true)
  })
})
