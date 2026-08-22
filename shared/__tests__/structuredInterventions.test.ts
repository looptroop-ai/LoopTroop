import { describe, it, expect } from 'vitest'
import {
  deriveStructuredInterventions,
  mergeStructuredInterventions,
  normalizeStructuredInterventions,
} from '../structuredInterventions'
import type { StructuredIntervention } from '../structuredInterventions'

function deriveOne(warning: string) {
  const result = deriveStructuredInterventions({ repairWarnings: [warning] })
  expect(result).toHaveLength(1)
  return result[0]!
}

function expectIntervention(
  intervention: StructuredIntervention,
  expected: { code: string; stage: string; category: string },
) {
  expect(intervention.code).toBe(expected.code)
  expect(intervention.stage).toBe(expected.stage)
  expect(intervention.category).toBe(expected.category)
  expect(intervention.title.length).toBeGreaterThan(0)
  expect(intervention.summary.length).toBeGreaterThan(0)
  expect(intervention.why.length).toBeGreaterThan(0)
  expect(intervention.how.length).toBeGreaterThan(0)
}

// ── Dropped category ──────────────────────────────────────────────────

describe('dropped interventions', () => {
  it('maps no-op refinement changes', () => {
    const i = deriveOne('Dropped no-op PRD refinement modified change at index 3 because the winning and final records are identical.')
    expectIntervention(i, { code: 'dropped_no_op_change', stage: 'semantic_validation', category: 'dropped' })
  })

  it('maps no-op interview refinement with unchanged keyword', () => {
    const i = deriveOne('Dropped no-op interview refinement replaced at index 2 because the question is unchanged across the winning and final drafts.')
    expectIntervention(i, { code: 'dropped_no_op_change', stage: 'semantic_validation', category: 'dropped' })
  })

  it('maps skipped non-object refinement change', () => {
    const i = deriveOne('Skipped non-object refinement change at index 5.')
    expectIntervention(i, { code: 'dropped_invalid_change', stage: 'semantic_validation', category: 'dropped' })
  })

  it('maps skipped refinement change with invalid type', () => {
    const i = deriveOne('Skipped refinement change at index 2 with invalid type.')
    expectIntervention(i, { code: 'dropped_invalid_change', stage: 'semantic_validation', category: 'dropped' })
  })

  it('maps skipped path and summary only refinement change metadata', () => {
    const i = deriveOne('Skipped refinement change at index 0 with path/summary metadata only; semantic before/after item records are required.')
    expectIntervention(i, { code: 'dropped_invalid_change', stage: 'semantic_validation', category: 'dropped' })
  })

  it('maps ignored because pattern', () => {
    const i = deriveOne('PRD coverage follow_up_questions were ignored because PRD coverage is envelope-only.')
    expectIntervention(i, { code: 'dropped_unsupported_or_partial_data', stage: 'semantic_validation', category: 'dropped' })
  })

  it('maps dropped partial pattern', () => {
    const i = deriveOne('Dropped partial interview refinement change at index 1 because a canonical same-identity modified change for Q3 was synthesized from the winner/final question lists.')
    expectIntervention(i, { code: 'dropped_unsupported_or_partial_data', stage: 'semantic_validation', category: 'dropped' })
  })
})

// ── Attribution category ──────────────────────────────────────────────

describe('attribution interventions', () => {
  it('maps out-of-range inspiration', () => {
    const i = deriveOne('Cleared out-of-range PRD refinement inspiration at index 2 because alternative draft 5 does not exist.')
    expectIntervention(i, { code: 'attribution_out_of_range', stage: 'semantic_validation', category: 'attribution' })
  })

  it('maps inspiration out of bounds', () => {
    const i = deriveOne('Inspiration draftIndex 3 is out of bounds (2 alternatives). Setting inspiration to null.')
    expectIntervention(i, { code: 'attribution_out_of_range', stage: 'semantic_validation', category: 'attribution' })
  })

  it('maps generic attribution repair', () => {
    const i = deriveOne('Repaired source labels for change at index 4.')
    expectIntervention(i, { code: 'attribution_repaired', stage: 'semantic_validation', category: 'attribution' })
  })
})

