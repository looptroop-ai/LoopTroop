import { describe, expect, it } from 'vitest'
import { parseYamlOrJsonCandidate } from '../yamlUtils'
import { normalizeBeadsJsonlOutput } from '../index'

describe('pre-parse repairs are recorded', () => {
  it('reports a missing space after a list dash', () => {
    const repairWarnings: string[] = []
    const parsed = parseYamlOrJsonCandidate([
      'items:',
      '  -id: one',
      '  -id: two',
    ].join('\n'), { repairWarnings })

    expect(parsed).toEqual({ items: [{ id: 'one' }, { id: 'two' }] })
    expect(repairWarnings).toContain('Inserted the missing space after a YAML list dash before parsing.')
  })

  it('reports removed duplicate mapping keys', () => {
    const repairWarnings: string[] = []
    const parsed = parseYamlOrJsonCandidate([
      'options:',
      '  - first',
      'options:',
      '  - second',
    ].join('\n'), { repairWarnings })

    expect(parsed).toEqual({ options: ['first'] })
    expect(repairWarnings).toContain('Removed duplicate YAML mapping keys before parsing.')
  })
})

describe('a repair rung records nothing when its parse fails', () => {
  it.each([
    ['a stray root sequence entry', ['a: "unclosed', '- stray'].join('\n')],
    ['a stray flow indicator', ['a: "unclosed', '{', 'b: 1'].join('\n')],
    ['an unterminated flow sequence', ['a: "unclosed', 'b: [1, 2'].join('\n')],
  ])('leaves the warnings empty when every rung fails on %s', (_label, candidate) => {
    // Each of these reaches the unclosed-quote rung, which used to append its
    // warning before the load it was hoping would succeed.
    const repairWarnings: string[] = []
    expect(() => parseYamlOrJsonCandidate(candidate, { repairWarnings })).toThrow()
    expect(repairWarnings).toEqual([])
  })

  it('still records the warning when that rung is the one that parses', () => {
    const repairWarnings: string[] = []
    const parsed = parseYamlOrJsonCandidate(['type: string | null', 'name: "x'].join('\n'), { repairWarnings })

    expect(parsed).toEqual({ type: 'string | null', name: 'x' })
    expect(repairWarnings).toEqual(['Fixed unbalanced YAML quote before reparsing.'])
  })
})

describe('repair warnings describe only the accepted candidate', () => {
  it('does not carry a rejected candidate’s warnings into the accepted result', () => {
    // The first candidate is the whole response, which fails on the prose line.
    // The second is the fenced block, which validates cleanly.
    const bead = {
      id: 'bead-1',
      title: 'First bead',
      prdRefs: ['EPIC-1 / US-1'],
      description: 'Do the first step.',
      contextGuidance: { patterns: ['Keep it scoped.'], anti_patterns: ['Do not wander.'] },
      acceptanceCriteria: ['done'],
      tests: ['test'],
      testCommands: ['npm run test'],
      priority: 1,
      status: 'pending',
      labels: [],
      dependencies: [],
      targetFiles: [],
      iteration: 1,
      createdAt: '',
      updatedAt: '',
      beadStartCommit: null,
    }
    const rejected = { ...bead, iteration: 0, acceptanceCriteria: [] }

    const result = normalizeBeadsJsonlOutput([
      JSON.stringify(rejected),
      '```jsonl',
      JSON.stringify(bead),
      '```',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(result.repairWarnings.some((warning) => warning.includes('replaced invalid iteration'))).toBe(false)
  })
})

describe('a jsonl code fence is unwrapped', () => {
  it('does not leave the trailing "l" of the fence language in the candidate', () => {
    const result = normalizeBeadsJsonlOutput([
      'Here is the tracker.',
      '```jsonl',
      JSON.stringify({
        id: 'bead-1',
        title: 'First bead',
        prdRefs: ['EPIC-1 / US-1'],
        description: 'Do the first step.',
        contextGuidance: { patterns: ['Keep it scoped.'], anti_patterns: ['Do not wander.'] },
        acceptanceCriteria: ['done'],
        tests: ['test'],
        testCommands: ['npm run test'],
        priority: 1,
        status: 'pending',
        labels: [],
        dependencies: [],
        targetFiles: [],
        iteration: 1,
        createdAt: '',
        updatedAt: '',
        beadStartCommit: null,
      }),
      '```',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.id).toBe('bead-1')
  })
})
