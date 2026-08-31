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
type WorkflowUIView = 'draft' | 'council' | 'interview_qa' | 'approval' | 'phase_review' | 'coding' | 'manual_qa' | 'error' | 'done' | 'canceled'
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
  // No phase asks for council votes today, so no model ever receives them. The
  // key keeps its label and its context-builder branch so a phase can request
  // votes later, which takes three things: something has to populate
  // `TicketState.votes`, the phase has to list `'votes'` in `PHASE_ALLOWLISTS`
  // (`server/opencode/contextBuilder.ts`), and the prompt has to list it in its
  // `contextInputs`. Listing it in a phase's `contextSummary` only adds a row to
  // the Details dialog.
  | 'votes'
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
  /**
   * Set only on the statuses that mean the workflow is over: nothing will run
   * again, Cancel is refused, and the ticket can be deleted.
   *
   * Deliberately not read off `kanbanPhase === 'done'`. The board column is a
   * display choice, so grouping a status under Done for presentation must never
   * be what decides whether a person can delete a ticket or is refused a cancel.
   */
  terminal?: true
  /**
   * Set only on the statuses that hold a project's single execution slot.
   *
   * Cannot be derived from `kanbanPhase` or `groupId`: the band spans three
   * kanban columns, and most `in_progress` statuses sit outside it. It is its
   * own fact about a phase, so it is recorded as one.
   */
  executionBand?: true
  uiView: WorkflowUIView
  editable: boolean
  multiModelLogs: boolean
  reviewArtifactType?: ReviewArtifactType
  progressKind?: 'questions' | 'beads'
  /** Context keys whose descriptions are shown in the "Context" section of the Details dialog. */
  contextSummary: readonly WorkflowContextKey[]
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
    overview: 'This is the quiet backlog state. Nothing is running yet. You can still rewrite the ticket, change priority, or adjust ticket-level settings before LoopTroop locks the saved title and description and starts the workflow.',
    steps: [
      'Ticket record: LoopTroop stores the title and description as the seed context for later planning. Priority, project assignment, settings, and provenance stay as operational metadata.',
      'Editable window: You can still change the ticket freely in this state. When you click Start, the current title and description become the Ticket Details context used by the workflow.',
      'Model selection: The project configuration already points to a main implementer and council members, but those choices are locked only when the ticket starts.',
      'Start handoff: Starting the ticket creates the workspace state on disk and moves the workflow into the first active planning step.',
    ],
    outputs: [
      'Saved ticket metadata, including title, description, priority, project, and ticket-level settings.',
      'No planning or execution artifacts yet. There is no interview, PRD, beads plan, or runtime worktree.',
      'A backlog ticket that remains fully user-controlled until Start or Cancel.',
    ],
    transitions: [
      'Start → Scanning Relevant Files: LoopTroop locks the current configuration, creates the initial workspace state, and begins planning.',
      'Cancel → Canceled: The ticket stops here without entering the workflow.',
    ],
    notes: [
      'No background AI work runs here.',
      'No AI-owned workspace or runtime files are expected yet.',
      'Context available later: Ticket Details only.',
      'A clear ticket description makes every later phase better.',
    ],
  },
  SCANNING_RELEVANT_FILES: {
    overview: 'LoopTroop starts by finding the files that matter to this ticket. The goal is to ground later planning in real code instead of guesses.',
    steps: [
      'Prompt setup: The main implementer receives the saved ticket details and is asked to identify the files most relevant to the requested work.',
      'Read-only scan: The model returns file paths, short excerpts, relevance levels, and plain-language reasons for why each file matters.',
      'Validation and retries: LoopTroop checks the structured response, keeps accepted results, and records rejected attempts and diagnostics when retries are needed.',
      'Artifact writing: The accepted result is saved as the shared relevant-files artifact that later interview, PRD, and beads phases can reuse.',
      'UI summary: A companion summary is stored so the ticket view can show what was found without making you open raw artifacts first.',
    ],
    outputs: [
      'Canonical `relevant-files.yaml` in the ticket workspace.',
      'A structured scan artifact with accepted files, excerpts, relevance levels, reasons, and raw retry history.',
      'Phase logs with prompt timing, validation, and diagnostics.',
    ],
    transitions: [
      'Success → Council Drafting Questions: The accepted scan becomes shared planning context for the interview council.',
      'Failure → Blocked Error: If the scan cannot produce a valid result, the ticket pauses for manual recovery.',
    ],
    notes: [
      'This is a single-model phase. The council has not started yet.',
      'The scan is read-only. It does not change repository files.',
      'Context available: Ticket Details only.',
      'Without this step, the later planning phases would have to reason from the ticket alone.',
    ],
  },
  COUNCIL_DELIBERATING: {
    overview: 'The council is drafting competing interview question sets in parallel. Each model works alone so the workflow can compare genuinely different ways to clarify the ticket.',
    steps: [
      'Shared context: Every council member gets the same ticket details and relevant-files artifact.',
      'Independent drafting: Each model proposes its own questions, ordering, and reasoning. It may inspect a small part of the repository read-only if the provided context does not prove a repository fact.',
      'Progress tracking: LoopTroop streams progress and watches quorum so it can stop early if too many drafts fail.',
      'Validation and retries: Drafts are validated against the expected schema. Malformed attempts stay diagnostic-only and retries run in fresh sessions.',
      'Artifact persistence: Accepted drafts are stored for the vote, along with model identity, progress, and raw attempt history.',
    ],
    outputs: [
      'Competing interview drafts from the council members.',
      'Per-model progress and logs for the drafting run.',
      'Stored draft artifacts for the next voting phase, plus rejected raw attempts and diagnostics.',
    ],
    transitions: [
      'Quorum Met → Voting on Questions: The workflow advances once enough valid drafts exist to score.',
      'Quorum Failure → Blocked Error: If too few valid drafts survive, the ticket pauses for recovery.',
      'Cancel → Canceled: User cancellation stops the active drafting work.',
    ],
    notes: [
      'This is the first multi-model phase in the workflow.',
      'Council members do not see each other\'s drafts while this phase is running.',
      'Malformed output stays diagnostic-only. It does not appear as a usable draft.',
      'Context available: Relevant Files and Ticket Details, with focused read-only repository inspection only when needed.',
    ],
    equivalents: [
      'This is the drafting step of the Interview phase. The same pattern repeats later for PRD drafts and beads blueprints.',
      'All three drafting phases follow the same rhythm: independent generation, quorum check, then voting.',
    ],
  },
  COUNCIL_VOTING_INTERVIEW: {
    overview: 'The council is choosing the strongest interview draft. Drafts are anonymized and shuffled so the vote is about quality, not authorship or position.',
    steps: [
      'Anonymization: LoopTroop strips authorship and assigns neutral draft labels.',
      'Random order: Each voter sees the drafts in a different order to reduce position bias.',
      'Independent scoring: Every council member scores every draft against the interview rubric and writes a short justification.',
      'Validation and retries: Vote payloads are validated, and malformed votes are retried in fresh sessions while rejected attempts stay in Raw diagnostics.',
      'Winner selection: The resolver totals the scores, applies tie-break rules when needed, and records the winning draft plus the audit trail.',
    ],
    outputs: [
      'Voting artifacts with rubric scores, rankings, and justifications.',
      'A winning interview draft reference for the refinement step.',
      'Audit data showing how the council reached the result.',
    ],
    transitions: [
      'Winner Selected → Refining Interview: The chosen draft moves into normalization.',
      'Voting Failure → Blocked Error: If the vote cannot produce a valid winner, the ticket pauses for recovery.',
    ],
    notes: [
      'Anonymization and random ordering reduce bias.',
      'Context available: Relevant Files, Ticket Details, and anonymized competing drafts.',
      'Voting Raw views show the validated drafts that were actually scored.',
      'The same rubric is used for every voter so the scores stay comparable.',
    ],
    equivalents: [
      'This is the voting step of the Interview phase. The same pattern repeats later for PRD drafts and beads blueprints.',
      'All three voting phases use anonymization, independent scoring, and a recorded audit trail. The main difference is the rubric each phase uses.',
    ],
  },
  COMPILING_INTERVIEW: {
    overview: 'LoopTroop turns the winning draft into the interview session you will actually use. It normalizes question shape, batch tracking, and UI metadata into one canonical artifact.',
    steps: [
      'Winning draft load: The workflow loads the selected draft and its proposed question set.',
      'Question normalization: Each question gets a stable id, type, text, optional hints, and ordering metadata. If needed, the refiner may inspect a small repository area read-only to confirm a technical fact.',
      'Validation and retries: LoopTroop validates the normalized structure and records rejected repair attempts when retries are needed.',
      'Session snapshot: The workflow builds batch state, answered and skipped tracking, and progress bookkeeping for the interactive interview screen.',
      'Artifact writing: The canonical interview artifact and its UI companion data are written to the ticket workspace.',
    ],
    outputs: [
      'Canonical interview artifact in the ticket workspace.',
      'An interview session snapshot with batch and completion state.',
      'Normalized question data for the interview UI.',
      'UI companion artifacts for rendering the session.',
    ],
    transitions: [
      'Success → Interviewing: The normalized session moves into the interactive interview screen.',
      'Failure → Blocked Error: If the winning draft cannot be normalized correctly, the ticket pauses for recovery.',
    ],
    notes: [
      'This is the first interactive artifact the user sees in the planning flow.',
      'The winning model performs this normalization step.',
      'Raw draft views stay aligned to the validated content used by refinement.',
      'The session structure supports later follow-up rounds if coverage adds them.',
    ],
    equivalents: [
      'This is the refinement step of the Interview phase. PRD and beads use the same idea later, but they keep document and blueprint formats instead of building an interactive session.',
      'All three take the strongest candidate and make it more usable before the next stage.',
    ],
  },
  WAITING_INTERVIEW_ANSWERS: {
    overview: 'This is the interactive interview. The workflow waits here while you answer or skip the current batch. Draft answers and skip decisions autosave with a visible status showing when the server last acknowledged a save. Coverage can later send the ticket back here with a focused follow-up batch.',
    steps: [
      'Question batch: The workspace shows the current set of pending questions, including type, context, and prior answered or skipped state.',
      'Answering Questions And Autosave: You can answer questions in any order. Free-text questions accept open-ended responses; choice-based questions present the available options. Draft changes autosave while you work, and the visible Autosave on indicator reports pending, saving, saved, conflict, or failure state plus the last server-acknowledged save time.',
      'Skipping: You can skip a question, or unskip it later and answer it. A skipped question takes an optional reason, which is saved with the interview and given to the model that later fills the answer in. Undoing the skip discards the reason, because it no longer explains anything. Skipped questions stay visible in the interview history along with whatever reason you gave.',
      'Batch submission: Submitting writes the latest answers and skip decisions into the interview session and canonical artifact. The model may inspect a small repository area read-only when it needs to prepare the next batch, but your product decisions remain authoritative.',
      'Follow-up rounds: If coverage finds real gaps later, the workflow returns here with new targeted questions instead of repeating the whole interview.',
      'Skip All: You can skip every remaining unanswered question at once, with one optional reason for the whole action. That reason applies only to questions you have not already explained individually, and never to answers you submitted in an earlier batch. LoopTroop writes a synthetic clean coverage record for audit history and sends the ticket directly to interview approval. Skipped questions are answered by AI models at the start of PRD drafting.',
    ],
    outputs: [
      'Saved user answers, skip decisions, and skip reasons in the interview session snapshot.',
      'An updated canonical interview artifact.',
      'A question history spanning both the original and follow-up rounds.',
    ],
    transitions: [
      'Submit or Skip → Interviewing: A non-final batch keeps the workflow here and loads the next batch.',
      'Interview Complete → Coverage Check (Interview): Once the current run has enough answers, LoopTroop moves into coverage review.',
      'Coverage Follow-Up → Back Here: If coverage still finds gaps, it sends the ticket back with targeted follow-up questions.',
      'Skip All → Approving Interview: All remaining unanswered questions are marked skipped, a synthetic clean coverage record is written, and the ticket moves straight to approval.',
    ],
    notes: [
      'This is a user-input phase. The workflow is intentionally paused while you answer.',
      'The phase may repeat during the initial interview and again during coverage follow-ups.',
      'AI context available: Ticket Details plus the live interview session state. Read-only repository checks can confirm technical facts, but they do not replace stakeholder decisions.',
      'Specific answers usually lead to better PRDs than broad or heavily skipped ones. A short reason on a skip is the next best thing, because the model that fills the answer in gets to read it.',
      'Each committed skip is recorded with who skipped it, when, and the reason at that moment. The Skips panel in the Full Log shows the whole trail.',
    ],
  },
  VERIFYING_INTERVIEW_COVERAGE: {
    overview: 'LoopTroop is checking whether the interview collected enough information to produce a good PRD. If not, it writes targeted follow-up questions and sends the ticket back to you. The loop is budgeted so it cannot keep running forever.',
    steps: [
      'Context assembly: The workflow loads the ticket details, the canonical interview artifact, and a normalized view of the recorded answers and skips.',
      'Coverage review: The winning interview model checks what is still unclear. It may inspect a small repository area read-only to confirm technical facts, but it does not infer stakeholder intent from existing code.',
      'Gap reporting: When the model finds gaps, it explains what is missing, why it matters, and what follow-up question would close it.',
      'Follow-up creation: If budget remains, LoopTroop writes a new targeted batch and sends the ticket back to Interviewing.',
      'Budget enforcement: When the follow-up budget is exhausted, the workflow stops asking new questions and moves the interview forward with the best available information.',
      'History: Every coverage pass is stored with its result, diagnostics, and budget usage.',
    ],
    outputs: [
      'An interview coverage artifact that records either a clean result or concrete gaps.',
      'Targeted follow-up questions when budget remains and gaps still matter.',
      'A refreshed canonical interview artifact when the interview is finalized.',
      'Coverage history with diagnostics and budget tracking.',
    ],
    transitions: [
      'Gaps + Budget Available → Interviewing: The ticket returns with a focused follow-up batch.',
      'Clean → Approving Interview: Once the interview is clean enough, it moves to approval.',
      'Budget Exhausted → Approving Interview: When the budget is spent, the interview advances even if some gaps remain.',
      'Failure → Blocked Error: If coverage cannot finish safely, the ticket pauses for recovery.',
    ],
    notes: [
      'The follow-up loop is budgeted and cannot run forever.',
      'Coverage uses the winning interview model for consistency with the chosen strategy.',
      'Context available: Ticket Details, User Answers, and Interview Results, plus focused read-only repository inspection only when needed.',
      'The current pass can appear in the live workspace title while this status is active.',
    ],
    equivalents: [
      'This is the coverage step of the Interview phase. PRD and beads use the same idea later, but they resolve gaps automatically instead of sending the user more questions.',
      'Each coverage loop has its own budget or cap so the workflow always converges.',
      'Beads adds a separate expansion phase after coverage. Interview and PRD do not.',
    ],
  },
  WAITING_INTERVIEW_APPROVAL: {
    overview: 'The interview is ready for review. Nothing moves forward until you approve it. You can inspect the structured view or raw YAML. Draft edits autosave with a visible last-save status, but they do not update the authoritative interview artifact until you explicitly Save.',
    steps: [
      'Review modes: You can switch between a structured question-and-answer view and the raw YAML.',
      'Editing Answers And Draft Autosave: You can adjust any answer text, change skip decisions, or modify the raw YAML directly. Marking an answer skipped takes an optional reason, and answering the question clears it. Draft changes autosave between view switches and reloads. The visible Draft autosave on indicator reports pending, saving, saved, conflict, or failure state plus the last server-acknowledged save time.',
      'Save: Draft autosave does not update the authoritative interview. Explicit Save writes the new interview, records a user-edit receipt, and refreshes caches. If you save a post-approval edit before PRE_FLIGHT_CHECK, LoopTroop archives the current approved version and restarts downstream planning from the edited interview.',
      'Approve: Approval locks the current interview as the source of truth for PRD drafting. The request includes the content hash you reviewed, so stale tabs cannot approve an older version.',
      'Edit window: After PRE_FLIGHT_CHECK begins, interview edits are no longer accepted because execution planning is already locked.',
    ],
    outputs: [
      'An approved interview artifact that becomes the authoritative source for PRD drafting.',
      'User-edited replacement content when you save changes.',
      'Persisted draft state for in-progress review edits.',
      'Approval and user-edit receipts with content hashes.',
      'A skip receipt for every answer this edit newly skipped, and for every skip reason it changed.',
      'Archived prior interview versions and downstream planning attempts when a post-approval edit restarts planning.',
    ],
    transitions: [
      'Approve → Council Drafting Specs: The approved interview becomes the input for PRD drafting.',
      'Cancel → Canceled: The ticket stops here without moving into PRD work.',
    ],
    notes: [
      'This is the human approval gate before PRD drafting begins.',
      'The content-hash check protects against approving a stale tab.',
      'No AI work runs just because this screen is open.',
      'Skipped questions deserve extra attention because PRD drafting will otherwise fill them with AI-generated answers. A reason on the skip is what the filling model has to work from.',
      'Re-saving a document you did not change records nothing. Only a newly skipped answer or an edited reason counts as a decision.',
    ],
    equivalents: [
      'This is the approval gate for the Interview phase. The same pattern repeats later for the PRD and beads approval screens.',
      'All three approval gates follow the same flow: review, optional edits, explicit Save when needed, then explicit approval to continue.',
      'Post-approval edits are still planning work. Interview and PRD edits remain allowed only before PRE_FLIGHT_CHECK.',
    ],
  },
  DRAFTING_PRD: {
    overview: 'The council is turning the approved interview into competing PRDs. First, each model fills skipped answers in its own Full Answers artifact. Then that same model uses its completed answer set to draft a full specification. The models work independently so the vote can compare both their assumptions and their PRDs.',
    steps: [
      'Part 1, Full Answers: For each skipped interview question, each council model writes its own best answer from the available context. It may inspect a small repository area read-only when the supplied context does not prove a technical fact.',
      'Why per-model answers matter: Different models may make different reasonable assumptions. Keeping Full Answers per model lets the vote compare a PRD together with the assumptions that produced it.',
      'Part 2, PRD drafting: Each model uses its own completed answer set, plus relevant files and ticket details, to write a full PRD with requirements, acceptance criteria, edge cases, test intent, and implementation guidance.',
      'Draft gating: If a model cannot produce a valid Full Answers artifact, its PRD draft does not start. The workflow records that row as invalid with diagnostics instead of pretending a usable PRD exists.',
      'Validation and retries: LoopTroop validates both Full Answers and PRD drafts, keeps accepted bodies for the vote, and records rejected attempts and diagnostics in Raw history. Structured retries run in fresh sessions.',
    ],
    outputs: [
      'Per-model Full Answers artifacts that complete the interview for each council member.',
      'Competing PRD drafts with requirements, acceptance criteria, edge cases, test intent, and implementation guidance.',
      'Draft metrics, Raw attempt history, and structured-output diagnostics for the run.',
    ],
    transitions: [
      'Quorum Met → Voting on Specs: The workflow advances once enough valid PRDs exist to score.',
      'Quorum Failure → Blocked Error: If too few valid drafts survive, the ticket pauses for recovery.',
    ],
    notes: [
      'This phase has two internal parts with different context slices: Interview Results for Full Answers, then Full Answers for PRD drafting.',
      'Malformed Full Answers or PRD text stays diagnostic-only. Safe parser repairs fix formatting, not meaning.',
      'This is the stage that turns interview intent into a formal implementation specification.',
      'The vote later selects both a PRD approach and the assumptions behind it.',
    ],
    equivalents: [
      'This is the drafting step of the PRD phase. Interview and beads use the same multi-model pattern later, but PRD drafting is the only one with a separate Full Answers stage first.',
      'Unlike interview and beads drafting, this phase asks each model to complete skipped answers before it writes the main artifact.',
    ],
  },
  COUNCIL_VOTING_PRD: {
    overview: 'The council is choosing the strongest PRD draft. Drafts are anonymized, scored independently, and compared with a weighted rubric so the winner is the best baseline for refinement.',
    steps: [
      'Anonymization: LoopTroop strips authorship from the PRD drafts and assigns neutral labels.',
      'Random order: Each voter sees the drafts in a different order to reduce position bias.',
      'Independent scoring: Every council member scores every draft with the PRD rubric and writes a short justification.',
      'Validation and retries: Vote payloads are validated, and malformed votes are retried in fresh sessions while rejected attempts stay in Raw diagnostics.',
      'Weighted rubric: The score emphasizes requirement completeness, acceptance criteria quality, edge cases, test intent, and overall coherence.',
      'Winner selection: The resolver totals the weighted scores, applies tie-break rules when needed, and records the winner plus the audit trail.',
    ],
    outputs: [
      'PRD vote artifacts with scores, rankings, and justifications.',
      'A winning PRD draft reference for the refinement step.',
      'Audit data showing the selected draft, score spread, and tie-breaks when they occurred.',
    ],
    transitions: [
      'Winner Selected → Refining Specs: The chosen draft moves into refinement.',
      'Voting Failure → Blocked Error: If the vote cannot produce a valid winner, the ticket pauses for recovery.',
    ],
    notes: [
      'Context available: Relevant Files, Ticket Details, Interview Results, and anonymized competing drafts.',
      'The winner is not the final PRD. It still goes through refinement and coverage.',
      'Voting Raw views show the validated drafts that were actually scored.',
      'The rubric is weighted, so some categories matter more than others in the final score.',
    ],
    equivalents: [
      'This is the voting step of the PRD phase. Interview and beads use the same pattern with different rubrics.',
      'The PRD rubric is more document-focused than the interview and beads rubrics. It cares most about completeness, clarity, and testable requirements.',
    ],
  },
  REFINING_PRD: {
    overview: 'LoopTroop turns the winning draft into PRD Candidate v1 by keeping its structure and pulling in the best missing material from the losing drafts. Stable item ids are preserved, safe identifier repairs never invent text, and repository-specific claims can be checked read-only when needed.',
    steps: [
      'Context assembly: The winning model receives the winning PRD plus all losing drafts, clearly labeled, and keeps the winning structure as the backbone.',
      'Selective merging: The model pulls in missing requirements, stronger acceptance criteria, useful edge cases, or test scenarios from the losing drafts without duplicating content.',
      'Validation and id safety: LoopTroop validates structure, stable item ids, and overall document integrity. Safe identifier repairs apply only when one unique displacement is proven from the artifacts.',
      'Diff metadata: Refinement metadata is normalized against the winning and final records so later review can show what changed and any safe id correction that happened.',
      'Candidate promotion: The accepted result becomes PRD Candidate v1, the first version that enters the coverage loop.',
    ],
    outputs: [
      'PRD Candidate v1, built from the winning draft plus selected improvements from the losing drafts.',
      'Refinement diff metadata and any safe identifier intervention warnings.',
      'Normalized PRD content ready for coverage review, with rejected attempts kept diagnostic-only.',
    ],
    transitions: [
      'Success → Coverage Check (PRD): The refined candidate moves into the PRD coverage loop.',
      'Failure → Blocked Error: If the candidate cannot be refined safely, the ticket pauses for recovery.',
    ],
    notes: [
      'The winning model performs refinement so the voice and structure of the selected draft stay coherent.',
      'Context available: Relevant Files, Ticket Details, Full Answers, and competing drafts, with focused read-only repository inspection only when needed.',
      'Raw draft views stay aligned to the validated content used by refinement.',
      'Identifier repairs never create requirements or rewrite item text.',
      'PRD Candidate v1 is versioned because coverage may later produce v2, v3, and beyond.',
    ],
    equivalents: [
      'This is the refinement step of the PRD phase. Interview and beads use the same idea later, but with different artifact shapes.',
      'PRD and beads refinement are closest to each other: both keep the winner and selectively merge strong ideas from the rest.',
    ],
  },
  VERIFYING_PRD_COVERAGE: {
    overview: 'LoopTroop is checking the current PRD candidate against the winning Full Answers. If it finds real gaps, it revises the PRD inside this same phase instead of sending the user back. The loop is versioned and capped, so you can see exactly how the candidate changed before approval.',
    steps: [
      'Coverage evaluation: The winning PRD model compares the current candidate against the winning Full Answers and reports either a clean result or concrete gaps.',
      'Gap details: When gaps exist, the result says what is missing, which answers are not reflected, and why the gap matters.',
      'In-phase revision: If the loop still has budget, LoopTroop asks for a revised PRD and promotes the accepted result to the next candidate version.',
      'Safe change metadata: Structured change notes are kept only when they preserve real semantic before-and-after records. Path-only or summary-only notes stay diagnostic.',
      'Version history: Every pass records the coverage result, revision actions, parser or repair notices, and the candidate version that came out of the pass.',
      'Cap enforcement: Once the configured cap is reached, the latest candidate moves forward even if some gaps remain. Those warnings stay visible during approval.',
    ],
    outputs: [
      'Versioned PRD coverage history from Candidate v1 through later revisions.',
      'The latest PRD candidate after zero or more in-phase fixes.',
      'Structured diagnostics about gaps, repairs, and unresolved warnings.',
    ],
    transitions: [
      'Clean → Approving Specs: A clean candidate moves into PRD approval.',
      'Cap Reached → Approving Specs: The latest candidate also moves into approval when the pass cap is reached, but with warnings preserved.',
      'Failure → Blocked Error: If coverage or revision cannot finish safely, the ticket pauses for recovery.',
    ],
    notes: [
      'Unlike interview coverage, this loop stays inside one phase and fixes the document directly.',
      'The version cap is configuration-driven so every project can choose its own trade-off.',
      'While this status is live, the workspace title can show the current candidate version and pass number.',
      'Change metadata repairs are text-preserving only. Missing semantic detail is never invented.',
      'Context available: the winning Full Answers artifact plus the current PRD candidate. Focused read-only inspection is available only when needed.',
    ],
    equivalents: [
      'This is the coverage step of the PRD phase. Interview and beads use the same completeness check, but they resolve gaps differently.',
      'Interview coverage asks the user more questions. PRD coverage fixes the document in place. Beads coverage also fixes in place, then adds a separate expansion phase.',
      'PRD coverage checks the PRD against the winning Full Answers artifact.',
    ],
  },
  WAITING_PRD_APPROVAL: {
    overview: 'The latest PRD candidate is ready for review before beads planning starts. Draft edits autosave with a visible last-save status, but they do not update the authoritative PRD until you explicitly Save. You can also inspect the read-only Full Answers context and any remaining coverage warnings before approval.',
    steps: [
      'Review modes: You can switch between a structured PRD view and the raw YAML.',
      'Full Answers context: When Part 1 produced a Full Answers artifact, the approval header shows a read-only view of the completed interview answers that shaped the winning PRD.',
      'Coverage warnings and extra fixes: If the pass cap was hit before the PRD became fully clean, the approval screen shows the unresolved gaps. You can edit manually, approve with gaps, or run one targeted AI fix at a time. Approving with gaps takes an optional reason, which is stored on the approval receipt as the current record and in the append-only skip trail as history. Nothing else explains why those gaps were accepted.',
      'Editing And Draft Autosave: You can edit any section of the PRD. Draft changes autosave between view switches and reloads. The visible Draft autosave on indicator reports pending, saving, saved, conflict, or failure state plus the last server-acknowledged save time. Draft autosave does not update the authoritative PRD; explicit Save applies the draft and records a user-edit receipt. If you save a post-approval edit before PRE_FLIGHT_CHECK, LoopTroop archives the current approved PRD and restarts downstream planning from the edited version.',
      'Approval decision: Approval locks the current PRD as the specification for beads drafting. The request includes the content hash you reviewed, so stale tabs cannot approve an older version.',
      'Edit window: After PRE_FLIGHT_CHECK begins, PRD edits are no longer accepted because execution planning is already locked.',
    ],
    outputs: [
      'An approved PRD artifact that becomes the authoritative input for beads drafting.',
      'User-edited replacement content when you save changes.',
      'Persisted draft state for in-progress review edits.',
      'Read-only Full Answers context when PRD drafting produced it.',
      'Approval and user-edit receipts with content hashes, plus optional extra-fix coverage history.',
      'A gap acknowledgement on the approval receipt, and a matching skip receipt, when you approve with known gaps and give a reason.',
      'Archived prior PRD versions and downstream beads attempts when a post-approval edit restarts planning.',
    ],
    transitions: [
      'Approve → Council Drafting Blueprint: The approved PRD becomes the input for semantic bead planning.',
      'Cancel → Canceled: The ticket stops here without moving into beads work.',
    ],
    notes: [
      'This is the human approval gate before beads planning begins.',
      'The content-hash check protects against approving a stale tab.',
      'No AI work runs just because this screen is open. AI sees this context only when you click Fix gaps with AI.',
      'The Full Answers view is reference context, not a second editable artifact.',
      'The gap reason is about the gaps in front of you now. It is not carried over from a previous coverage run.',
      'Editing the PRD after downstream planning has started intentionally archives that later planning and restarts it from the edited PRD.',
    ],
    equivalents: [
      'This is the approval gate for the PRD phase. Interview and beads use the same pattern on either side of it.',
      'All three approval gates sit between major planning stages. This one locks the PRD before the workflow starts breaking it into beads.',
    ],
  },
  DRAFTING_BEADS: {
    overview: 'The council is breaking the approved PRD into competing semantic bead plans. These drafts describe the work, dependencies, and verification intent, but they do not lock file targets or runtime metadata yet.',
    steps: [
      'Context loading: Each council member receives the approved PRD, ticket details, and relevant-files context. It may inspect a small repository area read-only when the supplied context does not prove a repository-specific claim.',
      'Independent blueprint drafting: Every model proposes its own semantic bead breakdown, including task descriptions, acceptance criteria, dependencies, and test intent.',
      'Decomposition strategy: Models decide how much work belongs in each bead and how those beads should depend on each other. Different models may arrive at very different task shapes.',
      'Validation and metrics: LoopTroop validates the blueprint structure, records task and graph metrics, keeps accepted drafts for the vote, and stores rejected attempts and diagnostics in Raw history.',
    ],
    outputs: [
      'Competing semantic bead blueprints from the council members.',
      'Draft metrics for task count, graph complexity, and structure.',
      'Stored draft artifacts for the next voting phase, plus rejected raw attempts and diagnostics.',
    ],
    transitions: [
      'Quorum Met → Voting on Blueprint: The workflow advances once enough valid blueprints exist to score.',
      'Quorum Failure → Blocked Error: If too few valid blueprints survive, the ticket pauses for recovery.',
    ],
    notes: [
      'Context available: Relevant Files, Ticket Details, and PRD, with focused read-only repository inspection only when needed.',
      'These blueprints stay semantic. Exact file targets and runtime metadata are added later during expansion.',
      'Malformed blueprint output stays diagnostic-only. It does not appear as a usable draft.',
      'Different models often spot different natural task boundaries, which is why the workflow drafts several plans before voting.',
    ],
    equivalents: [
      'This is the drafting step of the beads phase. Interview and PRD use the same multi-model pattern, but they draft question sets or specs instead of task graphs.',
      'Unlike PRD drafting, beads drafting is single-part. It also produces the most architecture-heavy artifact in the planning pipeline.',
    ],
  },
  COUNCIL_VOTING_BEADS: {
    overview: 'The council is choosing the most credible blueprint. Each model scores every plan against an architecture rubric that focuses on decomposition quality, feasibility, dependencies, and testability.',
    steps: [
      'Anonymization: LoopTroop strips authorship from the blueprints and assigns neutral labels.',
      'Random order: Each voter sees the blueprints in a different order to reduce position bias.',
      'Independent scoring: Every council member scores every blueprint with the architecture rubric and writes a short justification.',
      'Validation and retries: Vote payloads are validated, and malformed votes are retried in fresh sessions while rejected attempts stay in Raw diagnostics.',
      'Winner selection: The resolver totals the scores, applies tie-break rules when needed, and records the winner plus the audit trail.',
    ],
    outputs: [
      'Beads vote artifacts with architecture scores and justifications.',
      'A winning semantic blueprint reference for the refinement step.',
      'Audit data showing how the result was chosen.',
    ],
    transitions: [
      'Winner Selected → Refining Blueprint: The chosen blueprint moves into refinement.',
      'Voting Failure → Blocked Error: If the vote cannot produce a valid winner, the ticket pauses for recovery.',
    ],
    notes: [
      'Context available: Relevant Files, Ticket Details, PRD, and anonymized competing drafts.',
      'This rubric is more architecture-focused than the interview and PRD voting rubrics.',
      'Voting Raw views show the validated blueprints that were actually scored.',
      'The winning blueprint is not the final plan. It still goes through refinement, coverage, and expansion.',
    ],
    equivalents: [
      'This is the voting step of the beads phase. Interview and PRD use the same pattern with different rubrics.',
      'The beads rubric is the most implementation-focused of the three. It cares about graph quality and whether the plan can actually be executed.',
    ],
  },
  REFINING_BEADS: {
    overview: 'LoopTroop keeps the winning blueprint as the backbone and pulls in the strongest missing tasks, tests, constraints, and edge cases from the others. This is still semantic planning. File targets and runtime metadata come later during expansion.',
    steps: [
      'Context assembly: The winning model receives the winning blueprint plus all losing blueprints, clearly labeled, and keeps the winning structure as the backbone.',
      'Selective merging: The model adds missing tasks, stronger acceptance criteria, useful edge cases, or dependency insights from the losing blueprints without breaking the graph.',
      'Validation and retries: LoopTroop validates bead structure and dependency integrity, keeps the accepted result as the refined candidate, and stores rejected attempts in Raw history.',
      'Diff artifacts: The workflow records what changed between the winning blueprint and the refined candidate so later review can show the impact clearly.',
      'Verification restraint: The refined candidate keeps human-readable verification without forcing a command for every scenario. Broader integration and interactive checks stay for Final Testing or Manual QA.',
    ],
    outputs: [
      'A refined semantic beads blueprint built from the winning plan plus selected improvements from the others.',
      'Diff and attribution metadata for later review.',
      'A validated candidate ready for beads coverage.',
    ],
    transitions: [
      'Success → Coverage Check (Beads): The refined blueprint moves into coverage review against the PRD.',
      'Failure → Blocked Error: If the blueprint cannot be refined safely, the ticket pauses for recovery.',
    ],
    notes: [
      'This phase still works on the semantic plan, including minimal planned checks or an explanation when no automated command is appropriate.',
      'Context available: Relevant Files, Ticket Details, PRD, and competing drafts, with focused read-only repository inspection only when needed.',
      'Raw draft views stay aligned to the validated content used by refinement.',
      'Refining before expansion is cheaper and easier than redoing execution-specific metadata later.',
    ],
    equivalents: [
      'This is the refinement step of the beads phase. PRD uses almost the same idea, while interview refinement turns the winner into an interactive session.',
      'Beads refinement differs from PRD refinement because it is still followed by a separate expansion step that adds execution metadata.',
    ],
  },
  VERIFYING_BEADS_COVERAGE: {
    overview: 'LoopTroop is checking the semantic blueprint against the approved PRD. If required work is missing, it revises the blueprint before anything is expanded into execution-ready beads. The loop stays semantic and capped.',
    steps: [
      'Coverage evaluation: The winning beads model compares the current semantic blueprint against the PRD and reports either a clean result or concrete gaps.',
      'Gap resolution: When gaps exist, LoopTroop asks for a targeted revision that adds missing work or strengthens necessary acceptance and verification guidance. Command absence by itself is not a gap.',
      'Version tracking: Every coverage pass and revision is stored so you can follow how the blueprint changed over time.',
      'Finalization: Once the blueprint is clean enough, or the configured cap is reached, the workflow moves to expansion and preserves any remaining warnings for later review.',
    ],
    outputs: [
      'Versioned beads coverage history showing each pass and revision.',
      'The latest semantic blueprint after zero or more coverage fixes.',
      'A clean or cap-reached result that drives automatic advancement to expansion.',
    ],
    transitions: [
      'Coverage Clean → Expanding Blueprint: A clean semantic blueprint moves into expansion.',
      'Coverage Cap Reached → Expanding Blueprint: The latest blueprint also moves into expansion when the pass cap is reached, but with warnings preserved.',
      'Coverage Failure → Blocked Error: If coverage or revision cannot finish safely, the ticket pauses for recovery.',
    ],
    notes: [
      'This phase works only on the semantic blueprint. Execution-ready bead records are created in the separate expansion phase.',
      'The pass cap keeps the loop from running forever.',
      'While this status is live, the workspace title can show the current blueprint version and pass number.',
      'Context available: PRD and the semantic blueprint, with focused read-only repository inspection only when needed.',
      'Coverage happens before expansion because semantic fixes are cheaper than redoing execution metadata.',
    ],
    equivalents: [
      'This is the coverage step of the beads phase. Interview and PRD use the same completeness check with different source artifacts.',
      'Beads coverage is the only one followed by a separate expansion phase that adds execution metadata.',
      'Beads coverage checks the blueprint against the approved PRD.',
    ],
  },
  EXPANDING_BEADS: {
    overview: 'LoopTroop turns the approved semantic blueprint into the execution-ready bead records the coding loop will consume. Expansion keeps the approved acceptance and planned verification, then adds file targets, dependency ordering, labels, and runtime metadata.',
    steps: [
      'Blueprint loading: LoopTroop loads the latest semantic blueprint from the coverage phase.',
      'Expansion: The model receives the semantic blueprint, relevant files, ticket details, and the approved PRD. It preserves the accepted verification guidance and adds only the execution-specific fields the coding loop needs.',
      'Bead record writing: The expanded bead records are written to the ticket workspace as the canonical beads data file.',
      'Approval candidate: The expanded output is also stored as the artifact you review in the beads approval screen.',
    ],
    outputs: [
      'Execution-ready beads data with preserved verification guidance, file targets, dependency graphs, and runtime metadata.',
      'A canonical beads data file in the ticket workspace for pre-flight and coding.',
      'An approval candidate artifact for the beads approval UI.',
    ],
    transitions: [
      'Expansion Complete → Approving Blueprint: The execution-ready plan moves into user review.',
      'Expansion Failure → Blocked Error: If expansion cannot finish safely, the ticket pauses for recovery.',
    ],
    notes: [
      'This is the only planning phase with a dedicated semantic-to-execution expansion step.',
      'Context available: Relevant Files, Ticket Details, PRD, and the semantic blueprint, with focused read-only repository inspection only when needed.',
      'Expansion happens after coverage because execution-specific detail is expensive to redo if the semantic plan still has gaps.',
    ],
    equivalents: [
      'This expansion step is unique to the beads phase. Interview and PRD have no direct equivalent.',
      'Unlike the other planning phases, this one produces execution-ready artifacts that coding uses directly.',
    ],
  },
  WAITING_BEADS_APPROVAL: {
    overview: 'The final bead plan is ready for review before coding starts. Here you review task descriptions, dependencies, acceptance criteria, human-readable tests, and planned commands. After approval, the coding loop consumes one bead at a time.',
    steps: [
      'Execution plan review: LoopTroop shows each bead\'s description, acceptance criteria, dependency chain, file targets, planned test commands or no-command explanation, and execution ordering.',
      'Dependency view: The plan makes the dependency chain visible so you can check that the execution order makes sense before coding begins.',
      'Editing And Draft Autosave: You can review the plan in structured form or edit the raw representation before approving. Draft changes autosave between view switches and reloads. The visible Draft autosave on indicator reports pending, saving, saved, conflict, or failure state plus the last server-acknowledged save time. Draft autosave does not update the authoritative beads artifact; explicit Save applies the draft and records a user-edit receipt.',
      'Coverage warnings and extra fixes: If the pass cap was hit before the plan became fully clean, the approval screen shows the unresolved gaps. You can edit manually, approve with gaps, or run a targeted AI fix that revises the semantic blueprint and rechecks coverage. Approving with gaps takes an optional reason, which is stored on the approval receipt and in the skip trail.',
      'Approval decision: Approval locks the execution plan the coding loop will consume bead by bead. The request includes the content hash you reviewed, so stale tabs cannot approve an older version.',
      'Expansion refresh: If an extra fix changes the semantic blueprint, LoopTroop reruns expansion before it refreshes the approval artifact and hash.',
    ],
    outputs: [
      'An approved execution-ready beads plan that becomes the authoritative input for pre-flight and coding.',
      'User-edited replacement content when you save changes.',
      'Persisted draft state for in-progress review edits.',
      'Approval and user-edit receipts with content hashes, plus optional extra-fix coverage history.',
      'A gap acknowledgement on the approval receipt, and a matching skip receipt, when you approve with known gaps and give a reason.',
      'The authoritative bead set consumed by pre-flight checks and the coding loop.',
    ],
    transitions: [
      'Approve → Checking Readiness: The approved bead plan moves into pre-flight checks.',
      'Cancel → Canceled: The ticket stops here without entering execution.',
    ],
    notes: [
      'This is the last approval gate before automated code execution begins.',
      'The content-hash check protects against approving a stale tab.',
      'No AI work runs just because this screen is open. AI sees this context only when you click Fix gaps with AI.',
      'Dependency mistakes are expensive here because they affect the order the coding loop will follow.',
      'Clear acceptance criteria matter because the coding loop uses them to decide whether a bead is done.',
      'Approving with gaps here is the last chance to say why in writing. Nothing downstream asks again.',
    ],
    equivalents: [
      'This is the approval gate for the beads phase. Interview and PRD use the same pattern earlier in the workflow.',
      'It is the last human checkpoint before automated code execution begins, which makes it the most consequential approval screen in the planning pipeline.',
    ],
  },
  PRE_FLIGHT_CHECK: {
    overview: 'LoopTroop runs a fixed pre-flight check before any execution work starts. It confirms the coding agent can run, the workspace is intact, required artifacts exist, the worktree is clean enough to attribute future commits, and the bead dependency graph makes sense. The goal is to catch environment problems before setup or coding begins.',
    steps: [
      'Workspace Validation: LoopTroop checks that the ticket workspace exists, is writable, and contains the expected artifact files such as relevant files, interview, PRD, and beads data.',
      'Worktree Cleanliness Gate: LoopTroop inspects Git-visible changes before setup starts. Pre-existing committable project changes fail the gate so later bead commits stay attributable. Untracked generated or local outputs are recorded as warnings with suggested `.gitignore` entries.',
      'Coding Agent Connectivity: The pre-flight doctor verifies that the configured coding agent, OpenCode, is reachable and responsive. This catches connectivity, auth, or configuration problems early.',
      'Execution Capability Probe: LoopTroop creates a temporary execution-band session with the same model and variant planned for real work, retries session creation with the shared 1s/3s/7s backoff if needed, sends a tiny read-only probe, requires the exact response `OK`, then tears the session down. This catches session-creation or tool-mode problems that a generic health check would miss.',
      'Bead Availability Check: LoopTroop confirms that the approved beads data file exists, can be parsed, and contains at least one runnable bead with valid structure.',
      'Dependency Graph Validation: LoopTroop checks the bead dependency graph for circular dependencies, references to missing beads, and at least one bead with no dependencies so execution has a valid starting point.',
      'Pre-Flight Report: LoopTroop writes a structured report with pass, warning, and failure entries for every check. The report is saved whether the phase passes or fails so you can inspect the exact results.',
      'Execution Handoff: If everything passes, LoopTroop moves to Drafting Workspace Setup Plan. Bead progress does not start here. Coding still begins later at bead 1/N.',
    ],
    outputs: [
      'A pre-flight report artifact with pass, warning, and failure entries for each validation, including worktree-cleanliness diagnostics.',
      'An execution-readiness decision, either ready to draft the setup plan or blocked with a specific reason.',
    ],
    transitions: [
      'All Checks Pass → Drafting Workspace Setup Plan: The workflow starts a read-only, host-aware setup-plan generation attempt before asking for approval.',
      'Any Critical Failure → Blocked Error: Connectivity failures, missing artifacts, dependency-graph problems, committable pre-existing worktree changes, or workspace-integrity issues move the ticket to Blocked Error with a specific failure reason.',
    ],
    notes: [
      'This phase is deterministic and lightweight. It does not perform ticket-specific setup or make permanent repository changes.',
      'The point is to catch environment problems before setup or coding wastes time on work that was going to fail anyway.',
      'Warning-level results, such as untracked generated or local outputs, are recorded but do not block execution. Only critical failures stop the coding path.',
    ],
  },
  GENERATING_EXECUTION_SETUP_PLAN: {
    overview: 'LoopTroop is drafting a host-aware workspace setup plan before any setup commands run. This is an active, read-only generation phase: the locked main implementer inspects approved planning artifacts and current host evidence, emits a structured proposal, and leaves a visible log and versioned artifacts for review.',
    steps: [
      'Durable Attempt Start: LoopTroop opens a versioned drafting attempt and records the active generation request before dispatching AI work, so a backend or machine restart can resume without silently duplicating the request.',
      'Context And Host Audit: The locked main implementer reads ticket details, relevant files, the approved PRD and beads, the current worktree, detected Git evidence, and any reusable setup profile. A regeneration also receives the preserved commentary and structured or raw baseline from the durable regeneration-request artifact.',
      'Read-Only Drafting: The model decides whether temporary setup is needed and proposes only the missing preparation. It may inspect the repository, but this phase does not run setup commands or modify project files.',
      'Structured Validation And Repair: The proposal is parsed and validated with the existing structured retry and safe formatting-repair rules. Backend-owned identity, schema, host, Git-hook, and quality-policy fields remain authoritative if the model echoes them incorrectly.',
      'Visible Progress And Artifacts: The phase keeps its live log expanded, shows an artifact placeholder while work is active, and publishes the complete structured plan and generation report when valid. Exhausted invalid output remains available with the report, raw attempts, parser diagnostics, and repair warnings.',
      'Versioned Handoff: A completed draft is retained under this drafting attempt, then copied with its report into a fresh approval attempt. Regeneration archives the previous drafting and approval attempts and creates a new version instead of overwriting history.',
    ],
    outputs: [
      'A versioned `execution_setup_plan` candidate containing the complete structured, host-aware setup proposal.',
      'A generation report, live execution log, and raw-attempt diagnostics that explain validation, repairs, and any exhausted malformed result.',
      'A self-contained approval attempt containing the candidate and report needed for review.',
    ],
    transitions: [
      'Valid Draft → Approving Workspace Setup: The complete candidate and generation report are published to a fresh approval attempt.',
      'Invalid Draft After Structured Retries → Approving Workspace Setup: The rejected output and diagnostics remain reviewable, while Approve and Edit stay disabled and Regenerate remains available.',
      'Operational Failure → Blocked Error: Provider, session, timeout, persistence, or other unexpected failures pause for recovery and retain the durable regeneration request when one exists.',
      'Cancel → Canceled: Cancellation stops generation while preserving completed logs and artifacts for audit.',
    ],
    notes: [
      'This phase is in progress, not a user-input gate. Approval begins only after generation reaches a valid or reviewable-invalid result.',
      'No temporary setup or permanent repository mutation is allowed here. Approved setup actions run only in Preparing Workspace Runtime.',
      'The drafting attempt keeps the original generated candidate and diagnostics even after a user edits the separate approval copy.',
      'AI Response Timeout bounds setup-plan drafting. The owned OpenCode session is completed for a valid report and abandoned for invalid or failed output so a later attempt starts from clean durable context.',
    ],
  },
  WAITING_EXECUTION_SETUP_APPROVAL: {
    overview: 'The host-aware workspace setup plan is ready for review before any setup commands run. The plan is specific to the machine that will execute the ticket. Commands are stored as explicit programs and arguments or as scripts for a named shell. Workspace probes show that repository commands really work. The project Git-hook policy, detected hooks, and manager configuration stay backend-owned and read-only; detected-hook validation commands remain editable. Draft edits autosave with a visible last-save status, but the authoritative setup plan changes only when you explicitly Save.',
    steps: [
      'Generated Draft Handoff: This approval attempt receives the full setup-plan candidate and generation report produced by Drafting Workspace Setup Plan. Opening the approval screen does not start AI work.',
      'Structured Setup Plan: The draft combines an AI-written proposal with backend-owned ticket identity, schema, current-host facts, detected Git evidence, the locked project hook policy, quality policy, and derived readiness. If generated or edited content changes a backend-owned field, LoopTroop restores the authoritative value. Commands use either a program plus arguments or an explicit POSIX, Command Prompt, or PowerShell script. Direct programs are preferred.',
      'No-Action Cases Are First-Class: If the audit finds that the environment is already ready, the plan stays reviewable but contains no setup steps. You can approve it as-is or edit it to add temporary preparation if you want.',
      'User Review, Editing, And Draft Autosave: The approval UI lets you edit structured setup commands, probes, workspace inputs, and explicit hook-validation commands while reviewing the current-host banner and read-only project hook policy. Detected evidence is not editable. Large workspace inputs show file-count and size information and need an explicit override. The visible Draft autosave on indicator reports pending, saving, saved, conflict, or failure state plus the last acknowledged save time. Draft autosave does not update the authoritative setup plan. Explicit Save applies the editable fields and records before-and-after hashes.',
      'Regenerate With Commentary: If the plan is close but wrong, you can send commentary describing what should change. LoopTroop preserves the commentary and any unsaved structured or raw baseline in a durable regeneration request, archives the current drafting and approval attempts, creates a new version, and returns the ticket to Drafting Workspace Setup Plan. Older versions stay available through the VERSION dropdown.',
      'Evidence Refresh And Approval Handoff: Right before approval, LoopTroop restores the locked project hook policy and refreshes current-host and Git-hook evidence. If anything meaningful changed, the review hash changes and the plan must be reviewed again. Once approved, runtime uses that exact host-aware snapshot, project hook policy, command order, workspace inputs, probes, and setup steps.',
    ],
    outputs: [
      'An editable `execution_setup_plan` artifact with readiness, temporary setup steps, workspace probes, a read-only project hook policy and detected-hook evidence, editable validation commands, diagnostics, and regenerate history.',
      'Underlying plan-generation report and notes artifacts kept for workflow context, auditability, regenerate continuity, and raw-attempt inspection.',
      'An approval receipt confirming that the reviewed setup plan was explicitly approved before execution setup begins, including `content_sha256` for the canonical serialized plan.',
      'Append-only `user_edit_receipt:execution_setup_plan` artifacts for manual saves.',
    ],
    transitions: [
      'Approve → Preparing Workspace Runtime: The workflow moves into execution setup, which verifies the approved readiness assessment, performs only the missing temporary setup, and writes the reusable runtime profile.',
      'Regenerate → Drafting Workspace Setup Plan: LoopTroop durably records the commentary and current baseline, archives the prior drafting and approval attempts, creates a new version, and enters the active drafting phase. If runtime setup is active, LoopTroop stops it first, archives the runtime attempt, and clears stale setup-profile outputs while preserving the tool cache.',
      'Invalid Draft → Stay For Review: If LoopTroop cannot produce a valid AI proposal after structured retries, the ticket stays at Approving Workspace Setup. Approval remains disabled, while rejected output, parser diagnostics, and Regenerate stay available.',
    ],
    notes: [
      'This phase is still before coding. No permanent repository files should be modified here.',
      'No execution work goes past this gate until you approve the setup plan.',
      'Read APIs expose `contentSha256`, and write APIs reject explicit archived phase attempts with 409 so older setup-plan versions stay immutable. The only post-approval write window is the one-step rewind from Preparing Workspace Runtime back to this gate. CODING and later phases are read-only for setup-plan changes.',
      'If setup-plan generation fails, the rejected `modelOutput` is diagnostic-only. The structured view shows the failure state and errors, and the full malformed output stays in Raw diagnostics. The ticket is not globally blocked.',
      'The approved setup plan is not the same thing as the final execution setup profile. The profile is created only in the next phase after readiness is verified and any approved temporary setup is run inside LoopTroop-owned runtime paths, preferably under `.ticket/runtime/execution-setup/**`.',
      'Setup-plan generation and its OpenCode session belong to Drafting Workspace Setup Plan. This approval gate does not run AI work merely because it is open.',
    ],
  },
  PREPARING_EXECUTION_ENV: {
    overview: 'LoopTroop runs the approved current-host setup after review and before coding. It materializes approved non-reproducible workspace inputs, applies structured environment variables and PATH additions, provisions temporary tooling only under approved roots, and executes direct programs or explicitly named host shells. Setup stays language-agnostic and project-agnostic by following repository evidence instead of assuming a package manager, shell, or file layout.',
    steps: [
      'Approved Plan First: The locked main implementer reads the approved setup-plan artifact first, then loads only focused runtime context, ticket details, the beads plan, and any prior setup retry notes. User edits in the approved plan take precedence over the model\'s original draft.',
      'Readiness Verification Before Action: The setup agent must verify the approved readiness assessment first. If the approved plan says no actions are needed and that is still true, it should skip bootstrap commands and simply emit a reusable profile describing the ready environment.',
      'Temporary-Only Initialization: When setup is still missing, the agent runs only the approved temporary steps. It may inspect the repository, run repo-native bootstrap commands, warm caches, or prepare generated runtime artifacts. If required launchers or toolchains are missing, a failed version or info probe is discovery only. Wrapper creation, cache inspection, PATH edits, and version probes do not count as provisioning strategies. The agent must first try real user-space provisioning strategies that obtain, install, or activate the launcher under approved temp roots, preferably `.ticket/runtime/execution-setup/tool-cache/**`, or record why no safe provisioning path exists before reporting a tooling failure.',
      'Setup-Scoped Online Lookup: During Preparing Workspace Runtime, OpenCode `websearch` and `webfetch` are enabled so the agent can look up official release or download metadata when repository-declared versions cannot be resolved locally. Managed OpenCode dev servers are started with `OPENCODE_ENABLE_EXA=1`. Other phases keep these web tools disabled.',
      'Honest Structured Result: The agent must finish with one structured result whose top-level and profile status are both Ready when everything passes or both Blocked when anything fails. It records temp roots, bootstrap commands, non-mutating tooling probes, ordered functional workspace probes, the locked Git-hook policy and evidence, validation commands and receipts, optional provisioning evidence, reusable artifacts, discovered project command families, and later quality-gate policy. A Blocked result is diagnostic only and is never installed as the reusable runtime profile.',
      'Environment And Command Routing: LoopTroop applies the approved structured variables and PATH additions directly to every subprocess. It creates a small host-specific launcher only for coding-agent tool calls that need the same environment. No POSIX wrapper filename or substring convention is required.',
      'Progress Continuation And Result Repair: A short markerless progress reply is treated as unfinished setup work. LoopTroop sends up to two direct same-session instructions to keep using tools and finish with Ready or Blocked, without consuming a normal setup attempt or the structured-output repair budget. A third unfinished reply fails the attempt with a plain explanation. Completed but malformed results go through the separate structured-output correction path.',
      'One Deadline Per Attempt: Execution Setup Timeout is the total active-work budget for one attempt. Session acquisition, initial and fallback prompts, OpenCode provider recovery, progress continuations, structured-output corrections, setup commands, backend wrapper and probe validation, hook validation, worktree inspection, and retry-note generation all share that remaining time. OpenCode retry controls cannot extend it. A zero setting disables this aggregate deadline while existing command-level safety limits still apply.',
      'Audited Augmentations: If the approved plan turns out to be incomplete and the setup agent must run extra temporary-only commands, those additions are recorded in the setup report so you can see exactly how runtime diverged from the approved draft.',
      'Structured Validation: LoopTroop parses the model-owned result and combines it with already approved backend-owned inputs, probes, host facts, hook evidence, and policy. Contradictory Ready or Blocked outcomes are rejected. Malformed model echoes of backend fields cannot replace or invalidate the approved values. Legacy command strings may be repaired into a script for the current host shell without changing their text, with a visible warning.',
      'Filesystem Policy Enforcement: After each ready setup attempt, LoopTroop verifies in code that setup did not leave committable project changes outside LoopTroop or setup roots. If it did, the attempt fails and a retry note describes the violation. Common untracked generated or local outputs do not block setup, but they are logged and copied into profile `cautions` with suggested `.gitignore` entries. Setup never edits `.gitignore` automatically.',
      'Retry and Reset: If an attempt fails or returns an actionable Blocked result, LoopTroop records retry notes, resets tracked repository files back to the setup-phase start commit, preserves LoopTroop-owned ticket artifacts under `.ticket`, clears stale setup-profile and env-wrapper state while preserving `.ticket/runtime/execution-setup/tool-cache`, and retries within the normal iteration budget. A Blocked result with `not_provisionable` evidence and a reason stops immediately because the agent found no safe path. Repeated tooling-blocker protection still applies to retryable failures.',
      'Deadline Recovery: Once an attempt deadline expires, LoopTroop stops scheduling active setup work and returns a clear timeout failure. Process termination, session cleanup, safe worktree reset, and approved-input rematerialization may finish afterward so recovery stays safe. That cleanup does not consume the next attempt\'s fresh budget. Timeouts before session creation remain ordinary retryable setup failures.',
      'Manual Same-Session Attempt: After setup blocks, Retry with extra note... opens a dialog. Confirming sends only the entered text to the preserved setup session and grants one extra setup attempt beyond the attempts already used. It keeps the current runtime phase attempt and does not store the user text as future setup context.',
      'Return To Setup Approval: While this phase is active, you can go back to Approving Workspace Setup to edit or regenerate the plan. LoopTroop warns first, stops the active runtime setup session, archives both the approved setup-plan attempt and the current runtime attempt, clears stale runtime-profile outputs while preserving the tool cache, and requires the revised plan to be approved again before setup runs. The rewound approval actor stays quiet for that request, so manual edits are not overwritten by an automatic draft and regenerate starts only one setup-plan session.',
    ],
    outputs: [
      'A canonical execution setup profile artifact for Ready results, describing reusable temp roots, prepared runtime wrappers, tooling probe commands, provisioning-attempt evidence when relevant, discovered command families, and quality-gate policy for later coding beads and final testing. Blocked profiles stay diagnostic-only in the setup report.',
      'An execution setup report artifact with attempt history, final status, retry notes, worktree warnings, structured-output diagnostics, and Raw attempt variants for setup-generation retries.',
      'Temporary runtime artifacts under `.ticket/runtime/execution-setup/**`, including `tool-cache`, a host-specific coding-agent launcher when needed, and the profile mirror file `.ticket/runtime/execution-setup-profile.json`. Profile-declared setup and cache roots are excluded from later bead commits.',
    ],
    transitions: [
      'Setup Ready → Implementing: A valid setup profile with passing wrapper and probe validation advances the workflow into coding, where the first real bead starts at 1/N.',
      'Setup Blocked Or Failed → Blocked Error: A terminal honest Blocked result, retry exhaustion, repeated tooling blockers, provider or session failures, or committable project changes left by setup move the ticket to Blocked Error with the setup report preserved for diagnosis. Retry with extra note... can send one direct prompt to the preserved setup session. Edit setup plan... asks for confirmation before rewinding to approval.',
      'Edit Or Regenerate Plan → Approval Or Drafting: Manual editing rewinds one step to Approving Workspace Setup with the current plan. Regeneration archives the runtime and plan attempts, clears stale runtime outputs while preserving the tool cache, records a durable regeneration request, and enters Drafting Workspace Setup Plan.',
    ],
    notes: [
      'This phase is not a real bead. It does not change bead counts, is not part of final-testing scope, and never produces commits or pushes.',
      'Coding receives a read-only setup-profile file path instead of the full profile inline. That keeps later execution context smaller while still avoiding repeated environment rediscovery. Final testing also reads the setup profile and automatically applies a declared wrapper to generated commands that do not already use it.',
      'The approved setup plan stays the user-facing review artifact. Execution setup may augment it temporarily, but those augmentations are recorded in the execution report instead of silently rewriting the approved plan.',
      'Everything created here is temporary runtime state. Cleanup removes those temp roots at ticket end while preserving audit artifacts and execution logs. Later internal Git operations use the approved hook policy and ignore setup roots so prepared toolchains cannot become implementation work. LoopTroop materializes only ignored or untracked files and directories listed in the approved setup plan. It does not copy extra local inputs in response to a setup prompt.',
      'Internal setup and reset commands appear in `SYS > CMD` as completed-command summaries. Quiet git operations use concise outcomes instead of generic `ok` rows or progress streams.',
    ],
  },
  CODING: {
    overview: 'LoopTroop runs approved beads one at a time. The coding agent uses planned commands as guidance, runs the smallest sensible bead-scoped checks, and must return a structured all-pass completion marker. LoopTroop validates that marker without rerunning a frozen command list on its own. Deadline expiry and unresumable restarts go through Ralph reset-and-retry recovery. Local finalization failures become manual Retry or Cancel blocks. When all beads are done, Final Testing is still the required whole-ticket gate.',
    steps: [
      'Bead Selection and Tracker Update: LoopTroop reads the authoritative bead tracker, finds all runnable beads, meaning status `pending` with every `blocked_by` entry already done, sorts them by `priority` ascending, and selects the first one. It immediately marks that bead `in_progress` and updates ticket progress counters so the UI can show deterministic bead completion as a separate execution metric.',
      'Bead Start Commit Recording (Best Effort): Before the agent writes files, LoopTroop tries to record the current git HEAD SHA of the worktree as `beadStartCommit` and stores it in the bead tracker. This is the reset anchor if a later iteration fails. If recording fails, execution still continues, but reset-to-start and bead-diff capture are unavailable for that bead.',
      'Restart Recovery: If CODING resumes with an interrupted `in_progress` bead, LoopTroop first checks for an explicitly preserved continuation and then the latest `bead_execution:{beadId}` artifact. It reuses the exact preserved session or finalizes a checkpoint only when bead id, iteration, `startedAt`, `updatedAt`, and `beadStartCommit` match current durable state. Otherwise the interrupted attempt gets a deterministic Failed Iteration Note, resets to its start snapshot, advances to the next iteration, and returns to `pending`. The scheduler then starts that replacement iteration with a fresh configured deadline.',
      'Context Assembly: For the selected bead, LoopTroop assembles `bead_data` plus separately labeled Failed Iteration Notes, User Retry Notes, and Finalization Failure Notes. The prompt also points to the read-only setup profile at `.ticket/runtime/execution-setup-profile.json`. The agent gets only this bead-focused context, not the full beads plan, PRD, interview, or earlier coding transcript inline.',
      'Session Creation and Main Prompt: The locked main implementer opens a new OpenCode session with `keepActive: true` so the session can stay open for in-session retries and eligible provider or session Continue recovery. Workflow-owned iteration timeouts are not eligible for Continue. After context-wipe capture, that session is abandoned and the next attempt must use a fresh owned session. If OpenCode cannot create the session, LoopTroop retries with the shared 1s/3s/7s backoff and records health diagnostics before treating startup as blocked. The first bead prompt is sent only after a session exists. Session creation, prompt dispatch, and the start of streaming are logged as AI milestones with bead-iteration metadata so the live UI can show the current raw input before the execution artifact is written.',
      'OpenCode Retry Budget: During each prompt in the coding iteration, LoopTroop watches OpenCode `session.status` retry events. Matching provider or transport stalls, including rate limits, usage limits, resource exhaustion, overload, temporary unavailability, timeout, fetch, network, and socket-reset messages, count against the profile OpenCode retry limit and grace window. If either budget is exhausted, CODING throws a continuable provider error instead of consuming the bead iteration timeout or bead retry budget. Matching retry, session, or output-limit diagnostics are also kept as the latest underlying OpenCode cause if the bead later blocks through a completion-marker wrapper or bead retry budget. This provider or session budget is separate from the LoopTroop-owned per-iteration timeout.',
      'Inner Response Loop and Agent-Owned Verification: LoopTroop parses the `<BEAD_STATUS>` marker. Missing or malformed output uses the bounded structured-retry path, and a non-passing marker asks the same session to continue. The agent runs applicable bead-scoped tests, lint, typecheck, and qualitative review itself, correcting planned commands when repository evidence says they should change. A valid all-pass marker goes straight to local finalization. The single workflow deadline covers model work, checks, marker repair, and repair turns.',
      'Live Streaming: High-signal execution events, prompt dispatches, visible agent responses, file modifications, test results, and session lifecycle events stream into the normal phase log in real time. Deeper forensic details stay in the debug log.',
      'Scoped Verification: Planned commands stay language-agnostic and grounded in repository evidence. A bead may have no planned automated command if it records why none is appropriate, and detailed test scenarios do not require one command each. The agent may use the prepared runtime wrapper and discovered project commands without copying ignored tooling from another checkout.',
      'Success Path, Local Finalization, Diff Capture, Artifacts, and Broadcast: When the inner loop succeeds, LoopTroop first writes the full execution result as a `bead_execution:{beadId}` checkpoint tied to the exact in-progress bead state, including the raw bead-iteration prompt and output attempts captured so far. It then finalizes local work. `commitBeadChanges` must create a local per-bead commit whenever there are Git-visible project changes in any language or file extension, excluding LoopTroop and setup roots and excluding untracked generated or local noise. A true no-op may finish without a commit, and a remote push failure after a successful local commit is only a warning. Only after local finalization succeeds does LoopTroop mark the bead `done`, update progress counters, capture a code-only `bead_diff:{beadId}` from `beadStartCommit` when available, and broadcast `bead_complete` with progress counters.',
      'Failure Path, Failed Iteration Note: When the shared deadline or another iteration failure triggers Ralph recovery, LoopTroop records the raw attempt and appends a structured ANSI-free entry to `failedIterationNotes`. The entry includes timestamp, iteration, concise content, and an optional error code. Full output stays in execution and error logs. Earlier entries are never replaced, merged, or deduplicated.',
      'Failure Path, Worktree Reset and Status Rollback: After appending the Failed Iteration Note, LoopTroop resets the worktree to `beadStartCommit`, preserves `.ticket` artifacts, returns the bead to `pending`, abandons the active session, clears stale continuation state, and increments the outer iteration. Late output from the expired attempt cannot finalize the bead.',
      'Retry Budget and Finalization Boundary: Ralph failures consume the bead iteration budget and eventually block with `BEAD_RETRY_BUDGET_EXHAUSTED`. A valid all-pass marker moves to local finalization. Commit or finalization failure instead appends only to `finalizationFailureNotes` and immediately becomes a manual Blocked Error recovery. It is not converted into another Ralph iteration. Retry with extra note... appends the user text unchanged only to `userRetryNotes` after safe recovery is confirmed.',
    ],
    outputs: [
      'Updated bead statuses, from pending to in_progress to done or error, and ticket progress counters shown as a separate bead-completion metric. During CODING the ticket header, Kanban card, and navigator show deterministic bead completion as `completed_beads / total_beads` plus an approximate remaining-time estimate, while the normal progress ring still represents workflow-phase progress.',
      'Per-bead local git commits when a successfully completed bead changes Git-visible project files in any language or extension, or a true no-op completion when there are no committable project changes. Remote push failures and skipped untracked generated or local outputs are reported as warnings after local success.',
      'Per-bead code-only diffs, `bead_diff:{beadId}`, capturing what each bead changed in the repository, excluding `.ticket/**` metadata. These are written only when `beadStartCommit` was recorded successfully.',
      'Per-bead execution result artifacts, `bead_execution:{beadId}`, with raw bead-iteration attempts, initial prompts, final model outputs or diagnostics, error details, and current-bead checkpoint metadata, written on both success and failure.',
      'Three append-only per-bead histories: Failed Iteration Notes, User Retry Notes, and Finalization Failure Notes. Machine-generated entries are ANSI-free summaries. Full command output and stack traces stay in execution and error logs.',
      '`bead_complete` SSE broadcast events that drive real-time UI updates after each successfully finalized bead.',
    ],
    transitions: [
      'Bead Success + More Remaining → Stays in Coding: After a finalized successful bead, `BEAD_COMPLETE` is sent and the loop immediately selects the next runnable bead.',
      'All Beads Done → Testing Implementation: When every bead is marked `done`, `ALL_BEADS_DONE` is sent and the workflow advances to final testing.',
      'Bead Failure → Blocked Error: A bead that exhausts its Ralph iteration budget, hits an unrecoverable runtime error, or fails local finalization sends `BEAD_ERROR`. Ralph failures append to Failed Iteration Notes. Finalization failures use `BEAD_FINALIZATION_FAILED`, append to Finalization Failure Notes, do not broadcast `bead_complete`, and stay manual Retry or Cancel blocks. Retry with extra note... appends the user\'s timestamped guidance only to User Retry Notes after a safe reset.',
    ],
    notes: [
      'Only runnable beads are eligible for new execution selection. Interrupted `in_progress` beads are handled by recovery first: preserved continuations reuse their exact session, current checkpoints are finalized, and otherwise the interrupted attempt is noted, safely reset, incremented, and returned to `pending` before selection. Beads with status `error` are never selected until a retry moves them back into CODING.',
      'Inline context available to the agent is Current Bead Data, `bead_data`, plus the `bead_notes` slice rendered as three separate histories. Execution setup details stay available by reading `.ticket/runtime/execution-setup-profile.json` when needed. The agent does not receive the full beads plan, PRD, interview, or other beads\' results inline.',
      'The `beadStartCommit` is best effort. If git cannot record it before execution starts, that bead cannot be reset on context wipe and its diff artifact cannot be captured, but execution still proceeds.',
      'Every note producer is append-only. Ralph recovery writes only Failed Iteration Notes, Retry with extra note... writes the user text unchanged only to User Retry Notes, and local commit or finalization failure writes only a concise Finalization Failure Note. Entries are never replaced, merged, or deduplicated.',
      'The context-wipe note uses the failing session\'s full accumulated context, including tool calls, test output, and error traces, to generate an AI-authored diagnostic. If that capture prompt fails, LoopTroop builds a deterministic fallback note from recorded errors and recent tool-failure excerpts. The worktree reset still completes either way.',
      'Each successful bead with committable project changes creates a separate local per-bead git commit regardless of language or file extension. A successful no-op bead may finish without one. The integration phase later squashes all bead commits into one clean candidate commit for the pull request.',
      'Internal git commands in this phase are logged to `SYS > CMD` after completion with concise summaries for quiet outcomes such as clean worktrees, empty diffs, completed pushes, and context-wipe cleanup.',
      'The live workspace title shows bead and iteration progress only while CODING is the current ticket status. Its countdown is anchored to the active attempt\'s `updatedAt` and falls back to the bead\'s original `startedAt` only for legacy records. The left-panel workflow timeline keeps the last known bead count on historical CODING rows and completed tickets.',
      'Progress transparency: during CODING the normal progress ring still represents workflow-phase progress, while the header, Kanban card, and navigator show deterministic bead completion, `completed_beads / total_beads`, as a separate execution metric plus an ETA range, best, likely, and worst, recomputed on each bead completion. The ETA comes from recorded per-bead throughput and current retry pressure, using rich historical throughput bucketed by ticket size and effort tier when there are enough samples, otherwise the current run when it has signal, otherwise sparse history before falling back to the rough default. Hover text always clarifies that bead completion is execution-scoped, not workflow-phase progress, and that remaining time is approximate.',
    ],
  },
  RUNNING_FINAL_TEST: {
    overview: 'After all beads finish, LoopTroop runs a ticket-level final test to verify the implementation as a whole. The main implementer proposes structured commands for the approved current host. Direct processes are preferred, and scripts must name POSIX, Command Prompt, or PowerShell explicitly. LoopTroop applies the prepared structured environment directly, executes the commands on the current ticket branch, and audits dirty files so generated, cache, and setup-local outputs stay out of delivery.',
    steps: [
      'Context Assembly: LoopTroop loads ticket details, the approved PRD, the beads plan, and any final-test retry notes. The interview and Full Answers artifacts are intentionally excluded because the PRD and beads already contain the approved implementation intent.',
      'Test Plan Generation: The locked main implementer analyzes the full context and generates a structured final-test plan under the configured AI Response Timeout. The plan includes test commands, expected outcomes, what each test is verifying, and language-agnostic `file_effects` entries that classify files it expects to create or change as candidate, temporary, or unexpected. Tests may cover unit, integration, build verification, and acceptance-criteria validation. Malformed plan responses use the ticket\'s configured Structured Output Retries count and are kept as Raw attempt variants.',
      'Test Execution: LoopTroop runs each generated command with its explicit repository-relative working directory, environment variables, optional bounded timeout, and process or named-shell mode. The runtime profile contributes structured PATH additions and variables directly. Display text is rendered from the command object for logs and reports.',
      'Retry Reset: Between failed final-test attempts, LoopTroop resets project files back to the final-test start commit while preserving LoopTroop-owned ticket artifacts under `.ticket`.',
      'Result Recording: A final test report artifact is written whether tests pass or fail. It includes the generated test plan, actual command output, pass or fail status for each test, and any error messages or stack traces from failures.',
      'File Effects Audit: When final tests pass, LoopTroop compares dirty git state from before the passing attempt with dirty git state afterward and writes a `final_test_file_effects_audit`. Explicit candidate intent and tracked or staged changes are preserved. Recognized untracked generated, cache, or setup-local files stay on disk as local-only. An unknown untracked file gets one classification retry and then continues as local-only with a warning if it is still undeclared. An unresolved tracked change stays a candidate for later PR audit, while an explicitly temporary or unexpected tracked mutation is restored to committed content before candidate staging.',
      'Phase Logging: The normal phase log records the test lifecycle, including plan generation, command execution, output streams, and final results, for review and diagnosis. LoopTroop-owned reset and git-inspection commands are logged as completed-command summaries rather than recurring progress rows.',
    ],
    outputs: [
      'A final test report with the generated test plan, file-effects declarations, execution results, pass or fail status, error details, and raw-attempt diagnostics for final-test generation retries.',
      'A final-test file-effects audit listing baseline and post-test dirty files, produced or changed files, declared effects, candidate files, local-only files, deterministic classification reasons, retry outcomes, and warnings.',
      'Phase logs showing test command execution and output.',
      'A pass or fail gate that decides whether the implementation proceeds to the locked Manual QA route, direct integration, or recoverable error handling.',
    ],
    transitions: [
      'All Tests Pass + Manual QA Disabled → Preparing Final Commit: Successful final tests go straight to integration using the ticket\'s start-time Manual QA lock.',
      'All Tests Pass + Manual QA Enabled → Preparing Manual QA: Successful final tests advance to automated checklist generation, which resolves the file-effects audit and prepares the candidate-only QA checkpoint before asking for user verification.',
      'Local-Only File Effects → Continue Automatically: Generated, cache, and setup-local outputs stay in the worktree but are excluded from totals, checkpoints, and delivery. Unknown untracked files get one classification retry, then continue as local-only with a recorded warning if they are still undeclared.',
      'Any Test Failure → Blocked Error: Failed tests or final-test generation failures move the ticket to Blocked Error, where you can retry the test run or cancel.',
    ],
    notes: [
      'Context available: Ticket Details, PRD, Beads Plan, and Final Test Retry Notes.',
      'This phase tests the implementation as a whole and catches cross-bead issues that bead-level checks can miss.',
      'AI Response Timeout bounds the final-test model prompts. Command execution is still governed separately by the execution or final-test command timeout, so long-running shell commands are handled under their own limits.',
      'The test plan is generated dynamically so the main implementer can tailor checks to what was actually implemented, instead of assuming the right test already exists.',
    ],
  },
  GENERATING_QA_CHECKLIST: {
    overview: 'LoopTroop automatically prepares the next Manual QA checklist after final tests pass. This is an automation-only checkpoint. It reports meaningful preparation milestones, keeps the phase log visible, and exposes the finished checklist as a readable artifact with an exact Raw view. It does not ask for user input, and it never starts, stops, previews, or controls the user\'s application.',
    steps: [
      'Candidate Checkpoint Preparation: LoopTroop resolves the final-test file-effects audit, checkpoints accepted candidate changes exactly, leaves local-only test and runtime outputs available in the worktree, and records a delivery-relevant workspace baseline for detecting later application drift.',
      'Version Reservation: The next `vN` directory is reserved before any model work starts. A reservation does not count as an available artifact. The UI shows version selection only when more than one checklist-backed round exists.',
      'Focused Context Assembly and Inspection: The locked main implementer receives ticket details, the frozen approved PRD, selected bead fields, the current final-test report, the latest prior Manual QA artifacts, and targeted diff metadata. Focused read-only repository inspection is allowed, but repository-wide raw dumps are not.',
      'Checklist Generation and Validation: One strict tagged YAML response supplies checklist items, PRD references, and any approved-PRD criteria that are not applicable to human verification. Formatting-only repairs may normalize envelopes, YAML syntax, aliases, and safely quote YAML-sensitive text, but they never invent checklist text, actions, observations, or expected results. Invalid or overlapping PRD references use the normal structured-output retry policy.',
      'Coverage Computation: LoopTroop derives stable acceptance-criterion references from the approved PRD and computes covered, partially covered, uncovered, or Not applicable to Manual QA advisory coverage in code without a second model call. Every not-applicable criterion needs a reason.',
      'Persistence: The canonical checklist, coverage, generation reservation, and workspace baseline are written under `.ticket/manual-qa/vN/`, with compact append-only copies stored as phase artifacts.',
      'Progress and Artifact Presentation: The workspace reports checkpoint, reservation, context assembly, model and tool activity, validation, persistence, and handoff milestones. The artifact opens in a human-readable checklist view, with the exact canonical YAML available on its Raw tab.',
    ],
    outputs: [
      'A validated, immutable `manual_qa_checklist` artifact with app-assigned item and version ids, stable lineage, behavior and severity metadata, prerequisites, actions, expected results, watch notes, bead references, and PRD references.',
      'Advisory PRD coverage showing covered, partially covered, uncovered, and explicitly not-applicable acceptance criteria with reasons.',
      'A candidate-only Manual QA workspace baseline and durable version reservation for restart-safe generation. Local-only outputs may remain available to testing tools.',
    ],
    transitions: [
      'Checklist Ready → Waiting for Manual QA: A valid durable checklist advances automatically to the user-run verification gate.',
      'Generation, Validation, Or Checkpoint Failure → Blocked Error: Failures pause in recoverable error handling. Retry reuses the reserved version and any already valid artifacts.',
      'Cancel → Canceled: Cancellation stops workflow automation while preserving generated artifacts for audit.',
    ],
    notes: [
      'No user action is required here. This workspace exists to show live milestones, phase logs, and the finished checklist artifact before handing off to interactive Manual QA.',
      'LoopTroop does not launch or interact with the application being tested. The application remains fully user-controlled.',
      'Coverage gaps are advisory and do not block the checklist by themselves.',
      'The status title never includes a version suffix. Checklist-backed versions follow the same conditional attempt-selector pattern used by other versioned statuses.',
    ],
  },
  WAITING_MANUAL_QA: {
    overview: 'LoopTroop waits in the interactive Manual QA workspace while the user runs the application, records results and evidence, and verifies the generated checklist. Every item starts as Pending with no result-specific fields. Draft work autosaves with a visible last-save time. Only Submit or Skip finishes the round.',
    steps: [
      'User-Run Verification: The user starts and controls the application outside LoopTroop, follows each item\'s prerequisites and actions, and compares observed behavior with the expected result and watch notes.',
      'Focused Default: Pending is the default result. It shows only brief guidance. Result-specific notes, evidence, waiver, merge-group, and improvement controls appear only after the user chooses another result.',
      'Autosaved Draft: Pass, Fail, Waive, Improvement, Pending, notes, merge groups, improvement drafts, and evidence references are saved through revision-checked UI state. There is no manual Save action. The workspace says saving is automatic and shows a relative last-save time, with the exact timestamp on hover.',
      'Result Validation: Submit requires each required item to be resolved as Pass, Fail, Waive, or Improvement. Pass and Waive do not require evidence. Pass notes and waiver reasons are optional. Fail requires an observation. Every Improvement requires a reviewed title and description draft.',
      'Evidence Handling: Extra evidence offers matching Add link and Add files actions. Link and Details fields appear only after Add link is chosen. Add files opens the native picker from a dedicated button without unmounting or reloading the checklist. New uploads appear immediately without a refresh, and each item shows five evidence entries at first with Show more and Show less for the rest. Submit and Skip wait for active file uploads or removals, then the server keeps every durably stored file and safely drops dangling optional references. Any remaining file-integrity errors name the checklist item and filename instead of internal evidence ids. Only safe raster formats preview inline. Unsafe or unknown content is always served as an attachment.',
      'Failure Merge Groups: A failed item can select one or more other checklist items by number and title, including items not yet marked Fail. Submit is blocked until every selected member is also Fail, and each unresolved member is named in the validation message.',
      'Inline Improvement: Improvement editing stays inside the checklist item. Each draft includes a P1-P5 priority selector, with P3 Normal as the default, and a collapsed Advanced section for the child ticket\'s explicit Manual QA enabled or disabled setting, initially resolved from the effective project or profile setting. Manual QA context, final-description preview, and evidence or provenance preview are collapsed by default, along with the workspace\'s advisory PRD coverage.',
      'Workspace Drift Gate: Before Submit or Skip, LoopTroop compares project files with the saved QA baseline. Audited application-created drift must be explicitly included in a checkpoint or discarded before the action can continue.',
      'QA-Fix Planning: When any check fails, one locked main implementer prompt receives the failed merge groups and focused ticket, PRD, bead, final-test, checklist, evidence-reference, and diff context. At least one successful read-only repository inspection tool call is required so the resulting normal-quality beads can identify newly relevant files.',
      'Submission Journal: Final submission stages immutable results and the operation journal, generates and strictly validates one complete QA-fix bead candidate per failed merge group, then writes canonical `fix-beads.yaml` before creating any child ticket or bead. Only after the candidate is persisted does LoopTroop create configured Improvement tickets, append normal-shape `qa-fix` beads, write receipts and summary, and transition. Retry resumes the same action without duplicating work.',
      'Waiver and Skip Paths: Required waivers are recorded in a `waived_through` outcome, each with its own optional waiver reason. Skip warns that no QA-fix bead or improvement ticket will be created, takes an optional reason for the whole round, then archives every entered result, note, merge-group choice, improvement draft, and evidence reference as read-only even when normal Submit validation is incomplete.',
      'Loop Outcome: Passing, waived-through, or skipped rounds advance to integration. Any explicit Fail creates AI-planned, application-owned QA-fix work, archives the current round attempts, and returns the ticket to Coding. Successful fixes then get fresh final tests and a new checklist version.',
    ],
    outputs: [
      'An autosaved live draft plus an immutable submission snapshot and canonical versioned results and summary receipts.',
      'Secure evidence metadata and disk-only files, with copied provenance for any created improvement tickets or QA-fix work.',
      'A validated canonical `fix-beads.yaml` candidate artifact for failed checks, followed by normal pending `qa-fix` bead records whose lifecycle fields and identifiers are assigned by LoopTroop.',
      'A final outcome of `passed`, `waived_through`, `skipped`, or `created_fixes`, including created fix-bead and improvement-ticket ids.',
      'A skip reason on the round summary when the round was skipped, and a waiver reason on each waived item. Both are readable through the ticket-wide Skips panel in the Full Log.',
    ],
    transitions: [
      'Pass Or Optional-Pending Completion → Preparing Final Commit: With no failures and no required waivers, submission records `passed` and advances to integration.',
      'Required Waivers → Preparing Final Commit: Submission records `waived_through` and advances to integration.',
      'Skip → Preparing Final Commit: Skip bypasses normal result and merge-group validation, archives all entered data as read-only, records `skipped`, creates no improvement or QA-fix work, and advances to integration.',
      'Any Failure → Implementing: Submission creates full normal-shape Manual QA fix beads from a validated candidate artifact, records `created_fixes`, and returns to Coding. Improvements submitted in the same action stay separate backlog tickets with their chosen priority and Manual QA setting.',
      'QA-Fix Generation Or Validation Failure → Blocked Error: No child ticket or bead is created until the complete candidate set is valid and persisted. Retry resumes the exact stored submission action.',
    ],
    notes: [
      'This is the interactive consumer of the checklist artifact produced by Preparing Manual QA. The producer phase stays a smaller artifact-and-log surface.',
      'LoopTroop never starts, stops, previews, or otherwise controls the user\'s application.',
      'PRD coverage is advisory and collapsed by default. Improvement context and both description and provenance previews are also opt-in disclosures.',
      'Retry notes for normal bead failures stay separate from typed Manual QA origin data.',
      'A waiver reason explains one check. A skip reason explains the whole round. They are recorded separately and never merged.',
      'The status title is version-free. The version selector appears only when more than one checklist-backed round exists, and historical rounds remain selectable read-only after the ticket loops back to Coding or moves forward.',
      'The phase log is collapsed by default and follows the selected checklist-backed version, including submission, AI and tool, child-creation, completion, and error milestones. When expanded, its height can be adjusted manually.',
    ],
  },
  INTEGRATING_CHANGES: {
    overview: 'LoopTroop refreshes Git-hook evidence, records drift from the approved snapshot, and applies the ticket-run policy before creating the final candidate. Observe bypasses native hooks without separate checks. Check runs approved validations as advisory only. Require turns those validations into a gate. Run lets native hooks participate in Git operations. Then LoopTroop turns bead commits into one clean candidate commit while preserving bead history and the final-test file-effects audit.',
    steps: [
      'Branch Analysis: LoopTroop resolves the ticket worktree and base branch, calculates the merge base where the ticket branch diverged, and counts the number of individual commits made during bead execution. These internal git commands are audited in `SYS > CMD` as concise completed-command rows.',
      'Final-Test Audit Resolution: LoopTroop checks the latest `final_test_file_effects_audit` before staging. Explicit candidate intent and tracked or staged changes are preserved, local-only outputs stay unstaged, unknown untracked files continue with a warning after one unresolved classification retry, and unresolved tracked changes stay candidates for PR audit.',
      'Git-Hook Validation And Drift: LoopTroop compares current hooks and manager configuration with the approved backend evidence. Observe records a skip. Check runs approved structured validation commands and continues with warnings on failure or timeout. Require runs the same commands but blocks on failure. Run delegates to native Git hooks. Explicit validations audit worktree changes and restore only the mutations they introduced.',
      'Soft Reset: The branch is soft-reset back to the merge base, which unstages all bead-level commits but keeps all file changes in the working directory. This effectively uncommits the individual bead commits.',
      'Reviewer-Facing Candidate: Exact audited candidate paths are staged and committed as a single candidate commit with LoopTroop-specific commit metadata. Explicitly intended ignored files can still be staged by exact path, while local-only generated, cache, and setup outputs remain available but unstaged.',
      'Handoff Metadata: Integration records the candidate SHA, merge base, pre-squash HEAD, and squash statistics. That metadata becomes the source of truth for the next phase, which pushes the candidate and creates or updates the draft PR.',
      'Integration Report: The integration report captures the candidate commit SHA, merge base SHA, pre-squash HEAD, total commit count that was squashed, and file-change statistics. This report is persisted for audit and troubleshooting.',
      'Edge Case Handling: If there are no staged changes, for example if the beads produced no file modifications, or if git operations fail because of merge conflicts or a corrupt index, the phase records the failure and stops before PR creation.',
    ],
    outputs: [
      'An integration report artifact with the candidate commit SHA, merge base, pre-squash HEAD, commit counts, and file-change statistics.',
      'A candidate squash commit on the ticket branch, which is a single clean commit containing all implementation changes.',
      'Audited final-test candidate files included in the squash commit, while local-only generated, cache, and setup files plus LoopTroop internals stay on disk and out of the PR.',
      'Pre-squash metadata for audit, rollback reference, and troubleshooting.',
    ],
    transitions: [
      'Success → Creating Pull Request: A successful candidate commit advances the workflow to the GitHub sync phase, which creates or updates the draft PR.',
      'Failure → Blocked Error: Git operation failures, empty changesets, or merge conflicts move the ticket to Blocked Error. Local-only final-test outputs do not block integration.',
    ],
    notes: [
      'Context available: Git state, integration metadata, and the final test report. No new model context is assembled in this deterministic git phase.',
      'The squash commit preserves all file changes but replaces individual bead-level commit history with one clean commit.',
      'Individual bead commits are execution artifacts. They show how the AI worked through the task, not the commit history a human reviewer usually wants. Squashing gives reviewers one coherent candidate commit.',
      'The candidate commit is still local at the end of this phase. GitHub branch and PR sync happen next.',
    ],
  },
  CREATING_PULL_REQUEST: {
    overview: 'LoopTroop audits the final candidate files, pushes the approved candidate SHA to the remote ticket branch, and creates or updates a draft pull request on GitHub. This is the automatic GitHub handoff. It packages the final diff, the ticket intent, validation results, and any ignored-file decisions into a reviewer-facing draft PR without merging anything yet.',
    steps: [
      'Candidate File Audit: Before any remote side effects, the locked main implementer classifies every final changed file as include, exclude, or review using ticket scope, diff metadata, final-test results, and conservative generated-file rules. Exclusions need evidence. Generated or tracked files stay included unless the audit can explain why they are unrelated byproducts. Formatting-only YAML repairs are allowed only when the output structure proves the intended mapping, preserve the emitted text, and are recorded as audit warnings.',
      'Filtered Candidate Rewrite: If the audit excludes files, LoopTroop rewrites the local candidate from the merge base using only include and review files, records ignored files and reasons in `candidate_file_audit`, updates the integration handoff SHA, and captures the final net diff in `candidate_diff` before pushing.',
      'PR Drafting: Before any git or GitHub side effects, the locked main implementer generates a draft PR title and body in a fresh session under the configured AI Response Timeout using only ticket details and PRD as context, with integration report, final test report, diff stat, changed-file status, and diff patch appended as explicit prompt sections. Interview and beads artifacts are not fed into PR drafting.',
      'PR Draft Validation: The draft title and body response is parsed as structured output before branch push or PR create or update. If parsing fails, the ticket\'s configured Structured Output Retries count applies. Validation errors may use a continued-session prompt, while empty, provider, or session failures use a fresh session. If parsing still fails, LoopTroop records diagnostics and raw attempts, then falls back to deterministic title and body instead of blocking the ticket.',
      'Remote Candidate Push: LoopTroop force-pushes the final candidate SHA to the remote ticket branch using a lease, replacing the bead-level backup branch state with the single reviewable candidate commit. Internal push logging records the final result without progress output.',
      'PR Upsert: LoopTroop creates a new draft PR when none exists, or updates the existing PR title, body, and metadata when one already exists for the ticket branch.',
      'Metadata Persistence: The PR URL, number, state, head SHA, generated title and body, and timestamps are written into ticket artifacts so the review UI and later phases can reuse them deterministically.',
      'Failure Safety: If the push or GitHub operation fails, LoopTroop preserves the local candidate and worktree state and writes a recovery receipt describing the exact next safe actions. Git push, branch update, PR create or update, and review-waiting side effects are not retried automatically.',
    ],
    outputs: [
      'A Pull Request report artifact with PR URL, state, number, generated title and body, head SHA, and timestamps.',
      'A candidate-file audit artifact listing included, excluded, and reviewed files with reasons.',
      'Any formatting-only repairs applied while reading the candidate-file audit, listed as audit warnings and in the phase log.',
      'A candidate net-diff artifact used by PR review as the default diff view.',
      'The remote ticket branch updated to the final candidate commit.',
      'A draft GitHub pull request ready for human review.',
    ],
    transitions: [
      'Success → Reviewing Pull Request: A successful PR sync advances the workflow to the human PR review gate.',
      'Failure → Blocked Error: Push failures, GitHub auth issues, or PR creation or update failures move the ticket to Blocked Error.',
    ],
    notes: [
      'Context available: Ticket Details and PRD, plus explicit integration report, final test report, diff stat, diff name or status, and diff patch sections.',
      'Candidate-file audit runs in its own fresh session. Safe formatting-only repairs preserve the model-emitted paths and reasons and are shown as warnings; if validation still fails, LoopTroop falls back to including all files so malformed audit text cannot silently remove files.',
      'PR drafting starts in a fresh session after candidate-file auditing. If a matching active CREATING_PULL_REQUEST session exists, LoopTroop aborts and abandons it before creating the first draft session. AI Response Timeout bounds both the initial draft and structured retry prompts, and the draft session is completed before remote side effects begin.',
      'Structured PR draft retries happen before the remote branch push and before PR creation or update. If PR draft parsing is exhausted, LoopTroop records diagnostics and uses fallback text. Git or GitHub failures still move the ticket to Blocked Error with no automatic retry.',
      'This is the GitHub-native handoff from execution into review.',
      'The PR is draft-first by design so automated review or human review can happen before merge.',
    ],
  },
  WAITING_PR_REVIEW: {
    overview: 'LoopTroop stops automation and waits for you to review the draft pull request before finishing the ticket. This is the last human gate. You can inspect the PR in GitHub, review the net candidate diff, bead activity, ignored-file audit, and test results locally, then either merge the PR or finish the ticket without merging.',
    steps: [
      'Draft PR Presentation: The workspace shows the PR URL, current PR state, candidate SHA, branch and base refs, integration report, final test summary, candidate-file audit, and final net diff.',
      'Diff Review Modes: The bead-commits modal defaults to Net Diff for the actual base-to-candidate PR review surface, while By Bead preserves cumulative implementation activity and By File groups repeated bead touches.',
      'Manual Review: You inspect the draft PR and the local result. There is no time limit. LoopTroop waits for your decision.',
      'Merge Path: Choosing Merge PR & Finish marks the PR ready if needed and merges it into the base branch on GitHub. Once GitHub reports the PR merged, LoopTroop verifies that the remote base branch contains the candidate commit and leaves your local checkout untouched.',
      'Finish Without Merge Path: Choosing Finish Without Merge asks you to confirm, and takes an optional reason for stopping here. The PR and the remote ticket branch are preserved exactly as they are, then the ticket proceeds to cleanup and terminal completion. The reason is stored on the merge report as the current record, and in the ticket-wide skip trail as history. Nothing else explains why this branch stopped.',
      'External Merge Detection: If the PR is merged manually in GitHub while this phase is open, LoopTroop detects that during polling, skips a second remote merge call, verifies the remote base branch, and continues automatically.',
    ],
    outputs: [
      'A stable draft-PR review gate that exposes final PR metadata, test results, integration summary, ignored-file audit, and the net candidate diff.',
      'A merge report artifact recording whether the ticket finished as merged or closed unmerged, including the reason when you finished without merging.',
      'An explicit human decision before cleanup and terminal completion.',
    ],
    transitions: [
      'Merge PR & Finish → Cleaning Up: GitHub merge succeeds, remote base verification succeeds, and cleanup starts without changing the local checkout.',
      'Finish Without Merge → Cleaning Up: The ticket finishes successfully without merging and cleanup starts.',
      'System Error → Blocked Error: If the GitHub merge fails or the remote base branch cannot be verified to contain the candidate commit, the workflow blocks as a PR merge failure. Retry rechecks remote state without trying to merge again when GitHub already reports the PR as merged.',
    ],
    notes: [
      'Context available: PR metadata, final test report, integration summary, and merge controls. No AI prompt context is assembled in this review gate.',
      'This is the final human quality gate in the GitHub endgame.',
      'Finishing without merge does not require deleting the PR or the remote branch.',
      'Finishing without merge is a decision worth explaining. Nothing later in the ticket asks why the branch stopped.',
      'Internal merge, fetch, push, and cleanup commands appear in `SYS > CMD` as final summaries so the review gate stays auditable without noisy progress chatter.',
    ],
  },
  CLEANING_ENV: {
    overview: 'LoopTroop removes temporary runtime resources created during the ticket run while preserving the artifacts needed for audit, review, and history. This phase runs automatically right after verification and does not need user input. Cleanup errors are recorded as visible warnings, but they do not stop completion.',
    steps: [
      'Cleanup Scope Determination: LoopTroop decides which runtime resources are transient and safe to remove and which artifacts are permanent and must be preserved. Runtime state is treated as transient. Planning and audit artifacts are treated as permanent.',
      'Transient Resource Removal: Lock files, active session folders, stream buffers, temporary files, and runtime state files are removed when present. They were useful during execution but do not need to remain afterward.',
      'Artifact Preservation: Planning artifacts such as interview, PRD, and beads, plus normal and debug execution logs, test reports, integration reports, and phase-log history are intentionally preserved. They remain available for review, audit, and later reference.',
      'Cleanup Report: LoopTroop writes a cleanup report artifact describing what was removed, what was preserved, and whether any cleanup operations failed. The report includes `status: clean` or `status: warning`. Warnings are surfaced on the ticket while the workflow still completes.',
    ],
    outputs: [
      'A cleanup report artifact listing removed and preserved resources, with `status: clean` or `status: warning`.',
      'Freed disk space from transient runtime data such as lock files, session folders, and temporary files.',
      'Planning and audit artifacts, including interview, PRD, beads, test reports, and logs, preserved for later reference.',
    ],
    transitions: [
      'Cleanup Done → Done: Cleanup always advances the workflow to the terminal Done state after writing the report. Any removal failures stay visible as cleanup warnings.',
    ],
    notes: [
      'Context available: Ticket Details and Beads Plan.',
      'Cleanup is conservative. When there is doubt, LoopTroop preserves resources instead of deleting them.',
      'This phase is automatic and does not require user interaction.',
      'Cleanup warnings are housekeeping issues, not delivery failures. The ticket status still becomes Completed.',
    ],
  },
  COMPLETED: {
    overview: 'The ticket has finished its workflow and is now in a successful terminal state. All planning, execution, PR, testing, and cleanup artifacts remain available for review. The ticket records whether it finished through a merged PR or as a closed-unmerged completion, and it preserves the full implementation history. Cleanup warnings, if any, are shown separately and do not change the completed status.',
    steps: [
      'Terminal Status: LoopTroop marks the ticket as `completed` after cleanup finishes. This is final and irreversible. The ticket cannot be restarted or modified.',
      'Read-Only Workspace: From a workflow point of view, the workspace becomes read-only. No further AI phases run, no artifacts are modified, and no new planning or execution starts.',
      'Full History Access: All lifecycle artifacts remain accessible through the navigator and artifact views, including interview results, PRD, beads plan, per-bead execution logs, test reports, the integration report, and the cleanup report. You can review the full path from ticket creation to completion.',
      'Cleanup Summary: The ticket detail payload exposes the latest cleanup status, warning count, and cleanup report artifact id so housekeeping issues stay visible after completion.',
    ],
    outputs: [
      'A terminal `completed` status, which is the successful end state of the workflow.',
      'Full lifecycle history preserved for review, including interview, PRD, beads plan, execution logs, test reports, integration report, pull-request report, merge report, and cleanup report.',
      'A cleanup summary showing `clean`, `warning`, or `null` when no cleanup report exists.',
      'Completion metadata showing whether the ticket finished as merged or closed unmerged.',
    ],
    transitions: [
      'None: this is a terminal state. There are no forward workflow transitions from Completed.',
    ],
    notes: [
      'Reference artifacts available here include ticket details, interview results, PRD, beads plan, test reports, the integration report, and the pull-request report.',
      'The completed ticket is a permanent record of the implementation process and useful for reviewing decisions, understanding the result, or learning from the workflow.',
    ],
  },
  CANCELED: {
    overview: 'The ticket was stopped by user action before normal completion and is now in a terminal canceled state. By default, the work and artifacts created up to that point are preserved. At cancellation time, the user can optionally choose to delete AI-generated artifacts such as interview results, PRD drafts, beads plans, worktree code, and optionally the execution logs.',
    steps: [
      'Cancellation Recording: LoopTroop records the cancellation event, including the phase where cancellation was triggered, the timestamp, and any active sessions that were terminated.',
      'Active Session Cleanup: If AI sessions were still running when cancellation happened, for example during a council phase or coding, LoopTroop terminates those sessions gracefully.',
      'Optional Cleanup: If requested during cancellation, AI-generated artifacts such as interview Q&A, PRD drafts, beads plan, worktree code and its git branch, and either or both execution log files may be permanently deleted. Both cleanup options are opt-in and unchecked by default.',
      'History Preservation: Unless the user explicitly chose deletion, all artifacts generated before cancellation, including interview results, PRD drafts, beads plans, and execution logs, stay accessible through the navigator.',
      'Terminal State: Once cancellation is finalized, no more planning or execution actions are allowed. The ticket cannot be restarted from Canceled.',
    ],
    outputs: [
      'A terminal `canceled` status, meaning the workflow was permanently stopped by user action.',
      'Preserved history up to the cancellation point, unless the user chose to delete specific artifacts at cancellation time.',
      'No further workflow progress or artifact generation.',
    ],
    transitions: [
      'None: this is a terminal state. There are no forward workflow transitions from Canceled.',
    ],
    notes: [
      'Context available for reference is Ticket Details, though artifacts generated before cancellation are preserved in the workspace by default.',
      'Cancellation is available from most phases, including planning, approval, execution, and error recovery.',
      'Canceled tickets cannot be restarted. If you want to try again, create a new ticket.',
    ],
  },
  BLOCKED_ERROR: {
    overview: 'A blocking failure interrupted the workflow and LoopTroop is waiting for a human decision. The workspace leads with a plain-language explanation for the specific cause, such as an incomplete agent response, coding timeout, provider or environment interruption, exhausted implementation retries, final-testing failure, or Git finalization failure, along with the recommended recovery action. Technical messages, codes, diagnostics, and logs stay available in a collapsed details section, and earlier occurrences remain read-only.',
    steps: [
      'Error Recording: LoopTroop captures the error message, error codes when available, the exact failure timestamp, and the workflow status that failed. Provider, model, session, timeout, OpenCode retry, output-truncation, and rate-limit-style diagnostics are saved as structured fields when the failing subsystem exposes them. If OpenCode only streams a generic provider error, LoopTroop checks matching local OpenCode logs by session id and stores the sanitized provider cause when available. If structured-output validation later fails because OpenCode returned no usable content or ended with an output-length finish reason, the latest underlying OpenCode failure is preserved instead of being replaced by only the parser wrapper. All of this is stored as an error occurrence record.',
      'State Preservation: Blocked Error becomes the active workflow state while preserving the previous status, the phase that failed. That preserved status is what tells Retry and any eligible Continue exactly where to return. Backend, OpenCode, WSL, OS, and machine restarts revalidate an eligible continuation by the unresolved occurrence\'s exact session id and blocked-from phase. Temporary verification failures keep the session eligible instead of abandoning it.',
      'Error History: If a ticket has blocked more than once, for example retry, fail, retry, fail, every error occurrence is kept in history. That helps you spot repeated failures and decide whether retry is likely to help.',
      'Cause Explanation And Technical Context: Stable workflow events and error codes pick the plain-language title, explanation, and recommended recovery without guessing from log prose. Raw error messages, codes, stack traces, nearby logs, structured provider, model, and session diagnostics, and bead-specific context remain available under Technical details.',
      'Decision Point: You can choose Retry, Retry with extra note..., Edit setup plan... when workspace setup failed, eligible same-session Continue, or Cancel. For coding, the note is appended to User Retry Notes after safe bead recovery. For workspace setup, only the note is sent to the preserved setup session for one manual attempt. Finalization failures already have their own concise Finalization Failure Note and stay manual Retry or Cancel blocks. Ralph is used only for coding-iteration failures such as the workflow deadline.',
    ],
    outputs: [
      'An error-occurrence history with timestamps, error messages, error codes, structured provider, model, session, timeout, OpenCode retry, output-truncation, and rate-limit diagnostics when available, log-correlated provider causes when available, and the phase where each failure occurred.',
      'Blocked-state metadata linking the error to the specific phase that failed.',
      'A manual decision point with Retry, phase-specific Retry with extra note..., setup-plan editing, eligible same-session Continue, or Cancel.',
    ],
    transitions: [
      'Retry → Previous Status: Retry archives the active phase attempt with `manual_retry_after_blocked_error`, creates the next active attempt, and returns the workflow to the previously blocked status for every non-implementation phase. CODING keeps its special failed-bead reset before re-entering and does not create phase versions. For a live CODING block, Retry with extra note... performs the same safe recovery and appends a timestamped entry only to User Retry Notes after the bead can be identified and reset. OpenCode retry-budget or provider and session blocks may use Continue instead when the session is still addressable by exact id.',
      'Setup Retry With Note → Preparing Workspace Runtime: Retry with extra note... requires a preserved setup session. It keeps the current phase attempt, sends only the entered note to that session, and allows exactly one extra manual setup attempt. The user note is not appended to setup retry notes or later setup context.',
      'Continue → Previous Status: Continue is available only for eligible OpenCode or provider interruptions with a preserved active session addressable by exact id, including transient provider stalls, provider or session timeouts, selected 5xx or 529 and 408 or 429 responses, transport failures, and `HTTP 402 Payment Required` blocks that can be cleared outside the session. It is not available for CODING workflow-owned iteration timeouts, which keep resetting and retrying until the bead budget is exhausted. Eligible sessions survive backend, OpenCode, WSL, OS, and machine restarts when the unresolved error occurrence, previous phase, and exact remote session still match. Temporary verification failures preserve the active record for a later check, while only confirmed absence or stale ownership abandons it. Continue returns to the previous status without archiving or creating phase attempts and sends exactly `continue please` into that same session. For CODING provider interruptions, the blocked view treats the bead as paused instead of actively counting down. After Continue, LoopTroop starts a fresh per-iteration timeout window while reusing the preserved OpenCode session.',
      'Cancel → Canceled: Cancel moves the ticket to the terminal Canceled state. Artifacts and error history are preserved by default, and the cancellation dialog offers optional cleanup of AI-generated artifacts or the execution log.',
    ],
    notes: [
      'Past error occurrences stay reviewable even after the ticket moves on through retry or is canceled. Error history is never deleted.',
      'Manual retry versions for non-implementation phases are reviewed through the phase previous-version selector. Automatic structured retries inside a version are reviewed through artifact Raw attempt tabs, with parser and retry intervention warnings summarized on the main artifact tab. CODING retry history stays bead-scoped.',
      'Retry with extra note... is shown only on the live Blocked Error view when `previousStatus` is CODING or PREPARING_EXECUTION_ENV. It requires between 1 and 20,000 characters after whitespace-only input is rejected. Coding appends the text unchanged to User Retry Notes and starts a fresh bead recovery. Workspace setup sends it directly to the preserved session for one manual attempt. Historical errors and blocks from other phases do not offer note-bearing retry.',
      'When Drafting Workspace Setup Plan blocks during regeneration, Retry returns to that drafting version with the same durable regeneration-request artifact id. The request is cleared only after a valid or reviewable-invalid draft reaches approval.',
      'Continue is intentionally narrower than Retry. It is hidden unless the active error has a session id, the matching OpenCode session is preserved locally and addressable by exact id, and diagnostics point to a continuable provider or session condition such as `HTTP 402 Payment Required`, transient limits, overload, provider or session timeout, selected 5xx or 529 and 408 or 429 responses, or transport interruption, rather than a LoopTroop-owned iteration timeout, auth, non-402 quota, configuration, invalid-request, model-not-found, or request-size error. Restart reconciliation uses this same centralized eligibility classifier for every continuable error type instead of special-casing usage limits.',
      'Final-test file classification is unattended. Explicit candidate intent and tracked or staged changes are preserved, recognized local outputs stay on disk but out of delivery, unknown untracked files get one classification retry and then a warning, and unresolved tracked changes stay candidates for PR audit.',
      'Context available: Current Bead Data, if the failure happened during coding, plus Error Context with error message, codes, phase, and timing.',
      'Common causes include provider or model failures, session interruptions, model timeouts, output-length truncation, rate-limit-style failures, API connectivity issues, malformed AI output that fails validation, git operation failures, test failures, and dependency-graph violations.',
      'Before retrying, check the error details. Transient failures such as timeouts or connectivity problems often recover cleanly. Structural failures such as malformed output or missing configuration may fail again until the underlying issue is fixed.',
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
    return 'No automation runs here. Restarts simply reopen the saved ticket.'
  }
  if (phase.id === 'CODING') {
    return 'If the current bead can be matched safely after a restart, LoopTroop resumes it. Otherwise it resets that bead from durable state, keeps the retry notes, and continues. If the worktree cannot be trusted, it blocks instead.'
  }
  if (phase.id === 'BLOCKED_ERROR') {
    return 'Retry needs a recorded previous phase. Continue appears only when the same preserved OpenCode session is still recoverable by exact id. LoopTroop-owned coding timeouts do not use Continue.'
  }
  if (phase.id === 'COMPLETED') {
    return 'This terminal state is read-only. Restarts reopen the stored artifacts.'
  }
  if (phase.id === 'CANCELED') {
    return 'This terminal state is read-only. Restarts reopen preserved artifacts, but automation stays stopped.'
  }
  if (phase.kanbanPhase === 'needs_input') {
    return 'No background model work should be running. Restarts reopen the same saved draft or approval state.'
  }
  return 'Restarts rebuild this phase from durable state or reconnect the live work. If that is not safe, the ticket moves to Blocked Error.'
}

