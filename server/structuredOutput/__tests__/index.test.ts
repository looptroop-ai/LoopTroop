import { describe, expect, it } from 'vitest'
import {
  buildApprovedInterviewDocument,
  normalizeBeadCompletionMarkerOutput,
  normalizeBeadsJsonlOutput,
  normalizeBeadSubsetYamlOutput,
  normalizeCoverageResultOutput,
  normalizeFinalTestCommandsOutput,
  normalizeInterviewDocumentOutput,
  normalizeInterviewRefinementOutput,
  normalizeInterviewQuestionsOutput,
  normalizeInterviewTurnOutput,
  normalizePrdYamlOutput,
  normalizeRelevantFilesOutput,
  normalizeVoteScorecardOutput,
  updateInterviewDocumentAnswers,
} from '../index'
import { normalizeResolvedInterviewDocumentOutput } from '../interviewDocument'
import { TEST } from '../../test/factories'
import type {
  CoverageResultEnvelope,
  InterviewTurnOutput,
  StructuredOutputSuccess,
} from '../types'

const TICKET_ID = TEST.externalId

const VOTE_CATEGORIES = [
  'Coverage of requirements',
  'Correctness / feasibility',
  'Testability',
  'Minimal complexity / good decomposition',
  'Risks / edge cases addressed',
]
const CANDIDATE_RECOVERY_WARNING = 'Recovered the structured artifact from surrounding transcript or wrapper text before validation.'

function buildInterviewContent(
  ticketId: string,
  opts: { skipped?: boolean; prompt?: string; answer?: string } = {},
): string {
  const {
    skipped = false,
    prompt = 'What problem are we solving?',
    answer = 'Ship a deterministic planning pipeline.',
  } = opts

  const answeredBy = skipped ? 'ai_skip' : 'user'
  const answeredAt = skipped ? '' : '2026-03-20T10:05:00.000Z'
  const freeText = skipped ? '' : answer

  return [
    'schema_version: 1',
    `ticket_id: "${ticketId}"`,
    'artifact: "interview"',
    'status: "approved"',
    'generated_by:',
    '  winner_model: "openai/gpt-5"',
    '  generated_at: "2026-03-20T10:00:00.000Z"',
    'questions:',
    '  - id: "Q01"',
    '    phase: "Foundation"',
    `    prompt: "${prompt}"`,
    '    source: "compiled"',
    '    follow_up_round: null',
    '    answer_type: "free_text"',
    '    options: []',
    '    answer:',
    `      skipped: ${skipped}`,
    '      selected_option_ids: []',
    `      free_text: "${freeText}"`,
    `      answered_by: "${answeredBy}"`,
    `      answered_at: "${answeredAt}"`,
    'follow_up_rounds: []',
    'summary:',
    '  goals: []',
    '  constraints: []',
    '  non_goals: []',
    '  final_free_form_answer: ""',
    'approval:',
    '  approved_by: "user"',
    '  approved_at: "2026-03-20T10:10:00.000Z"',
  ].join('\n')
}

function buildStandardPrdYaml(opts: {
  ticketId?: string; sourceHash?: string | false; storyTitle?: string
  risksText?: string | false; outOfScope?: string[]; epicTitle?: string
  epicObjective?: string; epicSteps?: string[]; storyAcceptanceCriteria?: string[]
  storySteps?: string[]; storyVerificationCommands?: string[]
  includeApproval?: boolean; suffix?: string
} = {}): string {
  const {
    ticketId, sourceHash = 'stale-hash',
    storyTitle = 'Validate interview and PRD artifacts',
    risksText = 'Permissive repairs could hide semantic issues',
    outOfScope = ['Execution changes'], epicTitle = 'Harden structured output',
    epicObjective = 'Prevent format-only model mistakes from blocking tickets.',
    epicSteps = ['Add validators'],
    storyAcceptanceCriteria = ['Structured artifacts are normalized before save'],
    storySteps = ['Reuse shared repair helpers'],
    storyVerificationCommands = ['npm run test:server'],
    includeApproval = true, suffix = '',
  } = opts

  const yamlList = (items: string[], indent: string) =>
    items.length === 0 ? ' []' : '\n' + items.map((s) => `${indent}- "${s}"`).join('\n')

  return [
    'schema_version: 1',
    ...(ticketId ? [`ticket_id: "${ticketId}"`] : []),
    'artifact: "prd"', 'status: "draft"',
    ...(sourceHash !== false ? ['source_interview:', `  content_sha256: "${sourceHash}"`] : []),
    'product:', '  problem_statement: "Ship a deterministic planning pipeline."',
    '  target_users:', '    - "Maintainers"',
    'scope:', '  in_scope:', '    - "Prompt hardening"',
    `  out_of_scope:${yamlList(outOfScope, '    ')}`,
    'technical_requirements:', '  architecture_constraints:', '    - "Shared validator layer"',
    '  data_model: []', '  api_contracts: []', '  security_constraints: []',
    '  performance_constraints: []', '  reliability_constraints: []',
    '  error_handling_rules: []', '  tooling_assumptions: []',
    'epics:', '  - id: "EPIC-1"',
    `    title: "${epicTitle}"`, `    objective: "${epicObjective}"`,
    `    implementation_steps:${yamlList(epicSteps, '      ')}`,
    '    user_stories:', '      - id: "US-1"', `        title: "${storyTitle}"`,
    `        acceptance_criteria:${yamlList(storyAcceptanceCriteria, '          ')}`,
    `        implementation_steps:${yamlList(storySteps, '          ')}`,
    '        verification:',
    `          required_commands:${yamlList(storyVerificationCommands, '            ')}`,
    ...(risksText !== false ? ['risks:', `  - "${risksText}"`] : []),
    ...(includeApproval ? ['approval:', '  approved_by: ""', '  approved_at: ""'] : []),
  ].join('\n') + suffix
}

const CANONICAL_RESOLVED_INTERVIEW = [
  'schema_version: 1',
  `ticket_id: "${TICKET_ID}"`,
  'artifact: "interview"',
  'status: "approved"',
  'generated_by:',
  '  winner_model: "openai/gpt-5.4"',
  '  generated_at: "2026-03-25T18:18:55.102Z"',
  'questions:',
  '  - id: "Q01"',
  '    phase: "Foundation"',
  '    prompt: "What primary problem should the new phase solve?"',
  '    source: "compiled"',
  '    follow_up_round: null',
  '    answer_type: "free_text"',
  '    options: []',
  '    answer:',
  '      skipped: true',
  '      selected_option_ids: []',
  '      free_text: ""',
  '      answered_by: "ai_skip"',
  '      answered_at: ""',
  '  - id: "Q02"',
  '    phase: "Foundation"',
  '    prompt: "Who should consume the strategy?"',
  '    source: "compiled"',
  '    follow_up_round: null',
  '    answer_type: "single_choice"',
  '    options:',
  '      - id: "opt1"',
  '        label: "Workflow engine"',
  '      - id: "opt2"',
  '        label: "Beads generation"',
  '    answer:',
  '      skipped: false',
  '      selected_option_ids: ["opt1"]',
  '      free_text: ""',
  '      answered_by: "user"',
  '      answered_at: "2026-03-25T18:19:00.000Z"',
  'follow_up_rounds: []',
  'summary:',
  '  goals: []',
  '  constraints: []',
  '  non_goals: []',
  '  final_free_form_answer: ""',
  'approval:',
  '  approved_by: "user"',
  '  approved_at: "2026-03-25T18:19:30.000Z"',
].join('\n')