// ── Synthesized category ──────────────────────────────────────────────

describe('synthesized interventions', () => {
  it('maps inferred missing field', () => {
    const i = deriveOne('Inferred missing PRD refinement item_type at index 3 as epic.')
    expectIntervention(i, { code: 'synthesized_inferred_detail', stage: 'semantic_validation', category: 'synthesized' })
  })

  it('maps synthesized omitted refinement', () => {
    const i = deriveOne('Synthesized omitted PRD refinement modified change for epic EPIC-2 by matching item_type + id across the winning and final drafts.')
    expectIntervention(i, { code: 'synthesized_omitted_refinement', stage: 'semantic_validation', category: 'synthesized' })
  })

  it('maps synthesized omitted interview refinement', () => {
    const i = deriveOne('Synthesized omitted interview refinement modified change for Q7 by matching id and phase across the winning and final drafts.')
    expectIntervention(i, { code: 'synthesized_omitted_refinement', stage: 'semantic_validation', category: 'synthesized' })
  })

  it('maps generic synthesized/rebuilt/reconstructed', () => {
    const i = deriveOne('Rebuilt the missing section from available context.')
    expectIntervention(i, { code: 'synthesized_missing_detail', stage: 'normalize', category: 'synthesized' })
  })
})

// ── Parser fix category ─────────────────────────────────────────────

