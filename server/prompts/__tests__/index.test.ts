import { describe, expect, it } from 'vitest'
import {
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
  buildPromptFromTemplate,
  buildSameSessionPromptFromTemplate,
} from '../index'

describe.concurrent('structured prompt hardening', () => {
  it('keeps the interview refinement prompt explicit about phase order and self-checks', () => {
    const prompt = buildPromptFromTemplate(PROM3, [])
    expect(prompt).toContain('Phase Order Is Mandatory')
    expect(prompt).toContain('Final Self-Check')
    expect(prompt).toContain('Preserve the winning draft\'s existing `id`')
    expect(prompt).toContain('YAML with top-level `questions` list and top-level `changes` list')
    expect(prompt).toContain('Return one YAML artifact')
    expect(prompt).toContain('Do not split the refined questions and change metadata')
  })

  it('treats interview question limits as a ceiling rather than a target', () => {
    const draftPrompt = buildPromptFromTemplate(PROM1, [])
    const refinePrompt = buildPromptFromTemplate(PROM3, [])

    expect(draftPrompt).toContain('hard upper bound, never a target')
    expect(draftPrompt).toContain('Return one complete final `questions` list in this single response')
    expect(draftPrompt).toContain('do not emit a partial subset or phased draft')
    expect(refinePrompt).toContain('hard upper bound, never a target')
    expect(draftPrompt).not.toContain('endeavor to approach that limit')
  })

  it('uses the shared coverage envelope for interview, PRD, and beads coverage prompts', () => {
    for (const prompt of [PROM5, PROM13, PROM23]) {
      expect(prompt.outputFormat).toContain('status')
      expect(prompt.outputFormat).toContain('gaps')
      expect(prompt.outputFormat).toContain('follow_up_questions')
      expect(prompt.outputFormat).toContain('double-quoted strings')
    }
  })

  it('grants focused read-only tools to planning and interview prompts that need conditional repository inspection', () => {
    for (const prompt of [
      PROM2,
      PROM11,
      PROM21,
      PROM51,
      PROM53,
    ]) {
      expect(prompt.toolPolicy).toBe('disabled')
      expect(buildPromptFromTemplate(prompt, [])).not.toContain('Do not use tools.')
    }

    for (const prompt of [
      PROM1,
      PROM3,
      PROM4,
      PROM5,
      PROM10a,
      PROM10b,
      PROM12,
      PROM13,
      PROM13b,
      PROM20,
      PROM22,
      PROM23,
      PROM24,
      PROM25,
    ]) {
      expect(prompt.toolPolicy).toBe('read_only')
      expect(buildPromptFromTemplate(prompt, [])).not.toContain('Do not use tools.')
    }

    for (const prompt of [PROM0, PROM_CODING, PROM52, PROM54]) {
      expect(prompt.toolPolicy).toBe('default')
      expect(buildPromptFromTemplate(prompt, [])).not.toContain('Do not use tools.')
    }

    expect(PROM_EXECUTION_SETUP.toolPolicy).toBe('execution_setup_online')
    expect(buildPromptFromTemplate(PROM_EXECUTION_SETUP, [])).not.toContain('Do not use tools.')
    expect(PROM_EXECUTION_CAPABILITY_PROBE.toolPolicy).toBe('read_only')
    expect(buildPromptFromTemplate(PROM_EXECUTION_CAPABILITY_PROBE, [])).not.toContain('Do not use tools.')
    expect(PROM_EXECUTION_SETUP_PLAN.toolPolicy).toBe('read_only')
    expect(PROM_EXECUTION_SETUP_PLAN_REGENERATE.toolPolicy).toBe('read_only')
    expect(PROM_MANUAL_QA_FIX_BEADS.toolPolicy).toBe('read_only')
  })

  it('grounds conditional repository inspection in supplied evidence before targeted reads', () => {
    for (const prompt of [
      PROM1,
      PROM3,
      PROM4,
      PROM5,
      PROM10a,
      PROM10b,
      PROM12,
      PROM13,
      PROM13b,
      PROM20,
      PROM22,
      PROM23,
      PROM24,
      PROM25,
    ]) {
      const rendered = buildPromptFromTemplate(prompt, [])
      expect(rendered).toContain('Conditional Repository Inspection:')
      expect(rendered).toContain('Review the repository evidence already supplied in context, including `relevant_files` when available.')
    }
  })

  it('keeps interview repository inspection focused on discoverable technical facts rather than stakeholder decisions', () => {
    for (const prompt of [PROM1, PROM3, PROM4, PROM5]) {
      const rendered = buildPromptFromTemplate(prompt, [])
      expect(rendered).toContain('Interview Repository Boundary:')
      expect(rendered).toContain('Never infer stakeholder preferences, desired behavior, scope, priorities, acceptance decisions, or product requirements from repository contents')
    }

    expect(buildPromptFromTemplate(PROM2, [])).not.toContain('Conditional Repository Inspection:')
  })

  it('uses same-session rules for prompts that continue an existing session', () => {
    const prompt = buildSameSessionPromptFromTemplate(PROM51, [])

    expect(prompt).toContain('EXISTING SESSION:')
    expect(prompt).toContain('continuing in an existing session')
    expect(prompt).toContain('Failed Iteration Notes entry')
    expect(prompt).not.toContain('CONTEXT REFRESH:')
    expect(prompt).not.toContain('fresh session with no prior conversation history')
  })

  it('defines an explicit shared PRD schema contract for draft and refine prompts', () => {
    expect(PROM12.outputFormat).toContain(PROM10b.outputFormat)
    expect(PROM12.outputFormat).toContain('top-level `changes` list')
    expect(PROM12.outputFormat).toContain('inspiration')
    expect(PROM10b.outputFormat).toContain('schema_version')
    expect(PROM10b.outputFormat).toContain('technical_requirements')
    expect(PROM10b.outputFormat).toContain('required_commands')
    expect(PROM10b.outputFormat).toContain('begins with backticks or `@`, or contains `: ` in plain text, must be double-quoted')
    expect(PROM10b.outputFormat).not.toContain('PROM13.output_file')

    const draftPrompt = buildPromptFromTemplate(PROM10b, [])
    expect(draftPrompt).toContain('Schema Contract')
    expect(draftPrompt).toContain('Complete Interview Input')
    expect(draftPrompt).toContain('Source Contradiction Rule')
    expect(draftPrompt).toContain('do not choose a side or invent a requirement')
    expect(draftPrompt).toContain('artifact: "prd"')
    expect(draftPrompt).toContain('acceptance_criteria')
    expect(draftPrompt).toContain('Every epic must include at least one fully populated `user_stories` entry')
    expect(draftPrompt).toContain('Begin the artifact at `schema_version` and end at `approval.approved_at`')
    expect(draftPrompt).toContain('shorten field text instead of truncating later epics')
    expect(draftPrompt).toContain('Any one-line scalar or list item that begins with backticks or `@`, or contains `: ` in plain text, must be double-quoted')
    expect(draftPrompt).toContain('Never repeat prompt scaffolding or placeholder schema lines from `## Expected Output Format`, `## Context`, or `# Ticket:`')
    expect(draftPrompt).toContain('Never output implementation plans, diffs, next steps, acknowledgements, commentary')

    const refinePrompt = buildPromptFromTemplate(PROM12, [])
    expect(refinePrompt).toContain('Return one YAML artifact')
    expect(refinePrompt).toContain('Do not split the refined PRD and change metadata')
    expect(refinePrompt).toContain('Every epic in the final PRD must include at least one fully populated `user_stories` entry')
    expect(refinePrompt).toContain('Include `inspiration.item.detail` whenever the source item has useful supporting text')

    const coverageResolutionPrompt = buildPromptFromTemplate(PROM13b, [])
    expect(coverageResolutionPrompt).toContain('Every epic in the revised PRD must include at least one fully populated `user_stories` entry')
    expect(coverageResolutionPrompt).toContain('making the affected acceptance criteria, scope language, or verification guidance more concrete and testable')
    expect(coverageResolutionPrompt).toContain('If a gap updates top-level PRD sections such as `product`, `scope`, `technical_requirements`, or `api_contracts`, keep `affected_items: []`')
    expect(coverageResolutionPrompt).toContain('If a provided gap describes internally contradictory source artifacts')
    expect(coverageResolutionPrompt).toContain('Record that gap with `action: left_unresolved` and `affected_items: []`')
  })

  it('keeps PROM10a strict about preserving user answers and outputting only a full interview artifact', () => {
    const gapPrompt = buildPromptFromTemplate(PROM10a, [])
    expect(gapPrompt).toContain('The approved Interview Results artifact is already included in the prompt')
    expect(gapPrompt).toContain('Conditional Repository Inspection:')
    expect(gapPrompt).toContain('Use inspection only to confirm a technical fact needed for a skipped answer')
    expect(gapPrompt).toContain('Preserve every existing non-skipped answer exactly as-is')
    expect(gapPrompt).toContain('The only fields you may change are `questions[*].answer`')
    expect(gapPrompt).toContain('provide a concrete `free_text` and/or `selected_option_ids`')
    expect(gapPrompt).toContain('For any `free_text` question with `skipped: false`, `free_text` must be non-empty')
    expect(gapPrompt).toContain('set a non-empty ISO-8601 `answered_at` timestamp')
    expect(gapPrompt).toContain('no question may remain with `answer.skipped: true`')
    expect(gapPrompt).toContain('populate best-fit canonical `selected_option_ids` using the provided option IDs')
    expect(gapPrompt).toContain('Copy each canonical question block exactly as provided and change only the `answer` block')
    expect(gapPrompt).toContain('always set `selected_option_ids` using the canonical option IDs already present in that question block')
    expect(gapPrompt).toContain('Treat provided single-choice and multiple-choice options as orientation only, not as the full answer')
    expect(gapPrompt).toContain('For choice questions, `free_text` is optional when an existing option is an exact fit, but preferred when nuance, caveats, or a better suggestion matter')
    expect(gapPrompt).toContain('Do not use `free_text` only to restate the selected option label')
    expect(gapPrompt).toContain('If the final free-form question truly has nothing else to add')
    expect(gapPrompt).toContain('instead of `""`')
    expect(gapPrompt).toContain('If an earlier answer makes a follow-up question not applicable')
    expect(gapPrompt).toContain('never leave that follow-up answer blank')
    expect(gapPrompt).toContain('shorten answer text instead of omitting later question blocks')
    expect(gapPrompt).toContain('Do not read files, search for more context, propose an implementation plan')
    expect(gapPrompt).toContain('Stop immediately after the final `approval` block')
    expect(gapPrompt).toContain('Never repeat prompt scaffolding or placeholder schema lines from `## Expected Output Format`, `## Context`, or `# Ticket:`')
    expect(gapPrompt).toContain('answered_by: ai_skip')
    expect(gapPrompt).toContain('status: draft')
    expect(gapPrompt).toContain('Return the entire interview artifact from `schema_version` through the final `approval` block')
    expect(gapPrompt).toContain('Return exactly one complete interview artifact and nothing else')
  })

  it('keeps PRD coverage output envelope-only without PRD rewrite instructions', () => {
    const coveragePrompt = buildPromptFromTemplate(PROM13, [])
    expect(coveragePrompt).toContain('return only YAML with top-level `status`, `gaps`, and `follow_up_questions`')
    expect(coveragePrompt).toContain('max_coverage_passes')
    expect(coveragePrompt).toContain('Every item in `gaps` must be a double-quoted YAML string')
    expect(coveragePrompt).toContain('`follow_up_questions` is always `[]` for PRD coverage')
    expect(coveragePrompt).toContain('`follow_up_questions` must always be `[]`')
    expect(coveragePrompt).toContain('Acceptance criteria must be specific enough to verify')
    expect(coveragePrompt).toContain('Every major in-scope requirement, user flow, constraint, non-goal, or explicit edge case')
    expect(coveragePrompt).toContain('Flag PRD user stories that have missing or weak verification guidance')
    expect(coveragePrompt).toContain('missing traceability for major in-scope items')
    expect(coveragePrompt).toContain('Treat the winner Full Answers artifact as the canonical source for PRD coverage')
    expect(coveragePrompt).toContain('If the winner Full Answers artifact is internally contradictory')
    expect(coveragePrompt).toContain('report the contradiction as an unresolved coverage gap')
    expect(coveragePrompt).toContain('Do not output a rewritten PRD')
    expect(coveragePrompt).not.toContain('Provide the necessary additions or modifications to the PRD')
    expect(PROM13.contextInputs).toEqual(['full_answers', 'prd'])
    expect(PROM13b.contextInputs).toEqual(['full_answers', 'prd', 'coverage_gaps'])
  })

  it('keeps interview coverage explicit about structured follow-up question objects', () => {
    const coveragePrompt = buildPromptFromTemplate(PROM5, [])
    expect(coveragePrompt).toContain('return only YAML with top-level `status`, `gaps`, and `follow_up_questions`')
    expect(coveragePrompt).toContain('follow_up_budget_remaining')
    expect(coveragePrompt).toContain('max_coverage_passes')
    expect(coveragePrompt).toContain('Every item in `gaps` must be a double-quoted YAML string')
    expect(coveragePrompt).toContain('`id`, `question`, `phase`, `priority`, `rationale`')
    expect(coveragePrompt).toContain('Do not return plain strings in `follow_up_questions`')
    expect(coveragePrompt).toContain('Do not output rewritten interview results')
    expect(coveragePrompt).toContain('ready for interview approval')
    expect(coveragePrompt).toContain('PRD generation begins only after that approval step')
  })

  it('keeps beads coverage explicit about quoted gap strings', () => {
    const coveragePrompt = buildPromptFromTemplate(PROM23, [])
    expect(coveragePrompt).toContain('Every item in `gaps` must be a double-quoted YAML string')
    expect(coveragePrompt).toContain('backticks, or punctuation')
    expect(coveragePrompt).toContain('If the approved PRD is internally contradictory')
    expect(coveragePrompt).toContain('report the contradiction as an unresolved coverage gap')
    expect(coveragePrompt).toContain('The coverage decision itself remains about whether the blueprint covers the approved PRD')
    expect(coveragePrompt).not.toContain('Command Compatibility Check')
  })

  it('keeps beads coverage resolution explicit about semantic-plan output and gap accounting', () => {
    const coverageResolutionPrompt = buildPromptFromTemplate(PROM24, [])
    expect(coverageResolutionPrompt).toContain('current implementation plan as the baseline')
    expect(coverageResolutionPrompt).toContain('Return semantic Part 1 bead records only')
    expect(coverageResolutionPrompt).toContain('top-level `gap_resolutions` list with exactly one entry per provided gap')
    expect(coverageResolutionPrompt).toContain('`action` must be one of `updated_beads`, `already_covered`, or `left_unresolved`')
    expect(coverageResolutionPrompt).toContain('top-level `beads` list')
    expect(coverageResolutionPrompt).toContain('If a gap does not map cleanly to one or more specific beads, keep `affected_items: []`')
    expect(coverageResolutionPrompt).toContain('If a provided gap describes internally contradictory source artifacts')
    expect(coverageResolutionPrompt).toContain('Record that gap with `action: left_unresolved` and `affected_items: []`')
  })

  it('requires the bead subset schema consistently in draft and refine prompts', () => {
    expect(PROM20.outputFormat).toContain('top-level `beads` key')
    expect(PROM20.outputFormat).toContain('id:')
    expect(PROM20.outputFormat).toContain('contextGuidance:')
    expect(PROM20.outputFormat).toContain('patterns:')
    expect(PROM20.outputFormat).toContain('anti_patterns:')
    expect(PROM20.outputFormat).toContain('prefer a block scalar (`|-`) and otherwise use a double-quoted YAML string')
    expect(PROM20.outputFormat).toContain('escape literal backslashes as `\\\\`')
    expect(PROM20.outputFormat).toContain('For `testCommands` containing regex backslashes')
    expect(PROM20.outputFormat).toContain('Never emit quoted block-scalar indicators such as `"|-"`')
    expect(PROM20.outputFormat).toContain('Never use YAML single-quoted scalars for punctuation-heavy commands, code snippets, regex-like text')
    expect(PROM22.outputFormat).toContain(PROM20.outputFormat)
    expect(PROM24.outputFormat).toContain('Never emit quoted block-scalar indicators such as `"|-"`')
    expect(PROM22.outputFormat).toContain('top-level `changes` list')
    expect(PROM22.outputFormat).toContain('inspiration')

    const draftPrompt = buildPromptFromTemplate(PROM20, [])
    expect(draftPrompt).toContain('contextGuidance:')
    expect(draftPrompt).toContain('patterns:')
    expect(draftPrompt).toContain('anti_patterns:')
    expect(draftPrompt).toContain('dense punctuation, quotes, backslashes, `: `, brackets, braces, shell metacharacters, or other code-like inline syntax')
    expect(draftPrompt).toContain('never put raw `\\+` inside a double-quoted YAML string')
    expect(draftPrompt).toContain('Boundary Rule: Begin output at the `beads:` key. End after the last bead item.')
    expect(draftPrompt).toContain('If you use a block scalar, emit the indicator unquoted on the key line')

    const refinePrompt = buildPromptFromTemplate(PROM22, [])
    expect(refinePrompt).toContain('Return one YAML artifact')
    expect(refinePrompt).toContain('Do not split the refined beads and change metadata')
    expect(refinePrompt).toContain('Include `inspiration.item.detail` whenever the source item has useful supporting text')
  })

  it('keeps PROM21 explicit about randomized anonymous beads voting and strict scorecards', () => {
    const votePrompt = buildPromptFromTemplate(PROM21, [])

    expect(PROM21.outputFormat).toContain('top-level `draft_scores` mapping keyed by exact draft labels')
    expect(votePrompt).toContain('Drafts are presented in randomized order per evaluator')
    expect(votePrompt).toContain('Do not assume the first draft is the baseline or best')
    expect(votePrompt).toContain('compare each draft against the final PRD')
    expect(votePrompt).toContain('The top-level key MUST be `draft_scores`')
    expect(votePrompt).toContain('Each draft entry MUST contain exactly 6 integer fields on single lines')
    expect(votePrompt).toContain('Do not output prose, explanations, markdown fences')
  })

  it('defines execution setup prompts with explicit workspace setup rules', () => {
    const probePrompt = buildPromptFromTemplate(PROM_EXECUTION_CAPABILITY_PROBE, [])
    const setupPlanPrompt = buildPromptFromTemplate(PROM_EXECUTION_SETUP_PLAN, [])
    const setupPlanRegeneratePrompt = buildPromptFromTemplate(PROM_EXECUTION_SETUP_PLAN_REGENERATE, [])
    const setupPrompt = buildPromptFromTemplate(PROM_EXECUTION_SETUP, [])
    const setupNotePrompt = buildPromptFromTemplate(PROM_EXECUTION_SETUP_NOTE, [])

    expect(probePrompt).toContain('reply with exactly OK and nothing else')
    expect(probePrompt).toContain('read-only')
    expect(PROM_EXECUTION_CAPABILITY_PROBE.toolPolicy).toBe('read_only')
    expect(setupPlanPrompt).toContain('<EXECUTION_SETUP_PLAN>')
    expect(setupPlanPrompt).toContain('No Execution')
    expect(setupPlanPrompt).toContain('Existing Readiness First')
    expect(setupPlanPrompt).toContain('actions_required')
    expect(setupPlanPrompt).toContain('execution_setup_plan')
    expect(setupPlanPrompt).toContain('.ticket/runtime/execution-setup')
    expect(setupPlanPrompt).toContain('Manifests, lockfiles, or scripts prove the project type, but they do not prove readiness')
    expect(setupPlanPrompt).toContain('Missing command launchers or toolchains for discovered command families are setup gaps')
    expect(setupPlanPrompt).toContain('Runtime Command Readiness')
    expect(setupPlanPrompt).not.toContain('Bead Command Audit')
    expect(setupPlanPrompt).toContain('.ticket/runtime/execution-setup/tool-cache')
    expect(setupPlanPrompt).toContain('Tracked Change Boundary')
    expect(setupPlanPrompt).not.toContain('.cache/project-tooling')
    expect(setupPlanPrompt).toContain('Each step must include `id`, `title`, `purpose`, `commands`, `required`, `rationale`, and `cautions`')
    expect(setupPlanPrompt).toContain('"title": "short step title"')
    expect(setupPlanPrompt).toContain('"rationale": "evidence or reasoning for this step"')
    expect(setupPlanPrompt).toContain('Original Checkout Audit')
    expect(setupPlanPrompt).toContain('ignored or untracked file or directory')
    expect(setupPlanPrompt).toContain('concrete repository evidence or a prior workspace-setup failure')
    expect(setupPlanPrompt).toContain('Do not include file contents and do not add shell copy commands to `steps`')
    expect(setupPlanPrompt).toContain('Never propose `.git`, `.ticket`, `.looptroop`, or paths outside the original checkout')
    expect(setupPlanPrompt).toContain('"workspace_inputs"')
    expect(setupPlanPrompt).toContain('"kind":"file|directory"')
    expect(setupPlanPrompt).toContain('"source_status":"ignored|untracked"')
    expect(setupPlanPrompt).not.toContain('Never propose copying ignored files from another checkout')
    expect(PROM_EXECUTION_SETUP_PLAN.contextInputs).toEqual(['ticket_details', 'relevant_files', 'prd', 'beads', 'execution_setup_profile', 'execution_setup_plan_notes'])
    expect(setupPlanRegeneratePrompt).toContain('current draft baseline')
    expect(setupPlanRegeneratePrompt).toContain('Remain language-agnostic')
    expect(setupPlanRegeneratePrompt).toContain('Recheck launcher readiness while revising')
    expect(setupPlanRegeneratePrompt).toContain('prior workspace-runtime failure context')
    expect(PROM_EXECUTION_SETUP_PLAN_REGENERATE.contextInputs).toEqual(['ticket_details', 'relevant_files', 'prd', 'beads', 'execution_setup_profile', 'execution_setup_plan', 'execution_setup_plan_notes'])
    expect(setupPrompt).toContain('<EXECUTION_SETUP_RESULT>')
    expect(setupPrompt).toContain('Approved Plan First')
    expect(setupPrompt).toContain('Readiness Respect')
    expect(setupPrompt).toContain('Audited Augmentations')
    expect(setupPrompt).toContain('Approved Workspace Inputs')
    expect(setupPrompt).toContain('Do not copy additional ignored or untracked paths that are not present in the approved plan')
    expect(setupPrompt).not.toContain('Never copy ignored files from the primary checkout')
    expect(setupPrompt).toContain('.ticket/runtime/execution-setup')
    expect(setupPrompt).toContain('.ticket/runtime/execution-setup/tool-cache')
    expect(setupPrompt).toContain('Missing Tool Self-Healing')
    expect(setupPrompt).toContain('attempt safe user-space provisioning')
    expect(setupPrompt).toContain('Do not use `sudo`, global OS package-manager installs, or arbitrary source-tree install paths')
    expect(setupPrompt).toContain('Missing required launchers: a failed version/info probe is discovery only')
    expect(setupPrompt).toContain('Provisioning persistence: after a required launcher provisioning attempt fails')
    expect(setupPrompt).toContain('Real provisioning attempts: If the required launcher is missing')
    expect(setupPrompt).toContain('wrapper creation, cache inspection, PATH edits, and version probes do not count as provisioning strategies')
    expect(setupPrompt).toContain('Version pins/ranges: interpret repository-declared tool versions')
    expect(setupPrompt).toContain('Online artifact lookup')
    expect(setupPrompt).toContain('OpenCode `websearch`')
    expect(setupPrompt).toContain('`webfetch` for official release/download metadata')
    expect(setupPrompt).toContain('Provisioning Examples, Non-Exhaustive')
    expect(setupPrompt).toContain('For Node')
    expect(setupPrompt).toContain('for Python')
    expect(setupPrompt).toContain('for JavaScript runtimes such as Deno or Bun')
    expect(setupPrompt).toContain('These examples are illustrative only; use any safe, repository-appropriate commands')
    expect(setupPrompt).not.toContain('Go Toolchain Provisioning')
    expect(setupPrompt).not.toContain('official OS/architecture Go archive')
    expect((setupPrompt.match(/(?:For Node|for Python|for JavaScript runtimes)/g) ?? [])).toHaveLength(3)
    expect(setupPrompt).toContain('.ticket/runtime/execution-setup/env.sh')
    expect(setupPrompt).toContain('.ticket/runtime/execution-setup/run')
    expect(setupPrompt).toContain('LoopTroop independently routes the approved plan\'s bare workspace probes')
    expect(setupPrompt).toContain('avoids double wrapping')
    expect(setupPrompt).toContain('Workspace Writes')
    expect(setupPrompt).toContain('Gitignore Suggestions')
    expect(setupPrompt).toContain('do not edit `.gitignore` during setup')
    expect(setupPrompt).toContain('Feature-Work Ban')
    expect(setupPrompt).toContain('do not leave those changes behind')
    expect(setupPrompt).toContain('set `checks.tooling` to `fail`')
    expect(setupPrompt).toContain('only after at least two distinct safe user-space provisioning strategies under approved temp roots fail')
    expect(setupPrompt).toContain('tooling_probe_commands')
    expect(setupPrompt).toContain('tool_requirements')
    expect(setupPrompt).toContain('provisioning_attempts')
    expect(setupPrompt).toContain('LoopTroop reruns these probes before coding')
    expect(setupPrompt).toContain('execution_setup_profile')
    expect(PROM_EXECUTION_SETUP.contextInputs).toEqual(['ticket_details', 'beads', 'execution_setup_plan', 'execution_setup_notes'])
    expect(setupNotePrompt).toContain('append-only retry note')
  })

  it('PROM_CODING includes completion instructions, bead context guidance, and self-check', () => {
    const prompt = buildPromptFromTemplate(PROM_CODING, [])
    expect(prompt).toContain('BEAD_STATUS')
    expect(prompt).toContain('bead_data')
    expect(prompt).toContain('bead notes')
    expect(prompt).toContain('.ticket/runtime/execution-setup-profile.json')
    expect(prompt).toContain('Execution Setup Reference')
    expect(prompt).toContain('Prepared Runtime Wrapper')
    expect(prompt).toContain('./.ticket/runtime/execution-setup/run ...')
    expect(prompt).not.toContain('active_bead')
    expect(prompt).not.toContain('execution_setup_profile context')
    expect(prompt).toContain('Do not rediscover or rebuild the full environment unless the existing setup is missing or invalid')
    expect(prompt).toContain('no approved temp root from the setup profile can hold execution-only tooling')
    expect(prompt).toContain('Never download or install toolchains, SDKs, package managers, or large caches into arbitrary project paths')
    expect(prompt).toContain('unrelated baseline debt')
    expect(prompt).toContain('plain-language status updates')
    expect(prompt).toContain('Final Self-Check')
    expect(prompt).toContain('quality gates')
    expect(prompt).toContain('A `done/pass` marker is only a candidate completion')
    expect(prompt).toContain('independently rerun every declared `testCommands` entry')
    expect(prompt).toContain('deterministic failure receipt to this same session')
    expect(PROM_CODING.contextInputs).toEqual(['bead_data', 'bead_notes'])
  })

  it('tells final-test generation to reuse prepared runtime wrappers', () => {
    const prompt = buildPromptFromTemplate(PROM52, [])

    expect(prompt).toContain('Execution Setup Reference')
    expect(prompt).toContain('.ticket/runtime/execution-setup-profile.json')
    expect(prompt).toContain('./.ticket/runtime/execution-setup/run ...')
    expect(prompt).toContain('prepared PATH and cache variables')
    expect(prompt).toContain('LoopTroop will also execute returned commands through the declared setup wrapper')
  })

  it('keeps PROM25 explicit about expansion-only ownership, preserved order, and focused read-only target-file inspection', () => {
    const expandPrompt = buildPromptFromTemplate(PROM25, [])

    expect(expandPrompt).toContain('Order Is Mandatory')
    expect(expandPrompt).toContain('The app executes beads sequentially in this order')
    expect(expandPrompt).toContain('Add only these fields per bead: `id`, `issueType`, `labels`, `dependencies.blocked_by`, and `targetFiles`')
    expect(expandPrompt).toContain('Do not generate or rely on `priority`, `status`, `externalRef`, `dependencies.blocks`')
    expect(expandPrompt).toContain('Use `relevant_files` first as hints for likely `targetFiles`')
    expect(PROM25.toolPolicy).toBe('read_only')
    expect(expandPrompt).toContain('Conditional Repository Inspection:')
    expect(expandPrompt).toContain('Do not edit files, run commands, or change the repository')
  })

  it('requires Manual QA fix-bead generation to inspect the repository and return every full candidate', () => {
    const prompt = buildPromptFromTemplate(PROM_MANUAL_QA_FIX_BEADS, [])
    expect(prompt).toContain('at least one successful focused read-only repository tool call')
    expect(prompt).toContain('exactly one candidate for every supplied merge-group ID')
    expect(prompt).toContain('acceptance criteria, automated tests, runnable test commands')
    expect(prompt).toContain('<MANUAL_QA_FIX_BEADS>')
    expect(prompt).toContain('LoopTroop adds those fields after validation')
  })

  it('keeps PROM4 and PROM52 explicit about marker-only structured output', () => {
    const interviewPrompt = buildPromptFromTemplate(PROM4, [])
    const finalTestPrompt = buildPromptFromTemplate(PROM52, [])

    expect(interviewPrompt).toContain('primary interview checklist')
    expect(interviewPrompt).toContain('work through the compiled question set faithfully')
    expect(interviewPrompt).toContain('fully resolves one or more future compiled questions')
    expect(interviewPrompt).toContain('preserve its original compiled question ID whenever possible')
    expect(interviewPrompt).toContain('when a prior answer fully resolves that question')
    expect(interviewPrompt).toContain('Do not move to the final free-form question just because coverage feels good enough')
    expect(interviewPrompt).toContain("Keep the question anchored to 'Anything else to add before PRD generation?'")
    expect(interviewPrompt).toContain('coverage check may still create targeted follow-up questions')
    expect(interviewPrompt).toContain('interview approval step before PRD drafting begins')
    expect(interviewPrompt).toContain('Output Discipline')
    expect(interviewPrompt).toContain('Formatting Discipline')
    expect(interviewPrompt).toContain('schema_version: 1')
    expect(PROM4.contextInputs).toEqual(['ticket_details'])
    expect(finalTestPrompt).toContain('Prior Notes')
    expect(finalTestPrompt).toContain('Mandatory Self-Execution')
    expect(finalTestPrompt).toContain('run the exact command(s) you plan to return')
    expect(finalTestPrompt).toContain('fix the underlying implementation and/or the final test files')
    expect(finalTestPrompt).toContain('Do Not Game The Tests')
    expect(finalTestPrompt).toContain('Return `<FINAL_TEST_COMMANDS>` only after the exact listed command(s) have passed locally')
    expect(finalTestPrompt).toContain('.ticket/runtime/execution-setup/**')
    expect(finalTestPrompt).toContain('.ticket/runtime/execution-setup-profile.json')
    expect(interviewPrompt).toContain('follow_up_rounds:')
    expect(interviewPrompt).not.toContain('PROM5.output_file schema')
    expect(finalTestPrompt).toContain('Output Discipline')
    expect(finalTestPrompt).toContain('Final Self-Check')
    expect(PROM52.contextInputs).toEqual(['ticket_details', 'prd', 'beads', 'final_test_notes'])
  })
})
