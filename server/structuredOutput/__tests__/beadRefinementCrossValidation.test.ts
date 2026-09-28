import { describe, expect, it } from 'vitest'
import { normalizeBeadRefinementOutput } from '../index'
import { TEST } from '../../test/factories'

function bead(id: string, title: string, description: string) {
  return {
    id,
    title,
    prdRefs: ['REQ-1'],
    description,
    contextGuidance: {
      patterns: ['Keep the implementation focused.'],
      anti_patterns: ['Do not change unrelated behavior.'],
    },
    acceptanceCriteria: ['The behavior is verified.'],
    tests: ['Automated tests cover the behavior.'],
    testCommands: [],
    testCommandReason: 'No dedicated command applies.',
  }
}

function document(beads: ReturnType<typeof bead>[], changes?: unknown[]) {
  return JSON.stringify({ beads, ...(changes ? { changes } : {}) })
}

describe('bead refinement cross-validation', () => {
  it('synthesizes a complete diff when the refinement omits changes', () => {
    const winner = document([
      bead('stable', 'Stable work', 'Keep this description.'),
      bead('updated', 'Updated work', 'Original description.'),
      bead('removed', 'Removed work', 'No longer needed.'),
    ])
    const refined = document([
      bead('stable', 'Stable work', 'Keep this description.'),
      bead('updated', 'Updated work', 'Revised description.'),
      bead('added', 'New work', 'Added during refinement.'),
    ])

    const result = normalizeBeadRefinementOutput(refined, winner)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.changes.map(({ type }) => type)).toEqual(['modified', 'added', 'removed'])
    expect(result.value.changes.map(({ attributionStatus }) => attributionStatus))
      .toEqual(['synthesized_unattributed', 'synthesized_unattributed', 'synthesized_unattributed'])
    expect(result.repairWarnings).toHaveLength(3)
  })

  it('returns no synthesized changes when a refinement leaves every bead unchanged', () => {
    const unchanged = document([
      bead('stable', 'Stable work', 'Keep this description.'),
    ])

    const result = normalizeBeadRefinementOutput(unchanged, unchanged)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.changes).toEqual([])
    expect(result.value.repairApplied).toBe(false)
    expect(result.repairWarnings).toEqual([])
  })

  it('synthesizes only the omitted additions and removals beside an explicit edit', () => {
    const winner = document([
      bead('updated', 'Updated work', 'Original description.'),
      bead('removed', 'Removed work', 'No longer needed.'),
    ])
    const refined = document([
      bead('updated', 'Updated work', 'Revised description.'),
      bead('added', 'New work', 'Added during refinement.'),
    ], [
      {
        type: 'modified',
        item_type: 'bead',
        before: { id: 'updated', title: 'Updated work' },
        after: { id: 'updated', title: 'Updated work' },
      },
    ])

    const result = normalizeBeadRefinementOutput(refined, winner)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.changes.map(({ type, before, after, attributionStatus }) => ({
      type,
      before: before?.id ?? null,
      after: after?.id ?? null,
      attributionStatus,
    }))).toEqual([
      { type: 'modified', before: 'updated', after: 'updated', attributionStatus: 'model_unattributed' },
      { type: 'added', before: null, after: 'added', attributionStatus: 'synthesized_unattributed' },
      { type: 'removed', before: 'removed', after: null, attributionStatus: 'synthesized_unattributed' },
    ])
    expect(result.repairWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Synthesized omitted beads refinement added change'),
      expect.stringContaining('Synthesized omitted beads refinement removed change'),
    ]))
  })

  it('drops invalid and no-op changes, resolves labels, and hydrates valid inspiration', () => {
    const winner = document([
      bead('stable', 'Stable work', 'Keep this description.'),
      bead('updated', 'Updated work', 'Original description.'),
      bead('removed', 'Removed work', 'No longer needed.'),
    ])
    const refined = document([
      bead('stable', 'Stable work', 'Keep this description.'),
      bead('updated', 'Updated work', 'Revised description.'),
      bead('added', 'New work', 'Added during refinement.'),
    ], [
      { type: 'modified', item_type: 'bead', before: { id: 'unknown-before', title: 'Missing' }, after: { id: 'unknown-after', title: 'Missing' } },
      { type: 'added', item_type: 'bead', after: { id: 'unknown-added', title: 'Missing' } },
      { type: 'removed', item_type: 'bead', before: { id: 'unknown-removed', title: 'Missing' } },
      { type: 'modified', item_type: 'bead', before: { id: 'stable', title: 'Stable work' }, after: { id: 'stable', title: 'Stable work' } },
      {
        type: 'modified',
        item_type: 'bead',
        before: { id: 'stale-before', title: 'Updated work' },
        after: { id: 'stale-after', title: 'Updated work' },
        inspiration: { alternative_draft: 1, item: { id: 'unknown', title: 'Inspired work' } },
      },
      {
        type: 'added',
        item_type: 'bead',
        after: { id: 'added', title: 'New work' },
        inspiration: { alternative_draft: 2, item: { id: 'unknown', title: 'Missing source' } },
      },
    ])
    const losingDraft = document([bead('source', 'Inspired work', 'Source detail.')])

    const result = normalizeBeadRefinementOutput(refined, winner, [
      { memberId: TEST.councilMembers[0], content: losingDraft },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.changes).toMatchObject([
      {
        type: 'modified',
        before: { id: 'updated', label: 'Updated work' },
        after: { id: 'updated', label: 'Updated work' },
        inspiration: {
          draftIndex: 0,
          memberId: TEST.councilMembers[0],
          item: { id: 'source', label: 'Inspired work', detail: 'Source detail.' },
        },
        attributionStatus: 'inspired',
      },
      {
        type: 'added',
        after: { id: 'added', label: 'New work' },
        inspiration: null,
        attributionStatus: 'invalid_unattributed',
      },
      {
        type: 'removed',
        before: { id: 'removed', label: 'Removed work' },
        attributionStatus: 'synthesized_unattributed',
      },
    ])
    expect(result.repairWarnings.join('\n')).toContain('Skipped beads refinement change')
    expect(result.repairWarnings.join('\n')).toContain('Dropped no-op beads refinement modified change')
    expect(result.repairWarnings.join('\n')).toContain('Cleared out-of-range beads refinement inspiration')
    expect(result.repairWarnings.join('\n')).toContain('Synthesized omitted beads refinement removed change')
  })

  it('rejects malformed refined output and an unparseable winner before publishing changes', () => {
    const valid = document([bead('current', 'Current work', 'Current detail.')])

    const malformedRefined = normalizeBeadRefinementOutput('{}', valid)
    expect(malformedRefined.ok).toBe(false)

    const malformedWinner = normalizeBeadRefinementOutput(valid, '{}')
    expect(malformedWinner.ok).toBe(false)
    if (malformedWinner.ok) return
    expect(malformedWinner.error).toContain('Could not parse the winner bead draft required for refinement cross-validation')
  })
})