describe('parser fix interventions', () => {
  it('maps terminal noise', () => {
    const i = deriveOne('Removed terminal noise at end of YAML payload.')
    expectIntervention(i, { code: 'parser_terminal_noise', stage: 'parse', category: 'parser_fix' })
  })

  it('maps closing code fence', () => {
    const i = deriveOne('Removed closing code fence from structured output.')
    expectIntervention(i, { code: 'parser_closing_fence', stage: 'parse', category: 'parser_fix' })
  })

  it('maps markdown code fence', () => {
    const i = deriveOne('Unwrapped markdown code fence wrapping the YAML payload.')
    expectIntervention(i, { code: 'parser_markdown_fence', stage: 'parse', category: 'parser_fix' })
  })

  it('maps wrapper key', () => {
    const i = deriveOne('Removed wrapper key "output" from top level.')
    expectIntervention(i, { code: 'parser_wrapper_key', stage: 'parse', category: 'parser_fix' })
  })

  it('maps xml-style tags', () => {
    const i = deriveOne('Stripped xml-style tags <output>…</output> from payload.')
    expectIntervention(i, { code: 'parser_xml_tags', stage: 'parse', category: 'parser_fix' })
  })

  it('maps inline yaml', () => {
    const i = deriveOne('Converted inline yaml flow syntax to block format.')
    expectIntervention(i, { code: 'parser_inline_yaml', stage: 'parse', category: 'parser_fix' })
  })

  it('maps unbalanced yaml quote (before quoted scalar)', () => {
    const i = deriveOne('Fixed unbalanced yaml quote in field description.')
    expectIntervention(i, { code: 'parser_unbalanced_quote', stage: 'parse', category: 'parser_fix' })
  })

  it('maps quoted scalar', () => {
    const i = deriveOne('Repaired improperly quoted YAML scalar value.')
    expectIntervention(i, { code: 'parser_quoted_scalar', stage: 'parse', category: 'parser_fix' })
  })

  it('maps reserved-indicator scalar repair', () => {
    const i = deriveOne('Quoted plain YAML scalars that began with reserved indicator characters (` or @) before reparsing.')
    expectIntervention(i, { code: 'parser_reserved_indicator_scalar', stage: 'parse', category: 'parser_fix' })
  })

  it('maps free_text scalar formatting repair', () => {
    const i = deriveOne('Repaired YAML free_text scalar formatting before parsing.')
    expectIntervention(i, { code: 'parser_free_text_scalar', stage: 'parse', category: 'parser_fix' })
    expect(i.exactCorrection).toBe('Converted existing free_text answer lines into valid YAML string syntax without inventing answer text.')
  })

  it('maps invalid double-quoted scalar backslash escape repairs', () => {
    const i = deriveOne('Escaped invalid YAML double-quoted scalar backslash sequences before reparsing.')
    expectIntervention(i, { code: 'parser_double_quoted_scalar_escape', stage: 'parse', category: 'parser_fix' })
    expect(i.rule).toEqual({ id: 'parser_double_quoted_scalar_escape', label: 'YAML Escape Repair' })
    expect(i.exactCorrection).toBe('Escaped invalid backslash sequences inside double-quoted YAML scalars before reparsing the payload.')
  })

  it('maps colon-containing plain scalar repairs', () => {
    const i = deriveOne('Quoted YAML plain scalar values containing colon-space before reparsing.')
    expectIntervention(i, { code: 'parser_plain_scalar_colon', stage: 'parse', category: 'parser_fix' })
  })

  it('maps context-safe mapping separator repairs with exact formatting details', () => {
    const i = deriveOne('Repaired YAML mapping keys missing a space after colon before parsing.')
    expectIntervention(i, { code: 'parser_mapping_key_colon_space', stage: 'parse', category: 'parser_fix' })
    expect(i.rule).toEqual({ id: 'parser_mapping_key_colon_space', label: 'YAML Mapping Separator' })
    expect(i.exactCorrection).toBe('Inserted the missing space after a YAML mapping key colon without changing the key or value text.')
    expect(i.examples).toEqual([{
      scope: 'YAML mapping entry',
      before: 'key:value',
      after: 'key: value',
      note: 'Only a missing separator was corrected; scalar list values containing colons were preserved.',
    }])
  })

  it('maps wrapped colon-containing list scalar repairs', () => {
    const i = deriveOne('Folded wrapped YAML list scalar text containing colon-space before reparsing.')
    expectIntervention(i, { code: 'parser_plain_scalar_colon', stage: 'parse', category: 'parser_fix' })
    expect(i.how).toContain('folded its existing wrapped lines')
  })

  it('maps indentation', () => {
    const i = deriveOne('Repaired YAML indentation at line 42.')
    expectIntervention(i, { code: 'parser_indentation', stage: 'parse', category: 'parser_fix' })
  })

  it('maps yaml list dash', () => {
    const i = deriveOne('Fixed malformed yaml list dash at line 10.')
    expectIntervention(i, { code: 'parser_list_dash', stage: 'parse', category: 'parser_fix' })
  })

  it('maps yaml sequence item primary key repair with dynamic details', () => {
    const i = deriveOne('Repaired YAML sequence entry under "beads" at line 12: treated bare item "config-xml-json-marshalling" as id before parsing.')
    expectIntervention(i, { code: 'parser_sequence_item_primary_key', stage: 'parse', category: 'parser_fix' })
    expect(i.rule).toEqual({ id: 'parser_sequence_item_primary_key', label: 'YAML List Item Key Repair' })
    expect(i.exactCorrection).toBe('Moved the existing bare list item "config-xml-json-marshalling" into id under beads at line 12.')
    expect(i.examples?.[0]).toEqual({
      scope: 'beads line 12',
      before: '- config-xml-json-marshalling',
      after: '- id: config-xml-json-marshalling',
    })
  })

  it('maps wrapper text recovery', () => {
    const i = deriveOne('Recovered the structured artifact from surrounding wrapper text before validation.')
    expectIntervention(i, { code: 'parser_transcript_recovery', stage: 'parse', category: 'parser_fix' })
  })

  it('maps transcript recovery', () => {
    const i = deriveOne('Recovered the structured artifact from surrounding transcript or wrapper text before validation.')
    expectIntervention(i, { code: 'parser_transcript_recovery', stage: 'parse', category: 'parser_fix' })
  })

  it('maps malformed yaml recovery', () => {
    const i = deriveOne('Truncated incomplete last file entry to recover from malformed YAML.')
    expectIntervention(i, { code: 'parser_malformed_yaml', stage: 'parse', category: 'parser_fix' })
  })

  it('maps generic malformed yaml', () => {
    const i = deriveOne('Attempted to recover from malformed yaml in output.')
    expectIntervention(i, { code: 'parser_malformed_yaml', stage: 'parse', category: 'parser_fix' })
  })
})

