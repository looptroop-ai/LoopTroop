import * as jsYaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { TEST, makeInterviewYaml, makeInterviewQuestion } from '../../../test/factories'
import {
  buildPrdRefinedArtifact,
  buildPrdRefinementRetryPrompt,
  parsePrdRefinedArtifact,
  requirePrdRefinedArtifact,
  validatePrdRefinementOutput,
} from '../refined'

function story(id: string, title: string, criteria: string | string[], steps: string | string[]) {
  return {
    id,
    title,
    acceptance_criteria: Array.isArray(criteria) ? criteria : [criteria],
    implementation_steps: Array.isArray(steps) ? steps : [steps],
    verification: { required_commands: ['npm run test'] },
  }
}

function buildPrdContent(options: {
  epicTitle?: string
  epicObjective?: string
  epicImplementationSteps?: string[]
  storyOneTitle?: string
  storyOneCriteria?: string[]
  storyOneSteps?: string[]
  includeStoryTwo?: boolean
  includeStoryThree?: boolean
  changes?: unknown[]
} = {}): string {
  const document: Record<string, unknown> = {
    schema_version: 1,
    ticket_id: TEST.externalId,
    artifact: 'prd',
    status: 'draft',
    source_interview: { content_sha256: 'stale-hash' },
    product: { problem_statement: 'Keep PRD refinement strict and restart-safe.', target_users: ['LoopTroop maintainers'] },
    scope: { in_scope: ['PRD refinement validation', 'artifact parsing'], out_of_scope: ['Execution pipeline changes'] },
    technical_requirements: {
      architecture_constraints: ['Preserve the winner-only refinement flow.'],
      data_model: [], api_contracts: [], security_constraints: [], performance_constraints: [],
      reliability_constraints: ['Validated artifacts must survive restarts.'],
      error_handling_rules: ['Retry once on structured-output failures.'],
      tooling_assumptions: [],
    },
    epics: [{
      id: 'EPIC-1',
      title: options.epicTitle ?? 'Prompt hardening',
      objective: options.epicObjective ?? 'Make PRD refinement exact and auditable.',
      implementation_steps: options.epicImplementationSteps ?? ['Compare the winner draft against the final refined PRD.'],
      user_stories: [
        story('US-1', options.storyOneTitle ?? 'Validate PRD refinement',
          options.storyOneCriteria ?? ['Every winner-to-final diff is represented exactly once.'],
          options.storyOneSteps ?? ['Validate change coverage before persisting the artifact.']),
        ...(options.includeStoryTwo === false ? [] : [
          story('US-2', 'Record change attribution',
            'Every adopted improvement records its source.',
            'Persist attribution status alongside each change.'),
        ]),
        ...(options.includeStoryThree ? [
          story('US-3', 'Surface retry metadata',
            'Structured retry metadata is preserved for review.',
            'Expose retry metadata in the final artifact.'),
        ] : []),
      ],
    }],
    risks: ['Loose parsing could hide real refinement mistakes.'],
    approval: { approved_by: '', approved_at: '' },
  }

  if (options.changes !== undefined) {
    document.changes = options.changes
  }

  return jsYaml.dump(document, { lineWidth: 120, noRefs: true }) as string
}

function buildValidRefinementOutput(options: { omitStoryItemType?: boolean } = {}): string {
  return buildPrdContent({
    epicTitle: 'Prompt hardening and refinement safety',
    storyOneTitle: 'Validate PRD refinement exactly',
    includeStoryTwo: false,
    includeStoryThree: true,
    changes: [
      { type: 'modified', item_type: 'epic', before: { id: 'EPIC-1', title: 'Prompt hardening' }, after: { id: 'EPIC-1', title: 'Prompt hardening and refinement safety' }, inspiration: null },
      { type: 'modified', ...(options.omitStoryItemType ? {} : { item_type: 'user_story' }), before: { id: 'US-1', title: 'Validate PRD refinement' }, after: { id: 'US-1', title: 'Validate PRD refinement exactly' }, inspiration: null },
      { type: 'removed', item_type: 'user_story', before: { id: 'US-2', title: 'Record change attribution' }, after: null, inspiration: null },
      { type: 'added', item_type: 'user_story', before: null, after: { id: 'US-3', title: 'Surface retry metadata' }, inspiration: { alternative_draft: 1, item: { id: 'US-8', title: 'Expose retry telemetry' } } },
    ],
  })
}

