import { describe, expect, it } from 'vitest'
import { buildStructuredOutputMetadata, normalizeStructuredOutputMetadata } from '../metadata'

describe.concurrent('structured output metadata helpers', () => {
  it('normalizes metadata and drops malformed interventions', () => {
    const metadata = normalizeStructuredOutputMetadata({
      repairApplied: true,
      repairWarnings: ['Canonicalized ticket_id from the ticket context.'],
      autoRetryCount: 1,
      validationError: 'First pass failed validation.',
      interventions: [
        {
          code: 'cleanup_canonicalization',
          stage: 'normalize',
          category: 'cleanup',
          title: 'Canonicalized saved artifact details',
          summary: 'Saved artifact metadata was normalized.',
          why: 'The generated output did not match the canonical schema.',
          how: 'LoopTroop rewrote the affected fields before saving.',
        },
        {
          code: 'missing_fields_only',
        },
      ],
    })

    expect(metadata).toEqual({
      repairApplied: true,
      repairWarnings: ['Canonicalized ticket_id from the ticket context.'],
      autoRetryCount: 1,
      validationError: 'First pass failed validation.',
      interventions: [
        expect.objectContaining({
          code: 'cleanup_canonicalization',
          category: 'cleanup',
        }),
      ],
    })
  })

  it('merges explicit and derived interventions when building metadata', () => {
    const metadata = buildStructuredOutputMetadata(
      {
        repairApplied: true,
        interventions: [
          {
            code: 'attribution_repaired',
            stage: 'semantic_validation',
            category: 'attribution',
            title: 'Repaired change attribution',
            summary: 'Source attribution was corrected.',
            why: 'The original attribution referenced an invalid source.',
            how: 'LoopTroop repaired the attribution fields before saving.',
          },
        ],
      },
      {
        repairWarnings: [
          'Recovered the structured artifact from surrounding transcript or wrapper text before validation.',
        ],
        autoRetryCount: 1,
        validationError: 'Malformed YAML on first pass.',
      },
    )

    expect(metadata.repairApplied).toBe(true)
    expect(metadata.repairWarnings).toEqual([
      'Recovered the structured artifact from surrounding transcript or wrapper text before validation.',
    ])
    expect(metadata.interventions).toEqual([
      expect.objectContaining({ code: 'attribution_repaired', category: 'attribution' }),
      expect.objectContaining({ code: 'parser_transcript_recovery', category: 'parser_fix' }),
      expect.objectContaining({ code: 'retry_after_validation_failure', category: 'retry' }),
    ])
  })

  it('deduplicates repair warnings and derived interventions across repeated merges', () => {
    const once = buildStructuredOutputMetadata(
      {
        repairApplied: true,
        repairWarnings: ['Recovered the structured artifact from surrounding transcript or wrapper text before validation.'],
        autoRetryCount: 1,
        validationError: 'Malformed YAML on first pass.',
      },
      {
        repairWarnings: ['Recovered the structured artifact from surrounding transcript or wrapper text before validation.'],
        autoRetryCount: 1,
        validationError: 'Malformed YAML on first pass.',
      },
    )

    const twice = buildStructuredOutputMetadata(once, {
      repairWarnings: ['Recovered the structured artifact from surrounding transcript or wrapper text before validation.'],
      autoRetryCount: 1,
      validationError: 'Malformed YAML on first pass.',
    })

    expect(twice.repairWarnings).toEqual([
      'Recovered the structured artifact from surrounding transcript or wrapper text before validation.',
    ])
    expect(twice.interventions).toEqual([
      expect.objectContaining({ code: 'parser_transcript_recovery', category: 'parser_fix' }),
      expect.objectContaining({ code: 'retry_after_validation_failure', category: 'retry' }),
    ])
  })

  it('normalizes and deduplicates retry diagnostics across merges', () => {
    const once = buildStructuredOutputMetadata(
      {
        autoRetryCount: 1,
        retryDiagnostics: [
          {
            attempt: 1,
            validationError: 'Coverage output missing valid status',
            target: 'status',
            excerpt: '  1 | status:',
          },
        ],
      },
      {
        retryDiagnostics: [
          {
            attempt: 1,
            validationError: 'Coverage output missing valid status',
            target: 'status',
            excerpt: '  1 | status:',
          },
          {
            attempt: 2,
            validationError: 'Coverage output missing valid status',
            line: 3,
            column: 1,
            excerpt: '  3 | gaps:',
          },
        ],
      },
    )

    expect(once.retryDiagnostics).toEqual([
      {
        attempt: 1,
        validationError: 'Coverage output missing valid status',
        target: 'status',
        excerpt: '  1 | status:',
      },
      {
        attempt: 2,
        validationError: 'Coverage output missing valid status',
        line: 3,
        column: 1,
        excerpt: '  3 | gaps:',
      },
    ])
  })

  it('hydrates fallback rule and exact details for legacy interventions with technicalDetail only', () => {
    const metadata = normalizeStructuredOutputMetadata({
      repairApplied: true,
      repairWarnings: [],
      autoRetryCount: 0,
      interventions: [
        {
          code: 'cleanup_ticket_id',
          stage: 'normalize',
          category: 'cleanup',
          title: 'Corrected the ticket_id field',
          summary: 'The ticket_id did not match the current ticket.',
          why: 'The model produced a ticket_id that does not match the current ticket.',
          how: 'LoopTroop replaced ticket_id with the runtime value.',
          technicalDetail: 'Canonicalized ticket_id from "old-id" to "new-id".',
        },
      ],
    })

    expect(metadata?.interventions).toEqual([
      expect.objectContaining({
        code: 'cleanup_ticket_id',
        rule: {
          id: 'cleanup_ticket_id',
          label: 'Ticket ID',
        },
        exactCorrection: 'Changed ticket_id from "old-id" to "new-id".',
        examples: [
          {
            scope: 'ticket_id',
            before: 'old-id',
            after: 'new-id',
          },
        ],
      }),
    ])
  })

  it('builds future intervention metadata with raw audit messages and retry diagnostics', () => {
    const transcriptRecovery = 'Recovered the structured artifact from surrounding transcript or wrapper text before validation.'
    const markdownCleanup = 'Removed surrounding markdown code fence before parsing the final test commands.'
    const winnerModelCorrection = 'Canonicalized generated_by.winner_model from "gpt-4" to "claude-sonnet".'
    const contentHashCanonicalization = 'Canonicalized source_interview.content_sha256 from the approved Interview Results artifact.'
    const missingFieldInference = 'Inferred missing PRD refinement item_type at index 0 as epic.'
    const droppedNoOp = 'Dropped no-op PRD refinement modified change at index 3 because the winning and final records are identical.'
    const validationError = 'Malformed vote output: Missing scorecard for Draft 2.'

    const metadata = buildStructuredOutputMetadata(undefined, {
      repairApplied: true,
      repairWarnings: [
        transcriptRecovery,
        markdownCleanup,
        winnerModelCorrection,
        contentHashCanonicalization,
        missingFieldInference,
        droppedNoOp,
      ],
      autoRetryCount: 2,
      validationError,
      retryDiagnostics: [
        {
          attempt: 1,
          validationError: 'Vote scorecard output echoed the prompt instead of returning a structured scorecard',
          failureClass: 'validation_error',
          target: 'vote scorecard',
          line: 1,
          column: 1,
          excerpt: 'CRITICAL OUTPUT RULE:\nReturn only YAML.',
        },
        {
          attempt: 2,
          validationError: 'Vote scorecard output was empty.',
          failureClass: 'empty_response',
          target: 'vote scorecard',
          excerpt: '[empty response]',
        },
      ],
    })

    expect(metadata.repairWarnings).toEqual([
      transcriptRecovery,
      markdownCleanup,
      winnerModelCorrection,
      contentHashCanonicalization,
      missingFieldInference,
      droppedNoOp,
    ])
    expect(metadata.retryDiagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        validationError: 'Vote scorecard output echoed the prompt instead of returning a structured scorecard',
        failureClass: 'validation_error',
        target: 'vote scorecard',
        line: 1,
        column: 1,
        excerpt: 'CRITICAL OUTPUT RULE:\nReturn only YAML.',
      }),
      expect.objectContaining({
        attempt: 2,
        validationError: 'Vote scorecard output was empty.',
        failureClass: 'empty_response',
        target: 'vote scorecard',
        excerpt: '[empty response]',
      }),
    ])
    expect(metadata.interventions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'parser_transcript_recovery',
        rule: { id: 'parser_transcript_recovery', label: 'Transcript Recovery' },
        rawMessages: [transcriptRecovery],
      }),
      expect.objectContaining({
        code: 'parser_markdown_fence',
        rule: { id: 'parser_markdown_fence', label: 'Markdown Fence Unwrap' },
        rawMessages: [markdownCleanup],
      }),
      expect.objectContaining({
        code: 'cleanup_winner_model',
        exactCorrection: 'Changed generated_by.winner_model from "gpt-4" to "claude-sonnet".',
        examples: [
          {
            scope: 'generated_by.winner_model',
            before: 'gpt-4',
            after: 'claude-sonnet',
          },
        ],
        rawMessages: [winnerModelCorrection],
      }),
      expect.objectContaining({
        code: 'cleanup_content_hash',
        exactCorrection: 'Recomputed source_interview.content_sha256 from the authoritative approved source artifact.',
        rawMessages: [contentHashCanonicalization],
      }),
      expect.objectContaining({
        code: 'synthesized_inferred_detail',
        exactCorrection: 'Filled the missing PRD refinement item_type with "epic" using the validated surrounding context.',
        rawMessages: [missingFieldInference],
      }),
      expect.objectContaining({
        code: 'dropped_no_op_change',
        exactCorrection: 'Removed the no-op modified change entry at index 3 from the saved diff.',
        rawMessages: [droppedNoOp],
      }),
      expect.objectContaining({
        code: 'retry_after_validation_failure',
        rule: { id: 'retry_after_validation_failure', label: 'Validation Retry' },
        rawMessages: [validationError],
      }),
    ]))
  })

  it.each([
    {
      artifact: 'PRD',
      warning: 'Restored PRD refinement ID stability at change index 8: reassigned surviving user_story "Plugin documentation is available" from US-16 to US-15 and reassigned newly added user_story "Precomputed holiday Set for performance" from US-15 to US-16.',
      itemType: 'user_story',
      survivingLabel: 'Plugin documentation is available',
      survivingBefore: 'US-16',
      survivingAfter: 'US-15',
      addedLabel: 'Precomputed holiday Set for performance',
      addedBefore: 'US-15',
      addedAfter: 'US-16',
    },
    {
      artifact: 'Beads',
      warning: 'Restored Beads refinement ID stability at change index 2: reassigned surviving bead "Keep stable references" from BEAD-4 to BEAD-3 and reassigned newly added bead "Validate new references" from BEAD-3 to BEAD-4.',
      itemType: 'bead',
      survivingLabel: 'Keep stable references',
      survivingBefore: 'BEAD-4',
      survivingAfter: 'BEAD-3',
      addedLabel: 'Validate new references',
      addedBefore: 'BEAD-3',
      addedAfter: 'BEAD-4',
    },
  ])('presents a detailed $artifact refinement ID-stability repair', ({
    artifact,
    warning,
    itemType,
    survivingLabel,
    survivingBefore,
    survivingAfter,
    addedLabel,
    addedBefore,
    addedAfter,
  }) => {
    const metadata = buildStructuredOutputMetadata(undefined, {
      repairApplied: true,
      repairWarnings: [warning],
    })

    expect(metadata.interventions).toEqual([
      expect.objectContaining({
        code: 'cleanup_refinement_id_stability',
        stage: 'semantic_validation',
        category: 'cleanup',
        title: 'Restored refinement identifier stability',
        why: expect.stringContaining('matched uniquely'),
        how: expect.stringContaining('no item text was created or rewritten'),
        rule: {
          id: 'cleanup_refinement_id_stability',
          label: 'Refinement ID Stability Repair',
        },
        exactCorrection: expect.stringContaining(`At ${artifact} refinement change index`),
        examples: [
          {
            scope: `Surviving ${itemType}: ${survivingLabel}`,
            before: survivingBefore,
            after: survivingAfter,
            note: 'Restored the identifier from the winning artifact.',
          },
          {
            scope: `Newly added ${itemType}: ${addedLabel}`,
            before: addedBefore,
            after: addedAfter,
            note: 'Assigned the unused identifier freed by restoring the surviving item.',
          },
        ],
        rawMessages: [warning],
      }),
    ])
  })
})
