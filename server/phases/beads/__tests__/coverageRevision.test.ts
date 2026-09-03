import * as jsYaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  buildBeadsCoverageRevisionRetryPrompt,
  parseBeadsCoverageRevisionRefinedContent,
  validateBeadsCoverageRevisionOutput,
} from '../coverageRevision'

function buildBeadsContent() {
  return jsYaml.dump({
    beads: [{
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
      testCommands: ['npm run test:server'],
    }],
    changes: [],
  }, { lineWidth: 120, noRefs: true }) as string
}

describe.concurrent('beads coverage revision parsing', () => {
  it('infers a missing beads coverage affected_items item_type from a unique bead id', () => {
    const coverageGap = 'Keep the attribution bead visible in the saved metadata.'
    const currentCandidateContent = buildBeadsContent()
    const revised = jsYaml.load(currentCandidateContent) as Record<string, unknown>

    revised.gap_resolutions = [{
      gap: coverageGap,
      action: 'already_covered',
      rationale: 'The existing bead already preserves the needed attribution handling.',
      affected_items: [{
        id: 'bead-1',
        label: 'Validate refinement attribution',
      }],
    }]

    const result = validateBeadsCoverageRevisionOutput(
      jsYaml.dump(revised, { lineWidth: 120, noRefs: true }) as string,
      {
        currentCandidateContent,
        coverageGaps: [coverageGap],
      },
    )

    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Inferred missing beads coverage affected_items item_type')
    expect(result.gapResolutions[0]?.affectedItems).toEqual([
      {
        itemType: 'bead',
        id: 'bead-1',
        label: 'Validate refinement attribution',
      },
    ])
  })

  it('canonicalizes harmless quote changes in beads coverage gap references', () => {
    const coverageGap = 'Bead "bead-1" must keep context guidance inspectable.'
    const currentCandidateContent = buildBeadsContent()
    const revised = jsYaml.load(currentCandidateContent) as Record<string, unknown>

    revised.gap_resolutions = [{
      gap: "Bead 'bead-1' must keep context guidance inspectable.",
      action: 'already_covered',
      rationale: 'The existing bead already keeps context guidance inspectable.',
      affected_items: [],
    }]

    const result = validateBeadsCoverageRevisionOutput(
      jsYaml.dump(revised, { lineWidth: 120, noRefs: true }) as string,
      {
        currentCandidateContent,
        coverageGaps: [coverageGap],
      },
    )

    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Canonicalized beads coverage gap reference')
    expect(result.gapResolutions[0]?.gap).toBe(coverageGap)
  })

  it('canonicalizes escaped quote differences in beads coverage gap references', () => {
    const coverageGap = 'Bead \\"bead-1\\" must keep context guidance inspectable.'
    const currentCandidateContent = buildBeadsContent()
    const revised = jsYaml.load(currentCandidateContent) as Record<string, unknown>

    revised.gap_resolutions = [{
      gap: 'Bead "bead-1" must keep context guidance inspectable.',
      action: 'already_covered',
      rationale: 'The existing bead already keeps context guidance inspectable.',
      affected_items: [],
    }]

    const result = validateBeadsCoverageRevisionOutput(
      jsYaml.dump(revised, { lineWidth: 120, noRefs: true }) as string,
      {
        currentCandidateContent,
        coverageGaps: [coverageGap],
      },
    )

    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Canonicalized beads coverage gap reference')
    expect(result.gapResolutions[0]?.gap).toBe(coverageGap)
  })

  it('keeps the retry prompt strict about unresolved source-artifact contradictions', () => {
    const prompt = buildBeadsCoverageRevisionRetryPrompt([], {
      validationError: 'missing gap_resolutions',
      rawResponse: 'beads: []',
    })

    expect(prompt.at(-1)?.content).toContain('internally contradictory source artifacts')
    expect(prompt.at(-1)?.content).toContain('action: left_unresolved')
    expect(prompt.at(-1)?.content).toContain('affected_items: []')
  })
})

describe('the model\'s own changes block', () => {
  it('is not forwarded to refinement validation, so no change is skipped as summary-only', () => {
    // PROM24 asks for `{type, id, title, summary}` entries. Forwarding those to
    // `parseRefinementChanges`, which needs before/after item records, skipped
    // every one with a repair warning and then synthesized the same diff anyway.
    const coverageGap = 'Nothing covers the revised description.'
    const currentCandidateContent = buildBeadsContent()
    const revised = jsYaml.load(currentCandidateContent) as Record<string, unknown>
    const beads = revised.beads as Array<Record<string, unknown>>
    beads[0]!.description = 'Preserve explicit inspiration and cover the rollout gap.'
    revised.changes = [{
      type: 'modified',
      id: 'bead-1',
      title: 'Validate refinement attribution',
      summary: 'Covered the rollout gap.',
    }]
    revised.gap_resolutions = [{
      gap: coverageGap,
      action: 'updated_beads',
      rationale: 'Extended the bead to cover rollout.',
      affected_items: [{ item_type: 'bead', id: 'bead-1', label: 'Validate refinement attribution' }],
    }]

    const result = validateBeadsCoverageRevisionOutput(
      jsYaml.dump(revised, { lineWidth: 120, noRefs: true }) as string,
      { currentCandidateContent, coverageGaps: [coverageGap] },
    )

    expect(result.repairWarnings.some((warning) => warning.includes('summary metadata only'))).toBe(false)
    expect(result.changes).toEqual([
      expect.objectContaining({ type: 'modified', itemType: 'bead' }),
    ])
  })
})

describe('parseBeadsCoverageRevisionRefinedContent', () => {
  it('returns the persisted candidate blueprint', () => {
    const content = JSON.stringify({ winnerId: 'model-a', refinedContent: 'beads:\n  - id: bead-1' })
    expect(parseBeadsCoverageRevisionRefinedContent(content)).toBe('beads:\n  - id: bead-1')
  })

  it('rejects an artifact that is not JSON', () => {
    expect(() => parseBeadsCoverageRevisionRefinedContent('{ truncated'))
      .toThrow('Beads coverage revision artifact is not valid JSON')
  })

  it('rejects an artifact with no refinedContent', () => {
    expect(() => parseBeadsCoverageRevisionRefinedContent(JSON.stringify({ winnerId: 'model-a' })))
      .toThrow('Beads coverage revision artifact is missing refinedContent')
  })

  it('rejects an artifact whose refinedContent is blank', () => {
    expect(() => parseBeadsCoverageRevisionRefinedContent(JSON.stringify({ refinedContent: '   ' })))
      .toThrow('Beads coverage revision artifact is missing refinedContent')
  })
})
