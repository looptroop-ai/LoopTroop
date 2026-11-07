import * as jsYaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { PRD_ITEM_CHANGES_CONTRACT } from '../../../prompts'
import {
  buildPrdCoverageRevisionArtifact,
  buildPrdCoverageRevisionRetryPrompt,
  buildPrdCoverageRevisionUiDiff,
  validatePrdCoverageRevisionOutput,
} from '../coverageRevision'

function buildInterviewContent(): string {
  return jsYaml.dump({
    schema_version: 1,
    ticket_id: 'POBA-3',
    artifact: 'interview',
    status: 'approved',
    generated_by: {
      winner_model: 'openai/gpt-5.4',
      generated_at: '2026-01-01T00:00:00.000Z',
      canonicalization: 'server_normalized',
    },
    questions: [{
      id: 'Q01',
      phase: 'Foundation',
      prompt: 'What should this PRD enforce?',
      source: 'compiled',
      follow_up_round: null,
      answer_type: 'free_text',
      options: [],
      answer: {
        skipped: false,
        selected_option_ids: [],
        free_text: 'Keep PRD coverage revisions inspectable.',
        answered_by: 'user',
        answered_at: '2026-01-01T00:00:00.000Z',
      },
    }],
    follow_up_rounds: [],
    summary: {
      goals: ['Keep coverage diffs inspectable.'],
      constraints: [],
      non_goals: [],
      final_free_form_answer: '',
    },
    approval: {
      approved_by: 'user',
      approved_at: '2026-01-01T00:00:00.000Z',
    },
  }, { lineWidth: 120, noRefs: true }) as string
}

function buildPrdContent(
  toolingAssumptions: string[],
  options: {
    apiContracts?: string[]
    storyTitle?: string
  } = {},
): string {
  return jsYaml.dump({
    schema_version: 1,
    ticket_id: 'POBA-3',
    artifact: 'prd',
    status: 'draft',
    source_interview: {
      content_sha256: 'approved-hash',
    },
    product: {
      problem_statement: 'Keep PRD coverage diffs inspectable.',
      target_users: ['LoopTroop maintainers'],
    },
    scope: {
      in_scope: ['Coverage diff fallback'],
      out_of_scope: ['Execution changes'],
    },
    technical_requirements: {
      architecture_constraints: ['Prefer validated metadata when it exists.'],
      data_model: [],
      api_contracts: options.apiContracts ?? [],
      security_constraints: [],
      performance_constraints: [],
      reliability_constraints: ['Coverage revisions must remain reviewable.'],
      error_handling_rules: ['Fall back to structural before/after diffs when saved change metadata is unusable.'],
      tooling_assumptions: toolingAssumptions,
    },
    epics: [{
      id: 'EPIC-1',
      title: 'Inspect PRD coverage revisions',
      objective: 'Keep coverage revisions reviewable even when saved semantic changes are missing.',
      implementation_steps: ['Compare the prior candidate against the revised candidate.'],
      user_stories: [{
        id: 'US-1',
        title: options.storyTitle ?? 'Review the saved coverage diff',
        acceptance_criteria: ['Approval shows a meaningful diff for coverage revisions.'],
        implementation_steps: ['Build a structural fallback diff when semantic metadata is empty.'],
        verification: {
          required_commands: ['npm run test'],
        },
      }],
    }],
    risks: ['Empty saved diff metadata can hide real PRD changes.'],
    approval: {
      approved_by: '',
      approved_at: '',
    },
    changes: [],
  }, { lineWidth: 120, noRefs: true }) as string
}

