import * as jsYaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { TEST } from '../../../test/factories'
import {
  BEADS_PIPELINE_STEPS,
  buildBeadsRefinedArtifact,
  buildBeadsRefinementRetryPrompt,
  getRefinementBeadMetrics,
  parseBeadsRefinedArtifact,
  validateBeadsRefinementOutput,
} from '../refined'

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
    '      - mode: "process"',
    '        program: "npm"',
    '        args: ["test", "--", "AppShell"]',
    '        cwd: "."',
    '        env: {}',
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
    '      - mode: "process"',
    '        program: "npm"',
    '        args: ["test", "--", "UIContext"]',
    '        cwd: "."',
    '        env: {}',
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

type BeadYamlEntry = Record<string, unknown>

function readBeadDocument(content: string): { beads: BeadYamlEntry[]; [key: string]: unknown } {
  return jsYaml.load(content) as { beads: BeadYamlEntry[]; [key: string]: unknown }
}

function writeBeadDocument(document: { beads: BeadYamlEntry[]; [key: string]: unknown }): string {
  return jsYaml.dump(document, { lineWidth: -1, noRefs: true }) as string
}

function withChanges(content: string, changes: unknown[]): string {
  return writeBeadDocument({ ...readBeadDocument(content), changes })
}

function modifiedChange(
  before: { id: string; label: string },
  after: { id: string; label: string },
  inspiration?: unknown,
) {
  return {
    type: 'modified',
    item_type: 'bead',
    before,
    after,
    ...(inspiration === undefined ? {} : { inspiration }),
  }
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
            '    testCommands: [{mode: "process", program: "npm", args: ["test", "--", "cache"], cwd: ".", env: {}}]',
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

  it.each([
    ['omitted', undefined],
    ['declared with the wrong ID', 'wrong-added-id'],
  ])('does not treat a renamed winner as a new bead when its addition is %s', (_kind, addedId) => {
    const winnerDocument = readBeadDocument(buildBeadsRefinementContent())
    winnerDocument.beads.push({
      ...winnerDocument.beads[0]!,
      id: 'bead-4',
      title: 'Existing utility coverage',
      description: 'Retain the original utility coverage.',
    })
    const winnerDraftContent = writeBeadDocument(winnerDocument)
    const refinedDocument = readBeadDocument(winnerDraftContent)
    const survivingBead = refinedDocument.beads[1]!
    survivingBead.id = 'bead-3'
    survivingBead.description = 'Refresh persistence coverage with storage-shape verification.'
    const renamedWinner = refinedDocument.beads[2]!
    renamedWinner.id = 'bead-2'
    renamedWinner.title = 'Add cache invalidation coverage'
    renamedWinner.description = 'Cover cache invalidation explicitly.'
    refinedDocument.changes = [
      modifiedChange(
        { id: 'bead-2', label: 'Update persistence coverage' },
        { id: 'bead-3', label: 'Update persistence coverage' },
      ),
      ...(addedId === undefined ? [] : [{
        type: 'added',
        item_type: 'bead',
        before: null,
        after: { id: addedId, label: 'Add cache invalidation coverage' },
      }]),
    ]

    expect(() => validateBeadsRefinementOutput(writeBeadDocument(refinedDocument), { winnerDraftContent }))
      .toThrow('modified bead ids must remain stable (before "bead-2", after "bead-3")')
  })

  it('does not repair a colliding ID shift when the mismatched modification is omitted', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinedDocument = readBeadDocument(winnerDraftContent)
    const survivingBead = refinedDocument.beads[1]!
    survivingBead.id = 'bead-3'
    survivingBead.description = 'Refresh persistence coverage with storage-shape verification.'
    refinedDocument.beads = [
      refinedDocument.beads[0]!,
      survivingBead,
      {
        ...refinedDocument.beads[0]!,
        id: 'bead-2',
        title: 'Add cache invalidation coverage',
        description: 'Cover cache invalidation explicitly.',
      },
    ]
    refinedDocument.changes = []

    const result = validateBeadsRefinementOutput(writeBeadDocument(refinedDocument), { winnerDraftContent })

    expect(result.beadSubsets.find((bead) => bead.title === 'Update persistence coverage')?.id).toBe('bead-3')
    expect(result.beadSubsets.find((bead) => bead.title === 'Add cache invalidation coverage')?.id).toBe('bead-2')
    expect(result.changes.every((change) => change.type !== 'modified' || change.before?.id === change.after?.id)).toBe(true)
    expect(result.repairWarnings.some((warning) => warning.startsWith('Restored Beads refinement ID stability'))).toBe(false)
  })

  it('declines ID repair when another winner bead shares the reused bead title', () => {
    const winnerDocument = readBeadDocument(buildBeadsRefinementContent())
    winnerDocument.beads.push({
      ...winnerDocument.beads[0]!,
      id: 'bead-4',
      title: 'Add cache invalidation coverage',
      description: 'Keep the existing cache invalidation coverage.',
    })
    const winnerDraftContent = writeBeadDocument(winnerDocument)
    const refinedDocument = readBeadDocument(winnerDraftContent)
    const survivingBead = refinedDocument.beads[1]!
    survivingBead.id = 'bead-3'
    survivingBead.description = 'Refresh persistence coverage with storage-shape verification.'
    refinedDocument.beads = [
      refinedDocument.beads[0]!,
      survivingBead,
      {
        ...refinedDocument.beads[0]!,
        id: 'bead-2',
        title: 'Add cache invalidation coverage',
        description: 'Add coverage for invalidating stale cache entries.',
      },
    ]
    refinedDocument.changes = [
      modifiedChange(
        { id: 'bead-2', label: 'Update persistence coverage' },
        { id: 'bead-3', label: 'Update persistence coverage' },
      ),
      {
        type: 'added',
        item_type: 'bead',
        before: null,
        after: { id: 'bead-2', label: 'Add cache invalidation coverage' },
      },
    ]

    expect(() => validateBeadsRefinementOutput(writeBeadDocument(refinedDocument), { winnerDraftContent }))
      .toThrow('modified bead ids must remain stable')
  })

  it('does not repair a title-resolved modification with incorrect declared ids', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinedDocument = readBeadDocument(winnerDraftContent)
    const survivingBead = refinedDocument.beads[1]!
    survivingBead.id = 'bead-3'
    survivingBead.description = 'Refresh persistence coverage with storage-shape verification.'
    refinedDocument.beads = [
      refinedDocument.beads[0]!,
      survivingBead,
      {
        ...refinedDocument.beads[0]!,
        id: 'bead-2',
        title: 'Add cache invalidation coverage',
        description: 'Cover cache invalidation explicitly.',
      },
    ]
    refinedDocument.changes = [modifiedChange(
      { id: 'wrong-before', label: 'Update persistence coverage' },
      { id: 'wrong-after', label: 'Update persistence coverage' },
    )]

    expect(() => validateBeadsRefinementOutput(writeBeadDocument(refinedDocument), { winnerDraftContent }))
      .toThrow('modified bead ids must remain stable (before "bead-2", after "bead-3")')
  })

  it('does not treat a moved winner bead as newly added when its title matches', () => {
    const winnerDocument = readBeadDocument(buildBeadsRefinementContent())
    const existingBead = {
      ...winnerDocument.beads[0]!,
      id: 'bead-4',
      title: 'Add cache invalidation coverage',
      description: 'Cover cache invalidation explicitly.',
    }
    winnerDocument.beads.push(existingBead)

    const winnerDraftContent = writeBeadDocument(winnerDocument)
    const refinedDocument = readBeadDocument(winnerDraftContent)
    const survivingBead = refinedDocument.beads[1]!
    survivingBead.id = 'bead-3'
    survivingBead.description = 'Refresh persistence coverage with storage-shape verification.'
    refinedDocument.beads = [
      refinedDocument.beads[0]!,
      survivingBead,
      { ...existingBead, id: 'bead-2' },
    ]
    refinedDocument.changes = [
      modifiedChange(
        { id: 'bead-2', label: 'Update persistence coverage' },
        { id: 'bead-3', label: 'Update persistence coverage' },
      ),
      {
        type: 'added',
        item_type: 'bead',
        before: null,
        after: { id: 'bead-2', label: 'Add cache invalidation coverage' },
      },
    ]

    expect(() => validateBeadsRefinementOutput(writeBeadDocument(refinedDocument), { winnerDraftContent }))
      .toThrow('modified bead ids must remain stable (before "bead-2", after "bead-3")')
  })

  it.each([
    ['the reused id', 'bead-2', 'Update persistence coverage'],
    ['the shifted id', 'bead-3', 'Update persistence coverage'],
  ])('declines a stable-id repair when a removal also references %s', (_label, removedId, removedLabel) => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinedDocument = readBeadDocument(winnerDraftContent)
    const survivingBead = refinedDocument.beads[1]!
    survivingBead.id = 'bead-3'
    survivingBead.description = 'Refresh persistence coverage with storage-shape verification.'
    const addedBead = {
      ...refinedDocument.beads[0]!,
      id: 'bead-2',
      title: 'Add cache invalidation coverage',
      description: 'Cover cache invalidation explicitly.',
    }
    refinedDocument.beads = [refinedDocument.beads[0]!, survivingBead, addedBead]
    refinedDocument.changes = [
      modifiedChange(
        { id: 'bead-2', label: 'Update persistence coverage' },
        { id: 'bead-3', label: 'Update persistence coverage' },
      ),
      {
        type: 'added',
        item_type: 'bead',
        before: null,
        after: { id: 'bead-2', label: 'Add cache invalidation coverage' },
      },
      {
        type: 'removed',
        item_type: 'bead',
        before: { id: removedId, label: removedLabel },
        after: null,
      },
    ]

    expect(() => validateBeadsRefinementOutput(writeBeadDocument(refinedDocument), { winnerDraftContent }))
      .toThrow('modified bead ids must remain stable')
  })

  it.each([
    [
      'a prdRefs-only edit',
      (content: string) => content.replace('    prdRefs: ["EPIC-1", "US-2"]', '    prdRefs: ["EPIC-1", "US-3"]'),
    ],
    [
      'a contextGuidance-only edit',
      (content: string) => content.replace(
        '        - "Reuse the existing persistence path."',
        '        - "Reuse the existing persistence path and its storage key."',
      ),
    ],
  ])('accounts for %s that the model did not declare', (_label, edit) => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const result = validateBeadsRefinementOutput(edit(buildBeadsRefinementContent()), { winnerDraftContent })

    // Neither field was in the fingerprint, so the edit was dropped from
    // `changes` while the YAML kept the new value.
    expect(result.changes).toEqual([
      expect.objectContaining({
        type: 'modified',
        before: expect.objectContaining({ id: 'bead-2' }),
        after: expect.objectContaining({ id: 'bead-2' }),
      }),
    ])
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

  it('resolves change items by a unique title and returns the canonical ids', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinedContent = withChanges(
      buildBeadsRefinementContent({
        beadTwoDescription: 'Refresh the persistence coverage details with storage-shape verification.',
      }),
      [modifiedChange(
        { id: 'stale-before', label: '  UPDATE persistence coverage ' },
        { id: 'stale-after', label: ' Update persistence coverage ' },
      )],
    )

    const result = validateBeadsRefinementOutput(refinedContent, { winnerDraftContent })

    expect(result.changes).toEqual([
      expect.objectContaining({
        type: 'modified',
        before: expect.objectContaining({ id: 'bead-2', label: 'Update persistence coverage' }),
        after: expect.objectContaining({ id: 'bead-2', label: 'Update persistence coverage' }),
      }),
    ])
  })

  it('repairs an incomplete modified record from the canonical bead diff', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinedContent = withChanges(
      buildBeadsRefinementContent({
        beadTwoDescription: 'Refresh the persistence coverage details with storage-shape verification.',
      }),
      [modifiedChange(
        { id: 'unknown-bead', label: 'No matching winner bead' },
        { id: 'bead-2', label: 'Update persistence coverage' },
      )],
    )

    const result = validateBeadsRefinementOutput(refinedContent, { winnerDraftContent })

    expect(result.changes).toEqual([
      expect.objectContaining({
        type: 'modified',
        before: expect.objectContaining({ id: 'bead-2' }),
        after: expect.objectContaining({ id: 'bead-2' }),
        attributionStatus: 'synthesized_unattributed',
      }),
    ])
    expect(result.repairWarnings).toContain(
      'Skipped beads refinement change at index 0: modified change has no resolvable before or after item.',
    )
  })

  it('detects list edits even when delimiter-joined fingerprints would collide', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const winnerDocument = readBeadDocument(winnerDraftContent)
    const refinedDocument = readBeadDocument(buildBeadsRefinementContent({
      beadTwoDescription: 'Refresh the persistence coverage details with storage-shape verification.',
    }))
    ;(winnerDocument.beads[0]!.contextGuidance as Record<string, unknown>).patterns = ['alpha|beta']
    ;(refinedDocument.beads[0]!.contextGuidance as Record<string, unknown>).patterns = ['alpha', 'beta']
    refinedDocument.changes = [modifiedChange(
      { id: 'bead-2', label: 'Update persistence coverage' },
      { id: 'bead-2', label: 'Update persistence coverage' },
    )]

    const result = validateBeadsRefinementOutput(
      writeBeadDocument(refinedDocument),
      { winnerDraftContent: writeBeadDocument(winnerDocument) },
    )

    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'modified',
        before: expect.objectContaining({ id: 'bead-1' }),
        after: expect.objectContaining({ id: 'bead-1' }),
        attributionStatus: 'synthesized_unattributed',
      }),
    ]))
    expect(result.repairWarnings).toContain(
      'Synthesized omitted beads refinement modified change for bead "bead-1" by matching id across the winning and refined drafts.',
    )
  })

  it('synthesizes omitted add and remove records from a partially declared refinement', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinedDocument = readBeadDocument(winnerDraftContent)
    const switcherBead = refinedDocument.beads[0]!
    switcherBead.description = 'Keep the switcher accessible from the keyboard.'
    refinedDocument.beads = [
      switcherBead,
      {
        ...refinedDocument.beads[1]!,
        id: 'bead-3',
        title: 'Add cache invalidation coverage',
        prdRefs: ['EPIC-1', 'US-3'],
        description: 'Cover cache invalidation explicitly.',
      },
    ]
    refinedDocument.changes = [modifiedChange(
      { id: 'bead-1', label: 'Keep existing switcher bead' },
      { id: 'bead-1', label: 'Keep existing switcher bead' },
    )]

    const result = validateBeadsRefinementOutput(writeBeadDocument(refinedDocument), { winnerDraftContent })

    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'added',
        before: null,
        after: expect.objectContaining({ id: 'bead-3', label: 'Add cache invalidation coverage' }),
        attributionStatus: 'synthesized_unattributed',
      }),
      expect.objectContaining({
        type: 'removed',
        before: expect.objectContaining({ id: 'bead-2', label: 'Update persistence coverage' }),
        after: null,
        attributionStatus: 'synthesized_unattributed',
      }),
    ]))
    expect(result.repairWarnings).toContain(
      'Synthesized omitted beads refinement added change for bead "bead-3" (present in refined output but not in winner draft).',
    )
    expect(result.repairWarnings).toContain(
      'Synthesized omitted beads refinement removed change for bead "bead-2" (present in winner draft but not in refined output).',
    )
    expect(result.repairWarnings.some((warning) => warning.includes('do not fully account for the diff'))).toBe(false)
  })

  it('repairs a declared removal when the same bead ID remains in the refined draft', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinedDocument = readBeadDocument(winnerDraftContent)
    refinedDocument.beads[1]!.description = 'Refresh persistence coverage with storage-shape verification.'
    refinedDocument.changes = [{
      type: 'removed',
      item_type: 'bead',
      before: { id: 'bead-2', label: 'Update persistence coverage' },
      after: null,
    }]

    const result = validateBeadsRefinementOutput(writeBeadDocument(refinedDocument), { winnerDraftContent })

    expect(result.changes).toEqual([
      expect.objectContaining({
        type: 'modified',
        before: expect.objectContaining({ id: 'bead-2' }),
        after: expect.objectContaining({ id: 'bead-2' }),
        attributionStatus: 'synthesized_unattributed',
      }),
    ])
    expect(result.repairWarnings).toContain(
      'Skipped beads refinement change at index 0: removed bead "bead-2" remains in the refined output.',
    )
    expect(result.repairWarnings).not.toContain(
      'Synthesized omitted beads refinement added change for bead "bead-2" (present in refined output but not in winner draft).',
    )
    expect(result.repairWarnings.some((warning) => warning.includes('do not fully account for the diff'))).toBe(false)
  })

  it('repairs a declared addition when the same bead ID already exists in the winner draft', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinedDocument = readBeadDocument(winnerDraftContent)
    refinedDocument.beads[1]!.description = 'Refresh persistence coverage with storage-shape verification.'
    refinedDocument.changes = [{
      type: 'added',
      item_type: 'bead',
      before: null,
      after: { id: 'bead-2', label: 'Update persistence coverage' },
    }]

    const result = validateBeadsRefinementOutput(writeBeadDocument(refinedDocument), { winnerDraftContent })

    expect(result.changes).toEqual([
      expect.objectContaining({
        type: 'modified',
        before: expect.objectContaining({ id: 'bead-2' }),
        after: expect.objectContaining({ id: 'bead-2' }),
        attributionStatus: 'synthesized_unattributed',
      }),
    ])
    expect(result.repairWarnings).toContain(
      'Skipped beads refinement change at index 0: added bead "bead-2" already exists in the winner draft.',
    )
    expect(result.repairWarnings.some((warning) => warning.includes('do not fully account for the diff'))).toBe(false)
  })

  it('keeps an unproven title-matched ID drift as an add and remove', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinedDocument = readBeadDocument(winnerDraftContent)
    refinedDocument.beads[0]!.description = 'Keep the switcher accessible from the keyboard.'
    refinedDocument.beads[1]!.id = 'bead-3'
    refinedDocument.beads[1]!.description = 'Refresh persistence coverage with storage-shape verification.'
    refinedDocument.changes = [modifiedChange(
      { id: 'bead-1', label: 'Keep existing switcher bead' },
      { id: 'bead-1', label: 'Keep existing switcher bead' },
    )]

    const result = validateBeadsRefinementOutput(writeBeadDocument(refinedDocument), { winnerDraftContent })

    expect(result.changes).toHaveLength(3)
    expect(result.changes.filter((change) => change.attributionStatus === 'synthesized_unattributed')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'added',
        before: null,
        after: expect.objectContaining({ id: 'bead-3', label: 'Update persistence coverage' }),
      }),
      expect.objectContaining({
        type: 'removed',
        before: expect.objectContaining({ id: 'bead-2', label: 'Update persistence coverage' }),
        after: null,
      }),
    ]))
    expect(result.changes.every((change) => change.type !== 'modified' || change.before?.id === change.after?.id)).toBe(true)
  })

  it('keeps an identical inspiration when duplicate modified records collapse', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const change = modifiedChange(
      { id: 'bead-2', label: 'Update persistence coverage' },
      { id: 'bead-2', label: 'Update persistence coverage' },
      { alternative_draft: 1, item: { id: 'idea-1', title: 'Add coverage for expiry' } },
    )
    const refinedContent = withChanges(
      buildBeadsRefinementContent({
        beadTwoDescription: 'Refresh the persistence coverage details with storage-shape verification.',
      }),
      [change, structuredClone(change)],
    )

    const result = validateBeadsRefinementOutput(refinedContent, {
      winnerDraftContent,
      losingDraftMeta: [{ memberId: TEST.councilMembers[0] }],
    })

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({
      attributionStatus: 'inspired',
      inspiration: { draftIndex: 0, memberId: TEST.councilMembers[0] },
    })
    expect(result.repairWarnings).toContain(
      'Collapsed duplicate beads refinement modified change at index 1 because bead-2 was already covered by an identical modified change.',
    )
  })

  it('drops conflicting inspiration when duplicate modified records disagree', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const before = { id: 'bead-2', label: 'Update persistence coverage' }
    const after = { id: 'bead-2', label: 'Update persistence coverage' }
    const refinedContent = withChanges(
      buildBeadsRefinementContent({
        beadTwoDescription: 'Refresh the persistence coverage details with storage-shape verification.',
      }),
      [
        modifiedChange(before, after, {
          alternative_draft: 1,
          item: { id: 'idea-1', title: 'Add coverage for expiry', detail: 'First rationale' },
        }),
        modifiedChange(before, after, {
          alternative_draft: 1,
          item: { id: 'idea-1', title: 'Add coverage for expiry', detail: 'Different rationale' },
        }),
      ],
    )

    const result = validateBeadsRefinementOutput(refinedContent, {
      winnerDraftContent,
      losingDraftMeta: [{ memberId: TEST.councilMembers[0] }],
    })

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({ inspiration: null, attributionStatus: 'model_unattributed' })
  })

  it('collapses malformed and absent inspiration to model attribution', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const before = { id: 'bead-2', label: 'Update persistence coverage' }
    const after = { id: 'bead-2', label: 'Update persistence coverage' }
    const refinedContent = withChanges(
      buildBeadsRefinementContent({
        beadTwoDescription: 'Refresh the persistence coverage details with storage-shape verification.',
      }),
      [
        modifiedChange(before, after),
        modifiedChange(before, after, { alternative_draft: 1, item: null }),
      ],
    )

    const result = validateBeadsRefinementOutput(refinedContent, { winnerDraftContent })

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({ inspiration: null, attributionStatus: 'model_unattributed' })
  })

  it('declines the ID stability repair when a surviving title is ambiguous', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const winnerDocument = readBeadDocument(winnerDraftContent)
    const firstBead = { ...winnerDocument.beads[0]!, title: 'Update persistence coverage' }
    const secondBead = winnerDocument.beads[1]!
    const shiftedBead = {
      ...secondBead,
      id: 'bead-3',
      description: 'Refresh the persistence coverage details with storage-shape verification.',
    }
    const addedBead = {
      ...firstBead,
      id: 'bead-2',
      title: 'Add cache invalidation coverage',
      description: 'Cover cache invalidation explicitly.',
    }
    const refinedContent = writeBeadDocument({
      beads: [firstBead, shiftedBead, addedBead],
      changes: [
        modifiedChange(
          { id: 'bead-2', label: 'Update persistence coverage' },
          { id: 'bead-3', label: 'Update persistence coverage' },
        ),
        { type: 'added', item_type: 'bead', before: null, after: { id: 'bead-2', label: 'Add cache invalidation coverage' } },
      ],
    })

    expect(() => validateBeadsRefinementOutput(refinedContent, { winnerDraftContent }))
      .toThrow('modified bead ids must remain stable')
  })
})

