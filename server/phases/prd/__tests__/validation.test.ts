import { describe, expect, it } from 'vitest'
import { TEST, makeInterviewYaml, makeInterviewQuestion } from '../../../test/factories'
import { validatePrdDraft, validateResolvedInterview } from '../validation'

const skippedInterviewYaml = makeInterviewYaml({
  ticket_id: TEST.externalId,
  questions: [
    makeInterviewQuestion({
      id: 'Q01',
      prompt: 'Which workflow guardrails are mandatory?',
    }),
    makeInterviewQuestion({
      id: 'Q02',
      phase: 'Structure',
      prompt: 'Which downstream phases are out of scope for this pass?',
      answer: {
        skipped: false, selected_option_ids: [], free_text: 'PRD approval and coverage stay out of scope.',
        answered_by: 'user', answered_at: TEST.timestamp, skip_reason: null,
      },
    }),
  ],
})

const structuredInterviewYaml = makeInterviewYaml({
  ticket_id: TEST.externalId,
  questions: [
    makeInterviewQuestion({
      id: 'Q01',
      prompt: 'Which workflow guardrails are mandatory?',
      answer: {
        skipped: false, selected_option_ids: [], free_text: 'Keep the council flow intact.',
        answered_by: 'user', answered_at: TEST.timestamp, skip_reason: null,
      },
    }),
    makeInterviewQuestion({
      id: 'Q02',
      phase: 'Structure',
      prompt: 'Which sharding mode should be the default?',
      answer_type: 'single_choice',
      options: [
        { id: 'opt1', label: 'Always sharded' },
        { id: 'opt2', label: 'Automatic detection' },
        { id: 'opt3', label: 'Manual flag only' },
      ],
    }),
    makeInterviewQuestion({
      id: 'Q03',
      phase: 'Assembly',
      prompt: 'Who is affected by sharding?',
      answer_type: 'multiple_choice',
      options: [
        { id: 'opt1', label: 'Operators running the pipeline' },
        { id: 'opt2', label: 'Council models' },
        { id: 'opt3', label: 'Downstream consumers of issues.jsonl' },
      ],
    }),
  ],
})