// ── Cleanup category ────────────────────────────────────────────────

describe('cleanup interventions', () => {
  it('maps collapsed duplicate refinement', () => {
    const i = deriveOne('Collapsed duplicate PRD refinement modified change at index 3 because EPIC-2 was already covered by an identical modified change.')
    expectIntervention(i, { code: 'cleanup_collapsed_duplicate', stage: 'semantic_validation', category: 'cleanup' })
  })

  it('maps renumbered duplicate ids', () => {
    const i = deriveOne('Renumbered duplicate bead id "B-003" to "B-004".')
    expectIntervention(i, { code: 'cleanup_duplicate_ids', stage: 'normalize', category: 'cleanup' })
  })

  it('maps duplicate question ids', () => {
    const i = deriveOne('Renumbered duplicate question id Q3 at index 5 to Q6.')
    expectIntervention(i, { code: 'cleanup_duplicate_ids', stage: 'normalize', category: 'cleanup' })
  })

  it('maps duplicate option ids', () => {
    const i = deriveOne('Q2: removed duplicate option ids opt-a, opt-b and kept the first occurrence.')
    expectIntervention(i, { code: 'cleanup_duplicate_ids', stage: 'normalize', category: 'cleanup' })
  })

  it('maps duplicate epic ids', () => {
    const i = deriveOne('Renumbered duplicate epic id EPIC-1 to EPIC-3.')
    expectIntervention(i, { code: 'cleanup_duplicate_ids', stage: 'normalize', category: 'cleanup' })
  })

  it('maps filled missing field', () => {
    const i = deriveOne('Epic at index 2 was missing id. Filled with EPIC-3.')
    expectIntervention(i, { code: 'cleanup_filled_missing', stage: 'normalize', category: 'cleanup' })
  })

  it('maps filled missing ticket_id', () => {
    const i = deriveOne('Filled missing ticket_id from runtime context.')
    expectIntervention(i, { code: 'cleanup_filled_missing', stage: 'normalize', category: 'cleanup' })
  })

  it('maps recomputed total_score', () => {
    const i = deriveOne('Recomputed total_score from dimension scores.')
    expectIntervention(i, { code: 'cleanup_recomputed_score', stage: 'normalize', category: 'cleanup' })
  })

  it('maps trimmed empty strings', () => {
    const i = deriveOne('Trimmed empty PRD coverage gap strings before persisting the normalized result.')
    expectIntervention(i, { code: 'cleanup_trimmed_empty', stage: 'normalize', category: 'cleanup' })
  })

  it('maps phase reordering', () => {
    const i = deriveOne('Applied stable interview phase reordering (foundation -> structure -> assembly).')
    expectIntervention(i, { code: 'cleanup_reordering', stage: 'normalize', category: 'cleanup' })
  })

  it('maps question order canonicalization', () => {
    const i = deriveOne('Canonicalized question order to match the approved Interview Results artifact.')
    expectIntervention(i, { code: 'cleanup_reordering', stage: 'normalize', category: 'cleanup' })
  })

  it('maps resolved interview status', () => {
    const i = deriveOne('Canonicalized resolved interview status from "approved" to "draft".')
    expectIntervention(i, { code: 'cleanup_interview_status', stage: 'normalize', category: 'cleanup' })
  })

  it('maps normalized PRD status', () => {
    const i = deriveOne('Normalized unsupported PRD status "final" to draft.')
    expectIntervention(i, { code: 'cleanup_status_normalized', stage: 'normalize', category: 'cleanup' })
  })

  it('maps status to draft', () => {
    const i = deriveOne('Changed status to draft for the generated artifact.')
    expectIntervention(i, { code: 'cleanup_status_normalized', stage: 'normalize', category: 'cleanup' })
  })

  it('maps approval fields clearing', () => {
    const i = deriveOne('Cleared approval fields for the AI-generated Full Answers artifact.')
    expectIntervention(i, { code: 'cleanup_approval_fields', stage: 'normalize', category: 'cleanup' })
  })

  it('maps generated_by.winner_model correction', () => {
    const i = deriveOne('Canonicalized generated_by.winner_model from "gpt-4" to "claude-sonnet".')
    expectIntervention(i, { code: 'cleanup_winner_model', stage: 'normalize', category: 'cleanup' })
  })

  it('maps ticket_id canonicalization', () => {
    const i = deriveOne('Canonicalized ticket_id from "old-id" to "new-id".')
    expectIntervention(i, { code: 'cleanup_ticket_id', stage: 'normalize', category: 'cleanup' })
  })

  it('maps content_sha256 canonicalization', () => {
    const i = deriveOne('Canonicalized source_interview.content_sha256 from the approved Interview Results artifact.')
    expectIntervention(i, { code: 'cleanup_content_hash', stage: 'normalize', category: 'cleanup' })
  })

  it('maps schema_version normalization', () => {
    const i = deriveOne('Normalized invalid schema_version to 1.')
    expectIntervention(i, { code: 'cleanup_schema_version', stage: 'normalize', category: 'cleanup' })
  })

  it('maps mapped free_text', () => {
    const i = deriveOne('Mapped free_text to canonical option ids for AI-filled question Q4.')
    expectIntervention(i, { code: 'cleanup_mapped_free_text', stage: 'normalize', category: 'cleanup' })
  })

  it('maps selected option id repair warnings', () => {
    const i = deriveOne('Mapped selected option ids to canonical option ids for AI-filled question Q4.')
    expectIntervention(i, { code: 'cleanup_mapped_free_text', stage: 'normalize', category: 'cleanup' })
  })

  it('maps restored answered question', () => {
    const i = deriveOne('Restored answered canonical question Q2 from the approved Interview Results artifact.')
    expectIntervention(i, { code: 'cleanup_restored_answered', stage: 'normalize', category: 'cleanup' })
  })

  it('maps answered_by ai_skip', () => {
    const i = deriveOne('Canonicalized answered_by to ai_skip for AI-filled question Q5.')
    expectIntervention(i, { code: 'cleanup_answered_by', stage: 'normalize', category: 'cleanup' })
  })

  it('maps accepted empty final free-form answers', () => {
    const i = deriveOne('Accepted empty final_free_form answer as an explicit no-additions response for AI-filled question QFF1.')
    expectIntervention(i, { code: 'cleanup_final_free_form_empty', stage: 'normalize', category: 'cleanup' })
    expect(i.target).toBe('QFF1')
  })

  it('maps follow_up_rounds', () => {
    const i = deriveOne('Canonicalized follow_up_rounds to match the approved Interview Results artifact.')
    expectIntervention(i, { code: 'cleanup_follow_up_rounds', stage: 'normalize', category: 'cleanup' })
  })

  it('maps summary canonicalization', () => {
    const i = deriveOne('Canonicalized summary to match the approved Interview Results artifact.')
    expectIntervention(i, { code: 'cleanup_summary_match', stage: 'normalize', category: 'cleanup' })
  })

  it('maps no prd references', () => {
    const i = deriveOne('Bead "B-005" has no PRD references (prdRefs is empty).')
    expectIntervention(i, { code: 'cleanup_no_prd_refs', stage: 'semantic_validation', category: 'cleanup' })
  })

  it('maps context guidance canonicalization', () => {
    const i = deriveOne('Canonicalized string context guidance at index 2 into patterns/anti_patterns object.')
    expectIntervention(i, { code: 'cleanup_context_guidance', stage: 'normalize', category: 'cleanup' })
  })

  it('maps inline context guidance canonicalization', () => {
    const i = deriveOne('Canonicalized inline string context guidance at index 1 into patterns/anti_patterns object.')
    expectIntervention(i, { code: 'cleanup_context_guidance', stage: 'normalize', category: 'cleanup' })
  })

  it('maps affected_items label canonicalization', () => {
    const i = deriveOne('Canonicalized affected_items label for epic EPIC-1 from "Wrong Label" to "Correct Label".')
    expectIntervention(i, { code: 'cleanup_affected_label', stage: 'normalize', category: 'cleanup' })
  })

  it('maps preserved narrative fields restoration', () => {
    const i = deriveOne('Restored preserved Part 1 narrative fields from the refined blueprint for expanded bead at index 2 (B-003) after punctuation/whitespace-only drift in: description, acceptance_criteria.')
    expectIntervention(i, { code: 'cleanup_preserved_narrative', stage: 'normalize', category: 'cleanup' })
  })

  it('maps preserved narrative fields restoration after substantive drift', () => {
    const i = deriveOne('Restored preserved Part 1 narrative fields from the refined blueprint for expanded bead at index 2 (B-003) after substantive drift in: description, acceptanceCriteria.')
    expectIntervention(i, { code: 'cleanup_preserved_narrative_substantive', stage: 'normalize', category: 'cleanup' })
  })

  it('maps preserved testCommands restoration', () => {
    const i = deriveOne('Restored preserved Part 1 testCommands from the refined blueprint for expanded bead at index 2 (B-003) after drift in: testCommands[1].')
    expectIntervention(i, { code: 'cleanup_preserved_test_commands', stage: 'normalize', category: 'cleanup' })
  })

  it('maps converted change type', () => {
    const i = deriveOne('Converted interview refinement change at index 3 from "added" to "replaced" because Q5 already existed in the winning draft with different content.')
    expectIntervention(i, { code: 'cleanup_change_type_correction', stage: 'semantic_validation', category: 'cleanup' })
  })

  it('maps updated refined question from change', () => {
    const i = deriveOne('Updated the refined interview questions from modified change at index 1 for Q3 because the top-level questions list still contained the pre-change record.')
    expectIntervention(i, { code: 'cleanup_change_type_correction', stage: 'semantic_validation', category: 'cleanup' })
  })

  it('maps removed stale refined question', () => {
    const i = deriveOne('Removed stale top-level refined interview question Q2 using removed change at index 4.')
    expectIntervention(i, { code: 'cleanup_change_type_correction', stage: 'semantic_validation', category: 'cleanup' })
  })

  it('maps generic canonicalized metadata', () => {
    const i = deriveOne('Canonicalized metadata for canonical question Q1.')
    expectIntervention(i, { code: 'cleanup_canonicalization', stage: 'normalize', category: 'cleanup' })
  })

  it('falls through to generic cleanup for unrecognized warnings', () => {
    const i = deriveOne('Some completely unknown adjustment was made.')
    expectIntervention(i, { code: 'cleanup_generic', stage: 'normalize', category: 'cleanup' })
  })
})