describe('beads refined artifact helpers', () => {
  it('builds an artifact with a trimmed council winner and omits empty optional fields', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinement = validateBeadsRefinementOutput(winnerDraftContent, { winnerDraftContent })
    const artifact = buildBeadsRefinedArtifact(
      `  ${TEST.councilMembers[0]}  `,
      winnerDraftContent,
      refinement,
      { repairApplied: false, repairWarnings: [], autoRetryCount: 0 },
    )

    expect(artifact).toMatchObject({
      winnerId: TEST.councilMembers[0],
      refinedContent: refinement.refinedContent,
      draftMetrics: { beadCount: 2, totalTestCount: 2, totalAcceptanceCriteriaCount: 2 },
      pipelineSteps: BEADS_PIPELINE_STEPS,
      structuredOutput: { repairApplied: false, autoRetryCount: 0 },
    })
    expect(artifact).not.toHaveProperty('changes')
    expect(getRefinementBeadMetrics(refinement.beadSubsets)).toEqual(artifact.draftMetrics)
    expect(() => buildBeadsRefinedArtifact('  ', winnerDraftContent, refinement))
      .toThrow('Beads refined artifact is missing winnerId')
  })

  it('includes non-empty changes when building the artifact', () => {
    const winnerDraftContent = buildBeadsRefinementContent()
    const refinedContent = buildBeadsRefinementContent({
      beadTwoDescription: 'Refresh the persistence coverage details with storage-shape verification.',
    })
    const refinement = validateBeadsRefinementOutput(refinedContent, { winnerDraftContent })
    const artifact = buildBeadsRefinedArtifact(TEST.model, winnerDraftContent, refinement)

    expect(artifact.changes).toEqual(refinement.changes)
  })

  it.each([
    ['invalid JSON', '{ truncated', 'Beads refined artifact is not valid JSON'],
    ['a non-object payload', '[]', 'Beads refined artifact payload is invalid'],
    ['blank refined content', JSON.stringify({ refinedContent: '  ' }), 'Beads refined artifact is missing refinedContent'],
    ['metrics that cannot be derived', JSON.stringify({ refinedContent: 'not: [valid' }), 'Beads refined artifact is missing draftMetrics'],
  ])('rejects %s', (_label, content, message) => {
    expect(() => parseBeadsRefinedArtifact(content)).toThrow(message)
  })

  it('derives metrics from a legacy bead list and restores the default pipeline', () => {
    const artifact = parseBeadsRefinedArtifact(JSON.stringify({
      winnerId: ` ${TEST.model} `,
      refinedContent: jsYaml.dump([
        { acceptance_criteria: ['one', 'two'], tests: ['first'] },
        'non-object entry',
        { acceptanceCriteria: ['three'], tests: [] },
      ]) as string,
      pipelineSteps: [],
    }))

    expect(artifact).toMatchObject({
      winnerId: TEST.model,
      draftMetrics: { beadCount: 3, totalTestCount: 1, totalAcceptanceCriteriaCount: 3 },
      pipelineSteps: BEADS_PIPELINE_STEPS,
    })
  })

  it('re-derives metrics when the stored metrics contain invalid counts', () => {
    const artifact = parseBeadsRefinedArtifact(JSON.stringify({
      refinedContent: jsYaml.dump({ beads: [{ tests: ['first'], acceptanceCriteria: ['one'] }] }),
      draftMetrics: { beadCount: 1.5, totalTestCount: '1', totalAcceptanceCriteriaCount: 1 },
    }))

    expect(artifact.draftMetrics).toEqual({ beadCount: 1, totalTestCount: 1, totalAcceptanceCriteriaCount: 1 })
  })

  it('accepts normalized metrics and only keeps valid custom pipeline steps', () => {
    const artifact = parseBeadsRefinedArtifact(JSON.stringify({
      refinedContent: 'beads: []',
      draftMetrics: { beadCount: 7, totalTestCount: 9, totalAcceptanceCriteriaCount: 11 },
      pipelineSteps: [
        null,
        { step: 'custom_review', description: 'Review custom refinements.' },
        { step: 'missing_description' },
      ],
      changes: 'not-an-array',
    }))

    expect(artifact).toMatchObject({
      draftMetrics: { beadCount: 7, totalTestCount: 9, totalAcceptanceCriteriaCount: 11 },
      pipelineSteps: [{ step: 'custom_review', description: 'Review custom refinements.' }],
      changes: [],
    })
  })
})

