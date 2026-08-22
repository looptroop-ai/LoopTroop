import { normalizeString } from '@shared/typeGuards'

export type StructuredInterventionStage = 'parse' | 'normalize' | 'semantic_validation' | 'retry'
export type StructuredInterventionCategory = 'parser_fix' | 'cleanup' | 'synthesized' | 'dropped' | 'attribution' | 'retry'

export interface StructuredInterventionRule {
  id: string
  label: string
}

export interface StructuredInterventionExample {
  scope?: string
  before?: string
  after?: string
  note?: string
}

export interface StructuredIntervention {
  code: string
  stage: StructuredInterventionStage
  category: StructuredInterventionCategory
  title: string
  summary: string
  why: string
  how: string
  rule?: StructuredInterventionRule
  exactCorrection?: string
  examples?: StructuredInterventionExample[]
  technicalDetail?: string
  rawMessages?: string[]
  target?: string
}

export const STRUCTURED_INTERVENTION_CATEGORY_ORDER: StructuredInterventionCategory[] = [
  'parser_fix',
  'cleanup',
  'synthesized',
  'dropped',
  'attribution',
  'retry',
]

const STAGES = new Set<StructuredInterventionStage>(['parse', 'normalize', 'semantic_validation', 'retry'])
const CATEGORIES = new Set<StructuredInterventionCategory>(STRUCTURED_INTERVENTION_CATEGORY_ORDER)

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const normalized = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  const unique: string[] = []
  const seen = new Set<string>()

  for (const entry of normalized) {
    const trimmed = entry.trim()
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    unique.push(trimmed)
  }

  return unique
}

function normalizeExample(value: unknown): StructuredInterventionExample | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const scope = normalizeString(record.scope)
  const before = normalizeString(record.before)
  const after = normalizeString(record.after)
  const note = normalizeString(record.note)
  if (!scope && !before && !after && !note) return null

  return {
    ...(scope ? { scope } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(note ? { note } : {}),
  }
}

function normalizeExamples(value: unknown): StructuredInterventionExample[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const normalized = normalizeExample(entry)
    return normalized ? [normalized] : []
  })
}

function normalizeRule(value: unknown): StructuredInterventionRule | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const record = value as Record<string, unknown>
  const id = normalizeString(record.id)
  const label = normalizeString(record.label)
  if (!id || !label) return undefined

  return { id, label }
}