describe.concurrent('validatePrdDraft', () => {
  it('accepts wrapped PRD YAML, repairs ids deterministically, and returns stable metrics', () => {
    const interviewContent = skippedInterviewYaml

    const result = validatePrdDraft([
      '[MODEL] Here is the draft you asked for.',
      '```yaml',
      'schema_version: 1',
      'ticket_id: WRONG-ID',
      'artifact: prd',
      'status: needs_review',
      'source_interview:',
      '  content_sha256: stale',
      'product:',
      '  problem_statement: Keep PRD drafting resilient.',
      '  target_users: [LoopTroop maintainers]',
      'scope:',
      '  in_scope: [Normalize council PRD drafts]',
      '  out_of_scope: [PRD approval workflow]',
      'technical_requirements:',
      '  architecture_constraints: [Reuse council retry behavior]',
      '  data_model: []',
      '  api_contracts: []',
      '  security_constraints: []',
      '  performance_constraints: []',
      '  reliability_constraints: [Fail fast without canonical interview]',
      '  error_handling_rules: [Persist only normalized YAML]',
      '  tooling_assumptions: [Vitest remains the test runner]',
      'epics:',
      '  - title: Draft parsing parity',
      '    objective: Match interview council draft rigor.',
      '    implementation_steps: [Normalize PRD drafts before persistence]',
      '    user_stories:',
      '      - title: Repair ids deterministically',
      '        acceptance_criteria: [Missing ids are repaired deterministically]',
      '        implementation_steps: [Fill stable fallback ids]',
      '        verification:',
      '          required_commands: [npm run test:server]',
      '  - id: EPIC-1',
      '    title: UI detail parity',
      '    objective: Show PRD metrics instead of question counts.',
      '    implementation_steps: [Surface epic and story totals]',
      '    user_stories:',
      '      - id: US-1-1',
      '        title: Show PRD-specific chip detail',
      '        acceptance_criteria: [Chips show PRD metrics]',
      '        implementation_steps: [Read draftMetrics from persisted artifacts]',
      '        verification:',
      '          required_commands: [npm run test:client]',
      'risks: [Older artifacts may need regeneration]',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
      '```',
      '[SYS] Step finished: stop',
    ].join('\n'), {
      ticketId: TEST.externalId,
      interviewContent,
    })

    expect(result.metrics).toEqual({
      epicCount: 2,
      userStoryCount: 2,
    })
    expect(result.document.ticket_id).toBe(TEST.externalId)
    expect(result.document.status).toBe('draft')
    expect(result.document.epics.map((epic) => epic.id)).toEqual(['EPIC-1', 'EPIC-2'])
    expect(result.document.epics.flatMap((epic) => epic.user_stories.map((story) => story.id))).toEqual(['US-1-1', 'US-2-1'])
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Epic at index 0 was missing id')
    expect(result.repairWarnings.join('\n')).toContain('Renumbered duplicate epic id EPIC-1 to EPIC-2')
    expect(result.normalizedContent).not.toContain('interview_gap_resolutions:')
    expect(result.normalizedContent).toContain('id: EPIC-2')
    expect(result.normalizedContent).toContain('id: US-2-1')
  })

  it('repairs colon-bearing list item scalars in PRD drafts', () => {
    const interviewContent = skippedInterviewYaml

    const result = validatePrdDraft([
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: prd',
      'status: draft',
      'source_interview:',
      '  content_sha256: stale',
      'product:',
      '  problem_statement: Keep PRD drafting resilient.',
      '  target_users: [LoopTroop maintainers]',
      'scope:',
      '  in_scope: [Normalize council PRD drafts]',
      '  out_of_scope: [PRD approval workflow]',
      'technical_requirements:',
      '  architecture_constraints:',
      '    - Must preserve deterministic workflow transitions and backward compatibility for all tickets in progress',
      '    - Persisted strategy artifact path: `.looptroop/tickets/<ticket-id>/test-strategy.yaml`',
      '    - Schema must support inheritance: epic-level properties with story-level overrides',
      '  data_model: []',
      '  api_contracts: []',
      '  security_constraints: []',
      '  performance_constraints: []',
      '  reliability_constraints: []',
      '  error_handling_rules: []',
      '  tooling_assumptions: []',
      'epics:',
      '  - id: EPIC-1',
      '    title: Draft parsing parity',
      '    objective: Match interview council draft rigor.',
      '    implementation_steps: [Normalize PRD drafts before persistence]',
      '    user_stories:',
      '      - id: US-1-1',
      '        title: Repair ids deterministically',
      '        acceptance_criteria: [Missing ids are repaired deterministically]',
      '        implementation_steps: [Fill stable fallback ids]',
      '        verification:',
      '          required_commands: [npm run test:server]',
      'risks: []',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n'), {
      ticketId: TEST.externalId,
      interviewContent,
    })

    expect(result.document.technical_requirements.architecture_constraints[1]).toBe('Persisted strategy artifact path: `.looptroop/tickets/<ticket-id>/test-strategy.yaml`')
    expect(result.document.technical_requirements.architecture_constraints[2]).toBe('Schema must support inheritance: epic-level properties with story-level overrides')
  })

  it('normalizes a resolved interview against the approved interview artifact', () => {
    const canonicalInterviewContent = skippedInterviewYaml

    const result = validateResolvedInterview([
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: interview',
      'status: approved',
      'generated_by:',
      '  winner_model: wrong-model',
      '  generated_at: 2026-03-23T09:10:00.000Z',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Which workflow guardrails are mandatory?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Preserve council retries and strict normalization.',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:11:00.000Z',
      '  - id: Q02',
      '    phase: Structure',
      '    prompt: Which downstream phases are out of scope for this pass?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: PRD approval and coverage stay out of scope.',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:04:00.000Z',
      'follow_up_rounds: []',
      'summary:',
      '  goals: [Harden DRAFTING_PRD]',
      '  constraints: [Preserve council mechanics]',
      '  non_goals: [Touch PRD approval]',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: user',
      '  approved_at: 2026-03-23T09:12:00.000Z',
    ].join('\n'), {
      ticketId: TEST.externalId,
      canonicalInterviewContent,
      memberId: 'openai/gpt-5',
    })

    expect(result.questionCount).toBe(2)
    expect(result.document.status).toBe('draft')
    expect(result.document.questions[0]?.answer.answered_by).toBe('ai_skip')
    expect(result.document.questions[1]?.answer.free_text).toBe('PRD approval and coverage stay out of scope.')
    expect(result.document.approval).toEqual({ approved_by: '', approved_at: '' })
    expect(result.repairWarnings.join('\n')).toContain('Canonicalized answered_by to ai_skip')
    expect(result.repairWarnings.join('\n')).toContain('Cleared approval fields')
  })

  it('repairs malformed free_text scalars before normalizing a resolved interview', () => {
    const canonicalInterviewContent = skippedInterviewYaml

    const result = validateResolvedInterview([
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: interview',
      'status: approved',
      'generated_by:',
      '  winner_model: wrong-model',
      '  generated_at: 2026-03-23T09:10:00.000Z',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Which workflow guardrails are mandatory?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: `language` comes from the file extension',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:11:00.000Z',
      '  - id: Q02',
      '    phase: Structure',
      '    prompt: Which downstream phases are out of scope for this pass?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: PRD approval and coverage stay out of scope.',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:04:00.000Z',
      'follow_up_rounds: []',
      'summary:',
      '  goals: [Harden DRAFTING_PRD]',
      '  constraints: [Preserve council mechanics]',
      '  non_goals: [Touch PRD approval]',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: user',
      '  approved_at: 2026-03-23T09:12:00.000Z',
    ].join('\n'), {
      ticketId: TEST.externalId,
      canonicalInterviewContent,
      memberId: 'openai/gpt-5',
    })

    expect(result.document.questions[0]?.answer.free_text).toBe('`language` comes from the file extension')
    expect(result.document.questions[0]?.answer.answered_by).toBe('ai_skip')
    expect(result.repairWarnings.join('\n')).toContain('Canonicalized generated_by.winner_model')
  })

  it('repairs malformed multiline single-quoted free_text before normalizing a resolved interview', () => {
    const canonicalInterviewContent = skippedInterviewYaml

    const result = validateResolvedInterview([
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: openai/gpt-5',
      '  generated_at: 2026-03-23T09:10:00.000Z',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Which workflow guardrails are mandatory?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      "      free_text: 'No human approval checkpoint. Strategy generation and validation should",
      '        happen automatically between PRD approval and bead drafting. This follows the',
      '        user\'s non-goal of "Add human approval step" and keeps the phase deterministic.\'',
      '      answered_by: ai_skip',
      '      answered_at: 2026-03-23T09:11:00.000Z',
      '  - id: Q02',
      '    phase: Structure',
      '    prompt: Which downstream phases are out of scope for this pass?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: PRD approval and coverage stay out of scope.',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:04:00.000Z',
      'follow_up_rounds: []',
      'summary:',
      '  goals: [Changed summary that should be ignored]',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: changed',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n'), {
      ticketId: TEST.externalId,
      canonicalInterviewContent,
      memberId: 'openai/gpt-5',
    })

    expect(result.document.questions[0]?.answer.free_text).toContain('No human approval checkpoint.')
    expect(result.document.questions[0]?.answer.free_text).toContain('user\'s non-goal of "Add human approval step"')
  })

  it('reports exact missing and unexpected ids when a resolved interview omits canonical questions', () => {
    const canonicalInterviewContent = skippedInterviewYaml

    expect(() => validateResolvedInterview([
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: openai/gpt-5',
      '  generated_at: 2026-03-23T09:10:00.000Z',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Which workflow guardrails are mandatory?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Preserve council retries and strict normalization.',
      '      answered_by: ai_skip',
      '      answered_at: 2026-03-23T09:11:00.000Z',
      '  - id: Q99',
      '    phase: Structure',
      '    prompt: Which unexpected question slipped in?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: This should not be accepted.',
      '      answered_by: ai_skip',
      '      answered_at: 2026-03-23T09:12:00.000Z',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n'), {
      ticketId: TEST.externalId,
      canonicalInterviewContent,
      memberId: 'openai/gpt-5',
    })).toThrowError(
      /Resolved interview must preserve canonical question ids \(missing canonical ids: Q02; unexpected ids: Q99\)/,
    )
  })

  it('keeps omitted skipped canonical questions invalid', () => {
    const canonicalInterviewContent = skippedInterviewYaml

    expect(() => validateResolvedInterview([
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: openai/gpt-5',
      '  generated_at: 2026-03-23T09:10:00.000Z',
      'questions:',
      '  - id: Q02',
      '    phase: Structure',
      '    prompt: Which downstream phases are out of scope for this pass?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: PRD approval and coverage stay out of scope.',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:04:00.000Z',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n'), {
      ticketId: TEST.externalId,
      canonicalInterviewContent,
      memberId: 'openai/gpt-5',
    })).toThrowError(
      /Resolved interview must preserve all 2 canonical questions \(missing canonical ids: Q01\)/,
    )
  })

  it('restores canonical metadata, question order, and answered user questions instead of failing', () => {
    const canonicalInterviewContent = skippedInterviewYaml

    const result = validateResolvedInterview([
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: openai/gpt-5',
      '  generated_at: 2026-03-23T09:10:00.000Z',
      'questions:',
      '  - id: Q02',
      '    phase: Structure',
      '    prompt: Which downstream phases are out of scope for this pass?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Changed answer',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:04:00.000Z',
      '  - id: Q01',
      '    phase: Assembly',
      '    prompt: Rewritten prompt that should be ignored',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Preserve council retries and strict normalization.',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:11:00.000Z',
      'follow_up_rounds: []',
      'summary:',
      '  goals: [Changed summary]',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: changed',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n'), {
      ticketId: TEST.externalId,
      canonicalInterviewContent,
      memberId: 'openai/gpt-5',
    })

    expect(result.document.questions.map((question) => question.id)).toEqual(['Q01', 'Q02'])
    expect(result.document.questions[0]?.phase).toBe('Foundation')
    expect(result.document.questions[0]?.prompt).toBe('Which workflow guardrails are mandatory?')
    expect(result.document.questions[0]?.answer.free_text).toBe('Preserve council retries and strict normalization.')
    expect(result.document.questions[0]?.answer.answered_by).toBe('ai_skip')
    expect(result.document.questions[1]?.answer.free_text).toBe('PRD approval and coverage stay out of scope.')
    expect(result.repairWarnings.join('\n')).toContain('Canonicalized question order')
    expect(result.repairWarnings.join('\n')).toContain('Canonicalized metadata for canonical question Q01')
    expect(result.repairWarnings.join('\n')).toContain('Restored answered canonical question Q02')
    expect(result.repairWarnings.join('\n')).toContain('Canonicalized summary')
  })

  it('maps exact canonical option labels for skipped structured questions', () => {
    const canonicalInterviewContent = structuredInterviewYaml

    const result = validateResolvedInterview([
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: openai/gpt-5',
      '  generated_at: 2026-03-23T09:10:00.000Z',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Which workflow guardrails are mandatory?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Keep the council flow intact.',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:03:00.000Z',
      '  - id: Q02',
      '    phase: Structure',
      '    prompt: Which sharding mode should be the default?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Automatic detection',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:11:00.000Z',
      '  - id: Q03',
      '    phase: Assembly',
      '    prompt: Who is affected by sharding?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: |',
      '        - Operators running the pipeline',
      '        - Downstream consumers of issues.jsonl',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:12:00.000Z',
      'follow_up_rounds: []',
      'summary:',
      '  goals: [Harden DRAFTING_PRD]',
      '  constraints: [Preserve council mechanics]',
      '  non_goals: [Touch PRD approval]',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n'), {
      ticketId: TEST.externalId,
      canonicalInterviewContent,
      memberId: 'openai/gpt-5',
    })

    expect(result.document.questions[1]?.answer.selected_option_ids).toEqual(['opt2'])
    expect(result.document.questions[2]?.answer.selected_option_ids).toEqual(['opt1', 'opt3'])
    expect(result.repairWarnings.filter((warning) => warning.includes('Mapped free_text to canonical option ids'))).toHaveLength(2)
  })

  it('skips echoed retry artifacts when a later resolved interview candidate is valid', () => {
    const canonicalInterviewContent = skippedInterviewYaml

    const result = validateResolvedInterview([
      '## Full Answers Structured Output Retry',
      '',
      'Canonical approved interview artifact (copy everything except the skipped question answers):',
      '```yaml',
      canonicalInterviewContent,
      '```',
      '',
      'Previous invalid response:',
      '```',
      '[empty response]',
      '```',
      '',
      '```yaml',
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: openai/gpt-5',
      '  generated_at: 2026-03-23T09:10:00.000Z',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Which workflow guardrails are mandatory?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Preserve council retries and strict normalization.',
      '      answered_by: ai_skip',
      '      answered_at: 2026-03-23T09:11:00.000Z',
      '  - id: Q02',
      '    phase: Structure',
      '    prompt: Which downstream phases are out of scope for this pass?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: PRD approval and coverage stay out of scope.',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:04:00.000Z',
      'follow_up_rounds: []',
      'summary:',
      '  goals: [Changed summary that should be ignored]',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: changed',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
      '```',
    ].join('\n'), {
      ticketId: TEST.externalId,
      canonicalInterviewContent,
      memberId: 'openai/gpt-5',
    })

    expect(result.document.questions[0]?.answer.free_text).toBe('Preserve council retries and strict normalization.')
    expect(result.document.questions[1]?.answer.free_text).toBe('PRD approval and coverage stay out of scope.')
  })

  it('rejects ambiguous prose for skipped structured questions', () => {
    const canonicalInterviewContent = structuredInterviewYaml

    expect(() => validateResolvedInterview([
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: openai/gpt-5',
      '  generated_at: 2026-03-23T09:10:00.000Z',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Which workflow guardrails are mandatory?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Keep the council flow intact.',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:03:00.000Z',
      '  - id: Q02',
      '    phase: Structure',
      '    prompt: Which sharding mode should be the default?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Use automatic detection unless operators force the legacy path.',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:11:00.000Z',
      '  - id: Q03',
      '    phase: Assembly',
      '    prompt: Who is affected by sharding?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Operators and downstream systems benefit the most.',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:12:00.000Z',
      'follow_up_rounds: []',
      'summary:',
      '  goals: [Harden DRAFTING_PRD]',
      '  constraints: [Preserve council mechanics]',
      '  non_goals: [Touch PRD approval]',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n'), {
      ticketId: TEST.externalId,
      canonicalInterviewContent,
      memberId: 'openai/gpt-5',
    })).toThrow('does not map exactly to canonical options')
  })

  it('repairs leading canonical choice labels followed by explanation for skipped structured questions', () => {
    const canonicalInterviewContent = structuredInterviewYaml

    const result = validateResolvedInterview([
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: openai/gpt-5',
      '  generated_at: 2026-03-23T09:10:00.000Z',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Which workflow guardrails are mandatory?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Keep the council flow intact.',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:03:00.000Z',
      '  - id: Q02',
      '    phase: Structure',
      '    prompt: Which sharding mode should be the default?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: single_choice',
      '    options:',
      '      - id: opt1',
      '        label: Always sharded',
      '      - id: opt2',
      '        label: Automatic detection',
      '      - id: opt3',
      '        label: Manual flag only',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Automatic detection. Use the manual flag only when operators explicitly override the default.',
      '      answered_by: ai_skip',
      '      answered_at: 2026-03-23T09:11:00.000Z',
      '  - id: Q03',
      '    phase: Assembly',
      '    prompt: Who is affected by sharding?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: multiple_choice',
      '    options:',
      '      - id: opt1',
      '        label: Operators running the pipeline',
      '      - id: opt2',
      '        label: Council models',
      '      - id: opt3',
      '        label: Downstream consumers of issues.jsonl',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: |-',
      '        Operators running the pipeline - primary operators here.',
      '        Downstream consumers of issues.jsonl - they depend on the output shape.',
      '      answered_by: ai_skip',
      '      answered_at: 2026-03-23T09:12:00.000Z',
      'follow_up_rounds: []',
      'summary:',
      '  goals: [Harden DRAFTING_PRD]',
      '  constraints: [Preserve council mechanics]',
      '  non_goals: [Touch PRD approval]',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n'), {
      ticketId: TEST.externalId,
      canonicalInterviewContent,
      memberId: 'openai/gpt-5',
    })

    expect(result.document.questions[1]?.answer.selected_option_ids).toEqual(['opt2'])
    expect(result.document.questions[2]?.answer.selected_option_ids).toEqual(['opt1', 'opt3'])
    expect(result.repairWarnings.filter((warning) => warning.includes('Mapped free_text to canonical option ids'))).toHaveLength(2)
  })

  it('repairs non-canonical selected option ids when their labels match canonical options exactly', () => {
    const canonicalInterviewContent = structuredInterviewYaml

    const result = validateResolvedInterview([
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: openai/gpt-5',
      '  generated_at: 2026-03-23T09:10:00.000Z',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Which workflow guardrails are mandatory?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Keep the council flow intact.',
      '      answered_by: user',
      '      answered_at: 2026-03-23T09:03:00.000Z',
      '  - id: Q02',
      '    phase: Structure',
      '    prompt: Which sharding mode should be the default?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: single_choice',
      '    options:',
      '      - id: local-auto',
      '        label: Automatic detection',
      '      - id: local-manual',
      '        label: Manual flag only',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids:',
      '        - local-auto',
      '      free_text: ""',
      '      answered_by: ai_skip',
      '      answered_at: 2026-03-23T09:11:00.000Z',
      '  - id: Q03',
      '    phase: Assembly',
      '    prompt: Who is affected by sharding?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: multiple_choice',
      '    options:',
      '      - id: local-ops',
      '        label: Operators running the pipeline',
      '      - id: local-council',
      '        label: Council models',
      '      - id: local-downstream',
      '        label: Downstream consumers of issues.jsonl',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids:',
      '        - local-ops',
      '        - local-downstream',
      '      free_text: ""',
      '      answered_by: ai_skip',
      '      answered_at: 2026-03-23T09:12:00.000Z',
      'follow_up_rounds: []',
      'summary:',
      '  goals: [Harden DRAFTING_PRD]',
      '  constraints: [Preserve council mechanics]',
      '  non_goals: [Touch PRD approval]',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n'), {
      ticketId: TEST.externalId,
      canonicalInterviewContent,
      memberId: 'openai/gpt-5',
    })

    expect(result.document.questions[1]?.answer.selected_option_ids).toEqual(['opt2'])
    expect(result.document.questions[2]?.answer.selected_option_ids).toEqual(['opt1', 'opt3'])
    expect(result.repairWarnings.filter((warning) => warning.includes('Mapped selected option ids to canonical option ids'))).toHaveLength(2)
  })

  it('rejects PRD drafts when the canonical interview artifact is missing or invalid', () => {
    const prdContent = [
      'schema_version: 1',
      `ticket_id: ${TEST.externalId}`,
      'artifact: prd',
      'status: draft',
      'source_interview:',
      '  content_sha256: stale',
      'product:',
      '  problem_statement: Keep PRD drafting resilient.',
      '  target_users: [LoopTroop maintainers]',
      'scope:',
      '  in_scope: [Normalize council PRD drafts]',
      '  out_of_scope: [PRD approval workflow]',
      'technical_requirements:',
      '  architecture_constraints: []',
      '  data_model: []',
      '  api_contracts: []',
      '  security_constraints: []',
      '  performance_constraints: []',
      '  reliability_constraints: []',
      '  error_handling_rules: []',
      '  tooling_assumptions: []',
      'interview_gap_resolutions: []',
      'epics:',
      '  - id: EPIC-1',
      '    title: Draft parsing parity',
      '    objective: Match interview council draft rigor.',
      '    implementation_steps: []',
      '    user_stories:',
      '      - id: US-1-1',
      '        title: Repair ids deterministically',
      '        acceptance_criteria: []',
      '        implementation_steps: []',
      '        verification:',
      '          required_commands: []',
      'risks: []',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n')

    expect(() => validatePrdDraft(prdContent, {
      ticketId: TEST.externalId,
    })).toThrow('Canonical interview artifact is required for PRD normalization')

    expect(() => validatePrdDraft(prdContent, {
      ticketId: TEST.externalId,
      interviewContent: 'artifact: interview\nquestions: [',
    })).toThrow('Interview artifact is invalid')
  })
})