// ── Target extraction ───────────────────────────────────────────────

describe('target extraction', () => {
  it('extracts Q-style targets', () => {
    const i = deriveOne('Renumbered duplicate question id Q3 at index 5 to Q6.')
    expect(i.target).toBe('Q3')
  })

  it('extracts FU-style targets', () => {
    const i = deriveOne('Inferred missing interview refinement change.after at index 1 from refined final question FU2 by matching id and phase.')
    expect(i.target).toBe('FU2')
  })

  it('extracts EPIC-style targets', () => {
    const i = deriveOne('Renumbered duplicate epic id EPIC-1 to EPIC-3.')
    expect(i.target).toBe('EPIC-1')
  })

  it('extracts US-style targets', () => {
    const i = deriveOne('User story at epic 1, index 2 was missing id. Filled with US-1-3.')
    expect(i.target).toBe('US-1-3')
  })

  it('extracts Draft-style targets', () => {
    const i = deriveOne('Draft 2 had a formatting issue.')
    expect(i.target).toBe('Draft 2')
  })

  it('returns undefined when no target found', () => {
    const i = deriveOne('Some generic warning with no target.')
    expect(i.target).toBeUndefined()
  })
})

// ── technicalDetail ─────────────────────────────────────────────────

describe('technicalDetail', () => {
  it('preserves the raw warning string as technicalDetail', () => {
    const raw = 'Renumbered duplicate bead id "B-003" to "B-004".'
    const i = deriveOne(raw)
    expect(i.technicalDetail).toBe(raw)
  })

  it('keeps raw audit messages on derived interventions', () => {
    const raw = 'Removed surrounding markdown code fence before parsing the final test commands.'
    const i = deriveOne(raw)
    expect(i.rawMessages).toEqual([raw])
  })
})