describe.concurrent('structured output normalization', () => {
  it('repairs interview phase ordering without changing within-phase order', () => {
    const result = normalizeInterviewQuestionsOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What are we building?"',
      '  - id: Q03',
      '    phase: structure',
      '    question: "What are the main flows?"',
      '  - id: Q02',
      '    phase: foundation',
      '    question: "Who is the user?"',
    ].join('\n'), 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.value.questions.map((question) => question.id)).toEqual(['Q01', 'Q02', 'Q03'])
  })

  it('repairs interview questions with inconsistent sequence entry indentation (LOO-19)', () => {
    const result = normalizeInterviewQuestionsOutput([
      'questions:',
      '- id: Q01',
      '    phase: foundation',
      '    question: >-',
      '        Who are the primary users or stakeholders',
      '        of this feature?',
      '  - id: Q02',
      '    phase: foundation',
      '    question: >-',
      '        What is the core problem this feature solves?',
      '  - id: Q03',
      '    phase: structure',
      '    question: "What are the main user flows?"',
    ].join('\n'), 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questions).toHaveLength(3)
    expect(result.value.questions[0]!.id).toBe('Q01')
    expect(result.value.questions[1]!.id).toBe('Q02')
    expect(result.value.questions[2]!.id).toBe('Q03')
  })

  it('recovers interview questions emitted as an inline sequence parent', () => {
    const result = normalizeInterviewQuestionsOutput(
      'questions: - id: Q01 phase: foundation question: What behavior should the API expose?',
      10,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toContain('Repaired inline YAML sequence or mapping syntax before parsing.')
    expect(result.value.questions).toEqual([
      {
        id: 'Q01',
        phase: 'foundation',
        question: 'What behavior should the API expose?',
      },
    ])
  })

  it('recovers structured artifacts when commentary is glued to the first root key', () => {
    const questions = normalizeInterviewQuestionsOutput([
      'I am narrowing this to the minimum useful set.questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: What ambiguity should be removed first?',
    ].join('\n'), 10)
    expect(questions.ok).toBe(true)
    if (!questions.ok) return
    expect(questions.repairWarnings).toContain(CANDIDATE_RECOVERY_WARNING)
    expect(questions.value.questions[0]?.id).toBe('Q01')

    const votes = normalizeVoteScorecardOutput([
      'Checking feasibility before scoring.draft_scores:',
      '  Draft 1:',
      '    Coverage of requirements: 16',
      '    Correctness / feasibility: 17',
      '    Testability: 18',
      '    Minimal complexity / good decomposition: 19',
      '    Risks / edge cases addressed: 20',
      '    total_score: 90',
    ].join('\n'), ['Draft 1'], VOTE_CATEGORIES)
    expect(votes.ok).toBe(true)
    if (!votes.ok) return
    expect(votes.repairWarnings).toContain(CANDIDATE_RECOVERY_WARNING)
    expect(votes.value.draftScores['Draft 1']?.total_score).toBe(90)

    const coverage = normalizeCoverageResultOutput([
      'Reading the artifacts before calling this complete.status: clean',
      'gaps: []',
      'follow_up_questions: []',
    ].join('\n'))
    expect(coverage.ok).toBe(true)
    if (!coverage.ok) return
    expect(coverage.repairWarnings).toContain(CANDIDATE_RECOVERY_WARNING)
    expect(coverage.value.status).toBe('clean')

    const beads = normalizeBeadSubsetYamlOutput([
      'Updating the affected bead only: keep it scoped.beads:',
      '  - id: parser-recovery',
      '    title: Recover parser candidate boundaries',
      '    prdRefs:',
      '      - EPIC-1',
      '    description: Recover existing structured content after glued prose.',
      '    contextGuidance:',
      '      patterns:',
      '        - Keep candidate recovery text-preserving.',
      '      anti_patterns:',
      '        - Do not invent missing fields.',
      '    acceptanceCriteria:',
      '      - Glued prose before the root key is ignored.',
      '    tests:',
      '      - Parser regression covers glued root keys.',
      '    testCommands:',
      '      - npm run test:server',
    ].join('\n'))
    expect(beads.ok).toBe(true)
    if (!beads.ok) return
    expect(beads.repairWarnings).toContain(CANDIDATE_RECOVERY_WARNING)
    expect(beads.value[0]?.id).toBe('parser-recovery')
  })

  it('still rejects invalid content after a recovered root key', () => {
    const result = normalizeCoverageResultOutput([
      'Reading the artifacts before calling this complete.status: maybe',
      'gaps: []',
      'follow_up_questions: []',
    ].join('\n'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('Coverage output missing valid status')
  })

  it('normalizes refinement output wrapped in ```yaml code fences', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
      '  - id: Q02',
      '    phase: structure',
      '    question: "What are the main workflows?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      '```yaml',
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What user problem are we solving?"',
      '  - id: Q02',
      '    phase: structure',
      '    question: "What are the main workflows?"',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
      '    after:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What user problem are we solving?"',
      '```',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questionCount).toBe(2)
    expect(result.value.changes).toHaveLength(1)
    expect(result.value.changes[0]!.type).toBe('modified')
  })

  it('normalizes PROM3 refinement output with explicit changes', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
      '  - id: Q02',
      '    phase: structure',
      '    question: "What are the main workflows?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What user problem are we solving?"',
      '  - id: Q03',
      '    phase: assembly',
      '    question: "How should success be verified?"',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
      '    after:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What user problem are we solving?"',
      '  - type: removed',
      '    before:',
      '      id: Q02',
      '      phase: structure',
      '      question: "What are the main workflows?"',
      '    after: null',
      '  - type: added',
      '    before: null',
      '    after:',
      '      id: Q03',
      '      phase: assembly',
      '      question: "How should success be verified?"',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questionCount).toBe(2)
    expect(result.value.changes.map((change) => change.type)).toEqual(['modified', 'removed', 'added'])
    expect(result.normalizedContent).not.toContain('changes:')
    expect(result.normalizedContent).toContain('questions:')
  })

  it('marks malformed interview inspiration as invalid without dropping the change', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What user problem are we solving?"',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
      '    after:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What user problem are we solving?"',
      '    inspiration:',
      '      alternative_draft: 1',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.changes).toEqual([
      {
        type: 'modified',
        before: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What problem are we solving?',
        },
        after: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What user problem are we solving?',
        },
        inspiration: null,
        attributionStatus: 'invalid_unattributed',
      },
    ])
  })

  it('accepts labeled alternative-draft references in interview refinement inspiration', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What user problem are we solving?"',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
      '    after:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What user problem are we solving?"',
      '    inspiration:',
      '      alternative_draft: Alternative Draft 2',
      '      question:',
      '        id: Q09',
      '        phase: foundation',
      '        question: "What constraints matter most?"',
    ].join('\n'), winnerDraft, 10, [
      { memberId: 'openai/gpt-5-mini', content: 'questions: []' },
      { memberId: 'openai/gpt-5.4', content: 'questions: []' },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.changes).toEqual([
      {
        type: 'modified',
        before: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What problem are we solving?',
        },
        after: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What user problem are we solving?',
        },
        inspiration: {
          draftIndex: 1,
          memberId: 'openai/gpt-5.4',
          question: {
            id: 'Q09',
            phase: 'foundation',
            question: 'What constraints matter most?',
          },
        },
        attributionStatus: 'inspired',
      },
    ])
  })

  it('hydrates scalar interview inspiration questions from the referenced alternative draft', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
    ].join('\n')

    const losingDraft = [
      'questions:',
      '  - id: Q07',
      '    phase: structure',
      '    question: "What constraints matter most?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What user problem are we solving?"',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
      '    after:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What user problem are we solving?"',
      '    inspiration:',
      '      alternative_draft: 1',
      '      question: "What constraints matter most?"',
    ].join('\n'), winnerDraft, 10, [
      { memberId: 'openai/gpt-5.4', content: losingDraft },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.changes).toEqual([
      {
        type: 'modified',
        before: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What problem are we solving?',
        },
        after: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What user problem are we solving?',
        },
        inspiration: {
          draftIndex: 0,
          memberId: 'openai/gpt-5.4',
          question: {
            id: 'Q07',
            phase: 'structure',
            question: 'What constraints matter most?',
          },
        },
        attributionStatus: 'inspired',
      },
    ])
  })

  it('accepts PROM3 refinement output without a changes list and keeps the normalized artifact clean', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What user problem are we solving?"',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.changes).toEqual([])
    expect(result.normalizedContent).toContain('questions:')
    expect(result.normalizedContent).not.toContain('changes:')
  })

  it('preserves folded refinement questions instead of corrupting them during YAML repair', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q22',
      '    phase: assembly',
      '    question: >-',
      '      What deterministic ordering rules should govern XML output: path sort',
      '      only, directories before files, case sensitivity rules, and any stable',
      '      normalization required for cross-platform consistency?',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q22',
      '    phase: assembly',
      '    question: >-',
      '      What deterministic ordering and normalization rules should govern XML',
      '      output: path sort only, directories before files, case sensitivity,',
      '      locale neutrality, symlink handling, and any stable normalization needed',
      '      for cross-platform consistency?',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q22',
      '      phase: assembly',
      '      question: >-',
      '        What deterministic ordering rules should govern XML output: path sort',
      '        only, directories before files, case sensitivity rules, and any stable',
      '        normalization required for cross-platform consistency?',
      '    after:',
      '      id: Q22',
      '      phase: assembly',
      '      question: >-',
      '        What deterministic ordering and normalization rules should govern XML',
      '        output: path sort only, directories before files, case sensitivity,',
      '        locale neutrality, symlink handling, and any stable normalization needed',
      '        for cross-platform consistency?',
    ].join('\n'), winnerDraft, 50)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questionCount).toBe(1)
    expect(result.value.changes).toHaveLength(1)
    expect(result.value.questions[0]?.id).toBe('Q22')
    expect(result.value.questions[0]?.question).toContain('locale neutrality')
  })

  it('drops no-op modified interview refinement changes instead of retrying or failing', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
      '    after:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Dropped no-op interview refinement modified')
    expect(result.value.changes).toEqual([])
  })

  it('repairs stale top-level interview questions from explicit declared changes before diff validation', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: >-',
      '      Should the pink theme be selectable alongside existing themes (light, dark, system), or should it replace one of',
      '      them?',
      '  - id: Q02',
      '    phase: foundation',
      '    question: Are there any requirements or constraints for accessibility, contrast, or branding for the pink theme?',
      '  - id: Q03',
      '    phase: structure',
      '    question: >-',
      '      Which UI areas or components (e.g., buttons, badges, backgrounds) must change appearance when the pink theme is',
      '      active?',
      '  - id: Q04',
      '    phase: assembly',
      '    question: >-',
      '      Do you have a specific shade or palette of pink in mind for key color roles (background, primary, accent), or',
      '      should the implementation choose reasonable defaults?',
      '  - id: Q05',
      '    phase: assembly',
      '    question: >-',
      "      Should the pink theme's application support toggling at runtime in the same way as current themes, with instant",
      '      visual update and persistence?',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: Should the pink theme be selectable alongside existing themes (light, dark, system), or should it replace one of them?',
      '  - id: Q02',
      '    phase: foundation',
      '    question: Are there any requirements or constraints for accessibility, contrast, or branding for the pink theme?',
      '  - id: Q03',
      '    phase: structure',
      '    question: Which UI areas or components (e.g., buttons, badges, backgrounds) must change appearance when the pink theme is active?',
      '  - id: Q04',
      '    phase: assembly',
      '    question: Do you have a specific shade or palette of pink in mind for key color roles (background, primary, accent), or should the implementation choose reasonable defaults?',
      '  - id: Q05',
      '    phase: assembly',
      "    question: Should the pink theme's application support toggling at runtime in the same way as current themes, with instant visual update and persistence?",
      'changes:',
      '  - type: removed',
      '    before:',
      '      id: Q02',
      '      phase: foundation',
      '      question: Are there any requirements or constraints for accessibility, contrast, or branding for the pink theme?',
      '    after: null',
      '  - type: added',
      '    before: null',
      '    after:',
      '      id: Q02',
      '      phase: foundation',
      '      question: Are there any accessibility, contrast, or branding requirements—or is "visible and pink" sufficient for this test?',
      '  - type: modified',
      '    before:',
      '      id: Q04',
      '      phase: assembly',
      '      question: Do you have a specific shade or palette of pink in mind for key color roles (background, primary, accent), or should the implementation choose reasonable defaults?',
      '    after:',
      '      id: Q04',
      '      phase: assembly',
      '      question: Do you have a specific pink palette in mind (hex values or reference), or should the implementation use reasonable defaults?',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Updated the refined interview questions from added change')
    expect(result.repairWarnings.join('\n')).toContain('Updated the refined interview questions from modified change')
    expect(result.value.questions).toEqual([
      {
        id: 'Q01',
        phase: 'foundation',
        question: 'Should the pink theme be selectable alongside existing themes (light, dark, system), or should it replace one of them?',
      },
      {
        id: 'Q02',
        phase: 'foundation',
        question: 'Are there any accessibility, contrast, or branding requirements—or is "visible and pink" sufficient for this test?',
      },
      {
        id: 'Q03',
        phase: 'structure',
        question: 'Which UI areas or components (e.g., buttons, badges, backgrounds) must change appearance when the pink theme is active?',
      },
      {
        id: 'Q04',
        phase: 'assembly',
        question: 'Do you have a specific pink palette in mind (hex values or reference), or should the implementation use reasonable defaults?',
      },
      {
        id: 'Q05',
        phase: 'assembly',
        question: "Should the pink theme's application support toggling at runtime in the same way as current themes, with instant visual update and persistence?",
      },
    ])
    expect(result.value.changes.map((change) => change.type)).toEqual(['removed', 'added', 'modified'])
  })

  it('canonicalizes slight interview refinement text drift when id and phase uniquely match', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What user problem are we solving?"',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving today?"',
      '    after:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What user problem are we solving today?"',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.value.changes).toEqual([
      {
        type: 'modified',
        before: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What problem are we solving?',
        },
        after: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What user problem are we solving?',
        },
        inspiration: null,
        attributionStatus: 'model_unattributed',
      },
    ])
  })

  it('rejects refinement changes that reference a non-winner question', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q02',
      '    phase: foundation',
      '    question: "What user problem are we solving?"',
      'changes:',
      '  - type: replaced',
      '    before:',
      '      id: Q09',
      '      phase: foundation',
      '      question: "Unknown question?"',
      '    after:',
      '      id: Q02',
      '      phase: foundation',
      '      question: "What user problem are we solving?"',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('winning draft')
  })

  it('rejects duplicate reuse of the same question record across changes', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
      '  - id: Q02',
      '    phase: structure',
      '    question: "What are the main workflows?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q03',
      '    phase: foundation',
      '    question: "What user problem are we solving?"',
      '  - id: Q04',
      '    phase: structure',
      '    question: "What flow matters most?"',
      'changes:',
      '  - type: replaced',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
      '    after:',
      '      id: Q03',
      '      phase: foundation',
      '      question: "What user problem are we solving?"',
      '  - type: replaced',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
      '    after:',
      '      id: Q04',
      '      phase: structure',
      '      question: "What flow matters most?"',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('reuses a winning-draft question')
  })

  it('repairs added → replaced when the model reuses a winner-draft question ID with different content', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
      '  - id: Q02',
      '    phase: foundation',
      '    question: "Who is the target user?"',
      '  - id: Q03',
      '    phase: structure',
      '    question: "What are the main workflows?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
      '  - id: Q02',
      '    phase: structure',
      '    question: "What components need to interact?"',
      '  - id: Q03',
      '    phase: structure',
      '    question: "How should data flow between modules?"',
      'changes:',
      '  - type: added',
      '    before: null',
      '    after:',
      '      id: Q02',
      '      phase: structure',
      '      question: "What components need to interact?"',
      '  - type: added',
      '    before: null',
      '    after:',
      '      id: Q03',
      '      phase: structure',
      '      question: "How should data flow between modules?"',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Converted interview refinement change at index 0 from "added" to "replaced"')
    expect(result.repairWarnings.join('\n')).toContain('Converted interview refinement change at index 1 from "added" to "replaced"')
    expect(result.value.changes).toEqual([
      {
        type: 'replaced',
        before: {
          id: 'Q02',
          phase: 'foundation',
          question: 'Who is the target user?',
        },
        after: {
          id: 'Q02',
          phase: 'structure',
          question: 'What components need to interact?',
        },
        inspiration: null,
        attributionStatus: 'model_unattributed',
      },
      {
        type: 'replaced',
        before: {
          id: 'Q03',
          phase: 'structure',
          question: 'What are the main workflows?',
        },
        after: {
          id: 'Q03',
          phase: 'structure',
          question: 'How should data flow between modules?',
        },
        inspiration: null,
        attributionStatus: 'model_unattributed',
      },
    ])
  })

  it('synthesizes omitted same-identity modified changes when final questions are complete', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
      '  - id: Q02',
      '    phase: structure',
      '    question: "What flow matters most?"',
      '  - id: Q03',
      '    phase: assembly',
      '    question: "How do we verify success?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What user problem are we solving?"',
      '  - id: Q02',
      '    phase: structure',
      '    question: "What flow matters most?"',
      '  - id: Q03',
      '    phase: assembly',
      '    question: "How should success be verified in practice?"',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
      '    after:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What user problem are we solving?"',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Synthesized omitted interview refinement modified change for Q03')
    expect(result.value.changes).toEqual([
      {
        type: 'modified',
        before: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What problem are we solving?',
        },
        after: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What user problem are we solving?',
        },
        inspiration: null,
        attributionStatus: 'model_unattributed',
      },
      {
        type: 'modified',
        before: {
          id: 'Q03',
          phase: 'assembly',
          question: 'How do we verify success?',
        },
        after: {
          id: 'Q03',
          phase: 'assembly',
          question: 'How should success be verified in practice?',
        },
        inspiration: null,
        attributionStatus: 'synthesized_unattributed',
      },
    ])
  })

  it('succeeds when a modified entry is missing one side and there is a unique same-identity repair path', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What user problem are we solving?"',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.value.changes).toEqual([
      {
        type: 'modified',
        before: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What problem are we solving?',
        },
        after: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What user problem are we solving?',
        },
        inspiration: null,
        attributionStatus: 'synthesized_unattributed',
      },
    ])
  })

  it('drops a redundant partial entry after synthesizing the canonical same-identity modified change', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What user problem are we solving?"',
      'changes:',
      '  - type: modified',
      '    after:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What user problem are we solving?"',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Synthesized omitted interview refinement modified change for Q01')
    expect(result.repairWarnings.join('\n')).toContain('Dropped partial interview refinement change at index 0')
    expect(result.value.changes).toEqual([
      {
        type: 'modified',
        before: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What problem are we solving?',
        },
        after: {
          id: 'Q01',
          phase: 'foundation',
          question: 'What user problem are we solving?',
        },
        inspiration: null,
        attributionStatus: 'synthesized_unattributed',
      },
    ])
  })

  it('still fails when a partial modified entry is ambiguous after safe repairs', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
      '  - id: Q02',
      '    phase: structure',
      '    question: "What flow matters most?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q03',
      '    phase: assembly',
      '    question: "How should success be verified?"',
      'changes:',
      '  - type: modified',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('no unique safe repair candidate')
  })

  it('still fails for suspicious cross-id pairings that would require guessing', () => {
    const winnerDraft = [
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
      '  - id: Q02',
      '    phase: structure',
      '    question: "What flow matters most?"',
    ].join('\n')

    const result = normalizeInterviewRefinementOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What user problem are we solving?"',
      '  - id: Q02',
      '    phase: structure',
      '    question: "Which flow matters most in practice?"',
      'changes:',
      '  - type: replaced',
      '    before:',
      '      id: Q01',
      '      phase: foundation',
      '      question: "What problem are we solving?"',
      '    after:',
      '      id: Q02',
      '      phase: structure',
      '      question: "Which flow matters most in practice?"',
    ].join('\n'), winnerDraft, 10)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('do not fully and exactly account')
  })

  it('parses wrapped vote scorecards and repairs incorrect totals', () => {
    const wrapped = [
      '```yaml',
      'draft_scores:',
      '  Draft 1:',
      '    Coverage of requirements: 18',
      '    Correctness / feasibility: 17',
      '    Testability: 16',
      '    Minimal complexity / good decomposition: 15',
      '    Risks / edge cases addressed: 18',
      '    total_score: 84',
      '  Draft 2:',
      '    Coverage of requirements: 14',
      '    Correctness / feasibility: 15',
      '    Testability: 14',
      '    Minimal complexity / good decomposition: 16',
      '    Risks / edge cases addressed: 13',
      '    total_score: 72',
      '```',
    ].join('\n')

    const parsed = normalizeVoteScorecardOutput(
      wrapped,
      ['Draft 1', 'Draft 2'],
      VOTE_CATEGORIES,
    )

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.draftScores['Draft 1']?.total_score).toBe(84)

    const repaired = normalizeVoteScorecardOutput(
      parsed.normalizedContent.replace('total_score: 84', 'total_score: 80'),
      ['Draft 1', 'Draft 2'],
      VOTE_CATEGORIES,
    )

    expect(repaired.ok).toBe(true)
    if (!repaired.ok) return
    expect(repaired.repairApplied).toBe(true)
    expect(repaired.value.draftScores['Draft 1']?.total_score).toBe(84)
    expect(repaired.repairWarnings.join('\n')).toContain('Recomputed total_score for Draft 1')
  })

  it('repairs missing vote total_score values but keeps invalid category scores strict', () => {
    const repaired = normalizeVoteScorecardOutput(
      [
        'draft_scores:',
        '  Draft 1:',
        '    Coverage of requirements: 18',
        '    Correctness / feasibility: 17',
        '    Testability: 16',
        '    Minimal complexity / good decomposition: 15',
        '    Risks / edge cases addressed: 18',
      ].join('\n'),
      ['Draft 1'],
      VOTE_CATEGORIES,
    )

    expect(repaired.ok).toBe(true)
    if (!repaired.ok) return
    expect(repaired.repairApplied).toBe(true)
    expect(repaired.value.draftScores['Draft 1']?.total_score).toBe(84)

    const invalid = normalizeVoteScorecardOutput(
      [
        'draft_scores:',
        '  Draft 1:',
        '    Coverage of requirements: 18',
        '    Correctness / feasibility: 17',
        '    Testability: nope',
        '    Minimal complexity / good decomposition: 15',
        '    Risks / edge cases addressed: 18',
        '    total_score: 84',
      ].join('\n'),
      ['Draft 1'],
      VOTE_CATEGORIES,
    )

    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.error).toContain('Invalid score for Draft 1 / Testability')
  })

  it('repairs malformed wrapped vote indentation from council retries', () => {
    const repaired = normalizeVoteScorecardOutput(
      [
        'draft_scores:',
        'Draft 1:',
        '    Coverage of requirements: 18',
        '    Correctness / feasibility: 18',
        '    Testability: 18',
        '    Minimal complexity / good decomposition: 16',
        '    Risks / edge cases addressed: 19',
        '    total_score: 89',
        '  Draft 2:',
        '    Coverage of requirements: 20',
        '    Correctness / feasibility: 19',
        '    Testability: 20',
        '    Minimal complexity / good decomposition: 10',
        '    Risks / edge cases addressed: 19',
        '    total_score: 88',
        '  Draft 3:',
        '    Coverage of requirements: 18',
        '    Correctness / feasibility: 19',
        '    Testability: 18',
        '    Minimal complexity / good decomposition: 18',
        '    Risks / edge cases addressed: 18',
        '    total_score: 91',
        '  Draft 4:',
        '    Coverage of requirements: 12',
        '    Correctness / feasibility: 17',
        '    Testability: 11',
        '    Minimal complexity / good decomposition: 9',
        '    Risks / edge cases addressed: 12',
        '    total_score: 61',
      ].join('\n'),
      ['Draft 1', 'Draft 2', 'Draft 3', 'Draft 4'],
      VOTE_CATEGORIES,
    )

    expect(repaired.ok).toBe(true)
    if (!repaired.ok) return
    expect(repaired.repairApplied).toBe(true)
    expect(repaired.repairWarnings.join('\n')).toContain('Normalized vote scorecard indentation')
    expect(repaired.value.draftScores['Draft 1']?.total_score).toBe(89)
    expect(repaired.value.draftScores['Draft 4']?.total_score).toBe(61)
  })

  it('trims trailing terminal noise from complete vote scorecard JSON output', () => {
    const repaired = normalizeVoteScorecardOutput(
      `${JSON.stringify({
        draft_scores: {
          'Draft 1': {
            'Coverage of requirements': 18,
            'Correctness / feasibility': 17,
            Testability: 16,
            'Minimal complexity / good decomposition': 15,
            'Risks / edge cases addressed': 18,
            total_score: 84,
          },
        },
      })}[e~[`,
      ['Draft 1'],
      VOTE_CATEGORIES,
    )

    expect(repaired.ok).toBe(true)
    if (!repaired.ok) return
    expect(repaired.repairApplied).toBe(true)
    expect(repaired.repairWarnings.join('\n')).toContain('Trimmed trailing terminal noise')
    expect(repaired.value.draftScores['Draft 1']?.total_score).toBe(84)
  })

  it('trims orphan trailing closing fences from vote scorecards recovered via top-level hints', () => {
    const repaired = normalizeVoteScorecardOutput(
      [
        'Corrected scorecard:',
        'draft_scores:',
        '  Draft 1:',
        '    Coverage of requirements: 18',
        '    Correctness / feasibility: 17',
        '    Testability: 16',
        '    Minimal complexity / good decomposition: 15',
        '    Risks / edge cases addressed: 18',
        '    total_score: 84',
        '```',
      ].join('\n'),
      ['Draft 1'],
      VOTE_CATEGORIES,
    )

    expect(repaired.ok).toBe(true)
    if (!repaired.ok) return
    expect(repaired.repairApplied).toBe(true)
    expect(repaired.repairWarnings.join('\n')).toContain('orphan trailing closing code fence')
    expect(repaired.value.draftScores['Draft 1']?.total_score).toBe(84)
  })

  it('trims trailing terminal noise from vote scorecard scalars before validation', () => {
    const repaired = normalizeVoteScorecardOutput(
      [
        'draft_scores:',
        '  Draft 1:',
        '    Coverage of requirements: 18',
        '    Correctness / feasibility: 17',
        '    Testability: 16',
        '    Minimal complexity / good decomposition: 15',
        '    Risks / edge cases addressed: 18',
        '    total_score: 84[e~[',
      ].join('\n'),
      ['Draft 1'],
      VOTE_CATEGORIES,
    )

    expect(repaired.ok).toBe(true)
    if (!repaired.ok) return
    expect(repaired.repairApplied).toBe(true)
    expect(repaired.repairWarnings.join('\n')).toContain('Trimmed trailing terminal noise')
    expect(repaired.value.draftScores['Draft 1']?.total_score).toBe(84)
  })

  it('keeps unknown vote scorecards strict', () => {
    const result = normalizeVoteScorecardOutput(
      [
        'draft_scores:',
        '  Draft 1:',
        '    Coverage of requirements: 18',
        '    Correctness / feasibility: 17',
        '    Testability: 16',
        '    Minimal complexity / good decomposition: 15',
        '    Risks / edge cases addressed: 18',
        '    total_score: 84',
        '  Draft 3:',
        '    Coverage of requirements: 10',
        '    Correctness / feasibility: 10',
        '    Testability: 10',
        '    Minimal complexity / good decomposition: 10',
        '    Risks / edge cases addressed: 10',
        '    total_score: 50',
      ].join('\n'),
      ['Draft 1'],
      VOTE_CATEGORIES,
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Unknown scorecard for Draft 3')
  })

  it('normalizes PRD YAML and fills deterministic metadata from runtime context', () => {
    const interviewContent = buildInterviewContent(TICKET_ID, { skipped: true, prompt: 'Which fallback path should we use?' })
    const result = normalizePrdYamlOutput([
      'prd:',
      '  product:',
      '    problemStatement: Ship a deterministic planning pipeline.',
      '    targetUsers:',
      '      - Maintainers',
      '  scope:',
      '    inScope:',
      '      - Prompt hardening',
      '    outOfScope:',
      '      - Execution changes',
      '  technicalRequirements:',
      '    architectureConstraints:',
      '      - Shared validator layer',
      '  epics:',
      '    - id: EPIC-1',
      '      title: Harden structured output',
      '      objective: Prevent format-only model mistakes from blocking tickets.',
      '      implementationSteps:',
      '        - Add validators',
      '      userStories:',
      '        - id: US-1',
      '          title: Validate interview/PRD/beads artifacts',
      '          acceptanceCriteria:',
      '            - Structured artifacts are normalized before save',
      '          implementationSteps:',
      '            - Reuse shared repair helpers',
      '          verification:',
      '            requiredCommands:',
      '              - npm run test:server',
      '  risks:',
      '    - Retry loop could hide semantic mistakes if too permissive',
    ].join('\n'), {
      ticketId: TICKET_ID,
      interviewContent,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.ticket_id).toBe(TICKET_ID)
    expect(result.value.artifact).toBe('prd')
    expect(result.value.epics).toHaveLength(1)
    expect(result.normalizedContent).toContain('schema_version: 1')
  })

  it('accepts a top-level PRD document with artifact field instead of unwrapping it', () => {
    const interviewContent = buildInterviewContent(TICKET_ID)
    const result = normalizePrdYamlOutput(buildStandardPrdYaml({
      ticketId: TICKET_ID,
      sourceHash: 'abc123',
      storyTitle: 'Validate interview/PRD/beads artifacts',
      risksText: 'Retry loop could hide semantic mistakes if too permissive',
    }), {
      ticketId: TICKET_ID,
      interviewContent,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.ticket_id).toBe(TICKET_ID)
    expect(result.value.artifact).toBe('prd')
    expect(result.value.epics).toHaveLength(1)
  })

  it('preserves header-like PRD list scalar text instead of accepting YAML mapping coercion', () => {
    const interviewContent = buildInterviewContent(TICKET_ID)
    const prdContent = buildStandardPrdYaml({
      ticketId: TICKET_ID,
    }).replace(
      '  data_model: []',
      [
        '  data_model:',
        '    - Content-Disposition: attachment; filename=synonyms.json',
      ].join('\n'),
    )

    const result = normalizePrdYamlOutput(prdContent, {
      ticketId: TICKET_ID,
      interviewContent,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairWarnings).toContain('Quoted YAML plain scalar values containing colon-space before reparsing.')
    expect(result.value.technical_requirements.data_model).toEqual([
      'Content-Disposition: attachment; filename=synonyms.json',
    ])
  })

  it('repairs wrapped colon-containing acceptance criteria from PRD refinement output', () => {
    const interviewContent = buildInterviewContent(TICKET_ID)
    const malformedCriterion = [
      '          - `Object.getOwnPropertyDescriptor(fn, approvedProperty)` reports `writable: false`, `enumerable: false`, and',
      '            `configurable: false`.',
    ].join('\n')
    const prdContent = buildStandardPrdYaml({
      ticketId: TICKET_ID,
      storyAcceptanceCriteria: ['placeholder'],
    }).replace('          - "placeholder"', malformedCriterion)

    const result = normalizePrdYamlOutput(prdContent, {
      ticketId: TICKET_ID,
      interviewContent,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairWarnings).toContain('Folded wrapped YAML list scalar text containing colon-space before reparsing.')
    expect(result.value.epics[0]?.user_stories[0]?.acceptance_criteria).toEqual([
      '`Object.getOwnPropertyDescriptor(fn, approvedProperty)` reports `writable: false`, `enumerable: false`, and `configurable: false`.',
    ])
  })

  it('accepts PRD YAML after repairing bare epic and user story sequence ids', () => {
    const interviewContent = buildInterviewContent(TICKET_ID)
    const prdContent = buildStandardPrdYaml({
      ticketId: TICKET_ID,
    })
      .replace('  - id: "EPIC-1"', '  - EPIC-1')
      .replace('      - id: "US-1"', '      - US-1')

    const result = normalizePrdYamlOutput(prdContent, {
      ticketId: TICKET_ID,
      interviewContent,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.epics[0]?.id).toBe('EPIC-1')
    expect(result.value.epics[0]?.user_stories[0]?.id).toBe('US-1')
    const warnings = result.repairWarnings.join('\n')
    expect(warnings).toContain('Repaired YAML sequence entry under "epics"')
    expect(warnings).toContain('treated bare item "EPIC-1" as id before parsing.')
    expect(warnings).toContain('Repaired YAML sequence entry under "user_stories"')
    expect(warnings).toContain('treated bare item "US-1" as id before parsing.')
  })

  it('unwraps artifact.prd object wrappers without relaxing PRD validation', () => {
    const interviewContent = buildInterviewContent(TICKET_ID)

    const result = normalizePrdYamlOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact:',
      '  prd:',
      '    status: "draft"',
      '    source_interview:',
      '      content_sha256: "stale-hash"',
      '    product:',
      '      problem_statement: "Ship a deterministic planning pipeline."',
      '      target_users:',
      '        - "Maintainers"',
      '    scope:',
      '      in_scope:',
      '        - "Prompt hardening"',
      '      out_of_scope:',
      '        - "Execution changes"',
      '    technical_requirements:',
      '      architecture_constraints:',
      '        - "Shared validator layer"',
      '      data_model: []',
      '      api_contracts: []',
      '      security_constraints: []',
      '      performance_constraints: []',
      '      reliability_constraints: []',
      '      error_handling_rules: []',
      '      tooling_assumptions: []',
      '    epics:',
      '      - id: "EPIC-1"',
      '        title: "Harden structured output"',
      '        objective: "Prevent format-only model mistakes from blocking tickets."',
      '        implementation_steps:',
      '          - "Add validators"',
      '        user_stories:',
      '          - id: "US-1"',
      '            title: "Validate interview and PRD artifacts"',
      '            acceptance_criteria:',
      '              - "Structured artifacts are normalized before save"',
      '            implementation_steps:',
      '              - "Reuse shared repair helpers"',
      '            verification:',
      '              required_commands:',
      '                - "npm run test:server"',
      '    risks:',
      '      - "Permissive repairs could hide semantic issues"',
      '    approval:',
      '      approved_by: ""',
      '      approved_at: ""',
    ].join('\n'), {
      ticketId: TICKET_ID,
      interviewContent,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.ticket_id).toBe(TICKET_ID)
    expect(result.value.artifact).toBe('prd')
    expect(result.value.epics).toHaveLength(1)
    expect(result.value.epics[0]?.user_stories[0]?.id).toBe('US-1')
  })

  it('repairs dedented PRD nested wrapper mappings without relaxing schema checks', () => {
    const interviewContent = buildInterviewContent(TICKET_ID)

    const result = normalizePrdYamlOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "prd"',
      'status: "draft"',
      'source_interview:',
      'content_sha256: "stale-hash"',
      'product:',
      'problem_statement: "Ship a deterministic planning pipeline."',
      'target_users:',
      '  - "Maintainers"',
      'scope:',
      'in_scope:',
      '  - "Prompt hardening"',
      'out_of_scope:',
      '  - "Execution changes"',
      'technical_requirements:',
      'architecture_constraints:',
      '  - "Shared validator layer"',
      'data_model: []',
      'api_contracts: []',
      'security_constraints: []',
      'performance_constraints: []',
      'reliability_constraints: []',
      'error_handling_rules: []',
      'tooling_assumptions: []',
      'epics:',
      '  - id: EPIC-1',
      '    title: Harden structured output',
      '    objective: Prevent format-only model mistakes from blocking tickets.',
      '    implementation_steps:',
      '      - Add validators',
      '    user_stories:',
      '      - id: US-1',
      '        title: Validate interview and PRD artifacts',
      '        acceptance_criteria:',
      '          - Structured artifacts are normalized before save',
      '        implementation_steps:',
      '          - Reuse shared repair helpers',
      '        verification:',
      '        required_commands:',
      '        - npm run test:server',
      'risks:',
      '  - "Permissive repairs could hide semantic issues"',
      'approval:',
      'approved_by: ""',
      'approved_at: ""',
    ].join('\n'), {
      ticketId: TICKET_ID,
      interviewContent,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.product.problem_statement).toBe('Ship a deterministic planning pipeline.')
    expect(result.value.scope.in_scope).toEqual(['Prompt hardening'])
    expect(result.value.epics[0]?.user_stories[0]?.verification.required_commands).toEqual(['npm run test:server'])
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Canonicalized source_interview.content_sha256')
  })

  it('rejects non-object PRD payloads', () => {
    const result = normalizePrdYamlOutput('"prd"', {
      ticketId: TICKET_ID,
      interviewContent: buildInterviewContent(TICKET_ID, { prompt: 'Which workflow guardrails are mandatory?', answer: 'Keep the council flow intact.' }),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('YAML/JSON object')
  })

  it('keeps rejecting PRD payloads that are missing epics', () => {
    const result = normalizePrdYamlOutput([
      'schema_version: 1',
      'artifact: "prd"',
      'product:',
      '  problem_statement: "Ship a deterministic planning pipeline."',
      'scope:',
      '  in_scope:',
      '    - "Prompt hardening"',
      'technical_requirements:',
      '  architecture_constraints:',
      '    - "Shared validator layer"',
      'risks:',
      '  - "Incomplete plans can block delivery"',
    ].join('\n'), {
      ticketId: TICKET_ID,
      interviewContent: buildInterviewContent(TICKET_ID, { prompt: 'Which workflow guardrails are mandatory?', answer: 'Keep the council flow intact.' }),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('missing epics')
  })

  it('repairs duplicate and missing PRD ids deterministically', () => {
    const result = normalizePrdYamlOutput([
      '```yaml',
      'schema_version: 1',
      'artifact: "prd"',
      'status: "draft"',
      'product:',
      '  problem_statement: "Ship a deterministic planning pipeline."',
      '  target_users:',
      '    - "Maintainers"',
      'scope:',
      '  in_scope:',
      '    - "Prompt hardening"',
      '  out_of_scope: []',
      'technical_requirements:',
      '  architecture_constraints:',
      '    - "Shared validator layer"',
      '  data_model: []',
      '  api_contracts: []',
      '  security_constraints: []',
      '  performance_constraints: []',
      '  reliability_constraints: []',
      '  error_handling_rules: []',
      '  tooling_assumptions: []',
      'epics:',
      '  - id: "EPIC-1"',
      '    title: "First epic"',
      '    objective: "Cover the first slice."',
      '    implementation_steps: []',
      '    user_stories:',
      '      - id: "US-1"',
      '        title: "First story"',
      '        acceptance_criteria: []',
      '        implementation_steps: []',
      '        verification:',
      '          required_commands: []',
      '  - title: "Second epic"',
      '    objective: "Cover the second slice."',
      '    implementation_steps: []',
      '    user_stories:',
      '      - id: "US-1"',
      '        title: "Second story"',
      '        acceptance_criteria: []',
      '        implementation_steps: []',
      '        verification:',
      '          required_commands: []',
      '```',
    ].join('\n'), {
      ticketId: TICKET_ID,
      interviewContent: buildInterviewContent(TICKET_ID, { prompt: 'Which workflow guardrails are mandatory?', answer: 'Keep the council flow intact.' }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.value.epics.map((epic) => epic.id)).toEqual(['EPIC-1', 'EPIC-2'])
    expect(result.value.epics.flatMap((epic) => epic.user_stories.map((story) => story.id))).toEqual(['US-1', 'US-2-1'])
    expect(result.repairWarnings.join('\n')).toContain('Epic at index 1 was missing id')
    expect(result.repairWarnings.join('\n')).toContain('duplicate user story id US-1')
  })

  it('trims trailing terminal noise from complete PRD JSON output', () => {
    const interviewContent = buildInterviewContent(TICKET_ID)

    const result = normalizePrdYamlOutput(`${JSON.stringify({
      schema_version: 1,
      ticket_id: TICKET_ID,
      artifact: 'prd',
      status: 'draft',
      source_interview: {
        content_sha256: 'stale-hash',
      },
      product: {
        problem_statement: 'Ship a deterministic planning pipeline.',
        target_users: ['Maintainers'],
      },
      scope: {
        in_scope: ['Prompt hardening'],
        out_of_scope: ['Execution changes'],
      },
      technical_requirements: {
        architecture_constraints: ['Shared validator layer'],
        data_model: [],
        api_contracts: [],
        security_constraints: [],
        performance_constraints: [],
        reliability_constraints: [],
        error_handling_rules: [],
        tooling_assumptions: [],
      },
      epics: [
        {
          id: 'EPIC-1',
          title: 'Harden structured output',
          objective: 'Prevent format-only model mistakes from blocking tickets.',
          implementation_steps: ['Add validators'],
          user_stories: [
            {
              id: 'US-1',
              title: 'Validate interview and PRD artifacts',
              acceptance_criteria: ['Structured artifacts are normalized before save'],
              implementation_steps: ['Reuse shared repair helpers'],
              verification: {
                required_commands: ['npm run test:server'],
              },
            },
          ],
        },
      ],
      risks: ['Permissive repairs could hide semantic issues'],
      approval: {
        approved_by: '',
        approved_at: '',
      },
    })}[e~[`, {
      ticketId: TICKET_ID,
      interviewContent,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Trimmed trailing terminal noise')
    expect(result.value.epics[0]?.id).toBe('EPIC-1')
    expect(result.value.epics[0]?.user_stories[0]?.id).toBe('US-1')
  })

  it('trims trailing terminal noise glued to the last scalar in PRD YAML output', () => {
    const interviewContent = buildInterviewContent(TICKET_ID, { prompt: 'What should the planner do?' })

    const result = normalizePrdYamlOutput(buildStandardPrdYaml({
      ticketId: TICKET_ID,
      suffix: '[e~[',
    }), {
      ticketId: TICKET_ID,
      interviewContent,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Trimmed trailing terminal noise')
    expect(result.value.epics[0]?.id).toBe('EPIC-1')
    expect(result.value.epics[0]?.user_stories[0]?.id).toBe('US-1')
  })

  it('repairs PRD YAML that needs both trailing-noise trimming and scalar quoting', () => {
    const interviewContent = buildInterviewContent(TICKET_ID)

    const result = normalizePrdYamlOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "prd"',
      'status: "draft"',
      'source_interview:',
      '  content_sha256: "stale-hash"',
      'product:',
      '  problem_statement: Build theme: pink option',
      '  target_users:',
      '    - "Maintainers"',
      'scope:',
      '  in_scope:',
      '    - "Prompt hardening"',
      '  out_of_scope:',
      '    - "Execution changes"',
      'technical_requirements:',
      '  architecture_constraints:',
      '    - "Shared validator layer"',
      '  data_model: []',
      '  api_contracts: []',
      '  security_constraints: []',
      '  performance_constraints: []',
      '  reliability_constraints: []',
      '  error_handling_rules: []',
      '  tooling_assumptions: []',
      'epics:',
      '  - id: "EPIC-1"',
      '    title: "Harden structured output"',
      '    objective: "Prevent format-only model mistakes from blocking tickets."',
      '    implementation_steps:',
      '      - "Add validators"',
      '    user_stories:',
      '      - id: "US-1"',
      '        title: "Validate interview and PRD artifacts"',
      '        acceptance_criteria:',
      '          - "Structured artifacts are normalized before save"',
      '        implementation_steps:',
      '          - "Reuse shared repair helpers"',
      '        verification:',
      '          required_commands:',
      '            - "npm run test:server"',
      'risks:',
      '  - "Permissive repairs could hide semantic issues"',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""[e~[',
    ].join('\n'), {
      ticketId: TICKET_ID,
      interviewContent,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Trimmed trailing terminal noise')
    expect(result.value.product.problem_statement).toBe('Build theme: pink option')
    expect(result.value.epics[0]?.user_stories[0]?.id).toBe('US-1')
  })

  it('accepts PRD normalization even when the source interview contains skipped questions', () => {
    const result = normalizePrdYamlOutput(buildStandardPrdYaml({
      sourceHash: false,
      epicTitle: 'First epic',
      epicObjective: 'Cover the first slice.',
      epicSteps: [],
      storyTitle: 'First story',
      storyAcceptanceCriteria: [],
      storySteps: [],
      storyVerificationCommands: [],
      outOfScope: [],
      risksText: false,
      includeApproval: false,
    }), {
      ticketId: TICKET_ID,
      interviewContent: buildInterviewContent(TICKET_ID, { skipped: true, prompt: 'Which fallback path should we use?' }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.epics).toHaveLength(1)
  })

  it('normalizes bead subset YAML and generates fallback ids when needed', () => {
    const result = normalizeBeadSubsetYamlOutput([
      'beads:',
      '  - title: Build shared repair layer',
      '    prdRefs: [EPIC-1 / US-1]',
      '    description: Normalize structured model output before validation.',
      '    contextGuidance:',
      '      Patterns:',
      '        - Keep repairs deterministic.',
      '      Anti-patterns:',
      '        - Do not widen the retry scope unnecessarily.',
      '    acceptanceCriteria:',
      '      - Repair only formatting issues',
      '    tests:',
      '      - Shared validator tests cover fences and wrappers',
      '    testCommands:',
      '      - npm run test:server',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.id).toBe('bead-1')
    expect(result.normalizedContent).toContain('beads:')
  })

  it('accepts bead subset YAML after repairing bare sequence item ids', () => {
    const result = normalizeBeadSubsetYamlOutput([
      'beads:',
      '  - config-xml-json-marshalling',
      '    title: Implement XML/JSON unmarshalling',
      '    prdRefs:',
      '      - EPIC-1 / US-1',
      '    description: Handle conflict resolution config values.',
      '    contextGuidance:',
      '      patterns:',
      '        - Keep parser repairs deterministic.',
      '      anti_patterns:',
      '        - Do not invent missing text.',
      '    acceptanceCriteria:',
      '      - Existing scalar text is moved into id.',
      '    tests:',
      '      - Parser regression covers bare id entries.',
      '    testCommands:',
      '      - npm run test:server',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.id).toBe('config-xml-json-marshalling')
    expect(result.repairWarnings).toContain(
      'Repaired YAML sequence entry under "beads" at line 2: treated bare item "config-xml-json-marshalling" as id before parsing.',
    )
  })

  it('still rejects repaired bead subset YAML when required content is missing', () => {
    const result = normalizeBeadSubsetYamlOutput([
      'beads:',
      '  - config-xml-json-marshalling',
      '    title: Implement XML/JSON unmarshalling',
      '    prdRefs:',
      '      - EPIC-1 / US-1',
      '    contextGuidance:',
      '      patterns:',
      '        - Keep parser repairs deterministic.',
      '      anti_patterns:',
      '        - Do not invent missing text.',
      '    acceptanceCriteria:',
      '      - Existing scalar text is moved into id.',
      '    tests:',
      '      - Parser regression covers bare id entries.',
      '    testCommands:',
      '      - npm run test:server',
    ].join('\n'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('bead description')
  })

  it('accepts bead subset YAML after repairing malformed quoted scalar items', () => {
    const result = normalizeBeadSubsetYamlOutput([
      'beads:',
      '  - id: bead-1',
      '    title: Tighten theme typing',
      '    prdRefs:',
      '      - EPIC-1 / US-1',
      '    description: Keep UIState theme values typed and explicit.',
      '    contextGuidance:',
      '      patterns:',
      '        - Keep UIState as the source of truth for theme values.',
      '      anti_patterns:',
      '        - Do not widen theme to string.',
      '    acceptanceCriteria:',
      "      - 'pink' is accepted as a valid theme value in UIState.",
      '    tests:',
      '      - Theme reducer tests cover the pink path.',
      '    testCommands:',
      '      - npm run test:server',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toContain('Repaired improperly quoted YAML scalar value.')
    expect(result.value[0]?.acceptanceCriteria).toEqual([
      '\'pink\' is accepted as a valid theme value in UIState.',
    ])
  })

  it('accepts bead subset YAML after repairing doubled single-quote scalar wrappers', () => {
    const result = normalizeBeadSubsetYamlOutput([
      'beads:',
      '  - id: bead-1',
      '    title: Tighten header validation',
      '    prdRefs:',
      '      - EPIC-1 / US-1',
      '    description: Keep header requirements as scalar text.',
      '    contextGuidance:',
      '      patterns:',
      '        - Keep parser repairs text-preserving.',
      '      anti_patterns:',
      '        - Do not invent missing fields.',
      '    acceptanceCriteria:',
      "      - ''Response includes Content-Disposition: attachment; filename=synonyms.json''",
      '    tests:',
      '      - Header parser regression covers doubled single quotes.',
      '    testCommands:',
      '      - npm run test:server',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairWarnings).toContain('Repaired improperly quoted YAML scalar value.')
    expect(result.value[0]?.acceptanceCriteria).toEqual([
      'Response includes Content-Disposition: attachment; filename=synonyms.json',
    ])
  })

  it('composes quoted-scalar and colon-scalar repairs for bead subset YAML', () => {
    const command = 'node -e "const fs=require(\'fs\');console.error(\'Missing pink tokens: \'+[\'accent\'].join(\',\'))"'
    const result = normalizeBeadSubsetYamlOutput([
      'beads:',
      '  - id: bead-1',
      '    title: Preserve visible text across combined parser repairs',
      '    prdRefs:',
      '      - EPIC-1 / US-1',
      '    description: Recover multiple safe YAML near-misses without changing their meaning.',
      '    contextGuidance:',
      '      patterns:',
      '        - Keep parser repairs text-preserving.',
      '      anti_patterns:',
      '        - Do not invent missing fields.',
      '    acceptanceCriteria:',
      "      - 'pink' is accepted as a valid theme value in UIState.",
      '      - Parser preserves the original visible scalar text.',
      '    tests:',
      '      - Combined parser regression covers malformed quoted list items plus command scalars.',
      '    testCommands:',
      `      - ${command}`,
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toContain('Repaired improperly quoted YAML scalar value.')
    expect(result.value[0]?.acceptanceCriteria).toEqual([
      '\'pink\' is accepted as a valid theme value in UIState.',
      'Parser preserves the original visible scalar text.',
    ])
    expect(result.value[0]?.testCommands).toEqual([command])
  })

  it('accepts bead subset YAML after escaping invalid double-quoted regex backslashes', () => {
    const command = 'git diff -- core/settings_model.go | grep -E \'^\\+(?!\\+\\+)\''
    const result = normalizeBeadSubsetYamlOutput([
      'beads:',
      '  - id: bead-1',
      '    title: Preserve regex commands in blueprint drafts',
      '    prdRefs:',
      '      - EPIC-1 / US-1',
      '    description: Keep regex-heavy verification commands parseable without changing their text.',
      '    contextGuidance:',
      '      patterns:',
      '        - Treat command strings as literal execution guidance.',
      '      anti_patterns:',
      '        - Do not infer replacement commands during parser repair.',
      '    acceptanceCriteria:',
      '      - Regex command text is preserved after YAML parsing.',
      '    tests:',
      '      - Parser regression covers invalid double-quoted YAML backslash escapes.',
      '    testCommands:',
      '      - "git diff -- core/settings_model.go | grep -E \'^\\+(?!\\+\\+)\'"',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toContain('Escaped invalid YAML double-quoted scalar backslash sequences before reparsing.')
    expect(result.value[0]?.testCommands).toEqual([command])
  })

  it('canonicalizes object-form bead context guidance into the runtime string format', () => {
    const result = normalizeBeadSubsetYamlOutput([
      'beads:',
      '  - id: bead-1',
      '    title: Harden retry repair flow',
      '    prdRefs: [EPIC-1, US-1-1]',
      '    description: Keep retry repairs deterministic.',
      '    contextGuidance:',
      '      patterns:',
      '        - Prefer structured retry prompts before widening context.',
      '        - Keep retry metadata attached to the companion artifact.',
      '      anti_patterns:',
      '        - Do not rewrite the whole artifact when a localized repair is enough.',
      '    acceptanceCriteria:',
      '      - Retry metadata survives normalization.',
      '    tests:',
      '      - Normalizer accepts repaired object-form guidance.',
      '    testCommands:',
      '      - npm run test:server',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.contextGuidance).toEqual({
      patterns: ['Prefer structured retry prompts before widening context.', 'Keep retry metadata attached to the companion artifact.'],
      anti_patterns: ['Do not rewrite the whole artifact when a localized repair is enough.'],
    })
  })

  it('canonicalizes inline string bead context guidance into the patterns/anti_patterns object', () => {
    const result = normalizeBeadSubsetYamlOutput([
      'beads:',
      '  - id: bead-1',
      '    title: Harden inline guidance repair',
      '    prdRefs: [EPIC-1, US-1-1]',
      '    description: Recover inline guidance labels from council drafts.',
      '    contextGuidance: "Patterns: update src/context/uiContextDef.ts as the single source of truth; keep SET_THEME typed from UIState theme; preserve the existing state shape. Anti-patterns: avoid duplicating theme unions in multiple files; avoid widening theme to string; avoid mixing runtime logic into this type-only bead."',
      '    acceptanceCriteria:',
      '      - Inline guidance is canonicalized to the runtime format.',
      '    tests:',
      '      - Normalizer accepts inline guidance labels from council drafts.',
      '    testCommands:',
      '      - npm run test:server',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toContain('Canonicalized inline string context guidance at index 0 into patterns/anti_patterns object.')
    expect(result.value[0]?.contextGuidance).toEqual({
      patterns: ['update src/context/uiContextDef.ts as the single source of truth; keep SET_THEME typed from UIState theme; preserve the existing state shape.'],
      anti_patterns: ['avoid duplicating theme unions in multiple files; avoid widening theme to string; avoid mixing runtime logic into this type-only bead.'],
    })
  })

  it('rejects malformed inline string bead context guidance', () => {
    const cases = [
      [
        'beads:',
        '  - id: bead-1',
        '    title: Missing anti-patterns',
        '    prdRefs: [EPIC-1, US-1-1]',
        '    description: Reject guidance missing the second section.',
        '    contextGuidance: "Patterns: keep repairs deterministic."',
        '    acceptanceCriteria:',
        '      - Missing anti-patterns is rejected.',
        '    tests:',
        '      - Validator returns an error.',
        '    testCommands:',
        '      - npm run test:server',
      ].join('\n'),
      [
        'beads:',
        '  - id: bead-1',
        '    title: Empty patterns section',
        '    prdRefs: [EPIC-1, US-1-1]',
        '    description: Reject inline guidance with an empty patterns section.',
        '    contextGuidance: "Patterns:   Anti-patterns: avoid widening the retry scope."',
        '    acceptanceCriteria:',
        '      - Empty patterns is rejected.',
        '    tests:',
        '      - Validator returns an error.',
        '    testCommands:',
        '      - npm run test:server',
      ].join('\n'),
      [
        'beads:',
        '  - id: bead-1',
        '    title: Reversed section order',
        '    prdRefs: [EPIC-1, US-1-1]',
        '    description: Reject inline guidance with reversed section order.',
        '    contextGuidance: "Anti-patterns: avoid widening the retry scope. Patterns: keep repairs deterministic."',
        '    acceptanceCriteria:',
        '      - Reversed labels are rejected.',
        '    tests:',
        '      - Validator returns an error.',
        '    testCommands:',
        '      - npm run test:server',
      ].join('\n'),
    ]

    for (const content of cases) {
      const result = normalizeBeadSubsetYamlOutput(content)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error).toContain('must include both Patterns and Anti-patterns sections')
    }
  })

  it('accepts labeled alternative-draft references in bead refinement inspiration', () => {
    const result = normalizeBeadSubsetYamlOutput([
      'beads:',
      '  - id: bead-1',
      '    title: Build shared repair layer',
      '    prdRefs: [EPIC-1 / US-1]',
      '    description: Normalize structured model output before validation.',
      '    contextGuidance:',
      '      Patterns:',
      '        - Keep repairs deterministic.',
      '      Anti-patterns:',
      '        - Do not collapse distinct bead dependencies.',
      '    acceptanceCriteria:',
      '      - Repair only formatting issues',
      '    tests:',
      '      - Shared validator tests cover fences and wrappers',
      '    testCommands:',
      '      - npm run test:server',
      'changes:',
      '  - type: added',
      '    item_type: bead',
      '    before: null',
      '    after:',
      '      id: bead-1',
      '      title: Build shared repair layer',
      '    inspiration:',
      '      alternative_draft: Alternative Draft 2',
      '      item:',
      '        id: bead-9',
      '        title: Validate refinement attribution',
    ].join('\n'), [
      { memberId: 'openai/gpt-5-mini' },
      { memberId: 'openai/gpt-5.4' },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.changes).toEqual([
      {
        type: 'added',
        itemType: 'bead',
        before: null,
        after: {
          id: 'bead-1',
          label: 'Build shared repair layer',
        },
        inspiration: {
          draftIndex: 1,
          memberId: 'openai/gpt-5.4',
          item: {
            id: 'bead-9',
            label: 'Validate refinement attribution',
          },
        },
        attributionStatus: 'inspired',
      },
    ])
  })

  it('accepts bead JSON arrays and rejects invalid dependencies', () => {
    const valid = normalizeBeadsJsonlOutput(JSON.stringify([
      {
        id: 'bead-1',
        title: 'First bead',
        prdRefs: ['EPIC-1 / US-1'],
        description: 'Do the first step.',
        contextGuidance: [
          'Patterns:',
          '- Keep the bead narrowly scoped.',
          'Anti-patterns:',
          '- Do not depend on unrelated files.',
        ].join('\n'),
        acceptanceCriteria: ['done'],
        tests: ['test'],
        testCommands: ['npm run test'],
        priority: 1,
        status: 'pending',
        labels: [],
        dependencies: [],
        targetFiles: [],
        notes: [],
        iteration: 1,
        createdAt: '',
        updatedAt: '',
        beadStartCommit: null,
        estimatedComplexity: 'moderate',
        epicId: 'EPIC-1',
        storyId: 'US-1',
      },
    ]))

    expect(valid.ok).toBe(true)

    const inlineGuidance = normalizeBeadsJsonlOutput(JSON.stringify([
      {
        id: 'bead-inline',
        title: 'Inline guidance bead',
        prdRefs: ['EPIC-1 / US-1'],
        description: 'Recover inline guidance in expanded bead validation.',
        contextGuidance: 'Patterns: keep the bead narrowly scoped. Anti-patterns: do not depend on unrelated files.',
        acceptanceCriteria: ['done'],
        tests: ['test'],
        testCommands: ['npm run test'],
        priority: 1,
        status: 'pending',
        labels: [],
        dependencies: [],
        targetFiles: [],
        notes: [],
        iteration: 1,
        createdAt: '',
        updatedAt: '',
        beadStartCommit: null,
        estimatedComplexity: 'moderate',
        epicId: 'EPIC-1',
        storyId: 'US-1',
      },
    ]))

    expect(inlineGuidance.ok).toBe(true)
    if (!inlineGuidance.ok) return
    expect(inlineGuidance.repairApplied).toBe(true)
    expect(inlineGuidance.repairWarnings).toContain('Canonicalized inline string context guidance at index 0 into patterns/anti_patterns object.')
    expect(inlineGuidance.value[0]?.contextGuidance).toEqual({
      patterns: ['keep the bead narrowly scoped.'],
      anti_patterns: ['do not depend on unrelated files.'],
    })

    const invalid = normalizeBeadsJsonlOutput(JSON.stringify([
      {
        id: 'bead-1',
        title: 'Broken bead',
        prdRefs: ['EPIC-1 / US-1'],
        description: 'Bad dependencies.',
        contextGuidance: [
          'Patterns:',
          '- Keep the bead narrowly scoped.',
          'Anti-patterns:',
          '- Do not depend on unrelated files.',
        ].join('\n'),
        acceptanceCriteria: ['done'],
        tests: ['test'],
        testCommands: ['npm run test'],
        priority: 1,
        status: 'pending',
        labels: [],
        dependencies: ['bead-1'],
        targetFiles: [],
        notes: [],
        iteration: 1,
        createdAt: '',
        updatedAt: '',
        beadStartCommit: null,
        estimatedComplexity: 'moderate',
        epicId: 'EPIC-1',
        storyId: 'US-1',
      },
    ]))

    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.error).toContain('self-dependency')
  })

  it('parses the shared coverage result envelope', () => {
    const result = normalizeCoverageResultOutput([
      'status: gaps',
      'gaps:',
      '  - Missing rollback behavior',
      'follow_up_questions:',
      '  - id: FU1',
      '    question: What should happen when validation fails?',
      '    phase: Assembly',
      '    priority: high',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe('gaps')
    expect(result.value.followUpQuestions[0]?.id).toBe('FU1')
  })

  it('adds missing list markers to quoted coverage gaps without changing their text', () => {
    const result = normalizeCoverageResultOutput([
      'status: gaps',
      'gaps:',
      '  "Q04 answer is truncated to only \'Use\' — no color specifications were provided by the source."',
      '  "The done criterion lacks concrete verification guidance."',
      'follow_up_questions: []',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toContain('Repaired malformed coverage gap list items before reparsing.')
    expect(result.value.gaps).toEqual([
      "Q04 answer is truncated to only 'Use' — no color specifications were provided by the source.",
      'The done criterion lacks concrete verification guidance.',
    ])
  })

  it('trims orphan trailing closing fences from coverage results recovered via top-level hints', () => {
    const result = normalizeCoverageResultOutput([
      'Coverage result:',
      'status: gaps',
      'gaps:',
      '  - Missing rollback behavior',
      'follow_up_questions:',
      '  - id: FU1',
      '    question: What should happen when validation fails?',
      '    phase: Assembly',
      '    priority: high',
      '```',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('orphan trailing closing code fence')
    expect(result.value.followUpQuestions[0]?.id).toBe('FU1')
  })

  it('recovers a complete coverage artifact before an orphan closing fence and commentary', () => {
    const result = normalizeCoverageResultOutput([
      'status: clean',
      'gaps: []',
      'follow_up_questions: []',
      '```',
      'All source answers are covered by the artifact above.',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ status: 'clean', gaps: [], followUpQuestions: [] })
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toContain(
      'Trimmed an orphan trailing closing code fence and commentary after the complete coverage artifact.',
    )
  })

  it('normalizes string-based coverage follow-up questions', () => {
    const result = normalizeCoverageResultOutput([
      'status: gaps',
      'gaps:',
      '  - Missing rollback behavior',
      'follow_up_questions:',
      '  - What should happen when validation fails?',
      '  - Which fallback path should we use?',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.followUpQuestions).toEqual([
      {
        id: 'FU1',
        question: 'What should happen when validation fails?',
      },
      {
        id: 'FU2',
        question: 'Which fallback path should we use?',
      },
    ])
  })

  it('normalizes mixed coverage follow-up question shapes', () => {
    const result = normalizeCoverageResultOutput([
      'status: gaps',
      'gaps:',
      '  - Missing rollback behavior',
      'follow_up_questions:',
      '  - id: FU9',
      '    question: What should happen when validation fails?',
      '    phase: Assembly',
      '  - Which fallback path should we use?',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.followUpQuestions).toEqual([
      {
        id: 'FU9',
        question: 'What should happen when validation fails?',
        phase: 'Assembly',
      },
      {
        id: 'FU2',
        question: 'Which fallback path should we use?',
      },
    ])
  })

  it('repairs malformed coverage gap scalars that begin with backticks via the shared parser fix', () => {
    const result = normalizeCoverageResultOutput([
      'status: gaps',
      'gaps:',
      '  - Missing rollback behavior',
      '  - `repo_git_mutex` behavior is undefined, including exact serialized operations, timeout thresholds, retry policy, workspace preservation on timeout, and required manual recovery surface.',
      'follow_up_questions: []',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toEqual([
      'Quoted plain YAML scalars that began with reserved indicator characters (` or @) before reparsing.',
    ])
    expect(result.value.gaps).toEqual([
      'Missing rollback behavior',
      '`repo_git_mutex` behavior is undefined, including exact serialized operations, timeout thresholds, retry policy, workspace preservation on timeout, and required manual recovery surface.',
    ])
    expect(result.value.followUpQuestions).toEqual([])
  })

  it('repairs malformed coverage gap scalars without changing structured follow-up question objects', () => {
    const result = normalizeCoverageResultOutput([
      'status: gaps',
      'gaps:',
      '  - `repo_git_mutex` behavior is undefined and must be clarified.',
      'follow_up_questions:',
      '  - id: FU1',
      '    question: Which operations must the mutex serialize?',
      '    phase: Assembly',
      '    priority: high',
      '    rationale: Lock the mutex scope before PRD generation.',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.value.gaps).toEqual([
      '`repo_git_mutex` behavior is undefined and must be clarified.',
    ])
    expect(result.value.followUpQuestions).toEqual([
      {
        id: 'FU1',
        question: 'Which operations must the mutex serialize?',
        phase: 'Assembly',
        priority: 'high',
        rationale: 'Lock the mutex scope before PRD generation.',
      },
    ])
  })

  it('trims trailing terminal noise from coverage envelopes', () => {
    const result = normalizeCoverageResultOutput([
      'status: clean',
      'gaps: []',
      'follow_up_questions: [][e~[',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Trimmed trailing terminal noise')
    expect(result.value.status).toBe('clean')
    expect(result.value.gaps).toEqual([])
    expect(result.value.followUpQuestions).toEqual([])
  })

  it('recovers interview questions with backtick scalars via loose parser fallback', () => {
    const result = normalizeInterviewQuestionsOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: `repo_git_mutex` behavior?',
    ].join('\n'), 5)

    // YAML rejects backtick scalars, but the loose parser recovers the question
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questions).toHaveLength(1)
    expect(result.value.questions[0]!.question).toContain('repo_git_mutex')
  })

  it('auto-repairs duplicate question ids by renumbering above the max', () => {
    const result = normalizeInterviewQuestionsOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem?"',
      '  - id: Q02',
      '    phase: foundation',
      '    question: "Who is the user?"',
      '  - id: Q01',
      '    phase: structure',
      '    question: "What features?"',
      '  - id: Q02',
      '    phase: assembly',
      '    question: "Edge cases?"',
    ].join('\n'), 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.some(w => w.includes('Renumbered duplicate question id'))).toBe(true)
    // First occurrences keep their IDs, duplicates get Q03 and Q04
    const ids = result.value.questions.map(q => q.id)
    expect(ids).toContain('Q01')
    expect(ids).toContain('Q02')
    expect(ids).toContain('Q03')
    expect(ids).toContain('Q04')
    expect(result.value.questionCount).toBe(4)
  })

  it('keeps original ids when no duplicates exist', () => {
    const result = normalizeInterviewQuestionsOutput([
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    question: "What problem?"',
      '  - id: Q02',
      '    phase: structure',
      '    question: "What features?"',
    ].join('\n'), 10)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairWarnings.filter(w => w.includes('Renumbered'))).toHaveLength(0)
    expect(result.value.questions.map(q => q.id)).toEqual(['Q01', 'Q02'])
  })

  it('normalizes PROM4 batch envelopes with wrapper noise and indentation repair', () => {
    const result = normalizeInterviewTurnOutput([
      '[assistant] <INTERVIEW_BATCH>',
      '```yaml',
      'payload:',
      '  batchNumber: "2"',
      '  progress:',
      '   current: "4"',
      '   total: "6"',
      '  isFinalFreeForm: false',
      '  aiCommentary: Ask the missing edge-case questions now.',
      '  questions:',
      '   - id: Q04',
      '     prompt: What happens when the cluster restarts?',
      '     category: structure',
      '     priority: HIGH',
      '     rationale: Capture resilience expectations.',
      '```',
      '</INTERVIEW_BATCH>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('batch')
    if (result.value.kind !== 'batch') return
    expect(result.value.batch.batchNumber).toBe(2)
    expect(result.value.batch.questions[0]).toMatchObject({
      id: 'Q04',
      question: 'What happens when the cluster restarts?',
      phase: 'Structure',
      priority: 'high',
    })
  })

  it('truncates interview batches with more than 3 questions to first 3', () => {
    const result = normalizeInterviewTurnOutput([
      '<INTERVIEW_BATCH>',
      'batch_number: 1',
      'progress:',
      '  current: 0',
      '  total: 5',
      'questions:',
      '  - id: Q01',
      '    question: "Question one?"',
      '  - id: Q02',
      '    question: "Question two?"',
      '  - id: Q03',
      '    question: "Question three?"',
      '  - id: Q04',
      '    question: "Question four?"',
      '  - id: Q05',
      '    question: "Question five?"',
      '</INTERVIEW_BATCH>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('batch')
    if (result.value.kind !== 'batch') return
    expect(result.value.batch.questions).toHaveLength(3)
    expect(result.value.batch.questions.map((q) => q.id)).toEqual(['Q01', 'Q02', 'Q03'])
  })

  it('does not treat exact envelopes as parser repairs', () => {
    const noRepairCases = [
      () => normalizeInterviewTurnOutput([
        '<INTERVIEW_BATCH>',
        'batch_number: 1',
        'progress:',
        '  current: 0',
        '  total: 2',
        'questions:',
        '  - id: Q01',
        '    question: "What is the primary goal?"',
        '</INTERVIEW_BATCH>',
      ].join('\n')),
      () => normalizeBeadCompletionMarkerOutput([
        '<BEAD_STATUS>',
        'bead_id: bead-plain',
        'status: done',
        'checks:',
        '  tests: pass',
        '  lint: pass',
        '  typecheck: pass',
        '  qualitative: pass',
        '</BEAD_STATUS>',
      ].join('\n')),
      () => normalizeFinalTestCommandsOutput([
        '<FINAL_TEST_COMMANDS>',
        'commands:',
        '  - npm run test:server',
        'summary: verify the whole workflow',
        '</FINAL_TEST_COMMANDS>',
      ].join('\n')),
    ]

    for (const normalize of noRepairCases) {
      const result = normalize()
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.repairApplied).toBe(false)
      expect(result.repairWarnings).toEqual([])
    }
  })

  it('normalizes PROM4 complete envelopes with transcript prefixes', () => {
    const result = normalizeInterviewTurnOutput([
      '[assistant] <INTERVIEW_COMPLETE>',
      '```yaml',
      'interview:',
      '  schema_version: 1',
      '  artifact: interview',
      '  questions:',
      '    - id: Q01',
      '      prompt: What is the goal?',
      '  approval:',
      '    approved_by: ""',
      '    approved_at: ""',
      '```',
      '</INTERVIEW_COMPLETE>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('complete')
    if (result.value.kind !== 'complete') return
    expect(result.value.finalYaml).toContain('schema_version: 1')
    expect(result.value.finalYaml).toContain('artifact: interview')
  })

  it('normalizes PROM4 complete envelopes that use answer audit entries', () => {
    const result = normalizeInterviewTurnOutput([
      '<INTERVIEW_COMPLETE>',
      '---',
      'ticket_id: "LOOTR-5"',
      'status: "complete"',
      'answers:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    question: "What is the goal?"',
      '    answer: "Accuracy"',
      '    status: "answered"',
      'derived_findings:',
      '  primary_consumer: "interview"',
      '</INTERVIEW_COMPLETE>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('complete')
    if (result.value.kind !== 'complete') return
    expect(result.repairApplied).toBe(false)
    expect(result.repairWarnings).toEqual([])
    expect(result.value.finalYaml).toContain('ticket_id: LOOTR-5')
    expect(result.value.finalYaml).toContain('answers:')
    expect(result.value.finalYaml).toContain('derived_findings:')
  })

  it('records a single transcript recovery warning for wrapped interview batch envelopes', () => {
    const result = normalizeInterviewTurnOutput([
      '[assistant] <INTERVIEW_BATCH>',
      'batch_number: 2',
      'progress:',
      '  current: 1',
      '  total: 3',
      'questions:',
      '  - id: Q02',
      '    question: "What happens on rollback?"',
      '</INTERVIEW_BATCH>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toEqual([
      'Recovered the structured artifact from surrounding transcript or wrapper text before validation.',
    ])
  })

  it('normalizes BEAD_STATUS markers with YAML payloads and gate aliases', () => {
    const result = normalizeBeadCompletionMarkerOutput([
      'work done',
      '<BEAD_STATUS>',
      '```yaml',
      'beadStatus:',
      '  beadId: bead-1',
      '  status: done',
      '  gates:',
      '    test: passed',
      '    lint: ok',
      '    type_check: success',
      '    qualitative_review: true',
      '```',
      '</BEAD_STATUS>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      beadId: 'bead-1',
      status: 'done',
      checks: {
        tests: 'pass',
        lint: 'pass',
        typecheck: 'pass',
        qualitative: 'pass',
      },
    })
  })

  it('repairs dedented completion checks under BEAD_STATUS markers', () => {
    const result = normalizeBeadCompletionMarkerOutput([
      '<BEAD_STATUS>',
      'bead_id: bead-2',
      'status: completed',
      'checks:',
      'tests: pass',
      'lint: pass',
      'typecheck: pass',
      'qualitative: pass',
      '</BEAD_STATUS>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      beadId: 'bead-2',
      status: 'done',
      checks: {
        tests: 'pass',
        lint: 'pass',
        typecheck: 'pass',
        qualitative: 'pass',
      },
    })
    expect(result.repairApplied).toBe(true)
  })

  it('records a single markdown fence warning for exact BEAD_STATUS envelopes with fenced YAML', () => {
    const result = normalizeBeadCompletionMarkerOutput([
      '<BEAD_STATUS>',
      '```yaml',
      'bead_id: bead-fenced',
      'status: done',
      'checks:',
      '  tests: pass',
      '  lint: pass',
      '  typecheck: pass',
      '  qualitative: pass',
      '```',
      '</BEAD_STATUS>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toEqual([
      'Unwrapped markdown code fence wrapping the YAML payload.',
    ])
  })

  it('normalizes FINAL_TEST_COMMANDS markers and single-string commands', () => {
    const result = normalizeFinalTestCommandsOutput([
      '[assistant] <FINAL_TEST_COMMANDS>',
      '```yaml',
      'command_plan:',
      '  commands: npm run test:server',
      '  summary: verify the whole workflow',
      '```',
      '</FINAL_TEST_COMMANDS>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      commands: ['npm run test:server'],
      summary: 'verify the whole workflow',
      testFiles: [],
      modifiedFiles: [],
      fileEffects: [],
      testsCount: null,
    })
  })

  it('normalizes FINAL_TEST_COMMANDS file effects and preserves legacy candidate mapping', () => {
    const result = normalizeFinalTestCommandsOutput([
      '<FINAL_TEST_COMMANDS>',
      'commands:',
      '  - npm run test:server',
      'modified_files:',
      '  - tests/final.spec',
      'file_effects:',
      '  - path: tests/final.spec',
      '    intent: candidate',
      '  - path: tmp/output.log',
      '    intent: temporary',
      '    reason: created by test command',
      '</FINAL_TEST_COMMANDS>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.fileEffects).toEqual([
      { path: 'tests/final.spec', intent: 'candidate' },
      { path: 'tmp/output.log', intent: 'temporary', reason: 'created by test command' },
    ])
  })

  it('records a single wrapper-key warning for exact FINAL_TEST_COMMANDS envelopes with wrapper objects', () => {
    const result = normalizeFinalTestCommandsOutput([
      '<FINAL_TEST_COMMANDS>',
      'command_plan:',
      '  commands:',
      '    - npm run test:server',
      '  summary: verify the whole workflow',
      '</FINAL_TEST_COMMANDS>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings).toEqual([
      'Removed wrapper key "command_plan" from top level.',
    ])
  })

  it('normalizes tagged relevant-files payloads', () => {
    const result = normalizeRelevantFilesOutput([
      '<RELEVANT_FILES_RESULT>',
      'file_count: 1',
      'files:',
      '  - path: src/app.ts',
      '    rationale: Entry point for the app.',
      '    relevance: high',
      '    likely_action: modify',
      '    content: |',
      '      export const app = true',
      '</RELEVANT_FILES_RESULT>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(false)
    expect(result.repairWarnings).toEqual([])
    expect(result.value.file_count).toBe(1)
    expect(result.value.files[0]).toMatchObject({
      path: 'src/app.ts',
      rationale: 'Entry point for the app.',
      relevance: 'high',
      likely_action: 'modify',
    })
  })

  it('accepts relevant-files YAML after repairing bare file path sequence items', () => {
    const result = normalizeRelevantFilesOutput([
      '<RELEVANT_FILES_RESULT>',
      'file_count: 1',
      'files:',
      '  - src/app.ts',
      '    rationale: Entry point for the app.',
      '    relevance: high',
      '    likely_action: modify',
      '    content: |',
      '      export const app = true',
      '</RELEVANT_FILES_RESULT>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.files[0]?.path).toBe('src/app.ts')
    expect(result.repairWarnings.join('\n')).toContain(
      'Repaired YAML sequence entry under "files"',
    )
    expect(result.repairWarnings.join('\n')).toContain(
      'treated bare item "src/app.ts" as path before parsing.',
    )
  })

  it('repairs relevant-files payloads with transcript noise, fenced YAML, wrapper keys, aliases, and indentation drift', () => {
    const result = normalizeRelevantFilesOutput([
      '[assistant] <RELEVANT_FILES_RESULT>',
      '```yaml',
      'payload:',
      '  file_count: 1',
      '  files:',
      '    - filepath: src/routes.ts',
      '     reason: Central routing surface for the ticket.',
      '      relevance: HIGH',
      '     action: MODIFY',
      '     source: |',
      '       export const routes = []',
      '```',
      '</RELEVANT_FILES_RESULT>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.value.file_count).toBe(1)
    expect(result.value.files).toHaveLength(1)
    expect(result.value.files[0]).toMatchObject({
      path: 'src/routes.ts',
      rationale: 'Central routing surface for the ticket.',
      relevance: 'high',
      likely_action: 'modify',
    })
    expect(result.value.files[0]?.content).toContain('export const routes = []')
  })

  it.each([
    ['relevant-files', normalizeRelevantFilesOutput],
    ['final-test', normalizeFinalTestCommandsOutput],
    ['coverage', normalizeCoverageResultOutput],
  ] as const)('rejects %s prompt echoes with a clear validation error', (_label, normalize) => {
    const result = normalize([
      'CRITICAL OUTPUT RULE:',
      'Return strict machine-readable output.',
      '',
      'CONTEXT REFRESH:',
      'Use the latest ticket context.',
      '',
      '## System Role',
      'You are a senior test engineer.',
    ].join('\n'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('echoed the prompt')
  })

  it('rejects PRD prompt schema echoes with a clear validation error', () => {
    const interviewContent = buildInterviewContent(TICKET_ID, {
      skipped: true,
      prompt: 'Which fallback path should we use?',
    })
    const result = normalizePrdYamlOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "prd"',
      'status: "draft"',
      'source_interview:',
      '  content_sha256: "<sha256>"',
      'product:',
      '  problem_statement: "Ship a deterministic planning pipeline."',
      '  target_users:',
      '    - "Maintainers"',
      'scope:',
      '  in_scope:',
      '    - "Prompt hardening"',
      '  out_of_scope:',
      '    - "Execution changes"',
      'technical_requirements:',
      '  architecture_constraints:',
      '    - "Shared validator layer"',
      '  data_model: []',
      '  api_contracts: []',
      '  security_constraints: []',
      '  performance_constraints: []',
      '  reliability_constraints: []',
      '  error_handling_rules: []',
      '  tooling_assumptions: []',
      'epics:',
      '  - id: "EPIC-1"',
      '    title: "Harden structured output"',
      '    objective: "Prevent format-only model mistakes from blocking tickets."',
      '    implementation_steps:',
      '      - "Add validators"',
      '    user_stories:',
      '      - id: "US-1"',
      '        title: "Validate interview and PRD artifacts"',
      '        acceptance_criteria:',
      '          - "Structured artifacts are normalized before save"',
      '        implementation_steps:',
      '          - "Reuse shared repair helpers"',
      '        verification:',
      '          required_commands:',
      '            - "npm run test:server"',
      'risks:',
      '  - "Permissive repairs could hide semantic issues"',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
      '',
      '## Context',
      '### ticket_details',
      `# Ticket: ${TICKET_ID}`,
      'Keep PRD drafting strict.',
    ].join('\n'), {
      ticketId: TICKET_ID,
      interviewContent,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('echoed the prompt')
    expect(result.error).not.toContain('block mapping entry')
  })

  it('recovers complete file entries from a truncated response with no close tag', () => {
    // The last entry is cut off mid-key (no colon), causing YAML parse failure.
    // Truncation recovery removes the incomplete entry.
    const result = normalizeRelevantFilesOutput([
      '<RELEVANT_FILES_RESULT>',
      'file_count: 3',
      'files:',
      '  - path: src/app.ts',
      '    rationale: Entry point.',
      '    relevance: high',
      '    likely_action: modify',
      '    content: |',
      '      export const app = true',
      '  - path: src/utils.ts',
      '    rationale: Helper utilities.',
      '    relevance: medium',
      '    likely_action: read',
      '    content: |',
      '      export function help() {}',
      '  - path: src/broken.ts',
      '    rationale: This entry gets cut off.',
      '    relevance: high',
      '    likely_action: modify',
      '    content: |',
      '      import { foo } from "./foo"',
      '      export function broken() {',
      '    relev',
      // No closing tag — truncated mid-key, breaking YAML parsing
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.files).toHaveLength(2)
    expect(result.value.file_count).toBe(2)
    expect(result.value.files[0]?.path).toBe('src/app.ts')
    expect(result.value.files[1]?.path).toBe('src/utils.ts')
  })

  it('strips spurious </files> XML tag inside YAML and parses successfully', () => {
    const result = normalizeRelevantFilesOutput([
      '<RELEVANT_FILES_RESULT>',
      'file_count: 1',
      'files:',
      '  - path: src/app.ts',
      '    rationale: Entry point.',
      '    relevance: high',
      '    likely_action: modify',
      '    content: |',
      '      export const app = true',
      '</files>',
      '</RELEVANT_FILES_RESULT>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.files).toHaveLength(1)
    expect(result.value.files[0]?.path).toBe('src/app.ts')
  })

  it('strips both <files> and </files> wrappers inside YAML', () => {
    const result = normalizeRelevantFilesOutput([
      '<RELEVANT_FILES_RESULT>',
      'file_count: 1',
      '<files>',
      'files:',
      '  - path: src/app.ts',
      '    rationale: Entry point.',
      '    relevance: high',
      '    likely_action: modify',
      '    content: |',
      '      export const app = true',
      '</files>',
      '</RELEVANT_FILES_RESULT>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.files).toHaveLength(1)
    expect(result.value.files[0]?.path).toBe('src/app.ts')
  })

  it('preserves angle brackets in YAML string values and block scalars', () => {
    const result = normalizeRelevantFilesOutput([
      '<RELEVANT_FILES_RESULT>',
      'file_count: 1',
      'files:',
      '  - path: src/component.tsx',
      '    rationale: "Contains <div>Hello</div> JSX"',
      '    relevance: high',
      '    likely_action: modify',
      '    content: |',
      '      export default function App() {',
      '        return <div>Hello</div>',
      '      }',
      '</RELEVANT_FILES_RESULT>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.files[0]?.rationale).toContain('<div>Hello</div>')
    expect(result.value.files[0]?.content).toContain('<div>Hello</div>')
  })

  it('handles combined truncated output with spurious XML tags', () => {
    const result = normalizeRelevantFilesOutput([
      '<RELEVANT_FILES_RESULT>',
      'file_count: 3',
      '<files>',
      'files:',
      '  - path: src/app.ts',
      '    rationale: Entry point.',
      '    relevance: high',
      '    likely_action: modify',
      '    content: |',
      '      export const app = true',
      '  - path: src/utils.ts',
      '    rationale: Helpers.',
      '    relevance: medium',
      '    likely_action: read',
      '    content: |',
      '      export function help() {}',
      '  - path: src/broken.ts',
      '    rationale: Truncated entry.',
      '    relevance: high',
      '    likely_action: modify',
      '    content: |',
      '      import { x } from "./x"',
      '    relev',
      // No closing tags — truncated mid-key with spurious <files> tag
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.files).toHaveLength(2)
    expect(result.value.files[0]?.path).toBe('src/app.ts')
    expect(result.value.files[1]?.path).toBe('src/utils.ts')
  })

  it('repairs plain scalar rationale containing colon-space', () => {
    const result = normalizeRelevantFilesOutput([
      '<RELEVANT_FILES_RESULT>',
      'file_count: 2',
      'files:',
      '  - path: server/sse/broadcaster.ts',
      '    relevance: high',
      '    likely_action: modify',
      '    rationale: This is the live-stream backbone.',
      '    content_preview: |',
      '      class SSEBroadcaster {}',
      '  - path: server/machines/ticketMachine.ts',
      '    relevance: high',
      '    likely_action: modify',
      "    rationale: Many of the ticket's correctness rules are state-machine rules: completion truth gates, non-completion for idle/paused/interrupted, stop reasons, and authoritative transition sources.",
      '    content_preview: |',
      '      export const ticketMachine = setup({})',
      '</RELEVANT_FILES_RESULT>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.value.files).toHaveLength(2)
    expect(result.value.files[0]?.path).toBe('server/sse/broadcaster.ts')
    expect(result.value.files[1]?.path).toBe('server/machines/ticketMachine.ts')
    expect(result.value.files[1]?.rationale).toContain('state-machine rules: completion truth gates')
  })

  it('repairs multiple entries with colons in rationale values', () => {
    const result = normalizeRelevantFilesOutput([
      '<RELEVANT_FILES_RESULT>',
      'file_count: 3',
      'files:',
      '  - path: a.ts',
      '    rationale: Simple rationale.',
      '    relevance: high',
      '    likely_action: modify',
      '  - path: b.ts',
      '    rationale: Has colons: in the middle and again: here.',
      '    relevance: medium',
      '    likely_action: read',
      '  - path: c.ts',
      '    rationale: Also has key: value patterns and more: stuff here.',
      '    relevance: low',
      '    likely_action: read',
      '</RELEVANT_FILES_RESULT>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.files).toHaveLength(3)
    expect(result.value.files[1]?.rationale).toContain('Has colons: in the middle')
    expect(result.value.files[2]?.rationale).toContain('Also has key: value patterns')
  })

  it.each([
    ['mixed correct and incorrect', [
      'questions:',
      '  -id: Q1',
      '    phase: foundation',
      '    question: "What is the primary business goal?"',
      '  - id: Q2',
      '    phase: foundation',
      '    question: "Who are the primary users?"',
      '  -id: Q3',
      '    phase: structure',
      '    question: "What features are required?"',
    ], 3],
    ['all items missing dash space', [
      'questions:',
      '  -id: Q1',
      '    phase: foundation',
      '    question: "What problem are we solving?"',
      '  -id: Q2',
      '    phase: structure',
      '    question: "What features are needed?"',
    ], 2],
  ] as const)('repairs interview questions with %s items', (_, lines, expectedCount) => {
    const result = normalizeInterviewQuestionsOutput(lines.join('\n'), 10)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questions).toHaveLength(expectedCount)
  })

  it('normalizes yes_no answer_type to single_choice with Yes/No options in batch questions', () => {
    const result = normalizeInterviewTurnOutput([
      '<INTERVIEW_BATCH>',
      'batch_number: 1',
      'progress:',
      '  current: 1',
      '  total: 3',
      'is_final_free_form: false',
      'ai_commentary: "Testing yes_no type"',
      'questions:',
      '  - id: Q01',
      '    question: "Do you need authentication?"',
      '    phase: Foundation',
      '    priority: high',
      '    rationale: "Determines auth requirements"',
      '    answer_type: yes_no',
      '</INTERVIEW_BATCH>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('batch')
    if (result.value.kind !== 'batch') return
    const q = result.value.batch.questions[0]!
    expect(q.answerType).toBe('single_choice')
    expect(q.options).toEqual([
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ])
  })

  it.each([
    ['single_choice', 12, 10, 'Which database?', 'DB choice'],
    ['multiple_choice', 18, 15, 'Which platforms?', 'Platform choice'],
  ] as const)('truncates %s options exceeding the maximum of %d', (answerType, inputCount, maxCount, question, rationale) => {
    const options = Array.from({ length: inputCount }, (_, i) => `    - id: opt${i + 1}\n      label: "Option ${i + 1}"`)
    const result = normalizeInterviewTurnOutput([
      '<INTERVIEW_BATCH>',
      'batch_number: 1',
      'progress:',
      '  current: 1',
      '  total: 3',
      'is_final_free_form: false',
      'ai_commentary: "Testing option limits"',
      'questions:',
      '  - id: Q01',
      `    question: "${question}"`,
      '    phase: Foundation',
      '    priority: high',
      `    rationale: "${rationale}"`,
      `    answer_type: ${answerType}`,
      '    options:',
      ...options,
      '</INTERVIEW_BATCH>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('batch')
    if (result.value.kind !== 'batch') return
    expect(result.value.batch.questions[0]!.options).toHaveLength(maxCount)
  })

  it('downgrades single_choice to free_text when no options are provided', () => {
    const result = normalizeInterviewTurnOutput([
      '<INTERVIEW_BATCH>',
      'batch_number: 1',
      'progress:',
      '  current: 1',
      '  total: 3',
      'is_final_free_form: false',
      'ai_commentary: "Testing downgrade"',
      'questions:',
      '  - id: Q01',
      '    question: "Which database?"',
      '    phase: Foundation',
      '    priority: high',
      '    rationale: "DB choice"',
      '    answer_type: single_choice',
      '</INTERVIEW_BATCH>',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('batch')
    if (result.value.kind !== 'batch') return
    expect(result.value.batch.questions[0]!.answerType).toBeUndefined()
    expect(result.value.batch.questions[0]!.options).toBeUndefined()
  })

  it('keeps only the first duplicated options block across question artifacts', () => {
    const expectedOptions = [
      { id: 'opt1', label: 'Strict signatures, no allowlist' },
      { id: 'opt2', label: 'Strict signatures with allowlist' },
      { id: 'opt3', label: 'Conservative low-false-positive only' },
      { id: 'opt4', label: 'Warn only, never block' },
    ]
    const duplicatedOptionCases = [
      {
        normalize: () => normalizeInterviewTurnOutput([
          '<INTERVIEW_BATCH>',
          'batch_number: 12',
          'progress:',
          '  current: 12',
          '  total: 23',
          'is_final_free_form: false',
          'ai_commentary: "Testing duplicated options block"',
          'questions:',
          '  - id: Q25',
          '    question: "For obvious secret leak detection, what policy should apply at launch?"',
          '    phase: Assembly',
          '    priority: high',
          '    rationale: "This determines detector aggressiveness and whether teams can suppress known-safe matches."',
          '    answer_type: single_choice',
          '    options:',
          '      - id: opt1',
          '        label: "Strict signatures, no allowlist"',
          '      - id: opt2',
          '        label: "Strict signatures with allowlist"',
          '      - id: opt3',
          '        label: "Conservative low-false-positive only"',
          '      - id: opt4',
          '        label: "Warn only, never block"',
          '    options:',
          '      - id: opt1',
          '        label: "Strict signatures, no allowlist"',
          '      - id: opt2',
          '        label: "Strict signatures with allowlist"',
          '      - id: opt3',
          '        label: "Conservative low-false-positive only"',
          '      - id: opt4',
          '        label: "Warn only, never block"',
          '</INTERVIEW_BATCH>',
        ].join('\n')),
        assertOptions: (result: unknown) => {
          const parsed = result as StructuredOutputSuccess<InterviewTurnOutput>
          expect(parsed.value.kind).toBe('batch')
          if (parsed.value.kind !== 'batch') return
          expect(parsed.value.batch.questions[0]!.options).toEqual(expectedOptions)
        },
      },
      {
        normalize: () => normalizeCoverageResultOutput([
          'status: gaps',
          'gaps:',
          '  - "Missing secret detection policy"',
          'follow_up_questions:',
          '  - id: FU1',
          '    question: "What policy should apply at launch?"',
          '    phase: Assembly',
          '    priority: high',
          '    rationale: "Fix malformed duplicate options blocks."',
          '    answer_type: single_choice',
          '    options:',
          '      - id: opt1',
          '        label: "Strict signatures, no allowlist"',
          '      - id: opt2',
          '        label: "Strict signatures with allowlist"',
          '      - id: opt3',
          '        label: "Conservative low-false-positive only"',
          '      - id: opt4',
          '        label: "Warn only, never block"',
          '    options:',
          '      - id: opt1',
          '        label: "Strict signatures, no allowlist"',
          '      - id: opt2',
          '        label: "Strict signatures with allowlist"',
          '      - id: opt3',
          '        label: "Conservative low-false-positive only"',
          '      - id: opt4',
          '        label: "Warn only, never block"',
        ].join('\n')),
        assertOptions: (result: unknown) => {
          const parsed = result as StructuredOutputSuccess<CoverageResultEnvelope>
          expect(parsed.value.followUpQuestions[0]!.options).toEqual(expectedOptions)
        },
      },
    ]

    for (const testCase of duplicatedOptionCases) {
      const result = testCase.normalize()
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      testCase.assertOptions(result)
    }
  })

  it('dedupes duplicate option ids and surfaces repair warnings across question artifacts', () => {
    const dedupeCases = [
      {
        normalize: () => normalizeInterviewTurnOutput([
          '<INTERVIEW_BATCH>',
          'batch_number: 1',
          'progress:',
          '  current: 1',
          '  total: 3',
          'is_final_free_form: false',
          'ai_commentary: "Testing option dedupe"',
          'questions:',
          '  - id: Q01',
          '    question: "Which policy should apply?"',
          '    phase: Assembly',
          '    priority: high',
          '    rationale: "Dedupes duplicate ids."',
          '    answer_type: single_choice',
          '    options:',
          '      - id: opt1',
          '        label: "First"',
          '      - id: opt1',
          '        label: "Duplicate first"',
          '      - id: opt2',
          '        label: "Second"',
          '</INTERVIEW_BATCH>',
        ].join('\n')),
        assertResult: (result: unknown) => {
          const parsed = result as StructuredOutputSuccess<InterviewTurnOutput>
          expect(parsed.value.kind).toBe('batch')
          if (parsed.value.kind !== 'batch') return
          expect(parsed.value.batch.questions[0]!.options).toEqual([
            { id: 'opt1', label: 'First' },
            { id: 'opt2', label: 'Second' },
          ])
          expect(parsed.repairWarnings.join('\n')).toContain('Interview batch question Q01: removed duplicate option ids opt1')
        },
      },
      {
        normalize: () => normalizeCoverageResultOutput([
          'status: gaps',
          'gaps:',
          '  - "Missing selection policy"',
          'follow_up_questions:',
          '  - id: FU1',
          '    question: "Which policy should apply?"',
          '    phase: Assembly',
          '    priority: high',
          '    rationale: "Dedupes duplicate ids."',
          '    answer_type: single_choice',
          '    options:',
          '      - id: opt1',
          '        label: "First"',
          '      - id: opt1',
          '        label: "Duplicate first"',
          '      - id: opt2',
          '        label: "Second"',
        ].join('\n')),
        assertResult: (result: unknown) => {
          const parsed = result as StructuredOutputSuccess<CoverageResultEnvelope>
          expect(parsed.value.followUpQuestions[0]!.options).toEqual([
            { id: 'opt1', label: 'First' },
            { id: 'opt2', label: 'Second' },
          ])
          expect(parsed.repairWarnings.join('\n')).toContain('Coverage follow-up question FU1: removed duplicate option ids opt1')
        },
      },
    ]

    for (const testCase of dedupeCases) {
      const result = testCase.normalize()
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.repairApplied).toBe(true)
      testCase.assertResult(result)
    }
  })

  it('normalizes coverage follow-up questions with answer types', () => {
    const result = normalizeCoverageResultOutput([
      'status: gaps',
      'gaps:',
      '  - "Missing auth details"',
      'follow_up_questions:',
      '  - id: FU1',
      '    question: "Do you need OAuth?"',
      '    phase: Foundation',
      '    priority: high',
      '    rationale: "Auth gap"',
      '    answer_type: yes_no',
      '  - id: FU2',
      '    question: "Which platforms to support?"',
      '    phase: Structure',
      '    priority: medium',
      '    rationale: "Platform gap"',
      '    answer_type: multiple_choice',
      '    options:',
      '      - id: web',
      '        label: "Web"',
      '      - id: ios',
      '        label: "iOS"',
      '      - id: android',
      '        label: "Android"',
    ].join('\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.followUpQuestions).toHaveLength(2)
    expect(result.value.followUpQuestions[0]).toMatchObject({
      id: 'FU1',
      question: 'Do you need OAuth?',
      answerType: 'single_choice',
      options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    })
    expect(result.value.followUpQuestions[1]).toMatchObject({
      id: 'FU2',
      question: 'Which platforms to support?',
      answerType: 'multiple_choice',
      options: [
        { id: 'web', label: 'Web' },
        { id: 'ios', label: 'iOS' },
        { id: 'android', label: 'Android' },
      ],
    })
  })

  it('normalizes interview documents, repairs yes/no answers, and syncs the final free-form summary', () => {
    const result = normalizeInterviewDocumentOutput([
      'schema_version: 1',
      'artifact: interview_results',
      'generated_by:',
      '  winner_model: openai/gpt-5',
      '  generated_at: 2026-03-20T10:00:00.000Z',
      'questions:',
      '  - id: Q01',
      '    phase: foundation',
      '    prompt: Should retries be visible?',
      '    source: compiled',
      '    answer_type: yes_no',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: [yes]',
      '      free_text: ""',
      '  - id: FINAL',
      '    phase: assembly',
      '    prompt: Anything else the team should know?',
      '    source: final_free_form',
      '    answer_type: free_text',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Keep retries reviewable.',
      'summary:',
      '  goals: [Protect imports]',
      '  constraints: [No duplicate records]',
      '  non_goals: [Bulk reprocessing]',
      '  final_free_form_answer: stale summary text',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n'), {
      ticketId: TICKET_ID,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.ticket_id).toBe(TICKET_ID)
    expect(result.value.artifact).toBe('interview')
    expect(result.value.questions[0]?.answer_type).toBe('single_choice')
    expect(result.value.questions[0]?.options).toEqual([
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ])
    expect(result.value.summary.final_free_form_answer).toBe('Keep retries reviewable.')
    expect(result.repairApplied).toBe(true)
  })

  it('trims orphan trailing closing fences from interview documents recovered via top-level hints', () => {
    const result = normalizeInterviewDocumentOutput([
      'Corrected interview artifact:',
      'schema_version: 1',
      `ticket_id: ${TICKET_ID}`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: openai/gpt-5',
      '  generated_at: 2026-03-20T10:00:00.000Z',
      '  canonicalization: server_normalized',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Which constraints are fixed?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Keep imports stable.',
      '      answered_by: user',
      '      answered_at: 2026-03-20T10:05:00.000Z',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
      '```',
    ].join('\n'), {
      ticketId: TICKET_ID,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('orphan trailing closing code fence')
    expect(result.value.ticket_id).toBe(TICKET_ID)
    expect(result.value.questions[0]?.id).toBe('Q01')
  })

  it('repairs GLM-style dedented interview wrappers and still canonicalizes the resolved interview', () => {
    const canonicalInterview = [
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "approved"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:18:55.102Z"',
      '  canonicalization: "server_normalized"',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: "What primary problem should the new phase solve?"',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: ai_skip',
      '      answered_at: ""',
      '  - id: Q02',
      '    phase: Foundation',
      '    prompt: "Who should consume the strategy?"',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: multiple_choice',
      '    options:',
      '      - id: opt1',
      '        label: Workflow engine',
      '      - id: opt2',
      '        label: Beads generation',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids:',
      '        - opt1',
      '      free_text: ""',
      '      answered_by: user',
      '      answered_at: "2026-03-25T18:19:00.000Z"',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: "user"',
      '  approved_at: "2026-03-25T18:19:30.000Z"',
    ].join('\n')

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: ${TICKET_ID}`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      'winner_model: openai/gpt-5.4',
      'generated_at: "2026-03-25T18:18:55.102Z"',
      'canonicalization: server_normalized',
      'questions:',
      '- id: Q01',
      '  phase: Foundation',
      '  prompt: "What primary problem should the new phase solve?"',
      '  source: compiled',
      '  follow_up_round: null',
      '  answer_type: free_text',
      '  options: []',
      '  answer:',
      '  skipped: false',
      '  selected_option_ids: []',
      '  free_text: >-',
      '    Introduce a deterministic, risk-first planning checkpoint.',
      '  answered_by: ai_skip',
      '  answered_at: "2026-03-25T18:20:00.000Z"',
      '- id: Q02',
      '  phase: Foundation',
      '  prompt: "Who should consume the strategy?"',
      '  source: compiled',
      '  follow_up_round: null',
      '  answer_type: multiple_choice',
      '  options:',
      '    - id: opt1',
      '      label: Workflow engine',
      '    - id: opt2',
      '      label: Beads generation',
      '  answer:',
      '  skipped: false',
      '  selected_option_ids:',
      '  - opt1',
      '  free_text: ""',
      '  answered_by: user',
      '  answered_at: "2026-03-25T18:19:00.000Z"',
      'follow_up_rounds: []',
      'summary:',
      'goals: []',
      'constraints: []',
      'non_goals: []',
      'final_free_form_answer: ""',
      'approval:',
      'approved_by: ""',
      'approved_at: ""',
    ].join('\n'), {
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'nvidia/z-ai/glm5',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.generated_by.winner_model).toBe('nvidia/z-ai/glm5')
    expect(result.value.questions[0]?.answer.free_text).toContain('risk-first planning checkpoint')
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Canonicalized generated_by.winner_model')
  })

  it('normalizes the Mistral-shaped full answers artifact by repairing structure without relaxing semantics', () => {
    const canonicalInterview = [
      'schema_version: 1',
      'ticket_id: LINLO-20',
      'artifact: interview',
      'status: approved',
      'generated_by:',
      '  winner_model: openai/gpt-5.4',
      '  generated_at: "2026-03-29T13:24:16.543Z"',
      '  canonicalization: server_normalized',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Should the pink theme be a new selectable theme option, or should it replace the current light theme styling?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: single_choice',
      '    options:',
      '      - id: opt1',
      '        label: New selectable theme',
      '      - id: opt2',
      '        label: Replace light theme',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: ai_skip',
      '      answered_at: ""',
      '  - id: Q02',
      '    phase: Foundation',
      '    prompt: What is the main goal of this test ticket?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: single_choice',
      '    options:',
      '      - id: opt1',
      '        label: Proof of support only',
      '      - id: opt2',
      '        label: User-facing polished theme',
      '      - id: opt3',
      '        label: Somewhere in between',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: ai_skip',
      '      answered_at: ""',
      '  - id: Q03',
      '    phase: Structure',
      '    prompt: >-',
      '      What exact minimal scope should this ticket include: pink theme tokens only, adding a `Pink` option in the',
      '      existing theme switcher, persisted theme state, and checking key shared UI like buttons, dropdowns, and tooltips?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: ai_skip',
      '      answered_at: ""',
      '  - id: Q05',
      '    phase: Assembly',
      '    prompt: >-',
      '      What acceptance criteria define done for this minimal ticket: use a provided pink palette or a proposed default,',
      '      keep core UI readable with acceptable contrast, and, if pink is selectable, make it visible in the theme switcher',
      '      and persist across reloads?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: ai_skip',
      '      answered_at: ""',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: user',
      '  approved_at: "2026-03-29T13:25:29.634Z"',
    ].join('\n')

    const result = normalizeResolvedInterviewDocumentOutput([
      '```yaml',
      'schema_version: 1',
      'ticket_id: LINLO-20',
      'artifact:',
      '  interview:',
      '    status: draft',
      '    generated_by: winner_model',
      '    winner_model: mistralai/mistral-large-3-675b-instruct-2512',
      '    generated_at: "2026-03-29T12:00:00Z"',
      '    canonicalization:',
      '      server_normalized: true',
      '    questions:',
      '      - id: Q01',
      '        phase: Foundation',
      '        prompt: Should the pink theme be a new selectable theme option, or should it replace the current light theme styling?',
      '        source: compiled',
      '        follow_up_round: null',
      '        answer_type: single_choice',
      '        options:',
      '          - id: opt1',
      '            label: New selectable theme',
      '          - id: opt2',
      '            label: Replace light theme',
      '        answer:',
      '          skipped: false',
      '          selected_option_ids: [opt1]',
      '          free_text: ""',
      '          answered_by: ai_skip',
      '          answered_at: "2026-03-29T12:00:00Z"',
      '      - id: Q02',
      '        phase: Foundation',
      '        prompt: What is the main goal of this test ticket?',
      '        source: compiled',
      '        follow_up_round: null',
      '        answer_type: single_choice',
      '        options:',
      '          - id: opt1',
      '            label: Proof of support only',
      '          - id: opt2',
      '            label: User-facing polished theme',
      '          - id: opt3',
      '            label: Somewhere in between',
      '        answer:',
      '          skipped: false',
      '          selected_option_ids: [opt1]',
      '          free_text: ""',
      '          answered_by: ai_skip',
      '          answered_at: "2026-03-29T12:00:00Z"',
      '      - id: Q03',
      '        phase: Structure',
      '        prompt: >-',
      '          What exact minimal scope should this ticket include: pink theme tokens only, adding a `Pink` option in the existing theme switcher, persisted theme state, and checking key shared UI like buttons, dropdowns, and tooltips?',
      '        source: compiled',
      '        follow_up_round: null',
      '        answer_type: free_text',
      '        options: []',
      '        answer:',
      '          skipped: false',
      '          selected_option_ids: []',
      '          free_text: "Minimal scope includes adding pink theme tokens, a `Pink` option in the theme switcher, ensuring persisted theme state, and verifying key UI elements like buttons, dropdowns, and tooltips."',
      '          answered_by: ai_skip',
      '          answered_at: "2026-03-29T12:00:00Z"',
      '      - id: Q05',
      '        phase: Assembly',
      '        prompt: >-',
      '          What acceptance criteria define done for this minimal ticket: use a provided pink palette or a proposed default, keep core UI readable with acceptable contrast, and, if pink is selectable, make it visible in the theme switcher and persist across reloads?',
      '        source: compiled',
      '        follow_up_round: null',
      '        answer_type: free_text',
      '        options: []',
      '        answer:',
      '          skipped: false',
      '          selected_option_ids: []',
      '          free_text: "Acceptance criteria: use a default pink palette, ensure UI readability and contrast, make the pink theme visible in the switcher, and persist the theme across reloads."',
      '          answered_by: ai_skip',
      '          answered_at: "2026-03-29T12:00:00Z"',
      '        follow_up_rounds: []',
      '        summary:',
      '          goals: []',
      '          constraints: []',
      '          non_goals: []',
      '          final_free_form_answer: ""',
      '    approval:',
      '      approved_by: ""',
      '      approved_at: ""',
      '```',
    ].join('\n'), {
      ticketId: 'LINLO-20',
      canonicalInterviewContent: canonicalInterview,
      memberId: 'nvidia/mistralai/mistral-large-3-675b-instruct-2512',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Canonicalized generated_by.winner_model')
    expect(result.value.generated_by.winner_model).toBe('nvidia/mistralai/mistral-large-3-675b-instruct-2512')
    expect(result.value.generated_by.canonicalization).toBe('server_normalized')
    expect(result.value.questions.map((question) => question.id)).toEqual(['Q01', 'Q02', 'Q03', 'Q05'])
    expect(result.value.questions.map((question) => question.answer.skipped)).toEqual([false, false, false, false])
    expect(result.value.questions[0]?.answer.selected_option_ids).toEqual(['opt1'])
    expect(result.value.questions[1]?.answer.selected_option_ids).toEqual(['opt1'])
    expect(result.value.questions[2]?.answer.free_text).toContain('pink theme tokens')
    expect(result.value.summary).toEqual({
      goals: [],
      constraints: [],
      non_goals: [],
      final_free_form_answer: '',
    })
    expect(result.value.approval).toEqual({
      approved_by: '',
      approved_at: '',
    })
  })

  it('keeps repaired Mistral-shaped full answers strict when canonical option ids are invented', () => {
    const canonicalInterview = [
      'schema_version: 1',
      'ticket_id: LINLO-20',
      'artifact: interview',
      'status: approved',
      'generated_by:',
      '  winner_model: openai/gpt-5.4',
      '  generated_at: "2026-03-29T13:24:16.543Z"',
      '  canonicalization: server_normalized',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Should the pink theme be a new selectable theme option, or should it replace the current light theme styling?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: single_choice',
      '    options:',
      '      - id: opt1',
      '        label: New selectable theme',
      '      - id: opt2',
      '        label: Replace light theme',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: ai_skip',
      '      answered_at: ""',
      '  - id: Q02',
      '    phase: Foundation',
      '    prompt: What is the main goal of this test ticket?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: single_choice',
      '    options:',
      '      - id: opt1',
      '        label: Proof of support only',
      '      - id: opt2',
      '        label: User-facing polished theme',
      '      - id: opt3',
      '        label: Somewhere in between',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: ai_skip',
      '      answered_at: ""',
      '  - id: Q03',
      '    phase: Structure',
      '    prompt: Scope?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: ai_skip',
      '      answered_at: ""',
      '  - id: Q05',
      '    phase: Assembly',
      '    prompt: Done criteria?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: ai_skip',
      '      answered_at: ""',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: user',
      '  approved_at: "2026-03-29T13:25:29.634Z"',
    ].join('\n')

    const result = normalizeResolvedInterviewDocumentOutput([
      '```yaml',
      'schema_version: 1',
      'ticket_id: LINLO-20',
      'artifact:',
      '  interview:',
      '    status: draft',
      '    generated_by: winner_model',
      '    winner_model: mistralai/mistral-large-3-675b-instruct-2512',
      '    generated_at: "2026-03-29T12:00:00Z"',
      '    canonicalization:',
      '      server_normalized: true',
      '    questions:',
      '      - id: Q01',
      '        phase: Foundation',
      '        prompt: Should the pink theme be a new selectable theme option, or should it replace the current light theme styling?',
      '        source: compiled',
      '        follow_up_round: null',
      '        answer_type: single_choice',
      '        options:',
      '          - id: opt1',
      '            label: New selectable theme',
      '          - id: opt2',
      '            label: Replace light theme',
      '        answer:',
      '          skipped: false',
      '          selected_option_ids: [opt_new_selectable]',
      '          free_text: ""',
      '          answered_by: ai_skip',
      '          answered_at: "2026-03-29T12:00:00Z"',
      '      - id: Q02',
      '        phase: Foundation',
      '        prompt: What is the main goal of this test ticket?',
      '        source: compiled',
      '        follow_up_round: null',
      '        answer_type: single_choice',
      '        options:',
      '          - id: opt1',
      '            label: Proof of support only',
      '          - id: opt2',
      '            label: User-facing polished theme',
      '          - id: opt3',
      '            label: Somewhere in between',
      '        answer:',
      '          skipped: false',
      '          selected_option_ids: [opt1]',
      '          free_text: ""',
      '          answered_by: ai_skip',
      '          answered_at: "2026-03-29T12:00:00Z"',
      '      - id: Q03',
      '        phase: Structure',
      '        prompt: Scope?',
      '        source: compiled',
      '        follow_up_round: null',
      '        answer_type: free_text',
      '        options: []',
      '        answer:',
      '          skipped: false',
      '          selected_option_ids: []',
      '          free_text: "Pink tokens, selectable theme, persistence, and key shared UI checks."',
      '          answered_by: ai_skip',
      '          answered_at: "2026-03-29T12:00:00Z"',
      '      - id: Q05',
      '        phase: Assembly',
      '        prompt: Done criteria?',
      '        source: compiled',
      '        follow_up_round: null',
      '        answer_type: free_text',
      '        options: []',
      '        answer:',
      '          skipped: false',
      '          selected_option_ids: []',
      '          free_text: "Readable contrast, visible switcher option, and persisted selection."',
      '          answered_by: ai_skip',
      '          answered_at: "2026-03-29T12:00:00Z"',
      '        follow_up_rounds: []',
      '        summary:',
      '          goals: []',
      '          constraints: []',
      '          non_goals: []',
      '          final_free_form_answer: ""',
      '    approval:',
      '      approved_by: ""',
      '      approved_at: ""',
      '```',
    ].join('\n'), {
      ticketId: 'LINLO-20',
      canonicalInterviewContent: canonicalInterview,
      memberId: 'nvidia/mistralai/mistral-large-3-675b-instruct-2512',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('unknown option id "opt_new_selectable"')
  })

  it('updates interview answers as draft edits and stamps approval separately', () => {
    const normalized = normalizeInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: ${TICKET_ID}`,
      'artifact: interview',
      'status: approved',
      'generated_by:',
      '  winner_model: openai/gpt-5',
      '  generated_at: 2026-03-20T10:00:00.000Z',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: Which constraints are fixed?',
      '    source: compiled',
      '    answer_type: free_text',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Keep imports stable.',
      '      answered_at: 2026-03-20T10:05:00.000Z',
      '  - id: FINAL',
      '    phase: Assembly',
      '    prompt: Anything else the team should know?',
      '    source: final_free_form',
      '    answer_type: free_text',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Watch retries closely.',
      '      answered_at: 2026-03-20T10:06:00.000Z',
      'follow_up_rounds: []',
      'summary:',
      '  goals: [Protect imports]',
      '  constraints: [No duplicate records]',
      '  non_goals: [Bulk reprocessing]',
      '  final_free_form_answer: Watch retries closely.',
      'approval:',
      '  approved_by: user',
      '  approved_at: 2026-03-20T10:10:00.000Z',
    ].join('\n'))

    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return

    const drafted = updateInterviewDocumentAnswers(normalized.value, [
      {
        id: 'FINAL',
        answer: {
          skipped: false,
          selected_option_ids: [],
          free_text: 'Review retries and alerts together.',
        },
      },
    ], '2026-03-20T10:20:00.000Z')

    expect(drafted.status).toBe('draft')
    expect(drafted.approval).toEqual({
      approved_by: '',
      approved_at: '',
    })
    expect(drafted.summary.final_free_form_answer).toBe('Review retries and alerts together.')

    const approved = buildApprovedInterviewDocument(drafted, '2026-03-20T10:25:00.000Z')
    expect(approved.status).toBe('approved')
    expect(approved.approval).toEqual({
      approved_by: 'user',
      approved_at: '2026-03-20T10:25:00.000Z',
    })
  })

  it('trims trailing terminal noise from complete resolved interview JSON output', () => {
    const canonicalInterview = CANONICAL_RESOLVED_INTERVIEW

    const result = normalizeResolvedInterviewDocumentOutput(`${JSON.stringify({
      schema_version: 1,
      ticket_id: TICKET_ID,
      artifact: 'interview',
      status: 'draft',
      generated_by: {
        winner_model: 'nvidia/z-ai/glm5',
        generated_at: '2026-03-25T18:20:00.000Z',
        canonicalization: 'server_normalized',
      },
      questions: [
        {
          id: 'Q01',
          phase: 'Foundation',
          prompt: 'What primary problem should the new phase solve?',
          source: 'compiled',
          follow_up_round: null,
          answer_type: 'free_text',
          options: [],
          answer: {
            skipped: false,
            selected_option_ids: [],
            free_text: 'Introduce a deterministic, risk-first planning checkpoint.',
            answered_by: 'ai_skip',
            answered_at: '2026-03-25T18:20:00.000Z',
          },
        },
        {
          id: 'Q02',
          phase: 'Foundation',
          prompt: 'Who should consume the strategy?',
          source: 'compiled',
          follow_up_round: null,
          answer_type: 'single_choice',
          options: [
            { id: 'opt1', label: 'Workflow engine' },
            { id: 'opt2', label: 'Beads generation' },
          ],
          answer: {
            skipped: false,
            selected_option_ids: ['opt1'],
            free_text: '',
            answered_by: 'user',
            answered_at: '2026-03-25T18:19:00.000Z',
          },
        },
      ],
      follow_up_rounds: [],
      summary: {
        goals: [],
        constraints: [],
        non_goals: [],
        final_free_form_answer: '',
      },
      approval: {
        approved_by: '',
        approved_at: '',
      },
    })}[e~[`, {
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'nvidia/z-ai/glm5',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Trimmed trailing terminal noise')
    expect(result.value.questions).toHaveLength(2)
    expect(result.value.questions[1]?.id).toBe('Q02')
    expect(result.value.questions[0]?.answer.free_text).toContain('risk-first planning checkpoint')
  })

  it('trims trailing terminal noise glued to the last scalar in resolved interview YAML output', () => {
    const canonicalInterview = CANONICAL_RESOLVED_INTERVIEW

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "draft"',
      'generated_by:',
      '  winner_model: "nvidia/z-ai/glm5"',
      '  generated_at: "2026-03-25T18:20:00.000Z"',
      '  canonicalization: "server_normalized"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "What primary problem should the new phase solve?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "free_text"',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: "Introduce a deterministic, risk-first planning checkpoint."',
      '      answered_by: "ai_skip"',
      '      answered_at: "2026-03-25T18:20:00.000Z"',
      '  - id: "Q02"',
      '    phase: "Foundation"',
      '    prompt: "Who should consume the strategy?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "opt1"',
      '        label: "Workflow engine"',
      '      - id: "opt2"',
      '        label: "Beads generation"',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids:',
      '        - "opt1"',
      '      free_text: ""',
      '      answered_by: "user"',
      '      answered_at: "2026-03-25T18:19:00.000Z"',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""[e~[',
    ].join('\n'), {
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'nvidia/z-ai/glm5',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Trimmed trailing terminal noise')
    expect(result.value.questions).toHaveLength(2)
    expect(result.value.questions[1]?.id).toBe('Q02')
    expect(result.value.questions[0]?.answer.free_text).toContain('risk-first planning checkpoint')
  })

  it('rejects resolved interview prompt schema echoes with a clear validation error', () => {
    const canonicalInterview = CANONICAL_RESOLVED_INTERVIEW

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: "<winner-model-id>"',
      '  generated_at: "<ISO-8601 timestamp>"',
      '  canonicalization: server_normalized',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "What problem are we solving?"',
      '    source: compiled | prompt_follow_up | coverage_follow_up | final_free_form',
      '    follow_up_round: null',
      '    answer_type: free_text | single_choice | multiple_choice',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: "User answer or empty string"',
      '      answered_by: user | ai_skip',
      '      answered_at: "<ISO-8601 timestamp or empty string>"',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
      '',
      '## Context',
      '### ticket_details',
      `# Ticket: ${TICKET_ID}`,
      'Keep retries strict.',
    ].join('\n'), {
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'openai/gpt-5.4',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('echoed the prompt')
    expect(result.error).not.toContain('block mapping entry')
  })

  it('repairs resolved interview YAML that needs both trailing-noise trimming and free_text quoting', () => {
    const canonicalInterview = CANONICAL_RESOLVED_INTERVIEW

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "approved"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:20:00.000Z"',
      '  canonicalization: "server_normalized"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "What primary problem should the new phase solve?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "free_text"',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Done when: planning retries recover safely without manual cleanup.',
      '      answered_by: "ai_skip"',
      '      answered_at: "2026-03-25T18:20:00.000Z"',
      '  - id: "Q02"',
      '    phase: "Foundation"',
      '    prompt: "Who should consume the strategy?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "opt1"',
      '        label: "Workflow engine"',
      '      - id: "opt2"',
      '        label: "Beads generation"',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids:',
      '        - "opt1"',
      '      free_text: ""',
      '      answered_by: "user"',
      '      answered_at: "2026-03-25T18:19:00.000Z"',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: "user"',
      '  approved_at: "2026-03-25T18:19:30.000Z"[e~[',
    ].join('\n'), {
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'nvidia/z-ai/glm5',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairApplied).toBe(true)
    expect(result.repairWarnings.join('\n')).toContain('Trimmed trailing terminal noise')
    expect(result.value.questions[0]?.answer.free_text).toBe('Done when: planning retries recover safely without manual cleanup.')
    expect(result.value.status).toBe('draft')
    expect(result.value.approval).toEqual({
      approved_by: '',
      approved_at: '',
    })
  })

  it('maps leading canonical choice labels with explanation to canonical option ids', () => {
    const canonicalInterview = [
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "approved"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:18:55.102Z"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "Should the guardrail be enabled?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "yes"',
      '        label: "Yes"',
      '      - id: "no"',
      '        label: "No"',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: ""',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: "user"',
      '  approved_at: "2026-03-25T18:19:30.000Z"',
    ].join('\n')

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "draft"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:20:00.000Z"',
      '  canonicalization: "server_normalized"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "Should the guardrail be enabled?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "yes"',
      '        label: "Yes"',
      '      - id: "no"',
      '        label: "No"',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: "Yes. Keep it enabled for the guarded rollout."',
      '      answered_by: "ai_skip"',
      '      answered_at: "2026-03-25T18:20:00.000Z"',
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
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'openai/gpt-5.4',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questions[0]?.answer.selected_option_ids).toEqual(['yes'])
    expect(result.value.questions[0]?.answer.free_text).toBe('Yes. Keep it enabled for the guarded rollout.')
    expect(result.repairWarnings).toContain('Mapped free_text to canonical option ids for AI-filled question Q01.')
  })

  it('maps non-canonical selected option ids when candidate labels match canonical options exactly', () => {
    const canonicalInterview = [
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "approved"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:18:55.102Z"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "Which consumer should own the rollout?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "opt1"',
      '        label: "Workflow engine"',
      '      - id: "opt2"',
      '        label: "Beads generation"',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: ""',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: "user"',
      '  approved_at: "2026-03-25T18:19:30.000Z"',
    ].join('\n')

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "draft"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:20:00.000Z"',
      '  canonicalization: "server_normalized"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "Which consumer should own the rollout?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "local-workflow"',
      '        label: "Workflow engine"',
      '      - id: "local-beads"',
      '        label: "Beads generation"',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: ["local-workflow"]',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: "2026-03-25T18:20:00.000Z"',
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
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'openai/gpt-5.4',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questions[0]?.answer.selected_option_ids).toEqual(['opt1'])
    expect(result.repairWarnings).toContain('Mapped selected option ids to canonical option ids for AI-filled question Q01.')
  })

  it('keeps paraphrased choice prose invalid when it does not start with an exact canonical label', () => {
    const canonicalInterview = [
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "approved"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:18:55.102Z"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "Should the guardrail be enabled?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "yes"',
      '        label: "Yes"',
      '      - id: "no"',
      '        label: "No"',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: ""',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: "user"',
      '  approved_at: "2026-03-25T18:19:30.000Z"',
    ].join('\n')

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "draft"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:20:00.000Z"',
      '  canonicalization: "server_normalized"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "Should the guardrail be enabled?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "yes"',
      '        label: "Yes"',
      '      - id: "no"',
      '        label: "No"',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: "Enable it for the guarded rollout."',
      '      answered_by: "ai_skip"',
      '      answered_at: "2026-03-25T18:20:00.000Z"',
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
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'openai/gpt-5.4',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('does not map exactly to canonical options')
  })

  it('keeps invented selected option ids invalid when candidate labels do not match canonical options exactly', () => {
    const canonicalInterview = [
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "approved"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:18:55.102Z"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "Which consumer should own the rollout?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "opt1"',
      '        label: "Workflow engine"',
      '      - id: "opt2"',
      '        label: "Beads generation"',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: ""',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: "user"',
      '  approved_at: "2026-03-25T18:19:30.000Z"',
    ].join('\n')

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "draft"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:20:00.000Z"',
      '  canonicalization: "server_normalized"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "Which consumer should own the rollout?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "local-rollout"',
      '        label: "Primary rollout owner"',
      '      - id: "local-beads"',
      '        label: "Beads generation"',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: ["local-rollout"]',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: "2026-03-25T18:20:00.000Z"',
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
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'openai/gpt-5.4',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('unknown option id "local-rollout"')
  })

  it('accepts a blank final free-form answer only as an explicit no-additions response', () => {
    const canonicalInterview = [
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "approved"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:18:55.102Z"',
      'questions:',
      '  - id: "QFF1"',
      '    phase: "Assembly"',
      '    prompt: "Anything else we should capture before drafting the PRD?"',
      '    source: "final_free_form"',
      '    follow_up_round: null',
      '    answer_type: "free_text"',
      '    options: []',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: ""',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: "user"',
      '  approved_at: "2026-03-25T18:19:30.000Z"',
    ].join('\n')

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "draft"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:20:00.000Z"',
      '  canonicalization: "server_normalized"',
      'questions:',
      '  - id: "QFF1"',
      '    phase: "Assembly"',
      '    prompt: "Anything else we should capture before drafting the PRD?"',
      '    source: "final_free_form"',
      '    follow_up_round: null',
      '    answer_type: "free_text"',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: "2026-03-25T18:20:00.000Z"',
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
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'openai/gpt-5.4',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.questions[0]?.answer).toEqual({
      skipped: false,
      selected_option_ids: [],
      free_text: '',
      answered_by: 'ai_skip',
      answered_at: '2026-03-25T18:20:00.000Z',
    })
    expect(result.value.summary.final_free_form_answer).toBe('')
    expect(result.repairWarnings).toContain('Accepted empty final_free_form answer as an explicit no-additions response for AI-filled question QFF1.')
  })

  it('keeps blank non-final free_text answers invalid', () => {
    const canonicalInterview = [
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "approved"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:18:55.102Z"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "What primary problem should the new phase solve?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "free_text"',
      '    options: []',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: ""',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: "user"',
      '  approved_at: "2026-03-25T18:19:30.000Z"',
    ].join('\n')

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "draft"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:20:00.000Z"',
      '  canonicalization: "server_normalized"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "What primary problem should the new phase solve?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "free_text"',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: "2026-03-25T18:20:00.000Z"',
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
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'openai/gpt-5.4',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Resolved interview left skipped question unanswered: Q01')
  })

  it('keeps blank follow-up free_text answers invalid even when an earlier choice was answered', () => {
    const canonicalInterview = [
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "approved"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:18:55.102Z"',
      'questions:',
      '  - id: "Q05"',
      '    phase: "Structure"',
      '    prompt: "Should the draft include conditional follow-up handling?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "opt1"',
      '        label: "Yes"',
      '      - id: "opt2"',
      '        label: "No"',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: ""',
      '  - id: "FU1"',
      '    phase: "Assembly"',
      '    prompt: "If yes, what should happen when the follow-up is not applicable?"',
      '    source: "prompt_follow_up"',
      '    follow_up_round: 1',
      '    answer_type: "free_text"',
      '    options: []',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: ""',
      'follow_up_rounds:',
      '  - round_number: 1',
      '    source: "prom4"',
      '    question_ids: ["FU1"]',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: "user"',
      '  approved_at: "2026-03-25T18:19:30.000Z"',
    ].join('\n')

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "draft"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:20:00.000Z"',
      '  canonicalization: "server_normalized"',
      'questions:',
      '  - id: "Q05"',
      '    phase: "Structure"',
      '    prompt: "Should the draft include conditional follow-up handling?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "opt1"',
      '        label: "Yes"',
      '      - id: "opt2"',
      '        label: "No"',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: ["opt1"]',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: "2026-03-25T18:20:00.000Z"',
      '  - id: "FU1"',
      '    phase: "Assembly"',
      '    prompt: "If yes, what should happen when the follow-up is not applicable?"',
      '    source: "prompt_follow_up"',
      '    follow_up_round: 1',
      '    answer_type: "free_text"',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: "2026-03-25T18:21:00.000Z"',
      'follow_up_rounds:',
      '  - round_number: 1',
      '    source: "prom4"',
      '    question_ids: ["FU1"]',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n'), {
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'openai/gpt-5.4',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Resolved interview left skipped question unanswered: FU1')
  })

  it('keeps resolved interview artifacts with missing canonical questions invalid', () => {
    const canonicalInterview = [
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "approved"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:18:55.102Z"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "What primary problem should the new phase solve?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "free_text"',
      '    options: []',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: ""',
      '  - id: "Q02"',
      '    phase: "Foundation"',
      '    prompt: "Who should consume the strategy?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "opt1"',
      '        label: "Workflow engine"',
      '      - id: "opt2"',
      '        label: "Beads generation"',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: ""',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: "user"',
      '  approved_at: "2026-03-25T18:19:30.000Z"',
    ].join('\n')

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: ${TICKET_ID}`,
      'artifact: interview',
      'status: draft',
      'generated_by: winner_model: "nvidia/z-ai/glm5" generated_at: "2026-03-25T18:20:00.000Z" canonicalization: server_normalized',
      'questions: - id: "Q01" phase: "Foundation" prompt: "What primary problem should the new phase solve?" source: compiled follow_up_round: null answer_type: free_text options: [] answer: skipped: false selected_option_ids: [] free_text: "Introduce a deterministic, risk-first planning checkpoint." answered_by: ai_skip answered_at: "2026-03-25T18:20:00.000Z"',
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
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'nvidia/z-ai/glm5',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('must preserve all 2 canonical questions')
    expect(result.error).toContain('missing canonical ids: Q02')
  })

  it('repairs compact inline resolved interview YAML without inventing answers', () => {
    const canonicalInterview = [
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "approved"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:18:55.102Z"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "What primary problem should the new phase solve?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "free_text"',
      '    options: []',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: ""',
      '  - id: "Q02"',
      '    phase: "Foundation"',
      '    prompt: "Who should consume the strategy?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "opt1"',
      '        label: "Workflow engine"',
      '      - id: "opt2"',
      '        label: "Beads generation"',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: ""',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: "user"',
      '  approved_at: "2026-03-25T18:19:30.000Z"',
    ].join('\n')

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: ${TICKET_ID}`,
      'artifact: interview',
      'status: draft',
      'generated_by: winner_model: "nvidia/nemotron" generated_at: "2026-04-30T15:29:00Z" canonicalization: server_normalized',
      'questions: - id: "Q01" phase: "Foundation" prompt: "What primary problem should the new phase solve?" source: compiled follow_up_round: null answer_type: free_text options: [] answer: skipped: false selected_option_ids: [] free_text: "Introduce a deterministic, risk-first planning checkpoint." answered_by: ai_skip answered_at: "2026-04-30T15:29:01Z"',
      '  - id: "Q02" phase: "Foundation" prompt: "Who should consume the strategy?" source: compiled follow_up_round: null answer_type: single_choice options: - id: opt1 label: "Workflow engine" - id: opt2 label: "Beads generation" answer: skipped: false selected_option_ids: - opt1 free_text: \'\' answered_by: ai_skip answered_at: "2026-04-30T15:29:02Z"',
      'follow_up_rounds: []',
      'summary: goals: [] constraints: [] non_goals: [] final_free_form_answer: ""',
      'approval: approved_by: "" approved_at: ""',
    ].join('\n'), {
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'nvidia/nemotron',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairWarnings).toContain('Repaired inline YAML sequence or mapping syntax before parsing.')
    expect(result.value.generated_by.winner_model).toBe('nvidia/nemotron')
    expect(result.value.questions[0]?.answer.free_text).toBe('Introduce a deterministic, risk-first planning checkpoint.')
    expect(result.value.questions[1]?.answer.selected_option_ids).toEqual(['opt1'])
  })

  it('recovers answer-only Full Answers question blocks when canonical ids match', () => {
    const result = normalizeResolvedInterviewDocumentOutput([
      'generated_by:',
      '  winner_model: "nvidia/nemotron"',
      '  generated_at: "2026-04-30T15:29:00Z"',
      'questions:',
      '  - id:Q01',
      '    answer:',
      '      skipped:false',
      '      selected_option_ids: []',
      '      free_text: "Introduce a deterministic, risk-first planning checkpoint."',
      '    answered_by: ai_skip',
      '    answered_at: "2026-04-30T15:29:01Z"',
      '  - id: Q02',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: ["opt2"]',
      '      free_text: ""',
      '    answered_by: user',
      '    answered_at: "2026-03-25T18:19:00.000Z"',
    ].join('\n'), {
      ticketId: TICKET_ID,
      canonicalInterviewContent: CANONICAL_RESOLVED_INTERVIEW,
      memberId: 'nvidia/nemotron',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repairWarnings).toContain('Recovered Full Answers answer-only question blocks using canonical question metadata.')
    expect(result.repairWarnings).toContain('Hoisted answered_by into answer for canonical question Q01.')
    expect(result.repairWarnings).toContain('Hoisted answered_at into answer for canonical question Q01.')
    expect(result.repairWarnings).toContain('Repaired YAML mapping keys missing a space after colon before parsing.')
    expect(result.value.questions[0]?.prompt).toBe('What primary problem should the new phase solve?')
    expect(result.value.questions[0]?.answer).toEqual({
      skipped: false,
      selected_option_ids: [],
      free_text: 'Introduce a deterministic, risk-first planning checkpoint.',
      answered_by: 'ai_skip',
      answered_at: '2026-04-30T15:29:01Z',
    })
    expect(result.value.questions[1]?.prompt).toBe('Who should consume the strategy?')
    expect(result.value.questions[1]?.answer).toEqual({
      skipped: false,
      selected_option_ids: ['opt1'],
      free_text: '',
      answered_by: 'user',
      answered_at: '2026-03-25T18:19:00.000Z',
    })
  })

  it('canonicalizes malformed Full Answers follow_up_rounds from the approved interview artifact', () => {
    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: "nvidia/nemotron"',
      '  generated_at: "2026-04-30T15:29:00Z"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "What primary problem should the new phase solve?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "free_text"',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: "Introduce a deterministic, risk-first planning checkpoint."',
      '      answered_by: "ai_skip"',
      '      answered_at: "2026-04-30T15:29:01Z"',
      '  - id: "Q02"',
      '    phase: "Foundation"',
      '    prompt: "Who should consume the strategy?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "single_choice"',
      '    options:',
      '      - id: "opt1"',
      '        label: "Workflow engine"',
      '      - id: "opt2"',
      '        label: "Beads generation"',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: ["opt1"]',
      '      free_text: ""',
      '      answered_by: "user"',
      '      answered_at: "2026-03-25T18:19:00.000Z"',
      'follow_up_rounds:',
      '  - round_number: 1    source: prom4 | coverage',
      '    question_ids: ["FU1"]',
      'summary:',
      '  goals: ["drifted"]',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: ""',
      '  approved_at: ""',
    ].join('\n'), {
      ticketId: TICKET_ID,
      canonicalInterviewContent: CANONICAL_RESOLVED_INTERVIEW,
      memberId: 'nvidia/nemotron',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.follow_up_rounds).toEqual([])
    expect(result.repairWarnings).toContain('Canonicalized follow_up_rounds to match the approved Interview Results artifact.')
    expect(result.repairWarnings).toContain('Canonicalized summary to match the approved Interview Results artifact.')
  })

  it('keeps truncated resolved interview artifacts invalid', () => {
    const canonicalInterview = [
      'schema_version: 1',
      `ticket_id: "${TICKET_ID}"`,
      'artifact: "interview"',
      'status: "approved"',
      'generated_by:',
      '  winner_model: "openai/gpt-5.4"',
      '  generated_at: "2026-03-25T18:18:55.102Z"',
      'questions:',
      '  - id: "Q01"',
      '    phase: "Foundation"',
      '    prompt: "What primary problem should the new phase solve?"',
      '    source: "compiled"',
      '    follow_up_round: null',
      '    answer_type: "free_text"',
      '    options: []',
      '    answer:',
      '      skipped: true',
      '      selected_option_ids: []',
      '      free_text: ""',
      '      answered_by: "ai_skip"',
      '      answered_at: ""',
      'follow_up_rounds: []',
      'summary:',
      '  goals: []',
      '  constraints: []',
      '  non_goals: []',
      '  final_free_form_answer: ""',
      'approval:',
      '  approved_by: "user"',
      '  approved_at: "2026-03-25T18:19:30.000Z"',
    ].join('\n')

    const result = normalizeResolvedInterviewDocumentOutput([
      'schema_version: 1',
      `ticket_id: ${TICKET_ID}`,
      'artifact: interview',
      'status: draft',
      'generated_by:',
      '  winner_model: nvidia/z-ai/glm5',
      '  generated_at: 2026-03-25T18:20:00.000Z',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: What primary problem should the new phase solve?',
      '    source: compiled',
      '    follow_up_round: null',
      '    answer_type: free_text',
      '    options: []',
      '    answer:',
      '      skipped: false',
      '      selected_option_ids: []',
      '      free_text: Introduce a deterministic, risk-first planning checkpoint.',
      '      answered_by: ai_skip',
      '      answered',
    ].join('\n'), {
      ticketId: TICKET_ID,
      canonicalInterviewContent: canonicalInterview,
      memberId: 'nvidia/z-ai/glm5',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBeTruthy()
  })
})