describe('beads refinement retry prompt', () => {
  it('strips a top-level legacy changes block while preserving the bead content', () => {
    const prompt = buildBeadsRefinementRetryPrompt([], {
      validationError: 'changes did not match the refined output',
      rawResponse: 'beads:\n  - id: bead-1\n    title: Keep the existing bead\nchanges:\n  - type: modified\n',
    })

    expect(prompt.at(-1)?.content).toContain('## Beads Refinement Structured Output Retry')
    expect(prompt.at(-1)?.content).toContain('Your previous response failed validation: changes did not match the refined output')
    expect(prompt.at(-1)?.content).toContain('title: Keep the existing bead')
    expect(prompt.at(-1)?.content).not.toContain('\nchanges:')
  })

  it('preserves malformed YAML while removing only the legacy changes section', () => {
    const prompt = buildBeadsRefinementRetryPrompt([], {
      validationError: 'invalid YAML',
      rawResponse: 'beads: [unterminated\nchanges:\n  - type: modified\n    before: old\n',
    })

    expect(prompt.at(-1)?.content).toContain('beads: [unterminated')
    expect(prompt.at(-1)?.content).not.toContain('\nchanges:')
  })

  it('keeps blank previous responses blank in the prompt', () => {
    const prompt = buildBeadsRefinementRetryPrompt([], {
      validationError: 'empty result',
      rawResponse: '  \n\t',
    })

    expect(prompt.at(-1)?.content).toContain('## Previous Invalid Response\n```yaml\n\n```')
  })
})
