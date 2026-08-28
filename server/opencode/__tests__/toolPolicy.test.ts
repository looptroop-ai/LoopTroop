import { describe, expect, it } from 'vitest'
import type { OpenCodePermissionRule } from '../types'
import {
  OPENCODE_DISABLED_PERMISSIONS,
  OPENCODE_READ_ONLY_PERMISSIONS,
  resolveOpenCodePermissions,
  toolPolicyMayAskQuestions,
  type OpenCodeToolPolicy,
} from '../toolPolicy'

const ALL_POLICIES: OpenCodeToolPolicy[] = ['default', 'disabled', 'read_only', 'execution_setup_online']

function questionRules(rules: readonly OpenCodePermissionRule[] | undefined): OpenCodePermissionRule[] {
  return (rules ?? []).filter((rule) => rule.permission === 'question')
}

describe('resolveOpenCodePermissions', () => {
  it('states the question rule exactly once, whatever the policy said', () => {
    for (const policy of ALL_POLICIES) {
      for (const questionsAllowed of [true, false]) {
        const rules = resolveOpenCodePermissions(policy, questionsAllowed)
        expect(questionRules(rules as OpenCodePermissionRule[])).toHaveLength(1)
      }
    }
  })

  it('denies by default, so a call site that forgets to opt in stays unattended', () => {
    for (const policy of ALL_POLICIES) {
      const rules = resolveOpenCodePermissions(policy) as OpenCodePermissionRule[]
      expect(questionRules(rules)[0]?.action).toBe('deny')
    }
  })

  it('lets the setting override the policies that hard-denied questions', () => {
    // `read_only` carries `question: false` in its table. Before this it was why
    // most steps could never ask, whatever the operator had configured.
    expect(questionRules(OPENCODE_READ_ONLY_PERMISSIONS as OpenCodePermissionRule[])[0]?.action).toBe('deny')
    const allowed = resolveOpenCodePermissions('read_only', true) as OpenCodePermissionRule[]
    expect(questionRules(allowed)[0]?.action).toBe('allow')
  })

  it('never lets a no-tool step ask', () => {
    // `disabled` means the step only reformats text it was handed. It has
    // nothing to investigate, so it has nothing to ask about.
    const allowed = resolveOpenCodePermissions('disabled', true) as OpenCodePermissionRule[]
    expect(questionRules(allowed)[0]?.action).toBe('deny')
    expect(toolPolicyMayAskQuestions('disabled')).toBe(false)
    expect(toolPolicyMayAskQuestions('default')).toBe(true)
  })

  it('leaves every other permission in the policy untouched', () => {
    const base = (OPENCODE_DISABLED_PERMISSIONS as OpenCodePermissionRule[])
      .filter((rule) => rule.permission !== 'question')
    const resolved = (resolveOpenCodePermissions('disabled') as OpenCodePermissionRule[])
      .filter((rule) => rule.permission !== 'question')
    expect(resolved).toEqual(base)
  })

  it('returns the same frozen array for repeated calls', () => {
    expect(resolveOpenCodePermissions('default', true)).toBe(resolveOpenCodePermissions('default', true))
    expect(resolveOpenCodePermissions('default', true)).not.toBe(resolveOpenCodePermissions('default', false))
  })
})
