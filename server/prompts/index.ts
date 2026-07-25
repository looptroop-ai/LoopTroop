import type { PromptPart } from '../opencode/types'
import type { OpenCodeToolPolicy } from '../opencode/toolPolicy'
import { VOTING_RUBRIC_BEADS, VOTING_RUBRIC_INTERVIEW, VOTING_RUBRIC_PRD } from '../council/types'
import { GLOBAL_RULES, SAME_SESSION_RULES, CONVERSATIONAL_RULES } from './globalRules'
import { buildCompletionInstructions } from '../phases/execution/completionSchema'
import { getCommandSpecPromptExample } from '@shared/commandSpec'

interface PromptTemplate {
  id: string
  description: string
  systemRole: string
  task: string
  instructions: string[]
  outputFormat: string
  contextInputs: string[]
  toolPolicy: OpenCodeToolPolicy
}

const DEFAULT_VOTE_CATEGORY_SCORE = 15
const MAX_VOTE_CATEGORY_SCORE = 20
const MAX_VOTE_TOTAL_SCORE = 100
const EXAMPLE_DRAFT_A_SCORES = [18, 17, 16, 15, 18]
const EXAMPLE_DRAFT_B_SCORES = [14, 15, 14, 16, 13]
const COMMAND_SPEC_PROMPT_EXAMPLE = JSON.stringify(getCommandSpecPromptExample())

function buildStrictVoteOutputInstruction(categories: string[]): string {
  const renderExampleDraft = (label: string, scores: number[]) => [
    `  ${label}:`,
    ...categories.map((category, index) => `    ${category}: ${scores[index] ?? DEFAULT_VOTE_CATEGORY_SCORE}`),
    `    total_score: ${categories.reduce((sum, _, index) => sum + (scores[index] ?? DEFAULT_VOTE_CATEGORY_SCORE), 0)}`,
  ].join('\n')

  return [
    'Output Format: Output strict machine-readable YAML. The top-level key MUST be `draft_scores`. Under `draft_scores`, include one mapping entry per presented draft using the exact provided draft label as the key (for example: `Draft 1`, `Draft 2`).',
    `Each draft entry MUST contain exactly ${categories.length + 1} integer fields on single lines: ${categories.map(category => `\`${category}\``).join(', ')}, and \`total_score\`.`,
    `All category scores MUST be plain integers from 0 to ${MAX_VOTE_CATEGORY_SCORE}. \`total_score\` MUST be a plain integer from 0 to ${MAX_VOTE_TOTAL_SCORE} and MUST equal the sum of the category scores for that draft.`,
    'Do not output prose, explanations, markdown fences, comments, rankings, winners, averages, extra keys, or omitted drafts.',
    'Example:',
    '```yaml',
    'draft_scores:',
    renderExampleDraft('Draft 1', EXAMPLE_DRAFT_A_SCORES),
    renderExampleDraft('Draft 2', EXAMPLE_DRAFT_B_SCORES),
    '```',
  ].join('\n')
}

const STRICT_VOTE_OUTPUT_FORMAT = 'YAML with top-level `draft_scores` mapping keyed by exact draft labels. Each draft: rubric integer fields plus `total_score`. No other fields.'
const STRUCTURED_SELF_CHECK = 'Final Self-Check: before responding, verify that you are returning only the artifact, using the exact required top-level shape, with no prose, no markdown fences, no commentary, and no extra wrapper keys.'

const CONDITIONAL_REPOSITORY_INSPECTION = 'Conditional Repository Inspection: Review the repository evidence already supplied in context, including `relevant_files` when available. If you need extra context to confirm a repository-specific claim, use focused read-only inspection. Inspect only the smallest useful set of manifests, build files, task definitions, CI configuration, and directly relevant source locations; do not survey the repository broadly. Never infer exact commands, file paths, frameworks, package managers, build systems, or test runners solely from ticket or PRD prose, file-extension examples, or common conventions.'
const INTERVIEW_REPOSITORY_BOUNDARY = 'Interview Repository Boundary: Use repository inspection only to confirm discoverable technical facts or decide whether a technical follow-up is needed. Never infer stakeholder preferences, desired behavior, scope, priorities, acceptance decisions, or product requirements from repository contents; ask the user whenever a human decision is needed.'
const COVERAGE_OUTPUT_FORMAT = 'YAML with exactly these top-level keys: `status`, `gaps`, `follow_up_questions`. `status` must be `clean` or `gaps`. `gaps` must be a YAML list of double-quoted strings. Quote every `gaps` item even when it contains code identifiers, file paths, flags, backticks, or punctuation. `follow_up_questions` must be a YAML list (empty when status is `clean`).'
const INTERVIEW_COVERAGE_OUTPUT_FORMAT = 'YAML with exactly these top-level keys: `status`, `gaps`, `follow_up_questions`. `status` must be `clean` or `gaps`. `gaps` must be a YAML list of double-quoted strings. Quote every `gaps` item even when it contains code identifiers, file paths, flags, backticks, or punctuation. When `status` is `clean`, `follow_up_questions` must be `[]`. When `status` is `gaps`, `follow_up_questions` must be a YAML list of objects with these fields: `id`, `question`, `phase`, `priority`, `rationale`, `answer_type` (required: free_text|single_choice|multiple_choice|yes_no), and optionally `options` (list of {id, label}) when answer_type is single_choice or multiple_choice. Do not return plain strings in `follow_up_questions`.'
const PRD_OUTPUT_FORMAT = [
  'YAML with exactly these top-level keys (no wrappers): `schema_version`, `ticket_id`, `artifact`, `status`, `source_interview`, `product`, `scope`, `technical_requirements`, `epics`, `risks`, `approval`.',
  '`artifact` must be `prd`. `source_interview` must include `content_sha256`.',
  '`product` keys: `problem_statement`, `target_users`.',
  '`scope` keys: `in_scope`, `out_of_scope`.',
  '`technical_requirements` keys: `architecture_constraints`, `data_model`, `api_contracts`, `security_constraints`, `performance_constraints`, `reliability_constraints`, `error_handling_rules`, `tooling_assumptions`.',
  '`epics` must be a non-empty list. Each epic: `id`, `title`, `objective`, `implementation_steps`, `user_stories`.',
  'Each user story: `id`, `title`, `acceptance_criteria`, `implementation_steps`, `verification.required_commands`. Every command is a structured process or current-host shell command; prefer direct process execution.',
  'YAML Safety: Any one-line scalar or list item that begins with backticks or `@`, or contains `: ` in plain text, must be double-quoted.',
  'Example:',
  '```yaml',
  'schema_version: 1',
  'ticket_id: "PROJ-1"',
  'artifact: "prd"',
  'status: "draft"',
  'source_interview:',
  '  content_sha256: "<sha256>"',
  'product:',
  '  problem_statement: "..."',
  '  target_users:',
  '    - "..."',
  'scope:',
  '  in_scope:',
  '    - "..."',
  '  out_of_scope:',
  '    - "..."',
  'technical_requirements:',
  '  architecture_constraints: []',
  '  data_model: []',
  '  api_contracts: []',
  '  security_constraints: []',
  '  performance_constraints: []',
  '  reliability_constraints: []',
  '  error_handling_rules: []',
  '  tooling_assumptions: []',
  'epics:',
  '  - id: "EPIC-1"',
  '    title: "..."',
  '    objective: "..."',
  '    implementation_steps:',
  '      - "..."',
  '    user_stories:',
  '      - id: "US-1"',
  '        title: "..."',
  '        acceptance_criteria:',
  '          - "..."',
  '        implementation_steps:',
  '          - "..."',
  '        verification:',
  '          required_commands:',
  '            - mode: "process"',
  '              program: "npm"',
  '              args: ["test"]',
  '              cwd: "."',
  '              env: {}',
  'risks:',
  '  - "..."',
  'approval:',
  '  approved_by: ""',
  '  approved_at: ""',
  '```',
].join('\n')
const INTERVIEW_PHASE_ORDER_RULE = 'Phase Order Is Mandatory: all `foundation` questions first, then all `structure` questions, then all `assembly` questions. Never go backwards to an earlier phase once you have entered a later phase.'
const BEADS_ORDER_PRESERVATION_RULE = 'Order Is Mandatory: Preserve the bead list order from the winning draft exactly. When adding new beads, insert them at a logical position that respects dependency ordering, but do not reorder, merge, or split existing beads. The app executes beads sequentially and derives `priority` from this list order.'
const BEAD_VERIFICATION_RESTRAINT_RULE = 'Verification Restraint: Only when genuinely necessary for the bead\'s core implementation and unsuitable for Final Testing or Manual QA should the plan add, retain, or expand commands; derive automated verification from risks, alternatives, or manual behavior; introduce server/process/cookie/port/temp-directory orchestration; or create a verification-only bead. Detailed tests and acceptance criteria do not each require a matching command. Prefer the smallest existing repository-native test or build command, with no numerical command target or cap. When no appropriate automated command exists, use `testCommands: []` and a concise `testCommandReason`; include `testCommandReason` only in that case.'
const BEAD_SUBSET_OUTPUT_FORMAT = [
  'YAML with a single top-level `beads` key containing a list.',
  'Each bead item must include exactly these fields:',
  '```yaml',
  'beads:',
  '  - id: "setup-db-schema"',
  '    title: "Create database schema"',
  '    prdRefs:',
  '      - "EPIC-1"',
  '      - "US-1-1"',
  '    description: "Detailed technical implementation steps for this bead."',
  '    contextGuidance:',
  '      patterns:',
  '        - "Use Drizzle ORM migrations."',
  '      anti_patterns:',
  '        - "Avoid raw SQL."',
  '    acceptanceCriteria:',
  '      - "Schema file exists and migrations run cleanly."',
  '    tests:',
  '      - "Unit test verifies table creation."',
  '    testCommands:',
  '      - mode: "process"',
  '        program: "npm"',
  '        args: ["run", "test", "--", "server/db"]',
  '        cwd: "."',
  '        env: {}',
  '```',
  '`testCommands` must always be a YAML list of structured commands. Prefer `{mode: process, program, args, cwd: ".", env: {}}`; use `{mode: shell, shell: posix|cmd|powershell, script, cwd: ".", env: {}}` only when repository evidence requires shell syntax. When the list is empty, add `testCommandReason` as a non-empty string; otherwise omit it.',
  'YAML Safety: For any field value or list item that contains dense punctuation, quotes, backslashes, `: `, brackets, braces, shell metacharacters, or other code-like inline syntax, prefer a block scalar (`|-`) and otherwise use a double-quoted YAML string.',
  'When using double-quoted YAML strings, escape literal backslashes as `\\\\` (for example `\\\\|` in regex-like text), or use a block scalar for commands and regex-like text.',
  'For `testCommands` containing regex backslashes such as `\\+`, prefer a block scalar list item (`- |-`) or escape every literal backslash as `\\\\+`; never put raw `\\+` inside a double-quoted YAML string.',
  'If you use a block scalar, emit the indicator unquoted on the key line (for example `description: |-`). Never emit quoted block-scalar indicators such as `"|-"`; if unsure, use a one-line double-quoted string instead.',
  'Never use YAML single-quoted scalars for punctuation-heavy commands, code snippets, regex-like text, or similar machine-oriented strings.',
  'Write `contextGuidance` as an object with two keys: `patterns` (list of specific patterns to follow) and `anti_patterns` (list of anti-patterns to avoid).',
  'No other top-level keys. No prose before or after the YAML.',
].join('\n')
const BEADS_JSONL_OUTPUT_FORMAT = 'JSONL only. One JSON object per line. No markdown fences, no surrounding array, no prose, and no wrapper object.'