function formatRuleLabelToken(token: string): string {
  const normalized = token.trim().toLowerCase()
  if (!normalized) return ''

  const acronyms: Record<string, string> = {
    ai: 'AI',
    id: 'ID',
    ids: 'IDs',
    json: 'JSON',
    jsonl: 'JSONL',
    prd: 'PRD',
    xml: 'XML',
    yaml: 'YAML',
  }
  if (acronyms[normalized]) return acronyms[normalized]
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function buildDefaultRule(code: string): StructuredInterventionRule {
  const overrides: Record<string, string> = {
    parser_closing_fence: 'Closing Fence Trim',
    parser_double_quoted_scalar_escape: 'YAML Escape Repair',
    parser_free_text_scalar: 'Free-Text Scalar Repair',
    parser_indentation: 'YAML Indentation Repair',
    parser_inline_yaml: 'Inline YAML Normalize',
    parser_list_dash: 'YAML List Dash Repair',
    parser_mapping_key_colon_space: 'YAML Mapping Separator',
    parser_malformed_yaml: 'Malformed YAML Recovery',
    parser_markdown_fence: 'Markdown Fence Unwrap',
    parser_quoted_scalar: 'Quoted Scalar Repair',
    parser_reserved_indicator_scalar: 'Reserved Scalar Repair',
    parser_sequence_item_primary_key: 'YAML List Item Key Repair',
    parser_terminal_noise: 'Terminal Noise Trim',
    parser_transcript_recovery: 'Transcript Recovery',
    parser_unbalanced_quote: 'Quote Balance Repair',
    parser_wrapper_key: 'Wrapper Key',
    parser_xml_tags: 'XML Tag Strip',
    cleanup_duplicate_ids: 'Duplicate ID Repair',
    cleanup_refinement_id_stability: 'Refinement ID Stability Repair',
    cleanup_final_free_form_empty: 'Final Free-Form Empty Answer',
    cleanup_filled_missing: 'Missing Field Fill',
    cleanup_preserved_narrative_substantive: 'Preserved Narrative Restore',
    cleanup_status_normalized: 'Status Normalize',
    cleanup_ticket_id: 'Ticket ID',
    cleanup_winner_model: 'Winner Model',
    retry_after_validation_failure: 'Validation Retry',
    validation_failure_recorded: 'Validation Failure Record',
    synthesized_inferred_detail: 'Missing Field Inference',
  }
  if (overrides[code]) {
    return {
      id: code,
      label: overrides[code],
    }
  }

  const suffix = code.replace(/^(parser|cleanup|synthesized|dropped|attribution|retry)_/, '')
  const label = suffix
    .split('_')
    .map((token) => formatRuleLabelToken(token))
    .join(' ')
    .trim() || 'Intervention'

  return {
    id: code,
    label,
  }
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function formatQuotedValue(value: string): string {
  return `"${stripOuterQuotes(value)}"`
}

function buildBeforeAfterExample(
  scope: string | undefined,
  before: string | undefined,
  after: string | undefined,
  note?: string,
): StructuredInterventionExample | undefined {
  const normalizedScope = normalizeString(scope)
  const normalizedBefore = normalizeString(before)
  const normalizedAfter = normalizeString(after)
  const normalizedNote = normalizeString(note)

  if (!normalizedScope && !normalizedBefore && !normalizedAfter && !normalizedNote) return undefined

  return {
    ...(normalizedScope ? { scope: normalizedScope } : {}),
    ...(normalizedBefore ? { before: stripOuterQuotes(normalizedBefore) } : {}),
    ...(normalizedAfter ? { after: stripOuterQuotes(normalizedAfter) } : {}),
    ...(normalizedNote ? { note: normalizedNote } : {}),
  }
}

function extractWrapperSubject(warning: string): string | undefined {
  const chainMatch = warning.match(/^Removed wrapper key chain "(.+)" from top level\.$/i)
  if (chainMatch?.[1]) return chainMatch[1]

  const keyMatch = warning.match(/^Removed wrapper key "(.+)" from top level\.$/i)
  if (keyMatch?.[1]) return keyMatch[1]

  return undefined
}

function buildExactInterventionDetails(
  code: string,
  technicalDetail?: string,
): {
  exactCorrection?: string
  examples?: StructuredInterventionExample[]
} {
  if (!technicalDetail) return {}

  const warning = technicalDetail.trim()
  if (!warning) return {}

  const fromToMatch = warning.match(/^(?:Canonicalized|Normalized)\s+(.+?)\s+from\s+(.+?)\s+to\s+(.+?)\.$/i)
  if (fromToMatch) {
    const subject = normalizeString(fromToMatch[1])
    const before = fromToMatch[2]!
    const after = fromToMatch[3]!
    const example = buildBeforeAfterExample(subject, before, after)
    return {
      exactCorrection: subject
        ? `Changed ${subject} from ${formatQuotedValue(before)} to ${formatQuotedValue(after)}.`
        : `Changed ${formatQuotedValue(before)} to ${formatQuotedValue(after)}.`,
      ...(example ? { examples: [example] } : {}),
    }
  }

  if (code === 'parser_sequence_item_primary_key') {
    const repairMatch = warning.match(/^Repaired YAML sequence entry under "(.+)" at line (\d+): treated bare item "(.+)" as ([A-Za-z_][\w_-]*) before parsing\.$/i)
    if (repairMatch) {
      const parentKey = repairMatch[1]!
      const line = repairMatch[2]!
      const value = repairMatch[3]!
      const primaryKey = repairMatch[4]!
      const example = buildBeforeAfterExample(
        `${parentKey} line ${line}`,
        `- ${value}`,
        `- ${primaryKey}: ${value}`,
      )
      return {
        exactCorrection: `Moved the existing bare list item ${formatQuotedValue(value)} into ${primaryKey} under ${parentKey} at line ${line}.`,
        ...(example ? { examples: [example] } : {}),
      }
    }
  }

  if (code === 'cleanup_status_normalized') {
    const statusMatch = warning.match(/^Normalized unsupported PRD status\s+(.+?)\s+to\s+(.+?)\.$/i)
    if (statusMatch) {
      const example = buildBeforeAfterExample('PRD status', statusMatch[1], statusMatch[2])
      return {
        exactCorrection: `Changed the PRD status from ${formatQuotedValue(statusMatch[1]!)} to ${formatQuotedValue(statusMatch[2]!)}.`,
        ...(example ? { examples: [example] } : {}),
      }
    }
  }

  if (code === 'cleanup_duplicate_ids') {
    const renumberMatch = warning.match(/^Renumbered duplicate (.+?) id\s+("?[^"]+"?|[^\s.]+)(?: at index \d+)?\s+to\s+("?[^"]+"?|.+?)\.$/i)
    if (renumberMatch) {
      const subject = `${renumberMatch[1]} ID`
      const before = renumberMatch[2]!
      const after = renumberMatch[3]!
      const example = buildBeforeAfterExample(subject, before, after)
      return {
        exactCorrection: `Renumbered the duplicate ${subject.toLowerCase()} from ${formatQuotedValue(before)} to ${formatQuotedValue(after)}.`,
        ...(example ? { examples: [example] } : {}),
      }
    }

    const duplicateOptionsMatch = warning.match(/^([^:]+): removed duplicate option ids (.+?) and kept the first occurrence\.$/i)
    if (duplicateOptionsMatch) {
      return {
        exactCorrection: `Removed duplicate option IDs for ${duplicateOptionsMatch[1]!.trim()} and kept the first occurrence of each ID.`,
      }
    }
  }

  if (code === 'cleanup_refinement_id_stability') {
    const stabilityMatch = warning.match(
      /^Restored (PRD|beads) refinement ID stability at change index (\d+): reassigned surviving (epic|user_story|bead) "(.+)" from (\S+) to (\S+) and reassigned newly added \3 "(.+)" from (\S+) to (\S+)\.$/i,
    )
    if (stabilityMatch) {
      const artifact = stabilityMatch[1]!
      const changeIndex = stabilityMatch[2]!
      const itemType = stabilityMatch[3]!
      const survivingLabel = stabilityMatch[4]!
      const survivingBefore = stabilityMatch[5]!
      const survivingAfter = stabilityMatch[6]!
      const addedLabel = stabilityMatch[7]!
      const addedBefore = stabilityMatch[8]!
      const addedAfter = stabilityMatch[9]!

      return {
        exactCorrection: `At ${artifact} refinement change index ${changeIndex}, restored the surviving ${itemType} "${survivingLabel}" from ${formatQuotedValue(survivingBefore)} to ${formatQuotedValue(survivingAfter)} and reassigned the newly added ${itemType} "${addedLabel}" from ${formatQuotedValue(addedBefore)} to ${formatQuotedValue(addedAfter)}.`,
        examples: [
          {
            scope: `Surviving ${itemType}: ${survivingLabel}`,
            before: stripOuterQuotes(survivingBefore),
            after: stripOuterQuotes(survivingAfter),
            note: 'Restored the identifier from the winning artifact.',
          },
          {
            scope: `Newly added ${itemType}: ${addedLabel}`,
            before: stripOuterQuotes(addedBefore),
            after: stripOuterQuotes(addedAfter),
            note: 'Assigned the unused identifier freed by restoring the surviving item.',
          },
        ],
      }
    }
  }

  if (code === 'cleanup_filled_missing') {
    const filledMatch = warning.match(/^(.*?) was missing (.+?)\. Filled with (.+)\.$/i)
    if (filledMatch) {
      const scope = normalizeString(filledMatch[1])
      const field = stripOuterQuotes(filledMatch[2]!)
      const value = filledMatch[3]!
      const example = buildBeforeAfterExample(scope ?? field, '[missing]', value, scope ? `Filled ${field}.` : undefined)
      return {
        exactCorrection: `Filled the missing ${field} with ${formatQuotedValue(value)}.`,
        ...(example ? { examples: [example] } : {}),
      }
    }

    const runtimeFillMatch = warning.match(/^Filled missing (.+?) from runtime context\.$/i)
    if (runtimeFillMatch) {
      return {
        exactCorrection: `Filled the missing ${stripOuterQuotes(runtimeFillMatch[1]!)} from the runtime context.`,
      }
    }
  }

  if (code === 'synthesized_inferred_detail') {
    const inferredMatch = warning.match(/^Inferred missing (.+?)(?: at index \d+)? as (.+)\.$/i)
    if (inferredMatch) {
      const field = inferredMatch[1]
      const value = inferredMatch[2]!
      const example = buildBeforeAfterExample(field, '[missing]', value)
      return {
        exactCorrection: `Filled the missing ${field} with ${formatQuotedValue(value)} using the validated surrounding context.`,
        ...(example ? { examples: [example] } : {}),
      }
    }
  }

  if (code === 'synthesized_omitted_refinement') {
    const synthMatch = warning.match(/Synthesized omitted (.+?) refinement/i)
    if (synthMatch) {
      return { exactCorrection: `Synthesized an omitted ${synthMatch[1]} refinement change.` }
    }
    return { exactCorrection: 'Synthesized an omitted refinement change.' }
  }

  if (code === 'synthesized_missing_detail') {
    return { exactCorrection: 'Synthesized missing machine-readable detail from validated records.' }
  }

  if (code === 'dropped_no_op_change') {
    const droppedMatch = warning.match(/^Dropped no-op .* refinement (.+?)(?: change)? at index (\d+)/i)
    if (droppedMatch) {
      return {
        exactCorrection: `Removed the no-op ${droppedMatch[1]} change entry at index ${droppedMatch[2]} from the saved diff.`,
      }
    }
    return { exactCorrection: 'Removed a no-op change entry from the saved diff.' }
  }

  if (code === 'dropped_invalid_change') {
    const skippedMatch = warning.match(/^Skipped .*refinement change.* at index (\d+)/i)
    if (skippedMatch) {
      return { exactCorrection: `Removed the invalid refinement change entry at index ${skippedMatch[1]}.` }
    }
    return { exactCorrection: 'Removed an invalid refinement change entry.' }
  }

  if (code === 'dropped_unsupported_or_partial_data') {
    return { exactCorrection: 'Removed unsupported or partial data that conflicted with the expected artifact contract.' }
  }

  if (code === 'attribution_out_of_range') {
    const outOfRangeMatch = warning.match(/index (\d+).*draft (\d+)/i)
    if (outOfRangeMatch) {
      return { exactCorrection: `Cleared the out-of-range inspiration reference at index ${outOfRangeMatch[1]} pointing to non-existent draft ${outOfRangeMatch[2]}.` }
    }
    return { exactCorrection: 'Cleared an out-of-range inspiration reference.' }
  }

  if (code === 'attribution_repaired') {
    return { exactCorrection: 'Repaired change attribution fields to align with validated artifacts.' }
  }

  if (code === 'parser_wrapper_key') {
    const wrapperSubject = extractWrapperSubject(warning)
    return {
      exactCorrection: wrapperSubject
        ? `Removed the unexpected top-level wrapper ${wrapperSubject.includes('->') ? 'key chain' : 'key'} ${formatQuotedValue(wrapperSubject)} and kept its nested payload.`
        : 'Removed an unexpected top-level wrapper key and kept its nested payload.',
    }
  }

  if (code === 'parser_markdown_fence') {
    return {
      exactCorrection: 'Removed the outer Markdown code fence wrapper so only the structured payload remained.',
    }
  }

  if (code === 'parser_closing_fence') {
    return {
      exactCorrection: 'Removed the stray trailing closing code fence after the structured payload.',
    }
  }

  if (code === 'parser_xml_tags') {
    const tagsMatch = warning.match(/^Stripped XML-style tags?\s+(.+?)\s+from the payload before parsing\.$/i)
    if (tagsMatch) {
      return {
        exactCorrection: `Removed the XML-style wrapper tags ${tagsMatch[1]} around the payload before reparsing.`,
      }
    }

    return {
      exactCorrection: 'Removed XML-style wrapper tags around the payload before reparsing.',
    }
  }

  if (code === 'parser_terminal_noise') {
    return {
      exactCorrection: 'Trimmed the trailing terminal control noise after the structured payload.',
    }
  }

  if (code === 'parser_transcript_recovery') {
    return {
      exactCorrection: 'Extracted just the structured artifact and ignored the surrounding transcript or wrapper text.',
    }
  }

  if (code === 'parser_indentation') {
    const lineMatch = warning.match(/line\s+(\d+)/i)
    return {
      exactCorrection: lineMatch
        ? `Repaired YAML indentation at line ${lineMatch[1]} so the structure parsed correctly.`
        : 'Repaired the YAML indentation so the structure parsed correctly.',
    }
  }

  if (code === 'parser_list_dash') {
    const lineMatch = warning.match(/line\s+(\d+)/i)
    return {
      exactCorrection: lineMatch
        ? `Fixed the malformed YAML list dash at line ${lineMatch[1]}.`
        : 'Fixed a malformed YAML list-item dash.',
    }
  }

  if (code === 'parser_mapping_key_colon_space') {
    const example = buildBeforeAfterExample(
      'YAML mapping entry',
      'key:value',
      'key: value',
      'Only a missing separator was corrected; scalar list values containing colons were preserved.',
    )
    return {
      exactCorrection: 'Inserted the missing space after a YAML mapping key colon without changing the key or value text.',
      ...(example ? { examples: [example] } : {}),
    }
  }

  if (code === 'parser_unbalanced_quote') {
    return {
      exactCorrection: 'Balanced the malformed YAML quote before reparsing the payload.',
    }
  }

  if (code === 'parser_quoted_scalar') {
    return {
      exactCorrection: 'Repaired the malformed quoted YAML scalar before reparsing the payload.',
    }
  }

  if (code === 'parser_reserved_indicator_scalar') {
    return {
      exactCorrection: 'Quoted the plain YAML scalar that began with a reserved indicator character before reparsing the payload.',
    }
  }

  if (code === 'parser_free_text_scalar') {
    return {
      exactCorrection: 'Converted existing free_text answer lines into valid YAML string syntax without inventing answer text.',
    }
  }

  if (code === 'parser_double_quoted_scalar_escape') {
    return {
      exactCorrection: 'Escaped invalid backslash sequences inside double-quoted YAML scalars before reparsing the payload.',
    }
  }

  if (code === 'parser_inline_yaml') {
    return {
      exactCorrection: 'Converted inline YAML flow syntax into standard block YAML before validation.',
    }
  }

  if (code === 'parser_malformed_yaml') {
    return {
      exactCorrection: 'Recovered the valid portion of the malformed YAML and discarded the unrecoverable fragment.',
    }
  }

  if (code === 'parser_repair') {
    return { exactCorrection: 'Cleaned a parser-level formatting issue to safely read the structured payload.' }
  }

  if (code === 'cleanup_schema_version') {
    const example = buildBeforeAfterExample('schema_version', '[invalid]', '1')
    return {
      exactCorrection: 'Set schema_version to "1".',
      ...(example ? { examples: [example] } : {}),
    }
  }

  if (code === 'cleanup_approval_fields') {
    return {
      exactCorrection: 'Cleared the pre-filled approval fields so the artifact remained unapproved.',
    }
  }

  if (code === 'cleanup_content_hash') {
    return {
      exactCorrection: 'Recomputed source_interview.content_sha256 from the authoritative approved source artifact.',
    }
  }

  if (code === 'cleanup_follow_up_rounds') {
    return {
      exactCorrection: 'Restored follow_up_rounds from the approved interview artifact.',
    }
  }

  if (code === 'cleanup_summary_match') {
    return {
      exactCorrection: 'Restored the summary from the approved interview artifact.',
    }
  }

  if (code === 'cleanup_restored_answered') {
    const questionMatch = warning.match(/canonical question (QFF\d+|Q\d+|FU\d+)/i)
    return { exactCorrection: questionMatch ? `Restored the approved answered record for question ${questionMatch[1]}.` : 'Restored the approved answered question record from the canonical interview artifact.' }
  }

  if (code === 'cleanup_answered_by') {
    const targetMatch = warning.match(/question\s+(QFF\d+|Q\d+|FU\d+)/i)
    const example = buildBeforeAfterExample(targetMatch?.[1], undefined, 'ai_skip')
    return {
      exactCorrection: targetMatch ? `Set answered_by to "ai_skip" for question ${targetMatch[1]}.` : 'Set answered_by to "ai_skip" for the AI-filled question.',
      ...(example ? { examples: [example] } : {}),
    }
  }

  if (code === 'cleanup_mapped_free_text') {
    const targetMatch = warning.match(/question\s+(QFF\d+|Q\d+|FU\d+)/i)
    return { exactCorrection: targetMatch ? `Mapped the answer content to canonical option IDs for question ${targetMatch[1]}.` : 'Mapped the generated answer content to the closest canonical option IDs.' }
  }

  if (code === 'cleanup_final_free_form_empty') {
    const targetMatch = warning.match(/question\s+(QFF\d+|Q\d+|FU\d+)/i)
    return {
      exactCorrection: targetMatch
        ? `Accepted the empty final free-form answer for question ${targetMatch[1]} as an explicit no-additions response.`
        : 'Accepted the empty final free-form answer as an explicit no-additions response.',
    }
  }

  if (code === 'cleanup_context_guidance') {
    return { exactCorrection: 'Converted inline context guidance text into the canonical patterns / anti_patterns object.' }
  }

  if (code === 'cleanup_change_type_correction') {
    return { exactCorrection: 'Reclassified or reapplied the refinement change so the declared change list matched the validated content.' }
  }

  if (code === 'cleanup_collapsed_duplicate') {
    return { exactCorrection: 'Collapsed the duplicate refinement change entry.' }
  }

  if (code === 'cleanup_recomputed_score') {
    return { exactCorrection: 'Recomputed the total score from individual dimension scores.' }
  }

  if (code === 'cleanup_trimmed_empty') {
    return { exactCorrection: 'Trimmed empty entries before saving.' }
  }

  if (code === 'cleanup_reordering') {
    return { exactCorrection: 'Re-sorted the items into their correct canonical sequence.' }
  }

  if (code === 'cleanup_interview_status') {
    return { exactCorrection: 'Resolved the interview status field to the expected workflow value.' }
  }

  if (code === 'cleanup_no_prd_refs') {
    const beadMatch = warning.match(/Bead "([^"]+)"/i)
    return { exactCorrection: beadMatch ? `Flagged bead "${beadMatch[1]}" for having no PRD references.` : 'Flagged a bead for having no PRD references.' }
  }

  if (code === 'cleanup_preserved_narrative_substantive') {
    return { exactCorrection: 'Replaced a substantive narrative rewrite with the canonical preserved field content.' }
  }

  if (code === 'cleanup_preserved_narrative') {
    return { exactCorrection: 'Restored the exact canonical preserved field content after detecting cosmetic drift.' }
  }

  if (code === 'cleanup_affected_label') {
    return { exactCorrection: 'Canonicalized the affected_items label to match the authoritative source.' }
  }

  if (code === 'cleanup_canonicalization') {
    return { exactCorrection: 'Normalized the saved artifact detail to the canonical validated value.' }
  }

  if (code === 'retry_after_validation_failure') {
    return {
      exactCorrection: 'Retried after validation failed and preserved the rejected response in Raw attempts.',
    }
  }

  if (code === 'validation_failure_recorded') {
    return {
      exactCorrection: 'Recorded the validation failure message alongside the saved result for debugging.',
    }
  }

  return {}
}

function buildFallbackExactCorrection(intervention: StructuredIntervention): string {
  const ruleLabel = intervention.rule?.label ?? buildDefaultRule(intervention.code).label

  if (intervention.category === 'parser_fix') {
    return `Applied ${ruleLabel} to make the generated structured payload parseable before validation.`
  }

  if (intervention.category === 'cleanup') {
    return `Applied ${ruleLabel} to normalize the generated artifact before saving it.`
  }

  if (intervention.category === 'synthesized') {
    return `Applied ${ruleLabel} to create missing structured detail from validated context.`
  }

  if (intervention.category === 'dropped') {
    return `Applied ${ruleLabel} to remove generated detail that could not be safely persisted.`
  }

  if (intervention.category === 'attribution') {
    return `Applied ${ruleLabel} to correct or clear invalid source attribution.`
  }

  return `Applied ${ruleLabel} and recorded the validation context.`
}

function enrichIntervention(intervention: StructuredIntervention): StructuredIntervention {
  const derivedDetails = buildExactInterventionDetails(intervention.code, intervention.technicalDetail)
  const normalizedExamples = intervention.examples && intervention.examples.length > 0
    ? intervention.examples
    : derivedDetails.examples
  const rule = intervention.rule ?? buildDefaultRule(intervention.code)
  const exactCorrection = intervention.exactCorrection
    ?? derivedDetails.exactCorrection
    ?? buildFallbackExactCorrection({ ...intervention, rule })
  const rawMessages = intervention.rawMessages && intervention.rawMessages.length > 0
    ? normalizeStringArray(intervention.rawMessages)
    : intervention.technicalDetail
      ? [intervention.technicalDetail]
      : []

  return {
    ...intervention,
    rule,
    exactCorrection,
    ...(normalizedExamples && normalizedExamples.length > 0 ? { examples: normalizedExamples } : {}),
    ...(rawMessages.length > 0 ? { rawMessages } : {}),
  }
}

function normalizeIntervention(value: unknown): StructuredIntervention | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const code = normalizeString(record.code)
  const stage = normalizeString(record.stage)
  const category = normalizeString(record.category)
  const title = normalizeString(record.title)
  const summary = normalizeString(record.summary)
  const why = normalizeString(record.why)
  const how = normalizeString(record.how)
  const rule = normalizeRule(record.rule)
  const exactCorrection = normalizeString(record.exactCorrection)
  const examples = normalizeExamples(record.examples)
  const technicalDetail = normalizeString(record.technicalDetail)
  const rawMessages = normalizeStringArray(record.rawMessages)
  const target = normalizeString(record.target)

  if (!code || !stage || !category || !title || !summary || !why || !how) {
    return null
  }
  if (!STAGES.has(stage as StructuredInterventionStage) || !CATEGORIES.has(category as StructuredInterventionCategory)) {
    return null
  }

  return enrichIntervention({
    code,
    stage: stage as StructuredInterventionStage,
    category: category as StructuredInterventionCategory,
    title,
    summary,
    why,
    how,
    ...(rule ? { rule } : {}),
    ...(exactCorrection ? { exactCorrection } : {}),
    ...(examples.length > 0 ? { examples } : {}),
    ...(technicalDetail ? { technicalDetail } : {}),
    ...(rawMessages.length > 0 ? { rawMessages } : {}),
    ...(target ? { target } : {}),
  })
}

