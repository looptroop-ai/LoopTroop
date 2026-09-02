import { describe, expect, it } from 'vitest'
import { createShellCommandSpec } from '@shared/commandSpec'
import { getCoverageBeadMetrics } from '../../../structuredOutput'
import { getRefinementBeadMetrics } from '../refined'
import type { BeadSubset } from '../types'

const beads: BeadSubset[] = [{
  id: 'bead-1',
  title: 'First bead',
  prdRefs: ['EPIC-1'],
  description: 'Do the first step.',
  contextGuidance: { patterns: ['Keep it scoped.'], anti_patterns: ['Do not wander.'] },
  acceptanceCriteria: ['Done.', 'Reviewed.'],
  tests: ['Test it.'],
  testCommands: [createShellCommandSpec('npm run test'), createShellCommandSpec('npm run lint')],
}]

/**
 * The two metric shapes are deliberately different, which is why they no longer
 * share a name one letter apart. Coverage reads the command count; refinement
 * does not, and the interface never renders it.
 */
describe('bead metric shapes', () => {
  it('coverage metrics count test commands', () => {
    expect(getCoverageBeadMetrics(beads)).toEqual({
      beadCount: 1,
      totalTestCount: 1,
      totalTestCommandCount: 2,
      totalAcceptanceCriteriaCount: 2,
    })
  })

  it('refinement metrics do not', () => {
    expect(getRefinementBeadMetrics(beads)).toEqual({
      beadCount: 1,
      totalTestCount: 1,
      totalAcceptanceCriteriaCount: 2,
    })
  })
})
