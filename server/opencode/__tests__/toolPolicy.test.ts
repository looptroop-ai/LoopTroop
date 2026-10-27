import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { OpenCodePermissionRule } from '../types'
import {
  OPENCODE_DISABLED_PERMISSIONS,
  OPENCODE_READ_ONLY_PERMISSIONS,
  SILENT_DEFAULT_PERMISSIONS,
  SILENT_DISABLED_PERMISSIONS,
  SILENT_READ_ONLY_PERMISSIONS,
  isPermissionDeniedByRules,
  resolveOpenCodePermissions,
  toolPolicyMayAskQuestions,
  assistantPermissions,
  type OpenCodeToolPolicy,
} from '../toolPolicy'

const ALL_POLICIES: OpenCodeToolPolicy[] = ['default', 'disabled', 'read_only', 'execution_setup_online']

function questionRules(rules: readonly OpenCodePermissionRule[] | undefined): OpenCodePermissionRule[] {
  return (rules ?? []).filter((rule) => rule.permission === 'question')
}

describe('resolveOpenCodePermissions', () => {
  it('confines assistant reads while denying writes, other tools, and external directories', () => {
    const directory = resolve('assistant-policy-test')
    const rules = assistantPermissions(directory)
    for (const tool of ['read', 'list', 'glob']) {
      expect(isPermissionDeniedByRules(rules, tool, ['evidence/tickets/ticket.json'])).toBe(false)
      expect(isPermissionDeniedByRules(rules, tool, [`${directory.replaceAll('\\', '/')}/evidence/manifest.json`])).toBe(false)
      expect(isPermissionDeniedByRules(rules, tool, [resolve('outside/private.txt')])).toBe(true)
    }
    expect(isPermissionDeniedByRules(rules, 'grep', ['frontend'])).toBe(false)
    for (const tool of ['external_directory', 'bash', 'edit', 'task', 'question', 'webfetch']) {
      expect(isPermissionDeniedByRules(rules, tool, ['*'])).toBe(true)
    }
  })

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

  it('reports what the rules deny, so auto-approval cannot overturn them', () => {
    const silent = resolveOpenCodePermissions('default') as OpenCodePermissionRule[]
    const asking = resolveOpenCodePermissions('default', true) as OpenCodePermissionRule[]
    expect(isPermissionDeniedByRules(silent, 'question')).toBe(true)
    expect(isPermissionDeniedByRules(asking, 'question')).toBe(false)
  })

  it('reports a policy override rather than the base table it overrides', () => {
    // `doom_loop` and `external_directory` are allowed outright by the base
    // allow-all table and then denied by the stricter policies. Reading the
    // *first* matching rule returned the base allow, so auto-approval would have
    // said yes to a tool the policy had turned off — the same hole `question`
    // had, on the only two permissions where the tables actually collide.
    for (const permission of ['doom_loop', 'external_directory']) {
      expect(isPermissionDeniedByRules(SILENT_DISABLED_PERMISSIONS, permission)).toBe(true)
      expect(isPermissionDeniedByRules(SILENT_READ_ONLY_PERMISSIONS, permission)).toBe(permission === 'doom_loop')
      expect(isPermissionDeniedByRules(SILENT_DEFAULT_PERMISSIONS, permission)).toBe(false)
    }
  })

  it('allows external file access while preserving each step\'s tool policy', () => {
    for (const policy of ['default', 'execution_setup_online', 'read_only'] as const) {
      const rules = resolveOpenCodePermissions(policy)
      expect(isPermissionDeniedByRules(rules, 'external_directory', ['/outside/project'])).toBe(false)
      expect(isPermissionDeniedByRules(rules, 'read', ['/outside/project/settings.json'])).toBe(false)
      for (const permission of ['edit', 'write', 'bash']) {
        expect(isPermissionDeniedByRules(rules, permission, ['/outside/project/settings.json'])).toBe(policy === 'read_only')
      }
    }
    expect(isPermissionDeniedByRules(SILENT_DISABLED_PERMISSIONS, 'external_directory')).toBe(true)
  })

  it('uses the last matching specific or wildcard rule', () => {
    const specificAllowLast: OpenCodePermissionRule[] = [
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'allow' },
    ]
    const wildcardDenyLast: OpenCodePermissionRule[] = [
      { permission: 'read', pattern: '*', action: 'allow' },
      { permission: '*', pattern: '*', action: 'deny' },
    ]
    expect(isPermissionDeniedByRules(specificAllowLast, 'read')).toBe(false)
    expect(isPermissionDeniedByRules(specificAllowLast, 'bash')).toBe(true)
    expect(isPermissionDeniedByRules(wildcardDenyLast, 'read')).toBe(true)
    expect(isPermissionDeniedByRules(undefined, 'bash')).toBe(false)
    expect(isPermissionDeniedByRules(specificAllowLast, undefined)).toBe(false)
  })

  it('matches policy rules against the requested resources', () => {
    const rules: OpenCodePermissionRule[] = [
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: 'git push *', action: 'deny' },
      { permission: 'write', pattern: 'src/**', action: 'deny' },
    ]
    expect(isPermissionDeniedByRules(rules, 'bash', ['git push origin main'])).toBe(true)
    expect(isPermissionDeniedByRules(rules, 'bash', ['git push origin\nmain'])).toBe(true)
    expect(isPermissionDeniedByRules(rules, 'bash', ['git status --short'])).toBe(false)
    expect(isPermissionDeniedByRules(rules, 'write', ['/worktree/src/app.ts'], '/worktree')).toBe(true)
    expect(isPermissionDeniedByRules(rules, 'write', ['/worktree/docs/app.ts'], '/worktree')).toBe(false)
  })

  it('treats regex punctuation in permission patterns as literal glob text', () => {
    const rules: OpenCodePermissionRule[] = [
      { permission: 'bash', pattern: 'tool.+(arg)[x] *', action: 'deny' },
    ]
    expect(isPermissionDeniedByRules(rules, 'bash', ['tool.+(arg)[x] value'])).toBe(true)
    expect(isPermissionDeniedByRules(rules, 'bash', ['toolZZargx value'])).toBe(false)
  })

  it('asks for shell and edits only on guarded permissive workflows', () => {
    for (const policy of ['default', 'execution_setup_online'] as const) {
      const rules = resolveOpenCodePermissions(policy, false, true) as OpenCodePermissionRule[]
      for (const permission of ['bash', 'edit', 'write', 'apply_patch']) {
        expect(rules.findLast((rule) => rule.permission === permission)?.action).toBe('ask')
      }
    }
    for (const policy of ['disabled', 'read_only'] as const) {
      const rules = resolveOpenCodePermissions(policy, false, true) as OpenCodePermissionRule[]
      expect(rules.some((rule) => rule.permission === 'bash' && rule.action === 'ask')).toBe(false)
      expect(rules.some((rule) => ['edit', 'write', 'apply_patch'].includes(rule.permission) && rule.action === 'ask')).toBe(false)
      for (const permission of ['bash', 'edit', 'write', 'apply_patch']) {
        expect(isPermissionDeniedByRules(rules, permission, ['/worktree/file.ts'], '/worktree')).toBe(true)
      }
    }
    expect(resolveOpenCodePermissions('default', false, true)).not.toBe(resolveOpenCodePermissions('default'))
  })

  it('returns the same frozen array for repeated calls', () => {
    expect(resolveOpenCodePermissions('default', true)).toBe(resolveOpenCodePermissions('default', true))
    expect(resolveOpenCodePermissions('default', true)).not.toBe(resolveOpenCodePermissions('default', false))
  })
})
