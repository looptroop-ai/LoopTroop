import type { ManualQaPrd } from './prd'
import type {
  ManualQaChecklist,
  ManualQaCoverage,
  ManualQaPrdCriterion,
} from './types'
import { MANUAL_QA_SCHEMA_VERSION } from './types'

export function deriveManualQaPrdCriteria(
  prd: ManualQaPrd,
): ManualQaPrdCriterion[] {
  return prd.epics.flatMap((epic) => epic.user_stories.flatMap((story) =>
    story.acceptance_criteria.map((criterion, index) => ({
      ref: `${epic.id}/${story.id}/AC-${index + 1}`,
      criterion,
    })),
  ))
}

export function validateManualQaPrdReferences(
  checklist: ManualQaChecklist,
  criteria: readonly ManualQaPrdCriterion[],
): void {
  const validRefs = new Set(criteria.map((entry) => entry.ref))
  const invalidRefs = checklist.items.flatMap((item) =>
    item.prdRefs
      .filter((reference) => !validRefs.has(reference.ref))
      .map((reference) => `${item.id}: ${reference.ref}`),
  )
  const invalidNotApplicableRefs = checklist.notApplicablePrdRefs
    .filter((reference) => !validRefs.has(reference.ref))
    .map((reference) => reference.ref)
  const referencedRefs = new Set(checklist.items.flatMap((item) => item.prdRefs.map((reference) => reference.ref)))
  const overlappingRefs = checklist.notApplicablePrdRefs
    .filter((reference) => referencedRefs.has(reference.ref))
    .map((reference) => reference.ref)
  if (invalidRefs.length > 0) {
    throw new Error(`Checklist contains invalid PRD criterion references: ${invalidRefs.join(', ')}`)
  }
  if (invalidNotApplicableRefs.length > 0) {
    throw new Error(`Checklist contains invalid not-applicable PRD criterion references: ${invalidNotApplicableRefs.join(', ')}`)
  }
  if (overlappingRefs.length > 0) {
    throw new Error(`PRD criteria cannot be both checklist-covered and not applicable to Manual QA: ${overlappingRefs.join(', ')}`)
  }
}

export function computeManualQaCoverage(
  checklist: ManualQaChecklist,
  criteria: readonly ManualQaPrdCriterion[],
): ManualQaCoverage {
  validateManualQaPrdReferences(checklist, criteria)

  const entries = criteria.map((criterion) => {
    const notApplicable = checklist.notApplicablePrdRefs.find((reference) => reference.ref === criterion.ref)
    const references = checklist.items.flatMap((item) =>
      item.prdRefs
        .filter((reference) => reference.ref === criterion.ref)
        .map((reference) => ({ itemId: item.id, coverage: reference.coverage })),
    )
    const status = notApplicable
      ? 'not_applicable' as const
      : references.some((reference) => reference.coverage === 'full')
      ? 'covered' as const
      : references.some((reference) => reference.coverage === 'partial')
        ? 'partially_covered' as const
        : 'uncovered' as const

    return {
      criterionRef: criterion.ref,
      criterion: criterion.criterion,
      status,
      itemIds: [...new Set(references.map((reference) => reference.itemId))],
      ...(notApplicable ? { reason: notApplicable.reason } : {}),
    }
  })
  const countSource = (source: ManualQaChecklist['items'][number]['source']) =>
    checklist.items.filter((item) => item.source === source).length

  return {
    schemaVersion: MANUAL_QA_SCHEMA_VERSION,
    artifact: 'manual_qa_coverage',
    ticketId: checklist.ticketId,
    version: checklist.version,
    entries,
    coveredCount: entries.filter((entry) => entry.status === 'covered').length,
    partiallyCoveredCount: entries.filter((entry) => entry.status === 'partially_covered').length,
    uncoveredCount: entries.filter((entry) => entry.status === 'uncovered').length,
    notApplicableCount: entries.filter((entry) => entry.status === 'not_applicable').length,
    sourceItemCounts: {
      prd: countSource('prd'),
      bead: countSource('bead'),
      previousQa: countSource('previous_qa'),
      implementationDiff: countSource('implementation_diff'),
    },
  }
}
