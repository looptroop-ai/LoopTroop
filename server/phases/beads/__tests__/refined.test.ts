import { describe, expect, it } from 'vitest'
import { validateBeadsRefinementOutput } from '../refined'

function buildBeadsRefinementContent(options: {
  beadOneDescription?: string
  beadTwoDescription?: string
  includeChanges?: boolean
} = {}): string {
  const content = [
    'beads:',
    '  - id: "bead-1"',
    '    title: "Keep existing switcher bead"',
    '    prdRefs: ["EPIC-1", "US-1"]',
    `    description: "${options.beadOneDescription ?? 'Leave the switcher bead unchanged.'}"`,
    '    contextGuidance:',
    '      patterns:',
    '        - "Reuse the current theme switcher."',
    '      anti_patterns:',
    '        - "Do not redesign the menu."',
    '    acceptanceCriteria:',
    '      - "Keep the switcher bead unchanged."',
    '    tests:',
    '      - "Test the unchanged switcher bead."',
    '    testCommands:',
    '      - "npm test -- AppShell"',
    '  - id: "bead-2"',
    '    title: "Update persistence coverage"',
    '    prdRefs: ["EPIC-1", "US-2"]',
    `    description: "${options.beadTwoDescription ?? 'Refresh the persistence coverage details.'}"`,
    '    contextGuidance:',
    '      patterns:',
    '        - "Reuse the existing persistence path."',
    '      anti_patterns:',
    '        - "Do not change the storage key."',
    '    acceptanceCriteria:',
    '      - "Keep persistence coverage explicit."',
    '    tests:',
    '      - "Test persistence coverage."',
    '    testCommands:',
    '      - "npm test -- UIContext"',
  ]

  if (options.includeChanges) {
    content.push(
      'changes:',
      '  - type: modified',
      '    item_type: bead',
      '    before:',
      '      id: "bead-2"',
      '      label: "Update persistence coverage"',
      '      detail: "Refresh the persistence coverage details."',
      '    after:',
      '      id: "bead-2"',
      '      label: "Update persistence coverage"',
      '      detail: "Refresh the persistence coverage details with storage-shape verification."',
    )
  }

  return content.join('\n')
}

describe.concurrent('beads refinement validation', () => {
  it('does not synthesize a title-match modified change when the winner and refined bead are identical', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinedContent = buildBeadsRefinementContent({
      beadTwoDescription: 'Refresh the persistence coverage details with storage-shape verification.',
      includeChanges: true,
    })

    const result = validateBeadsRefinementOutput(refinedContent, {
      winnerDraftContent,
    })

    expect(result.changes).toHaveLength(1)
    expect(result.changes).toEqual([
      expect.objectContaining({
        type: 'modified',
        before: expect.objectContaining({ id: 'bead-2' }),
        after: expect.objectContaining({ id: 'bead-2' }),
      }),
    ])
    expect(result.changes.find((change) => change.before?.id === 'bead-1' || change.after?.id === 'bead-1')).toBeUndefined()
    expect(result.repairWarnings.join('\n')).not.toContain('bead "bead-1"')
  })

  it('restores stable ids when a declared addition unambiguously displaced a surviving bead', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinedContent = [
      buildBeadsRefinementContent()
        .replace(
          'Refresh the persistence coverage details.',
          'Refresh the persistence coverage details with storage-shape verification.',
        )
        .replace(
          '  - id: "bead-2"',
          [
            '  - id: "bead-2"',
            '    title: "Add cache invalidation coverage"',
            '    prdRefs: ["EPIC-1", "US-3"]',
            '    description: "Cover cache invalidation explicitly."',
            '    contextGuidance:',
            '      patterns: ["Reuse the existing cache helper."]',
            '      anti_patterns: ["Do not introduce a second cache."]',
            '    acceptanceCriteria: ["Invalidate stale cache entries."]',
            '    tests: ["Test stale cache invalidation."]',
            '    testCommands: ["npm test -- cache"]',
            '  - id: "bead-3"',
          ].join('\n'),
        ),
      'changes:',
      '  - type: modified',
      '    item_type: bead',
      '    before: { id: "bead-2", label: "Update persistence coverage" }',
      '    after: { id: "bead-3", label: "Update persistence coverage" }',
      '  - type: added',
      '    item_type: bead',
      '    before: null',
      '    after: { id: "bead-2", label: "Add cache invalidation coverage" }',
    ].join('\n')

    const result = validateBeadsRefinementOutput(refinedContent, { winnerDraftContent })

    expect(result.beadSubsets.find((bead) => bead.title === 'Update persistence coverage')?.id).toBe('bead-2')
    expect(result.beadSubsets.find((bead) => bead.title === 'Add cache invalidation coverage')?.id).toBe('bead-3')
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'modified',
        before: expect.objectContaining({ id: 'bead-2' }),
        after: expect.objectContaining({ id: 'bead-2' }),
      }),
      expect.objectContaining({
        type: 'added',
        after: expect.objectContaining({ id: 'bead-3' }),
      }),
    ]))
    expect(result.refinedContent).toContain('id: bead-3')
    expect(result.repairWarnings).toContain(
      'Restored Beads refinement ID stability at change index 0: reassigned surviving bead "Update persistence coverage" from bead-3 to bead-2 and reassigned newly added bead "Add cache invalidation coverage" from bead-2 to bead-3.',
    )
  })

  it('rejects the refinement when the winner draft cannot be parsed for cross-validation', () => {
    const refinedContent = buildBeadsRefinementContent({ includeChanges: true })

    expect(() => validateBeadsRefinementOutput(refinedContent, { winnerDraftContent: 'not: [a, bead, blueprint' }))
      .toThrow(/winner bead draft required for refinement cross-validation/i)
  })

  it('rejects a modified id change when no unique declared addition proves an id shift', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinedContent = [
      buildBeadsRefinementContent().replace('  - id: "bead-2"', '  - id: "bead-3"'),
      'changes:',
      '  - type: modified',
      '    item_type: bead',
      '    before: { id: "bead-2", label: "Update persistence coverage" }',
      '    after: { id: "bead-3", label: "Update persistence coverage" }',
    ].join('\n')

    expect(() => validateBeadsRefinementOutput(refinedContent, { winnerDraftContent }))
      .toThrow('modified bead ids must remain stable')
  })
})
