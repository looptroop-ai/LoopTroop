/** Kanban column a workflow phase maps to — drives the kanban board layout. */
export type KanbanPhase = 'todo' | 'in_progress' | 'needs_input' | 'done'
export type WorkflowGroupId =
  | 'todo'
  | 'discovery'
  | 'interview'
  | 'prd'
  | 'beads'
  | 'pre_implementation'
  | 'implementation'
  | 'post_implementation'
  | 'done'
  | 'errors'
type WorkflowUIView = 'draft' | 'council' | 'interview_qa' | 'approval' | 'coding' | 'manual_qa' | 'error' | 'done' | 'canceled'
/** Artifact types that support user editing from an approval gate. */
export type EditableArtifactType = 'interview' | 'prd' | 'beads' | 'execution_setup_plan'
export type ReviewArtifactType = EditableArtifactType | 'manual_qa_checklist'
/**
 * Keys identifying the context data artifacts that each workflow phase receives.
 * Each key maps to a labeled description shown in the Details dialog.
 */
export type WorkflowContextKey =
  | 'ticket_details'
  | 'relevant_files'
  | 'drafts'
  | 'interview'
  | 'full_answers'
  | 'user_answers'
  | 'votes' // Reserved — defined in CONTEXT_KEY_LABELS but not currently used in any phase's contextSummary
  | 'prd'
  | 'beads'
  | 'beads_draft'
  | 'tests'
  | 'bead_data'
  | 'bead_notes'
  | 'execution_setup_plan'
  | 'execution_setup_plan_notes'
  | 'execution_setup_profile'
  | 'execution_setup_notes'
  | 'final_test_notes'
  | 'manual_qa_previous'
  | 'manual_qa_checklist'
  | 'manual_qa_results'
  | 'error_context'

/** Content shown in the "Details" dialog for a workflow phase — overview, steps, outputs, transitions, notes, and cross-references to equivalent steps. */
export interface WorkflowPhaseDetails {
  overview: string
  steps: readonly string[]
  outputs: readonly string[]
  transitions: readonly string[]
  notes?: readonly string[]
  equivalents?: readonly string[]
}

/** Complete metadata for a single workflow phase — drives the status bar, Details dialog, kanban board, and context display. */
export interface WorkflowPhaseMeta {
  id: string
  label: string
  /** Short description shown below the phase label in the status bar. Safe-resume text is automatically appended at runtime. */
  description: string
  /** Detailed breakdown shown in the "Details" dialog (overview, steps, outputs, transitions, notes, equivalents). */
  details: WorkflowPhaseDetails
  kanbanPhase: KanbanPhase
  groupId: WorkflowGroupId
  uiView: WorkflowUIView
  editable: boolean
  multiModelLogs: boolean
  reviewArtifactType?: ReviewArtifactType
  progressKind?: 'questions' | 'beads'
  /** Context keys whose descriptions are shown in the "Context" section of the Details dialog. */
  contextSummary: WorkflowContextKey[]
  contextSections?: readonly WorkflowContextSection[]
}

/** Group header for workflow phases displayed in the navigator and Details dialog. */
export interface WorkflowGroupMeta {
  id: WorkflowGroupId
  label: string
}

/** A labeled group of context keys shown in the Details dialog when a phase has multi-part context (e.g., PRD drafting Part 1 / Part 2). */
export interface WorkflowContextSection {
  label: string
  description?: string
  keys: readonly WorkflowContextKey[]
}

function mergeContextSections(sections: readonly WorkflowContextSection[]): WorkflowContextKey[] {
  const merged: WorkflowContextKey[] = []
  for (const section of sections) {
    for (const key of section.keys) {
      if (!merged.includes(key)) merged.push(key)
    }
  }
  return merged
}