// ── exact details ──────────────────────────────────────────────────

describe('exact correction details', () => {
  it('derives rule and exact correction details for wrapper-key repairs', () => {
    const i = deriveOne('Removed wrapper key "command_plan" from top level.')

    expect(i.rule).toEqual({
      id: 'parser_wrapper_key',
      label: 'Wrapper Key',
    })
    expect(i.exactCorrection).toBe('Removed the unexpected top-level wrapper key "command_plan" and kept its nested payload.')
  })

  it('derives before/after examples for canonicalized from/to repairs', () => {
    const i = deriveOne('Canonicalized generated_by.winner_model from "gpt-4" to "claude-sonnet".')

    expect(i.exactCorrection).toBe('Changed generated_by.winner_model from "gpt-4" to "claude-sonnet".')
    expect(i.examples).toEqual([
      {
        scope: 'generated_by.winner_model',
        before: 'gpt-4',
        after: 'claude-sonnet',
      },
    ])
  })

  it('derives missing-value examples for inferred field repairs', () => {
    const i = deriveOne('Inferred missing PRD refinement item_type at index 0 as epic.')

    expect(i.exactCorrection).toBe('Filled the missing PRD refinement item_type with "epic" using the validated surrounding context.')
    expect(i.examples).toEqual([
      {
        scope: 'PRD refinement item_type',
        before: '[missing]',
        after: 'epic',
      },
    ])
  })

  it('derives explicit extracted details for dropped, attribution, and cleanup actions', () => {
    const droppedInvalid = deriveOne('Skipped non-object refinement change at index 2.')
    expect(droppedInvalid.exactCorrection).toBe('Removed the invalid refinement change entry at index 2.')

    const attributionOut = deriveOne('Cleared out-of-range PRD refinement inspiration at index 4 because alternative draft 10 does not exist.')
    expect(attributionOut.exactCorrection).toBe('Cleared the out-of-range inspiration reference at index 4 pointing to non-existent draft 10.')

    const cleanupStatus = deriveOne('Resolved interview status to the expected value.')
    expect(cleanupStatus.exactCorrection).toBe('Resolved the interview status field to the expected workflow value.')

    const mappedOption = deriveOne('Mapped free_text to canonical option ids for AI-filled question Q02.')
    expect(mappedOption.exactCorrection).toBe('Mapped the answer content to canonical option IDs for question Q02.')

    const answeredBy = deriveOne('Canonicalized answered_by to ai_skip for AI-filled question FU1.')
    expect(answeredBy.exactCorrection).toBe('Set answered_by to "ai_skip" for question FU1.')

    const emptyFinal = deriveOne('Accepted empty final_free_form answer as an explicit no-additions response for AI-filled question QFF1.')
    expect(emptyFinal.exactCorrection).toBe('Accepted the empty final free-form answer for question QFF1 as an explicit no-additions response.')
    
    const noPrdRefs = deriveOne('Bead "bead-abc" has no PRD references (prdRefs is empty).')
    expect(noPrdRefs.exactCorrection).toBe('Flagged bead "bead-abc" for having no PRD references.')
  })
})