function withSafeResumeMetadata(phase: WorkflowPhaseMeta): WorkflowPhaseMeta {
  const safeResume = getSafeResumeDescription(phase)
  return {
    ...phase,
    description: phase.description,
    details: {
      ...phase.details,
      notes: [...(phase.details.notes ?? []), `Safe resume: ${safeResume}`],
    },
  }
}

const BASE_WORKFLOW_PHASES = [
  {
    id: 'DRAFT',
    label: 'Backlog',
    description: 'The ticket is still in backlog, so nothing is running yet. You can edit the core details, priority, and ticket-level settings before LoopTroop locks the current ticket text and starts planning.',
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
    description: 'LoopTroop is finding the files that matter for this ticket and saving accepted paths, excerpts, and reasons as shared planning context. This is a read-only grounding step for the council, PRD, and blueprint phases that follow.',
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
    description: 'Each council model is drafting interview questions on its own so the workflow can compare different approaches before choosing one. Models work in parallel from the same context, and only valid drafts move forward to voting.',
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
    description: 'The council is scoring the interview drafts and choosing the strongest question set. Drafts are anonymized so the vote stays about quality, not authorship, and the winner becomes the basis for the interactive interview.',
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
    description: 'LoopTroop is turning the winning draft into the interview you will actually answer, including normalized questions, batch state, and UI metadata. This is the step that converts the council winner into a consistent interactive artifact.',
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
    description: 'Answer the interview questions that will shape the PRD, or skip them with an optional reason the answering model gets to read. Draft answers autosave with visible state and last-save time. Non-final submissions can load another batch, and coverage may send the ticket back here with focused follow-up questions.',
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
    description: 'LoopTroop is checking whether the interview gathered enough information. If important gaps remain, it creates a focused follow-up round before approval. The loop is budgeted so the interview still converges instead of running indefinitely.',
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
    description: 'Review and approve the final interview before PRD drafting starts, including any answers you want to skip and why. Draft edits autosave with visible state and last-save time, but explicit Save is required to update the authoritative artifact. Approval then locks this interview as the source of truth for PRD drafting.',
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
    description: 'The council is filling skipped answers where needed and drafting competing PRDs. Each model works from its own completed answer set so the vote can compare both assumptions and specs. Invalid Full Answers stay diagnostic-only instead of turning into broken drafts.',
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
    description: 'The council is scoring the PRD drafts and choosing the best starting point. The winner is the baseline for refinement, not the final approved spec, and the weighted rubric focuses on completeness, clarity, and testable requirements.',
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
    description: 'LoopTroop is strengthening the winning PRD with the best missing details from the other drafts and producing PRD Candidate v1. Stable identifiers and text-preserving repairs keep the candidate reviewable before coverage begins.',
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
    description: 'LoopTroop is checking the current PRD candidate against the winning Full Answers, using focused read-only repository inspection only when needed to confirm repository-specific claims. It revises in place until the candidate is clean or the pass cap is reached, and remaining gaps can still move forward with warnings.',
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
    description: 'Review and approve the PRD before implementation planning starts. Draft edits autosave with visible state and last-save time, but explicit Save is required to update the authoritative artifact. Coverage warnings and the read-only Full Answers context stay available while you decide, and approving with known gaps takes an optional reason.',
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
    description: 'The council is breaking the approved PRD into competing semantic bead plans with tasks, dependencies, and verification intent. These drafts stay at the planning level, so exact file targets and runtime metadata are added later.',
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
    description: 'The council is scoring the blueprint drafts and choosing the most credible implementation plan before refinement and coverage. The vote focuses on decomposition quality, dependency logic, feasibility, and testability.',
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
    description: 'LoopTroop is improving the winning semantic blueprint with stronger tasks, tests, and constraints from the other drafts, using focused read-only repository inspection when needed. This still stays at the semantic layer, before execution-specific metadata is added.',
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
    description: 'LoopTroop checks the semantic beads blueprint against the approved PRD, using focused read-only inspection when required. It revises the blueprint until the required work is covered or the pass cap is reached, while keeping this stage semantic before expansion adds execution metadata.',
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
    description: 'LoopTroop transforms the coverage-validated semantic blueprint into execution-ready bead records with the concrete fields the coding loop needs. This adds file targets, dependency ordering, labels, and runtime metadata without redesigning the approved plan.',
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
    description: 'Review and approve the execution-ready bead plan before coding starts. Draft edits autosave with visible state and last-save time, but explicit Save is required to update the authoritative artifact. Approving with known coverage gaps takes an optional reason, and this is the last planning checkpoint before automated code changes begin.',
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
    description: 'LoopTroop is running the last readiness checks before setup-plan drafting starts so execution does not begin from a broken workspace or plan. It verifies repo state, required artifacts, coding-agent access, and bead dependency integrity.',
    details: WORKFLOW_PHASE_DETAILS.PRE_FLIGHT_CHECK,
    kanbanPhase: 'in_progress',
    groupId: 'pre_implementation',
    executionBand: true,
    uiView: 'coding',
    editable: true,
    multiModelLogs: false,
    contextSummary: [],
  },
  {
    id: 'GENERATING_EXECUTION_SETUP_PLAN',
    label: 'Drafting Workspace Setup Plan',
    description: 'LoopTroop is creating a read-only, host-aware workspace setup proposal for review. Live generation logs and versioned artifacts stay visible, and no setup command runs until a valid plan is explicitly approved in the next phase.',
    details: WORKFLOW_PHASE_DETAILS.GENERATING_EXECUTION_SETUP_PLAN,
    kanbanPhase: 'in_progress',
    groupId: 'pre_implementation',
    executionBand: true,
    uiView: 'phase_review',
    editable: false,
    multiModelLogs: false,
    contextSummary: [
      'ticket_details',
      'relevant_files',
      'prd',
      'beads',
      'execution_setup_profile',
      'execution_setup_plan',
      'execution_setup_plan_notes',
    ],
  },
  {
    id: 'WAITING_EXECUTION_SETUP_APPROVAL',
    label: 'Approving Workspace Setup',
    description: 'Review the host-aware setup plan before any runtime setup commands run. Draft edits autosave with visible state and last-save time, but explicit Save is required to update the authoritative artifact. You can adjust commands, probes, workspace inputs, and hook-validation commands; the project Git-hook policy is read-only.',
    details: WORKFLOW_PHASE_DETAILS.WAITING_EXECUTION_SETUP_APPROVAL,
    kanbanPhase: 'needs_input',
    groupId: 'pre_implementation',
    executionBand: true,
    uiView: 'approval',
    editable: true,
    multiModelLogs: false,
    reviewArtifactType: 'execution_setup_plan',
    contextSummary: [],
  },
  {
    id: 'PREPARING_EXECUTION_ENV',
    label: 'Preparing Workspace Runtime',
    description: 'LoopTroop is preparing the current host for this ticket with the approved setup plan. The phase must finish with an honest Ready or Blocked result before coding can start. Any temporary tooling, inputs, and environment changes are recorded in the reusable runtime profile.',
    details: WORKFLOW_PHASE_DETAILS.PREPARING_EXECUTION_ENV,
    kanbanPhase: 'in_progress',
    groupId: 'pre_implementation',
    executionBand: true,
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'beads', 'execution_setup_plan', 'execution_setup_notes'],
  },
  {
    id: 'CODING',
    label: 'Implementing (Bead ?/?)',
    description: 'LoopTroop is implementing the ticket one bead at a time. Each bead must finish its own checks before the workflow moves to the next one. Success creates bead-level execution history, while failures reset safely or pause for manual recovery.',
    details: WORKFLOW_PHASE_DETAILS.CODING,
    kanbanPhase: 'in_progress',
    groupId: 'implementation',
    executionBand: true,
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    progressKind: 'beads',
    contextSummary: ['bead_data', 'bead_notes'],
  },
  {
    id: 'RUNNING_FINAL_TEST',
    label: 'Testing Implementation',
    description: 'LoopTroop is running whole-ticket verification against the implemented result. This is the mandatory automated gate before Manual QA or final integration. The phase also audits file effects so local-only outputs stay out of delivery.',
    details: WORKFLOW_PHASE_DETAILS.RUNNING_FINAL_TEST,
    kanbanPhase: 'in_progress',
    groupId: 'post_implementation',
    executionBand: true,
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'prd', 'beads', 'final_test_notes'],
  },
  {
    id: 'GENERATING_QA_CHECKLIST',
    label: 'Preparing Manual QA',
    description: 'LoopTroop is preparing the next Manual QA checklist and candidate checkpoint from the passing implementation. This phase stays automatic and never controls your app. It also computes advisory PRD coverage and writes the next checklist version.',
    details: WORKFLOW_PHASE_DETAILS.GENERATING_QA_CHECKLIST,
    kanbanPhase: 'in_progress',
    groupId: 'post_implementation',
    executionBand: true,
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    reviewArtifactType: 'manual_qa_checklist',
    contextSummary: ['ticket_details', 'prd', 'beads', 'tests', 'manual_qa_previous'],
  },
  {
    id: 'WAITING_MANUAL_QA',
    label: 'Manual QA',
    description: 'Run the app yourself, work through the checklist, and record results in the autosaved Manual QA workspace. Submit finishes the round, and failed checks create QA-fix work. Waiving a check or skipping the round takes an optional reason, and improvements and evidence stay attached to the versioned checklist history.',
    details: WORKFLOW_PHASE_DETAILS.WAITING_MANUAL_QA,
    kanbanPhase: 'needs_input',
    groupId: 'post_implementation',
    executionBand: true,
    uiView: 'manual_qa',
    editable: false,
    multiModelLogs: false,
    reviewArtifactType: 'manual_qa_checklist',
    contextSummary: ['manual_qa_checklist', 'manual_qa_results'],
  },
  {
    id: 'INTEGRATING_CHANGES',
    label: 'Preparing Final Commit',
    description: 'LoopTroop is turning the bead commits into one review-ready candidate commit while applying the approved hook policy and final file audit. This is where the local execution history becomes the clean commit that will back the draft PR.',
    details: WORKFLOW_PHASE_DETAILS.INTEGRATING_CHANGES,
    kanbanPhase: 'in_progress',
    groupId: 'post_implementation',
    executionBand: true,
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'prd', 'beads', 'tests'],
  },
  {
    id: 'CREATING_PULL_REQUEST',
    label: 'Creating Pull Request',
    description: 'LoopTroop is auditing the candidate files, recording any safe formatting corrections, drafting the PR text, pushing the ticket branch, and creating or updating the draft pull request. This packages the final diff for review without merging anything yet.',
    details: WORKFLOW_PHASE_DETAILS.CREATING_PULL_REQUEST,
    kanbanPhase: 'in_progress',
    groupId: 'post_implementation',
    executionBand: true,
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'prd'],
  },
  {
    id: 'WAITING_PR_REVIEW',
    label: 'Reviewing Pull Request',
    description: 'Review the draft pull request, final diff, ignored-file audit, and test results before you merge or finish without merging. Finishing without merging asks for confirmation and takes an optional reason. This is the last human gate before cleanup and terminal completion.',
    details: WORKFLOW_PHASE_DETAILS.WAITING_PR_REVIEW,
    kanbanPhase: 'needs_input',
    groupId: 'post_implementation',
    executionBand: true,
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'interview', 'prd', 'beads', 'tests'],
  },
  {
    id: 'CLEANING_ENV',
    label: 'Cleaning Up',
    description: 'LoopTroop is removing temporary runtime data while keeping the artifacts and logs you may still want to inspect. Cleanup warnings remain visible, but they do not turn a successful delivery into a failure.',
    details: WORKFLOW_PHASE_DETAILS.CLEANING_ENV,
    kanbanPhase: 'in_progress',
    groupId: 'post_implementation',
    executionBand: true,
    uiView: 'coding',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'beads'],
  },
  {
    id: 'COMPLETED',
    label: 'Done',
    description: 'The ticket finished successfully. The workflow is now read-only, and the full planning, execution, PR, and cleanup history stays available. Cleanup warnings, if any, remain visible without changing the successful outcome.',
    details: WORKFLOW_PHASE_DETAILS.COMPLETED,
    kanbanPhase: 'done',
    groupId: 'done',
    terminal: true,
    uiView: 'done',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details', 'interview', 'prd', 'beads', 'tests'],
  },
  {
    id: 'CANCELED',
    label: 'Canceled',
    description: 'The ticket was canceled. No more automation will run, but existing artifacts stay available unless you chose to delete them at cancel time. This terminal state preserves the work completed so far for later review.',
    details: WORKFLOW_PHASE_DETAILS.CANCELED,
    kanbanPhase: 'done',
    groupId: 'done',
    terminal: true,
    uiView: 'canceled',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['ticket_details'],
  },
  {
    id: 'BLOCKED_ERROR',
    label: 'Error (reason)',
    description: 'A phase failed and LoopTroop is waiting for your recovery decision. The ticket keeps the error context, logs, and the exact phase that needs retry or continuation. The detailed view explains what failed and which recovery actions are actually available.',
    details: WORKFLOW_PHASE_DETAILS.BLOCKED_ERROR,
    kanbanPhase: 'needs_input',
    groupId: 'errors',
    uiView: 'error',
    editable: false,
    multiModelLogs: false,
    contextSummary: ['bead_data', 'error_context'],
  },
] as const satisfies readonly WorkflowPhaseMeta[]