const WORKFLOW_PHASE_DETAILS = {
  DRAFT: {
    overview: 'The ticket exists as a backlog item only — no AI work, planning run, or execution state has started yet. Think of this as the "idea stage": the ticket is fully user-controlled and editable, giving you time to refine the title, description, priority, and project assignment before launching the automated workflow pipeline.',
    steps: [
      'Ticket Creation: When you create a ticket, LoopTroop stores the title and description as the seed context for downstream AI phases. Priority, project association, settings, and structured origin/provenance remain operational or informational metadata and are not added to Ticket Details prompt context.',
      'Council Configuration Lock: Behind the scenes, LoopTroop has already assigned a main implementer model and a set of council member models based on your project configuration. These assignments are locked at start time, not at creation — so changing project settings before starting will affect which models participate.',
      'Editable Window: While in Draft, you can freely change any ticket field. Once you press Start, the title and description become the authoritative "Ticket Details" context artifact that the scanning phase reads. Edits after Start require navigating back and may trigger cascade warnings.',
      'No AI Activity: No relevant-files scan, interview artifact, PRD, beads plan, or runtime worktree activity is performed in this state. The ticket directory in the workspace may not even exist yet until Start is triggered.',
      'Start Trigger: When Start is triggered, LoopTroop locks the council configuration (main implementer and council members), initializes the ticket workspace directory on disk, creates the initial runtime state, and begins the planning pipeline from the first active AI phase (Scanning Relevant Files).',
    ],
    outputs: [
      'Ticket metadata record (title, description, priority, project association, implementation notes).',
      'No planning or execution artifacts exist yet — only the ticket record itself.',
      'The ticket status is fully user-controlled through Start or Cancel actions at this point.',
    ],
    transitions: [
      'Start → Scanning Relevant Files: Locks the council configuration, initializes the ticket workspace directory, and begins the automated planning pipeline.',
      'Cancel → Canceled: Moves the ticket directly to the terminal Canceled state without producing any artifacts.',
    ],
    notes: [
      'This is the only phase where the ticket is intentionally inactive — no background processing occurs.',
      'No AI-owned files or workspace directories are expected to exist yet.',
      'Context available: Ticket Details only (the saved title and description). Priority, project data, settings, and origin/provenance metadata are excluded.',
      'Tip: Take your time here to write a clear, detailed description. The quality of your ticket description directly impacts how well the AI understands your intent throughout all subsequent phases.',
    ],
  },
  SCANNING_RELEVANT_FILES: {
    overview: 'LoopTroop performs a focused codebase scan before any council work starts, so later phases can reference the actual source files instead of guessing about your codebase structure. This is a single-model phase using the locked main implementer — not a multi-council step. The scan output becomes a reusable context artifact that every subsequent phase (interview, PRD, beads) can draw from.',
    steps: [
      'Prompt Assembly: LoopTroop builds a minimal prompt from the ticket title and description (the Ticket Details context). The prompt instructs the model to identify source files that are likely relevant to implementing this ticket — including files that would need modification, files that provide important interfaces or types, and files that contain related logic.',
      'Model Execution: The locked main implementer model processes the prompt under the configured AI Response Timeout and returns a structured response listing relevant files with their paths, content excerpts, relevance ratings (e.g., high/medium/low), and natural-language rationales explaining why each file matters to this ticket.',
      'Output Validation: LoopTroop validates the structured output against the expected schema (correct field types, non-empty file paths, valid relevance levels). Provider, session, and OpenCode failures are correlated with empty or discarded validation failures so transient infrastructure errors are not mistaken for ordinary malformed output. If validation fails, LoopTroop may use the ticket\'s configured Structured Output Retries count, either with a continued session repair prompt or by starting a fresh session, and records rejected/accepted raw attempts on the scan artifact.',
      'Artifact Persistence: On success, LoopTroop writes the canonical `relevant-files.yaml` artifact into the ticket workspace directory. This YAML file becomes the reusable file-context artifact that all downstream phases can reference without needing to re-scan the codebase.',
      'Summarized Scan Artifact: A companion summarized scan artifact is also stored for UI review, giving you a quick overview of what files were identified and why.',
      'Logging: The normal phase log captures key session lifecycle milestones — prompt dispatch timing, summarized model output, retry attempts, validation results, correlated provider/session/OpenCode diagnostics, and the final extracted file count.',
    ],
    outputs: [
      'Canonical `relevant-files.yaml` inside the ticket workspace — this becomes a shared context artifact that interview, PRD, and beads phases all receive as part of their input context.',
      'Structured scan artifact containing file paths, content previews, relevance levels (high/medium/low), natural-language rationales, Raw attempt variants for any automatic structured retry, and intervention notices on the primary Files tab.',
      'Normal phase logs with session lifecycle, prompt dispatch, retry history, and diagnostics.',
    ],
    transitions: [
      'Success → Council Drafting Questions: A valid scan artifact advances the ticket to the council deliberation phase where multiple models begin drafting interview questions.',
      'Failure → Blocked Error: Validation failure after the configured structured retries, correlated provider/session/OpenCode errors, model timeout, missing implementer configuration, or unexpected runtime errors route the ticket to the Blocked Error state for manual intervention.',
    ],
    notes: [
      'This phase is single-model (main implementer only), not multi-council — it is a preparatory step before the council engages.',
      'The scan is purely context-building: it reads and identifies files but does not modify any source files in your repository.',
      'Context available: Ticket Details only (the model does not yet have interview results, PRD, or beads — those are created in later phases).',
      'Why this matters: Without relevant file context, later phases would have to reason about your codebase from the ticket description alone. The scan gives the council concrete file references to ground their interview questions and specifications in your actual code.',
    ],
  },
  COUNCIL_DELIBERATING: {
    overview: 'The interview council creates competing interview/question drafts so the system can compare multiple approaches before asking you anything. This is the first multi-model phase in the workflow — each configured council member works independently and in parallel, producing their own interview strategy without seeing what the others are doing. The diversity of approaches is intentional: it ensures the final interview covers angles that any single model might miss.',
    steps: [
      'Context Loading: LoopTroop loads the ticket details (saved title and description only) and the relevant-files artifact (file paths, excerpts, rationales) as the shared prompt context that every council member receives identically.',
      'Parallel Draft Generation: Each configured council model receives the same context but drafts its own interview approach independently. When that context cannot confirm a discoverable repository fact, it may inspect the smallest relevant repository area read-only. Models are not allowed to see or influence each other\'s outputs — this independence is key to producing genuinely diverse interview strategies.',
      'Draft Content: Each draft typically includes a set of interview questions, their types (free-text, choice-based), ordering rationale, and a strategy explanation for why these particular questions would best clarify the implementation intent.',
      'Progress Tracking: LoopTroop tracks per-model progress in real time, streaming model logs to the UI so you can see how each council member is progressing. It also monitors quorum — the minimum number of successful drafts needed to proceed.',
      'Quorum Check: If too many models fail (insufficient successful drafts to meet quorum), the phase fails fast rather than waiting for all models to finish. This prevents wasted time when the council cannot produce enough valid drafts to vote on.',
      'Structured Retry Policy: Council draft validation uses the ticket\'s configured Structured Output Retries count. Retry prompts run in fresh sessions by design so each council response stays isolated, while rejected and accepted attempts remain visible in Raw diagnostics.',
      'Artifact Persistence: Each completed draft is persisted as a council artifact, stored alongside the model identity and draft metadata. Invalid, failed, or timed-out outputs persist diagnostics and raw attempt history only; malformed text is kept out of the structured artifact body and remains available from Raw.',
    ],
    outputs: [
      'A set of competing interview drafts — one from each council member — each with its own question set, ordering, and strategic rationale.',
      'Per-model draft progress and selected session milestones viewable in the phase log panel; completed drafts are preserved as artifacts for exact review.',
      'Persisted council draft artifacts that will be anonymized and presented to voters in the next phase, plus raw attempt diagnostics for rejected retries.',
    ],
    transitions: [
      'Quorum Met → Voting on Questions: When enough valid drafts are complete (meeting the configured quorum threshold), the workflow advances to the voting phase where the council scores each draft.',
      'Quorum Failure → Blocked Error: If too many models fail, produce invalid output, or time out — leaving fewer valid drafts than the quorum requires — the ticket routes to Blocked Error for manual retry.',
      'Cancel → Canceled: User cancellation during this phase stops all active model sessions and moves the ticket to Canceled.',
    ],
    notes: [
      'This is the first multi-model phase in the workflow — all phases before this used only the single main implementer.',
      'Council member independence is enforced: no model can see another\'s draft during this phase.',
      'Rejected or uncorrectable model output is diagnostic-only in artifacts: the structured view shows outcome, model, validation error, retry count, and excerpts, while the full malformed response stays in Raw and execution logs.',
      'Context available: Relevant Files + Ticket Details, with focused read-only repository inspection available only when necessary to confirm a discoverable technical fact. The council does not yet have interview answers, PRD, or beads — it is creating the interview that will gather those answers.',
      'Why multiple drafts? A single model might focus narrowly on one aspect of the ticket. By having multiple models independently draft interview approaches, the system captures a wider range of relevant questions and perspectives.',
    ],
    equivalents: [
      'This is the "multi-model drafting" step of the Interview phase. The same pattern repeats in the Specs (PRD) phase as "Council Drafting Specs" (where council members independently write competing PRD documents from the approved interview) and in the Blueprint (Beads) phase as "Council Drafting Blueprint" (where council members independently propose competing task decompositions from the approved PRD).',
      'All three drafting phases share the same mechanics: parallel independent generation → quorum check → advance to voting. The difference is what is being drafted (interview questions vs. specification document vs. implementation plan) and what context each council member receives.',
    ],
  },
  COUNCIL_VOTING_INTERVIEW: {
    overview: 'The council scores the interview drafts against a structured voting rubric and selects the strongest candidate to become the canonical interview basis. Each member scores all drafts — not just their own — and the drafts are anonymized so models cannot identify or favor their own output. This ensures the selection is based purely on quality, not authorship bias.',
    steps: [
      'Draft Anonymization: LoopTroop strips authorship information from the available interview drafts and assigns neutral identifiers (e.g., Draft A, Draft B, Draft C). This prevents models from recognizing and self-voting for their own output.',
      'Randomized Presentation Order: The order in which drafts are presented to each voter is randomized to control for position bias — the tendency to favor drafts that appear first or last in a list.',
      'Independent Scoring: Each council member receives all anonymized drafts plus the scoring rubric and evaluates every draft independently. Scores are submitted as structured vote payloads with rubric scores, rankings, and written justifications.',
      'Structured Retry Policy: Malformed vote payloads use the ticket\'s configured Structured Output Retries count. Retry prompts run in fresh sessions by design, preserving rejected/accepted Raw attempts without continuing a voter\'s prior transcript.',
      'Rubric Categories: The voting rubric typically evaluates drafts on question relevance (do the questions target the right implementation concerns?), coverage breadth (are all important areas addressed?), question clarity (are questions unambiguous?), and actionability (will the answers actually help write better specs?).',
      'Vote Resolution: The vote resolver totals the rubric scores across all members, handles ties according to the configured tie-breaking rules, and identifies the single winning draft that will be refined into the canonical interview.',
      'Audit Trail: LoopTroop records presentation order, individual vote payloads, per-model scoring breakdowns, quorum state, and final outcome metadata. This full audit trail is preserved so you can later inspect exactly how and why a particular draft was selected.',
    ],
    outputs: [
      'Voting artifacts with per-model rubric scores, rankings, and written justifications for each draft.',
      'A resolved winning interview draft reference — the draft that scored highest overall.',
      'Complete audit data showing how the council arrived at the selection, including score spread, presentation order, and tie-breaking decisions (if any).',
    ],
    transitions: [
      'Winner Selected → Refining Interview: A successful winner selection advances the workflow to the refinement phase where the winning draft is normalized into the interactive interview format.',
      'Voting Failure → Blocked Error: Invalid vote structure, malformed model responses, quorum collapse (not enough valid votes), or unresolvable ties route the ticket to Blocked Error.',
    ],
    notes: [
      'Anonymization and randomized ordering are both designed to reduce bias — models cannot identify their own draft and cannot benefit from a favorable presentation position.',
      'Context available: Relevant Files + Ticket Details + Competing Drafts (all anonymized).',
      'Previous draft artifacts shown during voting use the accepted validated draft as their Raw view; original raw model text remains scoped to the drafting phase diagnostics and logs.',
      'The voting rubric is consistent across all council members to ensure scores are comparable.',
      'Why vote instead of just picking one? Voting aggregates multiple perspectives on quality. A draft that impresses all council members is more likely to be genuinely strong than one that a single model happened to prefer.',
    ],
    equivalents: [
      'This is the "council voting" step of the Interview phase. The same pattern repeats in the Specs (PRD) phase as "Voting on Specs" (where the council scores competing PRD drafts using a PRD-specific rubric) and in the Blueprint (Beads) phase as "Voting on Blueprint" (where the council scores competing beads blueprints using an architecture rubric).',
      'All three voting phases share the same mechanics: anonymization → randomized presentation → independent scoring → vote resolution → winner selection. The difference is the scoring rubric used: interview voting evaluates question relevance and coverage; PRD voting evaluates requirement completeness and acceptance criteria quality; beads voting evaluates decomposition quality and dependency correctness.',
    ],
  },
  COMPILING_INTERVIEW: {
    overview: 'LoopTroop turns the winning interview draft into the normalized, interactive interview session that you will actually answer. This is a single-model phase using the winning model from the vote. The refinement step standardizes question formats, sets up batch state tracking, and produces the UI-ready interview artifact that the interview screen renders.',
    steps: [
      'Winning Draft Ingestion: The winning interview draft (selected by council vote) is loaded along with its question set, ordering rationale, and any strategic notes the winning model included.',
      'Question Normalization: LoopTroop normalizes all questions into a standardized format — each question gets a unique identifier, a question type (free-text, single-choice, multi-choice), display text, optional context/hints, and ordering metadata. When needed to confirm a discoverable repository fact, the refiner may inspect the smallest relevant area read-only. This ensures the interview UI can render any question regardless of how the original model formatted it.',
      'Structured Retry Policy: If the winning draft cannot be normalized into the required interactive schema, the configured structured retry count applies. Retry prompts run in fresh sessions by design for council refinement, and Raw diagnostics preserve the rejected outputs.',
      'Session Snapshot Creation: LoopTroop builds the interview session snapshot, which tracks batch state (which questions are in the current batch vs. future batches), completion bookkeeping (answered, skipped, pending), question ordering, and overall session progress.',
      'Artifact Writing: The canonical interview YAML is written into the ticket workspace. This becomes the authoritative interview artifact that downstream phases (coverage check, approval, PRD drafting) reference.',
      'UI Companion Artifacts: Additional UI-friendly companion artifacts are generated so the interview screen can render structured questions with proper input controls — text areas for free-text questions, radio buttons or checkboxes for choice-based questions, and skip/unskip toggles for each item.',
    ],
    outputs: [
      'Canonical interview artifact (YAML) in the ticket workspace — the authoritative record of all interview questions.',
      'Interview session snapshot with batch state, question ordering, and completion tracking.',
      'Normalized question set with proper types, identifiers, and display metadata ready for the interview UI.',
      'UI companion artifacts enabling structured question rendering with appropriate input controls.',
    ],
    transitions: [
      'Success → Interviewing: Once the interview session is fully built and persisted, the workflow moves to the Interviewing phase where you can start answering questions.',
      'Failure → Blocked Error: Normalization errors, YAML writing failures, or session snapshot creation problems route the ticket to Blocked Error.',
    ],
    notes: [
      'This phase produces the first user-facing interactive artifact in the planning flow — everything before this was AI-only work.',
      'The refinement is done by the winning model (from the vote), not the main implementer or all council members.',
      'Earlier draft artifacts inspected here show the validated draft content that refinement consumed in Raw, not the original drafting model response.',
      'Context available: Relevant Files + Ticket Details + Competing Drafts (used for reference during normalization), plus focused read-only repository inspection only when needed to confirm a discoverable technical fact.',
      'The session snapshot is designed to support multiple interview rounds — if coverage later adds follow-up questions, the same snapshot structure accommodates them.',
    ],
    equivalents: [
      'This is the "refinement" step of the Interview phase. The same pattern repeats in the Specs (PRD) phase as "Refining Specs" (where the winning PRD draft is enhanced with ideas from losing drafts) and in the Blueprint (Beads) phase as "Refining Blueprint" (where the winning blueprint is enhanced with ideas from losing blueprints).',
      'All three use the winning model to consolidate the best output. The interview phase calls it "compiling" because it normalizes the draft into an interactive format; the PRD and beads phases call it "refining" because they merge improvements from losing drafts into the winner. The underlying principle is the same: take the best candidate and make it stronger.',
    ],
  },
  WAITING_INTERVIEW_ANSWERS: {
    overview: 'LoopTroop pauses the workflow and presents an interactive interview for you to answer. This is a user-input phase until you submit or skip the current question batch. Draft answers and skip decisions autosave while you work, with a visible status showing when the server last acknowledged a save. Your answers directly shape the PRD that will be generated later, so this is your primary opportunity to guide the implementation direction. Submitting a non-final batch can keep the ticket in this same phase with the next batch, and coverage can also return here later with targeted follow-up questions.',
    steps: [
      'Question Presentation: The workspace presents the current interview batch with all pending questions. Each question shows its type (free-text or choice-based), any context/hints provided by the AI, and whether it has been previously answered or skipped.',
      'Answering Questions And Autosave: You can answer questions in any order. Free-text questions accept open-ended responses; choice-based questions present the available options. Draft changes autosave while you work, and the visible Autosave on indicator reports pending, saving, saved, conflict, or failure state plus the last server-acknowledged save time.',
      'Skipping Questions: If a question is not relevant or you don\'t have the information, you can skip it. Skipped questions are tracked separately — during PRD drafting, the AI will attempt to fill in reasonable answers for skipped questions based on the ticket context. You can also unskip a previously skipped question to answer it after all.',
      'Batch Submission: When you submit the current batch, LoopTroop normalizes your answers and skip decisions into the canonical interview state. This persists your responses into the interview session snapshot and updates the interview YAML artifact. If a checkable repository fact affects the next batch or follow-up, the interview model may inspect only the relevant repository area read-only; it still asks you for preferences, scope, priorities, desired behavior, and acceptance decisions. If the interview session has another batch ready, the ticket stays in this phase with the new questions; when the interview is complete, it advances to coverage.',
      'Follow-Up Rounds: After the interview is complete, coverage may determine that more information is needed and return here with a new targeted batch of follow-up questions. These follow-ups are generated based on gaps in your previous answers, not by repeating the same questions.',
      'Skip All: You can skip all remaining unanswered questions at once. This finalizes the current answers, marks all remaining questions as skipped, and advances the workflow directly to interview approval — bypassing the real coverage evaluation. Skipped questions will be answered by AI models at the beginning of the PRD phase. A synthetic clean coverage record is written under the VERIFYING_INTERVIEW_COVERAGE phase label so audit history remains complete.',
    ],
    outputs: [
      'Recorded user answers and skip decisions persisted into the interview session snapshot.',
      'Updated canonical interview YAML artifact reflecting the current state of all questions.',
      'Question history grouped across initial and follow-up rounds, preserving the full interaction timeline.',
    ],
    transitions: [
      'Submit/Skip → Interviewing: Submitting or skipping a non-final batch keeps the workflow in this phase and presents the next batch.',
      'Complete Batch → Coverage Check (Interview): When the submitted batch completes the interview, the workflow advances to the interview coverage check, which evaluates whether enough information has been gathered.',
      'Coverage Follow-Up → Back Here: If coverage identifies gaps, the workflow returns to this phase with additional targeted follow-up questions for you to answer.',
      'Skip All → Approving Interview (Direct): Finalizes all remaining unanswered questions as skipped (to be answered by AI models at the beginning of the PRD phase), then advances directly to interview approval — bypassing the real coverage evaluation. A synthetic clean coverage artifact is written for audit continuity.',
    ],
    notes: [
      'This is primarily a user-input phase — the workflow is intentionally paused while you answer questions. AI processing resumes only after submission to prepare the next batch or complete the interview.',
      'This phase may repeat during initial interview batching and later during coverage-generated follow-up rounds.',
      'AI context available: Ticket Details only. The compiled question set, answered/skipped/pending state, and configured question limits are appended explicitly by the interview session logic when needed. Focused read-only inspection is available only to confirm repository facts relevant to the next batch or follow-up, never to replace stakeholder decisions.',
      'Tip: Detailed, specific answers lead to better PRDs. If you\'re unsure about a question, it\'s better to answer with your best understanding and note any uncertainty than to skip it entirely.',
      'Tip: Skipping is fine for truly irrelevant questions — the AI will fill in reasonable defaults during PRD drafting. But skipping core architecture or business logic questions may result in a PRD that needs more manual editing later.',
    ],
  },
  VERIFYING_INTERVIEW_COVERAGE: {
    overview: 'The interview winner re-checks the ticket description and all recorded answers against the current interview results to decide whether enough information has been gathered, or if follow-up questions are still needed. This is a budgeted loop — LoopTroop tracks how many follow-up rounds have been used and will not exceed the configured maximum, ensuring the interview process eventually converges rather than looping indefinitely.',
    steps: [
      'Context Assembly: LoopTroop loads the canonical interview artifact, the ticket description, and a normalized answer summary. This gives the coverage model the full picture: what was asked, what was answered, what was skipped, and what the ticket is trying to accomplish.',
      'Coverage Evaluation: The winning interview model analyzes the collected answers against the ticket requirements and returns a structured coverage result. It may inspect the smallest relevant repository area read-only to confirm a discoverable technical fact, but it must not infer stakeholder intent from existing code. The result is either "clean" (all needed information has been collected) or "gaps found" (specific areas need more clarification).',
      'Gap Analysis (if gaps found): When gaps are identified, the model specifies exactly what information is missing and why it matters for downstream PRD generation. Each gap includes a description, the reason it is important, and a suggested follow-up question.',
      'Follow-Up Generation (if budget allows): If gaps remain and the follow-up budget has not been exhausted, LoopTroop generates targeted follow-up questions based on the identified gaps. These questions are added to the session snapshot as a new interview batch and the workflow returns to the Interviewing phase.',
      'Budget Enforcement: The follow-up budget tracks how many rounds of follow-up questions have been generated. Once the budget is exhausted, coverage will finalize the interview regardless of remaining gaps — the PRD phase will work with whatever information is available.',
      'Clean Finalization: If the interview is clean (no gaps or all gaps are minor), LoopTroop refreshes the canonical interview artifact with the finalized clean status and stores the coverage result for audit and UI review.',
      'Coverage History: Every coverage attempt (whether clean or gap-found) is persisted as a coverage history artifact, capturing the response, parsed result, follow-up budget usage, any artifact processing notices such as parser repairs or structured retries, and timestamps.',
    ],
    outputs: [
      'Interview coverage artifact describing whether the interview is clean or has remaining gaps, with detailed gap descriptions if applicable.',
      'Potentially new targeted follow-up questions added to the interview session (if gaps found and budget allows).',
      'Refreshed canonical interview artifact when the interview is finalized as clean.',
      'Coverage history with per-attempt details, follow-up budget tracking, and structural diagnostics.',
    ],
    transitions: [
      'Gaps + Budget Available → Interviewing: If follow-up questions are needed and the budget allows, the workflow returns to the Interviewing phase (WAITING_INTERVIEW_ANSWERS) with a new batch of targeted questions.',
      'Clean → Approving Interview: If the interview is clean (no gaps or all gaps resolved), the workflow advances to the interview approval gate.',
      'Budget Exhausted → Approving Interview: If the follow-up budget is used up, the interview advances to approval regardless of remaining gaps — the PRD phase will compensate where possible.',
      'Failure → Blocked Error: Coverage execution failures, model errors, or structural repair failures route the ticket to Blocked Error.',
    ],
    notes: [
      'The coverage loop is budgeted — it cannot run indefinitely. The maximum number of follow-up rounds is configured per project.',
      'Coverage is performed by the winning interview model (from the vote), ensuring consistency with the original interview strategy.',
      'Context available: Ticket Details + User Answers + Interview Results, with focused read-only repository inspection available only when necessary to confirm a discoverable technical fact.',
      'Why budget the loop? Without a budget, a model could theoretically keep finding minor gaps and generating follow-up questions forever. The budget ensures the interview converges to a usable state within a reasonable number of rounds.',
    ],
    equivalents: [
      'This is the "coverage check" step of the Interview phase. The same pattern repeats in the Specs (PRD) phase as "Coverage Check (PRD)" (where the PRD is checked against the winning model\'s Full Answers artifact) and in the Blueprint (Beads) phase as "Coverage Check (Beads)" (where the beads blueprint is checked against the approved PRD).',
      'All three coverage checks share the goal of verifying completeness, but they differ in how gaps are resolved: Interview coverage sends you back to answer follow-up questions (user-facing loop). PRD coverage revises the document automatically within the same phase (AI-internal loop, up to the configured pass cap). Beads coverage also revises automatically within the Coverage Check (Beads) phase, and is then followed by a separate Expanding Blueprint phase that transforms the validated semantic blueprint into execution-ready bead records.',
      'Each coverage check has a budget or cap to ensure convergence — interview has a follow-up round budget, PRD has a configured pass cap, and beads has its own configured pass cap. Blueprint expansion happens in the dedicated Expanding Blueprint phase that follows.',
      'While this status is active, the workspace title shows the current coverage pass when it can be read from coverage artifacts or logs. That live progress text disappears once the ticket leaves this status.',
    ],
  },
  WAITING_INTERVIEW_APPROVAL: {
    overview: 'The interview is ready for human review and approval. This is a user-input gate — no AI work proceeds until you explicitly approve. You can inspect the full interview results (questions, answers, and skip decisions) and edit answers or raw YAML. Draft edits autosave with a visible last-save status, but they do not update the authoritative interview artifact until you explicitly Save. The approved interview becomes the authoritative source material that drives PRD generation.',
    steps: [
      'Review Interface: LoopTroop exposes the canonical interview in two modes — a structured view showing questions and answers in a readable format, and a raw YAML editing view for direct text manipulation. You can switch between these views freely.',
      'Editing Answers And Draft Autosave: You can adjust any answer text, change skip decisions, or modify the raw YAML directly. Draft changes autosave between view switches and reloads. The visible Draft autosave on indicator reports pending, saving, saved, conflict, or failure state plus the last server-acknowledged save time.',
      'Saving Changes: Draft autosave does not update the authoritative interview. Explicit Save writes the updated interview artifact back to the ticket workspace, records a user-edit receipt with old/new content hashes, and refreshes all relevant caches. If this is a post-approval edit while the ticket is still before PRE_FLIGHT_CHECK, saving archives the current approved interview version plus downstream PRD/beads planning attempts, intentionally cancels active downstream planning sessions, saves and approves the edited interview as the new active version, clears stale downstream artifacts and UI state, and starts DRAFTING_PRD.',
      'Approval Decision: Approving locks in the current interview results as the authoritative source material for PRD drafting. The approval request includes the SHA-256 hash of the bytes you reviewed; if the server artifact changed in the meantime, approval returns a stale-content 409 instead of advancing. Once approved, the interview answers become the ground truth that the PRD council uses to generate specifications.',
      'Post-Approval Editing Window: After approval, interview edits remain allowed only while the ticket is still before PRE_FLIGHT_CHECK. Once the ticket reaches pre-flight or later, interview edits are rejected because implementation planning has already been locked for execution.',
    ],
    outputs: [
      'Approved interview artifact — the finalized, authoritative version of interview questions and answers.',
      'User-edited replacement (if edits were made before approval).',
      'Optional persisted UI draft state for in-progress edits.',
      'Approval snapshot and approval receipt with `content_sha256`; interview receipts also record `stored_content_sha256` when approval metadata changes the stored YAML.',
      'Append-only `user_edit_receipt:interview` artifacts for manual saves.',
      'A locked interview baseline that the PRD council treats as ground truth.',
      'Archived approved interview versions and downstream PRD/beads planning attempts remain read-only history when a post-approval edit creates a new active version.',
    ],
    transitions: [
      'Approve → Council Drafting Specs: Approval advances the workflow to PRD drafting, where multiple council models independently generate specification documents based on your approved interview answers.',
      'Cancel → Canceled: Cancellation moves the ticket to the terminal Canceled state.',
    ],
    notes: [
      'This is the review artifact gate for the interview phase — it ensures a human has signed off before expensive PRD generation begins.',
      'The approval UI and API compare content hashes so stale tabs cannot approve an interview version that is no longer current.',
      'No AI context is passed in this phase — it is entirely user-driven. The AI does not see or process anything during approval.',
      'Tip: Review skipped questions carefully. Skipped questions will have AI-generated answers filled in during PRD drafting. If you have opinions about those topics, it is better to provide real answers now than to rely on AI guesses later.',
      'Tip: This is your last easy chance to influence the interview before it feeds into the PRD. Editing after approval is possible only before PRE_FLIGHT_CHECK, and saving intentionally cancels active downstream planning sessions as cancellation rather than blocked errors so DRAFTING_PRD restarts from the new approved interview.',
    ],
    equivalents: [
      'This is the "approval gate" of the Interview phase. The same pattern repeats in the Specs (PRD) phase as "Approving Specs" (where you review and approve the PRD before beads planning) and in the Blueprint (Beads) phase as "Approving Blueprint" (where you review and approve the execution plan before coding starts).',
      'All three approval gates share the same mechanics: human review → optional editing → explicit approval to advance. Each gate controls what feeds into the next major phase: approved interview → PRD drafting, approved PRD → beads drafting, approved beads → coding execution.',
      'Post-approval edits are planning-only. Interview and PRD edits are allowed only before PRE_FLIGHT_CHECK. Saving them archives the previous approved planning generation and affected downstream attempts, treats active downstream session aborts as intentional cancellation, saves and approves the edit, and restarts the next drafting phase.',
    ],
  },
  DRAFTING_PRD: {
    overview: 'The PRD council produces competing specification drafts from the approved interview, relevant files, and ticket context. This is a 2-part phase: Part 1 lets each council member create its own Full Answers artifact by filling any skipped interview answers, and Part 2 uses that member-specific complete answer set to generate a full PRD draft. Both parts can perform focused read-only repository inspection when the supplied relevant-files context cannot support a needed repository-specific technical fact. Each council member independently produces both its assumptions and its PRD — they do not collaborate or see each other\'s work.',
    steps: [
      'Part 1 — Answering Skipped Questions: LoopTroop loads the relevant files, ticket details, and interview results (including which questions were answered vs. skipped). For each skipped question, each council member generates a reasonable full answer based on the available context and may inspect the smallest relevant repository area read-only to confirm a needed technical fact. The result is a per-model "Full Answers" artifact where every question has a response — either the user\'s original answer or that model\'s AI-generated fill-in.',
      'Why Keep Per-Model Full Answers? The PRD council benefits from diverse assumptions when the user skipped uncertain areas. Keeping Full Answers per model lets voting evaluate each PRD draft together with the assumptions that produced it, instead of forcing all members through one canonical guess before drafting.',
      'Part 2 — Generating PRD Drafts: LoopTroop loads the relevant files, ticket details, and that member\'s Full Answers artifact (including AI-filled responses). Each council model independently produces a complete PRD candidate rather than editing a shared draft. When relevant files do not provide concrete evidence for a repository-specific command, path, framework, package manager, build system, or test runner, the model may inspect the smallest useful repository area with read-only tools before making that claim. This independence ensures diverse specification approaches.',
      'Part 2 Gating: If Part 1 does not produce a valid Full Answers artifact for a member, that member\'s PRD draft is not started. The PRD draft row is recorded as skipped/invalid with a concise diagnostic instead of copying Full Answers raw output or retry warnings into the PRD draft artifact.',
      'PRD Content Structure: Each draft follows a consistent structure containing requirements (what the system should do), acceptance criteria (how to verify it works), edge cases (unusual situations to handle), test intent (what should be tested and how), and implementation guidance (suggested approach and constraints).',
      'Output Normalization: LoopTroop normalizes draft output to ensure consistent structure, records draft metrics (requirement count, acceptance criteria count, edge case count), logs structured-output diagnostics, records raw accepted/rejected attempts, and persists only accepted draft bodies for the upcoming voting phase. Full Answers parsing can repair safe YAML scalar formatting around existing free_text answer text and restores approved interview metadata such as follow_up_rounds from the canonical Interview Results artifact; unrecoverable or invented structure still fails validation. Full Answers and PRD draft retry prompts use the configured structured retry count and run in fresh sessions by design.',
    ],
    outputs: [
      'Per-model Full Answers artifacts — complete interview documents with AI-generated responses filling in skipped questions where needed (produced in Part 1). The winning model\'s Full Answers artifact is later available read-only from Approving Specs.',
      'Competing PRD drafts — one from each council member — each containing requirements, acceptance criteria, edge cases, test intent, and implementation guidance.',
      'Draft metrics, raw attempt history, and structured-output diagnostics for each council member\'s output.',
    ],
    transitions: [
      'Quorum Met → Voting on Specs: When enough valid PRD drafts are ready (meeting the configured quorum threshold), the workflow advances to the PRD voting phase.',
      'Quorum Failure → Blocked Error: Draft generation failures, insufficient valid drafts for quorum, or council member timeouts route the ticket to Blocked Error.',
    ],
    notes: [
      'This phase has 2 internal parts with different context inputs: Part 1 receives Relevant Files + Ticket Details + Interview Results and may perform focused read-only inspection only to confirm a technical fact needed for a skipped answer; Part 2 receives Relevant Files + Ticket Details + Full Answers and may perform focused read-only inspection when its supplied context is insufficient for a repository-specific claim.',
      'Rejected or uncorrectable Full Answers and PRD draft text is not rendered as artifact body content. Safe parser repairs correct formatting only; malformed responses that would require inventing questions, metadata, or planning content remain diagnostic-only in Raw attempt views and execution logs.',
      'The PRD phase is the first stage that converts interview intent into a formal implementation specification — it bridges the gap between "what do you want" (interview) and "what should be built" (specification).',
      'Each council member drafts from its own Full Answers artifact, so the PRD vote selects both a specification approach and the assumptions behind it.',
    ],
    equivalents: [
      'This is the "multi-model drafting" step of the Specs (PRD) phase. The equivalent in the Interview phase is "Council Drafting Questions" (where council members independently draft competing interview questions) and in the Blueprint (Beads) phase is "Council Drafting Blueprint" (where council members independently propose competing task decompositions).',
      'Unlike the Interview drafting phase, PRD drafting has a 2-part structure: Part 1 fills in skipped interview answers first, then Part 2 generates actual PRD drafts from those completed answers. The Interview and Beads drafting phases are single-part.',
    ],
  },
  COUNCIL_VOTING_PRD: {
    overview: 'The council scores the PRD candidates against a weighted PRD rubric to choose the strongest specification baseline. Each member scores all drafts independently, and drafts are anonymized to prevent self-voting bias. The winning PRD becomes the starting point for refinement — it is not the final PRD, but the best foundation to build on.',
    steps: [
      'Draft Anonymization: LoopTroop strips authorship from the PRD drafts and assigns neutral identifiers. This prevents models from recognizing their own output and voting in their own favor.',
      'Randomized Presentation: Drafts are presented in a randomized order to each voter to control for position bias — the tendency to favor items that appear first or last.',
      'Independent Scoring: Each council member receives all anonymized PRD drafts plus the PRD scoring rubric and evaluates every draft independently. Votes include weighted rubric scores, draft rankings, and written justifications explaining their reasoning.',
      'Structured Retry Policy: Malformed PRD vote payloads use the ticket\'s configured Structured Output Retries count. Retry prompts run in fresh sessions by design and are recorded as Raw attempt diagnostics.',
      'PRD Rubric Categories: The rubric typically evaluates requirement completeness (are all needed requirements present?), acceptance criteria quality (are criteria specific and testable?), edge case coverage (are unusual scenarios addressed?), test intent clarity (is it clear what to test and how?), and structural coherence (is the document well-organized and internally consistent?).',
      'Vote Resolution: The vote resolver totals the weighted scores across all members, applying configured tie-breaking rules if needed, and selects the single winning PRD draft for refinement.',
      'Audit Persistence: Vote order, individual scoring payloads, per-model breakdowns, and final outcome metadata are all persisted for later review and transparency.',
    ],
    outputs: [
      'PRD vote artifacts with per-model rubric scores, rankings, and written justifications.',
      'A winning PRD draft reference — the draft that will be refined into the PRD Candidate v1.',
      'Full audit data showing the selected draft, score spread, presentation order, and any tie-breaking decisions.',
    ],
    transitions: [
      'Winner Selected → Refining Specs: A successful winner selection advances the workflow to refinement, where the winning draft is enhanced with the best ideas from the losing drafts.',
      'Voting Failure → Blocked Error: Malformed vote output, insufficient valid votes for quorum, or unresolvable errors route the ticket to Blocked Error.',
    ],
    notes: [
      'Context available: Relevant Files + Ticket Details + Interview Results + Competing Drafts (all anonymized).',
      'The winning draft is not the final PRD — it still goes through refinement and coverage checking before approval.',
      'Previous PRD draft artifacts shown during voting use the accepted validated draft as their Raw view; original raw/rejected drafting text remains available only from the drafting phase diagnostics.',
      'The voting rubric is weighted, meaning some categories (like requirement completeness) may count more than others (like structural coherence) in the final score.',
    ],
    equivalents: [
      'This is the "council voting" step of the Specs (PRD) phase. The equivalent in the Interview phase is "Voting on Questions" (where the council votes on competing interview drafts) and in the Blueprint (Beads) phase is "Voting on Blueprint" (where the council votes on competing beads blueprints).',
      'The PRD voting rubric differs from the other two: it is weighted and focuses on requirement completeness, acceptance criteria quality, edge case coverage, test intent clarity, and structural coherence. Interview voting focuses on question relevance and coverage breadth. Beads voting focuses on decomposition quality, feasibility, and dependency correctness.',
    ],
  },
  REFINING_PRD: {
    overview: 'The winning PRD draft is upgraded into PRD Candidate v1 by selectively pulling in useful improvements from the losing drafts — additional requirements, stronger acceptance criteria, edge cases, or test scenarios that the winner missed. The winning model performs this refinement, preserving its own structure while incorporating the best elements from competitors. It can use focused read-only repository inspection when the supplied context does not substantiate a repository-specific claim it needs to retain or adopt.',
    steps: [
      'Context Assembly: LoopTroop gives the winning model its own winning draft plus all the losing drafts, clearly labeled. The prompt instructs it to keep the winning draft\'s structure and core content intact while selectively merging stronger elements from the losers. It reviews relevant files first and may use focused read-only inspection only when concrete repository evidence is missing.',
      'Selective Merging: The model reviews each losing draft for requirements, acceptance criteria, edge cases, or test scenarios that are present in the losing draft but absent from the winner. It incorporates these improvements without duplicating existing content or breaking the winning draft\'s organizational structure.',
      'Output Validation: The refinement output is normalized and validated as a proper PRD document — checking for consistent structure, non-empty requirement sections, valid acceptance criteria format, and overall document integrity. Automatic structured retries use the ticket\'s configured count, run in fresh sessions by design for council refinement, and are preserved as Raw attempt variants; only the accepted normalized PRD becomes canonical downstream context.',
      'Diff Metadata: LoopTroop optionally generates refinement diff metadata that describes what changed between the original winning draft and the refined candidate. This helps you understand what was added during refinement when you review the PRD later.',
      'Candidate Promotion: The resulting document becomes PRD Candidate v1 — the first versioned candidate that enters the coverage verification loop. This is not yet the final PRD; coverage may produce additional versions before approval until the configured cap is reached.',
    ],
    outputs: [
      'Refined PRD candidate artifact (PRD Candidate v1) — the winning draft enhanced with the best elements from losing drafts.',
      'Optional refinement diff metadata showing what was added or changed during the refinement process.',
      'Normalized PRD content ready for the coverage verification loop, with rejected refinement model text kept diagnostic-only in Raw attempts.',
    ],
    transitions: [
      'Success → Coverage Check (PRD): A valid refined candidate advances to the PRD coverage check, which verifies the PRD against the winning model\'s Full Answers artifact.',
      'Failure → Blocked Error: Refinement validation failures, malformed output, or model errors route the ticket to Blocked Error.',
    ],
    notes: [
      'The refinement is done by the winning model (from the vote), ensuring the refiner understands the winning approach and can merge additions coherently.',
      'Context available: Relevant Files + Ticket Details + Full Answers + Competing Drafts (the winner is labeled, losers are provided for mining improvements). Focused read-only repository inspection is available only when that context is insufficient for a concrete repository-specific claim.',
      'Competing draft artifacts reviewed here show their validated canonical draft in Raw, matching the content the refinement prompt used. Refinement model retries keep their own Raw attempt diagnostics separately.',
      'PRD Candidate v1 is a versioned identifier — coverage may produce later versions if gaps are found and revisions are needed.',
      'Why refine? The winning draft scored highest overall, but losing drafts often contain individual insights that the winner lacks. Refinement captures those insights without losing the winning structure.',
    ],
    equivalents: [
      'This is the "refinement" step of the Specs (PRD) phase. The equivalent in the Interview phase is "Refining Interview" (where the winning interview draft is compiled into the interactive format) and in the Blueprint (Beads) phase is "Refining Blueprint" (where the winning blueprint is enhanced with ideas from losing blueprints).',
      'PRD and Beads refinement are very similar — both merge improvements from losing drafts into the winner. Interview compilation differs slightly because it also transforms the format (from a raw draft into a normalized, interactive session structure), but the core idea is the same: take the winning output and strengthen it.',
    ],
  },
  VERIFYING_PRD_COVERAGE: {
    overview: 'LoopTroop runs a versioned PRD coverage loop, comparing the current PRD candidate against the winning model\'s Full Answers artifact to find any missing requirements or gaps. Unlike the interview coverage loop (which sends you back to answer more questions), PRD coverage stays inside this same phase — the model revises the PRD directly when gaps are found. The audit and revision prompts can use focused read-only repository inspection when supplied context does not substantiate a repository-specific claim. Revision metadata is normalized only when it preserves existing text; path/summary-only change notes stay diagnostic while the validated PRD versions provide the visible diff. The loop can produce later PRD candidate versions until the configured cap is reached, and if gaps remain after that, the latest version still advances to approval with warnings.',
    steps: [
      'Coverage Evaluation: The winning PRD model compares the current PRD candidate against that model\'s Full Answers artifact. It returns a structured coverage result: either "clean" (the PRD fully covers the canonical completed answers) or "gaps found" (specific requirements or acceptance criteria are missing or incomplete). When deciding a repository-specific assertion needs confirmation, it may inspect the smallest useful set of repository files with read-only tools.',
      'Gap Details: When gaps are found, the coverage result includes specific descriptions of what is missing, which completed answers are not reflected in the PRD, unresolved source-artifact contradictions when present, and why the gap matters for implementation correctness.',
      'In-Phase Revision: If gaps are found and the coverage cap has not been reached, LoopTroop asks the model to produce a revised PRD that addresses the identified gaps. Before adding or changing a repository-specific command, path, framework, package manager, build system, or test runner, the model confirms it from supplied or focused read-only repository evidence. The revised candidate is validated and promoted to the next version number (for example v1 → v2) within the same phase.',
      'Safe Change Metadata: Revision outputs may include structured change metadata. LoopTroop accepts harmless key aliases such as `change_type`, but it only keeps change records that contain real semantic before/after item records; path and summary-only notes are dropped as diagnostics so missing item text is never invented.',
      'Version History: Coverage attempts and version transitions are persisted, so you can see what changed between PRD versions and why. Each attempt records the coverage result, identified gaps, revision actions, parser/repair notices, and the resulting candidate version. If validated semantic change records are empty, the approval UI falls back to a structural diff between the validated PRD versions.',
      'Clean Finalization: If the PRD becomes clean (all gaps resolved), the clean result is recorded and the current candidate becomes the approval candidate with a clean status.',
      'Cap Enforcement: If the configured PRD coverage cap is reached, LoopTroop advances using the latest candidate even if minor gaps remain. The unresolved-gap history is preserved and visible during approval so you can address any remaining issues manually.',
    ],
    outputs: [
      'Versioned PRD coverage attempts and transition history — showing the journey from Candidate v1 through any revisions, including safe parser repair notices when model change metadata needed normalization.',
      'Latest PRD candidate after zero or more coverage revisions.',
      'Structured diagnostics about artifact processing notices, identified gaps, and whether they were resolved.',
    ],
    transitions: [
      'Clean → Approving Specs: A clean candidate (no remaining gaps) advances to the PRD approval gate.',
      'Cap Reached → Approving Specs: If the coverage cap is hit, the latest candidate advances to approval with warnings about unresolved gaps preserved for your review.',
      'Failure → Blocked Error: Coverage execution failures, model errors, or revision validation problems route the ticket to Blocked Error.',
    ],
    notes: [
      'Unlike the interview loop (which bounces back to the user for more answers), PRD gap resolution stays inside this same phase — the model revises the PRD directly.',
      'The maximum number of coverage versions is configuration-driven to ensure convergence without hard-coding a single limit for every project.',
      'While this status is active, the workspace title shows the PRD candidate version being checked and the current coverage pass when those values are available. That live progress text disappears once the ticket leaves this status.',
      'Change metadata repairs are text-preserving only. If a model provides section paths or summaries without concrete before/after item records, LoopTroop records a warning and derives the review diff from the validated PRD documents instead.',
      'Context available: winning model Full Answers + PRD (current candidate version). The approved interview is not fed to this phase; the winner Full Answers artifact is the canonical coverage source. Focused read-only inspection is available only when that context is insufficient for a repository-specific assertion.',
      'Why cap the loop? Diminishing returns: most meaningful gaps are caught in early revisions. The cap prevents the loop from endlessly polishing minor details while delaying your approval review.',
    ],
    equivalents: [
      'This is the "coverage check" step of the Specs (PRD) phase. The equivalent in the Interview phase is "Coverage Check (Interview)" (where the interview is checked for missing information) and in the Blueprint (Beads) phase is "Coverage Check (Beads)" (where the beads blueprint is checked against the approved PRD).',
      'Key difference from Interview coverage: PRD coverage resolves gaps automatically (the model revises the PRD within this same phase) rather than sending you back for more user input. Key difference from Beads coverage: Beads coverage is followed by a dedicated Expanding Blueprint phase that transforms the validated semantic blueprint into execution-ready bead records with commands, file targets, and dependency graphs — PRD coverage has no equivalent expansion phase.',
      'What is being verified against what: Interview coverage checks interview answers against the ticket description. PRD coverage checks the PRD against the winning model\'s Full Answers artifact. Beads coverage checks the beads blueprint against the approved PRD.',
    ],
  },
  WAITING_PRD_APPROVAL: {
    overview: 'The latest PRD candidate is ready for human review and approval before architecture planning starts. This is a user-input gate: the workflow will not proceed to beads planning until you explicitly approve. You can review the specification in structured or raw form, edit any section, inspect the winning model\'s read-only Full Answers artifact from Part 1 of PRD drafting, and check whether coverage warnings exist from the coverage loop. Draft edits autosave with a visible last-save status, but they do not update the authoritative PRD until you explicitly Save. When unresolved gaps remain, you can optionally ask AI for one targeted extra fix at a time before deciding whether to approve. The approved PRD becomes the authoritative input that drives beads (implementation task) planning.',
    steps: [
      'Review Interface: LoopTroop renders the PRD in two modes — a structured view showing requirements, acceptance criteria, edge cases, and test intent in a readable format, and a raw YAML editing view for direct manipulation. You can switch freely between views.',
      'Full Answers Context: If the winning PRD model produced a Full Answers artifact during Part 1 of PRD drafting, the approval header shows a compact Full Answers chip. Opening it displays the complete read-only interview answer set that the winning PRD draft used, including user answers and any AI-filled skipped answers. This artifact is supporting context only; edits are made to the PRD itself.',
      'Coverage Warnings And Extra Fixes: If the latest PRD candidate reached approval after exhausting the coverage loop cap (rather than achieving a fully clean status), coverage warnings are displayed prominently. These warnings describe unresolved gaps, including unresolved source-artifact contradictions when present. You can edit manually, approve with gaps, or click Fix gaps with AI to run one fresh targeted PRD revision followed by one fresh coverage check.',
      'Editing And Draft Autosave: You can edit any section of the PRD — add requirements, refine acceptance criteria, adjust edge cases, or rewrite test intent. Draft changes autosave between view switches and reloads. The visible Draft autosave on indicator reports pending, saving, saved, conflict, or failure state plus the last server-acknowledged save time. Draft autosave does not update the authoritative PRD; explicit Save applies the draft, records a user-edit receipt with old/new content hashes, and refreshes the artifact. If this is a post-approval edit while the ticket is still before PRE_FLIGHT_CHECK, saving archives the current approved PRD version plus downstream beads planning attempts, intentionally cancels active downstream planning sessions, saves and approves the edited PRD as the new active version, clears stale downstream artifacts and UI state, and starts DRAFTING_BEADS.',
      'Approval Decision: Approving confirms the current PRD as the authoritative specification for beads drafting. If unresolved coverage warnings remain, the button text makes that explicit as Approve with gaps. The request includes the SHA-256 hash of the reviewed PRD bytes; stale hashes return 409 and leave approval paused. The beads council will decompose this approved PRD into implementable tasks.',
      'Extra-Fix Refresh: Each Fix gaps with AI click reloads the latest PRD candidate, latest coverage warning, and winning Full Answers artifact on the server before prompting the model. If the PRD changes, the artifact and coverage history are updated; if no gaps remain afterward, the warning disappears without auto-approving.',
      'Post-Approval Editing Window: After approval, PRD edits remain allowed only while the ticket is still before PRE_FLIGHT_CHECK. Once the ticket reaches pre-flight or later, PRD edits are rejected because the implementation plan has already been accepted for execution.',
    ],
    outputs: [
      'Approved PRD artifact — the finalized, authoritative specification for the implementation.',
      'User-edited replacement (if edits were made before approval).',
      'Optional UI draft state for in-progress structured and raw edits.',
      'Read-only winning Full Answers artifact available as approval context when PRD drafting produced one.',
      'Optional extra-fix coverage history entries labeled `Extra Fix N` when unresolved coverage gaps were addressed from the approval warning.',
      'Approval snapshot and approval receipt with `content_sha256`; PRD receipts also record `stored_content_sha256` when approval metadata changes the stored YAML.',
      'Append-only `user_edit_receipt:prd` artifacts for manual saves.',
      'A locked PRD baseline that the beads council uses as its primary input.',
      'Archived approved PRD versions and downstream beads planning attempts remain read-only history when a post-approval edit creates a new active version.',
    ],
    transitions: [
      'Approve → Council Drafting Blueprint: Approval advances the workflow to the beads drafting phase, where multiple council models independently decompose the PRD into implementable task blueprints.',
      'Cancel → Canceled: Cancellation moves the ticket to the terminal Canceled state.',
    ],
    notes: [
      'This is the review artifact gate for the PRD phase — it ensures a human has signed off on the specification before expensive architecture planning begins.',
      'The approval UI and API compare content hashes so stale tabs cannot approve a PRD version that is no longer current.',
      'No automatic AI work runs just because this approval gate is open. AI sees approval-phase context only when you explicitly click Fix gaps with AI, and that prompt is scoped to the current PRD, the winning Full Answers artifact, the remaining coverage gaps, and previous extra-fix history.',
      'The Full Answers chip does not create another editable approval artifact. It shows the winning model\'s Part 1 context so you can understand which completed interview answers shaped the PRD.',
      'Tip: Pay special attention to acceptance criteria — they directly determine how the AI will verify its own implementation during the coding phase.',
      'Tip: If coverage warnings exist, read the unresolved gaps carefully. Minor gaps may be acceptable, but gaps in core requirements could lead to an incomplete implementation.',
      'Tip: Editing the PRD after beads planning starts intentionally cancels and archives downstream beads planning. Active downstream session aborts are cancellation, not blocked errors; archived attempts remain inspectable, while DRAFTING_BEADS restarts from the edited approved PRD.',
    ],
    equivalents: [
      'This is the "approval gate" of the Specs (PRD) phase. The equivalent in the Interview phase is "Approving Interview" (where you review and approve the interview results before PRD drafting) and in the Blueprint (Beads) phase is "Approving Blueprint" (where you review and approve the execution plan before coding starts).',
      'All three approval gates serve as quality checkpoints between major pipeline stages. This one sits between interview → PRD (upstream) and PRD → beads (downstream). Approving here locks the PRD as authoritative input for beads planning, just as approving the interview locks it for PRD drafting.',
    ],
  },
  DRAFTING_BEADS: {
    overview: 'The beads council decomposes the approved PRD into implementable tasks — called "beads" — that the coding agent will later execute one by one. Each council member independently proposes a semantic beads blueprint: a task-level breakdown with descriptions, acceptance criteria, dependencies, and test intent. The blueprints at this stage are still "semantic" (describing what to do) rather than "execution-ready" (containing exact commands and file paths). When concrete repository evidence is needed, members can inspect the smallest useful repository area with read-only tools.',
    steps: [
      'Context Loading: LoopTroop loads the approved PRD, ticket details, and relevant-files context into the beads drafting prompt. This gives each council member the full picture: what needs to be built (PRD), why (ticket), and what code already exists (relevant files). Members review this context first and use focused read-only inspection only when it cannot support a concrete repository-specific claim.',
      'Independent Blueprint Drafting: Each council member independently proposes a semantic beads blueprint. A blueprint contains individual bead definitions, each with a description of what the bead should accomplish, acceptance criteria for verifying completion, dependency declarations (which beads must complete before this one can start), and test intent (what tests should verify this bead\'s work).',
      'Task Decomposition Strategy: Models decide how to split the PRD into beads — balancing granularity (each bead should be a meaningful unit of work) against dependency complexity (too many fine-grained beads create complex dependency chains). Different council members may propose very different decomposition strategies.',
      'Validation & Metrics: Draft output is normalized, validated against the expected schema (proper bead structure, valid dependency references, non-empty fields), and stored as council draft artifacts. Draft metrics capture task counts, structure depth, and dependency graph complexity for each blueprint. Invalid, failed, or timed-out blueprint bodies are suppressed from structured artifact views and preserved only as raw attempts/log diagnostics. Beads draft retry prompts use the configured structured retry count and run in fresh sessions by design.',
    ],
    outputs: [
      'Competing beads blueprint drafts — one from each council member — each proposing a different task decomposition strategy.',
      'Draft metrics for task counts, dependency graph complexity, and structural analysis.',
      'Council artifacts persisted for the upcoming voting phase, with rejected raw attempts retained separately from accepted blueprint bodies.',
    ],
    transitions: [
      'Quorum Met → Voting on Blueprint: When enough valid blueprints are complete (meeting quorum), the workflow advances to the beads voting phase.',
      'Quorum Failure → Blocked Error: Drafting failures, insufficient valid blueprints for quorum, or model timeouts route the ticket to Blocked Error.',
    ],
    notes: [
      'Context available: Relevant Files + Ticket Details + PRD. Focused read-only repository inspection is available only when this context is insufficient for a concrete repository-specific claim.',
      'Blueprints at this stage pair semantic tasks and human-readable tests with only the planned bead commands that are genuinely useful. A bead may carry an explicit reason instead of an automated command; exact file targets and dependency metadata are added during expansion.',
      'Rejected or uncorrectable blueprint output is diagnostic-only in artifacts; the structured tab does not render malformed blueprint text as if it were a usable draft.',
      'Why independent drafting? Different models may identify different natural task boundaries. Voting on competing blueprints helps select the most logical and implementable decomposition.',
    ],
    equivalents: [
      'This is the "multi-model drafting" step of the Blueprint (Beads) phase. The equivalent in the Interview phase is "Council Drafting Questions" (where council members draft competing interview questions) and in the Specs (PRD) phase is "Council Drafting Specs" (where council members draft competing PRD documents).',
      'Unlike PRD drafting (which has a 2-part structure with skipped-answer filling), beads drafting is a single-part phase. The output is also fundamentally different: instead of a document (interview questions or specification), each council member produces a task decomposition graph with dependencies — making this the most architecturally complex drafting phase.',
    ],
  },
  COUNCIL_VOTING_BEADS: {
    overview: 'The council ranks the competing beads blueprints to pick the most credible implementation plan. Each member scores all blueprints independently against an architecture rubric that evaluates decomposition quality, feasibility, dependency correctness, and testability. The winning blueprint becomes the foundation for refinement.',
    steps: [
      'Blueprint Anonymization: LoopTroop anonymizes the beads blueprints and assigns neutral identifiers to prevent self-voting bias.',
      'Randomized Presentation: Blueprints are presented in randomized order to each voter to control for position bias.',
      'Independent Scoring: Each council member evaluates every blueprint independently using the architecture rubric. Scores cover decomposition quality (are the tasks logically divided?), feasibility (can each bead actually be implemented independently?), dependency correctness (are dependencies properly declared and acyclic?), and testability (can each bead\'s completion be meaningfully verified?).',
      'Structured Retry Policy: Malformed beads vote payloads use the ticket\'s configured Structured Output Retries count. Retry prompts run in fresh sessions by design and are recorded as Raw attempt diagnostics.',
      'Vote Resolution: The vote resolver totals the rubric scores across all members, applies tie-breaking rules if needed, and selects the winning beads blueprint.',
      'Audit Persistence: Votes, presentation order, per-model scoring breakdowns, and outcome metadata are stored as artifacts for audit and transparency.',
    ],
    outputs: [
      'Beads voting artifacts with per-model architecture scorecards and justifications.',
      'A winning semantic blueprint reference — the blueprint that scored highest overall.',
      'Audit history showing why the blueprint won, including score spread, per-category breakdowns, and any tie-breaking decisions.',
    ],
    transitions: [
      'Winner Selected → Refining Blueprint: A successful winner selection advances the workflow to the refinement phase, where the winner is enhanced with the best ideas from losing blueprints.',
      'Voting Failure → Blocked Error: Invalid votes, quorum collapse, or unresolvable errors route the ticket to Blocked Error.',
    ],
    notes: [
      'Context available: Relevant Files + Ticket Details + PRD + Competing Drafts (all anonymized).',
      'The architecture rubric differs from the PRD and interview rubrics — it focuses on implementation feasibility and dependency structure rather than requirement coverage.',
      'Previous blueprint draft artifacts shown during voting use the accepted validated blueprint as their Raw view; original raw/rejected drafting text remains scoped to the drafting phase diagnostics.',
      'The winning blueprint is not the final plan — it still goes through refinement, coverage checking (Coverage Check (Beads)), and expansion (Expanding Blueprint) before becoming execution-ready beads.',
    ],
    equivalents: [
      'This is the "council voting" step of the Blueprint (Beads) phase. The equivalent in the Interview phase is "Voting on Questions" (where the council votes on competing interview drafts) and in the Specs (PRD) phase is "Voting on Specs" (where the council votes on competing PRD drafts).',
      'The architecture rubric used here is the most technically focused of the three voting rubrics: it evaluates decomposition quality, feasibility, dependency correctness, and testability. By contrast, interview voting evaluates question relevance and coverage, while PRD voting evaluates requirement completeness and acceptance criteria quality.',
    ],
  },
  REFINING_BEADS: {
    overview: 'The winning beads blueprint stays the backbone while LoopTroop selectively pulls in stronger tasks, tests, constraints, and edge cases from the losing blueprints. Verification detail is expanded only when necessary for the bead itself; broad integration and interactive checks remain for Final Testing and Manual QA. Exact file targets and dependency metadata are added later during expansion, and focused read-only inspection can substantiate repository-specific claims.',
    steps: [
      'Context Assembly: The winning model receives its own winning blueprint plus all losing blueprints, clearly labeled. The prompt instructs it to preserve the winning structure while selectively merging improvements from the losers. It reviews relevant files first and may inspect the smallest useful repository area with read-only tools only when concrete evidence is missing.',
      'Selective Merging: The model reviews each losing blueprint for tasks, acceptance criteria, edge cases, or dependency insights that are present in the loser but absent from the winner. It incorporates these improvements without duplicating content, breaking the dependency graph, or fundamentally restructuring the winning blueprint.',
      'Output Normalization: LoopTroop normalizes the refinement output, validates the bead structure and dependency graph integrity, and stores the refined candidate. The configured structured retry count applies here, with retry prompts running in fresh sessions by design for council refinement. Attribution metadata is preserved where possible so you can see which improvements came from which losing blueprint.',
      'UI Diff Artifacts: Diff artifacts are generated showing what changed between the original winning blueprint and the refined version, helping you understand the refinement impact during later review.',
      'Verification Restraint: The refined candidate keeps detailed human-readable tests without requiring a matching command for every scenario. It retains or adds command, orchestration, risk, alternative, manual, or verification-only work only when that work is necessary for the bead and unsuitable for the later Final Testing or Manual QA phases.',
    ],
    outputs: [
      'Refined semantic beads blueprint — the winning blueprint enhanced with the best elements from losing competitors.',
      'Refinement attribution and diff metadata for UI inspection.',
      'A validated candidate structure ready for the coverage verification loop.',
    ],
    transitions: [
      'Success → Coverage Check (Beads): A valid refined blueprint advances to the beads coverage loop, which verifies it against the approved PRD.',
      'Failure → Blocked Error: Refinement failures, dependency graph violations, or validation errors route the ticket to Blocked Error.',
    ],
    notes: [
      'This phase still works on the semantic plan, including minimal planned checks or an explanation when no automated command is appropriate. File targets, runtime fields, and finalized dependency metadata are added during expansion.',
      'Context available: Relevant Files + Ticket Details + PRD + Competing Drafts. Focused read-only repository inspection is available only when this context is insufficient for a concrete repository-specific claim.',
      'Competing blueprint artifacts reviewed here show their validated canonical draft in Raw, matching the content the refinement prompt used. Refinement retries keep their own Raw attempt diagnostics separately.',
      'Why refine before expansion? Semantic-level refinement is cheaper and more flexible. It is easier to add or modify task descriptions than to redo execution-specific fields after expansion.',
    ],
    equivalents: [
      'This is the "refinement" step of the Blueprint (Beads) phase. The equivalent in the Interview phase is "Refining Interview" (where the winning interview draft is compiled into the interactive format) and in the Specs (PRD) phase is "Refining Specs" (where the winning PRD draft is enhanced with ideas from losing drafts).',
      'Beads refinement is very similar to PRD refinement — both merge improvements from losing drafts. The key difference is that beads refinement produces task-level implementation and verification guidance, while the Expanding Blueprint phase later adds the remaining execution metadata. PRD refinement produces the near-final document directly.',
    ],
  },
  VERIFYING_BEADS_COVERAGE: {
    overview: 'LoopTroop verifies the semantic beads blueprint against the approved PRD, revising it until required implementation outcomes are covered or the configured pass cap is reached. Coverage does not demand a command for every criterion or promote optional, risk, broad-integration, or manual behavior into Coding unless genuinely necessary. Once the loop finishes, the workflow advances to expansion.',
    steps: [
      'Coverage Evaluation: The winning beads model compares the current semantic blueprint against the PRD and returns a structured clean-or-gaps result. "Clean" means required implementation outcomes are covered and meaningfully verifiable; command absence or command-to-criterion parity is not a gap by itself. "Gaps" means required work lacks a bead, has insufficient acceptance criteria, lacks necessary verification, or depends on an unresolved source-artifact contradiction.',
      'Gap Resolution: If gaps are found, LoopTroop requests a targeted revision that adds missing implementation work or strengthens necessary acceptance and verification guidance. Revisions prefer replacing or consolidating planned commands instead of appending them, and may explain why no automated bead command is appropriate. This loop can repeat until clean or until the configured cap is reached.',
      'Version Tracking: Each coverage attempt and revision is persisted as coverage history, so you can see the evolution from the initial blueprint through each revision and understand what changed at each step.',
      'Finalization: Once coverage is clean or the configured cap is reached, the workflow advances to Expanding Blueprint. Any remaining requirement-coverage gaps are preserved for human review.',
    ],
    outputs: [
      'Versioned beads coverage history showing each coverage evaluation and revision.',
      'Latest refined semantic blueprint (after coverage revisions).',
      'Coverage result (clean or cap-reached), including any unresolved-gap warnings, that triggers automatic advancement to the expansion phase.',
    ],
    transitions: [
      'Coverage Clean → Expanding Blueprint: When the semantic blueprint passes coverage with no gaps, the workflow automatically advances to the Expanding Blueprint phase.',
      'Coverage Cap Reached → Expanding Blueprint: If the coverage cap is hit, the workflow advances to expansion with the latest available blueprint even if minor gaps remain. Coverage history is preserved for later review.',
      'Coverage Failure → Blocked Error: Coverage evaluation errors, revision validation failures, or model timeouts route the ticket to Blocked Error.',
    ],
    notes: [
      'This phase handles only the semantic coverage loop — expansion into execution-ready bead records happens in the separate Expanding Blueprint phase that follows.',
      'The beads coverage cap ensures convergence — the loop cannot run indefinitely.',
      'While this status is active, the workspace title shows the implementation-plan version being checked and the current coverage pass when those values are available. That live progress text disappears once the ticket leaves this status.',
      'Context available: PRD + Beads (semantic blueprint). Focused read-only repository inspection is available only when this context is insufficient for a concrete repository-specific assertion.',
      'Why separate coverage from expansion? Coverage at the semantic level is cheaper and faster than expansion. By checking coverage first at the semantic level, LoopTroop avoids wasting expansion effort on a blueprint that would need revision.',
    ],
    equivalents: [
      'This is the "coverage check" step of the Blueprint (Beads) phase. The equivalent in the Interview phase is "Coverage Check (Interview)" (where the interview is checked for missing information) and in the Specs (PRD) phase is "Coverage Check (PRD)" (where the PRD is checked against the winning model\'s Full Answers artifact).',
      'All three coverage checks share the goal of verifying completeness and resolve gaps automatically or via user input. What makes beads coverage unique is that it is followed by a separate expansion phase (Expanding Blueprint) that transforms the validated semantic blueprint into execution-ready bead records with commands, file targets, and dependency graphs. Interview and PRD coverage have no equivalent expansion step.',
      'What is being verified against what: Interview coverage checks answers against the ticket. PRD coverage checks the PRD against the winning model\'s Full Answers artifact. Beads coverage checks the blueprint against the approved PRD.',
    ],
  },
  EXPANDING_BEADS: {
    overview: 'LoopTroop transforms the coverage-validated blueprint into execution-ready bead records. Expansion preserves the approved acceptance, tests, minimal planned commands, and any no-command explanation while adding file targets, dependency ordering, labels, and runtime metadata. The expanded output becomes the approval candidate shown in the beads approval UI.',
    steps: [
      'Blueprint Loading: LoopTroop loads the latest semantic blueprint from the coverage phase — either the final coverage revision or the original refined blueprint if no revisions were needed.',
      'Expansion: The expansion model receives the semantic blueprint along with relevant files, ticket details, and the approved PRD. It preserves planned verification byte-for-byte and adds only file targets, dependency edges, labels, and runtime metadata; it cannot inflate or redesign the command list.',
      'Bead Record Writing: The expanded bead records are written to the ticket workspace as the canonical beads data file. This is the file the pre-flight check validates and the coding loop consumes bead-by-bead.',
      'Approval Candidate: The expanded output is persisted as the beads approval candidate artifact. This is what you review in the Approving Blueprint phase before coding starts.',
    ],
    outputs: [
      'Expanded execution-ready beads data with preserved verification guidance, file targets, dependency graphs, and runtime metadata.',
      'Canonical beads data file in the ticket workspace — the file the coding agent consumes.',
      'Approval candidate artifact for the Approving Blueprint UI.',
    ],
    transitions: [
      'Expansion Complete → Approving Blueprint: After the expansion step completes, the workflow advances to beads approval where you review the full execution plan.',
      'Expansion Failure → Blocked Error: Expansion errors or model timeouts route the ticket to Blocked Error.',
    ],
    notes: [
      'This is the only planning phase that ends with an explicit semantic-to-execution expansion step — all other phases work at the semantic level only.',
      'Context available: Relevant Files + Ticket Details + PRD + Semantic Blueprint (beads_draft), with focused read-only repository inspection available when required to confirm execution details.',
      'Why expand separately from coverage? Expansion is expensive and adds execution-specific detail. By doing coverage at the semantic level first (in Coverage Check (Beads)), LoopTroop avoids wasting expansion effort on a blueprint that would need revision.',
    ],
    equivalents: [
      'This is the "expansion" step unique to the Blueprint (Beads) phase — it has no direct equivalent in the Interview or Specs (PRD) phases. It follows immediately after Coverage Check (Beads) and precedes Approving Blueprint.',
      'Unlike all other planning phases which stay at the semantic level, this phase produces execution-ready artifacts: bead records with concrete commands, file targets, and dependency graphs that the coding agent will consume directly.',
    ],
  },
  WAITING_BEADS_APPROVAL: {
    overview: 'The final expanded beads plan is ready for human review before coding begins. You can review task descriptions, dependencies, acceptance criteria, human-readable tests, adaptable planned commands, and visible explanations for beads with no automated command. After approval, the coding agent implements beads one by one and Final Testing remains the mandatory ticket-wide automated gate.',
    steps: [
      'Execution Plan Review: LoopTroop shows each bead\'s description, acceptance criteria, dependency chain, file targets, planned test commands or no-command explanation, and execution ordering. Planned commands guide the agent and may be adapted when repository evidence requires it.',
      'Dependency Visualization: The beads are shown with their dependency relationships, so you can verify that the execution order makes sense — beads that depend on other beads will not run until their dependencies complete.',
      'Editing And Draft Autosave: You can review the plan in structured form or edit the raw representation before approving. Draft changes autosave between view switches and reloads. The visible Draft autosave on indicator reports pending, saving, saved, conflict, or failure state plus the last server-acknowledged save time. Draft autosave does not update the authoritative beads artifact; explicit Save applies the draft only while this approval gate is active, records a user-edit receipt with old/new content hashes, and invalidates the execution setup plan.',
      'Coverage Warnings And Extra Fixes: If the beads plan reached approval after exhausting the coverage loop cap (rather than achieving a fully clean status), coverage warnings are displayed. These describe unresolved gaps, including PRD requirements that may not have corresponding beads and unresolved source-artifact contradictions when present. You can edit manually, approve with gaps, or click Fix gaps with AI to revise the semantic blueprint and re-check coverage.',
      'Approval Decision: Approval confirms the execution plan that the coding loop will consume bead-by-bead. If unresolved coverage warnings remain, the button text makes that explicit as Approve with gaps. The request includes the SHA-256 hash of the reviewed JSONL bytes; stale hashes return 409 and leave approval paused. After approval, the coding agent receives individual bead specifications — it does not see the full plan, only the bead it is currently implementing.',
      'Extra-Fix Refresh: Each Fix gaps with AI click reloads the latest semantic beads blueprint, approved PRD, coverage warning, and approval artifact state on the server. If the semantic blueprint changes, LoopTroop reruns expansion before refreshing the approval plan and content hash.',
    ],
    outputs: [
      'Approved execution-ready beads plan — the authoritative task breakdown the coding agent will follow.',
      'User-edited replacement (if edits were made before approval).',
      'Saved approval editor state for in-progress reviews.',
      'Optional extra-fix coverage history entries labeled `Extra Fix N` when unresolved PRD-to-beads gaps were addressed from the approval warning.',
      'Approval snapshot and approval receipt with `content_sha256` for the reviewed JSONL plan.',
      'Append-only `user_edit_receipt:beads` artifacts for manual saves.',
      'The authoritative bead set consumed by pre-flight checks and the coding loop.',
    ],
    transitions: [
      'Approve → Checking Readiness: Approval advances the workflow to pre-flight checks, which validate that the execution environment is ready before the first bead runs.',
      'Cancel → Canceled: Cancellation moves the ticket to the terminal Canceled state.',
    ],
    notes: [
      'This is the review artifact gate for the beads phase and the last approval step before automated code execution begins.',
      'Bead reads expose the reviewed content hash in the `X-Content-Sha256` header, and approval compares that hash against the current server artifact before advancing.',
      'No automatic AI work runs just because this approval gate is open. AI sees approval-phase context only when you explicitly click Fix gaps with AI, and that prompt is scoped to the current semantic blueprint, approved PRD, remaining coverage gaps, and previous extra-fix history.',
      'Tip: Review the dependency chain carefully. Incorrect dependencies could cause beads to run before their prerequisites are ready, leading to implementation errors.',
      'Tip: Check that acceptance criteria are specific and testable. The coding agent uses acceptance criteria to verify its own work — vague criteria may lead to incomplete implementations.',
    ],
    equivalents: [
      'This is the "approval gate" of the Blueprint (Beads) phase — the last of three approval gates in the planning pipeline. The equivalent in the Interview phase is "Approving Interview" (the first gate) and in the Specs (PRD) phase is "Approving Specs" (the second gate).',
      'This is the most consequential approval gate because it is the last human checkpoint before automated code execution begins. Approving the interview feeds into PRD drafting (a planning step). Approving the PRD feeds into beads drafting (still a planning step). But approving beads feeds directly into the coding agent — which will start modifying files in your repository.',
    ],
  },
  PRE_FLIGHT_CHECK: {
    overview: 'LoopTroop runs a deterministic pre-flight gate before any execution-band AI work starts. This validates coding-agent connectivity, execution-mode session capability, workspace integrity, worktree cleanliness, required artifact availability, and the bead dependency graph\'s structural correctness. The pre-flight check exists to prevent the execution setup and coding phases from starting in a broken state.',
    steps: [
      'Workspace Validation: LoopTroop verifies that the ticket workspace directory exists, is writable, and contains the expected artifact files (relevant files, interview, PRD, beads data).',
      'Worktree Cleanliness Gate: LoopTroop inspects Git-visible changes before setup starts. Pre-existing committable project changes fail the gate so future bead commits can be attributed cleanly; untracked generated/local outputs are recorded as warnings with suggested `.gitignore` entries.',
      'Coding Agent Connectivity: The pre-flight doctor checks that the configured coding agent (OpenCode) is reachable and responsive. This catches connectivity issues, authentication problems, or configuration errors before execution-band work begins.',
      'Execution Capability Probe: LoopTroop creates a temporary execution-band session using the same model/variant combination planned for real work, retrying session creation with the shared 1s/3s/7s backoff when OpenCode fails to return a session, sends a tiny read-only probe prompt, requires the exact response `OK`, and then tears the probe session down. This catches session-create or tool-mode incompatibilities that a generic health check would miss.',
      'Bead Availability Check: LoopTroop confirms that the approved beads data file exists, is parseable, and contains at least one runnable bead with valid structure.',
      'Dependency Graph Validation: The bead dependency graph is checked for structural integrity — no circular dependencies, no references to non-existent beads, and at least one bead with no dependencies (so the execution loop has a valid starting point).',
      'Pre-Flight Report: A structured pre-flight report is generated with pass, warning, and failure entries for each check. This report is persisted regardless of the overall outcome so you can inspect exactly what passed and what failed.',
      'Execution Handoff: If all checks pass, LoopTroop advances into the dedicated execution-setup phase. Bead progress is not started here — coding still begins later at bead 1/N.',
    ],
    outputs: [
      'Pre-flight report artifact with pass, warning, and failure entries for each validation check, including worktree cleanliness diagnostics.',
      'Execution readiness decision — either "ready to draft the setup plan" or "blocked with specific failure reason."',
    ],
    transitions: [
      'All Checks Pass → Approving Workspace Setup: The workflow advances to the setup-plan approval gate, which audits workspace readiness and drafts only any missing temporary setup before anything mutates the worktree.',
      'Any Critical Failure → Blocked Error: Connectivity failures, missing artifacts, dependency graph problems, committable pre-existing worktree changes, or workspace integrity issues route the ticket to Blocked Error with a detailed failure reason.',
    ],
    notes: [
      'This phase is intentionally deterministic and lightweight — it does not perform ticket-specific execution setup or permanent repository changes.',
      'The pre-flight check is designed to catch environmental issues early, before the execution setup or coding agent wastes time on work that would fail due to missing prerequisites.',
      'Warning-level results (non-critical issues), such as untracked generated/local outputs, are recorded but do not block execution. Only critical failures prevent the coding loop from starting.',
    ],
  },
  WAITING_EXECUTION_SETUP_APPROVAL: {
    overview: 'LoopTroop audits the current host and workspace, then pauses for your review before setup commands run. The plan targets the machine that will execute this ticket; commands are stored as explicit programs and arguments or as scripts for a named shell. Ordered workspace probes demonstrate that repository commands really work, while detected Git hooks and manager configuration remain backend-owned, read-only evidence. The inherited Git-hook setting is only the starting choice: you can select a ticket-run override and edit its validation commands without changing the project or profile default. Draft edits autosave with a visible last-save status, but they do not update the authoritative setup plan until you explicitly Save.',
    steps: [
      'Automatic Readiness Audit On Entry: When this state is entered, LoopTroop asks the locked main implementer to inspect the approved ticket details, relevant files, PRD, beads, the current worktree, and any prior reusable setup profile under the configured AI Response Timeout, then decide whether temporary setup is actually needed. The draft is created automatically if no current setup-plan artifact exists.',
      'Structured Setup Plan: The draft combines an AI-authored proposal with backend-owned ticket identity, schema, current-host facts, detected Git evidence, initial hook policy, quality policy, and derived readiness. Model-supplied copies of backend fields are ignored with a visible repair warning instead of invalidating the draft. Commands identify either a program plus arguments or an explicit POSIX, Command Prompt, or PowerShell script; direct programs are preferred.',
      'No-Action Cases Are First-Class: If the audit finds that the environment already has everything needed, the plan stays reviewable but contains no setup steps. You can still approve it as-is or edit it to add commands if you want LoopTroop to do additional temporary preparation.',
      'User Review, Editing, And Draft Autosave: The approval UI lets you edit structured setup commands and probes; review the current-host banner; select Observe, Check, Require, or Run hooks for this ticket run; and edit explicit hook validation commands. Detected evidence is not editable. Large workspace inputs show file-count and size information and require an explicit override. The visible Draft autosave on indicator reports pending, saving, saved, conflict, or failure state. Draft autosave does not update the authoritative setup plan; explicit Save applies the draft and records before/after hashes.',
      'Regenerate With Commentary: If the initial assessment or plan is close but not correct, you can send commentary describing what should change. LoopTroop will archive the current plan as a prior version, then regenerate a new draft in the background. You are returned to the ticket overview immediately while generation runs. All previous versions are accessible via the VERSION dropdown at the top of the approval pane. From Preparing Workspace Runtime, regeneration performs the same one-step rewind before starting the single requested fresh draft, without also launching the automatic entry draft.',
      'Evidence Refresh And Approval Handoff: Immediately before approval, LoopTroop refreshes current-host and Git-hook evidence. Any meaningful change updates the review hash and requires review again. Once approved, runtime uses that exact host-aware snapshot, ticket-run hook policy, command order, workspace inputs, probes, and setup steps rather than silently replacing them.',
    ],
    outputs: [
      'Editable `execution_setup_plan` artifact containing readiness, temporary setup steps, workspace probes, hook policy, detected-hook evidence, explicit validation commands, diagnostics, and regenerate history.',
      'Underlying plan-generation report and notes artifacts retained for workflow context, auditability, regenerate continuity, and raw attempt inspection.',
      'Approval receipt confirming the reviewed setup plan was explicitly approved before execution setup begins, including `content_sha256` for the canonical serialized plan.',
      'Append-only `user_edit_receipt:execution_setup_plan` artifacts for manual saves.',
    ],
    transitions: [
      'Approve → Preparing Workspace Runtime: The workflow advances to the execution setup phase, which verifies the approved readiness assessment, performs only the missing temporary setup, and writes the reusable runtime profile.',
      'Regenerate → Returns To Overview: LoopTroop archives the current setup-plan draft as a prior version, starts a new empty draft (loading state), runs generation in the background, and returns you to the ticket overview immediately. All prior versions are accessible via the VERSION dropdown at the top of the approval pane. If runtime setup is currently active, LoopTroop first stops it, archives the runtime attempt, clears stale setup profile outputs while preserving the tool cache, returns to this approval gate, and runs only the requested regenerate draft for the fresh attempt.',
      'Invalid Draft → Stay For Review: If LoopTroop cannot produce a valid AI proposal after structured retries, the ticket remains at Approving Workspace Setup. Approval is disabled, while the rejected output, parser diagnostics, and Regenerate action remain available.',
    ],
    notes: [
      'This state is still pre-coding. No permanent repository files should be modified here.',
      'No AI execution proceeds past this gate until you approve the proposed setup plan.',
      'Read APIs expose `contentSha256`; write APIs reject explicit archived phase attempts with 409 so previous setup-plan versions stay immutable. The only post-approval write window is the one-step rewind from Preparing Workspace Runtime back to this approval gate; CODING and later phases remain read-only for setup-plan changes.',
      'If setup-plan generation fails, rejected `modelOutput` is diagnostic-only: the structured details show failure state and errors, full malformed output is available from Raw diagnostics, and the ticket is not globally blocked.',
      'The approved setup plan is separate from the final execution setup profile. The profile is produced only after the next phase verifies readiness and runs any approved temporary setup inside LoopTroop-owned runtime paths, preferably under `.ticket/runtime/execution-setup/**` for execution-only toolchains and caches.',
      'Setup-plan generation owns its OpenCode session only while producing the draft: AI Response Timeout bounds the draft/regenerate prompt, session creation uses the shared 1s/3s/7s OpenCode retry wrapper, ready reports complete the session, and invalid or failed reports abandon it so retry starts from clean durable context.',
    ],
  },
  PREPARING_EXECUTION_ENV: {
    overview: 'LoopTroop runs the approved current-host setup after review and before coding. It materializes approved non-reproducible workspace inputs, prepares structured environment variables and PATH additions, provisions temporary tooling only under approved roots, and executes direct programs or explicitly named host shells. Setup remains programming-language and project-type agnostic by following repository evidence rather than assuming a package manager, shell, or file layout.',
    steps: [
      'Approved Plan First: The locked main implementer reads the approved setup-plan artifact first, then loads only the focused runtime context — ticket details, beads plan, and any prior setup retry notes. User edits in the approved plan take precedence over the model\'s original draft.',
      'Readiness Verification Before Action: The setup agent must verify the approved readiness assessment first. If the approved plan says no actions are required and that remains true, it should avoid running bootstrap commands and simply emit a reusable profile describing the ready environment.',
      'Temporary-Only Initialization: When setup is still missing, the agent executes only the approved temporary steps, may inspect the repository, run repo-native bootstrap commands, warm caches, or prepare generated runtime artifacts. If required command launchers or toolchains are missing, a failed version/info probe is discovery only; wrapper creation, cache inspection, PATH edits, and version probes do not count as provisioning strategies. The agent must first try distinct real user-space provisioning strategies that obtain, install, or activate the launcher under approved temp roots, preferably `.ticket/runtime/execution-setup/tool-cache/**`, or record why no safe provisioning path exists before reporting tooling failure.',
      'Setup-Scoped Online Lookup: Preparing Workspace Runtime exposes OpenCode `websearch`/`webfetch` so the agent can consult official release or download metadata when repository-declared versions cannot be resolved locally. Managed OpenCode dev servers are started with `OPENCODE_ENABLE_EXA=1`; other phases keep the web tools disabled by LoopTroop tool policy.',
      'Honest Structured Result: The agent finishes by returning one structured result whose top-level and profile status are both Ready when every check passes or both Blocked when any check fails. It records temp roots, bootstrap commands, non-mutating tooling probes, ordered functional workspace probes, the locked Git-hook policy/detected evidence/validation commands and receipts, optional tool-requirement provisioning evidence, reusable artifacts, discovered project command families, and the later quality-gate policy. A Blocked result remains diagnostic and is never installed as the reusable runtime profile.',
      'Environment And Command Routing: LoopTroop applies the approved structured variables and PATH additions directly to every subprocess. It generates a small host-specific launcher only for coding-agent tool calls that need the same environment; no POSIX wrapper filename or substring convention is required.',
      'Progress Continuation And Result Repair: A short markerless progress reply is treated as unfinished setup work. LoopTroop sends up to two direct same-session instructions to continue using tools and finish with Ready or Blocked, without consuming a normal setup attempt or the structured-output repair budget. A third unfinished reply fails the attempt with a plain explanation. Completed but malformed results continue through the separate structured-output correction path.',
      'One Deadline Per Attempt: Execution Setup Timeout is the maximum total active-work budget for one attempt. Session acquisition, initial and fallback prompts, OpenCode provider recovery, progress continuations, structured-output corrections, setup commands, backend wrapper/probe/hook validation, worktree inspection, and retry-note generation all receive only the time remaining on that shared deadline. OpenCode retry controls cannot extend it. A zero setting disables this aggregate deadline while existing command-level safety limits remain.',
      'Audited Augmentations: If the approved plan is insufficient and the setup agent must run extra temporary-only commands, those additions are recorded in the setup report so you can see exactly how execution diverged from the approved draft.',
      'Structured Validation: LoopTroop parses the model-owned result and combines it with the already approved backend-owned inputs, probes, host facts, hook evidence, and policy. Contradictory Ready or Blocked outcomes are rejected, but malformed model echoes of backend fields cannot replace or invalidate the approved values. Legacy command strings may be repaired into a script for the current host shell without changing their text, with a visible warning.',
      'Filesystem Policy Enforcement: After each ready setup attempt, LoopTroop verifies in code that setup did not leave committable project changes outside LoopTroop/setup roots. Such changes fail the attempt and produce a retry note describing the violation. Common untracked generated/local outputs do not block setup, but they are logged and copied into profile `cautions` with suggested `.gitignore` entries; setup never edits `.gitignore` automatically.',
      'Retry and Reset: If an attempt fails or returns an actionable Blocked result, LoopTroop records retry notes, resets tracked repository files back to the setup phase start commit, preserves LoopTroop-owned ticket artifacts under `.ticket`, clears stale setup profile/env-wrapper state while preserving `.ticket/runtime/execution-setup/tool-cache`, and retries within the normal iteration budget. A Blocked result with `not_provisionable` evidence and a reason stops immediately because the agent found no safe path; repeated tooling-blocker protection remains active for retryable failures.',
      'Deadline Recovery: Once an attempt deadline expires, LoopTroop stops scheduling active setup work and returns a clear timeout failure. Process termination, session cleanup, safe worktree reset, and approved-input rematerialization may finish afterward so recovery remains safe; this cleanup does not consume the next attempt\'s fresh full budget. Timeouts before session creation remain ordinary retryable setup failures.',
      'Manual Same-Session Attempt: After setup blocks, Retry with extra note... opens a dialog. Confirmation sends only the entered text to the preserved setup session and grants one additional setup attempt beyond the attempts already used. It keeps the current runtime phase attempt and does not store the user text as future setup context.',
      'Return To Setup Approval: While this phase is still active, you can revisit Approving Workspace Setup to edit or regenerate the setup plan. LoopTroop warns first, stops the active runtime setup session, archives both the approved setup-plan attempt and current runtime attempt, clears stale runtime profile outputs while preserving the tool cache, and requires the revised plan to be approved again before setup runs. The rewound approval actor stays quiet for that request, so manual edits are not overwritten by an automatic draft and regenerate starts only one setup-plan session.',
    ],
    outputs: [
      'Canonical execution setup profile artifact for Ready results, describing reusable temp roots, prepared runtime wrappers, tooling probe commands, provisioning-attempt evidence when applicable, discovered command families, and quality-gate policy for later coding beads and final testing. Blocked profiles remain diagnostic-only in the setup report.',
      'Execution setup report artifact with attempt history, final status, retry notes, worktree warnings, structured-output diagnostics, and Raw attempt variants for setup-generation retries.',
      'Temporary runtime artifacts stored under `.ticket/runtime/execution-setup/**`, including `tool-cache`, a host-specific coding-agent launcher when needed, and the profile mirror file `.ticket/runtime/execution-setup-profile.json`; profile-declared setup/cache roots are excluded from later bead commits.',
    ],
    transitions: [
      'Setup Ready → Implementing: A valid setup profile with passing wrapper/probe validation advances the workflow into coding, where the first real bead starts at 1/N.',
      'Setup Blocked Or Failed → Blocked Error: A terminal honest Blocked result, retry exhaustion, repeated tooling blockers, provider/session failures, or committable project changes left by setup route the ticket to Blocked Error with the setup report preserved for diagnosis. Retry with extra note... can send one direct prompt to the preserved setup session. Edit setup plan... asks for confirmation before rewinding to approval.',
    ],
    notes: [
      'This phase is not a real bead. It does not change bead counts, does not participate in final testing scope, and never produces commits or pushes.',
      'Coding receives a read-only setup profile file path rather than the profile inline, keeping later execution context small while still avoiding repeated environment rediscovery when setup details are needed. Final testing also reads the setup profile and automatically applies a declared wrapper to generated commands that do not already use it.',
      'The approved setup plan remains the user-facing review artifact. Execution setup may augment it temporarily, but those augmentations are audited in the execution report instead of silently rewriting the approved plan.',
      'Everything created here is temporary runtime state. Cleanup removes temp roots at ticket end while preserving audit artifacts and execution logs. Later internal Git operations use the approved hook policy and ignore setup roots so prepared toolchains cannot become implementation work. LoopTroop materializes only ignored or untracked files and directories listed in the approved setup plan. It does not copy any additional local inputs in response to a setup prompt.',
      'Internal setup/reset commands appear in `SYS > CMD` as completed-command summaries; quiet git operations use concise outcomes instead of generic `ok` rows or progress streams.',
    ],
  },
  CODING: {
    overview: 'LoopTroop runs approved beads one at a time. The coding agent uses planned commands as adaptable guidance, runs the smallest appropriate bead-scoped checks, and must return a structured all-pass completion marker; LoopTroop validates that marker without independently rerunning frozen commands. Deadline exhaustion and unresumable restarts follow the Ralph reset-and-retry path, while local finalization failures remain manual Retry/Cancel blocks. After all beads complete, backend-executed Final Testing remains the mandatory ticket-wide gate.',
    steps: [
      'Bead Selection and Tracker Update: LoopTroop reads the authoritative bead tracker, identifies all runnable beads (status `pending` with every entry in `blocked_by` present in the done-bead set), and sorts them by `priority` ascending. The first bead in that sorted list is selected. The selected bead is immediately marked `in_progress` in the tracker and ticket progress counters are updated so the UI can show deterministic bead completion as a separate execution metric.',
      'Bead Start Commit Recording (Best Effort): Before the agent writes any files, LoopTroop attempts to record the current git HEAD SHA of the worktree as `beadStartCommit` and persists it in the bead tracker. This SHA is the worktree reset anchor — if a later iteration fails, the worktree can be rolled back to exactly this state. If recording fails (e.g., a git error), execution continues without it; context-wipe reset and bead-diff capture are simply disabled for this bead.',
      'Restart Recovery: If CODING resumes with an interrupted `in_progress` bead, LoopTroop first checks for an explicitly preserved continuation and then the latest `bead_execution:{beadId}` artifact. It reuses the exact preserved session or finalizes a checkpoint only when its bead id, iteration, `startedAt`, `updatedAt`, and `beadStartCommit` match current durable state. Otherwise the interrupted attempt receives a deterministic Failed Iteration Note, is reset to its start snapshot, advances to the next iteration, and returns to `pending`; the scheduler then starts that replacement iteration with a fresh configured deadline.',
      'Context Assembly: For the selected bead, LoopTroop assembles `bead_data` plus separately labelled Failed Iteration Notes, User Retry Notes, and Finalization Failure Notes. The prompt also points to the read-only setup profile at `.ticket/runtime/execution-setup-profile.json`. The agent receives only this bead-focused context — not the full beads plan, PRD, interview, or earlier coding transcript inline.',
      'Session Creation and Main Prompt: The locked main implementer opens a new OpenCode session with `keepActive: true` (the session stays open for potential in-session retries and eligible provider/session Continue recovery without re-creation overhead). Workflow-owned iteration timeouts are not eligible for Continue; after context-wipe capture, that session is abandoned and the next attempt must use a fresh owned session. If OpenCode fails to create the session, LoopTroop retries the create call with the shared 1s/3s/7s backoff and records health diagnostics before treating startup as blocked. The initial bead prompt is dispatched only after a session exists. Session creation, prompt dispatch, and the start of streaming are logged as AI milestone events with bead iteration metadata so the live UI can show the current raw input before the execution artifact is written.',
      'OpenCode Retry Budget: During every prompt in the coding iteration, LoopTroop watches OpenCode `session.status` retry events. Matching provider/transport stalls — rate limits, usage limits, resource exhaustion, overloaded/capacity, temporary unavailability, timeout/deadline, fetch, network, and socket-reset messages — are counted against the profile OpenCode retry limit and grace window. When either budget is exhausted, CODING throws a continuable provider error instead of consuming the bead iteration timeout or bead retry budget. Matching retry/session/output-limit diagnostics are also retained as the latest underlying OpenCode cause if the bead later blocks through a completion-marker wrapper or bead retry budget. This provider/session budget is separate from the LoopTroop-owned per-iteration timeout.',
      'Inner Response Loop and Agent-Owned Verification: LoopTroop parses the `<BEAD_STATUS>` marker. Missing or malformed output uses the bounded structured-retry path, and a non-passing marker asks the same session to continue. The agent runs applicable bead-scoped tests, lint, typecheck, and qualitative review itself, correcting planned commands when repository evidence requires it. A valid all-pass marker proceeds directly to local finalization; the single workflow deadline covers model work, checks, marker repair, and repair turns.',
      'Live Streaming: High-signal execution events, prompt dispatches, visible agent responses, file modification events, test results, and session lifecycle events are emitted into the normal phase log in real time. Deeper forensic/debug details live in the debug log.',
      'Scoped Verification: Planned commands stay language-agnostic and repository-grounded. A bead may have no planned automated command when it records why none is appropriate, and detailed test scenarios do not require one command each. The agent may use the prepared runtime wrapper and discovered project commands without copying ignored tooling from another checkout.',
      'Success Path — Local Finalization, Diff Capture, Artifacts, and Broadcast: When the inner loop exits successfully, LoopTroop first persists the full execution result as a `bead_execution:{beadId}` checkpoint tied to the exact in-progress bead state, including the raw bead-iteration prompt/output attempts captured so far. It then finalizes the local work: `commitBeadChanges` must create a local per-bead commit when Git-visible project changes exist in any language or file extension, excluding LoopTroop/setup roots and untracked generated/local noise. A true no-op may complete without a commit, and a remote push failure after a successful local commit is logged as a warning. Only after local finalization succeeds does LoopTroop mark the bead `done`, update progress counters, capture a code-only `bead_diff:{beadId}` from `beadStartCommit` when available, and broadcast `bead_complete` with progress counters.',
      'Failure Path — Failed Iteration Note: When the shared deadline or another iteration failure invokes Ralph recovery, LoopTroop records the raw attempt and appends a structured, ANSI-free entry to `failedIterationNotes`. The entry contains timestamp, iteration, concise content, and an optional error code; full output remains in execution/error logs. Earlier entries are never replaced, merged, or deduplicated.',
      'Failure Path — Worktree Reset and Status Rollback: After the Failed Iteration Note is appended, LoopTroop resets the worktree to `beadStartCommit`, preserves `.ticket` artifacts, returns the bead to `pending`, abandons the active session, clears stale continuation state, and increments the outer iteration. Late output from the expired attempt cannot finalize the bead.',
      'Retry Budget and Finalization Boundary: Ralph failures consume the bead iteration budget and eventually block with `BEAD_RETRY_BUDGET_EXHAUSTED`. A valid all-pass marker proceeds to local finalization. Commit/finalization failure instead appends only to `finalizationFailureNotes` and immediately enters manual Blocked Error recovery; it is not converted into another Ralph iteration. Retry with extra note... appends the user text unchanged only to `userRetryNotes` after safe recovery is proven.',
    ],
    outputs: [
      'Updated bead statuses (pending → in_progress → done/error) and ticket progress counters visible as a distinct bead-completion metric. During CODING the ticket header, Kanban card, and navigator show deterministic bead completion (`completed_beads / total_beads`) alongside an approximate remaining-time estimate, while the normal progress ring remains workflow-phase progress.',
      'Per-bead local git commits created when a successfully completed bead changes Git-visible project files in any language or extension, or a true no-op completion when there are no committable project changes; remote push failures and skipped untracked generated/local outputs are reported as warnings after local success.',
      'Per-bead code-only diffs (`bead_diff:{beadId}`) capturing what each bead changed in the repository (excluding `.ticket/**` metadata), stored as phase artifacts — only produced when `beadStartCommit` was successfully recorded.',
      'Per-bead execution result artifacts (`bead_execution:{beadId}`) with raw bead-iteration attempts, initial prompts, final model outputs or diagnostics, error details, and current-bead checkpoint metadata, written on both success and failure.',
      'Three append-only per-bead histories: Failed Iteration Notes, User Retry Notes, and Finalization Failure Notes. Machine entries are ANSI-free summaries; full command output and stack traces remain in execution/error logs.',
      '`bead_complete` SSE broadcast events enabling real-time UI bead-completion updates after each finalized successful bead.',
    ],
    transitions: [
      'Bead Success + More Remaining → Stays in Coding: After a finalized successful bead, `BEAD_COMPLETE` is sent and the loop immediately selects the next runnable bead.',
      'All Beads Done → Testing Implementation: When every bead is marked `done`, `ALL_BEADS_DONE` is sent and the workflow advances to the final testing phase.',
      'Bead Failure → Blocked Error: A bead that exhausts its Ralph iteration budget, hits an unrecoverable runtime error, or fails local finalization sends `BEAD_ERROR`. Ralph failures append to Failed Iteration Notes. Finalization failures use `BEAD_FINALIZATION_FAILED`, append to Finalization Failure Notes, do not broadcast `bead_complete`, and remain manual Retry/Cancel blocks. Retry with extra note... appends the user\'s timestamped guidance only to User Retry Notes after safe reset.',
    ],
    notes: [
      'Only runnable beads (status `pending` with all `blocked_by` dependencies in the done set) are eligible for new execution selection. Interrupted `in_progress` beads are handled by recovery first: preserved continuations reuse their exact session, current checkpoints are finalized, and otherwise the interrupted attempt is noted, safely reset, incremented, and returned to `pending` before selection. Beads with status `error` are never selected until a retry moves them back into CODING.',
      'Inline context available to the agent: Current Bead Data (`bead_data`) plus the `bead_notes` context slice rendered as three separately headed histories. Execution setup details remain available by reading `.ticket/runtime/execution-setup-profile.json` when needed. The agent does not receive the full beads plan, PRD, interview, or other beads\' results.',
      'The `beadStartCommit` is best-effort: if git fails to record it before execution starts, that bead cannot be reset on context wipe and its diff artifact cannot be captured, but execution still proceeds normally.',
      'Every note producer is append-only: Ralph recovery writes only Failed Iteration Notes, Retry with extra note... writes the user text unchanged only to User Retry Notes, and local commit/finalization failure writes only a concise Finalization Failure Note. Entries are never replaced, merged, or deduplicated.',
      'The context wipe note uses the failing session\'s full accumulated context (tool calls, test output, error traces) to generate an AI-authored diagnostic. If the context-capture prompt itself fails, a deterministic fallback note is built from recorded errors and recent tool-failure excerpts — the worktree reset always completes regardless of whether the AI note succeeds.',
      'Each successful bead with committable project changes produces a separate local per-bead git commit regardless of language or file extension. A successful no-op bead may complete without one. The integration phase later squashes all bead commits into a single clean candidate commit for the pull request.',
      'Internal git commands in this phase are logged to `SYS > CMD` after completion with concise summaries for quiet outcomes such as clean worktrees, empty diffs, completed pushes, and context-wipe cleanup.',
      'The live workspace title shows bead and iteration progress only while CODING is the ticket\'s current status; its countdown is anchored to the active attempt\'s `updatedAt` and falls back to the bead\'s original `startedAt` only for legacy records. The left-panel workflow timeline keeps the last known bead count on historical CODING rows and completed tickets.',
      'Progress transparency: during CODING the normal progress ring remains workflow-phase progress, while the header, Kanban card, and navigator surface deterministic bead completion (`completed_beads / total_beads`) as a distinct execution metric plus an ETA range (best / likely / worst) recomputed on each bead completion. The ETA is derived from recorded per-bead throughput and current retry pressure — rich historical throughput bucketed by ticket size and effort tier when enough samples exist, otherwise the current run while it has signal, otherwise sparse history before the rough default. Hover text always clarifies that bead completion is execution-scoped, not workflow-phase progress, and that remaining time is approximate.',
    ],
  },
  RUNNING_FINAL_TEST: {
    overview: 'After all beads finish successfully, LoopTroop runs a ticket-level final test to verify the implementation as a whole. The main implementer proposes structured commands for the approved current host: direct processes are preferred, while scripts must name POSIX, Command Prompt, or PowerShell explicitly. LoopTroop applies the prepared structured environment directly, executes the commands on the current ticket branch, and audits dirty files so generated, cache, and setup-local outputs stay outside delivery.',
    steps: [
      'Context Assembly: LoopTroop loads ticket details, the approved PRD, the beads plan, and any final-test retry notes. The interview and Full Answers artifacts are intentionally not fed because the PRD and beads already carry the approved implementation intent.',
      'Test Plan Generation: The locked main implementer analyzes the full context and generates a structured final-test plan under the configured AI Response Timeout. This plan includes test commands to execute, expected outcomes, what each test is verifying, and language-agnostic `file_effects` entries classifying files it expects to create or change as candidate, temporary, or unexpected. Tests may include unit tests, integration tests, build verification, and acceptance criteria validation. Malformed final-test plan responses use the ticket\'s configured Structured Output Retries count and are preserved as Raw attempt variants.',
      'Test Execution: LoopTroop executes each generated command with its explicit repository-relative working directory, environment variables, optional bounded timeout, and process or named-shell mode. The runtime profile contributes structured PATH additions and variables directly; display text is rendered from the command object for logs and reports.',
      'Retry Reset: Between failed final-test attempts, LoopTroop resets project files back to the final-test start commit while preserving LoopTroop-owned ticket artifacts under `.ticket`.',
      'Result Recording: A final test report artifact is written whether tests pass or fail. The report includes the generated test plan, actual command output, pass/fail status for each test, and any error messages or stack traces from failures.',
      'File Effects Audit: When final tests pass, LoopTroop compares dirty git state from before the passing final-test attempt with dirty git state afterward and records a `final_test_file_effects_audit`. Explicit candidate intent and tracked/staged changes are preserved. Recognized untracked generated/cache/setup-local files remain on disk as local-only; an unknown untracked file receives one classification retry and then continues as local-only with a warning if it is still undeclared. An unresolved tracked change remains a candidate for the later PR audit, while an explicitly temporary or unexpected tracked mutation is restored to committed content before candidate staging.',
      'Phase Logging: The normal phase log captures the test lifecycle — plan generation, command execution, output streams, and final results — for review and diagnosis. LoopTroop-owned reset and git inspection commands are logged as completed-command summaries rather than recurring progress rows.',
    ],
    outputs: [
      'Final test report with the generated test plan, file effects declarations, execution results, pass/fail status, error details, and raw attempt diagnostics for final-test generation retries.',
      'Final-test file effects audit listing baseline and post-test dirty files, produced or changed files, declared effects, candidate files, local-only files, deterministic classification reasons, retry outcomes, and warnings.',
      'Phase logs showing test command execution and output.',
      'A pass/fail gate that determines whether the implementation proceeds to the locked Manual QA route, direct integration, or recoverable error handling.',
    ],
    transitions: [
      'All Tests Pass + Manual QA Disabled → Preparing Final Commit: Successful final tests advance directly to integration using the ticket’s start-time Manual QA lock.',
      'All Tests Pass + Manual QA Enabled → Preparing Manual QA: Successful final tests advance to automated checklist generation; that phase resolves the file-effects audit and prepares the candidate-only QA checkpoint before asking for user verification.',
      'Local-Only File Effects → Continue Automatically: Generated/cache/setup-local outputs remain in the worktree but are omitted from totals, checkpoints, and delivery. Unknown untracked files receive one classification retry, then continue as local-only with a recorded warning when still undeclared.',
      'Any Test Failure → Blocked Error: Failed tests or test generation failures route the ticket to Blocked Error, where you can retry (re-run tests) or cancel.',
    ],
    notes: [
      'Context available: Ticket Details + PRD + Beads Plan + Final Test Retry Notes.',
      'This phase tests the complete implementation holistically — it catches integration issues between beads that individual bead-level tests might miss.',
      'AI Response Timeout bounds final-test model prompts; command execution remains governed by the execution/final-test command timeout so long-running shell commands are handled separately.',
      'Why generate tests dynamically? The main implementer can create tests tailored to what was actually implemented, rather than relying on pre-written tests that might not exist for new features.',
    ],
  },
  GENERATING_QA_CHECKLIST: {
    overview: 'LoopTroop automatically prepares the next Manual QA checklist after final tests pass. This automation-only checkpoint reports each meaningful preparation milestone, keeps the phase log visible, and presents the completed checklist as a readable artifact with an exact Raw view; no user action is requested, and LoopTroop never starts, stops, previews, or controls the user’s application.',
    steps: [
      'Candidate Checkpoint Preparation: LoopTroop resolves the final-test file-effects audit, exactly checkpoints accepted candidate changes, leaves local-only test/runtime outputs available in the worktree, and records a delivery-relevant workspace baseline for detecting later application drift.',
      'Version Reservation: The next `vN` directory is reserved before model work. A reservation is not treated as an available artifact; the UI exposes version selection only when more than one checklist-backed round exists.',
      'Focused Context Assembly and Inspection: The locked main implementer receives ticket details, the frozen approved PRD, selected bead fields, the current final-test report, the latest prior Manual QA artifacts, and targeted diff metadata. Focused read-only repository inspection is available, while repository-wide raw dumps are prohibited.',
      'Checklist Generation and Validation: One strict tagged YAML response supplies checklist items, PRD references, and any approved-PRD criteria that are not applicable to human verification. Formatting-only repairs may normalize envelopes, YAML syntax, aliases, and safely quote YAML-sensitive text, but never invent checklist text, actions, observations, or expected results. Invalid or overlapping PRD references use the normal structured-output retry policy.',
      'Coverage Computation: LoopTroop derives stable acceptance-criterion references from the approved PRD and computes covered, partially covered, uncovered, or Not applicable to Manual QA advisory coverage in code without a second model call. Every not-applicable criterion requires a reason.',
      'Persistence: The canonical checklist, coverage, generation reservation, and workspace baseline are written under `.ticket/manual-qa/vN/`, with compact append-only copies stored as phase artifacts.',
      'Progress and Artifact Presentation: The workspace reports checkpoint, reservation, context assembly, model/tool activity, validation, persistence, and handoff milestones. The artifact opens in a human-readable checklist view with the exact canonical YAML available on its Raw tab.',
    ],
    outputs: [
      'A validated, immutable `manual_qa_checklist` artifact with app-assigned item/version ids, stable lineage, behavior and severity metadata, prerequisites, actions, expected results, watch notes, bead references, and PRD references.',
      'Advisory PRD coverage showing covered, partially covered, uncovered, and explicitly not-applicable acceptance criteria with reasons.',
      'A candidate-only Manual QA workspace baseline and durable version reservation for restart-safe generation; local-only outputs may remain available to testing tools.',
    ],
    transitions: [
      'Checklist Ready → Waiting for Manual QA: A valid durable checklist advances automatically to the user-run verification gate.',
      'Generation, Validation, or Checkpoint Failure → Blocked Error: Failures pause in recoverable error handling. Retry reuses the reserved version and any already valid artifacts.',
      'Cancel → Canceled: Cancellation stops workflow automation while preserving generated artifacts for audit.',
    ],
    notes: [
      'No user action is required in this phase; the preparation workspace presents live milestones, phase logs, and a clickable structured/Raw checklist artifact before handing it to the interactive Manual QA gate.',
      'LoopTroop does not launch or interact with the application being tested. The application remains entirely user-controlled.',
      'Coverage gaps are advisory and do not by themselves block the checklist.',
      'The status title never contains a version suffix. Checklist-backed versions use the same conditional attempt selector pattern as other versioned statuses.',
    ],
  },
  WAITING_MANUAL_QA: {
    overview: 'LoopTroop waits in the interactive Manual QA workspace while the user runs the application, records results and evidence, and verifies the generated checklist. Every item starts Pending with no result-specific fields, draft work autosaves with a visible last-save time, and only Submit or Skip completes the round.',
    steps: [
      'User-Run Verification: The user starts and controls the application outside LoopTroop, follows each item’s prerequisites and actions, and compares observed behavior with the expected result and watch notes.',
      'Focused Default: Pending is the first and default result. It shows only brief guidance; result-specific notes, evidence, waiver, merge-group, and improvement controls appear only after the user chooses another result.',
      'Autosaved Draft: Pass, Fail, Waive, Improvement, Pending, notes, merge groups, improvement drafts, and evidence references save through revision-checked UI state. There is no manual Save action: the workspace reports that saving is automatic and shows a relative last-save time with the exact timestamp available on hover.',
      'Result Validation: Submit requires each required item to be resolved as Pass, Fail, Waive, or Improvement. Pass and Waive require no evidence; Pass notes and waiver reasons are optional. Fail requires an observation, while every Improvement requires a reviewed title and description draft.',
      'Evidence Handling: Extra evidence offers matching Add link and Add files actions; link and Details fields appear only after Add link is chosen. Add files opens the native picker from a dedicated button without unmounting or reloading the checklist. New uploads appear immediately without a refresh, and each item initially shows five evidence entries with Show more/Show less for the rest. Submit and Skip wait for active file uploads/removals, then the server retains every durably stored file and safely omits dangling optional references. Remaining file-integrity errors name the checklist item and filename instead of internal evidence IDs. Only safe raster formats preview inline; unsafe or unknown content is always served as an attachment.',
      'Failure Merge Groups: A failed item can select one or more other checklist items by number and title, including items not yet marked Fail. Submit is blocked until every selected member is also Fail, with each unresolved member identified in the validation message.',
      'Inline Improvement: Improvement editing stays inside the checklist item. Each draft includes a P1–P5 priority selector (P3 Normal by default) and a collapsed Advanced section for the child ticket’s explicit Manual QA enabled/disabled setting, initially resolved from the effective project/profile setting. Manual QA context, final-description preview, and evidence/provenance preview are collapsed by default, as is the workspace’s advisory PRD coverage.',
      'Workspace Drift Gate: Before Submit or Skip, LoopTroop compares project files with the saved QA baseline. Audited application-created drift must be explicitly included in a checkpoint or discarded before the action can continue.',
      'QA-Fix Planning: When any check fails, one locked-main-implementer prompt receives the failed merge groups and focused ticket, PRD, bead, final-test, checklist, evidence-reference, and diff context. At least one successful read-only repository inspection tool call is required so the resulting normal-quality beads can identify newly relevant files.',
      'Submission Journal: Final submission stages immutable results and the operation journal, generates and strictly validates one complete QA-fix bead candidate per failed merge group, then persists canonical `fix-beads.yaml` before creating any child ticket or bead. Only after candidate persistence does LoopTroop create configured Improvement tickets, append normal-shape `qa-fix` beads, write receipts/summary, and transition. Retry resumes the same action without duplicating work.',
      'Waiver and Skip Paths: Required waivers are recorded in a `waived_through` outcome. Skip… warns that no QA fix bead or improvement ticket will be created, then archives every entered result, note, merge-group choice, improvement draft, and evidence reference as read-only even when normal Submit validation is incomplete.',
      'Loop Outcome: Passing, waived-through, or skipped rounds advance to integration. Any explicit Fail creates AI-planned, application-owned QA fix work, archives the current round attempts, and returns the ticket to Coding; successful fixes receive fresh final tests and a new checklist version.',
    ],
    outputs: [
      'Autosaved live draft plus an immutable submission snapshot and canonical versioned results/summary receipts.',
      'Secure evidence metadata and disk-only files, with copied provenance for any created improvement tickets or QA fix work.',
      'A validated canonical `fix-beads.yaml` candidate artifact for failed checks, followed by normal pending `qa-fix` bead records whose lifecycle fields and identifiers are assigned by LoopTroop.',
      'A final outcome of `passed`, `waived_through`, `skipped`, or `created_fixes`, including created fix bead and improvement ticket ids.',
    ],
    transitions: [
      'Pass or Optional-Pending Completion → Preparing Final Commit: With no failures and no required waivers, submission records `passed` and advances to integration.',
      'Required Waivers → Preparing Final Commit: Submission records `waived_through` and advances to integration.',
      'Skip → Preparing Final Commit: Skip bypasses normal result and merge-group validation, archives all entered data read-only, records `skipped`, creates no improvement or QA fix work, and advances to integration.',
      'Any Failure → Implementing: Submission creates full normal-shape Manual QA fix beads from a validated candidate artifact, records `created_fixes`, and returns to Coding. Improvements submitted in the same action remain independent backlog tickets with their chosen priority and Manual QA setting.',
      'QA-Fix Generation or Validation Failure → Blocked Error: No child ticket or bead is created before the complete candidate set is valid and persisted. Retry resumes the exact stored submission action.',
    ],
    notes: [
      'This status is the interactive consumer of the checklist artifact produced by Preparing Manual QA; the producer phase itself remains a concise artifact-and-log review surface.',
      'LoopTroop never starts, stops, previews, or otherwise controls the user’s application.',
      'PRD coverage is advisory and collapsed by default; improvement context and both description/provenance previews are also opt-in disclosures.',
      'Retry notes for normal bead failures remain separate from typed Manual QA origin data.',
      'The status title is version-free. The version selector appears only when more than one checklist-backed round exists, and historical rounds remain selectable read-only after the ticket loops back to Coding or advances.',
      'The phase log is collapsed by default and follows the selected checklist-backed version, including submission, AI/tool, child-creation, completion, and error milestones. When expanded, its height can be manually adjusted up or down.',
    ],
  },
  INTEGRATING_CHANGES: {
    overview: 'LoopTroop refreshes Git-hook evidence, records drift from the approved snapshot, and applies the ticket-run policy before creating the final candidate. Observe bypasses native hooks without separate checks; Check runs approved validations as non-blocking advisories; Require makes those validations a gate; Run lets native hooks participate in Git operations. It then turns bead commits into one clean candidate commit while preserving bead history and the final-test file-effects audit.',
    steps: [
      'Branch Analysis: LoopTroop resolves the ticket worktree and base branch, calculates the merge base (where the ticket branch diverged), and counts the number of individual commits made during bead execution. These internal git commands are audited in `SYS > CMD` as concise completed-command rows.',
      'Final-Test Audit Resolution: LoopTroop checks the latest `final_test_file_effects_audit` before staging. Explicit candidate intent and tracked/staged changes are preserved, local-only outputs remain unstaged, unknown untracked files continue with a warning after one unresolved classification retry, and unresolved tracked changes remain candidates for the PR audit.',
      'Git-Hook Validation And Drift: LoopTroop compares current hooks and manager configuration with the approved backend evidence. Observe records a skip; Check runs approved structured validation commands and continues with warnings on failure or timeout; Require runs the same commands but blocks on failure; Run delegates to native Git hooks. Explicit validations audit worktree changes and restore only mutations they introduced.',
      'Soft Reset: The branch is soft-reset back to the merge base, which unstages all bead-level commits but keeps all file changes in the working directory. This effectively "un-commits" the individual bead commits.',
      'Reviewer-Facing Candidate: Exact audited candidate paths are staged and committed as a single candidate commit with LoopTroop-specific commit metadata. Explicitly intended ignored files can be staged by exact path, while local-only generated/cache/setup outputs remain available but unstaged.',
      'Handoff Metadata: Integration records the candidate SHA, merge base, pre-squash HEAD, and squash statistics. That metadata becomes the source of truth for the next phase, which will push the candidate and create or update the draft PR.',
      'Integration Report: The integration report captures the candidate commit SHA, merge base SHA, pre-squash HEAD, total commit count that was squashed, and file change statistics. This report is persisted for audit and troubleshooting.',
      'Edge Case Handling: If no staged changes exist (e.g., the beads produced no file modifications), or if git operations fail (merge conflicts, corrupt index), the phase records the failure and stops before advancing to PR creation.',
    ],
    outputs: [
      'Integration report artifact with candidate commit SHA, merge base, pre-squash HEAD, commit counts, and file change statistics.',
      'Candidate squash commit on the ticket branch — a single clean commit containing all implementation changes.',
      'Audited final-test candidate files included in the squash commit, while local-only generated/cache/setup files and LoopTroop internals remain on disk but stay out of the PR.',
      'Pre-squash metadata for audit, rollback reference, and troubleshooting.',
    ],
    transitions: [
      'Success → Creating Pull Request: A successful candidate commit advances the workflow to the GitHub sync phase, which creates or updates the draft PR.',
      'Failure → Blocked Error: Git operation failures, empty changesets, or merge conflicts route the ticket to Blocked Error. Local-only final-test outputs do not block integration.',
    ],
    notes: [
      'Context available: Git state, integration metadata, and final test report. No new model context is assembled in this deterministic git phase.',
      'The squash commit preserves all file changes but replaces the individual bead-level commit history with a single clean commit.',
      'Why squash? Individual bead commits are implementation artifacts — they reflect the AI\'s step-by-step execution, not a meaningful commit history for human review. Squashing produces a single commit that represents "what was implemented" as a whole.',
      'The candidate commit is still local at the end of this phase. GitHub branch and PR synchronization happen in the next automatic phase.',
    ],
  },
  CREATING_PULL_REQUEST: {
    overview: 'LoopTroop audits the final candidate files, pushes the approved candidate SHA to the remote ticket branch, and creates or updates a draft pull request on GitHub. This is an automatic GitHub-sync phase: it packages the final diff, the ticket intent, validation results, and any ignored-file decisions into a reviewer-facing draft PR without merging anything yet.',
    steps: [
      'Candidate File Audit: Before any remote side effects, the locked main implementer classifies every final changed file as include, exclude, or review using ticket scope, diff metadata, final-test results, and conservative generated-file rules. Exclusions require evidence; generated or tracked files are kept unless the audit can explain why they are unrelated byproducts.',
      'Filtered Candidate Rewrite: If the audit excludes files, LoopTroop rewrites the local candidate from the merge base using only include/review files, records the ignored files and reasons in `candidate_file_audit`, updates the integration handoff SHA, and captures the final net diff in `candidate_diff` before pushing.',
      'PR Drafting: Before any git or GitHub side effects, the locked main implementer generates a draft PR title and body in a fresh session under the configured AI Response Timeout using only ticket details and PRD as context, with integration report, final test report, diff stat, changed-file status, and diff patch appended as explicit prompt sections. The interview and beads artifacts are not fed to PR drafting.',
      'PR Draft Validation: The draft title/body response is parsed as structured output before branch push or PR create/update. If parsing fails, the ticket\'s configured Structured Output Retries count applies; validation errors may use a continued session prompt, while empty/provider/session failures use a fresh session. If parsing still fails, LoopTroop records diagnostics/raw attempts and falls back to the deterministic title/body instead of blocking the ticket.',
      'Remote Candidate Push: LoopTroop force-pushes the final candidate SHA to the remote ticket branch using a lease, replacing the bead-level backup branch state with the single reviewable candidate commit. Internal push logging records the final result without progress output.',
      'PR Upsert: LoopTroop creates a new draft PR when none exists, or updates the existing PR title/body and metadata when one already exists for the ticket branch.',
      'Metadata Persistence: The PR URL, number, state, head SHA, generated title/body, and timestamps are written into ticket artifacts so the review UI and later phases can reuse them deterministically.',
      'Failure Safety: If the push or GitHub operation fails, LoopTroop preserves the local candidate/worktree state and writes a recovery receipt describing the exact next-safe actions. Git push, branch update, PR create/update, and review-waiting side effects are not automatically retried.',
    ],
    outputs: [
      'Pull Request report artifact with PR URL, state, number, generated title/body, head SHA, and timestamps.',
      'Candidate file audit artifact listing included, excluded, and reviewed files with reasons.',
      'Candidate net diff artifact used by PR review as the default diff view.',
      'Remote ticket branch updated to the final candidate commit.',
      'A draft GitHub pull request ready for human review.',
    ],
    transitions: [
      'Success → Reviewing Pull Request: A successful PR sync advances the workflow to the human PR review gate.',
      'Failure → Blocked Error: Push failures, GitHub auth issues, or PR creation/update failures route the ticket to Blocked Error.',
    ],
    notes: [
      'Context available: Ticket Details + PRD, plus explicit integration report, final test report, diff stat, diff name/status, and diff patch sections.',
      'Candidate file audit starts in its own fresh session and falls back to including all files if the audit output cannot be parsed, so malformed audit text cannot silently remove files.',
      'PR drafting starts in a fresh session after candidate-file auditing. If a matching active CREATING_PULL_REQUEST session exists, LoopTroop aborts and abandons it before creating the first draft session; AI Response Timeout bounds both the initial draft and structured retry prompts, and the draft session is completed before remote side effects begin.',
      'Structured PR draft retries happen before the remote branch push and before PR creation/update. PR draft parse exhaustion records diagnostics and uses fallback text; git/GitHub failures still route to Blocked Error without auto retry.',
      'This is the GitHub-native handoff point between execution and review.',
      'The PR is draft-first by design so later automated review or human review can happen before merge.',
    ],
  },
  WAITING_PR_REVIEW: {
    overview: 'LoopTroop stops automation and waits for you to review the draft pull request before finishing the ticket. This is the last human gate: you can inspect the PR in GitHub, review the net candidate diff, bead activity, ignored-file audit, and test results locally, and then either merge the PR or finish the ticket without merging.',
    steps: [
      'Draft PR Presentation: The workspace shows the PR URL, current PR state, candidate SHA, branch/base refs, integration report, final test summary, candidate-file audit, and final net diff.',
      'Diff Review Modes: The bead commits modal defaults to Net Diff for the actual base-to-candidate PR review surface, while By Bead preserves cumulative implementation activity and By File groups repeated bead touches.',
      'Manual Review: You inspect the draft PR and the local result. There is no time limit; LoopTroop waits for your decision.',
      'Merge Path: Choosing Merge PR & Finish marks the PR ready if needed and merges it into the base branch on GitHub. Once GitHub reports the PR merged, LoopTroop verifies the remote base branch contains the candidate commit and leaves your local checkout untouched.',
      'Finish Without Merge Path: Choosing Finish Without Merge preserves the PR and remote ticket branch exactly as they are, then proceeds directly to cleanup and terminal completion.',
      'External Merge Detection: If the PR is merged manually in GitHub while this phase is open, LoopTroop detects that during polling, skips a second remote merge call, verifies the remote base branch, and continues automatically.',
    ],
    outputs: [
      'A stable draft-PR review gate that exposes the final PR metadata, test results, integration summary, ignored-file audit, and net candidate diff.',
      'A merge report artifact recording whether the ticket completed as merged or closed unmerged.',
      'An explicit human decision before cleanup and terminal completion.',
    ],
    transitions: [
      'Merge PR & Finish → Cleaning Up: GitHub merge succeeds, remote base verification succeeds, and cleanup starts without modifying the local checkout.',
      'Finish Without Merge → Cleaning Up: The ticket closes successfully without merging and cleanup starts.',
      'System Error → Blocked Error: If the GitHub merge itself fails or the remote base branch cannot be verified to contain the candidate commit, the workflow blocks as a PR merge failure. Retry rechecks the remote state without trying to merge the PR again when GitHub already reports it merged.',
    ],
    notes: [
      'Context available: PR metadata, final test report, integration summary, and merge controls. No AI prompt context is assembled in this review gate.',
      'This is the human quality gate for the GitHub-native endgame.',
      'LoopTroop completion does not require deleting the PR or remote branch when you finish without merge.',
      'Internal merge, fetch, push, and cleanup commands appear in `SYS > CMD` as final summaries so the review gate remains auditable without recurring progress chatter.',
    ],
  },
  CLEANING_ENV: {
    overview: 'LoopTroop removes temporary runtime resources created during the ticket run while carefully preserving the artifacts needed for audit, review, and historical reference. This phase is automatic — it runs immediately after verification and does not require user input. Cleanup errors are recorded as a visible warning summary but do not prevent the ticket from completing.',
    steps: [
      'Cleanup Scope Determination: LoopTroop identifies which runtime resources are transient (safe to remove) and which are permanent artifacts (must be preserved). The distinction is based on resource type: runtime state is transient, planning and audit artifacts are permanent.',
      'Transient Resource Removal: Lock files, active session folders, stream buffers, temporary files, and runtime state files are removed when present. These resources were needed during execution but have no long-term value.',
      'Artifact Preservation: Planning artifacts (interview, PRD, beads plan), normal and debug execution logs, test reports, integration reports, and phase log history are intentionally preserved. These remain accessible for review, audit, and reference long after the ticket is closed.',
      'Cleanup Report: A cleanup report artifact is generated detailing what was removed, what was preserved, and whether any cleanup operations failed. The report includes `status: clean` or `status: warning`; warnings are surfaced on the ticket while the workflow still completes.',
    ],
    outputs: [
      'Cleanup report artifact listing all removed and preserved resources, with `status: clean` or `status: warning`.',
      'Freed disk space from transient runtime data (lock files, session folders, temp files).',
      'Intact planning and audit artifacts (interview, PRD, beads, test reports, logs) preserved for future reference.',
    ],
    transitions: [
      'Cleanup Done → Done: Cleanup always advances the workflow to the terminal Done state after writing the report. Any removal failures remain visible as cleanup warnings.',
    ],
    notes: [
      'Context available: Ticket Details + Beads Plan.',
      'Cleanup is conservative — when in doubt, resources are preserved rather than deleted.',
      'The cleanup phase is automatic and does not require user interaction.',
      'Cleanup warnings are housekeeping results, not delivery failures; the ticket status remains Completed.',
    ],
  },
  COMPLETED: {
    overview: 'The ticket has finished its full workflow lifecycle and is now closed as a successful terminal state. All planning, execution, PR, testing, and cleanup artifacts remain accessible for review. The ticket records whether it completed via a merged PR or as a closed-unmerged finish while preserving the full implementation history. Cleanup warnings, when present, are shown as a separate summary without changing the completed status.',
    steps: [
      'Terminal Status: LoopTroop marks the ticket status as "completed" after cleanup finishes. This is a final, irreversible state — the ticket cannot be restarted or modified.',
      'Read-Only Workspace: The workspace becomes read-only from a workflow perspective. No further AI phases will run, no artifacts will be modified, and no new planning or execution occurs.',
      'Full History Access: All lifecycle artifacts remain accessible through the navigator and artifact views — interview results, PRD, beads plan, per-bead execution logs, test reports, integration report, and cleanup report. You can review the entire journey from ticket creation to completion.',
      'Cleanup Summary: The ticket detail payload exposes the latest cleanup status, warning count, and cleanup report artifact id so housekeeping issues remain visible after completion.',
    ],
    outputs: [
      'Terminal "completed" status — the successful end state of the workflow.',
      'Full lifecycle history preserved for review: interview, PRD, beads plan, execution logs, test reports, integration report, pull request report, merge report, and cleanup report.',
      'Cleanup summary showing `clean`, `warning`, or `null` when no cleanup report exists.',
      'Completion metadata indicating whether the ticket finished as merged or closed unmerged.',
    ],
    transitions: [
      'None — this is a terminal state. There are no forward workflow transitions from Completed.',
    ],
    notes: [
      'Reference artifacts available: ticket details, interview results, PRD, beads plan, test reports, integration report, and pull request report.',
      'The completed ticket serves as a permanent record of the implementation process — useful for understanding decisions, reviewing approaches, or learning from the AI\'s workflow.',
    ],
  },
  CANCELED: {
    overview: 'The ticket was stopped by user action before normal completion and now sits in a terminal canceled state. By default, all progress and artifacts created up to the cancellation point are preserved. At cancellation time the user may optionally choose to delete AI-generated artifacts (interview results, PRD drafts, beads plan, worktree code) and/or the execution logs.',
    steps: [
      'Cancellation Recording: LoopTroop records the cancellation event, including the phase from which cancellation was triggered, the timestamp, and any active sessions that were terminated.',
      'Active Session Cleanup: If AI sessions were running when cancellation was triggered (e.g., during a council phase or coding), those sessions are terminated gracefully.',
      'Optional Cleanup: If requested at cancellation time, AI-generated artifacts (interview Q&A, PRD drafts, beads plan, worktree code and its git branch) and/or both execution log files may be permanently deleted. Both options are opt-in and unchecked by default.',
      'History Preservation: Unless the user explicitly chose to delete them, all artifacts generated before cancellation (interview results, PRD drafts, beads plans, execution logs) remain accessible through the navigator.',
      'Terminal State: No more planning or execution actions are allowed once cancellation is finalized. The ticket cannot be restarted from the canceled state.',
    ],
    outputs: [
      'Terminal "canceled" status — the workflow has been permanently stopped by user action.',
      'Preserved history up to the cancellation point — all artifacts generated before cancellation remain accessible unless the user chose to delete them at cancellation time.',
      'No additional workflow progress or artifact generation.',
    ],
    transitions: [
      'None — this is a terminal state. There are no forward workflow transitions from Canceled.',
    ],
    notes: [
      'Context available for reference: Ticket Details only (though all artifacts generated before cancellation are preserved in the workspace by default).',
      'Cancellation is available from most phases — you can cancel during planning, approval, execution, or error recovery.',
      'Canceled tickets cannot be restarted. If you want to retry the work, create a new ticket.',
    ],
  },
  BLOCKED_ERROR: {
    overview: 'A blocking failure interrupted the workflow and LoopTroop is waiting for a human decision. The workspace leads with a cause-specific plain-language explanation—such as an incomplete agent response, coding timeout, provider/environment interruption, exhausted implementation retries, Final Testing failure, or Git finalization failure—plus the recommended available recovery action. Technical messages, codes, diagnostics, and logs remain available in a collapsed details section, and historical occurrences remain read-only.',
    steps: [
      'Error Recording: LoopTroop captures the error message, error codes (if available), the precise timestamp of the failure, and the workflow status where the failure occurred. Provider, model, session, timeout, OpenCode retry, output-truncation, and rate-limit-style diagnostics are persisted as structured fields when the failing subsystem exposes them. If OpenCode streams only a generic provider error, LoopTroop checks matching local OpenCode logs by session id and persists the sanitized provider cause when available. If structured-output validation later fails because OpenCode returned no usable content or stopped with an output-length finish reason, the latest underlying OpenCode failure is preserved instead of replacing it with only the parser wrapper. This information is stored as an error occurrence record.',
      'State Preservation: The blocked error becomes the active workflow state while preserving the previous status (the phase that failed). This preserved status is critical — it tells Retry and eligible Continue exactly which phase to re-enter. Backend, OpenCode, WSL, OS, and machine restarts revalidate an eligible continuation by the unresolved occurrence\'s exact session id and blocked-from phase; transient verification failures keep the session eligible instead of abandoning it.',
      'Error History: If a ticket has been blocked multiple times (e.g., retry → fail → retry → fail), all error occurrences are preserved in a history list. This helps you identify recurring issues and decide whether retry is likely to succeed.',
      'Cause Explanation and Technical Context: Stable workflow events and error codes select a plain-language title, explanation, and recommended recovery without guessing from log prose. Raw error messages, codes, stack traces, surrounding logs, structured provider/model/session diagnostics, and bead-specific context remain available under Technical details.',
      'Decision Point: You choose Retry, Retry with extra note..., Edit setup plan... when workspace setup failed, eligible same-session Continue, or Cancel. For coding, the note is appended to User Retry Notes after safe bead recovery. For workspace setup, only the note is sent to the preserved setup session for one manual attempt. Finalization failures already have their own concise Finalization Failure Note and remain manual Retry/Cancel blocks; Ralph is used only for coding-iteration failures such as the workflow deadline.',
    ],
    outputs: [
      'Error occurrence history with timestamps, error messages, error codes, structured provider/model/session/timeout/OpenCode retry/output-truncation/rate-limit diagnostics when available, log-correlated provider causes when available, and the phase where each failure occurred.',
      'Blocked state metadata linking the error to the specific phase that failed.',
      'Retry, phase-specific Retry with extra note..., setup-plan editing, eligible same-session Continue, or cancel decision point for manual intervention.',
    ],
    transitions: [
      'Retry → Previous Status: Retry archives the active phase attempt with `manual_retry_after_blocked_error`, creates the next active attempt, and returns the workflow to the previously blocked status for every non-implementation phase. CODING keeps its special failed-bead reset before re-entering and does not create phase versions. For a live CODING block, Retry with extra note... performs the same safe recovery and appends a timestamped entry only to User Retry Notes after the bead can be identified and reset; OpenCode retry-budget or provider/session blocks may instead use Continue when the session remains addressable by exact id.',
      'Setup Retry With Note → Preparing Workspace Runtime: Retry with extra note... requires a preserved setup session. It keeps the current phase attempt, sends only the entered note to that session, and allows exactly one additional manual setup attempt. The user note is not appended to setup retry notes or later setup context.',
      'Continue → Previous Status: Continue is available only for eligible OpenCode/provider interruptions with a preserved active session addressable by exact id, including transient provider stalls, provider/session timeouts, selected 5xx/529 or 408/429 responses, transport failures, and `HTTP 402 Payment Required` blocks that can be cleared outside the session. It is not available for CODING workflow-owned iteration timeouts, which reset/retry until the bead budget is exhausted. Eligible sessions survive backend, OpenCode, WSL, OS, and machine restarts when the unresolved error occurrence, previous phase, and exact remote session still match; temporary verification failures preserve the active record for a later check, while only confirmed absence or stale ownership abandons it. Continue returns to the previous status without archiving or creating phase attempts and dispatches exactly `continue please` into that same session. For CODING provider interruptions, the blocked view treats the bead as paused rather than actively counting down; after Continue, LoopTroop starts a fresh per-iteration timeout window while reusing the preserved OpenCode session.',
      'Cancel → Canceled: Cancel moves the ticket to the terminal Canceled state. Artifacts and error history are preserved by default; the cancellation dialog offers optional cleanup of AI-generated artifacts and/or the execution log.',
    ],
    notes: [
      'Past error occurrences remain reviewable even after the ticket moves on (via retry) or is canceled — the error history is never deleted.',
      'Manual retry versions for non-implementation phases are reviewed through the phase previous-version selector; automatic structured retries inside a version are reviewed through artifact Raw attempt tabs, with parser/retry intervention warnings summarized on the primary artifact tab. CODING retry history remains bead-scoped.',
      'Retry with extra note... is shown only on the live Blocked Error view when `previousStatus` is CODING or PREPARING_EXECUTION_ENV. It requires between 1 and 20,000 characters after rejecting whitespace-only input. Coding appends the text unchanged to User Retry Notes and starts a fresh bead recovery. Workspace setup sends it directly to the preserved session for one manual attempt. Historical errors and blocks from other phases do not offer note-bearing retry.',
      'Continue is deliberately narrower than Retry: it is hidden unless the active error has a session id, the matching OpenCode session is preserved locally and addressable by exact id, and diagnostics point to a continuable provider/session condition such as HTTP 402 Payment Required, transient limits, overload, provider/session timeout, selected 5xx/529 or 408/429 responses, or transport interruption rather than a LoopTroop-owned iteration timeout, auth, non-402 quota, configuration, invalid-request, model-not-found, or request-size errors. Restart reconciliation applies this same centralized eligibility classifier to every continuable error type instead of special-casing usage limits.',
      'Final-test file classification is unattended: explicit candidate intent and tracked/staged changes are preserved, recognized local outputs stay on disk but out of delivery, unknown untracked files receive one classification retry and then a warning, and unresolved tracked changes remain candidates for PR audit.',
      'Context available: Current Bead Data (if the failure occurred during the coding phase) + Error Context (error message, codes, phase, timing).',
      'Common causes of blocked errors: provider or model failures, session interruptions, model timeouts, output-length truncation, rate-limit-style failures, API connectivity issues, malformed AI output that fails validation, git operation failures, test failures, and dependency graph violations.',
      'Tip: Before retrying, check the error details. If the error is a transient issue (timeout, connectivity), retry is likely to succeed. If the error indicates a fundamental problem (malformed output, missing configuration), retry may fail again.',
    ],
  },
} satisfies Record<string, WorkflowPhaseDetails>

