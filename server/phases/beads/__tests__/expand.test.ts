import { describe, expect, it } from 'vitest'
import { expandBeads, validateBeadExpansion } from '../expand'
import type { Bead, BeadSubset } from '../types'
import type { CommandSpec } from '@shared/commandSpec'

const command = (script: string): CommandSpec => ({ mode: 'shell', shell: 'posix', script, cwd: '.', env: {} })

function buildSubsetBeads(): BeadSubset[] {
  return [
    {
      id: 'bead-1',
      title: 'Validate refinement attribution',
      prdRefs: ['EPIC-1 / US-1'],
      description: 'Preserve explicit inspiration in refinement diffs.',
      contextGuidance: {
        patterns: ['Keep repairs deterministic.'],
        anti_patterns: ['Do not widen the repair scope unnecessarily.'],
      },
      acceptanceCriteria: ['Validate attribution survives refinement'],
      tests: ['Shared tests cover refinement attribution'],
      testCommands: [command('npm run test:server')],
    },
    {
      id: 'bead-2',
      title: 'Surface retry metadata',
      prdRefs: ['EPIC-1 / US-2'],
      description: 'Surface refinement retry metadata in the diff viewer.',
      contextGuidance: {
        patterns: ['Keep attribution deterministic.'],
        anti_patterns: ['Do not remove inspiration metadata.'],
      },
      acceptanceCriteria: ['Show retry metadata alongside refinement diffs'],
      tests: ['UI tests show the correct inspiration tooltip'],
      testCommands: [command('npm run test:client')],
    },
  ]
}

function buildExpandedBeads(subsets: BeadSubset[] = buildSubsetBeads()): Bead[] {
  return expandBeads(subsets, 'PROJ-1').map((bead, index) => ({
    ...bead,
    id: `proj-1-bead-${index + 1}`,
    issueType: 'task',
    labels: [`ticket:PROJ-1`, `story:US-${index + 1}`],
    dependencies: {
      blocked_by: index === 0 ? [] : [`proj-1-bead-${index}`],
      blocks: [],
    },
    targetFiles: [index === 0 ? 'src/first.ts' : 'src/second.ts'],
  }))
}

describe.concurrent('validateBeadExpansion', () => {
  it('accepts punctuation and whitespace-only drift in narrative preserved fields', () => {
    const subsets = buildSubsetBeads()
    const expanded = buildExpandedBeads(subsets)
    expanded[0] = {
      ...expanded[0]!,
      description: 'Preserve explicit   inspiration in refinement diffs!',
      contextGuidance: {
        patterns: ['Keep repairs deterministic'],
        anti_patterns: ['  Do not widen the repair scope unnecessarily! '],
      },
      acceptanceCriteria: [' Validate attribution survives refinement. '],
      tests: ['Shared tests   cover refinement attribution!'],
    }

    const warnings = validateBeadExpansion(subsets, expanded)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('bead at index 0')
    expect(warnings[0]).toContain('contextGuidance.patterns[0]')
    expect(warnings[0]).toContain('tests[0]')
  })

  it('restores substantive drift in preserved narrative fields when identity anchors still match', () => {
    const subsets = buildSubsetBeads()
    const expanded = buildExpandedBeads(subsets)
    expanded[0] = {
      ...expanded[0]!,
      description: 'Rewrite the refinement pipeline around a new metadata transport.',
      contextGuidance: {
        patterns: ['Route refinement attribution through a transport adapter.'],
        anti_patterns: ['Avoid using the canonical refined blueprint as the source of truth.'],
      },
      acceptanceCriteria: ['Transport adapter persists all refinement metadata'],
      tests: ['Integration tests verify the transport adapter round-trip'],
    }

    const warnings = validateBeadExpansion(subsets, expanded)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('substantive drift')
    expect(warnings[0]).toContain('description')
    expect(warnings[0]).toContain('acceptanceCriteria')
  })

  it('still fails when title changes', () => {
    const subsets = buildSubsetBeads()
    const expanded = buildExpandedBeads(subsets)
    expanded[0] = {
      ...expanded[0]!,
      title: 'Validate refined attribution',
    }

    expect(() => validateBeadExpansion(subsets, expanded)).toThrow(
      'Expanded bead at index 0 changed preserved Part 1 fields or order',
    )
  })

  it('still fails when prdRefs change', () => {
    const subsets = buildSubsetBeads()
    const expanded = buildExpandedBeads(subsets)
    expanded[0] = {
      ...expanded[0]!,
      prdRefs: ['EPIC-9 / US-9'],
    }

    expect(() => validateBeadExpansion(subsets, expanded)).toThrow(
      'Expanded bead at index 0 changed preserved Part 1 fields or order',
    )
  })

  it('restores testCommands drift from the refined blueprint', () => {
    const subsets = buildSubsetBeads()
    const expanded = buildExpandedBeads(subsets)
    expanded[0] = {
      ...expanded[0]!,
      testCommands: [command('npm run test:server -- --watch=false')],
    }

    const warnings = validateBeadExpansion(subsets, expanded)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('expanded bead at index 0')
    expect(warnings[0]).toContain('testCommands[0]')
  })

  it('restores testCommandReason drift from the refined blueprint', () => {
    const subsets = buildSubsetBeads()
    subsets[0] = {
      ...subsets[0]!,
      testCommands: [],
      testCommandReason: 'No appropriate automated command exists.',
    }
    const expanded = buildExpandedBeads(subsets)
    expanded[0] = { ...expanded[0]!, testCommandReason: 'A different reason.' }

    const warnings = validateBeadExpansion(subsets, expanded)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('testCommandReason')
  })

  it('still fails when beads are reordered', () => {
    const subsets = buildSubsetBeads()
    const expanded = buildExpandedBeads(subsets).reverse()

    expect(() => validateBeadExpansion(subsets, expanded)).toThrow(
      'Expanded bead at index 0 changed preserved Part 1 fields or order',
    )
  })
})
