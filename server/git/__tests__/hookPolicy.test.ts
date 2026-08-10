import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir } from '../../test/tempDir'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateGitHookPolicy, readWorktreeGitHookPolicy, shouldBypassGitHooks } from '../hookPolicy'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Git hook policy', () => {
  it.each([
    ['observe_only', true],
    ['validate_advisory', true],
    ['validate_required', true],
    ['use_native_hooks', false],
  ] as const)('resolves %s and chooses internal bypass=%s', (policy, bypass) => {
    const root = makeTempDir('looptroop-hook-policy-')
    roots.push(root)
    mkdirSync(join(root, '.ticket/runtime'), { recursive: true })
    writeFileSync(join(root, '.ticket/runtime/execution-setup-profile.json'), JSON.stringify({
      git_hooks: { policy },
    }))

    const resolved = readWorktreeGitHookPolicy(root)
    expect(resolved).toBe(policy)
    expect(shouldBypassGitHooks(resolved)).toBe(bypass)
  })

  it('uses advisory validation as the non-blocking default when no profile exists', () => {
    const root = makeTempDir('looptroop-hook-policy-')
    roots.push(root)
    expect(readWorktreeGitHookPolicy(root)).toBe('validate_advisory')
  })

  it.each([
    ['validate_explicitly', 'validate_advisory'],
    ['ignore_internal_only', 'observe_only'],
    ['use_on_internal_commits', 'use_native_hooks'],
  ] as const)('maps persisted legacy policy %s to %s for settings migration', (legacyPolicy, expected) => {
    expect(migrateGitHookPolicy(legacyPolicy)).toBe(expected)
  })
})
