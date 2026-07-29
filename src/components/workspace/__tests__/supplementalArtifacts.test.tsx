import { describe, expect, it } from 'vitest'
import { getSupplementalArtifacts } from '../supplementalArtifacts'

describe.concurrent('getSupplementalArtifacts', () => {
  it('describes the two-step beads finalization flow during REFINING_BEADS', () => {
    expect(getSupplementalArtifacts('REFINING_BEADS')).toContainEqual(
      expect.objectContaining({
        id: 'final-beads-draft',
        description: 'Semantic blueprint consolidated from the winning draft with the strongest ideas from the losing drafts.',
      }),
    )
  })

  it('describes the coverage-stage beads artifact during VERIFYING_BEADS_COVERAGE', () => {
    expect(getSupplementalArtifacts('VERIFYING_BEADS_COVERAGE')).toContainEqual(
      expect.objectContaining({
        id: 'refined-beads',
        description: 'Latest blueprint candidate — semantic during coverage review, expanded into execution-ready beads after expansion.',
      }),
    )
  })

  it('describes the expansion-stage beads artifact during EXPANDING_BEADS', () => {
    expect(getSupplementalArtifacts('EXPANDING_BEADS')).toContainEqual(
      expect.objectContaining({
        id: 'refined-beads',
        description: 'Latest blueprint candidate — semantic during coverage review, expanded into execution-ready beads after expansion.',
      }),
    )
  })

  it('does not duplicate the setup plan artifact during execution setup approval', () => {
    expect(getSupplementalArtifacts('WAITING_EXECUTION_SETUP_APPROVAL')).toEqual([])
  })

  it('keeps the setup plan and generation report visible while drafting', () => {
    expect(getSupplementalArtifacts('GENERATING_EXECUTION_SETUP_PLAN')).toEqual([
      expect.objectContaining({
        id: 'execution-setup-plan',
        label: 'Workspace Setup Plan',
      }),
      expect.objectContaining({
        id: 'execution-setup-plan-report',
        label: 'Generation Report',
      }),
    ])
  })

  it('combines execution setup runtime profile and report into one review artifact', () => {
    const artifacts = getSupplementalArtifacts('PREPARING_EXECUTION_ENV')

    expect(artifacts).toEqual([
      expect.objectContaining({
        id: 'execution-setup-runtime',
        label: 'Execution Setup Runtime',
      }),
    ])
    expect(artifacts).not.toContainEqual(expect.objectContaining({ id: 'execution-setup-profile' }))
    expect(artifacts).not.toContainEqual(expect.objectContaining({ id: 'execution-setup-report' }))
  })

  it('exposes the generated Manual QA checklist as the preparation artifact', () => {
    expect(getSupplementalArtifacts('GENERATING_QA_CHECKLIST')).toEqual([
      expect.objectContaining({
        id: 'manual-qa-checklist',
        label: 'Manual QA Checklist',
      }),
    ])
  })
})