export const WORKFLOW_GROUPS: WorkflowGroupMeta[] = [
  { id: 'todo', label: 'To Do' },
  { id: 'discovery', label: 'Discovery' },
  { id: 'interview', label: 'Interview' },
  { id: 'prd', label: 'Specs (PRD)' },
  { id: 'beads', label: 'Blueprint (Beads)' },
  { id: 'pre_implementation', label: 'Pre-Implementation' },
  { id: 'implementation', label: 'Implementation' },
  { id: 'post_implementation', label: 'Post-Implementation' },
  { id: 'done', label: 'Done' },
  { id: 'errors', label: 'Errors' },
]

const DRAFTING_PRD_CONTEXT_SECTIONS = [
  {
    label: 'Part 1',
    description: 'Answering Skipped Questions',
    keys: ['relevant_files', 'ticket_details', 'interview'],
  },
  {
    label: 'Part 2',
    description: 'Generating PRD Drafts',
    keys: ['relevant_files', 'ticket_details', 'full_answers'],
  },
] as const satisfies readonly WorkflowContextSection[]

const VERIFYING_BEADS_COVERAGE_CONTEXT_SECTIONS = [
  {
    label: 'Coverage Review',
    description: 'Checking Blueprint Against PRD',
    keys: ['prd', 'beads'],
  },
] as const satisfies readonly WorkflowContextSection[]