// ── deriveStructuredInterventions ───────────────────────────────────

describe('deriveStructuredInterventions', () => {
  it('returns empty for no warnings', () => {
    expect(deriveStructuredInterventions({})).toEqual([])
  })

  it('filters out empty/whitespace warnings', () => {
    const result = deriveStructuredInterventions({ repairWarnings: ['', '  ', 'Removed terminal noise.'] })
    expect(result).toHaveLength(1)
    expect(result[0]!.code).toBe('parser_terminal_noise')
  })

  it('appends retry intervention when autoRetryCount > 0', () => {
    const result = deriveStructuredInterventions({ autoRetryCount: 2 })
    expect(result).toHaveLength(1)
    expect(result[0]!.code).toBe('retry_after_validation_failure')
    expect(result[0]!.category).toBe('retry')
    expect(result[0]!.stage).toBe('retry')
    expect(result[0]!.summary).toContain('2')
    expect(result[0]!.how).toBe('LoopTroop preserved each rejected model response in Raw attempts, retried the structured output request, and recorded the final accepted or rejected artifact state.')
    expect(result[0]!.rule).toEqual({ id: 'retry_after_validation_failure', label: 'Validation Retry' })
  })

  it('appends validation failure when validationError is provided', () => {
    const result = deriveStructuredInterventions({ validationError: 'Missing required field: id' })
    expect(result).toHaveLength(1)
    expect(result[0]!.code).toBe('validation_failure_recorded')
    expect(result[0]!.technicalDetail).toBe('Missing required field: id')
  })

  it('combines warnings and retry', () => {
    const result = deriveStructuredInterventions({
      repairWarnings: ['Removed terminal noise.'],
      autoRetryCount: 1,
      validationError: 'Schema mismatch',
    })
    expect(result).toHaveLength(2)
    expect(result[0]!.code).toBe('parser_terminal_noise')
    expect(result[1]!.code).toBe('retry_after_validation_failure')
  })
})