export function normalizeStructuredInterventions(value: unknown): StructuredIntervention[] {
  if (!Array.isArray(value)) return []
  return dedupeStructuredInterventions(value.flatMap((entry) => {
    const normalized = normalizeIntervention(entry)
    return normalized ? [normalized] : []
  }))
}

export function mergeStructuredInterventions(
  ...lists: Array<StructuredIntervention[] | undefined | null>
): StructuredIntervention[] {
  return dedupeStructuredInterventions(lists.flatMap((list) => (Array.isArray(list) ? list : [])))
}

export function dedupeStructuredInterventions(interventions: StructuredIntervention[]): StructuredIntervention[] {
  const unique: StructuredIntervention[] = []
  const seen = new Set<string>()

  for (const intervention of interventions) {
    const fingerprint = JSON.stringify({
      code: intervention.code,
      stage: intervention.stage,
      category: intervention.category,
      title: intervention.title,
      summary: intervention.summary,
      why: intervention.why,
      how: intervention.how,
      rule: intervention.rule
        ? {
            id: intervention.rule.id,
            label: intervention.rule.label,
          }
        : null,
      exactCorrection: intervention.exactCorrection ?? null,
      examples: intervention.examples?.map((example) => ({
        scope: example.scope ?? null,
        before: example.before ?? null,
        after: example.after ?? null,
        note: example.note ?? null,
      })) ?? [],
      technicalDetail: intervention.technicalDetail ?? null,
      rawMessages: intervention.rawMessages ?? [],
      target: intervention.target ?? null,
    })
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    unique.push(intervention)
  }

  return unique
}

