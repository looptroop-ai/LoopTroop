import { describe, expect, it } from 'vitest'
import {
  collectAliasConflictWarnings,
  getValueByAliases,
  withAliasConflictWarnings,
} from '../yamlUtils'
import { normalizeFinalTestCommandsOutput } from '../index'

describe('getValueByAliases precedence', () => {
  it('prefers the canonical alias over a legacy one written first', () => {
    const record = { legacy_name: 'legacy', name: 'canonical' }
    expect(getValueByAliases(record, ['name', 'legacy_name'])).toBe('canonical')
  })

  it('falls back to record order for two spellings of the same alias', () => {
    // normalizeKey folds `generated_at` and `generatedAt` into one token, so the
    // alias list cannot rank them. The conflict is still reported.
    expect(getValueByAliases({ generated_at: 'first', generatedAt: 'second' }, ['generatedAt'])).toBe('first')
  })

  it('does not depend on the order the payload happened to use', () => {
    const first = { legacy_name: 'legacy', name: 'canonical' }
    const second = { name: 'canonical', legacy_name: 'legacy' }
    expect(getValueByAliases(first, ['name', 'legacy_name'])).toBe('canonical')
    expect(getValueByAliases(second, ['name', 'legacy_name'])).toBe('canonical')
  })

  it('returns the single match when only a later alias is present', () => {
    expect(getValueByAliases({ legacy_name: 'legacy' }, ['name', 'legacy_name'])).toBe('legacy')
  })

  it('returns undefined when nothing matches', () => {
    expect(getValueByAliases({ other: 1 }, ['name'])).toBeUndefined()
  })

  it('treats equal values under two aliases as agreement', () => {
    const warnings: string[] = []
    withAliasConflictWarnings(warnings, () => {
      expect(getValueByAliases({ name: 'x', legacy_name: 'x' }, ['name', 'legacy_name'])).toBe('x')
    })
    expect(warnings).toEqual([])
  })

  it('compares structured values rather than references', () => {
    const warnings: string[] = []
    withAliasConflictWarnings(warnings, () => {
      getValueByAliases({ tags: ['a', 'b'], labels: ['a', 'b'] }, ['tags', 'labels'])
    })
    expect(warnings).toEqual([])
  })

  it('records a warning naming the alias it ignored', () => {
    const warnings: string[] = []
    withAliasConflictWarnings(warnings, () => {
      expect(getValueByAliases({ name: 'canonical', legacy_name: 'legacy' }, ['name', 'legacy_name'])).toBe('canonical')
    })
    expect(warnings).toEqual(['Resolved "name" and ignored the conflicting value in "legacy_name".'])
  })

  it('records a conflict between two spellings of the same alias', () => {
    const warnings: string[] = []
    withAliasConflictWarnings(warnings, () => {
      getValueByAliases({ generatedAt: 'a', generated_at: 'b' }, ['generatedAt'])
    })
    expect(warnings).toEqual(['Resolved "generatedAt" and ignored the conflicting value in "generated_at".'])
  })

  it('says nothing when no sink is installed', () => {
    expect(() => getValueByAliases({ name: 'a', legacy_name: 'b' }, ['name', 'legacy_name'])).not.toThrow()
  })
})

describe('alias conflict sinks', () => {
  it('restores the outer sink when a nested one is released', () => {
    const outer: string[] = []
    const inner: string[] = []
    withAliasConflictWarnings(outer, () => {
      withAliasConflictWarnings(inner, () => {
        getValueByAliases({ name: 'a', legacy_name: 'b' }, ['name', 'legacy_name'])
      })
      getValueByAliases({ title: 'a', label: 'b' }, ['title', 'label'])
    })
    expect(inner).toHaveLength(1)
    expect(outer).toHaveLength(1)
    expect(outer[0]).toContain('"label"')
  })

  it('stops collecting once released, and a second release is a no-op', () => {
    const warnings: string[] = []
    const release = collectAliasConflictWarnings(warnings)
    release()
    release()
    getValueByAliases({ name: 'a', legacy_name: 'b' }, ['name', 'legacy_name'])
    expect(warnings).toEqual([])
  })

  it('releases the sink even when the block throws', () => {
    const warnings: string[] = []
    expect(() => withAliasConflictWarnings(warnings, () => { throw new Error('boom') })).toThrow('boom')
    getValueByAliases({ name: 'a', legacy_name: 'b' }, ['name', 'legacy_name'])
    expect(warnings).toEqual([])
  })
})

describe('alias conflicts reach a parser result', () => {
  it('reports the ignored alias as a repair warning', () => {
    const result = normalizeFinalTestCommandsOutput([
      '<FINAL_TEST_COMMANDS>',
      'commands:',
      '  - npm run test:server',
      'file_effects:',
      '  - path: tmp/output.log',
      '    intent: temporary',
      '    type: file',
      '</FINAL_TEST_COMMANDS>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.fileEffects).toEqual([{ path: 'tmp/output.log', intent: 'temporary' }])
    expect(result.repairWarnings).toContain('Resolved "intent" and ignored the conflicting value in "type".')
  })
})