const EXPANDING_BEADS_CONTEXT_SECTIONS = [
  {
    label: 'Expansion',
    description: 'Transforming Blueprint into Execution-Ready Beads',
    keys: ['relevant_files', 'ticket_details', 'prd', 'beads_draft'],
  },
] as const satisfies readonly WorkflowContextSection[]

function getSafeResumeDescription(phase: Pick<WorkflowPhaseMeta, 'id' | 'kanbanPhase'>): string {
  if (phase.id === 'DRAFT') {
    return 'No automation is running; browser or server restarts reload the saved ticket fields.'
  }
  if (phase.id === 'CODING') {
    return 'After backend or OpenCode restart, LoopTroop finalizes only a current matching in-progress bead checkpoint; otherwise it resets the bead to its bead start commit, preserves retry notes, and continues from the next runnable bead. If no reset anchor exists, it blocks instead of reusing dirty work.'
  }
  if (phase.id === 'BLOCKED_ERROR') {
    return 'Retry is allowed only when the failed previous status is known from durable state. Continue is shown only when a matching active OpenCode session is preserved and addressable by exact id for a resumable provider/session interruption, including OpenCode retry-budget/provider stalls and provider timeouts; eligible sessions survive backend, OpenCode, WSL, OS, and machine restarts when the unresolved occurrence still matches, and transient verification failures are preserved for a later check. LoopTroop-owned CODING iteration timeouts reset/retry instead.'
  }
  if (phase.id === 'COMPLETED') {
    return 'This terminal result is read-only and reloads from stored artifacts after any restart.'
  }
  if (phase.id === 'CANCELED') {
    return 'This terminal cancellation is read-only; partial artifacts remain available after restart, but automation does not resume.'
  }
  if (phase.kanbanPhase === 'needs_input') {
    return 'No background model work should be active; browser/frontend restarts reload the saved artifact or UI draft, and backend restarts keep waiting for the same user action.'
  }
  return 'Backend or OpenCode restarts rehydrate the ticket actor and rerun or reconnect this phase from durable artifacts; unrecoverable state moves to Blocked Error.'
}