/**
 * Every workflow status, as a union of the ids actually declared above.
 *
 * Derived rather than hand-written so a status cannot exist in one list and be
 * missing from another: a lookup keyed by this type will not compile until every
 * phase has an entry, and a misspelled status is a compile error rather than an
 * `undefined` that reaches the screen as a blank label.
 */
export type WorkflowPhaseId = (typeof BASE_WORKFLOW_PHASES)[number]['id']

export const WORKFLOW_PHASES: WorkflowPhaseMeta[] = BASE_WORKFLOW_PHASES.map(withSafeResumeMetadata)

export const WORKFLOW_PHASE_IDS = WORKFLOW_PHASES.map((phase) => phase.id)

export const WORKFLOW_PHASE_MAP = Object.fromEntries(
  WORKFLOW_PHASES.map((phase) => [phase.id, phase]),
) as Record<string, WorkflowPhaseMeta>

/**
 * Narrows an arbitrary string to a declared workflow status.
 *
 * Statuses arrive as plain text from the database, a restored state-machine
 * snapshot, or a query string, so anything unrecognised has to be handled rather
 * than trusted. Checks own keys only: `WORKFLOW_PHASE_MAP` is a plain object, so
 * a plain index would answer `'toString'` and `'constructor'` with inherited
 * members of `Object.prototype`.
 */
