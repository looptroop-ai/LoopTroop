import { describe, expect, it } from 'vitest'
import { parseCoverageGapResolutions } from '../coverageGapResolutions'

describe('parseCoverageGapResolutions', () => {
  it('uses the canonical top-level alias regardless of payload key order', () => {
    const result = parseCoverageGapResolutions(
      {
        gapResolutions: [{
          gap: 'Keep the saved diff visible.',
          action: 'already_covered',
          rationale: 'Legacy spelling should not win.',
          affectedItems: [],
        }],
        gap_resolutions: [{
          gap: 'Keep the saved diff visible.',
          action: 'already_covered',
          rationale: 'The canonical spelling wins.',
          affected_items: [],
        }],
      },
      ['Keep the saved diff visible.'],
      {
        label: 'Test',
        gapMatchLabel: 'Canonicalized test',
        resolveAction: (normalizedAction) => normalizedAction === 'alreadycovered'
          ? 'already_covered'
          : null,
        resolveAffectedItem: ({ id, label }) => ({ itemType: 'thing', id, label }),
      },
    )

    expect(result.gapResolutions[0]?.rationale).toBe('The canonical spelling wins.')
    expect(result.repairWarnings).toEqual([
      'Resolved "gap_resolutions" and ignored the conflicting value in "gapResolutions".',
    ])
  })
})