function withSafeResumeMetadata(phase: WorkflowPhaseMeta): WorkflowPhaseMeta {
  const safeResume = getSafeResumeDescription(phase)
  const preservesVerbatimDescription = phase.id === 'GENERATING_QA_CHECKLIST'
    || phase.id === 'WAITING_MANUAL_QA'
  return {
    ...phase,
    description: preservesVerbatimDescription
      ? phase.description
      : `${phase.description} Safe resume: ${safeResume}`,
    details: {
      ...phase.details,
      notes: [...(phase.details.notes ?? []), `Safe resume: ${safeResume}`],
    },
  }
}

const BASE_WORKFLOW_PHASES: WorkflowPhaseMeta[] = [
  {
    id: 'DRAFT',
    label: 'Backlog',
    description: 'Ticket created but inactive; its saved title and description will seed AI context when the backlog item starts.',
    details: WORKFLOW_PHASE_DETAILS.DRAFT,
    kanbanPhase: 'todo',
    groupId: 'todo',
    uiView: 'draft',
    editable: true,
    multiModelLogs: false,
    contextSummary: ['ticket_details'],
  },
  {
    id: 'SCANNING_RELEVANT_FILES',
    label: 'Scanning Relevant Files',
    description: 'The locked main implementer scans the codebase under AI Response Timeout and extracts relevant file paths, excerpts, and rationales. Configured structured scan retries are preserved in Raw attempts, while retry warnings remain on the Files tab and the shared context artifact contains only accepted normalized files.',
    details: WORKFLOW_PHASE_DETAILS.SCANNING_RELEVANT_FILES,
    kanbanPhase: 'in_progress',
    groupId: 'discovery',
    uiView: 'council',
    editable: true,
    multiModelLogs: false,
    contextSummary: ['ticket_details'],
  },
  {
    id: 'COUNCIL_DELIBERATING',
    label: 'Council Drafting Questions',
    description: 'Each council member independently drafts interview questions in parallel and may confirm missing repository facts through focused read-only inspection; accepted drafts become artifacts, while invalid outputs keep only diagnostics and raw-attempt history.',
    details: WORKFLOW_PHASE_DETAILS.COUNCIL_DELIBERATING,
    kanbanPhase: 'in_progress',
    groupId: 'interview',
    uiView: 'council',
    editable: true,
    multiModelLogs: true,
    contextSummary: ['relevant_files', 'ticket_details'],
  },
  {
    id: 'COUNCIL_VOTING_INTERVIEW',
    label: 'Voting on Questions',
    description: 'Council members score all anonymized interview drafts against a structured rubric to select the strongest candidate; previous draft Raw views show only validated draft content.',
    details: WORKFLOW_PHASE_DETAILS.COUNCIL_VOTING_INTERVIEW,
    kanbanPhase: 'in_progress',
    groupId: 'interview',
    uiView: 'council',
    editable: true,
    multiModelLogs: true,
    contextSummary: ['relevant_files', 'ticket_details', 'drafts'],
  },
  {
    id: 'COMPILING_INTERVIEW',
    label: 'Refining Interview',
    description: 'The winning interview draft is normalized into an interactive session and may use focused read-only inspection to confirm repository facts; previous draft Raw views stay aligned to the validated content consumed by refinement.',
    details: WORKFLOW_PHASE_DETAILS.COMPILING_INTERVIEW,
    kanbanPhase: 'in_progress',
    groupId: 'interview',
    uiView: 'council',
    editable: true,
    multiModelLogs: false,
    contextSummary: ['relevant_files', 'ticket_details', 'drafts'],
  },
  {
    id: 'WAITING_INTERVIEW_ANSWERS',
    label: 'Interviewing',
    description: 'Answer the interview questions that will shape the PRD. The live model may confirm relevant repository facts read-only when preparing a next batch, while your decisions remain authoritative. Draft answers autosave with visible state and last-save time. Non-final submissions can keep you here with another batch; completed interviews move to coverage, and coverage follow-ups can return here later.',
    details: WORKFLOW_PHASE_DETAILS.WAITING_INTERVIEW_ANSWERS,
    kanbanPhase: 'needs_input',
    groupId: 'interview',
    uiView: 'interview_qa',
    editable: true,
    multiModelLogs: false,
    progressKind: 'questions',
    contextSummary: ['ticket_details'],
  },
  {
    id: 'VERIFYING_INTERVIEW_COVERAGE',
    label: 'Coverage Check (Interview)',
    description: 'Coverage check for interview completeness; may confirm repository facts through focused read-only inspection and add targeted follow-up questions before approval. The live workspace title shows the current pass when known.',
    details: WORKFLOW_PHASE_DETAILS.VERIFYING_INTERVIEW_COVERAGE,
    kanbanPhase: 'in_progress',
    groupId: 'interview',
    uiView: 'council',
    editable: true,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'user_answers', 'interview'],
  },
  {
    id: 'WAITING_INTERVIEW_APPROVAL',
    label: 'Approving Interview',
    description: 'Review and approve the final interview Q&A before PRD drafting starts. Draft edits autosave with visible state and last-save time, but explicit Save is required to update the authoritative artifact. Approval requires the reviewed content hash; stale hashes return 409. Edits write user-edit receipts, and post-approval edits archive the current version before restarting downstream PRD planning.',
    details: WORKFLOW_PHASE_DETAILS.WAITING_INTERVIEW_APPROVAL,
    kanbanPhase: 'needs_input',
    groupId: 'interview',
    uiView: 'approval',
    editable: true,
    multiModelLogs: false,
    reviewArtifactType: 'interview',
    contextSummary: [],
  },
  {
    id: 'DRAFTING_PRD',
    label: 'Council Drafting Specs',
    description: 'Models produce per-model Full Answers artifacts and competing PRD drafts. Full Answers and PRD drafting may use focused read-only repository inspection when relevant files cannot support a needed concrete technical fact; invalid Full Answers skip that member\'s PRD draft after configured structured retries and malformed bodies stay in Raw diagnostics only.',
    details: WORKFLOW_PHASE_DETAILS.DRAFTING_PRD,
    kanbanPhase: 'in_progress',
    groupId: 'prd',
    uiView: 'council',
    editable: true,
    multiModelLogs: true,
    contextSummary: mergeContextSections(DRAFTING_PRD_CONTEXT_SECTIONS),
    contextSections: DRAFTING_PRD_CONTEXT_SECTIONS,
  },
  {
    id: 'COUNCIL_VOTING_PRD',
    label: 'Voting on Specs',
    description: 'Council members score all anonymized PRD drafts against a weighted rubric to select the strongest specification baseline; previous draft Raw views show only validated draft content.',
    details: WORKFLOW_PHASE_DETAILS.COUNCIL_VOTING_PRD,
    kanbanPhase: 'in_progress',
    groupId: 'prd',
    uiView: 'council',
    editable: true,
    multiModelLogs: true,
    contextSummary: ['relevant_files', 'ticket_details', 'interview', 'drafts'],
  },
  {
    id: 'REFINING_PRD',
    label: 'Refining Specs',
    description: 'Winning draft is consolidated into PRD Candidate v1 using useful ideas from losing drafts and, when needed, focused read-only repository inspection; previous draft Raw views are validated-only, while refinement retries remain inspectable.',
    details: WORKFLOW_PHASE_DETAILS.REFINING_PRD,
    kanbanPhase: 'in_progress',
    groupId: 'prd',
    uiView: 'council',
    editable: true,
    multiModelLogs: false,
    contextSummary: ['relevant_files', 'ticket_details', 'full_answers', 'drafts'],
  },
  {
    id: 'VERIFYING_PRD_COVERAGE',
    label: 'Coverage Check (PRD)',
    description: 'LoopTroop checks the current PRD candidate against the winning model\'s Full Answers artifact, using focused read-only repository inspection only when needed to confirm repository-specific claims. It normalizes safe revision metadata and revises in-phase until clean or the configured cap is reached.',
    details: WORKFLOW_PHASE_DETAILS.VERIFYING_PRD_COVERAGE,
    kanbanPhase: 'in_progress',
    groupId: 'prd',
    uiView: 'council',
    editable: true,
    multiModelLogs: false,
    contextSummary: ['full_answers', 'prd'],
  },
  {
    id: 'WAITING_PRD_APPROVAL',
    label: 'Approving Specs',
    description: 'Review and approve the PRD candidate before architecture planning starts. Draft edits autosave with visible state and last-save time, but explicit Save is required to update the authoritative artifact. Approval requires the reviewed content hash; stale hashes return 409. The winning Full Answers artifact is reference context, edits write user-edit receipts, and unresolved coverage gaps can be sent through optional one-click extra fixes before approval.',
    details: WORKFLOW_PHASE_DETAILS.WAITING_PRD_APPROVAL,
    kanbanPhase: 'needs_input',
    groupId: 'prd',
    uiView: 'approval',
    editable: true,
    multiModelLogs: false,
    reviewArtifactType: 'prd',
    contextSummary: [],
  },
  {
    id: 'DRAFTING_BEADS',
    label: 'Council Drafting Blueprint',
    description: 'Each council member independently decomposes the approved PRD into a semantic beads blueprint and may use focused read-only repository inspection when relevant files lack needed evidence; accepted blueprints advance, while invalid bodies are shown only as diagnostics/raw attempts.',
    details: WORKFLOW_PHASE_DETAILS.DRAFTING_BEADS,
    kanbanPhase: 'in_progress',
    groupId: 'beads',
    uiView: 'council',
    editable: true,
    multiModelLogs: true,
    contextSummary: ['relevant_files', 'ticket_details', 'prd'],
  },
  {
    id: 'COUNCIL_VOTING_BEADS',
    label: 'Voting on Blueprint',
    description: 'Council members score all anonymized beads blueprints against an architecture rubric to select the best implementation plan; previous blueprint Raw views show only validated content.',
    details: WORKFLOW_PHASE_DETAILS.COUNCIL_VOTING_BEADS,
    kanbanPhase: 'in_progress',
    groupId: 'beads',
    uiView: 'council',
    editable: true,
    multiModelLogs: true,
    contextSummary: ['relevant_files', 'ticket_details', 'prd', 'drafts'],
  },
  {
    id: 'REFINING_BEADS',
    label: 'Refining Blueprint',
    description: 'Winning draft is consolidated into the final semantic beads blueprint using the strongest ideas from losing drafts and, when needed, focused read-only repository inspection; previous blueprint Raw views are validated-only.',
    details: WORKFLOW_PHASE_DETAILS.REFINING_BEADS,
    kanbanPhase: 'in_progress',
    groupId: 'beads',
    uiView: 'council',
    editable: true,
    multiModelLogs: false,
    contextSummary: ['relevant_files', 'ticket_details', 'prd', 'drafts'],
  },
  {
    id: 'VERIFYING_BEADS_COVERAGE',
    label: 'Coverage Check (Beads)',
    description: 'LoopTroop checks the semantic beads blueprint against the approved PRD, using focused read-only inspection when required. Missing requirements become automatic revision gaps; once coverage is clean or the pass cap is reached, the workflow advances to expansion.',
    details: WORKFLOW_PHASE_DETAILS.VERIFYING_BEADS_COVERAGE,
    kanbanPhase: 'in_progress',
    groupId: 'beads',
    uiView: 'council',
    editable: true,
    multiModelLogs: false,
    contextSummary: mergeContextSections(VERIFYING_BEADS_COVERAGE_CONTEXT_SECTIONS),
    contextSections: VERIFYING_BEADS_COVERAGE_CONTEXT_SECTIONS,
  },
  {
    id: 'EXPANDING_BEADS',
    label: 'Expanding Blueprint',
    description: 'LoopTroop transforms the coverage-validated semantic blueprint into execution-ready bead records with commands, file targets, dependency graphs, and runtime metadata, using focused read-only inspection only when supplied context cannot confirm an execution detail.',
    details: WORKFLOW_PHASE_DETAILS.EXPANDING_BEADS,
    kanbanPhase: 'in_progress',
    groupId: 'beads',
    uiView: 'council',
    editable: true,
    multiModelLogs: false,
    contextSummary: mergeContextSections(EXPANDING_BEADS_CONTEXT_SECTIONS),
    contextSections: EXPANDING_BEADS_CONTEXT_SECTIONS,
  },
  {
    id: 'WAITING_BEADS_APPROVAL',
    label: 'Approving Blueprint',
    description: 'Review and approve the full execution-ready beads plan with content-hash protection. Draft edits autosave with visible state and last-save time, but explicit Save is required to update the authoritative artifact. The reviewed JSONL hash is recorded before coding begins.',
    details: WORKFLOW_PHASE_DETAILS.WAITING_BEADS_APPROVAL,
    kanbanPhase: 'needs_input',
    groupId: 'beads',
    uiView: 'approval',
    editable: true,
    multiModelLogs: false,
    reviewArtifactType: 'beads',
    contextSummary: [],
  },
  {
    id: 'PRE_FLIGHT_CHECK',
    label: 'Checking Readiness',
    description: 'Validates the execution environment before coding begins: workspace health, worktree cleanliness, coding-agent connectivity, an execution-mode session probe, bead artifact availability, and dependency-graph integrity. No ticket planning context is assembled — the only AI interaction is a minimal connectivity probe.',
    details: WORKFLOW_PHASE_DETAILS.PRE_FLIGHT_CHECK,
    kanbanPhase: 'in_progress',
    groupId: 'pre_implementation',
    uiView: 'coding',
    editable: true,
    multiModelLogs: false,
    contextSummary: [],
  },
  {
    id: 'WAITING_EXECUTION_SETUP_APPROVAL',
    label: 'Approving Workspace Setup',
    description: 'Review a current-host setup plan with structured commands, workspace-input previews, backend-detected Git evidence, and an editable ticket-run hook policy. Draft edits autosave with visible state and last-save time, but explicit Save is required to update the authoritative artifact. Invalid AI drafts stay here with diagnostics and Regenerate instead of blocking the ticket. Approval refreshes host and hook evidence, then content-hash locks the exact reviewed decision.',
    details: WORKFLOW_PHASE_DETAILS.WAITING_EXECUTION_SETUP_APPROVAL,
    kanbanPhase: 'needs_input',
    groupId: 'pre_implementation',
    uiView: 'approval',
    editable: true,
    multiModelLogs: false,
    reviewArtifactType: 'execution_setup_plan',
    contextSummary: [],
  },
  {
    id: 'PREPARING_EXECUTION_ENV',
    label: 'Preparing Workspace Runtime',
    description: 'Materializes approved non-reproducible inputs, applies structured PATH and environment settings, and runs direct programs or an explicitly selected host shell. The agent must finish with an honest Ready or Blocked result. The approved host, hook policy, evidence, and probes remain backend-owned; only genuine runtime failures can block execution.',
    details: WORKFLOW_PHASE_DETAILS.PREPARING_EXECUTION_ENV,
    kanbanPhase: 'in_progress',
    groupId: 'pre_implementation',
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'beads', 'execution_setup_plan', 'execution_setup_notes'],
  },
  {
    id: 'CODING',
    label: 'Implementing (Bead ?/?)',
    description: 'Executes beads one at a time, independently runs every declared test command after a model `done/pass` marker through the setup wrapper, and returns failures to the same session within the shared iteration deadline. Deadline failures use fresh-session Ralph recovery; all-passing receipts permit local finalization. Failed iterations, user retries, and finalization failures remain separate append-only histories.',
    details: WORKFLOW_PHASE_DETAILS.CODING,
    kanbanPhase: 'in_progress',
    groupId: 'implementation',
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    progressKind: 'beads',
    contextSummary: ['bead_data', 'bead_notes'],
  },
  {
    id: 'RUNNING_FINAL_TEST',
    label: 'Testing Implementation',
    description: 'Generates and runs whole-ticket tests as structured current-host commands with explicit working directories, environment, shell choice, and timeouts, while preserving candidate changes and keeping generated/cache/setup-local outputs outside delivery.',
    details: WORKFLOW_PHASE_DETAILS.RUNNING_FINAL_TEST,
    kanbanPhase: 'in_progress',
    groupId: 'post_implementation',
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'prd', 'beads', 'final_test_notes'],
  },
  {
    id: 'GENERATING_QA_CHECKLIST',
    label: 'Preparing Manual QA',
    description: 'LoopTroop is preparing a candidate-only checkpoint and human-facing Manual QA checklist while keeping local generated/cache outputs available to tests and outside delivery.',
    details: WORKFLOW_PHASE_DETAILS.GENERATING_QA_CHECKLIST,
    kanbanPhase: 'in_progress',
    groupId: 'post_implementation',
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    reviewArtifactType: 'manual_qa_checklist',
    contextSummary: ['ticket_details', 'prd', 'beads', 'tests', 'manual_qa_previous'],
  },
  {
    id: 'WAITING_MANUAL_QA',
    label: 'Manual QA',
    description: 'LoopTroop is waiting for user-run verification in an autosaved checklist with collapsed resizable logs, explicit Not applicable PRD coverage, configurable Improvement tickets, and AI-planned full QA-fix beads for failed checks.',
    details: WORKFLOW_PHASE_DETAILS.WAITING_MANUAL_QA,
    kanbanPhase: 'needs_input',
    groupId: 'post_implementation',
    uiView: 'manual_qa',
    editable: false,
    multiModelLogs: false,
    reviewArtifactType: 'manual_qa_checklist',
    contextSummary: ['manual_qa_checklist', 'manual_qa_results'],
  },
  {
    id: 'INTEGRATING_CHANGES',
    label: 'Preparing Final Commit',
    description: 'Refreshes Git-hook drift evidence, applies the approved Observe, Check, Require, or Run-hooks behavior, and exactly stages audited candidates into one clean commit; advisory failures warn while required checks and native hooks may block.',
    details: WORKFLOW_PHASE_DETAILS.INTEGRATING_CHANGES,
    kanbanPhase: 'in_progress',
    groupId: 'post_implementation',
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'prd', 'beads', 'tests'],
  },
  {
    id: 'CREATING_PULL_REQUEST',
    label: 'Creating Pull Request',
    description: 'Auditing candidate files, recording ignored-file reasons, drafting PR title/body under AI Response Timeout, then pushing the final candidate branch and creating or updating the draft PR.',
    details: WORKFLOW_PHASE_DETAILS.CREATING_PULL_REQUEST,
    kanbanPhase: 'in_progress',
    groupId: 'post_implementation',
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'prd'],
  },
  {
    id: 'WAITING_PR_REVIEW',
    label: 'Reviewing Pull Request',
    description: 'Review the draft PR, final net diff, bead activity views, ignored-file audit, and test results before choosing Merge PR & Finish or Finish Without Merge.',
    details: WORKFLOW_PHASE_DETAILS.WAITING_PR_REVIEW,
    kanbanPhase: 'needs_input',
    groupId: 'post_implementation',
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'interview', 'prd', 'beads', 'tests'],
  },
  {
    id: 'CLEANING_ENV',
    label: 'Cleaning Up',
    description: 'Removes transient runtime resources while preserving permanent artifacts. Cleanup warnings are recorded in `cleanup.status` and surfaced on the ticket without blocking completion.',
    details: WORKFLOW_PHASE_DETAILS.CLEANING_ENV,
    kanbanPhase: 'in_progress',
    groupId: 'post_implementation',
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'beads'],
  },
  {
    id: 'COMPLETED',
    label: 'Done',
    description: 'The workflow reached its successful terminal state. All planning, execution, PR, and cleanup artifacts remain accessible, and any cleanup warning summary stays visible without changing completion.',
    details: WORKFLOW_PHASE_DETAILS.COMPLETED,
    kanbanPhase: 'done',
    groupId: 'done',
    uiView: 'done',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'interview', 'prd', 'beads', 'tests'],
  },
  {
    id: 'CANCELED',
    label: 'Canceled',
    description: 'Ticket canceled by user action. Artifacts are preserved by default; optional cleanup is available at cancellation time.',
    details: WORKFLOW_PHASE_DETAILS.CANCELED,
    kanbanPhase: 'done',
    groupId: 'done',
    uiView: 'canceled',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details'],
  },
  {
    id: 'BLOCKED_ERROR',
    label: 'Error (reason)',
    description: 'A workflow phase failed and needs a recovery decision. Local-only generated/cache file classification never enters this status; other failures show their captured error and available recovery actions.',
    details: WORKFLOW_PHASE_DETAILS.BLOCKED_ERROR,
    kanbanPhase: 'needs_input',
    groupId: 'errors',
    uiView: 'error',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['bead_data', 'error_context'],
  },
]