function extractTargetFromWarning(warning: string): string | undefined {
  const matches = [
    warning.match(/\b(QFF\d{1,3})\b/i),
    warning.match(/\b(Q\d{1,3})\b/),
    warning.match(/\b(FU\d{1,3})\b/),
    warning.match(/\b(EPIC-[A-Za-z0-9-]+)\b/i),
    warning.match(/\b(US-[A-Za-z0-9-]+)\b/i),
    warning.match(/\b(Draft \d+)\b/i),
  ]
  for (const match of matches) {
    if (match?.[1]) return match[1]
  }
  return undefined
}

function buildIntervention(
  warning: string,
  intervention: Omit<StructuredIntervention, 'technicalDetail' | 'target' | 'rule' | 'exactCorrection' | 'examples'>,
): StructuredIntervention {
  const target = extractTargetFromWarning(warning)
  return enrichIntervention({
    ...intervention,
    technicalDetail: warning,
    rawMessages: [warning],
    ...(target ? { target } : {}),
  })
}

function deriveInterventionFromWarning(warning: string): StructuredIntervention {
  const normalized = warning.trim().toLowerCase()

  // ── Dropped category ──────────────────────────────────────────────────

  if (/^dropped no-op .* refinement .* (?:identical|unchanged)/i.test(warning)) {
    return buildIntervention(warning, {
      code: 'dropped_no_op_change',
      stage: 'semantic_validation',
      category: 'dropped',
      title: 'Dropped a no-op change',
      summary: 'The AI reported a change that did not alter the validated artifact.',
      why: 'The winning and final records were identical, so keeping the change note would have been misleading.',
      how: 'LoopTroop removed the no-op change entry from the saved validated diff.',
    })
  }

  if (
    /^skipped non-object refinement change/i.test(warning)
    || /^skipped refinement change .* invalid type/i.test(warning)
    || /^skipped refinement change .* path\/summary metadata only/i.test(warning)
  ) {
    return buildIntervention(warning, {
      code: 'dropped_invalid_change',
      stage: 'semantic_validation',
      category: 'dropped',
      title: 'Dropped an invalid change entry',
      summary: 'A refinement change entry was malformed and could not be trusted.',
      why: 'The entry did not match the required machine-readable change schema.',
      how: 'LoopTroop ignored the invalid entry and kept only validated change records.',
    })
  }

  if (/ignored because|^dropped partial /i.test(warning)) {
    return buildIntervention(warning, {
      code: 'dropped_unsupported_or_partial_data',
      stage: 'semantic_validation',
      category: 'dropped',
      title: 'Dropped unsupported or partial data',
      summary: 'Some generated fields were unusable and were not carried into the validated artifact.',
      why: 'Those fields conflicted with the artifact contract or were too incomplete to preserve safely.',
      how: 'LoopTroop removed the unsupported detail and kept the rest of the validated output.',
    })
  }

  // ── Attribution category ──────────────────────────────────────────────

  if (/cleared out-of-range .* inspiration|inspiration .* out of bounds/i.test(warning)) {
    return buildIntervention(warning, {
      code: 'attribution_out_of_range',
      stage: 'semantic_validation',
      category: 'attribution',
      title: 'Cleared an out-of-range inspiration source',
      summary: 'An inspiration reference pointed to a draft that does not exist, so the reference was removed.',
      why: 'The model cited an alternative draft index that exceeds the number of available drafts, making the attribution invalid.',
      how: 'LoopTroop cleared the out-of-range inspiration reference and set the field to null to prevent broken cross-references.',
    })
  }

  if (/attribution|source label|source labels|source information|source info|inspiration/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'attribution_repaired',
      stage: 'semantic_validation',
      category: 'attribution',
      title: 'Repaired change attribution',
      summary: 'Source attribution on a saved change note was corrected or cleared.',
      why: 'The original attribution did not line up with the validated artifacts or referenced an invalid source.',
      how: 'LoopTroop repaired the attribution fields and preserved the validated change history.',
    })
  }

  // ── Synthesized category ──────────────────────────────────────────────

  if (/^inferred missing /i.test(warning)) {
    return buildIntervention(warning, {
      code: 'synthesized_inferred_detail',
      stage: 'semantic_validation',
      category: 'synthesized',
      title: 'Inferred a missing structured field',
      summary: 'A required structured field was missing and had to be inferred.',
      why: 'The model left out a required field, but the surrounding validated records uniquely identified the correct value.',
      how: 'LoopTroop inferred the missing field and saved the normalized validated artifact.',
    })
  }

  if (/synthesized omitted .* refinement/i.test(warning)) {
    return buildIntervention(warning, {
      code: 'synthesized_omitted_refinement',
      stage: 'semantic_validation',
      category: 'synthesized',
      title: 'Synthesized an omitted refinement change',
      summary: 'The model did not declare a change that is evident from comparing the winning and final drafts, so LoopTroop synthesized it.',
      why: 'The winning and final drafts differ for this item, but the model omitted a corresponding refinement change entry.',
      how: 'LoopTroop matched items by identity across the winning and final drafts, detected the undeclared modification, and synthesized a change record.',
    })
  }

  if (/synthesi|rebuilt|reconstructed/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'synthesized_missing_detail',
      stage: 'normalize',
      category: 'synthesized',
      title: 'Synthesized missing machine-readable detail',
      summary: 'LoopTroop reconstructed a missing structured detail from validated records.',
      why: 'The model omitted a required machine-readable detail even though enough validated context existed to recover it.',
      how: 'LoopTroop synthesized the missing detail and persisted the validated result.',
    })
  }

  // ── Parser fix category (specific sub-patterns) ───────────────────────

  if (/terminal noise/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_terminal_noise',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Stripped trailing terminal noise',
      summary: 'Trailing terminal control characters or shell prompt artifacts were appended after the YAML/JSON payload.',
      why: 'The model echoed terminal noise (control characters, prompt strings, or escape sequences) after the structured data, which would break parsing.',
      how: 'LoopTroop detected and stripped the trailing terminal noise, then reparsed the clean payload successfully.',
    })
  }

  if (/closing code fence/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_closing_fence',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Removed a stray closing code fence',
      summary: 'A closing Markdown code fence (```) was appended after the structured payload.',
      why: 'The model terminated its output with a ``` fence marker that is not part of the structured data, which would cause a parse error.',
      how: 'LoopTroop stripped the trailing ``` fence marker and reparsed the cleaned payload.',
    })
  }

  if (/markdown code fence/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_markdown_fence',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Unwrapped payload from Markdown code fences',
      summary: 'The structured payload was enclosed inside Markdown code fences (```yaml … ```).',
      why: 'The model wrapped the YAML/JSON payload in Markdown code fences instead of returning raw structured data, preventing direct parsing.',
      how: 'LoopTroop extracted the content between the fence markers, discarded the fences, and reparsed the unwrapped payload.',
    })
  }

  if (/wrapper key/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_wrapper_key',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Removed an unexpected top-level wrapper key',
      summary: 'The model nested the expected payload under an extra top-level YAML key that is not part of the schema.',
      why: 'The extra wrapper key changes the document structure, making the payload inaccessible at the expected path.',
      how: 'LoopTroop unwrapped the nested content from under the extra key and reparsed the flattened payload.',
    })
  }

  if (/xml-style tags/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_xml_tags',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Stripped XML-style tags from the payload',
      summary: 'The structured payload was enclosed in XML-like tags (e.g. <output>…</output>).',
      why: 'The model wrapped the YAML/JSON data in XML-style tags that are not part of the expected format, preventing direct parsing.',
      how: 'LoopTroop removed the XML-style tags, extracted the inner content, and reparsed the clean payload.',
    })
  }

  if (/inline yaml/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_inline_yaml',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Converted inline YAML flow syntax to block format',
      summary: 'The model used JSON-like inline YAML flow syntax ({…} or […]) instead of standard block format.',
      why: 'Inline flow syntax can cause ambiguity in strict YAML parsing and is harder to validate against the expected schema.',
      how: 'LoopTroop converted the inline flow constructs to standard block YAML and reparsed the normalized payload.',
    })
  }

  if (/unbalanced yaml quote/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_unbalanced_quote',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Fixed an unbalanced YAML quote',
      summary: 'A quote in the YAML payload was opened but never closed (or vice versa).',
      why: 'An unbalanced quote causes the YAML parser to consume subsequent lines as part of the quoted string, corrupting the document structure.',
      how: 'LoopTroop balanced the mismatched quote, restoring the correct field boundaries, and reparsed the payload.',
    })
  }

  if (/reserved indicator/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_reserved_indicator_scalar',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Quoted a reserved-indicator YAML scalar',
      summary: 'A plain YAML scalar began with a reserved indicator character such as a backtick or `@`, which breaks strict parsing.',
      why: 'YAML does not allow plain one-line scalars to begin with reserved indicator characters, so the emitted value could not be parsed as structured data.',
      how: 'LoopTroop wrapped the existing scalar text in double quotes and reparsed the payload without changing the scalar content itself.',
    })
  }

  if (/free_text.*scalar formatting|yaml free_text scalar/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_free_text_scalar',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Repaired free_text YAML scalar formatting',
      summary: 'A free_text answer used YAML scalar formatting that could not be parsed reliably.',
      why: 'free_text fields are answer strings, but YAML can misread unquoted, malformed block, or split multi-line values as structure.',
      how: 'LoopTroop converted the existing free_text lines to valid quoted or block-scalar YAML and corrected nearby answer metadata indentation without adding answer text.',
    })
  }

  if (
    /double-quoted scalar backslash sequences/i.test(normalized)
    || /invalid .*double-quoted .*backslash/i.test(normalized)
  ) {
    return buildIntervention(warning, {
      code: 'parser_double_quoted_scalar_escape',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Escaped invalid YAML backslash sequences',
      summary: 'A double-quoted YAML scalar contained a backslash sequence YAML does not allow.',
      why: 'YAML double-quoted strings only permit specific escape sequences; an invalid backslash sequence makes the payload fail strict parsing.',
      how: 'LoopTroop escaped the stray backslash sequence without changing the visible scalar text, then reparsed the payload.',
    })
  }

  if (
    /plain scalar.*colon-space|colon-space.*plain scalar/i.test(normalized)
    || /wrapped yaml list scalar.*colon-space/i.test(normalized)
  ) {
    return buildIntervention(warning, {
      code: 'parser_plain_scalar_colon',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Repaired a colon-containing YAML scalar',
      summary: 'A plain YAML scalar contained colon-space text that YAML could otherwise interpret as a nested mapping.',
      why: 'YAML treats colon-space inside an unquoted scalar as structure, so header-like or prose values can parse as the wrong type.',
      how: 'LoopTroop quoted the scalar or folded its existing wrapped lines into valid YAML, then reparsed the payload without changing the scalar content.',
    })
  }

  if (/yaml sequence entry.*treated bare item/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_sequence_item_primary_key',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Repaired a YAML list item key',
      summary: 'A structured YAML list entry used a bare scalar where the item object should have started with its primary key.',
      why: 'YAML cannot attach nested object fields to a scalar list item, so the generated list entry fails strict parsing.',
      how: 'LoopTroop moved the existing bare scalar text into the configured primary key for that list and reparsed the payload.',
    })
  }

  if (/yaml mapping keys missing a space after colon/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_mapping_key_colon_space',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Repaired a YAML mapping separator',
      summary: 'A YAML mapping key was missing the space after its colon, but the surrounding structure proved it was a mapping entry.',
      why: 'Without the separator, YAML can read an intended mapping entry as one plain text value. The same-looking text can also be a legitimate scalar, so standalone list values are left unchanged unless structure proves the mapping meaning.',
      how: 'LoopTroop inserted only the missing separator and kept the original key and value text unchanged before reparsing the payload.',
    })
  }

  if (/quoted .*scalar/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_quoted_scalar',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Repaired an improperly quoted YAML scalar',
      summary: 'A YAML scalar value had mismatched or malformed quoting that would cause a parse error.',
      why: 'The model produced a value with incorrect quote delimiters (e.g. mixed single/double quotes, or unescaped inner quotes).',
      how: 'LoopTroop fixed the quoting on the affected scalar value and reparsed the corrected payload.',
    })
  }

  if (/indentation/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_indentation',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Repaired inconsistent YAML indentation',
      summary: 'The YAML payload had misaligned or mixed indentation levels that broke strict parsing.',
      why: 'YAML is indentation-sensitive; inconsistent indentation causes keys to be assigned to the wrong parent or triggers parse errors.',
      how: 'LoopTroop corrected the indentation to produce valid, consistently-indented YAML and reparsed the payload.',
    })
  }

  if (/yaml list dash/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_list_dash',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Corrected a malformed YAML list-item dash',
      summary: 'A YAML list entry had an incorrect or missing dash prefix ("- ").',
      why: 'YAML list items must start with "- " followed by the value; a missing or malformed dash breaks the list structure.',
      how: 'LoopTroop repaired the list-item syntax to use the correct "- " prefix and reparsed the payload.',
    })
  }

  if (/wrapper text|transcript/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_transcript_recovery',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Extracted payload from surrounding prose or transcript',
      summary: 'The structured payload was embedded inside conversational text, preamble, or transcript output.',
      why: 'The model included explanatory prose or transcript text alongside the structured data instead of returning only the raw YAML/JSON payload.',
      how: 'LoopTroop isolated the structured data block from the surrounding text, discarded the prose, and reparsed the extracted payload.',
    })
  }

  if (/truncated incomplete|recover from malformed yaml|malformed yaml/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_malformed_yaml',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Recovered data from malformed YAML',
      summary: 'The YAML payload had structural errors too severe for simple quote or indentation repairs (e.g. truncated entries, broken nesting).',
      why: 'The model produced YAML with deep structural problems that would cause complete parse failure if not handled with recovery logic.',
      how: 'LoopTroop applied best-effort recovery rules to extract the valid portions, discarded the unrecoverable fragments, and reparsed the salvaged payload.',
    })
  }

  // parser_fix fallback for unrecognized parser-level issues
  if (/code fence|parse error|yaml error|json error/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'parser_repair',
      stage: 'parse',
      category: 'parser_fix',
      title: 'Recovered malformed structured output',
      summary: 'LoopTroop repaired a parser-level formatting issue so the structured artifact could be read safely.',
      why: 'The model wrapped or formatted the output in a way that broke strict machine parsing.',
      how: 'LoopTroop cleaned the parser-level formatting issue, reparsed the payload, and kept the validated result.',
    })
  }

  // ── Cleanup category (specific sub-patterns) ─────────────────────────

  if (/^Restored (?:PRD|beads) refinement ID stability at change index \d+:/i.test(warning)) {
    return buildIntervention(warning, {
      code: 'cleanup_refinement_id_stability',
      stage: 'semantic_validation',
      category: 'cleanup',
      title: 'Restored refinement identifier stability',
      summary: 'A newly added item reused an existing identifier and shifted the surviving item to a different identifier.',
      why: 'Surviving items must retain their winning-artifact identifiers so references remain stable. The displaced survivor and explicit addition could be matched uniquely from the validated winner, final artifact, and change records.',
      how: 'LoopTroop restored the surviving item’s original identifier and moved the newly added item to the unused identifier. Only identifiers and their references were corrected; no item text was created or rewritten.',
    })
  }

  if (/collapsed duplicate.*refinement/i.test(warning)) {
    return buildIntervention(warning, {
      code: 'cleanup_collapsed_duplicate',
      stage: 'semantic_validation',
      category: 'cleanup',
      title: 'Collapsed a duplicate refinement change',
      summary: 'A refinement change entry was identical to another change already recorded for the same item.',
      why: 'The model declared the same modification twice, which would double-count the change in the validated diff.',
      how: 'LoopTroop detected the duplicate change entry, kept the first occurrence, and removed the redundant copy.',
    })
  }

  if (/renumbered|duplicate .* id|duplicate option ids/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_duplicate_ids',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Renumbered duplicate identifiers',
      summary: 'One or more items shared the same identifier, so LoopTroop assigned unique IDs to eliminate conflicts.',
      why: 'Duplicate identifiers cause ambiguity in cross-referencing and break data integrity when items are looked up by ID.',
      how: 'LoopTroop detected the duplicates, assigned unique sequential identifiers (preserving the original content), and updated all internal references.',
    })
  }

  if (/filled missing|missing .*\bfilled\b/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_filled_missing',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Filled a missing required field',
      summary: 'A required field was empty or omitted by the model and was populated with the correct value.',
      why: 'The model left out a required field that downstream processing depends on, but the correct value could be determined from context.',
      how: 'LoopTroop inferred the correct value from the runtime context or used a safe default, then populated the missing field before saving.',
    })
  }

  if (/recomputed total_score/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_recomputed_score',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Recomputed total_score from dimension scores',
      summary: 'The reported total_score did not match the arithmetic result of its component dimension scores.',
      why: 'The model produced a total_score that is inconsistent with the individual dimension scores, which would make vote rankings unreliable.',
      how: 'LoopTroop recalculated total_score from the individual dimension scores to ensure arithmetic consistency.',
    })
  }

  if (/trimmed empty/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_trimmed_empty',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Trimmed empty entries',
      summary: 'Empty or whitespace-only entries were removed from the artifact.',
      why: 'Blank entries carry no meaningful content and would clutter the persisted artifact with noise.',
      how: 'LoopTroop filtered out the empty entries and kept only entries with substantive content.',
    })
  }

  if (/phase reordering|reorder|reordered|sorting|question order/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_reordering',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Re-sorted items into canonical phase order',
      summary: 'Items were returned in a non-canonical order and were re-sorted (foundation → structure → assembly).',
      why: 'The workflow requires a stable, deterministic ordering so that items appear consistently across all views and downstream phases.',
      how: 'LoopTroop applied the canonical phase sort order, preserving all item content while correcting their sequence.',
    })
  }

  if (/resolved interview status/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_interview_status',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Resolved interview status to the expected value',
      summary: 'The interview status field was set to an unexpected value and was corrected.',
      why: 'The model set the interview status to a value that conflicts with the current workflow stage.',
      how: 'LoopTroop overrode the status to the canonical value required at this point in the interview workflow.',
    })
  }

  if (/normalized.*status|status to draft/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_status_normalized',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Normalized artifact status to "draft"',
      summary: 'The artifact status was set to an unsupported or premature value and was corrected to "draft".',
      why: 'At this stage of the workflow, the artifact must start as a draft — the model set it to a different status prematurely.',
      how: 'LoopTroop overrode the status field to "draft", the required value for newly generated artifacts at this workflow stage.',
    })
  }

  if (/approval fields/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_approval_fields',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Cleared pre-filled approval fields',
      summary: 'Approval metadata (timestamps, approver info) was pre-populated by the model and had to be cleared.',
      why: 'Approval fields should only be set by explicit user action — pre-filling them would bypass the approval workflow.',
      how: 'LoopTroop cleared the pre-filled approval metadata so the artifact starts in a proper unapproved state.',
    })
  }

  if (/generated_by\.winner_model/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_winner_model',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Corrected the generated_by.winner_model field',
      summary: 'The model identified itself incorrectly in the generated_by.winner_model field.',
      why: 'The winner_model field must match the canonical model identifier of the council member that produced this draft for accurate attribution.',
      how: 'LoopTroop set generated_by.winner_model to the correct canonical model identifier for the drafting council member.',
    })
  }

  if (/ticket_id/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_ticket_id',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Corrected the ticket_id field',
      summary: 'The ticket_id did not match the current ticket and was corrected to the canonical identifier.',
      why: 'The model produced a ticket_id that does not match the ticket this artifact belongs to, which would break ticket-artifact linking.',
      how: 'LoopTroop replaced the ticket_id with the authoritative value from the runtime context.',
    })
  }

  if (/content_sha256/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_content_hash',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Recalculated the source content hash',
      summary: 'The content_sha256 hash was incorrect or stale and was recomputed from the authoritative source artifact.',
      why: 'A mismatched content hash would break change-detection logic that relies on hash comparison to determine if the source has been modified.',
      how: 'LoopTroop recomputed content_sha256 from the approved source artifact and stored the correct hash.',
    })
  }

  if (/schema_version/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_schema_version',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Corrected the schema_version field',
      summary: 'The schema_version was set to an invalid or unexpected value and was corrected.',
      why: 'An incorrect schema_version could cause downstream readers to misinterpret the artifact structure.',
      how: 'LoopTroop set schema_version to the correct value for the current artifact format.',
    })
  }

  if (/mapped free_text|mapped selected option ids/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_mapped_free_text',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Mapped answer content to canonical option IDs',
      summary: 'The model provided non-canonical choice data instead of using the approved option IDs directly.',
      why: 'Downstream processing requires canonical option identifiers, not free-form text, for structured question responses.',
      how: 'LoopTroop matched the provided option labels or answer text to the canonical option identifiers and recorded the mapping.',
    })
  }

  if (/accepted empty final_free_form answer/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_final_free_form_empty',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Accepted an empty final free-form answer',
      summary: 'The model marked the final free-form question as answered but left its text empty, and LoopTroop treated that as an explicit no-additions response.',
      why: 'For the final free-form question only, an empty answer can safely mean "nothing else to add" when the model already marked it answered and supplied an answer timestamp.',
      how: 'LoopTroop preserved the answered state, kept the empty text, and recorded the normalization as a cleanup warning instead of inventing content.',
    })
  }

  if (/restored answered/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_restored_answered',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Restored an answered question from the approved artifact',
      summary: 'A previously answered and approved interview question was omitted or altered by the model and was restored.',
      why: 'Approved answers are authoritative — the model should not modify or omit them in subsequent drafts.',
      how: 'LoopTroop copied the authoritative answered record from the approved Interview Results artifact.',
    })
  }

  if (/answered_by.*ai_skip/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_answered_by',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Canonicalized answered_by to "ai_skip"',
      summary: 'The answered_by field for an AI-filled question was set incorrectly and was corrected to "ai_skip".',
      why: 'AI-filled questions must be tagged as "ai_skip" so the system knows they were not answered by the user.',
      how: 'LoopTroop set the answered_by field to "ai_skip" for the AI-filled question.',
    })
  }

  if (/follow_up_rounds/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_follow_up_rounds',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Canonicalized follow_up_rounds from approved artifact',
      summary: 'The follow_up_rounds data was altered or omitted by the model and was restored from the approved artifact.',
      why: 'Follow-up round data was already approved — the model should preserve it exactly as-is in subsequent drafts.',
      how: 'LoopTroop restored follow_up_rounds from the authoritative approved Interview Results artifact.',
    })
  }

  if (/summary to match/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_summary_match',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Canonicalized the document summary',
      summary: 'The document summary was altered by the model and was restored to match the approved artifact.',
      why: 'The approved summary is authoritative — rewording it could misrepresent the approved interview content.',
      how: 'LoopTroop restored the summary text from the authoritative approved artifact.',
    })
  }

  if (/no prd references/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_no_prd_refs',
      stage: 'semantic_validation',
      category: 'cleanup',
      title: 'Flagged a bead with no PRD references',
      summary: 'A bead has an empty prdRefs list, meaning it does not trace to any PRD user story or epic.',
      why: 'Every bead should reference at least one PRD item for traceability — an empty prdRefs may indicate the bead was fabricated or the references were lost.',
      how: 'LoopTroop recorded the missing-reference warning; the bead was kept but flagged for review.',
    })
  }

  if (/context guidance/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_context_guidance',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Canonicalized context guidance into structured format',
      summary: 'Inline string context guidance was converted into the structured patterns/anti_patterns object format.',
      why: 'The model provided context guidance as a plain string instead of the expected structured object with patterns and anti_patterns fields.',
      how: 'LoopTroop parsed the inline string, mapped it into the canonical patterns/anti_patterns structure, and persisted the normalized result.',
    })
  }

  if (/affected_items label/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_affected_label',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Canonicalized an affected_items label',
      summary: 'An affected_items label did not match the authoritative source and was corrected.',
      why: 'The label must exactly match the canonical label from the source artifact to maintain consistent cross-referencing.',
      how: 'LoopTroop looked up the canonical label from the source artifact and replaced the model-provided label.',
    })
  }

  if (/preserved.*testcommands/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_preserved_test_commands',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Restored preserved test commands after drift',
      summary: 'Part 1 testCommands changed during expansion and were restored from the canonical refined blueprint.',
      why: 'Expansion may only change AI-owned fields, so preserved execution commands must remain identical to the validated blueprint.',
      how: 'LoopTroop kept the expanded AI-owned fields, restored the canonical testCommands from the refined blueprint, and recorded the repair.',
    })
  }

  if (/preserved.*narrative fields/i.test(normalized) && /substantive drift/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_preserved_narrative_substantive',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Restored preserved narrative fields after substantive drift',
      summary: 'Part 1 narrative fields were rewritten during expansion and were restored from the canonical refined blueprint.',
      why: 'Only AI-owned fields may change during expansion, so narrative rewrites in preserved Part 1 fields must not be persisted.',
      how: 'LoopTroop kept the expanded AI-owned fields, restored the canonical Part 1 narrative fields from the refined blueprint, and recorded the repair.',
    })
  }

  if (/preserved.*narrative fields/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_preserved_narrative',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Restored preserved narrative fields after drift',
      summary: 'Part 1 narrative fields drifted during expansion (punctuation or whitespace changes only) and were restored.',
      why: 'Narrative fields from Part 1 of the blueprint are preserved verbatim — even minor punctuation or whitespace changes are considered drift.',
      how: 'LoopTroop detected the cosmetic drift, restored the original Part 1 narrative field values, and kept the expanded content.',
    })
  }

  if (/converted.*(?:added|replaced|modified)|updated.*refined.*question|removed stale.*refined/i.test(warning)) {
    return buildIntervention(warning, {
      code: 'cleanup_change_type_correction',
      stage: 'semantic_validation',
      category: 'cleanup',
      title: 'Corrected a refinement change type or applied it to the question list',
      summary: 'A refinement change was reclassified or applied to synchronize the top-level question list with the declared changes.',
      why: 'The declared change type did not match the actual modification, or the top-level list was out of sync with the change entries.',
      how: 'LoopTroop reclassified the change to the correct type and/or updated the question list to reflect the declared changes.',
    })
  }

  // cleanup fallback for remaining canonical/normalized patterns
  if (/canonical|normalized/i.test(normalized)) {
    return buildIntervention(warning, {
      code: 'cleanup_canonicalization',
      stage: 'normalize',
      category: 'cleanup',
      title: 'Canonicalized saved artifact details',
      summary: 'Saved artifact metadata or content was normalized to the canonical validated shape.',
      why: 'The generated output did not exactly match the persisted schema or canonical project state.',
      how: 'LoopTroop rewrote the affected fields to the canonical validated values before saving the artifact.',
    })
  }

  // ── Generic cleanup fallback ──────────────────────────────────────────

  return buildIntervention(warning, {
    code: 'cleanup_generic',
    stage: 'normalize',
    category: 'cleanup',
    title: 'Normalized saved artifact details',
    summary: 'LoopTroop adjusted a saved artifact detail during validation.',
    why: 'The generated output did not fully match the expected machine-readable shape.',
    how: 'LoopTroop normalized the detail before persisting the validated artifact.',
  })
}