// ── normalizeStructuredInterventions ────────────────────────────────

describe('normalizeStructuredInterventions', () => {
  it('returns empty for non-array input', () => {
    expect(normalizeStructuredInterventions(null)).toEqual([])
    expect(normalizeStructuredInterventions(undefined)).toEqual([])
    expect(normalizeStructuredInterventions('string')).toEqual([])
  })

  it('filters out invalid entries', () => {
    const result = normalizeStructuredInterventions([
      null,
      { code: 'x', stage: 'parse', category: 'parser_fix', title: 'T', summary: 'S', why: 'W', how: 'H' },
      { code: 'missing_fields' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.code).toBe('x')
  })

  it('rejects invalid stage or category', () => {
    const result = normalizeStructuredInterventions([
      { code: 'x', stage: 'invalid_stage', category: 'parser_fix', title: 'T', summary: 'S', why: 'W', how: 'H' },
    ])
    expect(result).toEqual([])
  })
})

// ── mergeStructuredInterventions ────────────────────────────────────

describe('mergeStructuredInterventions', () => {
  const a: StructuredIntervention = {
    code: 'a', stage: 'parse', category: 'parser_fix', title: 'A', summary: 'SA', why: 'WA', how: 'HA',
  }
  const b: StructuredIntervention = {
    code: 'b', stage: 'normalize', category: 'cleanup', title: 'B', summary: 'SB', why: 'WB', how: 'HB',
  }

  it('merges multiple lists', () => {
    expect(mergeStructuredInterventions([a], [b])).toEqual([a, b])
  })

  it('handles null and undefined lists', () => {
    expect(mergeStructuredInterventions(null, [a], undefined, [b])).toEqual([a, b])
  })

  it('returns empty for no input', () => {
    expect(mergeStructuredInterventions()).toEqual([])
  })
})