export const WORKFLOW_PHASES: WorkflowPhaseMeta[] = BASE_WORKFLOW_PHASES.map(withSafeResumeMetadata)

export const WORKFLOW_PHASE_IDS = WORKFLOW_PHASES.map((phase) => phase.id)

export const WORKFLOW_PHASE_MAP = Object.fromEntries(
  WORKFLOW_PHASES.map((phase) => [phase.id, phase]),
) as Record<string, WorkflowPhaseMeta>

/** Returns the full phase metadata for a given status ID, or `undefined` if the status is unknown. */
export function getWorkflowPhaseMeta(status: string): WorkflowPhaseMeta | undefined {
  return WORKFLOW_PHASE_MAP[status]
}

export type WorkflowAction =
  | 'start'
  | 'approve'
  | 'cancel'
  | 'retry'
  | 'edit_execution_setup_plan'
  | 'continue'
  | 'merge'
  | 'close_unmerged'

/** Returns `true` when `status` precedes the execution band (before PRE_FLIGHT_CHECK). Resolves BLOCKED_ERROR via `previousStatus`. */
export function isBeforeExecution(status: string, previousStatus?: string | null, depth?: number): boolean {
  if (status === 'BLOCKED_ERROR' && previousStatus) {
    // Guard against infinite recursion if both statuses are BLOCKED_ERROR
    if (previousStatus === 'BLOCKED_ERROR' || (depth ?? 0) >= 1) return false
    return isBeforeExecution(previousStatus, null, (depth ?? 0) + 1)
  }
  const index = WORKFLOW_PHASE_IDS.indexOf(status)
  const executionIndex = WORKFLOW_PHASE_IDS.indexOf('PRE_FLIGHT_CHECK')
  return index >= 0 && executionIndex >= 0 && index < executionIndex
}