export function deriveStructuredInterventions(options: {
  repairWarnings?: string[]
  autoRetryCount?: number
  validationError?: string
}): StructuredIntervention[] {
  const interventions = (options.repairWarnings ?? [])
    .filter((warning): warning is string => typeof warning === 'string' && warning.trim().length > 0)
    .map((warning) => deriveInterventionFromWarning(warning))

  const retryCount = options.autoRetryCount ?? 0
  const validationError = normalizeString(options.validationError)
  if (retryCount > 0 || validationError) {
    interventions.push(enrichIntervention({
      code: retryCount > 0 ? 'retry_after_validation_failure' : 'validation_failure_recorded',
      stage: retryCount > 0 ? 'retry' : 'semantic_validation',
      category: 'retry',
      title: retryCount > 0 ? 'Retried after validation failure' : 'Recorded a validation failure',
      summary: retryCount > 0
        ? `LoopTroop used ${Math.max(retryCount, 1)} extra validation pass(es) after an earlier response failed validation.`
        : 'A validator rejected an earlier response shape.',
      why: retryCount > 0
        ? 'The first response did not match the required machine-readable shape or semantic contract.'
        : 'The saved output did not satisfy strict validation.',
      how: retryCount > 0
        ? 'LoopTroop preserved each rejected model response in Raw attempts, retried the structured output request, and recorded the final accepted or rejected artifact state.'
        : 'LoopTroop kept the validator message for debugging and surfaced the saved result with that context.',
      ...(validationError ? { technicalDetail: validationError } : {}),
      ...(validationError ? { rawMessages: [validationError] } : {}),
    }))
  }

  return interventions
}