const interviewContent = makeInterviewYaml({
  ticket_id: TEST.externalId,
  questions: [makeInterviewQuestion({
    prompt: 'Which prompt hardening rules are required?',
    answer: {
      skipped: false,
      selected_option_ids: [],
      free_text: 'Require strict output validation and exact retry handling.',
      answered_by: 'user',
      answered_at: TEST.timestamp, skip_reason: null,
    },
  })],
  summary: {
    goals: ['Harden REFINING_PRD'],
    constraints: ['Preserve winner-only refinement'],
    non_goals: ['Change execution'],
    final_free_form_answer: '',
  },
  approval: { approved_by: 'user', approved_at: TEST.timestamp },
})

function validationContext(overrides: Record<string, unknown> = {}) {
  return { ticketId: TEST.externalId, interviewContent, winnerDraftContent: buildPrdContent(), ...overrides }
}

describe.concurrent('PRD refined artifacts', () => {
  it('keeps the retry prompt explicit about non-empty epic user_stories', () => {
    const retryPrompt = buildPrdRefinementRetryPrompt([], {
      validationError: 'Epic at index 1 is missing user stories',
      rawResponse: 'schema_version: 1\nartifact: prd\n',
    })

    expect(retryPrompt[0]?.type).toBe('text')
    expect(retryPrompt[0]?.content).toContain('Every epic must include at least one fully populated `user_stories` entry')
  })

  it('validates a refined PRD only when changes fully and exactly cover the winner-to-final diff', () => {
    const result = validatePrdRefinementOutput(buildValidRefinementOutput(), {
      ...validationContext(),
      losingDraftMeta: [{ memberId: 'openai/gpt-5-mini' }],
    })

    expect(result.metrics).toEqual({ epicCount: 1, userStoryCount: 2 })
    expect(result.changes).toHaveLength(4)
    expect(result.changes.map((change) => change.type)).toEqual(['modified', 'modified', 'removed', 'added'])
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toContain('Canonicalized source_interview.content_sha256 from the approved Interview Results artifact.')
    expect(result.refinedContent).not.toContain('changes:')
  })

  it('validates refined PRDs that need both colon repair and reserved-indicator scalar quoting', () => {
    const rawRefinement = buildValidRefinementOutput()
      .replace('  data_model: []', [
        '  data_model:',
        '    - `UIState.theme` allows `pink` as a valid value.',
      ].join('\n'))
      .replace(
        '    - Retry once on structured-output failures.',
        "    - Persist `theme: 'pink'` exactly as entered when retrying.",
      )

    const result = validatePrdRefinementOutput(rawRefinement, validationContext({
      losingDraftMeta: [{ memberId: 'openai/gpt-5-mini' }],
    }))

    expect(result.document.technical_requirements.data_model).toEqual([
      '`UIState.theme` allows `pink` as a valid value.',
    ])
    expect(result.document.technical_requirements.error_handling_rules).toEqual([
      "Persist `theme: 'pink'` exactly as entered when retrying.",
    ])
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('reserved indicator characters')
  })

  it('drops no-op modified changes before validating diff coverage', () => {
    const unchangedContent = buildPrdContent({
      changes: [{
        type: 'modified', item_type: 'user_story',
        before: { id: 'US-1', title: 'Validate PRD refinement' },
        after: { id: 'US-1', title: 'Validate PRD refinement' },
        inspiration: null,
      }],
    })

    const result = validatePrdRefinementOutput(unchangedContent, validationContext())

    expect(result.changes).toEqual([])
    expect(result.repairWarnings.join('\n')).toContain('Dropped no-op PRD refinement modified change')
  })

  it('keeps modified epic changes when the epic title stays the same but the body changed', () => {
    const result = validatePrdRefinementOutput(buildPrdContent({
      epicObjective: 'Make PRD refinement exact, auditable, and restart-safe.',
      changes: [{
        type: 'modified', item_type: 'epic',
        before: { id: 'EPIC-1', title: 'Prompt hardening' },
        after: { id: 'EPIC-1', title: 'Prompt hardening' },
        inspiration: null,
      }],
    }), validationContext())

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({
      type: 'modified',
      before: { id: 'EPIC-1', label: 'Prompt hardening' },
      after: { id: 'EPIC-1', label: 'Prompt hardening' },
    })
    expect(result.repairWarnings.join('\n')).not.toContain('Dropped no-op PRD refinement modified change')
  })

  it('keeps modified user story changes when only later story content changed', () => {
    const winnerDraftContent = buildPrdContent({
      storyOneCriteria: [
        'Every winner-to-final diff is represented exactly once.',
        'Persist only canonical changes.',
      ],
      storyOneSteps: [
        'Validate change coverage before persisting the artifact.',
        'Store validated changes alongside the artifact.',
      ],
    })

    const result = validatePrdRefinementOutput(buildPrdContent({
      storyOneCriteria: [
        'Every winner-to-final diff is represented exactly once.',
        'Surface later acceptance criteria changes as real diffs.',
      ],
      storyOneSteps: [
        'Validate change coverage before persisting the artifact.',
        'Store full story-body differences as real changes.',
      ],
      changes: [{
        type: 'modified', item_type: 'user_story',
        before: { id: 'US-1', title: 'Validate PRD refinement' },
        after: { id: 'US-1', title: 'Validate PRD refinement' },
        inspiration: null,
      }],
    }), validationContext({ winnerDraftContent }))

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({
      type: 'modified',
      before: { id: 'US-1', label: 'Validate PRD refinement' },
      after: { id: 'US-1', label: 'Validate PRD refinement' },
    })
    expect(result.repairWarnings.join('\n')).not.toContain('Dropped no-op PRD refinement modified change')
  })

  it('rejects changes that reference items outside the winning draft', () => {
    const invalidOutput = buildPrdContent({
      changes: [{
        type: 'removed', item_type: 'user_story',
        before: { id: 'US-99', title: 'Ghost story' }, after: null, inspiration: null,
      }],
    })

    expect(() => validatePrdRefinementOutput(invalidOutput, validationContext()))
      .toThrow('does not match any item from the winning draft')
  })

  it('rejects duplicate before or after reuse across changes', () => {
    const duplicateReuseOutput = buildPrdContent({
      storyOneTitle: 'Validate PRD refinement exactly',
      changes: [
        { type: 'modified', item_type: 'user_story', before: { id: 'US-1', title: 'Validate PRD refinement' }, after: { id: 'US-1', title: 'Validate PRD refinement exactly' }, inspiration: null },
        { type: 'removed', item_type: 'user_story', before: { id: 'US-1', title: 'Validate PRD refinement' }, after: null, inspiration: null },
      ],
    })

    expect(() => validatePrdRefinementOutput(duplicateReuseOutput, validationContext()))
      .toThrow('reuses a winning-draft item already referenced by another change')
  })

  it('restores stable IDs when one explicit addition reused a surviving story ID and shifted that survivor', () => {
    const winnerDraftContent = buildPrdContent({ includeStoryTwo: false })
    const parsed = jsYaml.load(buildPrdContent({ includeStoryTwo: false })) as {
      epics: Array<{ user_stories: Array<ReturnType<typeof story>> }>
      changes?: unknown[]
    }
    const firstEpic = parsed.epics[0]!
    const existingStory = firstEpic.user_stories[0]!
    firstEpic.user_stories = [
      {
        ...existingStory,
        id: 'US-3',
        title: 'Validate PRD refinement exactly',
      },
      story(
        'US-1',
        'Add parser diagnostics',
        'Every safe parser repair is visible.',
        'Record an exact non-inventive repair warning.',
      ),
    ]
    parsed.changes = [
      {
        type: 'modified',
        item_type: 'user_story',
        before: { id: 'US-1', title: 'Validate PRD refinement' },
        after: { id: 'US-3', title: 'Validate PRD refinement exactly' },
        inspiration: null,
      },
      {
        type: 'added',
        item_type: 'user_story',
        before: null,
        after: { id: 'US-1', title: 'Add parser diagnostics' },
        inspiration: null,
      },
    ]

    const result = validatePrdRefinementOutput(
      jsYaml.dump(parsed, { lineWidth: 120, noRefs: true }),
      validationContext({ winnerDraftContent }),
    )

    expect(result.document.epics[0]?.user_stories.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: 'US-1', title: 'Validate PRD refinement exactly' },
      { id: 'US-3', title: 'Add parser diagnostics' },
    ])
    expect(result.changes).toEqual([
      expect.objectContaining({
        type: 'modified',
        before: expect.objectContaining({ id: 'US-1' }),
        after: expect.objectContaining({ id: 'US-1' }),
      }),
      expect.objectContaining({
        type: 'added',
        before: null,
        after: expect.objectContaining({ id: 'US-3' }),
      }),
    ])
    expect(result.refinedContent).toContain('id: US-1')
    expect(result.repairWarnings).toContain(
      'Restored PRD refinement ID stability at change index 0: reassigned surviving user_story "Validate PRD refinement exactly" from US-3 to US-1 and reassigned newly added user_story "Add parser diagnostics" from US-1 to US-3.',
    )
  })

  it('rejects shifted-ID repairs when other changes make the mapping ambiguous', () => {
    const winnerDraftContent = buildPrdContent({ includeStoryTwo: false })
    const parsed = jsYaml.load(buildPrdContent({ includeStoryTwo: false })) as {
      epics: Array<{ user_stories: Array<ReturnType<typeof story>> }>
      changes?: unknown[]
    }
    const firstEpic = parsed.epics[0]!
    const existingStory = firstEpic.user_stories[0]!
    firstEpic.user_stories = [
      { ...existingStory, id: 'US-3', title: 'Validate PRD refinement exactly' },
      story('US-1', 'Add parser diagnostics', 'Repairs are visible.', 'Record repair warnings.'),
    ]
    parsed.changes = [
      {
        type: 'modified',
        item_type: 'user_story',
        before: { id: 'US-1', title: 'Validate PRD refinement' },
        after: { id: 'US-3', title: 'Validate PRD refinement exactly' },
        inspiration: null,
      },
      {
        type: 'added',
        item_type: 'user_story',
        before: null,
        after: { id: 'US-1', title: 'Add parser diagnostics' },
        inspiration: null,
      },
      {
        type: 'removed',
        item_type: 'user_story',
        before: { id: 'US-1', title: 'Validate PRD refinement' },
        after: null,
        inspiration: null,
      },
    ]

    expect(() => validatePrdRefinementOutput(
      jsYaml.dump(parsed, { lineWidth: 120, noRefs: true }),
      validationContext({ winnerDraftContent }),
    )).toThrow('with type modified must preserve the same id')
  })

  it('collapses duplicate modified changes for the same PRD item instead of failing', () => {
    const winnerDraftContent = buildPrdContent({ includeStoryTwo: false })
    const result = validatePrdRefinementOutput(buildPrdContent({
      storyOneTitle: 'Validate PRD refinement exactly',
      includeStoryTwo: false,
      changes: [
        {
          type: 'modified',
          item_type: 'user_story',
          before: { id: 'US-1', title: 'Validate PRD refinement' },
          after: { id: 'US-1', title: 'Validate PRD refinement exactly' },
          inspiration: null,
        },
        {
          type: 'modified',
          item_type: 'user_story',
          before: { id: 'US-1', title: 'Validate PRD refinement' },
          after: { id: 'US-1', title: 'Validate PRD refinement exactly' },
          inspiration: null,
        },
      ],
    }), validationContext({ winnerDraftContent }))

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({
      type: 'modified',
      itemType: 'user_story',
      before: expect.objectContaining({ id: 'US-1', label: 'Validate PRD refinement' }),
      after: expect.objectContaining({ id: 'US-1', label: 'Validate PRD refinement exactly' }),
      inspiration: null,
      attributionStatus: 'model_unattributed',
    })
    expect(result.repairWarnings.join('\n')).toContain('Collapsed duplicate PRD refinement modified change')
  })

  it('downgrades conflicting duplicate inspirations to model_unattributed', () => {
    const winnerDraftContent = buildPrdContent({ includeStoryTwo: false })
    const result = validatePrdRefinementOutput(buildPrdContent({
      storyOneTitle: 'Validate PRD refinement exactly',
      includeStoryTwo: false,
      changes: [
        {
          type: 'modified',
          item_type: 'user_story',
          before: { id: 'US-1', title: 'Validate PRD refinement' },
          after: { id: 'US-1', title: 'Validate PRD refinement exactly' },
          inspiration: { alternative_draft: 1, item: { id: 'US-8', title: 'Expose retry telemetry' } },
        },
        {
          type: 'modified',
          item_type: 'user_story',
          before: { id: 'US-1', title: 'Validate PRD refinement' },
          after: { id: 'US-1', title: 'Validate PRD refinement exactly' },
          inspiration: { alternative_draft: 2, item: { id: 'US-9', title: 'Tighten refinement accounting' } },
        },
      ],
    }), {
      ...validationContext({ winnerDraftContent }),
      losingDraftMeta: [
        { memberId: 'openai/gpt-5-mini' },
        { memberId: 'anthropic/claude-sonnet-4' },
      ],
    })

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({
      inspiration: null,
      attributionStatus: 'model_unattributed',
    })
    expect(result.repairWarnings.join('\n')).toContain('Collapsed duplicate PRD refinement modified change')
  })

  it('synthesizes omitted same-identity user story modifications', () => {
    const winnerDraftContent = buildPrdContent({ includeStoryTwo: false })
    const result = validatePrdRefinementOutput(buildPrdContent({
      epicTitle: 'Prompt hardening and refinement safety',
      storyOneSteps: [
        'Validate change coverage before persisting the artifact.',
        'Repair omitted same-ID story changes before accepting the PRD.',
      ],
      includeStoryTwo: false,
      changes: [{
        type: 'modified',
        item_type: 'epic',
        before: { id: 'EPIC-1', title: 'Prompt hardening' },
        after: { id: 'EPIC-1', title: 'Prompt hardening and refinement safety' },
        inspiration: null,
      }],
    }), validationContext({ winnerDraftContent }))

    expect(result.changes).toHaveLength(2)
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'modified',
        itemType: 'user_story',
        before: expect.objectContaining({ id: 'US-1', label: 'Validate PRD refinement' }),
        after: expect.objectContaining({ id: 'US-1', label: 'Validate PRD refinement' }),
        inspiration: null,
        attributionStatus: 'synthesized_unattributed',
      }),
    ]))
    expect(result.repairWarnings.join('\n')).toContain('Synthesized omitted PRD refinement modified change for user_story US-1')
  })

  it('synthesizes omitted same-identity epic and user story modifications when unclaimed', () => {
    const result = validatePrdRefinementOutput(buildPrdContent({
      epicObjective: 'Make PRD refinement exact, auditable, and approval-safe.',
      storyOneSteps: [
        'Validate change coverage before persisting the artifact.',
        'Repair exact same-ID omissions before persisting the artifact.',
      ],
      includeStoryTwo: false,
      changes: [{
        type: 'removed',
        item_type: 'user_story',
        before: { id: 'US-2', title: 'Record change attribution' },
        after: null,
        inspiration: null,
      }],
    }), validationContext())

    expect(result.changes).toHaveLength(3)
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'removed',
        itemType: 'user_story',
        before: expect.objectContaining({ id: 'US-2', label: 'Record change attribution' }),
        after: null,
      }),
      expect.objectContaining({
        type: 'modified',
        itemType: 'epic',
        inspiration: null,
        attributionStatus: 'synthesized_unattributed',
      }),
      expect.objectContaining({
        type: 'modified',
        itemType: 'user_story',
        inspiration: null,
        attributionStatus: 'synthesized_unattributed',
      }),
    ]))
    expect(result.repairWarnings.join('\n')).toContain('Synthesized omitted PRD refinement modified change for epic EPIC-1')
    expect(result.repairWarnings.join('\n')).toContain('Synthesized omitted PRD refinement modified change for user_story US-1')
  })

  it('still rejects ambiguous item_type repairs when no unique candidate exists', () => {
    const winnerDocument = jsYaml.dump({
      schema_version: 1,
      ticket_id: TEST.externalId,
      artifact: 'prd',
      status: 'draft',
      source_interview: { content_sha256: 'stale-hash' },
      product: { problem_statement: 'Keep PRD refinement strict and restart-safe.', target_users: ['LoopTroop maintainers'] },
      scope: { in_scope: ['PRD refinement validation'], out_of_scope: ['Execution pipeline changes'] },
      technical_requirements: {
        architecture_constraints: ['Preserve the winner-only refinement flow.'],
        data_model: [], api_contracts: [], security_constraints: [], performance_constraints: [],
        reliability_constraints: ['Validated artifacts must survive restarts.'],
        error_handling_rules: ['Retry once on structured-output failures.'],
        tooling_assumptions: [],
      },
      epics: [{
        id: 'ITEM-1',
        title: 'Shared item',
        objective: 'Track ambiguous PRD item IDs safely.',
        implementation_steps: ['Inspect the winning draft first.'],
        user_stories: [{
          id: 'ITEM-1',
          title: 'Shared item',
          acceptance_criteria: ['Ambiguous item_type repairs must fail.'],
          implementation_steps: ['Require a unique repair candidate before inferring item_type.'],
          verification: { required_commands: ['npm run test'] },
        }],
      }],
      risks: ['Ambiguous IDs could hide invalid changes.'],
      approval: { approved_by: '', approved_at: '' },
    }, { lineWidth: 120, noRefs: true }) as string

    const ambiguousOutput = jsYaml.dump({
      schema_version: 1,
      ticket_id: TEST.externalId,
      artifact: 'prd',
      status: 'draft',
      source_interview: { content_sha256: 'stale-hash' },
      product: { problem_statement: 'Keep PRD refinement strict and restart-safe.', target_users: ['LoopTroop maintainers'] },
      scope: { in_scope: ['PRD refinement validation'], out_of_scope: ['Execution pipeline changes'] },
      technical_requirements: {
        architecture_constraints: ['Preserve the winner-only refinement flow.'],
        data_model: [], api_contracts: [], security_constraints: [], performance_constraints: [],
        reliability_constraints: ['Validated artifacts must survive restarts.'],
        error_handling_rules: ['Retry once on structured-output failures.'],
        tooling_assumptions: [],
      },
      epics: [{
        id: 'ITEM-1',
        title: 'Shared item v2',
        objective: 'Track ambiguous PRD item IDs safely.',
        implementation_steps: ['Inspect the winning draft first.'],
        user_stories: [{
          id: 'ITEM-1',
          title: 'Shared item',
          acceptance_criteria: ['Ambiguous item_type repairs must fail.'],
          implementation_steps: ['Require a unique repair candidate before inferring item_type.'],
          verification: { required_commands: ['npm run test'] },
        }],
      }],
      risks: ['Ambiguous IDs could hide invalid changes.'],
      approval: { approved_by: '', approved_at: '' },
      changes: [{
        type: 'modified',
        before: { id: 'ITEM-1', title: 'Shared item' },
        after: { id: 'ITEM-1', title: 'Shared item v2' },
        inspiration: null,
      }],
    }, { lineWidth: 120, noRefs: true }) as string

    expect(() => validatePrdRefinementOutput(ambiguousOutput, validationContext({ winnerDraftContent: winnerDocument })))
      .toThrow('is missing item_type and no unique repair candidate was found')
  })

  it('still rejects missing add/remove coverage that cannot be synthesized safely', () => {
    const incompleteCoverageOutput = buildPrdContent({
      storyOneTitle: 'Validate PRD refinement exactly',
      includeStoryTwo: false,
      changes: [{
        type: 'modified',
        item_type: 'user_story',
        before: { id: 'US-1', title: 'Validate PRD refinement' },
        after: { id: 'US-1', title: 'Validate PRD refinement exactly' },
        inspiration: null,
      }],
    })

    expect(() => validatePrdRefinementOutput(incompleteCoverageOutput, validationContext()))
      .toThrow('PRD refinement changes do not fully and exactly account for the diff between the winning draft and the final output.')
  })

  it('downgrades malformed inspiration to invalid_unattributed', () => {
    const result = validatePrdRefinementOutput(buildPrdContent({
      includeStoryThree: true,
      changes: [{
        type: 'added', item_type: 'user_story', before: null,
        after: { id: 'US-3', title: 'Surface retry metadata' },
        inspiration: { alternative_draft: 'oops', item: { id: 'US-8', title: 'Expose retry telemetry' } },
      }],
    }), {
      ...validationContext(),
      losingDraftMeta: [{ memberId: 'openai/gpt-5-mini' }],
    })

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({
      inspiration: null,
      attributionStatus: 'invalid_unattributed',
    })
  })

  it('accepts labeled alternative-draft inspiration references', () => {
    const result = validatePrdRefinementOutput(buildPrdContent({
      includeStoryThree: true,
      changes: [{
        type: 'added', item_type: 'user_story', before: null,
        after: { id: 'US-3', title: 'Surface retry metadata' },
        inspiration: { alternative_draft: 'Alternative Draft 1', item: { id: 'US-8', title: 'Expose retry telemetry' } },
      }],
    }), {
      ...validationContext({ winnerDraftContent: buildPrdContent({ includeStoryThree: false }) }),
      losingDraftMeta: [{ memberId: 'openai/gpt-5-mini' }],
    })

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({
      inspiration: {
        draftIndex: 0,
        memberId: 'openai/gpt-5-mini',
        item: {
          id: 'US-8',
          label: 'Expose retry telemetry',
        },
      },
      attributionStatus: 'inspired',
    })
  })

  it('defaults uninspired edits to model_unattributed', () => {
    const result = validatePrdRefinementOutput(buildPrdContent({
      storyOneTitle: 'Validate PRD refinement exactly',
      includeStoryTwo: false,
      changes: [{
        type: 'modified', item_type: 'user_story',
        before: { id: 'US-1', title: 'Validate PRD refinement' },
        after: { id: 'US-1', title: 'Validate PRD refinement exactly' },
      }],
    }), validationContext({ winnerDraftContent: buildPrdContent({ includeStoryTwo: false }) }))

    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({
      inspiration: null,
      attributionStatus: 'model_unattributed',
    })
  })

  it('round-trips parsed refined PRD artifacts and rejects missing persisted artifacts', () => {
    const refinement = validatePrdRefinementOutput(buildValidRefinementOutput(), {
      ...validationContext(),
      losingDraftMeta: [{ memberId: 'openai/gpt-5-mini' }],
    })

    const artifact = buildPrdRefinedArtifact(
      'openai/gpt-5',
      refinement.winnerDraftContent,
      refinement,
      {
        repairApplied: refinement.repairApplied,
        repairWarnings: refinement.repairWarnings,
        autoRetryCount: 1,
        validationError: 'PRD refinement output is missing changes',
      },
    )
    const parsed = parsePrdRefinedArtifact(JSON.stringify(artifact))

    expect(parsed.winnerId).toBe('openai/gpt-5')
    expect(parsed.draftMetrics).toEqual({ epicCount: 1, userStoryCount: 2 })
    expect(parsed.changes).toEqual([])
    expect(JSON.stringify(artifact)).not.toContain('"changes"')
    expect(parsed.winnerDraftContent).toContain('title: Prompt hardening')
    expect(parsed.structuredOutput).toMatchObject({
      autoRetryCount: 1,
      validationError: 'PRD refinement output is missing changes',
    })
    expect(() => requirePrdRefinedArtifact(undefined)).toThrow('No validated refined PRD found')
  })
})