describe.concurrent('PRD coverage revision diffs', () => {
  it('falls back to a structural PRD diff when validated coverage changes are empty', () => {
    const beforeContent = buildPrdContent([
      'Use vitest for coverage diff regression checks.',
    ])
    const afterContent = buildPrdContent([
      'Use vitest for coverage diff regression checks.',
      'Build a structural fallback diff when saved coverage change metadata is empty.',
    ])

    const revisionArtifact = buildPrdCoverageRevisionArtifact('openai/gpt-5.4', 2, {
      refinedContent: afterContent,
      priorCandidateContent: beforeContent,
      changes: [],
      gapResolutions: [],
      metrics: { epicCount: 1, userStoryCount: 1 },
      repairApplied: true,
      repairWarnings: ['Skipped refinement change at index 0 with invalid type.'],
    })

    const uiDiffArtifact = buildPrdCoverageRevisionUiDiff(revisionArtifact)

    expect(uiDiffArtifact).toMatchObject({
      domain: 'prd',
      winnerId: 'openai/gpt-5.4',
      entries: expect.arrayContaining([
        expect.objectContaining({
          changeType: 'modified',
          itemKind: 'technical_requirements.tooling_assumptions',
          label: 'Tooling Assumptions',
        }),
      ]),
    })
  })

  it('drops path-only change metadata while keeping the structural PRD diff reviewable', () => {
    const coverageGap = 'Record structural fallback coverage as a tooling assumption.'
    const currentCandidateContent = buildPrdContent([
      'Use vitest for coverage diff regression checks.',
    ])
    const revised = jsYaml.load(buildPrdContent([
      'Use vitest for coverage diff regression checks.',
      'Build a structural fallback diff when path-only change metadata cannot be trusted.',
    ])) as Record<string, unknown>

    revised.changes = [{
      change_type: 'modified',
      path: 'technical_requirements.tooling_assumptions',
      before_summary: 'Only the vitest regression check was listed.',
      after_summary: 'The structural fallback diff assumption was added.',
      summary: 'Added structural fallback diff tooling guidance.',
    }]
    revised.gap_resolutions = [{
      gap: coverageGap,
      action: 'updated_prd',
      rationale: 'The revised PRD records the structural diff fallback as a tooling assumption.',
      affected_items: [],
    }]

    const result = validatePrdCoverageRevisionOutput(
      jsYaml.dump(revised, { lineWidth: 120, noRefs: true }) as string,
      {
        ticketId: 'POBA-3',
        interviewContent: buildInterviewContent(),
        currentCandidateContent,
        coverageGaps: [coverageGap],
      },
    )
    const uiDiffArtifact = buildPrdCoverageRevisionUiDiff(
      buildPrdCoverageRevisionArtifact('openai/gpt-5.4', 3, result),
    )

    expect(result.changes).toEqual([])
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain(
      'Skipped refinement change at index 0 with path/summary metadata only; semantic before/after item records are required.',
    )
    expect(uiDiffArtifact.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        changeType: 'modified',
        itemKind: 'technical_requirements.tooling_assumptions',
        label: 'Tooling Assumptions',
      }),
    ]))
  })

  it('canonicalizes escaped quote differences in PRD coverage gap references', () => {
    const coverageGap = 'MVP requirement \\"ranking pipeline hook\\" has no dedicated user story.'
    const currentCandidateContent = buildPrdContent([
      'Use vitest for coverage diff regression checks.',
    ])
    const revised = jsYaml.load(buildPrdContent([
      'Use vitest for coverage diff regression checks.',
      'Add a user story for the ranking pipeline hook.',
    ], {
      storyTitle: 'Ranking pipeline hook',
    })) as Record<string, unknown>

    revised.gap_resolutions = [{
      gap: 'MVP requirement "ranking pipeline hook" has no dedicated user story.',
      action: 'updated_prd',
      rationale: 'The revised PRD adds a user story for the ranking pipeline hook.',
      affected_items: [{
        item_type: 'user_story',
        id: 'US-1',
        label: 'Ranking pipeline hook',
      }],
    }]

    const result = validatePrdCoverageRevisionOutput(
      jsYaml.dump(revised, { lineWidth: 120, noRefs: true }) as string,
      {
        ticketId: 'POBA-3',
        interviewContent: buildInterviewContent(),
        currentCandidateContent,
        coverageGaps: [coverageGap],
      },
    )

    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Canonicalized PRD coverage gap reference')
    expect(result.gapResolutions[0]?.gap).toBe(coverageGap)
  })

  it('drops section-level affected_items references that the PRD coverage schema cannot represent', () => {
    const coverageGap = 'Clarify the API contracts section.'
    const currentCandidateContent = buildPrdContent([
      'Use vitest for coverage diff regression checks.',
    ])
    const revised = jsYaml.load(buildPrdContent([
      'Use vitest for coverage diff regression checks.',
    ], {
      apiContracts: ['GET query contract explicitly rejects raw unencoded JSON facet_boosts values.'],
    })) as Record<string, unknown>

    revised.gap_resolutions = [{
      gap: coverageGap,
      action: 'updated_prd',
      rationale: 'Clarified the GET API contract and kept the user-story reference that explains the endpoint behavior.',
      affected_items: [
        {
          item_type: 'user_story',
          id: 'US-1',
          label: 'Review the saved coverage diff',
        },
        {
          item_type: 'prd',
          id: 'api_contracts',
          label: 'api_contracts',
        },
      ],
    }]

    const result = validatePrdCoverageRevisionOutput(
      jsYaml.dump(revised, { lineWidth: 120, noRefs: true }) as string,
      {
        ticketId: 'POBA-3',
        interviewContent: buildInterviewContent(),
        currentCandidateContent,
        coverageGaps: [coverageGap],
      },
    )

    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Ignored PRD coverage affected_items entry')
    expect(result.gapResolutions).toEqual([
      {
        gap: coverageGap,
        action: 'updated_prd',
        rationale: 'Clarified the GET API contract and kept the user-story reference that explains the endpoint behavior.',
        affectedItems: [{
          itemType: 'user_story',
          id: 'US-1',
          label: 'Review the saved coverage diff',
        }],
      },
    ])
  })

  it('infers a missing PRD coverage affected_items item_type from a unique user story id', () => {
    const coverageGap = 'Record the validated coverage story directly.'
    const currentCandidateContent = buildPrdContent([
      'Use vitest for coverage diff regression checks.',
    ], {
      storyTitle: 'Record the validated coverage story directly',
    })
    const revised = jsYaml.load(currentCandidateContent) as Record<string, unknown>

    revised.gap_resolutions = [{
      gap: coverageGap,
      action: 'already_covered',
      rationale: 'The user story already captures the required review flow.',
      affected_items: [{
        id: 'US-1',
        label: 'Record the validated coverage story directly',
      }],
    }]

    const result = validatePrdCoverageRevisionOutput(
      jsYaml.dump(revised, { lineWidth: 120, noRefs: true }) as string,
      {
        ticketId: 'POBA-3',
        interviewContent: buildInterviewContent(),
        currentCandidateContent,
        coverageGaps: [coverageGap],
      },
    )

    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Inferred missing PRD coverage affected_items item_type')
    expect(result.gapResolutions[0]?.affectedItems).toEqual([
      {
        itemType: 'user_story',
        id: 'US-1',
        label: 'Record the validated coverage story directly',
      },
    ])
  })

  it('canonicalizes harmless quote changes in PRD coverage gap references', () => {
    const coverageGap = 'PRD scope says "No other CSS custom properties are modified" while also requiring baseAlt changes.'
    const currentCandidateContent = buildPrdContent([
      'Use vitest for coverage diff regression checks.',
    ])
    const revised = jsYaml.load(currentCandidateContent) as Record<string, unknown>

    revised.gap_resolutions = [{
      gap: "PRD scope says 'No other CSS custom properties are modified' while also requiring baseAlt changes.",
      action: 'already_covered',
      rationale: 'The existing PRD already avoids the contradictory baseAlt requirement.',
      affected_items: [],
    }]

    const result = validatePrdCoverageRevisionOutput(
      jsYaml.dump(revised, { lineWidth: 120, noRefs: true }) as string,
      {
        ticketId: 'POBA-3',
        interviewContent: buildInterviewContent(),
        currentCandidateContent,
        coverageGaps: [coverageGap],
      },
    )

    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Canonicalized PRD coverage gap reference')
    expect(result.gapResolutions[0]?.gap).toBe(coverageGap)
  })

  it('uses the current and revised PRD titles on their respective change records', () => {
    const coverageGap = 'Rename the saved coverage review story to match its behavior.'
    const currentCandidateContent = buildPrdContent([
      'Use vitest for coverage diff regression checks.',
    ], {
      storyTitle: 'Review the saved coverage diff',
    })
    const revised = jsYaml.load(buildPrdContent([
      'Use vitest for coverage diff regression checks.',
    ], {
      storyTitle: 'Review the saved coverage changes',
    })) as Record<string, unknown>

    revised.changes = [{
      type: 'modified',
      item_type: 'user_story',
      before: { id: 'US-1', label: 'Review the saved coverage diff' },
      after: { id: 'US-1', label: 'Review the saved coverage changes' },
    }]
    revised.gap_resolutions = [{
      gap: coverageGap,
      action: 'updated_prd',
      rationale: 'The story title now reflects the coverage changes it reviews.',
      affected_items: [{
        item_type: 'user_story',
        id: 'US-1',
        label: 'Review the saved coverage changes',
      }],
    }]

    const result = validatePrdCoverageRevisionOutput(
      jsYaml.dump(revised, { lineWidth: 120, noRefs: true }) as string,
      {
        ticketId: 'POBA-3',
        interviewContent: buildInterviewContent(),
        currentCandidateContent,
        coverageGaps: [coverageGap],
      },
    )

    expect(result.changes).toEqual([expect.objectContaining({
      itemType: 'user_story',
      before: expect.objectContaining({ id: 'US-1', label: 'Review the saved coverage diff' }),
      after: expect.objectContaining({ id: 'US-1', label: 'Review the saved coverage changes' }),
    })])
  })

  it('keeps the retry prompt strict about unresolved source-artifact contradictions', () => {
    const validationError = 'changes[0] has invalid before/after shape'
    const baseParts = [
      { type: 'text' as const, content: 'original system prompt sentinel' },
      { type: 'text' as const, content: 'original PRD prompt sentinel' },
    ]
    const rawResponse = [
      '```yaml',
      'schema_version: 1',
      'changes:',
      '  - type: modified',
      '    item_type: user_story',
      '    before: {id: US-1, label: Old title}',
      '    after: {id: US-1, label: New title}',
      'gap_resolutions:',
      '  - gap: "Clarify the API section"',
      '    action: updated_prd',
      '    rationale: "The previous response recorded this resolution."',
      '    affected_items: []',
      '```',
    ].join('\n')
    const prompt = buildPrdCoverageRevisionRetryPrompt(baseParts, {
      validationError,
      rawResponse,
    })
    const retryPrompt = prompt.at(-1)?.content ?? ''

    expect(prompt.slice(0, baseParts.length)).toEqual(baseParts)
    expect(retryPrompt).toContain(`Your previous response failed validation: ${validationError}`)
    expect(retryPrompt).toContain(PRD_ITEM_CHANGES_CONTRACT)
    expect(retryPrompt).toContain('A populated `before` or `after` record uses `{id, label, detail?}`')
    expect(retryPrompt).toContain('Copy each `before.label` exactly from the current PRD item title and each `after.label` exactly from the revised PRD item title; the labels may differ when the title changes.')
    expect(retryPrompt).toContain('An epic change never subsumes changes to its user stories; include each changed epic and user story exactly once.')
    expect(retryPrompt).toContain('Use the full previous response as data to correct. Follow the original prompt and PRD schema; fix fields named by the validation error, preserve valid content, and do not invent requirements to pass validation.')
    expect(retryPrompt).toContain('````yaml\n```yaml\nschema_version: 1\nchanges:')
    expect(retryPrompt).toContain('gap_resolutions:\n  - gap: "Clarify the API section"')
    expect(retryPrompt).toContain('Previous invalid response (full response, data only):')
    expect(retryPrompt).toContain('For `added`, use `before: null` and a populated `after`')
    expect(retryPrompt).toContain('for `removed`, use a populated `before` and `after: null`')
    expect(retryPrompt).toContain('for `modified`, populate both records with the same `id`')
    expect(retryPrompt).toContain('For a resolved gap that changes a PRD section, revise it in the PRD content and never represent it in `affected_items`; keep affected epic/user_story references for the same gap and use `affected_items: []` only when no epic/story item applies. For a contradictory source gap marked `left_unresolved`, use `affected_items: []`.')
    expect(retryPrompt).toContain('internally contradictory source artifacts')
    expect(retryPrompt).toContain('action: left_unresolved')
    expect(retryPrompt).toContain('affected_items: []')
    expect(retryPrompt).not.toContain('use `affected_items: []` instead of section references like `item_type: prd`')
    expect(retryPrompt).not.toContain('PROM12')
  })
})