/** Returns `true` when `currentStatus` is at or past `targetStatus` in the linear workflow order. */
export function isStatusAtOrPast(currentStatus: string, targetStatus: string): boolean {
  const currentIndex = WORKFLOW_PHASE_IDS.indexOf(currentStatus)
  const targetIndex = WORKFLOW_PHASE_IDS.indexOf(targetStatus)
  return currentIndex >= 0 && targetIndex >= 0 && currentIndex >= targetIndex
}

/**
 * Returns the statically-known available workflow actions for a given status.
 *
 * NOTE: The server may dynamically add `'continue'` to BLOCKED_ERROR actions
 * when a resumable OpenCode session is available — see
 * `server/storage/ticketQueries.ts`. Final-test local-only files are resolved
 * automatically and do not add recovery actions.
 */
export function getAvailableWorkflowActions(status: string): WorkflowAction[] {
  switch (status) {
    case 'DRAFT':
      return ['start', 'cancel']
    case 'WAITING_INTERVIEW_APPROVAL':
    case 'WAITING_PRD_APPROVAL':
    case 'WAITING_BEADS_APPROVAL':
    case 'WAITING_EXECUTION_SETUP_APPROVAL':
      return ['approve', 'cancel']
    case 'WAITING_PR_REVIEW':
      return ['merge', 'close_unmerged', 'cancel']
    case 'BLOCKED_ERROR':
      return ['retry', 'cancel']
    case 'COMPLETED':
    case 'CANCELED':
      return []
    default:
      return ['cancel']
  }
}
