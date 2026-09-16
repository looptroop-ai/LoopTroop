import { describe, expect, it } from 'vitest'
import {
  collectAliasConflictWarnings,
  getValueByAliases,
  withAliasConflictWarnings,
} from '../yamlUtils'
import { getValueByExactAlias } from '@shared/typeGuards'
import { normalizeFinalTestCommandsOutput } from '../index'

describe('getValueByAliases precedence', () => {
  it('prefers the canonical alias over a legacy one written first', () => {
    const record = { legacy_name: 'legacy', name: 'canonical' }
    expect(getValueByAliases(record, ['name', 'legacy_name'])).toBe('canonical')
  })

  it('prefers an exact canonical spelling within one normalized alias bucket', () => {
    expect(getValueByAliases({ generated_at: 'legacy', generatedAt: 'canonical' }, ['generatedAt'])).toBe('canonical')
  })

  it('does not depend on the order the payload happened to use', () => {
    const first = { legacy_name: 'legacy', name: 'canonical' }
    const second = { name: 'canonical', legacy_name: 'legacy' }
    expect(getValueByAliases(first, ['name', 'legacy_name'])).toBe('canonical')
    expect(getValueByAliases(second, ['name', 'legacy_name'])).toBe('canonical')
  })

  it('keeps the canonical snake_case alias across payload permutations', () => {
    const payloads = [
      { winnermodel: 'legacy', winner_model: 'canonical' },
      { winner_model: 'canonical', winnermodel: 'legacy' },
    ]

    for (const payload of payloads) {
      const warnings: string[] = []
      withAliasConflictWarnings(warnings, () => {
        expect(getValueByAliases(payload, ['winner_model', 'winnermodel'])).toBe('canonical')
      })
      expect(warnings).toEqual(['Resolved "winner_model" and ignored the conflicting value in "winnermodel".'])
    }
  })

  it('keeps required_commands ahead of its legacy spellings across permutations', () => {
    const payloads = [
      { requiredcommands: ['legacy'], required_commands: ['canonical'] },
      { required_commands: ['canonical'], requiredcommands: ['legacy'] },
    ]

    for (const payload of payloads) {
      expect(getValueByAliases(payload, ['required_commands', 'requiredcommands', 'commands'])).toEqual(['canonical'])
    }
  })

  it('keeps alias-list precedence across normalized buckets', () => {
    const warnings: string[] = []
    withAliasConflictWarnings(warnings, () => {
      expect(getValueByAliases(
        { requiredCommands: ['canonical'], commands: ['lower-priority'] },
        ['required_commands', 'commands'],
      )).toEqual(['canonical'])
    })
    expect(warnings).toEqual([
      'Resolved "requiredCommands" and ignored the conflicting value in "commands".',
    ])
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

  it('names an ignored alias once when the list carries two spellings of it', () => {
    // Several live alias lists do this — `actionsrequired` and
    // `actions_required` normalise to one token — so the same record entries
    // were visited once per spelling and the disagreement reported twice.
    const warnings: string[] = []
    withAliasConflictWarnings(warnings, () => {
      expect(getValueByAliases(
        { actionsRequired: 'legacy', actions_required: 'canonical' },
        ['actions_required', 'actionsRequired'],
      )).toBe('canonical')
    })
    expect(warnings).toEqual(['Resolved "actions_required" and ignored the conflicting value in "actionsRequired".'])
  })
})

describe('getValueByExactAlias', () => {
  it('matches only the exact spelling', () => {
    expect(getValueByExactAlias({ generated_at: 'x' }, ['generatedAt'])).toBeUndefined()
    expect(getValueByExactAlias({ generated_at: 'x' }, ['generatedAt', 'generated_at'])).toBe('x')
  })

  it('takes the first listed alias that is present', () => {
    expect(getValueByExactAlias({ generated_at: 'legacy', generatedAt: 'canonical' }, ['generatedAt', 'generated_at']))
      .toBe('canonical')
  })

  it('does not answer to an inherited key', () => {
    // The two local copies this replaced used `alias in record`, which walks the
    // prototype, so a record with no `constructor` of its own still had one.
    expect(getValueByExactAlias({}, ['constructor'])).toBeUndefined()
    expect(getValueByExactAlias({}, ['toString'])).toBeUndefined()
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