// Relevant Files Context Extraction Prompt
export const PROM0: PromptTemplate = {
  id: 'PROM0',
  description: 'Relevant Files Context Extraction Prompt',
  systemRole: 'You are an expert software architect performing codebase analysis for implementation planning.',
  task: 'Given the ticket description, identify and read the source files most relevant to this ticket. Use your file-reading and directory-listing tools to explore the project structure, examine the actual code, then return a structured identification of the relevant files with detailed rationales.',
  instructions: [
    'Analysis Strategy: Study the ticket description to understand what needs to be implemented. Use your file-reading and directory-listing tools to explore the project structure and identify files that would need to be read, modified, or depended upon when implementing this ticket.',
    'Rationale Depth: For each file, write a detailed multi-sentence rationale (3-6 sentences) that explains: (a) WHY this file is relevant to the ticket, (b) WHICH specific symbols (functions, classes, types, exports) inside the file matter and why, (c) what role this file plays in the implementation (dependency, modification target, type source, test target, etc.), and (d) how it connects to other relevant files. The rationale is the primary value of your output — be thorough and specific.',
    'Content Preview: For each file, include a `content_preview` field containing ONLY the key symbol signatures relevant to the ticket — function/method signatures, type/interface definitions, class declarations, and export statements. Do NOT include function bodies, implementations, or full code blocks. Aim for 5-20 lines of signatures per file. Think of this as a table-of-contents for the file, not a code excerpt.',
    'Relevance Ordering: Present files in descending order of relevance. Core implementation files first, then type definitions, then supporting utilities, then tests/configs.',
    'Scope Discipline: Read only files genuinely relevant to the ticket. Do not read entire directories. Aim for precision: 5-25 files depending on ticket scope. Never exceed 30 files.',
    'Output Envelope: Return exactly one <RELEVANT_FILES_RESULT>...</RELEVANT_FILES_RESULT> block and nothing else before or after it.',
    'YAML Discipline: Inside the block, output only strict YAML with valid indentation. Do not use markdown fences anywhere inside the block.',
    'Count Consistency: `file_count` must exactly equal the final number of entries in `files`.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: 'YAML inside <RELEVANT_FILES_RESULT> tags with top-level keys: `file_count` (integer), `files` (list). Each file item: `path` (string), `rationale` (string, detailed 3-6 sentences), `relevance` (high|medium|low), `likely_action` (read|modify|create), `content_preview` (string, key symbol signatures only — no implementations). No other top-level keys.',
  contextInputs: ['ticket_details'],
  toolPolicy: 'default',
}

// Interview Phase Prompts
export const PROM1: PromptTemplate = {
  id: 'PROM1',
  description: 'Interview Draft Specification Prompt',
  systemRole: 'You are an expert product manager and technical interviewer.',
  task: "Generate a comprehensive set of interview questions to gather all requirements and clarify the user's intent for the project.",
  instructions: [
    'Phase 1 - Foundation (What/Who/Why): First establish project intent, target user, core value, constraints (and out of scope), and non-goals. Exit criteria: no core ambiguity remains for problem, user, and objective.',
    'Phase 2 - Structure (Complete Feature Inventory): Then capture the full list of required features and major user flows before deep implementation details. Exit criteria: feature inventory is complete, deduplicated, and prioritized.',
    'Phase 3 - Assembly (Deep Dive Per Feature): Then go feature-by-feature and define implementation-level expectations (behavior, edge cases, acceptance criteria, test intent, dependencies). Exit criteria: each in-scope feature has enough detail to support PRD generation without guessing.',
    INTERVIEW_PHASE_ORDER_RULE,
    'Question Limit: Treat `max_initial_questions` as a hard upper bound, never a target. Ask only as many questions as are genuinely needed to remove meaningful ambiguity and gather enough detail for PRD generation. Returning well under `max_initial_questions` is fully acceptable when coverage is already strong. Do not add low-value or redundant questions just because budget remains.',
    'Single Response Completeness: Return one complete final `questions` list in this single response. Do not stop after only the `foundation` phase, do not emit a partial subset or phased draft, and do not split the list across multiple messages. Whatever number of questions you decide is necessary, include that entire final set in the one YAML artifact.',
    CONDITIONAL_REPOSITORY_INSPECTION,
    INTERVIEW_REPOSITORY_BOUNDARY,
    'Question Grounding: When the supplied repository context is insufficient to make a technical question precise, inspect only the relevant repository area before drafting it. Keep product and stakeholder choices as questions for the user.',
    `Output Format: Output strict machine-readable YAML. The top-level key MUST be \`questions\` containing a list. Each entry MUST have exactly three fields: \`id\`, \`phase\`, and \`question\`.
    Example:
    \`\`\`yaml
    questions:
      - id: Q01
        phase: foundation
        question: "Your question here?"
          - id: Q02
        phase: structure
        question: "Another question?"
    \`\`\``,
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: 'YAML with top-level `questions` list. Each item: {id, phase, question}. No other fields.',
  contextInputs: ['relevant_files', 'ticket_details'],
  toolPolicy: 'read_only',
}

export const PROM2: PromptTemplate = {
  id: 'PROM2',
  description: 'Interview Council Voting Prompt',
  systemRole: 'You are an impartial judge on an AI Council. Your role is to evaluate multiple sets of proposed interview questions objectively.',
  task: 'Read all provided interview question drafts. Evaluate how well each draft will extract the necessary requirements from the user without being overwhelming. Rate each draft from 0 to 100.',
  instructions: [
    'Impartiality: Rate impartially as if all drafts are anonymous. Do not favor any draft based on its origin or style.',
    'Anti-anchoring: Drafts are presented in randomized order per evaluator. Do not assume the first draft is the baseline or best.',
    'Scoring Rubric (minimum 0, maximum 20 points per category, total maximum 100): 1) Coverage of requirements. 2) Correctness / feasibility. 3) Testability. 4) Minimal complexity / good decomposition. 5) Risks / edge cases addressed.',
    buildStrictVoteOutputInstruction(VOTING_RUBRIC_INTERVIEW.map(item => item.category)),
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: STRICT_VOTE_OUTPUT_FORMAT,
  contextInputs: ['relevant_files', 'ticket_details', 'drafts'],
  toolPolicy: 'disabled',
}

export const PROM3: PromptTemplate = {
  id: 'PROM3',
  description: 'Interview Winner Refinement Prompt',
  systemRole: "You are the Lead Product Manager and the winner of the AI Council's interview drafting phase.",
  task: 'Create the final, definitive version of your interview questions by reviewing the alternative (losing) drafts for useful inspiration. Keep the winning draft as the primary foundation, but feel free to improve it wherever the alternatives clearly produce a stronger final draft.',
  instructions: [
    'Anchor on the winning draft. It won because its structure, sequencing, and core decisions are the best starting point. Preserve its strengths, but do not treat its exact wording or every individual question as untouchable.',
    'Use the alternative drafts as inspiration, not as equal-weight sources to merge blindly. They may surface missed topics, sharper phrasing, stronger sequencing, or better edge-case coverage, and you may adopt those improvements whenever they make the final draft meaningfully better.',
    'Gap Scan: Read through the alternative drafts and note only high-value candidates: topics you truly skipped, edge cases you clearly missed, or questions that are materially clearer or more precise than yours. These are optional candidates — not automatic additions.',
    'Selective Upgrade: For each candidate, ask whether it creates a clear net improvement over the winning draft. If it fills a real gap or add value to the project, add it. If it meaningfully improves one of your existing questions, adapt, replace, or combine questions while keeping the winning draft’s overall voice and quality bar. Otherwise, discard it.',
    'Measured Refinement: Do not rewrite from scratch or blend drafts together just for balance. But it is acceptable to improve several questions, adjust local sequencing, or rework wording across the draft if that produces a clearly stronger final result.',
    'Question Limit: Treat `max_initial_questions` as a hard upper bound, never a target. Keep only the questions that are necessary for strong coverage. Returning well under `max_initial_questions` is fully acceptable when the winning draft already covers the space well. Do not add low-value questions just because capacity remains.',
    'Restraint: Avoid appending near-duplicate questions that merely rephrase something you already cover. Prefer meaningful improvements over cosmetic churn. But if genuine gaps exist — topics missed, edge cases overlooked — fill them, as long as you stay within `max_initial_questions`.',
    'ID Stability: Preserve the winning draft\'s existing `id` for every question that still exists in the final draft, even if its wording improves or its position moves. Do not renumber surviving questions for neatness. Assign fresh IDs only to genuinely new questions, using new numeric IDs above the current maximum winner-draft ID.',
    'Single Artifact Contract: Return one YAML artifact that contains both the final refined `questions` list and a top-level `changes` list. Do not split the refined questions and change metadata across multiple outputs, wrappers, or separate artifacts.',
    'Changes Coverage: The top-level `changes` list must fully account for the differences between the winning draft and the final refined draft. Use `type` values `modified`, `replaced`, `added`, or `removed`. For each entry, include `before` and `after` question records (or `null` when appropriate for added/removed changes).',
    'Optional Inspiration Attribution: When a change was directly inspired by an alternative draft, include `inspiration` with `alternative_draft` and the inspiring `question`. If a change was not directly inspired by a losing draft, omit `inspiration` or set it to null.',
    INTERVIEW_PHASE_ORDER_RULE,
    CONDITIONAL_REPOSITORY_INSPECTION,
    INTERVIEW_REPOSITORY_BOUNDARY,
    'Question Refinement Grounding: Before adding or sharpening a technical question based on an unsupported repository-specific assumption, inspect only the smallest relevant repository area. Keep stakeholder choices as questions for the user.',
    'Formatting: Output the final refined draft and the top-level `changes` list using the exact structural format required for this phase. Output only this single artifact.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: 'YAML with top-level `questions` list and top-level `changes` list. Each `questions` item: {id, phase, question}. Each `changes` item: {type, before, after, inspiration?}. `type` must be one of {modified, replaced, added, removed}. `before` and `after` use the same question shape or null when appropriate. Optional `inspiration` uses {alternative_draft, question}. No extra wrapper object.',
  contextInputs: ['relevant_files', 'ticket_details', 'drafts'],
  toolPolicy: 'read_only',
}

export const PROM4_FINAL_INTERVIEW_SCHEMA = [
  'Final Interview YAML Schema:',
  'schema_version: 1',
  'ticket_id: "<ticket-id>"',
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
  '    options:',
  '      - id: opt1',
  '        label: "Option label"',
  '    answer:',
  '      skipped: false',
  '      selected_option_ids: []',
  '      free_text: "User answer or empty string"',
  '      answered_by: user | ai_skip',
  '      answered_at: "<ISO-8601 timestamp or empty string>"',
  'follow_up_rounds:',
  '  - round_number: 1',
  '    source: prom4 | coverage',
  '    question_ids: ["FU1"]',
  'summary:',
  '  goals: []',
  '  constraints: []',
  '  non_goals: []',
  '  final_free_form_answer: ""',
  'approval:',
  '  approved_by: ""',
  '  approved_at: ""',
].join('\n')

export const PROM4: PromptTemplate = {
  id: 'PROM4',
  description: 'Interview Batch Question Prompt',
  systemRole: 'You are an expert product manager conducting an interview with a user.',
  task: "Review the user's answers to questions and adjust the upcoming ones to improve coherence and extract missing details.",
  instructions: [
    'Batching and Progress: Present batches of 1-3 questions. You MUST vary the batch size — do NOT always use 3. Choose batch size dynamically: use 1 for complex/open-ended/high-priority questions that need focused attention; use 2 for moderately related questions or when the user gave brief/unclear previous answers; use 3 only for simple/clear-cut/factual questions that are tightly related. If in doubt, prefer smaller batches. Show progress (e.g., question 12 of the current planned set, where the total may change), and wait for the user to answer all questions in that batch.',
    'Compiled Checklist: Treat the compiled questions supplied in context as the primary interview checklist, not as background reference. Use them as the default plan for the interview and keep them actively in mind throughout the conversation.',
    'Checklist Fidelity: Try to work through the compiled question set faithfully before ending the interview. You may adapt sequencing and wording for coherence, and if a user answer fully resolves one or more future compiled questions, you may skip those future questions instead of asking them redundantly. Stay anchored to the compiled agenda rather than drifting to a much smaller custom subset just because coverage feels strong.',
    'Adaptation and IDs: You may reorder, rephrase, merge, or lightly split compiled questions when it improves coherence, but keep them tied to the original compiled agenda. When adapting a compiled question, preserve its original compiled question ID whenever possible; use new follow-up IDs only for genuinely new follow-up questions you introduce.',
    'Auto-Skipping: Do not silently drop compiled questions just because earlier answers seem broadly sufficient. Auto-skip a compiled question only when the user has already answered it implicitly, when a prior answer fully resolves that question, or when it has become clearly redundant or no longer useful to ask, and keep that question accounted for in the final interview results under its compiled ID.',
    'Adaptive Iteration: After each batch, analyze answers and adjust only upcoming questions when needed. Treat `max_follow_ups` as a hard cap derived from the configured coverage follow-up budget percent. Add follow-up questions only when they are necessary to resolve meaningful ambiguities, update/delete now-redundant questions, and accept skipped answers without re-asking unless the missing answer is critical. Follow-up questions may interleave with compiled questions when they materially improve coherence or unblock later compiled questions. Do not use the follow-up budget unless it materially improves coverage.',
    CONDITIONAL_REPOSITORY_INSPECTION,
    INTERVIEW_REPOSITORY_BOUNDARY,
    'Interactive Repository Grounding: If the user mentions an existing component, behavior, limitation, command, path, or architecture detail, inspect only the directly relevant repository area when confirmation would affect the next batch or a follow-up. Do not explore broadly or delay the interview to inspect the repository.',
    "Final Free-Form Question: Do not move to the final free-form question just because coverage feels good enough. First work through or explicitly account for the remaining compiled questions, including future compiled questions made unnecessary by earlier answers, and only after the compiled checklist has been answered, skipped, or rendered redundant and no major ambiguity remains, present one final free-form question. Keep the question anchored to 'Anything else to add before PRD generation?' but explicitly tell the user that the next step is interview coverage check, that coverage check may still create targeted follow-up questions if gaps are found, and that there is still an interview approval step before PRD drafting begins.",
    'Final Output: After the final free-form question is answered or skipped, output the final interview results file in a strict machine-readable format.',
    `Structured Batch Output: Wrap each intermediate batch response in <INTERVIEW_BATCH> tags containing YAML with these fields:
  batch_number: (integer, starting at 1)
  progress:
    current: (same as batch_number — the sequential batch index, starting at 1)
    total: (estimated total number of batches planned, may change as you adapt)
  is_final_free_form: (boolean, true only for the final free-form question)
  ai_commentary: (brief text explaining why you chose these questions or how you adapted)
  questions:
    - id: (string, e.g. "Q12" or "FU3")
      question: (the question text)
      phase: (Foundation | Structure | Assembly)
      priority: (critical | high | medium | low)
      rationale: (why this question matters)
      answer_type: (REQUIRED — evaluate every question and choose the best type. Default to structured answer types; use free_text only as a last resort:
        - "yes_no" for simple boolean/binary questions (e.g., "Do you need authentication?", "Should there be an admin panel?") — do NOT include options, the system generates Yes/No automatically
        - "single_choice" for mutually-exclusive choices from a finite set (e.g., "Which database engine?", "What deployment target?") — provide 2-10 options
        - "multiple_choice" for "select all that apply" from a finite set (e.g., "Which platforms to support?", "Which authentication methods?") — provide 2-15 options
        - "free_text" ONLY for genuinely open-ended questions where the answer space cannot be reasonably enumerated into choices (e.g., "Describe the problem you're solving", "What are your performance requirements?")
        IMPORTANT: Prefer structured types (yes_no, single_choice, multiple_choice) as the default. At least 60-70% of questions should use structured types. Most product and technical questions CAN be expressed as choices — think about what the realistic options are and offer them. Use free_text ONLY when the answer is truly creative, narrative, or unbounded. The user always has a free-form text field below the options to add notes or write their own answer, so structured types never limit the user. Do NOT include an "Other" option yourself.)
      options: (required when answer_type is single_choice or multiple_choice; omit for free_text and yes_no — list of choices with id and label, e.g.:)
        - id: opt1
          label: "PostgreSQL"
        - id: opt2
          label: "MySQL"`,
    'Final Complete Output: When the interview is fully complete (after the final free-form answer), wrap the final output in <INTERVIEW_COMPLETE> tags containing YAML that matches this exact interview-results schema.',
    PROM4_FINAL_INTERVIEW_SCHEMA,
    'Output Discipline: For intermediate turns, return exactly one <INTERVIEW_BATCH> block and nothing else outside it. For the final turn, return exactly one <INTERVIEW_COMPLETE> block and nothing else outside it.',
    'Formatting Discipline: Do not place markdown fences inside either tag block. Keep YAML indentation valid so every question field stays nested under its list item.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: 'YAML — complete interview results file with schema_version, ticket_id, artifact, status, generated_by, questions, follow_up_rounds, summary, approval',
  contextInputs: ['ticket_details'],
  toolPolicy: 'read_only',
}

export const PROM5: PromptTemplate = {
  id: 'PROM5',
  description: 'Interview Coverage Verification Prompt',
  systemRole: 'You are a meticulous Quality Assurance Lead.',
  task: 'Re-read the original ticket description and all collected user answers, then compare them against the final Interview Results file to ensure complete coverage.',
  instructions: [
    'Coverage Check: Detect unresolved ambiguity, missing constraints, missing edge cases, missing non-goals, and inconsistent answers.',
    'Identify Gaps: List any specific gaps or discrepancies found between the source material and the Interview Results.',
    CONDITIONAL_REPOSITORY_INSPECTION,
    INTERVIEW_REPOSITORY_BOUNDARY,
    'Coverage Grounding: Inspect only the relevant repository area when needed to determine whether a technical fact is discoverable or whether a technical follow-up is necessary. Do not use repository contents to resolve a stakeholder decision.',
    'Coverage Limits: Treat `coverage_run_number` and `max_coverage_passes` from the context as hard limits. Coverage can run once or at most `max_coverage_passes` times in total. If `is_final_coverage_run` is true, report any unresolved gaps clearly without assuming another retry exists.',
    'Follow-up Budget: Treat `coverage_follow_up_budget_percent`, `follow_up_budget_total`, `follow_up_budget_used`, and `follow_up_budget_remaining` from the context as hard limits. If gaps exist, generate only the targeted follow-up questions strictly necessary to resolve them and never exceed `follow_up_budget_remaining`. If `follow_up_budget_remaining` is `0`, you must return `follow_up_questions: []`.',
    'Coverage Follow-up ID Rule: Every generated follow-up question must use a new ID that does not reuse any existing canonical interview question ID or `QFF1`. When you need a new coverage-specific ID, prefer the `CFU<n>` form.',
    'If no gaps exist, confirm that the Interview Results are complete and ready for interview approval, and make clear that PRD generation begins only after that approval step.',
    'Output Envelope: return only YAML with top-level `status`, `gaps`, and `follow_up_questions`.',
    'YAML Validity: Every item in `gaps` must be a double-quoted YAML string, even when the text contains code identifiers, paths, flags, backticks, or punctuation.',
    `Gap Triggering: Use \`status: gaps\` only when at least one real unresolved gap remains. When \`status: gaps\`, \`follow_up_questions\` must be a YAML list of question objects with these fields: \`id\`, \`question\`, \`phase\`, \`priority\`, \`rationale\`, and \`answer_type\` (REQUIRED — choose the best type for each question: "free_text" for open-ended, "single_choice" for mutually-exclusive finite sets with 2-10 options, "multiple_choice" for select-all-that-apply with 2-15 options, "yes_no" for simple boolean questions without options). When answer_type is single_choice or multiple_choice, include an \`options\` list with \`id\` and \`label\` fields. Do not return plain strings in \`follow_up_questions\`.`,
    'Do not output rewritten interview results, summaries, or any extra keys.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: INTERVIEW_COVERAGE_OUTPUT_FORMAT,
  contextInputs: ['ticket_details', 'user_answers', 'interview'],
  toolPolicy: 'read_only',
}

// PRD Phase Prompts
export const PROM10a: PromptTemplate = {
  id: 'PROM10a',
  description: 'PRD Gap Resolution Prompt',
  systemRole: 'You are an expert Technical Product Manager and Software Architect.',
  task: 'Fill every skipped answer in the approved Interview Results and output one complete Full Answers interview artifact that preserves the original approved interview structure.',
  instructions: [
    'Source Of Truth: Treat the provided approved Interview Results as canonical for question order, IDs, prompts, phases, options, source metadata, and every non-skipped user answer.',
    'Provided Artifact Rule: The approved Interview Results artifact is already included in the prompt. Do not search for or fetch another copy of it before answering.',
    'Preservation Rule: Preserve every existing non-skipped answer exactly as-is. Do not rewrite, summarize, or improve user-provided answers.',
    'Allowed Edits Only: The only fields you may change are `questions[*].answer` for questions whose current answer is marked `skipped: true`.',
    'Forbidden Edits: Do not change question IDs, question order, prompts, phases, `answer_type`, `options`, `follow_up_rounds`, `summary`, approval fields, or any existing non-skipped answer.',
    'Artifact Shape Rule: `artifact` must be the scalar value `interview` on one line. Do not wrap the document under `artifact.interview` or any other envelope.',
    'Generated By Shape Rule: `generated_by` must be a mapping block with exactly these child keys: `winner_model`, `generated_at`, and `canonicalization`.',
    'Top-Level Placement Rule: `follow_up_rounds`, `summary`, and `approval` must each appear once at the top level after `questions`. Never nest them under a question, answer, or another wrapper object.',
    'Gap Resolution Rule: Fill only the questions whose current answer is marked `skipped: true`. Use the ticket details, relevant files, and the rest of the interview to infer the strongest concrete answer.',
    CONDITIONAL_REPOSITORY_INSPECTION,
    'Repository Fact Rule: Use inspection only to confirm a technical fact needed for a skipped answer. Preserve all user-provided answers exactly and do not treat repository contents as evidence of a stakeholder preference, scope decision, priority, desired behavior, or acceptance decision.',
    'Answer Encoding: For every filled skipped question, set `answer.skipped: false`, provide a concrete `free_text` and/or `selected_option_ids` consistent with the question `answer_type`, set `answered_by: ai_skip`, and set a non-empty ISO-8601 `answered_at` timestamp. When the answer type is choice-based, populate best-fit canonical `selected_option_ids` using the provided option IDs. For any `free_text` question with `skipped: false`, `free_text` must be non-empty.',
    'Question Copy Rule: Copy each canonical question block exactly as provided and change only the `answer` block for skipped questions.',
    'Choice Canonical ID Rule: For `single_choice` and `multiple_choice`, always set `selected_option_ids` using the canonical option IDs already present in that question block. Never invent option IDs or rewrite the `options` list.',
    'Choice Orientation Rule: Treat provided single-choice and multiple-choice options as orientation only, not as the full answer. Use the closest canonical `selected_option_ids` when they help anchor the answer, but if the better inferred answer goes beyond the listed options, capture that better answer in concise `free_text`.',
    'Choice Free Text Rule: For choice questions, `free_text` is optional when an existing option is an exact fit, but preferred when nuance, caveats, or a better suggestion matter. Do not use `free_text` only to restate the selected option label.',
    'Final Free-Form Rule: If the final free-form question truly has nothing else to add, still write a short explicit `free_text` response such as "Nothing else to add." instead of `""`.',
    'Conditional Follow-Up Rule: If an earlier answer makes a follow-up question not applicable, say that explicitly in `free_text`; never leave that follow-up answer blank.',
    'No Remaining Gaps: In the final artifact, no question may remain with `answer.skipped: true`.',
    'Artifact Status: Output the completed interview artifact as `status: draft` with empty approval fields, because these AI-filled answers are not user-approved.',
    'Self-Check: Before responding, verify that the output contains the exact same number of questions and the exact same canonical question IDs as the approved interview artifact.',
    'Completeness Rule: Return the entire interview artifact from `schema_version` through the final `approval` block. Do not stop early, emit only a prefix, or omit trailing question blocks. If space is tight, shorten answer text instead of omitting later question blocks.',
    'Clean Stop Rule: Stop immediately after the final `approval` block. Do not append status text, markdown fences, tool notes, stray terminal characters, or any note that says Do not read files, search for more context, propose an implementation plan.',
    'Prompt Echo Guard: Never repeat prompt scaffolding or placeholder schema lines from `## Expected Output Format`, `## Context`, or `# Ticket:`. Output only the final artifact.',
    'Output Discipline: Return exactly one complete interview artifact and nothing else. No prose, no PRD content, no wrappers, no markdown fences, and no extra keys.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: PROM4_FINAL_INTERVIEW_SCHEMA,
  contextInputs: ['relevant_files', 'ticket_details', 'interview'],
  toolPolicy: 'read_only',
}

export const PROM10b: PromptTemplate = {
  id: 'PROM10b',
  description: 'PRD Draft Specification Prompt',
  systemRole: 'You are an expert Technical Product Manager and Software Architect.',
  task: 'Generate a complete Product Requirements Document (PRD) based on the provided Full Answers interview artifact. The PRD must be detailed enough that an AI coding agent can implement the feature without ambiguity.',
  instructions: [
    'Complete Interview Input: Treat the provided Full Answers interview artifact as the complete requirement source, including any AI-resolved answers for questions the user originally skipped.',
    'Source Contradiction Rule: If the provided source artifacts are internally contradictory, do not choose a side or invent a requirement to reconcile them. Represent only requirements that are supported by the source artifacts and preserve unresolved contradictions as explicit risks or open ambiguity in the PRD.',
    'Product Scope: Include epics, user stories, and acceptance criteria. Every in-scope feature from the Interview Results must map to at least one user story.',
    'Epic Completeness: Every epic must include at least one fully populated `user_stories` entry. Never emit an epic shell with `user_stories: []`, omit `user_stories`, or park requirements only at epic level.',
    'Implementation Steps: For each user story, include detailed technical implementation steps decomposed as far as possible — data flows, state changes, component interactions, and integration points.',
    'Technical Requirements: Define architecture constraints, data model, API/contracts, security/performance/reliability constraints, error-handling rules, tooling/environment assumptions, explicit non-goals.',
    CONDITIONAL_REPOSITORY_INSPECTION,
    'Repository Claim Rule: Before adding an exact command, file path, framework, package manager, build system, or test runner that is not already concretely evidenced by the supplied context, confirm it with focused repository inspection.',
    'Schema Contract: Follow the exact PRD YAML schema in the Expected Output Format section, including all required top-level keys and nested fields.',
    'Output Format: Output a single, comprehensive PRD document covering all of the above in one artifact.',
    'Boundary Rule: Begin the artifact at `schema_version` and end at `approval.approved_at`. Do not prepend or append any prose.',
    'Length Safety: If output length is a concern, shorten field text instead of truncating later epics, user stories, risks, or the final approval block.',
    'Prompt Echo Guard: Never repeat prompt scaffolding or placeholder schema lines from `## Expected Output Format`, `## Context`, or `# Ticket:`. Output only the final artifact.',
    'No Prose Mode: Never output implementation plans, diffs, next steps, acknowledgements, commentary, or any text outside the PRD YAML artifact.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: PRD_OUTPUT_FORMAT,
  contextInputs: ['relevant_files', 'ticket_details', 'full_answers'],
  toolPolicy: 'read_only',
}

export const PROM11: PromptTemplate = {
  id: 'PROM11',
  description: 'PRD Council Voting Prompt',
  systemRole: 'You are an impartial judge on an AI Council. Your role is to evaluate multiple Product Requirements Document (PRD) drafts objectively.',
  task: 'Read all provided PRD drafts, compare each draft against the Interview Results, and evaluate them against each other. Rate each draft from 0 to 100.',
  instructions: [
    'Impartiality: Rate impartially as if all drafts are anonymous. Do not favor any draft based on its origin or style.',
    'Anti-anchoring: Drafts are presented in randomized order per evaluator. Do not assume the first draft is the baseline or best.',
    'Draft Provenance: Some PRD drafts may reflect model-specific AI-filled answers for questions the user originally skipped. Score the draft quality and requirement coverage as presented, not the identity of the model that filled those gaps.',
    'Scoring Rubric (minimum 0, maximum 20 points per category, total maximum 100): 1) Coverage of requirements. 2) Correctness / feasibility. 3) Testability. 4) Minimal complexity / good decomposition. 5) Risks / edge cases addressed.',
    buildStrictVoteOutputInstruction(VOTING_RUBRIC_PRD.map(item => item.category)),
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: STRICT_VOTE_OUTPUT_FORMAT,
  contextInputs: ['relevant_files', 'ticket_details', 'interview', 'drafts'],
  toolPolicy: 'disabled',
}

export const PROM12: PromptTemplate = {
  id: 'PROM12',
  description: 'PRD Winner Refinement Prompt',
  systemRole: "You are the Lead Architect and the winner of the AI Council's PRD drafting phase.",
  task: 'Create the final, definitive version of your PRD by reviewing the alternative (losing) drafts. Extract any superior ideas, missing edge cases, or better technical constraints they contain, and integrate them seamlessly into your winning foundation.',
  instructions: [
    'Anchor on the winning draft. It won because its structure, architecture decisions, and core requirements are the best starting point. Preserve its strengths, but do not treat its exact wording or every individual epic as untouchable.',
    'Full Answers Context: Each council member produced their own Full Answers artifact during PRD drafting — filling in skipped interview questions with their own model-specific answers. As a result, each PRD draft was built from a different set of underlying answers and assumptions. When reviewing alternative drafts, consider not just the PRD requirements themselves but also the Full Answers that informed them. Some models may have produced better answers for certain skipped questions, leading to requirements you should adopt.',
    'Gap Scan: Read through the alternative drafts and note anything they cover that your draft does not: requirements you missed, edge cases or error states you omitted, risks you underweighted, or constraints that are unambiguously more precise than yours. These are candidates — not automatic additions.',
    'Selective Upgrade: For each candidate, decide: does it add genuine value, or is it a rephrasing of something you already cover well? If it fills a real gap, add it. If it is a strictly better formulation of something you already have, replace yours with it. Otherwise, discard it.',
    'Measured Refinement: Do not rewrite from scratch or blend drafts together just for balance. But it is acceptable to improve multiple sections, adjust local structure, or rework content across the draft if that produces a clearly stronger final result.',
    'Restraint: Avoid adding content that merely restates what you already cover. But if genuine gaps exist — missing requirements, unaddressed risks, overlooked error states — add them; completeness matters more than brevity.',
    'Epic Completeness: Every epic in the final PRD must include at least one fully populated `user_stories` entry. Never leave an epic as a shell with `user_stories: []`, omit `user_stories`, or move story-level requirements only into epic-level fields.',
    CONDITIONAL_REPOSITORY_INSPECTION,
    'Repository Claim Preservation: Before adopting repository-specific architecture, paths, commands, tooling, or framework details from an alternative draft, confirm unsupported details with focused repository inspection.',
    'Single Artifact Contract: Return one YAML artifact that contains both the final refined PRD and a top-level `changes` list. Do not split the refined PRD and change metadata across multiple outputs, wrappers, or separate artifacts.',
    'Changes Coverage: The top-level `changes` list must fully account for the differences between the winning PRD and the final refined PRD using only changed epic and user story items. Use `type` values `modified`, `added`, or `removed`. Include `item_type` (`epic` or `user_story`) plus `before` and `after` item records (or `null` when appropriate).',
    'One-Entry-Per-Item Rule: Every changed epic or user story must appear exactly once in `changes`. Epic changes do not subsume changed user stories. If an existing item keeps the same ID but its content changes, emit exactly one `modified` entry for that item.',
    'Optional Inspiration Attribution: When a change was directly inspired by an alternative draft, include `inspiration` with `alternative_draft` and the inspiring `item`. Include `inspiration.item.detail` whenever the source item has useful supporting text (for example objective, description, acceptance, or implementation detail). If a change was not directly inspired by a losing draft, omit `inspiration` or set it to null.',
    'Formatting: Output only this single refined PRD artifact with its top-level `changes` list.',
    'Schema Preservation: keep the same PRD schema, required top-level sections, and nested field structure. Do not wrap the PRD in another object.',
    'ID Stability: Preserve existing epic IDs and user story IDs from the winning draft unless you are adding a genuinely new epic or story.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: `${PRD_OUTPUT_FORMAT}\nAlso include a top-level \`changes\` list. Each change item: {type, item_type, before, after, inspiration?}. \`type\` must be one of {modified, added, removed}. \`item_type\` must be \`epic\` or \`user_story\`. \`before\` and \`after\` use {id, label, detail?} or null when appropriate. Optional \`inspiration\` uses {alternative_draft, item}. Keep everything in one YAML artifact.`,
  contextInputs: ['relevant_files', 'ticket_details', 'full_answers', 'drafts'],
  toolPolicy: 'read_only',
}

export const PROM13: PromptTemplate = {
  id: 'PROM13',
  description: 'PRD Coverage Verification Prompt',
  systemRole: 'You are a meticulous Quality Assurance Lead.',
  task: 'Re-read the winner Full Answers artifact, then compare it against the final PRD to ensure complete coverage.',
  instructions: [
    'Primary Truth: Treat the winner Full Answers artifact as the canonical source for PRD coverage. It contains the user-provided answers plus the adopted AI completion for skipped questions.',
    'Coverage Check: Detect unresolved ambiguity, missing requirements, missing edge cases, missing constraints, missing acceptance criteria, missing non-goals or out-of-scope items, and inconsistencies between the winner Full Answers artifact and the PRD.',
    'Source Artifact Contradictions: If the winner Full Answers artifact is internally contradictory in a way the PRD cannot faithfully satisfy, report the contradiction as an unresolved coverage gap. Do not choose a side or invent requirements to reconcile contradictory source artifacts.',
    'Coverage Strictness: Treat weak coverage as a real gap when the PRD mentions a requirement but leaves it materially underspecified. Acceptance criteria must be specific enough to verify, not just broad restatements of the feature title or user story.',
    'Traceability Rule: Every major in-scope requirement, user flow, constraint, non-goal, or explicit edge case captured in the winner Full Answers artifact must be represented somewhere in the PRD by at least one concrete epic, user story, acceptance criterion, scope item, constraint, or risk entry.',
    'Verification Readiness: Flag PRD user stories that have missing or weak verification guidance when the acceptance criteria are not concrete enough to support later implementation verification.',
    CONDITIONAL_REPOSITORY_INSPECTION,
    'Repository Claim Audit: Use focused repository inspection only when repository evidence is needed to assess a concrete command, path, tooling, or implementation claim in the PRD. Keep the Full Answers artifact as the source of truth for requirements.',
    'Identify Gaps: List any specific gaps or discrepancies found between the winner Full Answers artifact and the PRD.',
    'Coverage Limits: Treat `coverage_run_number` and `max_coverage_passes` from the context as hard limits. Coverage can run once or at most `max_coverage_passes` times in total. If `is_final_coverage_run` is true, report unresolved gaps clearly without assuming another refinement pass exists.',
    'If no gaps exist, confirm that the PRD is complete and ready for PRD approval, and make clear that Beads breakdown begins only after that approval step.',
    'PRD Follow-Up Rule: `follow_up_questions` is always `[]` for PRD coverage. Do not invent new PRD questions; use `gaps` only.',
    'Audit-Only Contract: This prompt only audits the current PRD candidate. Do not rewrite the PRD, propose changes, or include resolution notes in this response.',
    'Output Envelope: return only YAML with top-level `status`, `gaps`, and `follow_up_questions`.',
    'YAML Validity: Every item in `gaps` must be a double-quoted YAML string, even when the text contains code identifiers, paths, flags, backticks, or punctuation.',
    'Gap Triggering: Use `status: gaps` only when at least one real unresolved gap remains. For PRD coverage, `follow_up_questions` should normally be an empty list. Use `status: gaps` plus concrete `gaps` entries to trigger another refinement pass. Count materially vague acceptance criteria, missing scope boundaries, missing traceability for major in-scope items, and weak verification guidance as real gaps when they would force later phases to guess.',
    'Do not output a rewritten PRD, PRD patch, or any extra keys.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: `${COVERAGE_OUTPUT_FORMAT} For PRD coverage, \`follow_up_questions\` must always be \`[]\`.`,
  contextInputs: ['full_answers', 'prd'],
  toolPolicy: 'read_only',
}

export const PROM13b: PromptTemplate = {
  id: 'PROM13b',
  description: 'PRD Coverage Resolution Prompt',
  systemRole: 'You are a meticulous Technical Product Manager resolving concrete PRD coverage gaps.',
  task: 'Revise the current PRD candidate to address the provided coverage gaps while preserving the candidate as the baseline. Return one updated PRD artifact plus machine-readable change and gap-resolution metadata.',
  instructions: [
    'Primary Truth: Treat the winner Full Answers artifact as the canonical source for PRD coverage. It contains the user-provided answers plus the adopted AI completion for skipped questions.',
    'Baseline Rule: Treat the provided current PRD candidate as the baseline. Do not rewrite from scratch.',
    'Gap Resolution Rule: Address only the concrete coverage gaps provided in the context. Do not make unrelated improvements.',
    'Source Artifact Contradictions: If a provided gap describes internally contradictory source artifacts, do not choose a side, invent a requirement, or revise the PRD to pretend the contradiction is resolved. Record that gap with `action: left_unresolved` and `affected_items: []`.',
    'Preservation Rule: Keep existing epic IDs and user story IDs unless the revised candidate requires a genuinely new item.',
    'Epic Completeness: Every epic in the revised PRD must include at least one fully populated `user_stories` entry. Never leave an epic as a shell with `user_stories: []`, omit `user_stories`, or move story-level requirements only into epic-level fields.',
    'Specificity Rule: When a provided gap says coverage is vague or hard to verify, resolve it by making the affected acceptance criteria, scope language, or verification guidance more concrete and testable instead of adding generic filler prose.',
    CONDITIONAL_REPOSITORY_INSPECTION,
    'Repository Claim Revision: Before adding or revising repository-specific commands, paths, tooling, or implementation details, confirm unsupported details with focused repository inspection.',
    'Change Accounting: Include a top-level `changes` list that fully and exactly accounts for the diff between the current PRD candidate and the revised PRD candidate.',
    'Gap Resolution Accounting: Include a top-level `gap_resolutions` list with exactly one entry per provided gap.',
    'Gap Resolution Actions: Each `gap_resolutions` entry must include `gap`, `action`, `rationale`, and `affected_items`. `action` must be one of `updated_prd`, `already_covered`, or `left_unresolved`.',
    'Affected Items: `affected_items` must be a YAML list of `{ item_type, id, label }` entries referencing epic or user_story items. Use an empty list when no epic/story reference applies.',
    'Section-Level Changes: If a gap updates top-level PRD sections such as `product`, `scope`, `technical_requirements`, or `api_contracts`, keep `affected_items: []`. Never emit `item_type: prd`, `section`, or similar section references in `affected_items`.',
    'Output Discipline: Return only one PRD YAML artifact using the normal PRD schema, plus top-level `changes` and `gap_resolutions`. Do not add wrappers or prose.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: `${PRD_OUTPUT_FORMAT}\nAlso include top-level \`changes\` and \`gap_resolutions\` lists. \`changes\` uses the same shape as PROM12 refinement output. Each \`gap_resolutions\` item: {gap, action, rationale, affected_items}. \`action\` must be one of {updated_prd, already_covered, left_unresolved}. Each \`affected_items\` entry: {item_type, id, label}.`,
  contextInputs: ['full_answers', 'prd', 'coverage_gaps'],
  toolPolicy: 'read_only',
}

// Beads Phase Prompts
export const PROM20: PromptTemplate = {
  id: 'PROM20',
  description: 'Beads Draft Specification Prompt',
  systemRole: 'You are an expert Software Architect.',
  task: 'Create a Beads breakdown (architecture/task graph) based on the final PRD.',
  instructions: [
    'Decomposition: Split each user story into one or more beads using phased modular decomposition appropriate to the feature domain (e.g., input capture → normalization/validation → core domain logic → integration/adapters → output/presentation) to keep flow logical and dependencies minimal.',
    'Granularity: Each bead must be the smallest independently-completable unit of work — small enough that a single AI agent call can implement it with its defined tests, but complete enough to be meaningful. If a bead requires touching too many files or concepts, split it further.',
    `Draft Bead Structure: Each bead in this draft phase must include only the following subset of fields (the remaining fields will be added in a later expansion step):
  - id — a concise, descriptive kebab-case identifier unique across all beads (e.g., "setup-db-schema", "user-auth-middleware"). These draft IDs will be replaced with hierarchical IDs in the expansion step.
  - title — short task name.
  - prdRefs — list of PRD epic and user-story IDs this bead maps to (e.g., EPIC-1, US-1-1). If there are multiple beads in a user story, each bead references the same story.
  - description — detailed technical implementation steps for this specific bead only.
  - contextGuidance — an object with two keys: \`patterns\` (specific patterns to follow copied from the PRD/Architecture, e.g., "Use the AppError class for exceptions", "Follow the Container/Presenter pattern defined in src/components") and \`anti_patterns\` (approaches to avoid for this task, e.g., "Do not use alert() for error display").
  - acceptanceCriteria — human-readable definitions of done for this bead.
  - tests — bead-scoped tests (targeted unit/integration tests for this bead only, not the full suite).
  - testCommands — exact commands to run appropriate bead-scoped checks; may be empty.
  - testCommandReason — required only when testCommands is empty; explains why no appropriate automated command exists.`,
    'Context Guidance Contract: Write `contextGuidance` as an object with an explicit `patterns` list and an explicit `anti_patterns` list. Each must contain at least one entry. If the structure risks becoming too long, shorten the prose in those lists instead of dropping later beads.',
    'Dependency Ordering: List beads in dependency order — if bead B depends on bead A, A must appear before B. Do not create circular dependencies or self-references.',
    'PRD Coverage: Every in-scope PRD requirement must map to at least one bead. Each bead\'s `prdRefs` must reference valid PRD epic or user-story IDs (e.g., EPIC-1, US-1-1).',
    'Test Specificity: Each bead\'s `tests` must verify that bead alone — not the entire feature. Tests may describe multiple scenarios without requiring one command per scenario.',
    BEAD_VERIFICATION_RESTRAINT_RULE,
    CONDITIONAL_REPOSITORY_INSPECTION,
    'Test Command Grounding: When `relevant_files` and the approved PRD do not establish an exact `testCommands` entry, inspect the repository before emitting that command, while allowing checks for files or behavior the bead will create.',
    'Project-Agnostic Test Commands: Use focused repository inspection when the supplied context does not establish an exact test command. Choose the smallest practical verification for the bead, including standard platform utilities or checks for files and behavior the bead will create. Never assume a language, package manager, framework, or test runner merely because it is familiar.',
    'Single Response Completeness: Return one complete final `beads` list in a single response. Do not stop mid-list or emit partial subsets.',
    'Length Safety: If total output risks being cut off, shorten description text instead of omitting later beads. Every planned bead must appear in the output.',
    'Strict Output: Do not add wrappers, markdown fences, prose, or trailing commentary. Begin at `beads:` and end after the final bead item.',
    'Boundary Rule: Begin output at the `beads:` key. End after the last bead item. No prose, markdown fences, or commentary before or after the YAML.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: BEAD_SUBSET_OUTPUT_FORMAT,
  contextInputs: ['relevant_files', 'ticket_details', 'prd'],
  toolPolicy: 'read_only',
}

export const PROM21: PromptTemplate = {
  id: 'PROM21',
  description: 'Beads Council Voting Prompt',
  systemRole: 'You are an impartial judge on an AI Council. Your role is to evaluate multiple Beads breakdown (architecture/task) drafts objectively.',
  task: 'Read all provided Beads drafts, compare each draft against the final PRD, and evaluate them against each other. Rate each draft from 0 to 100.',
  instructions: [
    'Impartiality: Rate impartially as if all drafts are anonymous. Do not favor any draft based on its origin or style.',
    'Anti-anchoring: Drafts are presented in randomized order per evaluator. Do not assume the first draft is the baseline or best.',
    'Decomposition Interpretation: Different architectural approaches to the same PRD may legitimately vary in granularity, dependency handling, and sequencing. Score the decomposition quality, coverage, and test isolation as presented, not the identity of the architect.',
    'Scoring Rubric (minimum 0, maximum 20 points per category, total maximum 100): 1) Coverage of PRD requirements. 2) Correctness / feasibility of technical approach. 3) Quality and isolation of bead-scoped tests. 4) Minimal complexity / good dependency management. 5) Risks / edge cases addressed.',
    'Command Feasibility: Treat test commands that are unrelated to the bead or assume an unobserved project ecosystem as correctness defects. Reward practical, bead-scoped verification that fits the repository or the behavior the bead will create.',
    buildStrictVoteOutputInstruction(VOTING_RUBRIC_BEADS.map(item => item.category)),
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: STRICT_VOTE_OUTPUT_FORMAT,
  contextInputs: ['relevant_files', 'ticket_details', 'prd', 'drafts'],
  toolPolicy: 'disabled',
}

export const PROM22: PromptTemplate = {
  id: 'PROM22',
  description: 'Beads Winner Refinement Prompt',
  systemRole: "You are the Lead Architect and the winner of the AI Council's Beads drafting phase.",
  task: 'Create the final, definitive version of your Beads breakdown by reviewing the alternative (losing) drafts.',
  instructions: [
    'Anchor on the winning draft. It won because its decomposition, dependency graph, and test coverage are the best starting point. Preserve its strengths, but do not treat its exact wording or every individual bead as untouchable.',
    'Gap Scan: Read through the alternative drafts and note anything they cover that your draft does not: work units you missed, edge cases or error paths you omitted, test scenarios that are more precise than yours, or dependency edges you overlooked. These are candidates — not automatic additions.',
    'Selective Upgrade: For each candidate, decide: does it add genuine value, or is it a variation of something you already cover well? If it fills a real gap, add the bead. If an alternative has a strictly better definition of one of your existing beads — tighter scope, better tests, cleaner dependencies — replace yours with it. Otherwise, discard it.',
    'Measured Refinement: Do not rewrite from scratch or blend drafts together just for balance. But it is acceptable to improve multiple beads, adjust dependency edges, or rework test strategies across the draft if that produces a clearly stronger final result.',
    'Restraint: Avoid adding beads that merely restate work already covered by an existing bead. But if genuine gaps exist — missing work units, uncovered error paths, overlooked dependencies — add them; a complete graph matters more than a short one.',
    CONDITIONAL_REPOSITORY_INSPECTION,
    'Repository Detail Preservation: Before adopting or retaining repository-specific commands, paths, tooling, or framework details from an alternative draft, inspect the repository when the supplied context does not provide concrete evidence.',
    'Test Command Quality: Preserve practical bead-scoped test commands. Replace commands that assume an unobserved project ecosystem or do not verify the bead with a suitable project-agnostic or repository-native check, and account for that replacement in `changes`.',
    BEAD_VERIFICATION_RESTRAINT_RULE,
    'Single Artifact Contract: Return one YAML artifact that contains both the final refined Beads breakdown and a top-level `changes` list. Do not split the refined beads and change metadata across multiple outputs, wrappers, or separate artifacts.',
    'Changes Coverage: The top-level `changes` list must fully account for the differences between the winning bead subset and the final refined bead subset. Use `type` values `modified`, `added`, or `removed`. Include `item_type: bead` plus `before` and `after` bead item records (or `null` when appropriate).',
    'One-Entry-Per-Item Rule: Every changed bead must appear exactly once in `changes`. If an existing bead keeps the same ID but its content changes, emit exactly one `modified` entry for that bead. Do not split one changed bead across multiple change entries.',
    'Optional Inspiration Attribution: When a change was directly inspired by an alternative draft, include `inspiration` with `alternative_draft` and the inspiring `item`. Include `inspiration.item.detail` whenever the source item has useful supporting text (for example description, acceptance, tests, or dependency detail). If a change was not directly inspired by a losing draft, omit `inspiration` or set it to null.',
    'ID Stability: Preserve existing bead IDs from the winning draft unless you are adding a genuinely new bead. Do not renumber for neatness.',
    'Formatting: Output only this single refined Beads artifact with its top-level `changes` list.',
    'Schema Preservation: keep the same bead subset schema and output a single top-level `beads` list. Do not wrap it in prose or additional objects.',
    BEADS_ORDER_PRESERVATION_RULE,
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: `${BEAD_SUBSET_OUTPUT_FORMAT} Also include a top-level \`changes\` list. Each change item: {type, item_type, before, after, inspiration?}. \`type\` must be one of {modified, added, removed}. \`item_type\` must be \`bead\`. \`before\` and \`after\` use {id, label, detail?} or null when appropriate. Optional \`inspiration\` uses {alternative_draft, item}. Keep everything in one YAML artifact.`,
  contextInputs: ['relevant_files', 'ticket_details', 'prd', 'drafts', 'votes'],
  toolPolicy: 'read_only',
}

export const PROM23: PromptTemplate = {
  id: 'PROM23',
  description: 'Beads Coverage Verification Prompt',
  systemRole: 'You are a meticulous Quality Assurance Lead.',
  task: 'Re-read the final PRD as the source of truth and compare it against the current Beads blueprint to ensure complete coverage before execution planning is finalized.',
  instructions: [
    'Primary Truth: Treat the approved PRD as the sole source of truth for this audit. Every in-scope PRD requirement must be traceable to at least one bead.',
    'Coverage Check: Detect uncovered PRD requirements, oversized beads, vague work splits, missing necessary verification, empty or insufficient acceptance criteria, invalid empty-command explanations, and beads with no `prdRefs` mapping. Do not treat command absence or command-to-requirement parity as a gap by itself.',
    BEAD_VERIFICATION_RESTRAINT_RULE,
    CONDITIONAL_REPOSITORY_INSPECTION,
    'Repository-Specific Claims: Use focused repository inspection when the supplied context does not provide enough evidence to assess a path, build system, or tooling claim. The coverage decision itself remains about whether the blueprint covers the approved PRD.',
    'Source Artifact Contradictions: If the approved PRD is internally contradictory in a way the Beads blueprint cannot faithfully satisfy, report the contradiction as an unresolved coverage gap. Do not choose a side or invent implementation requirements to reconcile contradictory source artifacts.',
    'Identify Gaps: List any specific gaps or discrepancies found between the PRD and the Beads breakdown.',
    'Coverage Limits: Treat `coverage_run_number` and `max_coverage_passes` from the context as hard limits. Coverage can run once or at most `max_coverage_passes` times in total. If `is_final_coverage_run` is true, report unresolved gaps clearly without assuming another refinement pass exists.',
    'If no gaps exist, confirm that the Beads blueprint is complete and ready for the final expansion step.',
    'Audit-Only Contract: This prompt only audits the current Beads blueprint. Do not rewrite beads, propose changes, or include resolution notes in this response.',
    'Output Envelope: return only YAML with top-level `status`, `gaps`, and `follow_up_questions`.',
    'Beads Follow-Up Rule: `follow_up_questions` is always `[]` for beads coverage. Beads coverage has no user interaction; use `gaps` only.',
    'YAML Validity: Every item in `gaps` must be a double-quoted YAML string, even when the text contains code identifiers, paths, flags, backticks, or punctuation.',
    'Gap Triggering: Use `status: gaps` only when at least one real unresolved gap remains. Use concrete `gaps` entries to trigger another refinement pass. Do not flag stylistic preferences or minor wording differences as gaps.',
    'Do not output a rewritten Beads blueprint, beads patch, or any extra keys.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: `${COVERAGE_OUTPUT_FORMAT} For beads coverage, \`follow_up_questions\` must always be \`[]\`.`,
  contextInputs: ['prd', 'beads'],
  toolPolicy: 'read_only',
}

export const PROM24: PromptTemplate = {
  id: 'PROM24',
  description: 'Beads Coverage Resolution Prompt',
  systemRole: 'You are a meticulous Technical Lead resolving concrete implementation-plan coverage gaps.',
  task: 'Revise the current Beads blueprint to address the provided coverage gaps while preserving the current blueprint as the baseline. Return one updated semantic Beads artifact plus machine-readable change and gap-resolution metadata.',
  instructions: [
    'Primary Truth: Treat the approved PRD as the source of truth.',
    'Baseline Rule: Treat the provided current implementation plan as the baseline. Do not rewrite from scratch.',
    'Gap Resolution Rule: Address only the concrete coverage gaps provided in the context. Do not make unrelated improvements.',
    'Source Artifact Contradictions: If a provided gap describes internally contradictory source artifacts, do not choose a side, invent implementation requirements, or revise beads to pretend the contradiction is resolved. Record that gap with `action: left_unresolved` and `affected_items: []`.',
    'Preservation Rule: Keep the existing bead order, IDs, and unaffected fields unless a provided gap requires a concrete change. If you add a new bead, insert it at the minimal valid position that preserves dependency order.',
    'Bead Completeness: Every bead in the revised blueprint must include non-empty `acceptanceCriteria` and `tests`. `testCommands` may be empty only when accompanied by a non-empty `testCommandReason`.',
    BEAD_VERIFICATION_RESTRAINT_RULE,
    CONDITIONAL_REPOSITORY_INSPECTION,
    'Repository-Specific Revisions: When changing a repository-specific detail, use focused repository inspection if the supplied context does not establish the replacement. A verification command may also target files or behavior that the revised bead will create.',
    'Semantic Blueprint Rule: Return semantic Part 1 bead records only. Each bead must include the Beads blueprint fields: `id`, `title`, `prdRefs`, `description`, `contextGuidance`, `acceptanceCriteria`, `tests`, and `testCommands`, plus `testCommandReason` only for an empty command list.',
    'Change Accounting: Include a top-level `changes` list that fully and exactly accounts for the diff between the current Beads candidate and the revised Beads candidate. Each entry must include `type` (added|removed|modified), `id`, `title`, and `summary`.',
    'Gap Resolution Accounting: Include a top-level `gap_resolutions` list with exactly one entry per provided gap.',
    'Gap Resolution Actions: Each `gap_resolutions` entry must include `gap`, `action`, `rationale`, and `affected_items`. `action` must be one of `updated_beads`, `already_covered`, or `left_unresolved`.',
    'Affected Items: `affected_items` must be a YAML list of `{ item_type, id, label }` entries referencing bead items. Use an empty list when no bead mapping applies.',
    'Non-Bead Gaps: If a gap does not map cleanly to one or more specific beads, keep `affected_items: []`. Never emit PRD refs, section names, or non-bead item types in `affected_items`.',
    'Output Discipline: Return only one YAML artifact with a top-level `beads` list plus top-level `changes` and `gap_resolutions`. Do not add wrappers or prose.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: `${BEAD_SUBSET_OUTPUT_FORMAT} Also include a top-level \`changes\` list and a top-level \`gap_resolutions\` list. Each \`changes\` item: {type, id, title, summary}. \`type\` must be one of {added, removed, modified}. Each \`gap_resolutions\` item: {gap, action, rationale, affected_items}. \`action\` must be one of {updated_beads, already_covered, left_unresolved}. Each \`affected_items\` entry: {item_type, id, label}, where \`item_type\` must be \`bead\`.`,
  contextInputs: ['prd', 'beads', 'coverage_gaps'],
  toolPolicy: 'read_only',
}

export const PROM25: PromptTemplate = {
  id: 'PROM25',
  description: 'Beads Semantic Expansion Prompt',
  systemRole: "You are the Lead Architect and the winner of the AI Council's Beads phase.",
  task: 'Take the latest validated Beads blueprint and expand each bead into the final execution-ready Beads list by adding only the AI-owned fields.',
  instructions: [
    'Fresh Context Contract: This prompt includes only the approved final PRD, the latest validated blueprint, ticket details, and `relevant_files`. Use this refreshed context as your full working set; do not assume any prior conversation state.',
    'Expansion Only: Preserve these Part 1 fields exactly for every bead: `title`, `prdRefs`, `description`, `contextGuidance`, `acceptanceCriteria`, `tests`, `testCommands`, and conditional `testCommandReason`.',
    'Test Command Preservation: Preserve `testCommands` and any `testCommandReason` byte-for-byte during expansion; this phase adds execution metadata and must not redesign the semantic blueprint.',
    'Order Is Mandatory: Preserve bead list order exactly. The app executes beads sequentially in this order and derives `priority` from this order. Do not reorder, merge, split, add, or remove beads.',
    'AI-Owned Fields Only: Add only these fields per bead: `id`, `issueType`, `labels`, `dependencies.blocked_by`, and `targetFiles`.',
    'Mechanical Copy Rule: For each bead, start from the matching bead in `### beads_draft`, mechanically copy every preserved Part 1 field byte-for-byte, then replace only `id`, `issueType`, `labels`, `dependencies.blocked_by`, and `targetFiles`.',
    'LoopTroop-Owned Fields: Do not generate or rely on `priority`, `status`, `externalRef`, `dependencies.blocks`, `notes`, `iteration`, `createdAt`, `updatedAt`, `completedAt`, `startedAt`, or `beadStartCommit`. LoopTroop will create those.',
    'ID Contract: Generate a unique, stable, readable bead `id` for each bead. Hierarchical IDs are allowed when useful, but keep them concise and execution-friendly.',
    'Dependency Contract: `dependencies.blocked_by` may reference only earlier beads in the existing list order. No self-dependencies. No forward references. Keep the graph acyclic.',
    'Labels: Provide concise, useful labels grounded in the PRD and the refined blueprint. Include epic/story/ticket/domain labels when they are well supported by the provided context.',
    'Target Files: Use `relevant_files` first as hints for likely `targetFiles`. Prefer those hints when they are already sufficient. Use repository-inspection tools only when the hints are insufficient or need confirmation. Return only minimal project-relative file paths that the bead is most likely to touch.',
    CONDITIONAL_REPOSITORY_INSPECTION,
    'Tool Policy: Repository-inspection tools are read-only. You may read files and inspect the tree. Do not edit files, run commands, or change the repository.',
    'Output Discipline: output JSONL only. No surrounding array. No markdown fences. No prose before or after the JSONL.',
    'Expansion Self-Check: Before responding, verify that every preserved Part 1 field is byte-for-byte identical to the matching bead in `### beads_draft`; only the five AI-owned fields may differ.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: BEADS_JSONL_OUTPUT_FORMAT,
  contextInputs: ['relevant_files', 'ticket_details', 'prd', 'beads_draft'],
  toolPolicy: 'read_only',
}

export const PROM_MANUAL_QA_FIX_BEADS: PromptTemplate = {
  id: 'PROM_MANUAL_QA_FIX_BEADS',
  description: 'Manual QA Fix Beads Prompt',
  systemRole: 'You are the locked main implementer preparing execution-ready repair beads from failed human QA checks.',
  task: 'Inspect the repository with read-only tools and produce one complete fix-bead candidate for every supplied Manual QA merge group.',
  instructions: [
    'Repository Inspection Is Mandatory: perform at least one successful focused read-only repository tool call before answering. Inspect the files that are most likely to explain each failure, including files outside earlier bead targets when the evidence points there.',
    'No Mutation: do not edit files, run mutating commands, install dependencies, or change repository state.',
    'Exact Group Coverage: return exactly one candidate for every supplied merge-group ID, in the supplied order. Do not add, omit, merge, split, or rename groups.',
    'Implementation Quality: each candidate must contain a precise title and description, concrete implementation guidance, acceptance criteria, automated test scenarios, appropriate verification command guidance, useful labels, dependencies, and minimal project-relative target files.',
    BEAD_VERIFICATION_RESTRAINT_RULE,
    'PRD References: use only PRD references supplied for that merge group. Never invent a PRD reference.',
    'Dependencies: `blockedByGroupIds` may reference only earlier supplied merge-group IDs. Keep the graph acyclic.',
    'Application-Owned Fields: do not generate bead IDs, priority, status, issue type, external reference, reverse `blocks`, lifecycle timestamps, notes, iteration, or QA provenance. LoopTroop adds those fields after validation.',
    'Output Discipline: end with exactly one `<MANUAL_QA_FIX_BEADS>...</MANUAL_QA_FIX_BEADS>` YAML block and no prose outside it.',
    'YAML Safety: quote punctuation-heavy strings and strings containing `#`, `: `, URLs, shell syntax, brackets, braces, or backslashes. Prefer block scalars for complex descriptions and commands.',
  ],
  outputFormat: [
    '<MANUAL_QA_FIX_BEADS>',
    'beads:',
    '  - groupId: "exact-app-provided-group-id"',
    '    title: "Concise repair title"',
    '    description: "Detailed implementation work"',
    '    prdRefs: ["exact supplied criterion ref"]',
    '    contextGuidance:',
    '      patterns: ["Specific pattern to follow"]',
    '      anti_patterns: ["Specific approach to avoid"]',
    '    acceptanceCriteria: ["Observable completion criterion"]',
    '    tests: ["Concrete automated regression test"]',
    '    testCommands: [{mode: "process", program: "tool", args: ["test"], cwd: ".", env: {}}]',
    '    # When testCommands is [], add: testCommandReason: "Why no appropriate automated command exists"',
    '    labels: ["manual-qa", "domain-label"]',
    '    blockedByGroupIds: []',
    '    targetFiles: ["project/relative/path.ext"]',
    '</MANUAL_QA_FIX_BEADS>',
  ].join('\n'),
  contextInputs: ['ticket_details', 'prd', 'beads', 'final_test_report', 'manual_qa_results', 'focused_diff'],
  toolPolicy: 'read_only',
}

// Execution Prompts
const EXECUTION_SETUP_PROJECT_AGNOSTIC_RULE =
  'Project Agnosticism: Infer required tooling and preparation from repository evidence. Do not assume a programming language, build system, package manager, shell, operating system, or setup command, and do not invent commands for tooling you did not observe.'

const EXECUTION_SETUP_COMPLETION_RULE =
  'Completion: Continue using the available tools until setup work finishes and you can return exactly one structured result. A progress update such as "provisioning the toolchain" is never a final answer. Return `ready` when preparation succeeds or `blocked` with evidence when it cannot succeed safely; do not stop at a statement of intent.'

const EXECUTION_SETUP_HONEST_OUTCOME_RULE =
  'Honest Outcome: Return `ready` only when every setup check passes. If any check fails or a required tool is `failed` or `not_provisionable`, return `blocked`, identify the cause and attempted approaches, and preserve the evidence needed for recovery.'

export const PROM_EXECUTION_CAPABILITY_PROBE: PromptTemplate = {
  id: 'PROM_EXECUTION_CAPABILITY_PROBE',
  description: 'Execution Capability Probe Prompt',
  systemRole: 'You are a read-only execution capability probe.',
  task: 'Verify that the workspace is accessible with read-only tooling and respond with a strict success token.',
  instructions: [
    'Use only read-only repository inspection tools.',
    'Perform exactly one harmless read-only workspace check, such as listing the current directory or reading a manifest file.',
    'Do not edit files, run mutating commands, request permissions, or create artifacts.',
    'After the read-only check succeeds, reply with exactly OK and nothing else.',
  ],
  outputFormat: 'Exactly `OK` after one successful read-only workspace check.',
  contextInputs: [],
  toolPolicy: 'read_only',
}

export const PROM_EXECUTION_SETUP_PLAN: PromptTemplate = {
  id: 'PROM_EXECUTION_SETUP_PLAN',
  description: 'Execution Setup Plan Prompt',
  systemRole: 'You are an expert execution-planning analyst drafting a workspace setup plan for later coding.',
  task: 'Inspect the approved planning context and the current workspace state, decide whether setup is actually needed, and return a reviewable execution setup plan without modifying the repository.',
  instructions: [
    'Scope: Your job is to audit current readiness first, then plan only the missing workspace preparation. Do not assume setup is needed just because this phase exists.',
    'Read-Only Discovery: Inspect the ticket details, relevant files, PRD, beads plan, any prior setup-plan notes, and any existing execution_setup_profile context. You may inspect repository files, manifests, lockfiles, runtime directories, and generated temp artifacts, but do not edit files, install dependencies, or run mutating commands.',
    'Existing Readiness First: Determine whether the current worktree already has what later coding beads need. Manifests, lockfiles, or scripts prove the project type, but they do not prove readiness unless the command launchers needed by required prepare/test/lint/typecheck commands are available or already prepared. If the environment is already ready, record concrete evidence, leave `readiness.gaps` and `steps` empty.',
    'Missing Work Only: If the environment is not fully ready, record concrete gaps and include only the smallest credible set of setup steps needed to close those gaps. Missing command launchers or toolchains for discovered command families are setup gaps, not cautions on a ready plan.',
    'Runtime Command Readiness: Inspect the launchers required by the approved beads and project commands so the setup plan can provision missing runtime tooling without redesigning the approved work.',
    'Backend-Owned Fields: Return only your proposal. LoopTroop supplies schema and ticket identity, artifact/status, current-host facts, temp roots, Git policy and detected-hook evidence, quality policy, and derives readiness status/actions from the proposed work. Do not echo or guess those fields.',
    EXECUTION_SETUP_PROJECT_AGNOSTIC_RULE,
    'Workspace Setup Policy: The setup plan may propose repository-native bootstrap commands. Prefer LoopTroop-owned temporary roots under `.ticket/runtime/execution-setup/**`, especially `.ticket/runtime/execution-setup/tool-cache/**`, for execution-only toolchains, dependency caches, build caches, generated outputs, or tool caches. Do not propose ticket feature implementation as part of setup.',
    'Tracked Change Boundary: If a setup command is likely to modify tracked manifests, lockfiles, generated assets, or configuration, prefer a non-mutating or temp-root alternative. If readiness truly requires a permanent repository change, record the exact need in `cautions` instead of trying to make that change during setup.',
    'Plan Structure: Return ordered setup steps when commands are required. Each step must include `id`, `title`, `purpose`, `commands`, `required`, `rationale`, and `cautions`; use `cautions: []` when no step-specific cautions apply. A plan whose only required action is materializing approved workspace inputs may use a non-empty `workspace_inputs` list with an empty `steps` list.',
    `Structured Commands: Every machine command is an object matching the shared command schema. Prefer a direct process such as \`${COMMAND_SPEC_PROMPT_EXAMPLE}\`. Use \`{"mode":"shell","shell":"posix|cmd|powershell","script":"unchanged script","cwd":".","env":{}}\` only when repository evidence requires shell syntax. Never assume a shell from the programming language.`,
    'Command Families: Discover project-level command families for prepare/bootstrap, full test, full lint, and full typecheck when possible. If a family is unavailable, return an empty list rather than inventing commands.',
    'Quality Gate Policy: Default to bead test commands first, then impacted-or-package scoped lint/typecheck, and never block later phases on unrelated baseline debt.',
    'Functional Workspace Probes: Propose at least one safe repository-level command that loads or discovers the actual project whenever project command families or bead test commands exist. Tool/runtime version checks alone are not workspace probes.',
    'Git Hook Validation: Inspect repository hook configuration and propose explicit, safe validation commands for hooks you can identify. Do not invent commands for unknown hooks. The backend supplies read-only detected-hook evidence and the configured policy.',
    'Original Checkout Audit: Compare the current ticket worktree with the original checkout provided in `workspace_locations`. Check whether the original checkout contains an ignored or untracked file or directory that explains a setup failure or readiness gap. Confirm that it is absent from the ticket worktree and needed to prepare, load, build, test, lint, or otherwise operate the project.',
    'Workspace Input Evidence: Add an item only when concrete repository evidence or a prior workspace-setup failure connects it to a readiness problem. Do not list unrelated ignored files, caches, dependencies, temporary output, or the complete ignored-file inventory.',
    'Workspace Inputs: Record every necessary ignored or untracked file or directory in `workspace_inputs`. Use repository-relative paths. For each item, record whether it is a file or directory, whether it is ignored or untracked, its category (`local_config`, `secret`, `fixture`, `dataset`, or `other_non_reproducible`), and a concise reason it is needed. Do not include file contents and do not add shell copy commands to `steps`.',
    'Reproducible Inputs: Never propose generated dependencies, dependency directories, caches, or build output as workspace inputs. Setup commands must recreate reproducible state.',
    'Approved Materialization: The user reviews and may edit `workspace_inputs` as part of the normal execution setup plan. Approval authorizes LoopTroop to copy only those listed inputs from the original checkout into the same relative paths in the ticket worktree before setup commands run.',
    'Workspace Input Boundaries: Never propose `.git`, `.ticket`, `.looptroop`, or paths outside the original checkout as workspace inputs.',
    'Workspace Input Readiness: A non-empty `workspace_inputs` list counts as required setup work. Set `readiness.actions_required` to true when those inputs are needed, even when no additional setup command is required.',
    'No Execution: Do not initialize the environment yet. This phase stops at the plan artifact so the user can review and edit it.',
    'Output Discipline: End with exactly one `<EXECUTION_SETUP_PLAN>...</EXECUTION_SETUP_PLAN>` block and nothing else.',
  ],
  outputFormat: `JSON or YAML inside \`<EXECUTION_SETUP_PLAN>...</EXECUTION_SETUP_PLAN>\` with this exact shape:
{
  "summary": "short human-readable summary",
  "readiness": {
    "evidence": ["observed fact proving readiness"],
    "gaps": []
  },
  "workspace_inputs": [{"path":"relative/path","kind":"file|directory","source_status":"ignored|untracked","category":"local_config|secret|fixture|dataset|other_non_reproducible","reason":"why setup needs it"}],
  "workspace_probes": [{"id": "workspace-1", "command": {"mode":"process","program":"tool","args":["test"],"cwd":".","env":{},"timeoutMs":120000}, "purpose": "prove the project can be loaded"}],
  "git_hooks": {
    "validation_commands": [{"id": "hook-1", "hook": "pre-commit", "command": {"mode":"process","program":"tool","args":["check"],"cwd":".","env":{}}, "purpose": "run the hook check explicitly"}]
  },
  "steps": [],
  "project_commands": {
    "prepare": [{"mode":"process","program":"tool","args":["prepare"],"cwd":".","env":{}}],
    "test_full": [{"mode":"process","program":"tool","args":["test"],"cwd":".","env":{}}],
    "lint_full": [],
    "typecheck_full": []
  },
  "cautions": ["..."]
}
Each setup step must have this exact shape:
{
  "id": "setup-step-1",
  "title": "short step title",
  "purpose": "why this workspace setup step is needed",
  "commands": [{"mode":"process","program":"tool","args":["prepare"],"cwd":".","env":{},"timeoutMs":120000}],
  "required": true,
  "rationale": "evidence or reasoning for this step",
  "cautions": []
}`,
  contextInputs: ['ticket_details', 'relevant_files', 'prd', 'beads', 'execution_setup_profile', 'execution_setup_plan_notes'],
  toolPolicy: 'read_only',
}

export const PROM_EXECUTION_SETUP_PLAN_REGENERATE: PromptTemplate = {
  id: 'PROM_EXECUTION_SETUP_PLAN_REGENERATE',
  description: 'Execution Setup Plan Regenerate Prompt',
  systemRole: 'You are revising an existing execution setup plan for a workspace initialization phase.',
  task: 'Revise the current execution setup plan using the provided user commentary while keeping the plan scoped to workspace preparation and reviewable.',
  instructions: [
    'Treat the provided `execution_setup_plan` as the current draft baseline.',
    'Apply the user commentary from `execution_setup_plan_note` entries directly to the plan when it is compatible with the repository and workspace setup policy.',
    'Re-audit current readiness while revising. Preserve or strengthen a no-op plan when the environment is already ready; only add steps if the commentary or repository evidence shows missing work.',
    'When prior workspace-runtime failure context is present, use its cleaned command and error output while checking the original checkout for ignored or untracked inputs that concretely explain the failure.',
    'Preserve good existing steps when the commentary does not require changing them.',
    EXECUTION_SETUP_PROJECT_AGNOSTIC_RULE,
    'Recheck launcher readiness while revising. Do not report the environment as ready when a command required by the approved work still needs provisioning.',
    'Do not execute commands or mutate the repository while revising the plan.',
    'Return a full replacement setup plan artifact, not a diff or patch note.',
    'Output Discipline: End with exactly one `<EXECUTION_SETUP_PLAN>...</EXECUTION_SETUP_PLAN>` block and nothing else.',
  ],
  outputFormat: PROM_EXECUTION_SETUP_PLAN.outputFormat,
  contextInputs: ['ticket_details', 'relevant_files', 'prd', 'beads', 'execution_setup_profile', 'execution_setup_plan', 'execution_setup_plan_notes'],
  toolPolicy: 'read_only',
}

export const PROM_EXECUTION_SETUP: PromptTemplate = {
  id: 'PROM_EXECUTION_SETUP',
  description: 'Execution Setup Prompt',
  systemRole: 'You are an expert execution-environment initializer preparing a temporary reusable workspace for future coding beads.',
  task: 'Execute the approved setup plan, initialize reusable execution state, discover any missing project command details, and return a structured execution setup result.',
  instructions: [
    'Scope: Prepare only the reusable temporary execution environment needed by later coding beads. Do not implement ticket features, make broad source edits, or perform unrelated refactors.',
    'Approved Plan First: Read the approved `execution_setup_plan` context before taking action. Treat user-edited plan steps and commands as the primary setup contract.',
    'Readiness Respect: If the approved setup plan says `readiness.status` is `ready` and `readiness.actions_required` is `false`, verify that assessment and avoid bootstrap work unless a concrete missing prerequisite blocks later coding.',
    'Context Review: Read the ticket details, approved setup plan, beads plan, and any prior `execution_setup_note` context before taking action. Use repository tools for any concrete file, manifest, or script details you need. Avoid repeating failed setup approaches.',
    EXECUTION_SETUP_PROJECT_AGNOSTIC_RULE,
    'Repository-Native Setup: Prefer repository-provided wrappers, manifests, lockfiles, scripts, and bootstrap commands. Start with approved plan commands, and add only the smallest repository-evidenced preparation needed when the plan is incomplete.',
    'Temporary Scope and Safety: Put execution-only toolchains, dependency/build caches, generated outputs, logs, and reusable setup artifacts under approved temp roots, preferably `.ticket/runtime/execution-setup/**` and `.ticket/runtime/execution-setup/tool-cache/**`. Do not use privileged or global installation, arbitrary source-tree install paths, or permanent repository changes.',
    'Gitignore Suggestions: If setup commands create untracked generated or local outputs outside approved temp roots because repository ignore coverage is missing, do not edit `.gitignore` during setup. Record the exact paths and recommended `.gitignore` entries in `cautions`, and prefer moving reusable setup outputs under approved temp roots when possible.',
    'Missing Tool Recovery: A failed version or information probe only discovers a missing tool. Before reporting it as failed, try at least two distinct safe user-space strategies that actually obtain, install, or activate a compatible launcher under the approved temp roots, unless repository evidence proves no safe strategy exists. Wrapper creation, cache inspection, PATH edits, and probes are not provisioning attempts. Resolve declared version constraints from repository metadata, consult official release metadata when needed, record the evidence and commands used, and never repeat an unchanged failed approach.',
    'Runtime Environment: Report the PATH additions and environment variables needed by prepared tools as reusable runtime information. LoopTroop applies that environment to subprocesses and creates any host-appropriate coding-agent launcher; do not require or assume POSIX env.sh/run wrappers.',
    'Structured Commands: Return every machine command as a direct process object or an explicit POSIX, cmd, or PowerShell shell object, using the same command schema shown in the approved plan. Prefer direct processes.',
    'Tracked Change Boundary: If a repository-native setup command changes tracked manifests, lockfiles, generated assets, or configuration, do not leave those changes behind. Record the exact need in `cautions` and return `blocked` if readiness depends on a permanent repository change.',
    'Minimum Necessary Work: If the environment is already ready or only partially missing one prerequisite, do only the missing temporary work. Do not rebuild or re-bootstrap the environment from scratch without evidence.',
    'Audited Augmentations: If the approved plan is insufficient and you must run additional setup commands, keep those additions minimal and make sure `bootstrap_commands` lists every command actually used, including additions beyond the approved plan.',
    'Reusable Outputs: Record any reusable dependency directory, build cache, generated temp artifact, tool cache, or setup note path in `temp_roots` or `reusable_artifacts`. Prefer runtime-owned paths under `.ticket/runtime/execution-setup/**`; use another setup-created location only when the repository itself requires it.',
    'Discovery Goal: Discover project-level command families for prepare/bootstrap, full test, full lint, and full typecheck when possible. If a command family is unavailable, return an empty list for that field instead of inventing a fake command.',
    'Tooling Probes: Record non-mutating, rerunnable `tooling_probe_commands` that prove the prepared environment works. LoopTroop reruns these probes before coding.',
    'Backend-Owned Runtime Fields: Do not echo the approved workspace inputs/probes, Git hook policy/evidence/validations, ticket/schema identity, temp roots, or quality policy. LoopTroop copies those approved fields into the runtime profile after parsing your result.',
    'Approved Workspace Inputs: LoopTroop materializes the approved `workspace_inputs` before this setup session begins. Use those inputs as part of the prepared worktree. Do not copy additional ignored or untracked paths that are not present in the approved plan. If an approved input is unavailable or materialization failed, report the exact path as a workspace failure.',
    'Quality Gate Policy: Default to bead test commands first, then impacted-or-package scoped lint/typecheck, and never block later phases on unrelated baseline debt.',
    EXECUTION_SETUP_HONEST_OUTCOME_RULE,
    EXECUTION_SETUP_COMPLETION_RULE,
    'Output Discipline: End with exactly one `<EXECUTION_SETUP_RESULT>...</EXECUTION_SETUP_RESULT>` block and nothing else.',
  ],
  outputFormat: `JSON or YAML inside \`<EXECUTION_SETUP_RESULT>...</EXECUTION_SETUP_RESULT>\` with this exact shape:
{
  "status": "<ready|blocked>",
  "summary": "short human-readable summary",
  "profile": {
    "status": "<ready|blocked>",
    "summary": "environment initialized and reusable",
    "runtime_environment": {"pathPrepend":[".ticket/runtime/execution-setup/tool-cache/bin"],"variables":{}},
    "bootstrap_commands": [{"mode":"process","program":"tool","args":["prepare"],"cwd":".","env":{}}],
    "tooling_probe_commands": [{"mode":"process","program":"tool","args":["--version"],"cwd":".","env":{}}],
    "tool_requirements": [
      {
        "launcher": "<required command launcher>",
        "required_by": ["project_commands.prepare[0]"],
        "status": "available|provisioned|failed|not_provisionable",
        "missing_probe": "<probe that proved the launcher was missing, when applicable>",
        "provisioning_attempts": [
          {
            "strategy": "<distinct safe provisioning strategy name>",
            "commands": [{"mode":"shell","shell":"powershell","script":"<current-host provisioning script>","cwd":".","env":{}}],
            "result": "<available|provisioned|failed|not_run>",
            "reason": "<short outcome or failure reason>"
          }
        ],
        "final_probe": "<final verification probe, when applicable>",
        "failure_reason": "<why provisioning failed or no safe provisioning path exists, when applicable>"
      }
    ],
    "reusable_artifacts": [
      {
        "path": ".ticket/runtime/execution-setup/tool-cache",
        "kind": "cache",
        "purpose": "why this exists"
      }
    ],
    "project_commands": {
      "prepare": [{"mode":"process","program":"tool","args":["prepare"],"cwd":".","env":{}}],
      "test_full": [{"mode":"process","program":"tool","args":["test"],"cwd":".","env":{}}],
      "lint_full": [],
      "typecheck_full": []
    },
    "cautions": ["..."]
  },
  "checks": {
    "workspace": "<pass|fail>",
    "tooling": "<pass|fail>",
    "temp_scope": "<pass|fail>",
    "policy": "<pass|fail>"
  }
}`,
  contextInputs: ['ticket_details', 'beads', 'execution_setup_plan', 'execution_setup_notes'],
  toolPolicy: 'execution_setup_online',
}

export const PROM_EXECUTION_SETUP_NOTE: PromptTemplate = {
  id: 'PROM_EXECUTION_SETUP_NOTE',
  description: 'Execution Setup Retry Note Prompt',
  systemRole: 'You are a concise technical analyst summarizing a failed execution setup attempt for the next retry.',
  task: 'Write a short append-only retry note describing what initialization work was attempted, what blocked it, and what the next setup attempt should preserve or avoid.',
  instructions: [
    'Summarize the attempted environment initialization work and the most relevant commands or actions.',
    'Capture the specific blocker or policy violation that prevented setup from succeeding.',
    EXECUTION_SETUP_PROJECT_AGNOSTIC_RULE,
    'Guide the next retry toward the safest repository-evidenced approach without repeating full logs, and state whether another actionable approach remains or no safe preparation path exists.',
    'The next setup attempt must finish with an honest structured `ready` or `blocked` outcome; a progress-only response is unfinished work.',
    'Keep it concise and directly actionable.',
  ],
  outputFormat: 'Plain text - one concise append-only retry note',
  contextInputs: ['ticket_details', 'error_context'],
  toolPolicy: 'disabled',
}

export const PROM_CODING: PromptTemplate = {
  id: 'PROM_CODING',
  description: 'Bead Implementation Prompt — guides the AI implementer through executing a single bead',
  systemRole: 'You are an expert AI implementer executing a specific implementation task (bead) within a larger ticket. You have full tool access to read, write, and run commands in the worktree.',
  task: 'Implement the active bead requirements in the worktree, pass all quality gates (tests, lint, typecheck, qualitative review), and output a structured completion marker.',
  instructions: [
    'Read and Understand: Read the bead specification from the `bead_data` context — including bead id, description, acceptance criteria, target files, and test commands. `bead_data` identifies which bead you are implementing.',
    'Check Prior Notes: If bead notes exist from prior iteration failures, carefully read them and avoid repeating the same mistakes. These notes describe what went wrong previously and what to do differently.',
    'Execution Setup Reference: The full setup profile is available at `.ticket/runtime/execution-setup-profile.json`. Treat it as read-only runtime context; read it only when setup, tooling, prepared-artifact, or project-command details are needed, and prefer it over rediscovering those details from scratch.',
    'Prepared Runtime Launcher: When the setup profile records a `command-launcher` reusable artifact, invoke setup-dependent tools through that host-specific `.sh`, `.ps1`, or `.cmd` launcher. Do not assume POSIX syntax; use the launcher matching `host_context.preferredShell`. Machine commands in the profile are structured objects, so read their program/args or explicit shell/script fields rather than treating the JSON as command text.',
    'Implement Changes: Make the necessary code changes in the worktree to fulfill the bead requirements. Follow existing code patterns and conventions in the project.',
    'Environment Readiness: If the setup profile file is missing, unreadable, or invalid, do only the minimum safe discovery needed to proceed. Do not rediscover or rebuild the full environment unless the existing setup is missing or invalid. If a required command launcher or toolchain is missing and no approved temp root from the setup profile can hold execution-only tooling, report an environment failure instead of installing into arbitrary repository paths.',
    'Execution-Only Tooling: If you must prepare a missed execution-only toolchain or cache during coding, create it only under an existing approved temp root from `.ticket/runtime/execution-setup-profile.json`, preferably `.ticket/runtime/execution-setup/**`. Never download or install toolchains, SDKs, package managers, or large caches into arbitrary project paths.',
    'Repair Loop: After implementing the bead, treat its planned test commands as starting guidance. Run the applicable commands, and correct or replace a command when repository evidence shows that another project-native check is more appropriate. Then run impacted, package-scoped, or file-scoped lint and typecheck commands when the project supports them. If a scoped lint/typecheck command is unavailable, use the best safe project-native command family from the setup profile file when available without blocking on unrelated baseline debt.',
    'Run Tests: Use the smallest appropriate automated checks for the implementation and keep fixing relevant failures until they pass. When the bead has no test commands and gives a reason, do not invent an unsuitable command merely to create a gate.',
    'Agent-Owned Verification: LoopTroop validates the final completion marker but does not independently rerun a frozen copy of the bead test commands. Return `done` only after you have run the applicable checks and verified the implementation against the acceptance criteria.',
    'Run Lint & Typecheck: Prefer scoped lint and typecheck for the code you touched. Do not fail the bead because of unrelated pre-existing project-wide lint/typecheck debt.',
    'Self-Verify Quality: Review each acceptance criterion and confirm the implementation satisfies it qualitatively. Check edge cases and error handling.',
    'Do Not Self-Terminate Early: Do not stop just because lint, tests, or typecheck fail. Continue working in the same session while time remains. The app will decide when to stop the iteration.',
    'No Progress Prose: While the bead is still in progress, do not reply with plain-language status updates such as "I\'m installing dependencies" or "I\'ll rerun tests next". Keep using tools and continue working until you can return the required completion marker or the app interrupts you.',
    `Completion Marker:\n${buildCompletionInstructions()}`,
    'Output Discipline: Return exactly one <BEAD_STATUS>...</BEAD_STATUS> block as the final output marker. Inside the marker, return only the machine-readable JSON object. No markdown fences, commentary, or wrapper keys.',
    'Terminal Condition: The normal terminal response for an active iteration is the final marker with status `done` after all required gates pass. Do not emit status `error` for lint/test/typecheck failures while the app has not stopped the iteration.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: 'JSON inside <BEAD_STATUS>...</BEAD_STATUS> tags with bead_id, status, checks (tests, lint, typecheck, qualitative), and optional reason',
  contextInputs: ['bead_data', 'bead_notes'],
  toolPolicy: 'default',
}

export const PROM51: PromptTemplate = {
  id: 'PROM51',
  description: 'Context Wipe Note Summary Prompt',
  systemRole: 'You are a concise technical analyst summarizing a failed implementation attempt.',
  task: "Generate a short, actionable summary of what was attempted and what errors were encountered during this bead iteration, to be appended as a new Failed Iteration Notes entry for the next attempt.",
  instructions: [
    'Summarize Attempt: Describe what implementation approach was taken and what code changes were made during this iteration.',
    'Document Errors: List the specific errors encountered during linting, testing, or execution.',
    'Explain Delay or Stall: If the attempt timed out or stalled, explain what was consuming time and why the bead did not complete.',
    'Extract Lessons: Identify what should be avoided or done differently in the next attempt.',
    'Keep it Concise: Only include information that will help the next iteration succeed.',
  ],
  outputFormat: 'Plain text — one append-only Failed Iteration Notes entry',
  contextInputs: ['bead_data', 'error_context'],
  toolPolicy: 'disabled',
}

export const PROM52: PromptTemplate = {
  id: 'PROM52',
  description: 'Final Test Generation Prompt',
  systemRole: 'You are an expert QA Engineer and the main implementer who has just finished implementing a ticket from end to end.',
  task: 'Design and implement a comprehensive final test (or test suite) that validates the entire ticket was implemented correctly. You MUST add or modify at least one test artifact that specifically validates the ticket\'s implementation — do not just re-run existing project tests without adding new coverage.',
  instructions: [
    'Review Scope: Re-read the ticket details, PRD, and Beads list to understand the full scope.',
    'Prior Notes: If prior `final_test_note` context is present, read it first and avoid repeating failed approaches unless you have a concrete reason.',
    'Test Design: Design the minimal but sufficient set of tests that collectively prove the ticket requirements are met.',
    'Coverage Priorities: Focus on: (1) all acceptance criteria from PRD user stories; (2) critical user flows described by the PRD; (3) key edge cases and error states.',
    "Test Type: Prefer integration or end-to-end tests that exercise real code paths. Use the project's existing testing framework.",
    'Determinism: Tests must be deterministic and repeatable. Avoid any external dependencies, network calls, or non-deterministic timing.',
    'Test Artifacts: You MUST create or modify at least one test file. These test files become permanent regression tests for the project. Record the paths of all test files you created or modified in the `test_files` field of the output marker.',
    'Modified Files Contract: Record in `modified_files` every permanent repository file that you created or modified during this final-test phase and that should remain in the final candidate. Include all paths from `test_files`, plus any production files you intentionally changed. Exclude ephemeral runtime data, logs, caches, databases, build output, temp files, or other scratch artifacts.',
    'File Effects Contract: Also record `file_effects` for every repository file you expect final testing to create or leave dirty. Use `{"path":"relative/path","intent":"candidate"}` for files that should be included in the PR, `{"path":"relative/path","intent":"temporary"}` for files that are expected test byproducts and must stay out of the PR, and `{"path":"relative/path","intent":"unexpected","reason":"..."}` for dirty files you did not intend as permanent. Paths must be repository-relative and language/framework agnostic.',
    'Ephemeral Runtime Exclusion: LoopTroop-owned internals such as `.ticket/**`, `.ticket/runtime/execution-setup/**`, `.ticket/runtime/execution-setup-profile.json`, and `.looptroop/**` are temporary runtime state and must never appear in `modified_files` or `file_effects`.',
    'Mandatory Self-Execution: Before returning `<FINAL_TEST_COMMANDS>`, you MUST run the exact command(s) you plan to return in this same worktree.',
    'Execution Setup Reference: Read `.ticket/runtime/execution-setup-profile.json` for the approved runtime environment and project commands. LoopTroop applies its structured PATH additions and variables directly when it executes returned commands.',
    'Repair Loop: If any planned command fails, inspect the real failure output, fix the underlying implementation and/or the final test files, and rerun the same command(s). Repeat until the exact planned command(s) pass or you run out of time.',
    'Scope Discipline: You may modify production code and test files during this phase, but keep changes minimal and strictly within the approved ticket, PRD, and Beads scope.',
    'Do Not Game The Tests: Do not weaken assertions, delete coverage, lower thresholds, or narrow test scope just to get a pass. Only change a failing test if it is demonstrably broader than the approved requirements.',
    'Test Commands: Provide exact structured commands targeting only your test files. Prefer `{"mode":"process","program":"tool","args":["test"],"cwd":".","env":{}}`; use `{"mode":"shell","shell":"posix|cmd|powershell","script":"...","cwd":".","env":{}}` only when repository evidence requires shell syntax. Use the current host context supplied below; plans are for this host.',
    'Command Marker: End your response with `<FINAL_TEST_COMMANDS>{"commands":[{"mode":"process","program":"tool","args":["test","path/to/test-file"],"cwd":".","env":{}}],"test_files":["path/to/test-file"],"modified_files":["path/to/test-file","src/feature-file"],"file_effects":[{"path":"path/to/test-file","intent":"candidate"},{"path":"tmp/test-output","intent":"temporary","reason":"created by the final-test command"}],"summary":"short explanation"}</FINAL_TEST_COMMANDS>`.',
    'Output Discipline: Return exactly one `<FINAL_TEST_COMMANDS>...</FINAL_TEST_COMMANDS>` block and nothing else outside it. Inside the marker, return only the machine-readable object with a non-empty `commands` field, a non-empty `test_files` field, a non-empty `modified_files` field, and `file_effects` entries for expected dirty files.',
    'Do not claim the tests passed yourself. LoopTroop will execute the commands and determine pass/fail from the real exit codes.',
    'Final Gate: Return `<FINAL_TEST_COMMANDS>` only after the exact listed command(s) have passed locally in your own session on the current branch state.',
    'Failure Handling: If you added or updated tests, include only the commands needed to verify the final implementation state.',
    STRUCTURED_SELF_CHECK,
  ],
  outputFormat: 'Test file(s) + execution commands',
  contextInputs: ['ticket_details', 'prd', 'beads', 'final_test_notes', 'host_context'],
  toolPolicy: 'default',
}

export const PROM53: PromptTemplate = {
  id: 'PROM53',
  description: 'Final Test Retry Note Prompt',
  systemRole: 'You are a concise technical analyst summarizing a failed final-test attempt for the next retry.',
  task: 'Generate a short, append-only retry note that captures what was attempted, what failed, and what the next final-test iteration should pay attention to.',
  instructions: [
    'Summarize The Attempt: Describe the intended final-test approach and the commands that were run.',
    'Capture The Failure: Include the most important command failure or validation problem without copying full logs.',
    'Guide The Next Retry: State the key lesson or adjustment for the next iteration.',
    'Keep It Concise: Write only the note text that should be appended to the retry history.',
  ],
  outputFormat: 'Plain text - one concise append-only retry note',
  contextInputs: ['ticket_details', 'error_context'],
  toolPolicy: 'disabled',
}

export const PROM54_CONTINUE_TEXT = 'continue please'

export const PROM54: PromptTemplate = {
  id: 'PROM54',
  description: 'Same-session OpenCode continuation prompt',
  systemRole: 'Existing OpenCode session continuation',
  task: PROM54_CONTINUE_TEXT,
  instructions: [],
  outputFormat: 'Bare continuation text only.',
  contextInputs: [],
  toolPolicy: 'default',
}

function buildPromptWithRules(
  rules: string,
  template: PromptTemplate,
  contextParts: PromptPart[],
): string {
  return [
    rules,
    '',
    `## System Role`,
    template.systemRole,
    '',
    `## Task`,
    template.task,
    '',
    `## Instructions`,
    ...template.instructions.map((step, i) => `${i + 1}. ${step}`),
    '',
    `## Expected Output Format`,
    template.outputFormat,
    '',
    `## Context`,
    ...contextParts.map((p) => `### ${p.source ?? p.type}\n${p.content}`),
  ].join('\n')
}

// Helper to build full prompt from template
export function buildPromptFromTemplate(
  template: PromptTemplate,
  contextParts: PromptPart[],
): string {
  return buildPromptWithRules(GLOBAL_RULES, template, contextParts)
}

export function buildSameSessionPromptFromTemplate(
  template: PromptTemplate,
  contextParts: PromptPart[],
): string {
  return buildPromptWithRules(SAME_SESSION_RULES, template, contextParts)
}

// Helper to build a conversational (multi-turn) prompt from template
export function buildConversationalPrompt(
  template: PromptTemplate,
  contextParts: PromptPart[],
): string {
  return buildPromptWithRules(CONVERSATIONAL_RULES, template, contextParts)
}

export const ALL_PROMPTS = {
  PROM0,
  PROM1,
  PROM2,
  PROM3,
  PROM4,
  PROM5,
  PROM10a,
  PROM10b,
  PROM11,
  PROM12,
  PROM13,
  PROM13b,
  PROM20,
  PROM21,
  PROM22,
  PROM23,
  PROM24,
  PROM25,
  PROM_MANUAL_QA_FIX_BEADS,
  PROM_EXECUTION_CAPABILITY_PROBE,
  PROM_EXECUTION_SETUP_PLAN,
  PROM_EXECUTION_SETUP_PLAN_REGENERATE,
  PROM_EXECUTION_SETUP,
  PROM_EXECUTION_SETUP_NOTE,
  PROM_CODING,
  PROM51,
  PROM52,
  PROM53,
  PROM54,
}