export function isWorkflowPhaseId(status: string): status is WorkflowPhaseId {
  return Object.prototype.hasOwnProperty.call(WORKFLOW_PHASE_MAP, status)
}

/**
 * Returns the full phase metadata for a given status ID, or `undefined` if the
 * status is unknown.
 *
 * Every lookup goes through the guard above, so "unknown" includes the names
 * inherited from `Object.prototype`. Callers treat a truthy result as a phase and
 * read into it, and a function is not a phase.
 */
export function getWorkflowPhaseMeta(status: string): WorkflowPhaseMeta | undefined {
  return isWorkflowPhaseId(status) ? WORKFLOW_PHASE_MAP[status] : undefined
}

/**
 * The statuses that mean the workflow is over — nothing will run again.
 *
 * Prefer `isTerminalWorkflowStatus`; this list exists for the callers that need
 * the values themselves, such as a SQL `IN (...)` filter.
 */
export const TERMINAL_WORKFLOW_STATUSES: readonly string[] = WORKFLOW_PHASES
  .filter((phase) => phase.terminal)
  .map((phase) => phase.id)

/**
 * True when the ticket has finished: no automation will run again, Cancel is
 * refused, and the ticket can be deleted.
 *
 * Every check of "is this ticket done" goes through here so that the answer can
 * only be changed in one place — `terminal` in the phase table above.
 */
export function isTerminalWorkflowStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && getWorkflowPhaseMeta(status)?.terminal === true
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
  // A finished ticket offers nothing. Read that from the phase table rather than
  // naming the statuses again here, or a status marked terminal later would keep
  // offering Cancel in the UI while the route answers 409.
  if (isTerminalWorkflowStatus(status)) return []

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
    default:
      return ['cancel']
  }
}
