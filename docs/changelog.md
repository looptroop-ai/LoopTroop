# Changelog

All notable changes and official releases for LoopTroop are documented here.
Unreleased changes appear first and represent commits that have not yet been included in a versioned release.

---

## Unreleased

> Changes merged since the last versioned release that have not yet shipped in a tagged version.

### Summary
- Rewrote and expanded every ticket-view workflow status summary and Details explanation in clearer, human-first language across the full lifecycle.
- Kept Specs and Blueprint refinement moving when models unambiguously displace stable item IDs or repeat equivalent change records.
- Added clarifying reassurance to the interview Skip All confirmation message noting that skipped questions will be answered by AI models at the beginning of the PRD phase.
- Kept boot-enabled LoopTroop services available during temporary npm audit outages without weakening dependency maintenance or local integrity checks.
- Kept selected OpenRouter routing preferences saved and highlighted when reopening Configuration.
- Made workspace setup current-host aware and non-blocking for malformed AI drafts, with portable structured commands and flexible Git-hook checks.
- Humanized and updated the `ticket-lifecycle-screenshots.md` documentation page to detail available user actions across all ticket workflow statuses, project creation, and configuration using clear, human technical writing guidelines.
- Standardized Manual QA selection styling across global Configuration, Project settings, and Ticket forms to match Git Hook Policy's primary black highlight aesthetic.
- Consolidated Manual QA checkpoint and Git hook policy options into a collapsed-by-default Advanced section in the backlog workspace view.

### Added
- Added direct-process and explicit POSIX, Command Prompt, and PowerShell command specifications with repository-relative working directories, structured environments, and bounded timeouts.
- Added backend-owned host context, Git-hook evidence, and previewed size limits for non-reproducible workspace inputs.
- Added `docs/ticket-lifecycle-screenshots.md` navigation entries to VitePress sidebar under Workflow, `docs/ticket-flow.md`, and `README.md`.

### Changed
- Rewrote the ticket-view workflow status summaries and Details dialog copy in `shared/workflowMeta.ts` so every phase reads more clearly for humans, expanded the top summaries to fuller explanations, and moved Safe resume guidance out of the top summary into the detailed notes while preserving the same workflow behavior, recovery semantics, and context expectations.
- Updated the interview Skip All confirmation modal message and workflow metadata to reassure users that skipped questions are answered by AI models during the initial PRD phase.
- Changed Git-hook handling to editable per-ticket Observe, Check, Require, and Run modes, with advisory checks as the non-blocking default.
- Refined `docs/ticket-lifecycle-screenshots.md` writing style by eliminating AI patterns, removing em-dashes, and updating status action details to match canonical state machine behavior.
- Aligned Manual QA setting selector buttons with Git Hook Policy styling using primary background highlight (`bg-primary font-semibold text-primary-foreground`) and hover states across Configuration, Project, and Ticket views.
- Wrapped Manual QA checkpoint and Git hook policy settings inside a collapsed-by-default Advanced section when viewing tickets in backlog (`DraftView.tsx`), matching Ticket creation and Project configuration forms.

### Fixed
- Safely restored displaced PRD and Beads item IDs from uniquely matching winner/final records, collapsed duplicate PRD modifications, surfaced exact UI repair details, and continued rejecting ambiguous mappings without inventing text.
- Retried and safely deferred temporary npm audit transport or malformed-response failures during startup while preserving strict standalone audit failures and blocking local dependency-integrity errors.
- Preserved OpenRouter routing suffixes after validating their base models so saved Configuration selections remain active when reopened.
- Prevented malformed model-owned setup fields, fake Git-hook evidence, and invalid setup drafts from routing tickets to Blocked Error before user review.
- Kept refreshed backend-owned workspace evidence stable across setup-plan saves so approval no longer enters a repeated “evidence changed” loop.
- Made Git-hook policy inheritance remain live until ticket start and visibly highlighted the effective selection when configuration, project, and ticket controls first open.

---

## 0.4.0 (2026-07-24)

### Release Highlights
- Manual QA Verification: Interactive post-implementation testing gate with evidence uploads, automated QA-fix loops, and direct backlog improvement creation.
- Modernized Dashboard and UI: Glassmorphic dashboard refresh, Markdown description previews, and resizable log drawers.
- Native OS File Watching: Replaced brute-force file polling with native file watching across Linux, macOS, native Windows, and WSL Linux filesystems for major CPU savings and faster feedback.
- 10-Member Councils and Routing: Support for up to 10 council models with live voting tallies and OpenRouter routing modifiers such as `:nitro`, `:thinking`, and `:free`.
- Smarter Diagnostics and Logs: Latest-first log pagination, standardized AI log headers, and live token, cost, and runtime tracking.
- Repo and Lifecycle Tools: New existing-repo attachment modes, complete ticket deletion, 50,000-character descriptions, and npm 12 support.

### Summary
- Redesigned the main dashboard and landing page using taste-skill anti-slop frontend guidelines, introducing sleek glassmorphism, refined dark/light mode tech aesthetics, ambient glow effects, header-aligned priority badges on Kanban cards, keyboard search shortcuts, and tech stack logo walls.
- Fixed ticket log opening so the newest 20 visible entries appear immediately instead of inheriting another ticket's scroll position or landing on hidden AI-detail rows.
- Added a pause-aware Actual implementation time to Ticket Details, with workspace, final-testing, and Manual QA fix-bead context.
- Sped up the dev server on Linux, macOS, native Windows, and remote/VPS hosts by using efficient native file watching by default instead of always polling, while still auto-enabling polling for WSL workspaces on Windows-mounted drives.
- Increased the ticket description limit to 50,000 characters and made validation failures explain what needs fixing.
- Made new-ticket creation explain missing project setup and surface create-request errors instead of appearing unresponsive.
- Kept development startup available when npm 12 misclassifies a registry-hosted optional tarball as a remote dependency during update preview.
- Added the live remaining/total timeout clock to Preparing Workspace Runtime.
- Made paginated log totals honest without removing the existing color legend.
- Clarified dev server startup output with explicit "LoopTroop App" and "Documentation" labels and a prominent Ready summary that now appears only once the app has fully loaded (frontend serving and backend startup complete).
- Made complete log navigation, copying, and hard-refresh restoration reliable for long ticket histories.
- Kept AI diagnostics and progressive log history visible and contextual while reviewing long phase and Full Log timelines.
- Added complete OpenCode AI diagnostics with assistant progress, live usage details, richer tool records, runtime variants, and provider recovery actions.
- Made workspace setup obey one total timeout per attempt and made duration settings easier to understand and edit.
- Made workspace setup finish with honest Ready or Blocked results and recover progress-only replies within the same attempt.
- Made cold ticket and status opens responsive by warming workspace modules and progressively loading projected logs.
- Made artifact loading responsive by separating lightweight manifests from on-demand, cache-validatable content bodies.
- Made bead verification lightweight and adaptable while preserving Final Testing as the mandatory automated delivery gate.
- Improved bead failure diagnostics so command failures and coding timeouts retain actionable execution context.
- Scoped each bead's execution log to the selected iteration, added a distinct all-iterations view, and clarified iteration states.
- Standardized AI log headers with full model identifiers across prompts, thinking, tools, and output.
- Recovered valid structured coverage results when a model appends an orphan Markdown fence and commentary after the artifact.
- Kept Beads coverage focused on PRD completeness while allowing project-agnostic verification commands.
- Made workspace setup preserve prepared tool environments and begin deterministic retries without avoidable AI-note delays.
- Expanded OpenCode session-scoped permission rules to match absolute paths, preventing workspace setup and tool provisioning from blocking on system read commands.
- Prevented unattended OpenCode work from stalling on unexpected permission requests.
- Added an explicit default None choice to model effort controls so providers keep their native effort behavior until you select an override.
- Kept GitHub readiness checks compatible with older GitHub CLI releases while retaining structured checks on current releases.
- Added concise, setting-specific guidance to Configuration documentation-link tooltips.
- Simplified inherited Git-hook and Manual QA controls with detailed hover guidance and lifecycle-organized Advanced settings.
- Made model configuration load quickly by requesting the full OpenCode catalog only when **Show all providers** is selected.
- Added safe restore, clear-tickets, and start-fresh choices when attaching repositories that already contain LoopTroop state.
- Expanded councils to support up to ten distinct models, including the main implementer.
- Kept dependency release-age checks compatible with npm 12 publish-metadata output.
- Allowed native dependencies to build automatically on npm v12+ via allowScripts configuration.
- Kept generated and cache outputs usable in ticket worktrees while automatically excluding them from implementation totals, checkpoints, and delivery.
- Made interrupted coding recovery consume a bounded fresh bead iteration with an accurate restarted countdown.
- Added support for OpenRouter routing modifiers (such as `:floor`, `:nitro`, `:thinking`, `:extended`, and `:free`) to customize model pricing, speed, and capability preferences.
- Added a 'Delete the ticket completely' option to the ticket cancellation dialog to clean up all database records and local files.
- Added the active execution setup attempt count (e.g. attempt 2 of 5) to the Preparing Workspace Runtime status title when running subsequent attempts.
- Made workspace setup recoverable when isolated worktrees need approved ignored or untracked inputs, including one direct same-session manual retry after the automatic budget ends.
- Made blocked errors immediately actionable and recovered safely wrapped YAML list prose across structured-output phases.
- Recovered PRD and interview coverage responses when quoted gap entries omit only their YAML list markers, preventing otherwise valid coverage findings from blocking a ticket.
- Prevented automatic development maintenance from installing peer-incompatible npm dependency graphs.
- Preserved eligible same-session Continue recovery across backend, OpenCode, WSL, OS, and machine restarts.
- Restored one-click recovery for blocked tickets when Retry sends an empty request body.
- Added language-agnostic workspace and Git-hook validation, adaptable agent-owned bead checks, and separate append-only implementation note histories.
- Made planning and interview prompts inspect repository evidence read-only only when supplied context cannot support a project-specific claim, while keeping council voting tool-disabled.
- Added a copy button next to the ticket description tab in the backlog workspace when clicking on the "Raw" view.
- Made ticket cancellation confirmation mandatory in every state, including Draft and Blocked Error, preventing accidental one-click cancellation.
- Added optional user guidance when retrying a blocked implementation bead, so the next fresh attempt can act on extra context without replacing existing notes.
- Bolded the live voting-result tally details in the council card description while voting is in progress.
- Changed ticket description to render as pretty Markdown by default (with a toggle to Raw text) when revisiting the Backlog phase on a started ticket.
- Added manual height adjustment to the expanded Manual QA log panel, allowing the drawer to be resized up or down.
- Modified Manual QA submission with failures to automatically expand the log drawer so users can monitor the QA-fix bead generation.
- Improved Manual QA with reliable canonical parsing, version-consistent status/history UI, richer logs and artifacts, reasoned PRD applicability, configurable Improvements, and repository-aware full QA-fix beads.
- Fixed application documentation links to consistently include the VitePress trailing slash base path, resolving public base URL mismatches when opening local docs from the header link, console summary, or documentation guides.
- Fixed `CLEANING_ENV` failures by recursively ensuring write permissions before deleting cached read-only files (like Go module caches) and added a hover tooltip to the Cleanup status in the Ticket Details dialog showing the exact cleanup warnings.
- Made project and ticket worktree deletion reliable for read-only caches and generated outputs across project ecosystems.
- Added a subtle top border to the collapsible log section when collapsed or expanded, ensuring visual separation from the content above it in the ticket workspace views.
- Manual QA Pass and Waive submissions now finish without evidence requirements or stale file-reference failures.
- Development restarts now open tickets safely without mixing stale and current React dependency generations.
- Development-only React hook dispatcher mismatches now recover automatically when restored React and React DOM modules have different Vite generations.
- Council voting phases now show a live `X/Y complete · Leading/Winner: <model> · <pts>` tally appended inline to the council card's description line (e.g. "Council members are scoring all prd drafts. · 2/4 complete · Leading: …") while scoring is in progress.
- Provider changes now appear after a lightweight Configuration reload without restarting OpenCode or interrupting active tickets.
- Simplified Manual QA configuration with consistent Enabled/Disabled choices at global, project, and ticket levels.
- Added a spec-aligned, ticket-locked Manual QA checkpoint with a distinct artifact-and-log preparation view and interactive verification handoff, turning failures into traceable fix beads and reviewed improvements into context-rich backlog tickets without controlling the user's application.
- Streamlined Manual QA with Pending-first items, inline Improvements, immediate evidence feedback, safer merge groups, autosave-only submission, and lossless skipping.
- Made autosave status and last-save timing visible across Interviewing and every editable approval draft.
- Added a new high-priority roadmap item for optional skip reasons to improve auditability of user skips across the workflow.
- Added Show/Hide Mock Tickets option to the Kanban triage filter bar.
- Consolidated the three separate chat roadmap items (Log AI Chat, Chat during execution, Chat in dashboard) into a unified **Ticket Chat & Action Assistant** with actionable write capabilities (approve/reject artifacts, edit artifacts and project files, trigger workflow actions) and full auto-execute with undo/rollback.
- Modified workspace drift detection to gracefully bypass Git checks and avoid throwing baseline-missing errors for display-only mock tickets.
- Updated the Core Philosophy documentation with a TL;DR overview and a new Manual QA Verification section.

### Detailed Changes

#### Added
- Added **Actual implementation time** below the overall Ticket Details duration. It totals only `CODING` intervals for originally planned beads, excluding time in `BLOCKED_ERROR` while an exhausted or failed bead waits for Retry or Continue and keeping Manual QA fix-bead work separate. Its help tooltip shows bead execution start, the final originally planned bead's completion (unchanged by Manual QA fix beads), and separate workspace-preparation, final-testing, and Manual QA-fix durations.
- Added client-side handling for server validation messages, including the exact ticket field and constraint that failed.
- Added visible new-ticket guidance when no project is attached and error toasts for failed ticket creation requests.
- Preparing Workspace Runtime now shows the current setup attempt's remaining and configured total timeout beside its live status. The clock resets from the attempt-start event on automatic retries and respects the effective project or profile setup-timeout setting.
- Added complete filtered entry and logical text-line totals to paginated log responses and the phase/Full Log count tooltip, alongside loaded/remaining progress and the existing color legend.
- Added forward-only per-turn AI metrics and expandable AI/model summaries for cost, token categories, and model time, plus latest runtime-variant hover details, tool duration/attachment/compaction metadata, and provider recovery actions in ERROR and model logs.
- Added ticket-isolated artifact manifest and content APIs, including SHA-256 ETags and a bounded batch body endpoint so large artifact histories no longer travel with the initial list or SSE artifact updates.
- Added effective commands and bounded output excerpts to deterministic bead verification diagnostics.
- Added ticket-level Git-hook policy overrides, start-time inheritance locks, and contextual documentation links in Configuration, Project Advanced settings, new-ticket Advanced settings, and the Draft workspace.
- Added three explicit existing-project attachment actions: restore all state, retain project settings while clearing every ticket, or delete `.looptroop` and start fresh. Destructive actions include active-ticket warnings, a keep/delete comparison, and a required confirmation.
- Added support for OpenRouter routing modifiers (such as `:floor`, `:nitro`, `:thinking`, `:extended`, and `:free`) in model configuration and validation, with a dedicated selector in the configuration profile setup.
- Added `deleteTicket` option to the ticket cancellation endpoint and a corresponding checkbox in the Cancel Ticket dialog, allowing users to erase all database records and local files, automatically disabling other cleanup options when selected.
- Added the active execution setup attempt count (e.g. `execution setup attempt 2 of 5`) from the phase logs to the `Preparing Workspace Runtime` status title when the setup attempt number is greater than 1.
- Added user-reviewed workspace input files and directories to execution setup plans, plus setup-specific **Retry with extra note...** and **Edit setup plan...** recovery actions.
- Added repository-level workspace probes and configurable explicit Git-hook validation with visible setup-plan evidence, editable validation commands, and audited internal-hook policies.
- Added a copy button next to the description's "Raw" tab in both DraftView (tickets in backlog before starting) and PhaseReviewView (backlog/DRAFT phase of started tickets).
- Added **Retry with extra note...** to live implementation errors, with a required multiline note that is appended to the recoverable bead's existing context before the next fresh attempt.
- Added reasoned **Not applicable to Manual QA** PRD coverage, P1–P5 and Manual QA settings for Improvement tickets, and strict repository-aware `<MANUAL_QA_FIX_BEADS>` generation persisted before child creation.
- Added cleanup warning messages display in a `<Tooltip>` on hover over the Cleanup status badge in the Ticket Details dialog.
- Added `errors` array property to the cleanup payload in backend database queries and frontend ticket normalization.
- Added a live voting-result tally to the ticket-view council card for `COUNCIL_VOTING_INTERVIEW` / `COUNCIL_VOTING_PRD` / `COUNCIL_VOTING_BEADS`: while a live voting attempt is selected, the header card's description line now appends ` · X/Y complete · Leading: <model> · <pts>` (switching to `Winner: <model> · <pts>` once a winner is selected), derived from the streamed vote companion artifact with no backend changes.
- Added an extensible Advanced Settings section directly below Models Selected in Ticket Details, showing whether the ticket's effective Manual QA checkpoint is Enabled or Disabled.
- Added contextual Manual QA help links to global Configuration, Project Advanced settings, new-ticket Advanced settings, and the Draft ticket workspace, with scope-specific tooltip guidance and direct navigation to the relevant documentation.
- Added the `GENERATING_QA_CHECKLIST` and `WAITING_MANUAL_QA` post-implementation statuses, versioned strict checklist/results/coverage schemas, stable item lineage, code-computed approved-PRD criterion coverage, and restart-safe generation reservations.
- Added profile-level Manual QA enablement (off by default), project/ticket `Enabled / Disabled` controls, Draft-only ticket editing, and frozen effective value/source fields at ticket Start.
- Added a lazy Manual QA workspace with generation guidance, required/optional result validation, pass/fail/waive/improvement/pending controls, five-second revision-checked autosave, evidence management, failure merge groups, improvement review, drift recovery, skip, and read-only historical rounds.
- Added contained streaming evidence storage with a 250 MiB per-file limit and no count/round cap, SHA-256/size verification, sanitized paths, symlink/traversal protection, atomic publication, safe-raster inline previews, attachment-only unsafe/unknown content, and HTTP(S)-only evidence links.
- Added restart-idempotent Manual QA submission journaling that persists validated `qa-fix` bead candidates before application-owned bead creation and creates one priority/configured Draft ticket per reviewed Improvement without duplicates.
- Added loop-aware public ticket projections (`visitedStatuses`, monotonic `workflowRevision`, and Manual QA round/outcome/artifact availability) plus Manual QA REST routes for rounds, evidence, submit/skip, and workspace-drift include/discard decisions.
- Added typed `qaOrigin` metadata and Manual QA Fix presentation across coding/bead/artifact/log views, with image evidence delivered through OpenCode SDK file parts for image-capable locked models.

#### Changed
- Aligned priority badges (`P1`–`P5`) into the top header row of Kanban ticket cards alongside the project badge and ticket key, preventing priority text truncation and visual line misalignments on short or multi-line titles.
- Updated `docs/core-philosophy.md` with a TL;DR block summarizing LoopTroop's purpose and key AI engineering methodologies, added Manual QA Verification as the fifteenth core philosophy section, and updated section count references from fourteen to fifteen.
- Increased create and update ticket descriptions from 10,000 to 50,000 characters and added explicit operation/category context to surfaced request errors.
- Dev server startup output now uses explicit "LoopTroop App" and "Documentation" labels instead of "Frontend" and "Docs", and prints a prominent Ready summary with direct URLs only once the app has truly loaded — the Vite frontend is serving **and** the backend has finished its full startup sequence (through step 6, signalled by `[startup] Startup complete`) — instead of appearing as soon as Vite is ready.
- Full Log now loads the complete remaining lifecycle before **Go to top**, targets virtualized extrema directly, and keeps **Back to bottom** pinned through layout updates. **Copy all** in phase and Full Log views continues to use the complete-history export independently of visible pagination, with a disabled spinner, progress tooltip, and retry feedback while the export and clipboard write finish.
- AI/model details now remain pinned while their log entries scroll, model hover details show the ticket-locked Configuration effort, and phase/Full Log history initially loads the latest 20 rows before visibly fetching older 250-row pages without moving the reader's position.
- Completed AI-detail persistence for every assistant message in the current prompt segment: intermediate narration is now an `ASSISTANT` Other event, terminal responses remain `OUTPUT`, and reused sessions do not duplicate older turns.
- Execution Setup Timeout now bounds all active work in one workspace-setup attempt, including provider recovery, continuation/correction prompts, validation, worktree checks, and retry-note generation; each genuine retry receives a fresh budget, while safe cleanup may finish afterward. Configuration now distinguishes AI, coding, and workspace-setup deadlines and provides compact inline synchronized seconds and minutes/seconds editors for every duration setting.
- Workspace setup prompts now use concise repository-grounded rules without assuming a language, build system, package manager, shell, or operating system. Ready requires every setup check to pass; actionable Blocked results retry, while evidence that no safe provisioning path exists stops immediately.
- Changed ticket history restoration to request the newest 20 projected log rows, merge them with bounded live SSE rows by stable identity, virtualize large timelines, and page older rows in 250-row batches only when the user scrolls upward. Copy all continues to export the complete matching history, while browser `localStorage` no longer stores full log snapshots.
- Warmed common ticket workspace modules in development and pre-optimized `react-virtuoso`; selected live workspace modules preload after ticket discovery and the common historical review view prefetches during idle time.
- Made cold log projection catch-up cooperative and deduplicated, with cached schema/prepared statements, so large JSONL histories do not monopolize the server while health checks are waiting.
- Beads may now explain why no planned automated command is appropriate, and coding agents may adapt planned commands to repository evidence instead of being blocked by a frozen backend rerun. Planning, refinement, and coverage favor only necessary bead-scoped commands without turning manual behavior, risks, optional alternatives, or broad integration scenarios into mandatory Coding gates; Final Testing remains strict.
- Bead detail logs now show only entries from the selected iteration, with an opt-in **Show all logs for bead** view when multiple iterations exist. The all-logs mode visibly deselects the iteration, and each iteration view is bounded by its own session start and the next retry so delayed old-session events cannot leak into another attempt; the list remounts on view changes so rows cannot persist between views. Active iterations show **In progress** while older attempts without an explicit outcome show **Rejected**.
- Standardized visible AI log headers as `PROMPT`, `THINKING`, `TOOL`, and `OUTPUT`, each carrying the complete model ID while keeping persisted log tags compatible with existing diagnostics.
- Full Answers, PRD and beads drafting, refinement, coverage, and blueprint expansion now have focused read-only repository inspection available after reviewing supplied context. They use it only to confirm unsupported repository-specific commands, paths, frameworks, package managers, build systems, or test runners; council voting remains tool-disabled.
- Interview drafting, refinement, live batched conversations, and coverage now have focused read-only repository inspection available after reviewing supplied context. They may confirm discoverable technical facts or decide whether a follow-up is necessary, but cannot infer stakeholder preferences, scope, priorities, desired behavior, or acceptance decisions; interview council voting remains tool-disabled.
- Structured coverage parsing now preserves a complete, schema-valid YAML artifact when only an orphan closing code fence and trailing commentary follow it; the UI records the exact lossless repair.
- Preparing Workspace Runtime now detects and records its canonical command wrapper, applies it consistently to independent probes and later commands, and reports visible failure-analysis and structured-correction milestones.
- Beads planning prompts now favor practical bead-scoped verification without restricting commands to a built-in ecosystem list, while continuing to reject unobserved language or framework assumptions.
- Beads coverage now audits requirement completeness against the approved PRD; launcher availability and command success remain runtime setup and execution concerns.
- Model effort pickers now include **None** as the selected default whenever no named override is set, including legacy saved `none` selections; choosing it clears the override for both the main implementer and council members.
- Added a shared autosave indicator to Interviewing and the Interview, Specs, Blueprint, and Workspace Setup approval editors, including pending, saving, saved, conflict, and failure feedback plus relative and exact last-save timestamps. Approval autosave preserves only the draft; **Save** still updates the authoritative artifact and applies downstream workflow effects.
- Configuration documentation-link tooltips now explain each setting's effect and available range or choice before linking to the detailed documentation.
- Consolidated the three separate chat roadmap items (Log AI Chat, Chat during execution, Chat in dashboard) into a single unified **Ticket Chat & Action Assistant** roadmap entry. The unified item preserves all read-only Q&A capabilities (log-scoped, execution-scoped, dashboard-scoped) and adds a new **Actionable Chat** sub-item with write capabilities: approve/reject planning artifacts, edit artifact content, edit project files, and trigger workflow actions via natural language. Write actions use a full auto-execute safety model with an append-only audit journal (`chat-action-audit.jsonl`) and per-action undo/rollback.
- Replaced Git-hook policy dropdowns and duplicate inheritance entries with linked **Validate**, **Ignore**, and **Run** buttons, keeping **Validate** as the recommended default in Pre-Implementation. Added multi-sentence behavioral tooltips to every Git-hook and Manual QA choice, renamed Configuration's Execution category to **Implementation Phase**, grouped Manual QA under **Post-Implementation**, and moved both project-level controls into one collapsed **Advanced** section. Project and new-ticket Advanced containers now use stronger borders so the settings are easier to notice.
- Model pickers and the model API now default to configured-provider models. `GET /api/models?scope=all` and the **Show all providers** option load the full catalog on demand through an independent cache, while Configuration reload clears both scopes and refreshes only configured models.
- Expanded the model council to a maximum of ten distinct members (the main implementer plus up to nine additional members); the supported minimum-quorum range remains capped at six.
- Existing-state attachment now updates the saved project path to the repository root on the current machine. Clear-tickets preserves project identity, appearance, creation time, profile association, and overrides while removing all ticket-linked records/content/worktrees, recording a new update time, and resetting numbering to `<SHORTNAME>-1`; start-fresh recreates the complete local state folder without altering repository commits or branches.
- Changed final-test file handling to preserve explicit and tracked/staged project changes while leaving untracked generated, cache, and setup-local outputs on disk as local-only files. Unknown untracked files receive one classification retry before continuing with a warning; unresolved tracked changes remain candidates for the final PR audit instead of blocking integration.
- Changed setup **Retry with extra note...** to send only the entered text to the preserved setup session and grant one manual attempt beyond the automatic retry budget without archiving the runtime phase attempt or saving the note as future context. **Edit setup plan...** now asks for confirmation before rewinding, and both dialog-opening labels use an ellipsis.
- Changed execution setup planning to compare the original checkout with the ticket worktree, propose only evidence-backed missing inputs, and materialize approved inputs before setup commands run.
- Made every held dependency and audit detail self-explanatory by naming the exact release-age, metadata, version, or peer-compatibility reason and showing the eligibility timestamp when applicable.
- Split bead history into append-only **Failed Iteration Notes**, **User Retry Notes**, and **Finalization Failure Notes**, keeping each source clearly labelled in execution context and workspace views.
- Changed execution setup readiness to require functional repository probes, audit configured Git hooks without assuming an ecosystem, and use explicit validation by default instead of allowing hidden hook failures during LoopTroop-owned commits.
- Extended implementation retry recovery and `POST /api/tickets/:id/retry` with optional user guidance, CODING-only validation, safe reset-before-append ordering, and append-only timestamped bead notes.
- Bolded the live voting-result tally details (e.g. `2/4 complete · Leading: <model> · <pts>`) in the Council card description line.
- Updated the description display when revisiting the Backlog (Draft) phase on a started ticket to show the pretty Markdown view by default with a tab toggle to view raw text.
- Updated description edit actions in the draft workspace to automatically restore the pretty Markdown view once changes are saved or canceled.
- Updated the expanded Manual QA log panel at the bottom of the workspace to support manual vertical resizing via a drag handle.
- Modified Manual QA submission to automatically expand the live log drawer at the bottom of the workspace when a failed result triggers a QA-fix coding round.
- Changed Manual QA status titles to remain version-free and show the established selector only for multiple checklist-backed rounds; Preparing now reports live milestones and presents structured/Raw artifacts, while Manual QA logs default collapsed and follow the selected version.
- Changed failed Manual QA Submit to require focused read-only repository inspection and full normal-bead candidates. Model/tool/parser failure now creates no children, enters recoverable Blocked Error, and resumes the stored submission action on Retry.
- Changed Manual QA items to start with a field-free Pending choice, made waiver reasons optional, collapsed advisory PRD coverage and Improvement context/previews by default, and moved Improvement editing inline with the checklist item.
- Reworked extra evidence into matching Add link/Add files actions, delayed Link and Details fields until requested, limited the initial evidence list to five entries, and added Show more/Show less disclosure.
- Replaced the separate Manual QA Save action with automatic saving, a relative last-save indicator and exact hover timestamp, while retaining Submit as the only primary completion action.
- Changed failure merge groups to multi-select checklist number/title buttons that may be assembled in advance but block Submit with named diagnostics until every selected member is marked Fail.
- Changed Skip Manual QA… to warn that no follow-up work will be created, bypass ordinary incomplete-result/group warnings, and archive all entered data read-only without creating QA-fix beads or Improvement tickets.
- Compacted the new-ticket and Draft-ticket Manual QA controls into a single row, retained their contextual `?` documentation links, and removed redundant effective-setting/source text.
- Removed the visible `Inherit` choice from Manual QA settings, restored the checkpoint selector for all new and Draft tickets, and made new project/ticket saves persist an explicit Enabled/Disabled value while safely resolving legacy unset values.
- Updated the Kanban triage control bar to support showing or hiding mock tickets (marked with `(M)`). This setting can be persisted in Kanban filter presets and defaults to showing mocks.
- Changed `TESTS_PASSED` routing to use the ticket's frozen Manual QA value: disabled/missing locks retain direct integration, while enabled tickets checkpoint final-test effects and enter the generated QA loop.
- Strengthened generic ticket UI state to serialized server-owned compare-and-set revisions with idempotent action IDs and latest-state `409` conflicts; existing approval autosave consumers retain debounce and unload keepalive behavior.
- Changed post-QA failure recovery to archive the current final-test/generation/wait attempts, schedule normal QA-fix beads, run fresh final tests, and allocate a new checklist version before integration.
- Extended final delivery and PR summaries with the latest Manual QA outcome, created fix-bead/improvement-ticket IDs, and skip/waiver state while keeping evidence binaries out of prompts, commits, diffs, and PRs.
- Changed Manual QA workspace drift detection to bypass Git worktree checks and return no drift for display-only mock tickets, resolving baseline-missing errors when loading mock tickets in the UI.

#### Fixed
- Fixed the initial ALL log page appearing empty when its newest projected rows were AI tool/detail entries that belong only in dedicated tabs. Overview pagination now filters those hidden rows before applying its 20-entry limit, so opening a high-latency remote ticket shows visible history without requiring a scroll-triggered older-page request.
- Fixed the Vite dev server unconditionally forcing `usePolling` for frontend file watching on every platform. The frontend and backend watchers now share one OS-agnostic decision (`resolveWatchPollingDecision()` in `shared/wslPerformance.ts`): native OS file-system events are used by default on Linux (including remote/VPS hosts), macOS, native Windows, and WSL workspaces on the Linux filesystem, while polling is auto-enabled only for WSL workspaces on Windows-mounted drives (`/mnt/...`). An explicit `CHOKIDAR_USEPOLLING` value still overrides the auto-detection in either direction. This removes constant polling CPU overhead and reduces refresh latency and HMR jitter, most noticeably on remote hosts.
- Deferred only the triggering direct dependency update when npm rejects a configured-registry tarball as remote during preview, while preserving npm's remote-package policy and clear daily-retry diagnostics.
- Fixed the ALL tab appearing empty after a hard refresh when the newest projected rows were all commands by excluding command-classified rows before applying overview pagination.
- Prevented progress-only workspace setup replies from consuming fresh attempts immediately: LoopTroop now continues the same session twice before failing the attempt with a functional incomplete-setup explanation, while malformed completed results keep their separate structured repair path.
- Replaced the generic workspace-setup check failure with a visible failed area and the setup agent's concise blocker explanation.
- Fixed blocked workflow errors that previously collapsed distinct agent-response, coding-timeout, environment/provider, final-test, and Git-finalization failures into generic messages.
- Prevented truncated streaming-thinking previews from repeating the model header above their retained tail lines.
- Fixed prepared toolchains disappearing during independent setup validation because a nested login shell reloaded profiles and overwrote the wrapper-provided environment.
- Removed the avoidable retry delay for deterministic setup failures by generating local retry notes for missing structured results and complete backend command failures.
- Fixed workspace setup (`PREPARING_EXECUTION_ENV`) blocking and timing out when setup commands run system diagnostics (such as checking CPU architecture or reading `/etc/os-release` to provision toolchains) by adding absolute path glob patterns (`*`, `/*`, `/**/*`, `**`, and `**/.*`) to the default allow-all OpenCode permission rules.
- Fixed unattended OpenCode prompts stalling on permission requests by replacing deprecated prompt-level tool maps with complete ordered session permission policies, explicitly allowing `external_directory` and `doom_loop`, and automatically approving unexpected requests once per request ID. Failed approval replies now abort the session immediately so the existing retry or blocked-error flow can recover.
- Pre-flight GitHub authentication now falls back to `gh auth status --hostname github.com` only when an older GitHub CLI rejects the JSON status flag, so valid older installations can proceed while current installations retain structured account validation.
- Fixed npm 12 dependency maintenance incorrectly holding releases whose publish-time metadata was returned as a one-element JSON array; both the legacy object and npm 12 array shapes now participate in the seven-day release-age check.
- Fixed native dependency builds (like better-sqlite3 and esbuild) failing or being skipped on npm v12+ by adding them to the allowScripts allowlist in package.json.
- Prevented generated and cache outputs from inflating implementation change totals or blocking final testing, Manual QA preparation, and integration when they are not delivery candidates.
- Restored type-safe OpenRouter router-model detection in profile configuration so the full lint gate remains clean.
- Fixed backend/OS restart recovery for an unresumable in-progress coding bead so the interrupted attempt is recorded in Failed Iteration Notes, the iteration number advances after the safe worktree reset, and the replacement attempt receives a fresh configured deadline.
- Fixed active bead countdowns after restart by retaining each attempt's `updatedAt` timestamp in public runtime and materialized ticket-state projections instead of falling back to the bead's original first-attempt `startedAt`.
- Fixed Vitest environment-specific test suite warnings and failures caused by `nvm` shell initialization warnings on stderr and mismatched prompt expectations.
- Preserved line breaks in long blocked-error details and cleaned ANSI sequences from those details as well as the main message, while preserving the raw logs. Terminal decoration, carriage-return artifacts, and repeated single-line or multiline warnings are also removed from the displayed error.
- Replaced the generic Blocked Error workspace essay with the failed phase, a bounded version of the captured error, and guidance for only the recovery actions currently available; historical occurrences are clearly read-only.
- Recovered model-generated YAML list prose that wraps onto deeper continuation lines by preserving the emitted text in a block scalar before shared structured-output parsing, instead of blocking otherwise valid PRD, Beads, and other artifacts.
- Allowed successful audit previews to continue when npm exits with status 1 solely because known vulnerabilities remain, while still rejecting peer-resolution and operational failures.
- Previewed direct dependency and audit proposals in isolation, validated their complete graphs with `npm ci --dry-run`, held incompatible releases without forced fallbacks, applied accepted graphs through deterministic `npm ci`, and restored the previous graph if application fails.
- Changed the dependency bootstrap and standalone sync paths to use the committed lockfile through `npm ci`, preventing missing or stale `node_modules` from silently rewriting dependency versions.
- Kept every centrally classified continuable blocked-error session restart-safe by matching exact project-local ownership, preserving transiently unverifiable sessions, and abandoning only confirmed-missing or stale records.
- Distinguished confirmed OpenCode session `404` responses from SDK transport and server failures so temporary verification errors no longer remove Continue.
- Preserved zero-byte POST streams after global JSON validation so body-free Retry requests no longer fail with a misleading invalid-JSON error.
- Prevented ANSI terminal control sequences from leaking into machine-generated bead notes while retaining complete raw command output in execution logs.
- Routed all ticket cancellation controls through the shared confirmation dialog, with existing optional artifact, worktree, and log cleanup choices preserved.
- Corrected workflow Details to consistently describe ticket prompt context as the saved title and description only, keeping Manual QA Improvement provenance, evidence, priority, project data, and settings informational.
- Fixed canonical Manual QA YAML being corrupted by model-output repairs when scalar identifiers contained colons, and preserved YAML-sensitive checklist prose such as hex-color values through safe quoting/repair.
- Fixed recursive deletion permission errors (`EACCES`) during the `CLEANING_ENV` phase by recursively making target files and folders writable before deletion.
- Fixed project Free Disk Space, ticket deletion, and canceled-ticket content cleanup failing on same-user read-only files or directories by routing whole-worktree removal through a contained, symlink-safe permission normalization and Git/filesystem fallback.
- Fixed the collapsed log element lacking visual separation in ticket workspace views by adding a subtle top border (`border-t border-border/40`) to `CollapsiblePhaseLogSection` by default when there is no active resize handle, and removed the duplicate top border from the parent container in `DraftView.tsx`.
- Fixed Manual QA submission races by waiting for active evidence uploads/removals, retaining valid durably stored files, and safely dropping dangling optional references before Pass or Waive completes. Any remaining file-integrity error now identifies the checklist item number/title and human filename instead of exposing an internal evidence ID.
- Fixed the first lazy ticket workspace opened after a development-server restart crashing with a null React hook dispatcher. Vite now finishes an explicit frontend dependency bundle before serving, marks dev resources `no-store`, deduplicates the React/React Query graph, and performs a cooldown-limited development-only reload if an already-restored tab still reports two dependency generations, including mismatches visible between `react.js` and `react-dom_client.js`.
- Fixed Manual QA Add files collapsing the ticket to its header/loading state by retaining the mounted workspace during backend recovery, keeping the liveness probe outside the normal read-rate budget, recognizing rate-limited health responses as reachable, and opening the native picker from a dedicated button. Successful uploads continue to appear in the active checklist item immediately.
- Fixed the first Manual QA handoff showing `Manual QA version not found` until refresh by deferring reserved-version reads until the checklist is handed off and reconciling Manual QA queries on artifact, status, and stream-recovery events; Preparing Manual QA now exposes the exact checklist as a clickable artifact beside its status and log instead of duplicating the interactive Manual QA screen.
- Fixed the Configuration model-refresh icon to spin and remain disabled for the full provider/model refresh instead of stopping before the refresh request completes.
- Fixed stale provider/model discovery after OpenCode credentials change: Configuration reload now disposes only LoopTroop's catalog/root OpenCode instance before refetching the catalog, while leaving `opencode serve` and active ticket worktree instances running.
- Fixed application documentation links to include the VitePress `/docs/` base path and trailing slash, resolving the public base URL mismatch page when opening local docs from the header link, console summary, or documentation guides.
- Aligned Manual QA checklist sources, required/optional severity, and recheck states with the documented contract; required checks now support non-blocking Improvements, improvement tickets share deterministic IDs and retain editable human-readable PRD/bead/evidence context, and QA-fix origins carry their model capability and creation timestamp.
- Fixed Manual QA recovery end to end: strict action guards run before reservation, immutable results and incomplete journals resume safely, terminal retries repair missing summary/skip-receipt phase mirrors before transitioning, submit/skip and evidence mutations reuse durable identities without duplicate work, exact checkpoint files exclude staged residue, model image file parts reach coding sessions, and reverse-loop history remains reviewable through later errors or cancellation.
- Preserved complete Manual QA round summaries and coverage/source provenance in historical review, made upload/removal/drift retries reuse their identities with fresh CAS guards and visible reconciliation errors, retained exact failed files in collision-safe Retry/Dismiss states, and surfaced typed QA-fix origins in structured bead artifacts and grouped Coding logs while keeping retry notes separate.
- Fixed checklist-generation recovery to reuse its reserved version, rebuild missing deterministic coverage without another model call, and independently repair half-written compact checklist/coverage artifacts; evidence storage now also preserves concurrent uploads, repairs removals interrupted after unlink even with a new action after reload, and rejects symlinked ancestor directories before reads, removals, or directory creation.
- Bound final-test file-effect decisions to the exact audit that produced them so an older Manual QA round cannot resolve fresh unclassified files, and retained all earlier QA fix-bead/improvement-ticket IDs in final integration and PR summaries after a later round passes.

#### Removed

#### Maintenance
- Isolated the pull-request workflow suite from the shared pure-test module graph so its prompt-runner mocks cannot race with real council and PRD prompt tests during full parallel verification.

#### Documentation
- Documented conditional read-only repository grounding across Council, prompt inventory, context-engineering, workflow status Details, OpenCode integration, and ticket-flow references.
- Reworked Git-hook guidance around the three user-facing choices, inheritance and locking, and the operational difference between explicit validation and running repository hooks.
- Documented workspace input approval and materialization, setup-runtime recovery actions, retry API behavior, and readable blocked-error output across the execution guides and references.
- Documented the **Retry with extra note...** workflow, validation, context contract, and API behavior across the Implementing and Blocked Error status details and focused execution guides.
- Updated Manual QA status Details and reference guides for version-free titles, structured history, activity/log/artifact presentation, four-state PRD coverage, configurable Improvements, and failure-safe AI-planned QA beads. Existing testing tickets/artifacts are intentionally not migrated.
- Updated the Manual QA status details and reference guides for Pending-first results, optional waiver reasons, collapsed disclosures, inline Improvements, evidence controls, merge-group validation, autosave status, and lossless Skip semantics.
- Documented Manual QA configuration/inheritance, strict checklist/result contracts, Submit-versus-Skip artifact semantics, routes/CAS, workflow/status details, checkpoint/drift safety, prompts/normalization, context-rich Improvements, self-contained QA origins, frontend routing/timeline, architecture impacts, and post-implementation outcomes across the README and reference guides.
- Added **Skip Reason Auditability** to the [High Priority roadmap](roadmap.md#high-priority): users can provide an optional reason when skipping any step, prompt, or approval gate, and the reason is persisted in the relevant ticket artifact.

---

## 0.3.3 (2026-07-07)

### Summary
- Added Google Analytics (gtag.js) to the marketing landing page.
- Added live execution progress: during coding the ticket header, Kanban cards, and phase navigator show deterministic bead completion (done/total) as a distinct metric plus an approximate remaining-time (ETA) range that sharpens as work proceeds.
- Folded the Deterministic Command Safety Guard roadmap item into the larger Sandboxing & Guardrails roadmap item.
- Added historical notes to the Ticket-Scoped Phase Flags roadmap item detailing the pre-consolidation features.

### Detailed Changes

#### Added
- Google Analytics (gtag.js) tracking code to the marketing landing page (`web.html`) with measurement ID `G-9L5KPS2CXD`.
- Bead-completion progress during execution: while a ticket is coding, the header and Kanban card show a distinct bead-completion chip so workflow progress and bead progress do not share the same visual scale.
- ETA forecast for active execution: a best/likely/worst remaining-time range shown in the ticket header, Kanban cards, and phase navigator, recomputed on each bead completion. Estimates use historical throughput bucketed by ticket size and effort tier when enough history exists, fall back to the current run while a ticket is building its own sample set, use sparse history before the hardcoded default, and are always flagged as approximate on hover.
- Per-bead throughput telemetry: a new project-database table (`bead_execution_metrics`) records completion time and retry count for each completed bead, measured from bead start to bead completion while excluding time spent outside `CODING`. Recording is best-effort and can never interrupt an execution run. Token/cost columns are reserved for a future Cost Management feature.

#### Changed
- Consolidated the standalone Deterministic Command Safety Guard roadmap item into the Sandboxing & Guardrails roadmap item, merging pre-execution command checking, subshell detection, and path confinement rules with runtime container/VM safety profiles.
- Updated the Ticket-Scoped Phase Flags roadmap item with historical details of the features it consolidated and replaced, including Argue the opposite, Winner model discussion, and Exhaustive Interrogation Mode for Interviews.

---

## 0.3.2 (2026-07-01)

### Summary
- Added Status (every workflow step) and Phase (all workflow groups) multi-select filters plus a tri-state Errors filter (No errors / Has errored before / Currently blocked) to the Kanban triage bar.
- Fixed saved Kanban filter presets disappearing after a browser refresh by keeping them in the single durable UI-state record and no longer overwriting stored state with an empty read on load.
- Fixed Kanban preset saving to gracefully fallback to in-memory storage when browser storage (localStorage) is disabled or sandboxed, avoiding "Could not save preset" errors.
- Removed the redundant "Run active / Run 19/19" progress/health badge from Kanban board ticket cards.
- Added advanced sorting (bidirectional updated date, created date, priority, and title) and custom triage filtering (priority, stale/inactive, and error only) to the Kanban board, complete with project-scoped local presets and ticket description search.
- Improved Kanban operator triage with active-filter visibility, preset hover details, search match hints, and stale filtering that focuses only live workflow columns.
- Added animated status icons for AI council actions and throbbing warning indicators for blocked ticket error states.
- Added an About window for app-level storage details and surfaced each project's local `.looptroop` state path in Project Details.
- Added ack-aware yellow flashing for tickets waiting on user input, so the dashboard highlights what needs you and stops flashing once you've opened the ticket.
- Fixed startup after the `js-yaml` v5 dependency update by aligning YAML imports and types with the package's ESM exports.
- Added standard contribution, code of conduct, issue, and pull request guidance so repository visitors have a clear path for reporting and contributing.
- Expanded the Core Philosophy doc to cover all fourteen of LoopTroop's foundational ideas, each opening with a short summary and verified against the actual code.
- Reorganized the Core Philosophy doc: moved the durable-state rationale into System Architecture and the "what LoopTroop is (and is not) for" guidance into Getting Started, and sharpened the Five Core Commitments around context engineering, thorough planning, and human-in-the-loop.
- Collapsed the changelog's Unreleased section by default behind a short explanatory note, so the page opens on the latest tagged release.
- Added approval-screen AI extra fixes for unresolved PRD and beads coverage warnings, with unlimited manual attempts and `Extra Fix N` report history.

### Detailed Changes
#### Added
- Added a Triage & Filter Control Bar to the Kanban board (`KanbanBoard.tsx`), enabling client-side filtering of tickets by Project (dropdown with project icons and emojis), Priority (Very High to Very Low toggle badges with hover tooltips), Inactivity age (Stale > 24h, > 3d, > 7d affecting only the Needs Input and In Progress columns), and Errors only. The bar is hidden by default and can be toggled via a premium filter control button next to the search bar.
- Added custom filter presets that let users save, load, and delete named filter/sort configurations, scoped per project and persisted in the durable `looptroop-ui-state` record (`UIState.presetsByProject`).
- Added 8 bidirectional sorting modes to Kanban columns (`KanbanColumn.tsx`): Last Updated (Newest/Oldest), Date Created (Newest/Oldest), Priority (High to Low/Low to High), and Title (A-Z/Z-A).
- Added `formatRelativeDateChip` to ticket cards to show clear calendar-relative date chips (`Today HH:MM`, `Yesterday`, or weekday name) with absolute timestamp tooltips.
- Expanded the dashboard search component to index and search ticket descriptions in addition to external ID, title, and project metadata.
- Added active-filter count badges and detailed hover text to the Kanban filter slider, so hidden project, priority, stale, error-only, and non-default sort settings remain visible from the header.
- Added search match hints to Kanban cards (`ID match`, `Title match`, `Description match`, or `Project match`) so operators can see why a ticket matched the current dashboard search.
- Added compact run-health chips to active Kanban tickets with phase, bead progress, ticket-update age as the available model-response freshness signal, retry count, and last-error hash details in the tooltip.
- Added animated, context-specific status icons for AI council members and artifact status chips during drafting (writing pencil), scoring (flipping hourglass), refining (spinning arrows), and verifying (scanning magnifying glass) phases, with automatic prefers-reduced-motion overrides.
- Added a pulsing/throbbing warning animation to active warning and error icons across the Kanban board cards, active ticket header summary, sidebar indicators, activity strip, and live error card views.
- Added a read-only `About` window at the end of Configuration that opens in a separate modal and shows app-level storage/runtime details: app version, app database path, config directory, storage source, attached-project count, and a short explanation that project-local LoopTroop state lives inside each repository's `.looptroop/` folder.
- Added the project-local LoopTroop state path to Project Details so users can immediately see where the selected repository keeps its `.looptroop/` folder.
- Added ack-aware yellow flashing on dashboard cards for tickets in the Needs Input column (interview answers, approvals, PR review). When a ticket starts waiting on you, its card flashes a soft yellow border; the moment you open the ticket the flashing stops and the border reverts to the static project color, even if the required action was not performed. A new wait (different status or re-entry) flashes again. Red error flashing still takes precedence, the existing pending-question pulse is suppressed inside Needs Input, and reduced-motion users get a steady amber border with no flashing. The acknowledgment is persisted per-ticket via the existing UI-state channel (new `needs_input_attention` scope) so it survives reloads and syncs across tabs.
- Added `Fix gaps with AI` on PRD and beads approval warnings. Each click runs one fresh targeted fix session plus one fresh coverage check from the latest server artifacts, records the attempt as `source: ai_fix_button`, and keeps the warning actionable until gaps are cleared or the user chooses to approve with gaps.
- Added `POST /api/tickets/:id/coverage/fix-gaps` for approval-screen PRD/beads extra fixes, including per-ticket/domain concurrency protection and no-op success when the latest coverage artifact is already clean.
- Added Status and Phase multi-select filters to the Kanban triage bar (`KanbanBoard.tsx`). Status lists every workflow step grouped by phase (Backlog, Scanning, Council Drafting, …, Done, Canceled, Blocked Error); Phase offers all ten workflow groups (To Do, Discovery, Interview, Specs (PRD), Blueprint (Beads), Pre-Implementation, Implementation, Post-Implementation, Done, Errors). Both narrow tickets within their existing Kanban columns and are included in saved presets and the header active-filter summary.

#### Changed
- Kanban saved presets now show their full saved filter/sort details on hover instead of relying on expanded preview content in the dropdown.
- Kanban stale/inactive filtering now clears To Do and Done and only evaluates Needs Input and In Progress tickets, making stale triage focus on live operator workflow columns.
- Beads approval extra fixes now refresh the semantic blueprint and rerun expansion when the blueprint changes, so the execution-ready approval plan and reviewed content hash stay current before approval.
- Coverage reports now include user-triggered approval attempts as `Extra Fix N` tabs alongside normal version transitions while keeping `Latest Check` last and selected by default.
- PRD and beads approval actions now read `Approve with gaps` when unresolved coverage gaps remain, and approval is blocked while a matching extra fix is running.
- Replaced the binary Kanban `Errors Only` toggle with a tri-state Errors filter: `All states`, `Has errored before` (tickets with `hasPastErrors`, including currently blocked), and `Currently blocked` (only `BLOCKED_ERROR`). The legacy persisted `onlyErrors: true` value migrates to `Currently blocked` on load.
- Kanban triage presets live in `UIState.presetsByProject`, persisted through the same durable `looptroop-ui-state` record as filters and theme. The app no longer writes standalone `looptroop-presets-*` localStorage keys; any left by older builds are recovered once at startup so previously saved presets are not lost.

#### Fixed
- Fixed Kanban preset saving to gracefully handle `localStorage` security/quota exceptions by using an in-memory fallback.
- Fixed Kanban preset saving so the dropdown form uses controlled input state, reports inline save/failure feedback, and avoids exposing collapsed filter controls to hidden hit targets.
- Fixed a React console warning on pulsing ticket cards by avoiding mixed border shorthand and side-specific border styles.
- Fixed backend startup with `js-yaml` v5 by switching all default `js-yaml` imports to namespace imports that match the package's named ESM exports, preserving existing `load` and `dump` call sites.
- Fixed saved Kanban presets disappearing after a browser refresh. Presets are stored only in the durable `looptroop-ui-state` record, and the UI-state provider no longer writes state back to storage on its initial render — so a failed or empty rehydrate can no longer overwrite good data (the previous self-destruct on load). Committed React state is now the single source of truth, written before paint so changes survive an immediate refresh. The fragile dual-storage machinery this replaced — per-scope mirror keys, read-back-and-merge on every write, and migrate-on-every-read — was removed; legacy `looptroop-presets-*` keys are still recovered once at startup so nothing saved by older builds is lost. Trade-off: cross-tab preset merging is gone, so with two tabs open the last writer wins.

#### Removed
- Removed the "Run active / Run 19/19" progress/health badge from Kanban board ticket cards along with its unused helpers and imports.

#### Maintenance
- Removed the stale `@types/js-yaml` dev dependency because `js-yaml` v5 ships bundled TypeScript declarations.

#### Documentation
- Removed the old mixed `Storage config` roadmap entry, folded the global app-storage portion into `System Info + About`, and added a separate roadmap item for project-local `.looptroop` visibility so the roadmap matches the split UI.
- Documented the new Configuration `About` window and clarified that app-wide storage is shown there while project-local LoopTroop state remains discoverable in Project Details.
- Added `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, GitHub issue templates, and a pull request template with practical guidance adapted to LoopTroop's local AI orchestration workflow, safety expectations, docs maintenance, and validation commands.
- Wrapped the changelog `## Unreleased` section in a collapsed-by-default VitePress `::: details` block, preceded by a one-line note explaining that it previews changes merged but not yet shipped in a tagged release.
- Documented approval-screen coverage extra fixes across status details, API reference, PRD/beads docs, frontend artifact-report docs, prompt inventory, and context-engineering guide, and removed the completed roadmap item.
- Rewrote `docs/core-philosophy.md` so every core idea is explicitly present and accurate to the implementation: local/open-source (MIT, local backend + SQLite), the modern GUI (React Kanban with phase/artifact/log/diff/council/bead views), end-to-end ticket orchestration (the `ticketMachine` lifecycle), the project/ticket orchestration model, context engineering, LLM Council planning (the `server/council` draft → quorum → anonymized vote → refine → coverage pipeline), interview-before-spec, PRD as source of truth, beads as small implementation units, Ralph Loop recovery (context-wipe note, `beadStartCommit` reset, fresh session, bounded `maxIterations`), the OpenCode execution engine (`opencode serve` via SDK, separate `main_implementer` vs `council_members`, permissive execution policy, inherited skills/MCPs), Git worktree isolation, slow planning to avoid AI slop, and human-in-the-loop approval gates. Each section now leads with a one-paragraph summary followed by detail, and the existing comparison table and durable-state/optimization sections were retained and folded in.
- Reworded the first three of the Core Philosophy "Five Core Commitments" to lead with context engineering, thorough upfront planning, and keeping a human in the loop at irreversible boundaries.
- Moved the standalone "Durable State Beats Conversational Memory" section out of `docs/core-philosophy.md` and into System Architecture's Authoritative Data Ownership section (`docs/system-architecture.md` §3), where the full storage-layer map already lives.
- Moved the "What LoopTroop Optimizes For (And What It Is Not)" section out of `docs/core-philosophy.md` and into a new "Is LoopTroop Right For Your Task?" section at the end of `docs/getting-started.md`, adapted to a user-facing framing with links to the VM and free-model guidance on that page.
- Updated the Documentation Map hook in `docs/index.md` to drop the now-moved "durable state" mention from the Core Philosophy summary line.
- Replaced the "Persist important state outside the model" row in the Core Philosophy "Five Core Commitments" table with an LLM Council commitment (scoring anonymized drafts and refining the winner with the best ideas from the losing drafts to reduce single-model bias).
- Added a per-item "Read more" deep link at the end of each of the fourteen Core Philosophy ideas, pointing to the exact section of the relevant doc page (Getting Started, Frontend, Ticket Flow, System Architecture, Context Engineering, LLM Council, Interview, PRD, Beads & Execution, OpenCode Integration, Pre-/Post-Implementation). Removed the now-redundant standalone "Durable State" list (the full storage map already lives in System Architecture §3) and collapsed it to a short pointer.

---

## 0.3.1 (2026-06-22)

### Summary
- Changed the documentation "Last updated" date format to a clear, non-ambiguous DD/MMM/YYYY, HH:MM UTC format (e.g., 02/Jun/2026, 14:15 UTC) and linked it directly to the specific file diff in the corresponding git commit.
- Corrected documentation drift across the API, workflow, architecture, frontend, and operations docs to match the current code (SSE event payloads, pre-flight attribution, council module paths, prompt-template subsystem, YAML approval editor, and dev-script caveats).
- Updated the README with a new walkthrough animation GIF and renamed the video demo section.
- Fixed the dark/light mode toggle on the marketing landing page by configuring Tailwind CSS v4 class-based dark mode.
- Hardened structured-output recovery so common glued prose and escaped-quote coverage references no longer cause avoidable parser failures.
- Added a compact contact section at the bottom of the marketing landing page.
- Fixed the flash/split-second visibility of the floating "Back to top" button on landing page load by initializing it with hidden styles.
- Added a "Show details" section to the full-app crash screen so the underlying error message, stack trace, and component stack are visible (and copyable) without opening the console.
- Fixed `npm run dev` failing on native Windows with an `EINVAL` spawn error from the dev preflight when dependencies were already installed.

### Detailed Changes

#### Added
- Added a contact section at the bottom of the landing page, offering direct contact options via email (`contact@looptroop.ovh`) and Twitter (`@liviusa`) alongside a text reference pointing to the official LoopTroop socials.
- Added an expandable "Show details" panel to the top-level `App crashed` screen (`src/components/shared/AppCrashScreen.tsx`). The `ErrorBoundary` now forwards the caught `error` and `componentStack` to a render-prop fallback, surfacing the error name, message, full stack trace, and React component stack on screen with a copy-to-clipboard action and an explicit Refresh button.

#### Changed
- Modified the VitePress "Last updated" footer display format from the default localized style (e.g., 6/4/26, 6:26 PM) to a non-ambiguous "DD/MMM/YYYY, HH:MM UTC" format (24-hour UTC clock) linked directly to the specific file diff inside the corresponding git commit, implemented by overriding the default layout footer using custom layout slots.
- Updated `README.md` to display a 26-second animated walkthrough GIF showing LoopTroop's automated ticket lifecycle execution, and renamed the video demo section to highlight the 16-minute deep dive presentation and ticket demo.

#### Documentation
- Corrected the API Reference SSE event table and examples to match the broadcaster: removed the never-emitted `progress` and `app_error` events (noted as reserved type slots), fixed the `bead_complete` payload (`beadId`, `title`, `completed`, `total`), documented `log` as a flat `LogEvent` with no `logEntry` wrapper, and described the source-dependent `needs_input` shapes.
- Fixed Ticket Flow pre-flight attribution: pre-flight runs in `handlePreFlight` (`server/workflow/phases/verificationPhase.ts`, backed by `server/phases/preflight/doctor.ts`), while `executionSetupPlanPhase.ts` only handles setup-plan approval and draft regeneration.
- Fixed the LLM Council refinement module paths from the non-existent `server/workflow/council/*` to the real `server/council/*`.
- Updated System Architecture: removed the stale `server/phases/verification/*` reference (the directory holds only tests) and added the `server/prompts/*` prompt-template layer to the module map.
- Documented the shared `YamlEditor` and `CascadeWarning` approval surfaces in the Frontend docs.
- Documented the `diagnose:stall --help` flag, the `dev:app` preflight-bypass caveat, and synced `.env.example` with `LOOPTROOP_DEV_HOST`, `LOOPTROOP_OPENCODE_LOGS`, and `LOOPTROOP_OPENCODE_PERMISSION_MODE`.

#### Fixed
- Fixed the marketing landing page (`web.html`) theme toggle by adding the custom variant `dark` selector configuration to `src/web.css` so Tailwind CSS v4 compiles class-based dark mode styles rather than media-query-only styles.
- Fixed an issue where the floating "Back to top" button briefly flashed on page load by explicitly applying `opacity-0` and `pointer-events-none` classes to the element in `web.html`, preventing transition-on-load issues before its scroll position is verified.
- Recovered structured artifacts when short commentary is glued directly before a known root key such as `questions:`, `draft_scores:`, `status:`, or `beads:`, while preserving schema validation for the recovered content.
- Canonicalized harmless escaped-quote differences in PRD and beads coverage gap references so coverage revision metadata can match the originally provided gap text without inventing content.
- Fixed `npm run dev` aborting on native Windows with `spawnSync ... EINVAL` from the startup preflight. The preflight and dev-maintenance scripts now launch Windows `.cmd` shims (`npm.cmd`, `tsx.cmd`, `opencode.cmd`) through the shell, working around Node's BatBadBut hardening (18.20.2/20.12.2/21+) that refuses to spawn `.cmd`/`.bat` files directly. Arguments are quoted to stay safe under shell re-parsing, and the missing-`opencode` detection that previously relied on `ENOENT` now also recognizes cmd.exe's "not recognized" exit. WSL/Linux/macOS behavior is unchanged.

#### Maintenance
- Updated `hono` to 4.12.25 and `typescript-eslint` to 8.61.0.
- Stabilized the council pipeline hard-deadline unit test so full-suite timing variance no longer causes false failures while preserving the partial-result assertion.
- Refreshed the generated marketing CSS asset from the 0.3.1 site build so tracked deploy assets match the current source and package version.
- Ignored the generated `site/` deployment output in ESLint so `npm run lint` remains valid after running `npm run site:build`.

---

## 0.3.0 (2026-06-15)

### Summary
- Added dashboard ticket search for finding tickets by ID, title, or project, with mobile and keyboard support.
- Refined the dashboard ticket search into a smaller, subtler pill control with the search/clear icon on the right.
- Fixed dashboard startup for browsers with older saved UI filter state.
- Fixed project execution locks so display-only mock/demo tickets no longer block real tickets.
- Restored the Cancel action for non-terminal display-only mock/demo tickets while keeping runnable workflow actions blocked.
- Updated OpenCode SDK and React Query dependencies.
- Marked display-only mock/demo tickets with a superscript `(M)` beside their ticket ID in the board and dashboard.
- Fixed narrow To Do and Done kanban columns so ticket details wrap inside the existing column widths instead of clipping.
- Kept display-only mock tickets visible on the board while preventing them from hydrating or running workflow actions.
- Refined the Runtime Diagnostics docs to separate stall reports from ticket-side diagnostics, align blocked-error field docs with the current code, and document structured retry diagnostics.
- Refined the Operations Guide to match the implemented startup artifacts, OpenCode log handling, API auth and health surfaces, maintenance scripts, and current audit leftovers.
- Improved ticket descriptions with Raw/Markdown editing previews and Markdown-only details viewing.
- Refined the API Reference docs to better match the implemented route constraints, response payloads, archived-attempt behavior, and middleware guard rails.
- Refined the Prompt Inventory docs to better explain code-enforced context assembly, runtime retry overlays, and conservative prompt-driven fallback paths.
- Refined the Configuration docs to match the implemented ticket-lock boundaries, project-override behavior, model-picker UX, and ambiguous interview-question guidance.
- Refined the Database Schema docs to match the implemented app/project storage boundaries, public-vs-local IDs, filesystem ownership, and runtime schema bootstrap workflow.
- Refined the Frontend docs to match the current React shell, ticket dashboard orchestration, project-management modals, live-update recovery, and actual shortcut behavior.
- Refined the OpenCode Integration docs to match the current adapter stack, tool-policy layer, question APIs, and model-discovery behavior.
- Refined the System Architecture docs so they now match the implemented startup bootstrap, ticket-state persistence, request guard rails, structured-output pipeline, and browser recovery model.
- Reworked the Beads & Execution and Pre-Implementation docs to match the implemented setup approval, runtime rewind, retry/recovery, and reusable artifact model.
- Expanded the PRD docs to match the implemented Full Answers pipeline, versioned coverage loop, approval UI, and post-approval edit/restart behavior.
- Refined the Interview docs so they now match the implemented lifecycle more closely, including live session behavior, follow-up source types, approval/edit semantics, and the exact interview artifact structure.
- Refined the Output Normalization docs to cover the missing vote, relevant-files, final-test, execution-setup, and expanded-bead normalizers while tightening interview and diagnostics wording.
- Refined the Ticket Flow docs to match the implemented lifecycle more closely, including workflow-wide cancellation, setup-plan rewinds, versioned retries/history, OpenCode runtime questions, and final-test recovery decisions.
- Tightened docs-to-code coverage by correcting stale frontend behavior notes and documenting project-level configuration overrides plus startup shell surfaces.
- Added documentation for the worktree changes classification system, coverage control loop, execution band concurrency lock, IO utilities (atomic write/append/JSONL/recovery), startup state system, and session continuation eligibility logic across the architecture docs.
- Updated the system architecture, API reference, output normalization, ticket flow, opencode integration, frontend, and LLM council documentation to cover missing core modules and architectural components.
- Documented the Structured Interventions subsystem and added a performance warning for Windows-mounted drives inside WSL.
- Documented the Question Log Fingerprinting system, Error Diagnostics Normalization, Refinement Change Tracking, and UI Artifact Companions across the OpenCode integration, diagnostics, LLM council, and output normalization documentation.
- Enhanced SSE event type documentation with full payload examples for every event type.
- Added explicit code module references for shared utilities (WSL performance, error diagnostics, artifact companions) across operations and architecture docs.
- Added two new documentation pages for Pre-Implementation and Post-Implementation workflow phases, and updated the VitePress configuration and index doc map.
- Clarified the Prompt Inventory wording and expanded the phase map so each workflow area lists its exact built-in prompt IDs.
- Improved the Prompt Inventory documentation with workflow-grouped prompt tables, styled collapsed prompt content, and a persistent right-sidebar outline collapse control.
- Added a Prompt Inventory reference page that documents built-in prompts, collapsed full prompt content, runtime prompt builders, workflow usage, tool policies, and context inputs.
- Optimized the landing page (`web.html`) and modernized the build pipeline: compiled Tailwind CSS v4 statically (moving all custom classes, keyframes, scrollbars, and preloaded `@font-face` definitions to `src/web.css` and building to `public/web.css`), converted all screenshot images from PNG to WebP to reduce asset payload size by ~85%, updated references in `web.html`, `README.md`, and `docs/index.md` to use `/media/*.webp`, fixed an HTML nesting bug that broke the Alternate Bead Error tab, implemented Scroll-Spy navigation for header nav links, added a secure-context copy command fallback, and automated the `package.json` version tag injection during builds.
- Streamlined documentation and README: focused the README documentation table to essential first-time user pages (including LLM Council and Context Engineering), added missing error screenshots, integrated a high-level VM warning and a quoted Mermaid flowchart into the docs landing page to resolve parse errors, added Configuration and Changelog links to the doc map, linked terminology notes internally, and synced the core-philosophy challenges comparison table and optimizations list.
- Renamed the sidebar item to 'Ticket Flow' and added structured sequential prefix numbering to logical conceptual sections across 12 documentation pages.
- Split the large state machine transition diagram in ticket-flow.md into 6 focused phase-specific diagrams for improved readability.
- Make the Ticket Flow diagrams render reliably in VS Code Markdown Preview by replacing the live Mermaid blocks with embedded SVG diagrams and keeping loopback details in nearby notes.
- Merged redundant documentation pages: state-machine.md into ticket-flow.md, and execution-loop.md into beads.md. Updated VitePress sidebar links accordingly.
- Synchronized the API reference and operations guide with the implemented Hono routes, composite ticket refs, ticket-size breakdown endpoint, and native file-reveal endpoint.
- Removed dead exports, standardized boolean naming, and extracted shared helpers/components to reduce duplication across log grouping and editor wiring.
- Restructured the README for clarity: consolidated repeated explanations, merged overlapping sections, and reorganized the reading flow.
- Aligned documentation pages with the restructured README: updated index.md positioning, enriched FAQ comparison table, strengthened core-philosophy context framing and cost caveats, expanded the README doc table, and synchronized screenshot captions.
- Improved the Getting Started guide: reordered sections, added VM safety warning, added implementer model guidance, simplified startup details, and added a post-ticket pipeline overview.
- Added AI-assisted candidate-file auditing before PR creation so unrelated byproducts can be excluded with visible reasons.
- Added bead-level raw Input and Output inspection with per-iteration history.
- Cleaned up redundant coding workspace chrome around bead progress and logs.
- Hardened structured-output parsing for common YAML quote mistakes before implementation planning.
- Corrected four doc/code discrepancies: removed non-existent `server/github/*` module reference from the architecture guide; added `opencode_steps` to the database schema and API reference profile payload; added `LOOPTROOP_OPENCODE_PERMISSION_MODE` to the operations environment-variable table.
- Added a prominent TL;DR callout to the Context Engineering docs page summarizing the core design principle.
- Polished the marketing landing page (`web.html`) with SEO meta tags, a noscript fallback banner, and a pre-render theme script to eliminate dark-mode flash.
- Hardened the marketing landing page (`web.html`) for production: fixed broken header/mobile social links to use correct profile URLs; added Twitter Card meta tags, canonical URL, robots directive, og:site_name, and JSON-LD structured data; self-hosted Inter and JetBrains Mono fonts replacing the Google Fonts CDN; pinned CDN dependencies (Tailwind, Font Awesome) to specific versions with SRI integrity hashes; added `<main>` landmark for accessibility; disabled the non-functional video play button with a clear "coming soon" visual; removed the duplicate footer back-to-top button; and added version-sync comments at both version badges.
- Updated the Vercel deployment layout so the marketing page serves at `/` while documentation moves under `/docs/`.
- Updated repository and marketing-page links to point at the new `/docs/` documentation routes.
- Strengthened the marketing landing page (`web.html`) SEO, accessibility, and performance: added a dedicated 1280×640 OG image, Organization JSON-LD with social profiles, distinct SEO vs. social descriptions, a sitemap and robots.txt, font preloads, color-contrast fixes for low-emphasis text, and an 8th screenshot tab for an alternate bead error view.

### Detailed Changes

#### Added
- Added dashboard ticket search beside **New Ticket**, including persisted `filters.search` UI state, client-side kanban filtering by external ticket ID/title/project name/project shortname, compact ticket-ID matching such as `LOO15` to `LOO-15`, project-name prefix suggestions from all attached projects, mobile search popover behavior, `/` focus, `Escape`/clear recovery, and the empty search-results state.
- Added Raw/Markdown tabs for ticket descriptions while creating or editing draft tickets, plus Markdown-only rendering in Ticket Details, including safe rich previews for headings, lists, task lists, code blocks, links, blockquotes, and tables while keeping the stored/copied description text unchanged.
- Added worktree changes classification documentation (committable, looptroopExcluded, setupExcluded, generatedNoise) to the post-implementation file effects audit section.
- Added coverage control documentation (resolveCoverageRunState, resolveCoverageGapDisposition, termination conditions) to the ticket flow state machine section.
- Added execution band documentation (single-ticket-per-project lock, status membership validation) to the ticket flow state machine section.
- Added startup state system documentation (storage classification, restore flow, startup health endpoint) to the system architecture page.
- Added IO utilities documentation (atomicWrite, atomicAppend, JSONL, recovery) with durability guarantees to the system architecture page.
- Added session status logging documentation (buildSessionStatusLogEntries, entry structure) to the system architecture page.
- Added session continuation eligibility documentation (continuable vs non-continuable errors, Continue mechanics) to the opencode integration page.
- Added Question Log Fingerprinting documentation (`logIdentity.ts`) to the opencode integration page, covering SHA-256 fingerprinting for question lifecycle deduplication.
- Added Error Diagnostics Normalization documentation (`errorDiagnostics.ts`) to the diagnostics page, covering diagnostic classification, credential redaction, and field structure.
- Added Refinement Change Tracking documentation (`refinementChanges.ts`, `refinementDiffArtifacts.ts`) to the LLM council page, covering change types, attribution tracking, and UI diff artifacts.
- Added UI Artifact Companions documentation (`artifactCompanions.ts`) to the output normalization page, covering companion type convention, lifecycle, and UI rendering metadata.
- Expanded documentation across 7 core architecture guides to cover missing components: Data Access Layer, IO Utilities, Shared Layer, Modular Ticket Handlers, Structured Output Schemas, Advanced Workflow Mechanics, and Frontend coverage controls.
- Added documentation for the Structured Interventions diagnostic subsystem (categories, stages, and UI behavior) in [output-normalization.md](file:///wsl.localhost/Ubuntu/home/liviu/LoopTroop/docs/output-normalization.md).
- Added a performance warning cautioning WSL users against cloning repositories or running projects on Windows-mounted drives (like `/mnt/c/`) in [operations.md](file:///wsl.localhost/Ubuntu/home/liviu/LoopTroop/docs/operations.md).
- Added `docs/pre-implementation.md` documentation page detailing the pre-flight checks doctor, capability probe, setup plan, and tool-cache environment setup.
- Added `docs/post-implementation.md` documentation page detailing final testing, file-effects auditing, integration, pull request publishing, and environment cleanup.
- Added a persisted right-sidebar outline collapse toggle to the VitePress docs theme, mirroring the existing left sidebar collapse behavior for wide desktop docs pages.
- Added `docs/prompts.md` as a Prompt Inventory reference page covering built-in prompts, collapsed full prompt content, runtime prompt builders, workflow statuses, session types, tool policies, context inputs, and maintenance guidance.
- Added a high-level warning alerting users to run LoopTroop in a sandboxed environment/VM on the documentation landing page (`docs/index.md`).
- Added a simple workflow flowchart using Mermaid to the documentation landing page (`docs/index.md`).
- Added candidate-file auditing during pull request creation: final changed files are classified as include, exclude, or review before the branch is pushed; evidence-backed exclusions rewrite the local candidate and are recorded in a `candidate_file_audit` artifact.
- Added candidate net-diff capture for PR review so the review surface can distinguish the actual final PR diff from cumulative bead activity.
- Added bead-level `Input` and `Output` tabs in the Coding view, including raw prompt/output formatting, copy actions, line/character/token counts, tooltips, and a version selector for previous bead iterations.
- Preserved raw per-bead execution attempts in `bead_execution:<beadId>` artifacts, including initial prompts, final model responses or diagnostics, outcomes, model/session audit context, and bead-iteration log metadata for live inspection.

#### Changed
- Restored the dashboard Cancel button and cancel API path for non-terminal display-only mock/demo tickets; canceling these tickets now moves them directly to Canceled without hydrating workflow actors, while Start and other runnable workflow actions remain blocked.
- Updated `@opencode-ai/sdk` to `1.17.0` and `@tanstack/react-query` / `@tanstack/query-core` to `5.101.0`.
- Refined the dashboard ticket search styling to use a compact ~20-character desktop width, softer pill-shaped chrome, and right-aligned search/clear affordances while preserving the same filtering behavior.
- Marked display-only mock/demo tickets with a superscript `(M)` beside their external ID in kanban cards, the selected-ticket dashboard header/details, and terminal delete confirmation copy while keeping the raw `externalId` unchanged for routes, storage, file paths, and artifacts; ticket API payloads now expose `isDisplayOnlyMock` so the UI does not infer that state from reserved branch names.
- Reworked `docs/diagnostics.md` so it now distinguishes runtime stall reports from blocked-error and structured-retry diagnostics, documents the current persisted blocked-error fields and redaction behavior accurately, and makes the runtime report sections / flags easier to map back to the implemented script and UI surfaces.
- Reworked `docs/operations.md` so it now documents the repo-local startup artifact files, explicit-versus-fallback OpenCode startup rules, API token transport options, useful health endpoints, manual maintenance script behavior, mounted-drive warning surfaces, the default OpenCode log directory, and the current `drizzle-kit`/`vitepress`/`mermaid` audit leftovers more precisely.
- Reworked `docs/api-reference.md` so it now documents the current auth/rate-limit edge cases, singleton profile lifecycle, project-route mutability rules, ticket/UI-state validation limits, standard workflow action response shape, execution-setup regeneration behavior, artifact/history filters, and bead-route fallback responses more precisely.
- Tightened `docs/prompts.md` against the implemented prompt pipeline: clarified that collapsed prompt text shows the base template render, added code-backed notes for phase allowlists / context trim order / runtime overlays, documented the `PROM53` retry-note wrapper behavior, and called out the conservative candidate-file-audit fallback/report helpers that shape PR creation when classification is unavailable.
- Reworked `docs/configuration.md` so it now distinguishes ticket-start locks from live-read settings, documents the actual configuration-dialog model picker / variant behavior, clarifies project-override scope, and removes ambiguous guidance around `Max Interview Questions`; aligned the configuration UI hint and profile-route comment with that guidance.
- Reworked `docs/database-schema.md` so it now reflects the live storage model more accurately: clarified public project/ticket identifiers versus local DB row ids, documented the app/project database ownership boundary and the lack of cross-database foreign keys, added missing filesystem-backed state such as `ticket.meta.json`, marked `runtime/state.yaml` as a rebuildable projection, and documented that both app and project schema evolution are runtime-bootstrapped in `server/db/init.ts` and `server/db/project.ts`.
- Reworked `docs/frontend.md` so it now reflects the current UI more accurately: documented `AppShell`/`TicketDashboard` responsibilities, corrected the real SSE event names and recovery hooks, replaced stale interview-control references with the actual `InterviewQAView` structure, expanded the project-management modal coverage, and clarified that the shortcuts overlay currently advertises more keys than are actually bound.
- Reworked `docs/opencode-integration.md` to remove stale ambiguity and document the current OpenCode runtime more accurately: adapter/bootstrap selection, session-scoped permissions, per-prompt tool policies, aggregate question routes, health/model discovery flow, mock-mode behavior, and session reuse controls.
- Rewrote `docs/system-architecture.md` to make the runtime model easier to follow and closer to the code: clarified the browser/provider layer, documented the request guard-rail middleware, added missing ticket-machine, startup-bootstrap, council, and structured-output subsystems, expanded the storage ownership section to cover derived runtime projections and setup tool caches, refreshed the architecture diagrams, and replaced the densest recovery prose with clearer recovery rules.
- Rewrote `docs/beads.md` so it now matches the current runtime instead of the older execution-loop/setup description: clarified approval semantics and downstream invalidation, documented the actual execution-setup plan/profile contract, added missing session-preservation and restart-recovery behavior, expanded the artifact/API inventory, and tightened the scheduler/finalization explanations.
- Reworked `docs/pre-implementation.md` to match the implemented pre-flight, setup-plan approval, and runtime-setup flow: corrected the readiness checks, documented versioned setup-plan edits/regeneration and runtime rewinds, clarified setup validation/evidence rules, and added the real profile/report/runtime-artifact outputs consumed by coding and final testing.
- Rewrote `docs/prd.md` to align it with the implemented PRD lifecycle: clarified the two-part Full Answers -> PRD drafting flow, documented per-model Full Answers semantics and failure handling, expanded the canonical PRD schema and story verification shape, described versioned PRD coverage behavior and conservative change-metadata handling, and added the real approval/edit semantics around hash-guarded approval, draft re-saving, and downstream beads restart after post-approval edits.
- Rewrote `docs/interview.md` to align it with the implemented interview flow: clarified that the approved interview is the authoritative planning baseline rather than the only downstream input, documented the live session snapshot versus the final `interview.yaml` artifact, explained `compiled` vs prompt-follow-up vs coverage-follow-up vs final free-form question sources, added missing details about answer history/editing and skip-all behavior, and tightened the approval/edit-restart semantics around content-hash approval and post-approval planning invalidation.
- Reworked `docs/output-normalization.md` to match the implemented normalization pipeline more closely: documented vote scorecards, relevant-files payloads, final-test command plans, execution-setup artifacts, and expanded beads JSONL handling; clarified the split between question-list vs durable interview normalization; fixed stale wording around PRD status cleanup; and condensed the retry/Raw-attempt observability section into code-backed rules.
- Refined `docs/ticket-flow.md` so its high-level action/recovery guidance now matches the code: cancellation is documented as available from every non-terminal state, setup-plan edits/regenerations during runtime setup now explain the rewind-to-approval behavior, non-implementation retries/regenerations are described as archived phase-attempt history, execution-time OpenCode questions are called out explicitly, and the final-test file-effects decision path is documented in the status and recovery sections.
- Corrected stale frontend documentation to match the current implementation: removed the old Zustand claim, fixed the documented keyboard shortcuts, clarified that `AIQuestionProvider` handles OpenCode human-input requests rather than interview batches, and documented startup overlays plus project-level configuration overrides in the configuration and API guides.
- Enhanced SSE event type documentation in the API reference with a table covering all 7 event types, their trigger conditions, key payload fields, and payload examples for `progress`, `bead_complete`, `log`, `app_error`, and `needs_input`.
- Added explicit `shared/wslPerformance.ts` module reference to the WSL mounted-drive warning in the operations guide.
- Renumbered structured output schemas section from 6 to 7 after inserting the UI Artifact Companions section.
- Reworded `docs/prompts.md` to use plain built-in prompt terminology and expanded the phase map so it lists each exact prompt ID instead of ranges or wildcard groups.
- Reworked `docs/prompts.md` into a workflow-oriented reference with a phase map, grouped built-in prompt tables, wider prompt-page layout, and more readable collapsed prompt content styling.
- Streamlined `README.md` quick navigation start links to fit on a single line.
- Added missing `bead2.png` and `bead3.png` error view screenshots to the `README.md` gallery.
- Focused the documentation table in `README.md` to display only the essential five pages for new users.
- Added `Configuration` and `Changelog` references to `docs/index.md`'s Documentation Map.
- Updated Terminology Notes in `docs/index.md` to use internal cross-reference links.
- Synced and enriched the direct-agent challenges comparison table and optimized-for list in `docs/core-philosophy.md`.
- Improved `web.html` landing page SEO and UX: added favicon, Open Graph meta tags, and canonical URL; moved theme detection to an inline `<head>` script to eliminate dark-mode flash on load; added a `<noscript>` banner warning users that interactive features require JavaScript; added the missing `scrollbar-hide` CSS utility for the screenshot tab strip; simplified the footer theme-toggle script to only sync icons since the class is now set pre-render.
- Hardened `web.html` for production: fixed header and mobile-menu social links that pointed to bare platform domains instead of the LoopTroop profile pages; added Twitter Card meta tags, `<link rel="canonical">`, `<meta name="robots">`, `og:site_name`, and JSON-LD `SoftwareApplication` structured data; self-hosted Inter and JetBrains Mono woff2 font files in `/public/fonts/` replacing the Google Fonts CDN and `preconnect` hints; pinned Tailwind CDN to v3.4.17 and Font Awesome to v6.5.2 with SRI integrity hashes; wrapped main content in a `<main>` landmark; replaced the non-functional video play button with a visually disabled "coming soon" indicator; removed the duplicate footer "Back to top" button (floating FAB remains); and added `<!-- VERSION -->` comments at both v0.2.4 badges to ease future updates.
- Renamed the sidebar item to 'Ticket Flow' (instead of 'Ticket Flow & State Machine') in docs/.vitepress/config.ts and modified the main H1 header in docs/ticket-flow.md.
- Split the large state machine transition diagram in docs/ticket-flow.md into 6 smaller, focused diagrams organized by workflow phase: Entry & Discovery, Interview Loop, PRD Loop, Beads Loop, Execution & Delivery, and Error Recovery & Cancellation. Enhanced readability by reducing diagram complexity and added descriptive notes explaining retry/continue behavior.
- Added structured sequential prefix numbering to the main conceptual H2 sections across 12 documentation pages (Core Philosophy, Context Engineering, Interview, PRD, LLM Council, System Architecture, OpenCode Integration, Frontend, Database Schema, Output Normalization, Operations, and Diagnostics) to guide the reader clearly.
- Merged `docs/state-machine.md` (Workflow Groups, Board Locations, Phase Inventory, Phase Descriptions, Transition Model, Safe Resume, Retry Semantics, UI Consequences) into `docs/ticket-flow.md` to create a unified Ticket Flow & State Machine document.
- Merged `docs/execution-loop.md` (Execution Phases, Bead Execution Cycle, Structured Completion, Bounded Ralph-Style Retry, Context Wipe Notes, Session Strategy, OpenCode Retry Budget, Worktree Hygiene, Success/Failure Paths, Execution Configuration Controls) into `docs/beads.md` to create a unified Beads & Execution document.
- Updated `docs/.vitepress/config.ts` to reflect the merged documentation links in the sidebar.
- Added a TL;DR `[!IMPORTANT]` callout to `docs/context-engineering.md` highlighting the core principle: every phase, status, and retry uses only minimal context — never the full conversation history.
- Updated `docs/api-reference.md` to document composite ticket refs (`projectId:externalId`), `GET /api/tickets/:id/size`, the `/api/files/open-path` route, and the exact `GET/PUT /api/files/:ticketId/:file` behavior.
- Fixed `docs/operations.md` to describe `npm run dev:backend` as the Hono backend server rather than Express.
- Changed PR review diff handling to default to the final net diff while keeping bead-level and by-file activity available for audit.
- Removed the extra bead progress summary line below the coding progress bar, leaving the header progress count and bead grid as the single source of progress information.
- Removed the empty artifact spacer between live coding beads and the log viewer, leaving a single separator at that boundary.
- Restructured the README: broke the dense intro paragraph into short focused sentences; merged the Core Pipeline numbered list and Core Ideas subsections into a single enriched section; consolidated three separate context engineering explanations into one comprehensive subsection; removed repeated council draft/vote/refine descriptions from PRD and Beads sections; consolidated repeated "hours/overnight" mentions into a single statement in Execution; merged the standalone Safety section into What You Need with a "Why a VM?" subsection; moved Screenshots to a collapsed `<details>` element after the intro links; moved the comparison table below Quick Start; and merged the two "What LoopTroop is not" headings into one section.
- Aligned `docs/index.md` with the README: replaced the opening paragraph with the tagline, intro, and architecture table; rewrote "What LoopTroop Is" as prose paragraphs matching the README; enriched terminology notes with Bead and PRD definitions; removed the "Canonical Runtime Sources" section.
- Improved `docs/getting-started.md`: reordered council setup before project attach; added VM safety warning with `[!WARNING]` callout; added "Choosing Your Main Implementer" section with provider recommendations and benchmark links; added OpenCode link in prerequisites; simplified startup details collapsible; trimmed redundant VM bullet list; expanded "Attaching Your First Project" with post-submit context; added "What Happens After Your First Ticket?" pipeline overview; merged Operations into Next Steps; fixed typos and grammar.
- Enriched `docs/faq.md` "Why use LoopTroop" answer with a structured 7-row comparison table matching the README's core challenges, replacing the previous 5-point list.
- Strengthened `docs/core-philosophy.md` context degradation section with concrete 40% context window performance metric and "AI slop" framing from the README.
- Added multi-model council token cost caveat to `docs/core-philosophy.md` "not optimized for" section.
- Expanded the README documentation table from 9 to 14 pages, adding Configuration, State Machine, Frontend, Output Normalization, and Runtime Diagnostics.
- Synchronized the `docs/index.md` Projects screenshot caption with the README ("add" instead of "create").
- Updated the Vercel build to publish a combined static `site/` output, with `web.html` at the site root and the VitePress documentation nested under `/docs/`.
- Updated README and `web.html` links so public docs links use `/docs/`, old Execution Loop and State Machine links resolve to their merged pages, and marketing screenshots load from `/docs/assets/`.
- Replaced the previous `/trans-logo.png` references in `web.html`'s `og:image` and `twitter:image` meta tags with the new purpose-built `/og-image.png?v=20260429` for richer social link previews.
- Unified every URL, `canonical`, and JSON-LD reference in `web.html` to the canonical `https://www.looptroop.ovh/` marketing domain.
- Repointed all 7 screenshot image URLs in the Screenshots section of `web.html` from VitePress-hashed `/docs/assets/...` paths to stable `/docs/media/*.png` paths, so the marketing page no longer breaks when VitePress regenerates assets.
- Introduced two distinct descriptions in `web.html`: a search-engine-focused `<meta name="description">` (richer keywords and a positioning statement) and a punchier social-hook `<meta property="og:description">` / `<meta name="twitter:description">` (focused on a single benefit).

#### Removed
- Removed now-redundant documentation files `docs/state-machine.md` and `docs/execution-loop.md` whose content is now merged into `docs/ticket-flow.md` and `docs/beads.md` respectively.

#### Fixed
- Fixed project execution-band conflict detection so display-only mock/demo tickets in statuses such as `WAITING_PR_REVIEW` do not reserve execution capacity or block real tickets from entering pre-flight.
- Fixed a startup crash when an older persisted `looptroop-ui-state` filter object did not include the newer `filters.search` field, normalizing missing filter defaults before dashboard search renders.
- Fixed ticket card overflow in the narrower To Do and Done kanban columns by allowing grid columns, scroll-area content, and card metadata rows to shrink and wrap within the existing board layout, avoiding horizontal scrollbars or column width changes.
- Prevented display-only mock tickets from being restored as active workflow actors on startup and hid all workflow actions for those tickets.
- Replaced the live Mermaid diagrams in `docs/ticket-flow.md` with embedded SVG exports generated from the same flow definitions, so section 2 and all section 3 state diagrams render consistently in VS Code Markdown Preview while the omitted loopback semantics remain documented immediately below the affected charts.
- Repaired text-preserving YAML quote recovery for model outputs that include unescaped inner quotes in one-line scalars or omit the closing quote on a quoted list item before the next structured block, reducing avoidable Full Answers and PRD draft retries.
- Corrected `docs/system-architecture.md` to remove non-existent `server/github/*` module reference; all GitHub integration code lives in `server/git/github.ts`.
- Corrected all 8 screenshot image URLs in the Screenshots section of `web.html` (including the newly added Bead Error Alt tab) to use the canonical `https://raw.githubusercontent.com/looptroop-ai/LoopTroop/refs/heads/main/docs/media/*.png` paths. This was the intent of the original "use the raw versions" instruction in the marketing-page review; the previous commit had used site-local `/docs/media/*.png` paths which Vercel does not serve at that path.
- Expanded the Bead Error Alt panel copy to match the description-length and tone of the other six screenshot panels: a longer 65-word description that mirrors the polished, three-sentence cadence of the surrounding panels, and three 3–4-word feature bullets in the same style as `Bead Error & Recovery`.
- Improved color contrast for low-emphasis text throughout `web.html` (tab labels, mobile social icons, footer social icons, timeline badges, hero copy, footer version line) by replacing `text-zinc-500 dark:text-zinc-500` with `text-zinc-600 dark:text-zinc-400`, addressing WCAG contrast for small gray-on-white text. The terminal text on the in-page black background is intentionally left at `text-zinc-500` for visual hierarchy.
- Added missing `opencode_steps` column to the `profiles` table key columns list in `docs/database-schema.md`, with a corresponding note in the prose.
- Added missing `"opencodeSteps"` field to the profile update payload example in `docs/api-reference.md` with a description of its default and range.
- Added missing `LOOPTROOP_OPENCODE_PERMISSION_MODE` row to the Environment Variables table in `docs/operations.md`.
- Added an 8th "Bead Error Alt" screenshot tab to `web.html` using `docs/media/bead3.png`, giving visitors a second view of the Ralph Loop's failure-recovery flow across varied error shapes.
- Added a dedicated `public/og-image.png` (1280×640, copied from `.github/social-preview.png`) used for Open Graph and Twitter Card previews, with explicit `width`, `height`, and `alt` meta attributes for richer link unfurls.
- Added Organization JSON-LD structured data (`@type: Organization`) to `web.html` with the official LoopTroop logo URL and `sameAs` links to the GitHub organization, GitHub project, GitHub sponsors, X/Twitter, and Discord profiles.
- Added `public/robots.txt` allowing all crawlers and pointing at the sitemap.
- Added `public/sitemap.xml` listing the marketing root and all 19 documentation pages under `https://www.looptroop.ovh/docs/`.
- Added preloads for the self-hosted `inter-latin.woff2` and `jetbrains-mono-latin.woff2` font files in `web.html` to improve LCP and reduce render-blocking font loading.

#### Maintenance
- Removed dead exported functions and constants from `src/lib/beadsDocument.ts` and `server/lib/constants.ts` that were defined but never called.
- Extracted shared `LogCollapseToggle` component used identically in `PhaseLogPanel` and `FullLogView`, eliminating duplicate JSX blocks.
- Extracted `useApprovalPaneState` hook shared across all three approval panes (`InterviewApprovalPane`, `PrdApprovalPane`, `ExecutionSetupPlanApprovalPane`), removing duplicate state and type definitions.
- Standardized boolean variable naming to use `is/has/should` prefixes throughout the codebase.
- Added `EXECUTION_SETUP_EDIT_GRACE_MS` named constant to replace inline magic number in approval pane timing logic.
- Added `varsIgnorePattern: '^_'` to ESLint config for cleaner destructuring patterns without disable comments.
- Split bead log grouping helpers out of the `BeadDelimiter` component module, removing refresh suppressions and keeping bead section parsing reusable without JSX exports.
- Reworked `YamlEditor` read-only reconfiguration to use a CodeMirror compartment so the editor no longer depends on a hook-dependency suppression.
- Removed dead internal exports from dev scripts and backend runtime/storage/git helpers that were no longer referenced anywhere in the app or test suite.

---

## 0.2.4 (2026-05-28)

### Summary
- Added live-only workspace status progress labels for coding, coverage checks, and retried phases.
- Made merged PR completion independent of the user's local checkout cleanliness.
- Fixed long ticket descriptions being unscrollable in backlog and detail views.
- Enabled setup-scoped online artifact lookup for missing launcher provisioning while keeping real provisioning evidence stricter.
- Fixed realtime logs for active multi-attempt phases while keeping archived phase versions static and attempt-scoped.
- Hardened execution setup so missing launcher failures must show persistent provisioning attempts before blocking.
- Hardened setup reuse so final testing automatically runs through validated prepared environments.
- Improved workspace setup approval logs so generation starts visibly expanded and collapses once the setup plan is ready.
- Added a one-step rewind from Preparing Workspace Runtime back to setup-plan approval for safe edits and regeneration.
- Fixed runtime setup rewinds so regeneration starts only the requested setup-plan session instead of racing an automatic draft.
- Made future bead commits language-agnostic while blocking setup-created project dirt before coding starts.
- Consolidated concurrent AI status messages and warnings into a premium collapsible activity strip below workspace logs with persistence.
- Fixed stale Current Activity timeout warnings when reviewing phases that already passed.
- Made PRD coverage revisions tolerate safe change-metadata aliases while preserving validated structural review diffs.
- Added tooltip to the CMD log tab in phase and full log views, consistent with all other log tabs.
- Raw tab in artifact views now defaults to the validated variant (or first accepted attempt) instead of the first non-disabled variant. When multiple model sources exist, the first validated model is auto-selected.
- Added dynamically calculated bead implementation time below Completed At in CodingView's bead details panel.
- Improved stall diagnostics with trend-wide process attribution and focused ticket runtime artifact sizing.
- Fixed completed ticket navigation so the historical Implementing row shows the final bead count.

### Detailed Changes

#### Added
- Added trend-wide top system CPU/RSS/read/write attribution and a `--ticket-path` option to `npm run diagnose:stall`, so reports can identify memory/I/O spike owners and inspect a specific ticket runtime's logs, largest directories, and large build artifacts.
- Added dynamically calculated bead implementation time (Completed At minus Started At) under the Timeline section in the CodingView's bead details panel, rendered on the fly when both timestamps are available and represent a valid positive duration.
- Added live-only progress wording to the workspace status title: CODING now names the active bead and iteration, coverage phases show pass/version progress when known, and manually retried non-implementation phases show the active retry attempt while the status is live.
- Raw artifact tab now defaults to the validated variant when available. When multiple model sources exist (e.g. council drafts, votes), the first source with a validated variant is auto-selected. Falls back to the first non-disabled variant when no validated variant exists.
- Added an `Initial Prompt` selector to future model-produced Raw attempt views when the first prompt is persisted, making the model input inspectable beside accepted and rejected attempt outputs without inferring legacy prompts from logs.
- Added a guarded setup-plan rewind while `PREPARING_EXECUTION_ENV` is active, letting users edit or regenerate the approved setup plan after runtime setup starts while preserving archived runtime evidence.
- Added setup-scoped OpenCode `websearch`/`webfetch` access during `PREPARING_EXECUTION_ENV`, with managed dev OpenCode servers started using `OPENCODE_ENABLE_EXA=1`, so agents can resolve official launcher artifact metadata when local repository evidence is insufficient.
- Added `tool_requirements.provisioning_attempts` evidence to execution setup profiles so failed required-launcher setup records distinct temp-root provisioning strategies and commands, or why no safe provisioning path exists.
- Added `tooling_probe_commands` to execution setup profiles so prepared language/toolchain environments can be verified by model-selected, non-mutating probes before coding starts.
- Added pre-flight and execution-setup worktree cleanliness checks: pre-existing committable project changes now block before setup, ready setup attempts fail if they leave committable project changes, and untracked generated/local noise is reported with `.gitignore` suggestions.
- Added support for tracking multiple parallel AI model activities and diagnostics concurrently.
- Added state persistence to localStorage for the collapsible activity strip, saving user preferences across reloads.
- Added a **"Create and Start"** button to the New Ticket modal, letting users create a ticket and immediately trigger the workflow from a single action.

#### Fixed
- Completed and later-phase tickets now keep the last known bead progress on the left-panel Implementing timeline row, showing labels such as `Implementing (Bead 8/8)` instead of the generic `Bead ?/?` fallback.
- Runtime setup rewinds now suppress the restored approval actor's immediate auto-draft when the route is about to save an edited plan or start a commented regeneration, preventing duplicate setup-plan sessions and last-writer-wins overwrites.
- The CMD log tab now shows a descriptive tooltip on hover, matching the tooltip behavior of all other log tabs (ALL, SYS, AI, ERROR, DEBUG).
- Long ticket descriptions are now independently scrollable (300px max-height with overflow) in the Ticket Details modal, DraftView, and PhaseReviewView. Previously, long descriptions expanded indefinitely and pushed other content off-screen.
- Viewing the active (latest) version in multi-attempt phases now keeps using realtime SSE logs while filtering to that active `phaseAttempt`. Archived phase versions remain static/read-only and load their durable attempt-scoped log snapshot, preventing both missed live runtime setup logs and cross-attempt log mixing.
- Current Activity timeout warnings now render only for the ticket's live status, so revisiting an older phase cannot show an obsolete `Approaching timeout` banner until refresh.

#### Changed
- PR merge completion now verifies that `origin/<baseBranch>` contains the candidate commit and proceeds to cleanup without checking out, fast-forwarding, or requiring cleanliness in the user's main project folder.
- Renamed Raw retry attempt selectors to the clearer `Attempt N Output - Accepted/Rejected` format.
- Setup-plan edits and regenerations from active runtime setup now stop the runtime session, archive the approved setup contract and runtime attempt, clear stale runtime profile outputs while preserving the tool cache, and require approval again before setup reruns.
- Execution setup prompts now state that wrapper creation, cache inspection, PATH edits, and version probes are discovery/scaffolding only, and do not count as provisioning strategies unless the attempt actually obtains, installs, or activates the missing launcher under approved temp roots.
- Execution setup prompts now treat failed launcher version/info probes as discovery only, replacing single-ecosystem provisioning guidance with non-exhaustive Node, Python, and JavaScript-runtime examples plus permission to use any safe repository-appropriate temp-root provisioning approach.
- Execution setup now requires at least two distinct failed provisioning strategies before accepting terminal failed-tooling evidence, and grants a small bounded persistence retry extension when the base setup budget is exhausted after only one real strategy.
- Final-test command execution now reuses a validated execution-setup wrapper automatically when one is declared, recording both the original command and the effective wrapped command in the report.
- Workspace setup approval now keeps the live log drawer expanded while LoopTroop is generating the setup plan, then automatically collapses it when the plan artifact becomes visible for review.
- Execution setup now fails early when declared wrappers are missing or unusable, probes fail, or wrapper/project command families are declared without probes.
- Changed bead commit capture to be language-agnostic. LoopTroop now commits Git-visible project changes regardless of extension, while still excluding `.ticket/**`, `.looptroop/**`, execution-setup roots, and untracked generated/local outputs.
- Execution setup prompts now ask agents to record suggested `.gitignore` entries in profile cautions instead of editing `.gitignore` during setup.
- Re-engineered the Current Activity strip below the log tabs to be fully collapsible and display a list of all active model sessions, beads, and warnings.
- Redesigned the strip UI with premium unified severity styling (Error > Warning > Info) and smooth chevron transitions on toggle.

---

## 0.2.3 (2026-05-26)

### Summary
- Added future-ticket safety around PR merge completion and final-test file effects so merged PRs and test-produced files are handled audibly and recoverably.
- Format commands in system logs to match tool calls exactly, using identical colors (`text-cyan-500`) and rendering output/error blocks in standard structured sections (squares/boxes) regardless of length.
- Render bead separators in the per-phase normal log view for CODING phase, matching the existing Full Log bead grouping behavior.
- Resume execution-setup and final-test attempt counters correctly after an app restart, so logs show the true attempt number and the maxIterations guard is respected across restarts.
- Fixed bead iteration countdown timer showing 00:00 on iteration 2+ by anchoring to the current iteration's start time (`updatedAt`) instead of the first iteration's start time (`startedAt`).
- Pause the CODING bead countdown while a ticket is blocked by a continuable provider interruption, and show a paused-session cue instead.
- Repair bare structured YAML list item keys before parsing so compatible model outputs no longer retry when they emitted an existing id/path as a scalar.
- Show a live Current Activity strip above log views so model stalls, empty outputs, trusted timeout causes, and near-deadline warnings are visible while waiting.
- Apply AI Response Timeout consistently to model-output waits across scan, planning, final-test generation, and PR drafting phases while keeping CODING on its bead iteration timeout.
- Separate CODING iteration timeouts from OpenCode/provider interruptions so owned bead deadlines reset and retry while resumable provider stalls can still Continue.
- Make the ticket location copy path button permanently visible in the ticket details view, and add an OS-agnostic 'Reveal in File Explorer' button next to it.
- Show line count, interactive color legend, and copy button in the per-bead model log view.
- Show index-based bead numbers next to bead titles and IDs in the beads details view (blocked by, blocks, and label matching lists) and draft views.
- Fixed bead `startedAt` to preserve the first iteration's start time across retries instead of overwriting it on each attempt; changed bead `createdAt` to be set at approval time (when user clicks Approve) instead of on save or expansion.
- Added and hardened `npm run dev --lan` for trusted local-network dashboard sharing with LAN URLs, a mobile QR code, and WSL-aware Windows portproxy diagnostics.
- Let users collapse the left-panel Errors section even when a blocked ticket auto-opens it.
- Reload only after sustained dashboard reconnect/loading recovery so transient warning flickers do not refresh the page.
- Show exact sanitized OpenCode provider causes when generic provider errors can be matched to local OpenCode logs.
- Make Continue recovery use exact OpenCode session lookup and show failed action reasons inline.
- Allow Continue for blocked `HTTP 402 Payment Required` OpenCode provider errors when the original session is still active.
- Show live `npm run dev` preflight progress so slow startup checks no longer look stalled.
- Added a manual reload button next to "AI Models" in Configuration to force-refresh available OpenCode providers and models on demand.
- Keep future `.ticket/**` metadata local to LoopTroop so ticket artifacts no longer get committed or pushed to target repository branches.
- The DEBUG tab now shows every single log line from LoopTroop (all three channels) and OpenCode (all SDK stream events plus native server logs); OpenCode native logs are always written at DEBUG level to the log directory. Use `npm run dev --opencode-logs=all` to additionally print them to the console.
- Added a high-priority roadmap item for an AI Gap-Fix Button on coverage warnings during approval statuses, letting the main AI implementer resolve unresolved coverage gaps in-place.
- Successful `git push` commands now show a compact `→ push completed` log entry instead of the verbose multi-line `STDERR:` remote messages block.
- Show a visible notification in the ALL tab whenever an OpenCode session is restarted due to no response text being produced, making silent session resets visible across all workflow phases.
- Added **OpenCode Max Steps** profile setting to cap the number of steps per OpenCode session; when set, LoopTroop writes a per-worktree `opencode.json` (git-excluded) before coding and removes it after; 0 means no limit (OpenCode default).
- Fixed release validation coverage for the OpenCode Max Steps documentation link and normalized roadmap line endings.

### Detailed Changes

#### Added
- Added language-agnostic final-test file-effects auditing. Final-test structured output now accepts `file_effects` entries (`candidate`, `temporary`, or `unexpected`), records baseline/post-test dirty files in a `final_test_file_effects_audit` artifact, and blocks integration with `FINAL_TEST_FILE_EFFECTS_UNCLASSIFIED` when final testing leaves undeclared dirty files.
- Added blocked-error recovery actions for unresolved final-test file effects: **Include in PR** writes a `final_test_file_effects_override` that treats unclassified final-test-produced files as candidate changes, while **Discard and Continue** removes/reverts only files proven by the audit to have been produced or changed during final testing.
- `emitOpenCodeSessionLogs` now emits an `audience: 'all'` milestone notification when `responseChars=0`, making silent OpenCode session restarts visible in the ALL tab across all workflow phases (coding, PRD, interview, verification, PR drafting, etc.).
- New **OpenCode Max Steps** profile setting (`opencodeSteps`, default `0`): caps the number of steps per OpenCode session. When set to a non-zero value, LoopTroop writes `opencode.json` at the worktree root before coding starts (git-excluded via per-worktree local exclude) and removes it in a `finally` block after coding completes. `0` means no limit — matching OpenCode's default behavior.
- Added `opencodeSteps` to DB schema (`opencode_steps INTEGER DEFAULT 0`), Drizzle ORM profile schema, Zod profile route schema, frontend `Profile` interface, `numericFields` config, `buildInitialRawNumeric`, and `ProfileSetup.tsx` with a `NumericField` control and inline hint.
- Added **OpenCode Max Steps** section to `docs/configuration.md` covering steps-vs-messages semantics, trade-offs, and git-exclusion implementation detail.

#### Changed
- PR merge completion now treats the GitHub merge as complete once GitHub reports the PR merged. Local base-branch sync runs afterward as a recoverable follow-up, and retries for already-merged PRs skip the remote merge call and resume local sync/cleanup.
- New ticket worktrees now fetch `origin` before resolving their base and prefer `origin/<baseBranch>` when that remote ref is available.
- Successful `git push` with informational remote STDERR is now rendered as a compact `→ push completed` log entry in `commandLogger`, suppressing the verbose multi-line `STDERR:` block.
- Changed command tag `[CMD]` and text colors to match tool logs (`text-cyan-500`) instead of `text-zinc-500`.
- Bypassed the length/complexity filter (`shouldRenderImplicitStdoutSection`) in `splitLegacyCommandBody` to ensure compact command outputs are always rendered as structured `STDOUT` or `ERROR` boxes.
- Updated `PhaseLogPanel` tests to align with the standard structured formatting of all command outputs.
- Broadened the existing `councilResponseTimeout` setting into the user-facing AI Response Timeout, covering non-coding model-output prompts including relevant-files scanning, setup-plan drafting, final-test generation, and PR drafting; CODING and execution setup keep their dedicated timeout behavior.
- Removed the hover-only opacity constraint from the copy path button in the ticket details view, making it permanently visible.
- Show the 1-based index (bead number) next to dependency references (Blocked By, Blocks) and label matching lists in the bead details view trigger and hover cards to easily locate them in the main bead list.
- Display index-based bead numbers next to dependencies (Blocked By, Blocks) in the collapsible Beads draft artifact details view.
- Bead `startedAt` now preserves the first iteration's start timestamp across retries instead of being overwritten on each attempt. Only `updatedAt` reflects the latest attempt start time.
- Bead `createdAt` is now stamped at approval time (when the user clicks Approve) instead of at save or expansion time. Beads start with `createdAt: ''` and receive their timestamp only when approved.
- Ticket worktree artifacts under `.ticket/**` now stay local: project attach installs `/.ticket/` in `.git/info/exclude`, and bead finalization excludes those files from commit capture while still preserving them across execution resets.

#### Added
- Added bead delimiter separators to the per-phase normal log view for the CODING phase. Log entries are grouped by detected bead boundaries (from `[SYS] Executing bead ...` system lines) and each bead section is preceded by a `Bead X/Y` delimiter showing the bead title, matching the existing Full Log behavior. Incomplete future beads are hidden when runtime data is available, and the grouping respects the current tab filter so empty bead sections are omitted.
- Added a compact Current Activity strip to phase and full log views, deriving waiting-for-first-model, provider retry timeout, provider-timeout-preserved, iteration-timeout, empty-output, workflow timeout, and near-timeout states from structured log events.
- Added a 'Reveal in File Explorer' button next to the copy path button in the ticket details view.
- Added a POST `/api/files/open-path` API endpoint that safely reveals files/folders in the user's native file explorer, supporting Windows, macOS, Linux, and WSL (including WSL path to Windows host conversion).
- Added entry count, interactive color legend tooltip, and copy-to-clipboard button to the per-bead Log view (in the bead details pane) matching the standard dashboard phase/full log view headers.
- Added a LAN sharing mode for `npm run dev --lan`, binding the frontend/docs dev servers to the local network, advertising reachable LAN URLs with a QR code, and keeping backend/OpenCode control-plane ports loopback-only behind the Vite proxy.
- Replaced automatic WSL relay startup with a safe Windows portproxy one-liner for `npm run dev --lan`, avoiding suspicious PowerShell listener processes while explaining why WSL `172.x` addresses are not directly reachable from other LAN devices and keeping the mobile QR code for the after-setup URL.
- Added WSL LAN setup diagnostics that check whether the matching Windows network profile is Private, print the exact `Set-NetConnectionProfile` command when the profile is Public, run a Windows-side reachability self-test for the forwarded frontend/docs URLs, and explain that router/AP client isolation cannot be reliably detected from the dev machine.
- Added a reload button with tooltip next to the "AI Models" heading in the Configuration panel. Clicking it clears the React Query cache and re-fetches the full model catalog from the OpenCode server, bypassing the 5-minute stale-time window.
- The DEBUG tab now loads `channel=all`, which merges all three LoopTroop log files (`execution-log.jsonl`, `execution-log.debug.jsonl`, `execution-log.ai.jsonl`) plus OpenCode native server log lines filtered by the ticket's session IDs. Every LoopTroop log entry and every OpenCode SDK stream event is visible in a single chronological view. All content is loaded lazily on tab open; no other tabs are affected.
- Added `channel=all` to the log API (`GET /api/files/:ticketId/logs?channel=all`). The server merges and deduplicates entries from all three LoopTroop log channels server-side, appends OpenCode native log entries (parsed from logfmt and tagged `source: 'debug'`), sorts by timestamp, and returns a single list. Phase/status filters still apply to LoopTroop entries but OpenCode native entries are always included.
- Logged the previously-silent `part_removed` OpenCode SDK stream event to the debug channel, completing 100% SDK stream event coverage in logs.
- OpenCode managed server is now always started with `--log-level DEBUG`, writing native logs at full verbosity to the OpenCode log directory so they are always available in the DEBUG tab. Use `npm run dev --opencode-logs=all` to additionally print them to the terminal. The `--opencode-logs=all` flag adds `--print-logs` to the OpenCode serve args.

#### Fixed
- Fixed PRD coverage revision parsing so `change_type` aliases are recognized and path/summary-only change notes are dropped as diagnostics while the validated PRD diff remains reviewable.
- Fixed execution-setup and final-test attempt counters resetting to 1 after an app restart; both phases now resume from the correct attempt number derived from persisted retry notes, so the `maxIterations` guard is honoured across restarts.
- Fixed bead iteration countdown timer showing 00:00 on iteration 2+ beads; the timer now anchors to `updatedAt` (updated at the start of each iteration session) instead of `startedAt` (frozen at the first iteration), so the remaining time is accurate across all iterations.
- Fixed blocked CODING provider interruptions showing a live bead countdown while the ticket was paused; the header now hides the timer outside live CODING, and the error panel shows that the preserved session will resume with a fresh bead timer when Continue is available.
- Repaired opt-in structured YAML lists when a model emits an existing bead/PRD id or relevant-file path as a bare sequence item followed by object fields, with dynamic parser warnings that name the affected parent list, line, scalar value, and primary key.
- Hardened the WSL LAN sharing one-liner so it listens on detected Windows LAN addresses, clears stale wildcard `0.0.0.0` portproxy entries, starts the Windows IP Helper service, and forwards through Windows localhost into WSL instead of depending on a fragile current WSL NAT address.
- Let the ticket navigator's auto-expanded Errors section be collapsed and reopened by the user while preserving auto-open behavior for newly active or selected errors.
- Added guarded full-page recovery reloads after sustained backend reconnecting, live-update reconnecting, or post-initial ticket loading banners clear, with a 10-second session cooldown, a five-second minimum visible warning duration, and two 1.5-second backend health confirmation probes to avoid reload loops and transient false reconnect banners.
- Enriched generic `Provider returned error` OpenCode failures by correlating the session with local OpenCode logs, surfacing sanitized HTTP/provider details while excluding prompts, request bodies, headers, credentials, cookies, and URL query strings.
- Fixed Continue and owned-session reconnect checks to verify preserved OpenCode sessions by exact session ID instead of relying on session-list membership, and surfaced rejected workflow actions inline in the blocked-error view.
- Made `HTTP 402 Payment Required` OpenCode provider blocks eligible for same-session Continue after payment or workspace access is restored, while keeping permanent 4xx request, auth, permission, model-not-found, and request-size failures non-continuable.
- Fixed CODING timeout ownership so LoopTroop-owned per-iteration deadlines consume bead attempts, capture context-wipe notes, abandon the timed-out session, reset the worktree, and retry in a fresh owned session until `BEAD_RETRY_BUDGET_EXHAUSTED`, while true OpenCode/provider timeouts still preserve same-session Continue when eligible.
- Fixed Current Activity timeout detection so timeout-like strings in model/tool/debug output no longer create false `Workflow timeout` banners; near-timeout warnings now use structured prompt deadline metadata and only appear during the final warning window.
- Fixed stale Current Activity near-timeout warnings so completed prompts no longer keep showing active countdowns when revisiting a previous status, and terminal timeout elapsed values stay pinned to the diagnostic event.
- Made `npm run dev` print immediate and phase-level preflight progress before bootstrap dependency checks, daily dependency/audit/OpenCode maintenance, stale-process cleanup, and port checks, with a final completion duration.
- Updated ProfileSetup documentation-link test coverage for the OpenCode Max Steps configuration link and normalized `docs/roadmap.md` to LF-only line endings so release validation passes consistently.

---

## 0.2.2 (2026-05-22)

### Summary
- Extracted magic numbers into named constants, consolidated a repeated Tailwind label class, and standardised boolean variable naming across the codebase.
- Hardened workflow approval, audit, bead-finalization, archived-version, and cleanup boundaries with content hashes and visible cleanup warnings.
- Documented the ticket-handler route split from a single file into focused route modules without changing workflow behavior.
- Added profile-controlled OpenCode retry budgets so transient provider stalls block early with diagnostics and same-session Continue across OpenCode-backed phases.
- Preserved underlying OpenCode provider/session causes on coding bead failures so parser or retry-budget wrappers no longer hide usage-limit style blockers.
- Extended the ticket disk space card in the details view to allow expanding any category (Source Code, Phase Artifacts, or Execution Logs) to see which specific folders/files are occupying space, rendered in a beautiful HSL dark-mode monochrome interactive accordion.
- Added a beautiful button and card to calculate and display ticket disk space usage with granular breakdown by logs, artifacts, and source code.
- Made manual Retry preserve versioned logs and artifacts for every non-implementation failed status while keeping CODING bead-scoped.
- Made documentation screenshots collapsible and clickable, with expanded bead error screenshots on the docs home page.
- Consolidated changelog maintenance into the docs changelog while keeping a root pointer for discoverability.
- Prevented first-interaction crashes when a lazy UI module fails to load during dev startup.
- Made versioned coverage reports keep version transitions in order while defaulting to the latest check and suppressing stale open-gap lists.
- Clarified the `npm run dev` startup summary with an explicit package release-age gate note.
- Added a beautiful Changelog documentation page positioned above the Roadmap.
- Made Full Answers parsing more resilient to malformed YAML formatting while preserving approved interview metadata.
- Kept the left-panel Errors header compact while showing real bead counters in expanded coding-error labels.
- Made OpenCode runtime setup permissive and self-healing while keeping missing execution tooling as a hard setup blocker.
- Made OpenCode session startup more resilient with bounded app-wide retries and health diagnostics.
- Added an opt-in `npm run dev --opencode-logs=all` mode for full managed OpenCode DEBUG logs in the terminal.
- Audited and corrected all user-facing status descriptions, Details content, and documentation for accuracy and consistency.
- Added a high-priority roadmap item for a Context Slimming Pipeline that audits per-phase input/output fields, strips unused data from canonical context while preserving it in companion artifacts, and classifies every field by downstream consumption.
- Applied targeted reliability and safety fixes from an external audit: atomic write durability, git timeout hardening, ticket cancel race, interview null guard, and bead schema validation.

### Detailed Changes

#### Changed
- Extracted 9 magic numbers (`GIT_CHECK_DEBOUNCE_MS`, `COUNTDOWN_TICK_MS`, `DROPDOWN_Z_INDEX`, etc.) into named constants in `src/lib/constants.ts`.
- Consolidated the repeated `text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground` Tailwind pattern (21 occurrences) into a `.section-label` `@apply` class in `src/index.css`.
- Standardised all boolean state and derived variables across 21 components to use `is`/`has`/`should` prefixes (e.g. `open` → `isOpen`, `showHistory` → `isHistoryOpen`, `showModelTabs` → `hasModelTabs`).

#### Added
- Added SHA-256 content identity to approval snapshots/receipts and artifact read responses, required `expectedContentSha256` approval payloads with stale-approval `409` responses, durable approval receipts for all approval gates, and append-only `user_edit_receipt:*` artifacts for manual artifact edits.
- Added `cleanup.status` to cleanup reports and a top-level ticket cleanup summary so completed tickets can surface non-blocking cleanup warnings.
- Added profile settings for `OpenCode Retry Limit` and `OpenCode Retry Grace Window`, exposed through the API, Configuration UI, and documentation with defaults of 10 retry events and 60 seconds.
- Added recursive nested file and folder expansion directly in the ticket disk space details view, incorporating standard monochrome folder/file icons, exact size formatting, and custom collapsible sub-accordions with smooth transitions.
- Added full recursive top-level and category child listings with sizes in the Hono ticket size API endpoint (`/tickets/:id/size`).
- Added a ticket disk space calculation card under the Artifacts Location in details view with a premium themed button, interactive hover effects, live loading state, error alert banner, and on-demand recursive disk size computation broken down by Source Code, Phase Artifacts, and Execution Logs.
- Added a `GET /tickets/:id/size` route to Hono backend for recursively measuring ticket worktree folders using safe non-symlink-following `lstat` concurrency, computing precise space breakdowns for logs, artifacts, and source files.
- Added a robust integration test `server/routes/__tests__/tickets.size.test.ts` verifying exact and recursive file size aggregation and granular category splits.
- Added two bead error screenshots to the docs home page and a docs-wide image lightbox so screenshots can be opened nearly full screen with a top-right close button.
- Added a dedicated `Changelog` documentation page (`docs/changelog.md`) detailing LoopTroop's official release history starting from release `0.1.0`.
- Integrated `/changelog` route into both VitePress sidebar and top navbar navigation.
- Added `npm run dev --opencode-logs=all` to print full managed OpenCode DEBUG logs with `--print-logs --log-level DEBUG`, plus `LOOPTROOP_OPENCODE_LOGS=all` for direct watcher launches.

#### Changed
- Clarified that the workspace phase header's `(details)` button opens the canonical workflow metadata from `shared/workflowMeta.ts`, and aligned the state-machine and ticket-flow wording for approval and execution-setup statuses with the current UI copy.
- Bead completion now means OpenCode success plus local finalization success: local commits are required when code changes exist, true no-op completions are allowed, push failures are warnings, and fatal finalization failures route through `BEAD_FINALIZATION_FAILED` instead of broadcasting `bead_complete`.
- Archived phase-attempt artifacts are explicitly read-only, while current approval-edit routes continue to write only the active version.
- Added "Context Slimming Pipeline" as a high-priority roadmap item in `docs/roadmap.md` for per-phase input/output field auditing, deterministic strip-and-store, and retry-path field classification.
- Updated architecture and ticket-flow documentation to reference the focused `server/routes/ticketHandlers/` module directory for user-triggered ticket actions.
- Clarified the Configuration UI copy for OpenCode Provider Recovery so it explicitly mentions rate-limit, usage-limit, overload, timeout, and network retry events across phases.
- Manual Retry from `BLOCKED_ERROR` now archives and creates fresh phase attempts for every non-implementation status, including runtime setup and post-implementation phases, while `CODING` keeps its existing failed-bead reset and retry history.
- Wrapped the docs home-page screenshots in collapsed-by-default details sections so only each screenshot title is visible until expanded.
- Made `docs/changelog.md` the canonical full changelog, including unreleased changes, and replaced the root `CHANGELOG.md` with a discoverability pointer.
- `npm run dev` now prints a short multi-line package gate note in the startup summary, making it clearer that direct npm dependency updates and audit fixes wait until package releases are 7 days old while OpenCode updates immediately.
- Updated `@opencode-ai/sdk` from `1.15.5` to `1.15.6`.
- `npm run dev` now starts managed OpenCode servers with `OPENCODE_PERMISSION='"allow"'` by default, while `LOOPTROOP_OPENCODE_PERMISSION_MODE=inherit` lets external permission policy pass through unchanged.
- Workspace setup prompts now treat missing required command launchers as setup gaps, attempt user-space provisioning under `.ticket/runtime/execution-setup/tool-cache`, record reusable `env.sh`/`run` wrapper artifacts, and tell coding/final-test agents to run setup-dependent commands through the wrapper.
- Execution setup retries now preserve the ticket-owned `tool-cache` while clearing stale profile and wrapper state, and stop early when the same tooling blocker repeats after provisioning fails.
- Updated `BLOCKED_ERROR` status description to include the `Continue` action alongside `Retry`, with accurate detail on eligibility and session behavior; aligned `DRAFTING_PRD` description to note that structured retries are exhausted before a PRD draft is skipped.
- Replaced all opaque internal prompt IDs (`PROM4`, `PROM_CODING`, `PROM51`, `PROM25`) with plain English descriptions in `shared/workflowMeta.ts`, `docs/execution-loop.md`, `docs/ticket-flow.md`, and `docs/configuration.md`; replaced internal constant names (`BEAD_STATUS_SCHEMA_REMINDER`, `CONTINUE_CODING_SCHEMA_REMINDER`, `shouldUseStructuredRetry`, `buildContinuationPrompt`, `perIterationTimeoutMs`) with conceptual descriptions in the CODING Details steps.
- Removed stale `COMPLETED` note that incorrectly implied the candidate branch had not yet been merged (the merge decision is finalized in `WAITING_PR_REVIEW` before `COMPLETED` is reached).
- Synced all eight out-of-date rows in the `docs/state-machine.md` Phase Descriptions table with their canonical `description` fields in `shared/workflowMeta.ts`.
- Refined PRD coverage status description to clarify in-phase revision loop instead of implying cross-state transitions.
- Clarified PRE_FLIGHT_CHECK status description to note the minimal AI connectivity probe instead of broadly stating "No AI context is passed."
- Annotated dead `GAPS_FOUND` state machine transitions for PRD and beads coverage phases as defensive-safety artifacts since coverage loops internally.
- Added JSDoc to all exported types, interfaces, and functions across `shared/workflowMeta.ts`, `src/lib/workflowMeta.ts`, `WorkspacePhaseSummary.tsx`, `ticketMachine.ts`, and `ticketQueries.ts`.
- Documented the dynamic `continue` action injection on `getAvailableWorkflowActions` with a reference to `addContinueActionWhenAvailable`.
- Annotated the unused `votes` context key as reserved and added a note to `CONTEXT_KEY_LABELS`.

#### Fixed
- OpenCode `session.status` retry events for rate limits, usage limits, overload/capacity, temporary unavailability, timeouts, and network/socket failures now block through `BLOCKED_ERROR` after the configured budget, preserving provider diagnostics and active sessions for Continue when eligible.
- Coding completion-marker and bead retry-budget failures now retain the latest underlying OpenCode provider/session diagnostic, such as usage-limit retries, in the blocked error details.
- CODING now routes continuable OpenCode/provider retry exhaustion through the normal blocked-error path instead of converting it into bead retry exhaustion, while ordinary implementation failures keep the existing bead reset/retry behavior.
- Active bead countdowns now reset their start timestamp when a new coding iteration/session begins, preventing the UI from sticking at `00:00/20:00` while later iterations continue.
- Left-panel blocked-error headers now stop appending active bead identifiers after the count and Active badge, preventing long bead names from overflowing the navigator while preserving details in the expanded error view.
- Coding error occurrence labels now use the ticket's runtime bead counters, so left-panel rows and blocked-error headers show labels such as `Implementing (Bead 2/5)` instead of the generic `Bead ?/?` fallback.
- Lazy-loaded Configuration, ticket creation, project, and workspace views now automatically refresh once after recoverable dynamic-import/chunk-load failures, avoiding the root crash screen caused by transient first-load module fetch races.
- Coverage reports now show the latest open-gap status by default after ordered version transitions, suppress stale open-gap lists when no gaps remain, and switch gap headings/lists to the selected `v1 > v2` or `v2 > v3` transition.
- Fixed date rendering on the Changelog documentation page by formatting version dates as clean, standard parentheses text, avoiding raw unparsed HTML badge tags.
- Full Answers normalization now restores canonical `follow_up_rounds` when a model emits malformed round metadata and repairs common multiline `free_text` YAML formatting without changing answer text.
- Bead commits now exclude execution setup temp roots, reusable setup artifact roots, and legacy `.cache/project-tooling/**` files so temporary toolchains cannot be recorded as implementation work.
- OpenCode session creation now retries the initial attempt up to three times with bounded backoff, collecting lightweight health diagnostics after failures while preserving cancellation and timeout behavior.

#### Security & Reliability
- Ticket cancel now awaits active OpenCode session abort before executing destructive cleanup, eliminating the race where cleanup could run while sessions were still writing.
- Interview batch async path now explicitly returns 404 when no session artifact is found, replacing the non-null assertion that could crash at runtime.
- Bead plan PUT endpoint now validates each bead against a required-field schema (id, title, status, priority, dependencies) and rejects duplicate IDs, preventing malformed execution plans from being written.
- Git operations now include a 30-second timeout and `GIT_TERMINAL_PROMPT=0`/`GIT_ASKPASS=echo` environment guards so locked repositories, credential prompts, or network filesystems cannot hang the server process; push operations use a 120-second timeout.
- Atomic write helper now cleans up the `.tmp` file in all failure paths and fsyncs the parent directory after rename for crash-durable artifact persistence.

---

## 0.2.1 (2026-05-20)

### Summary
- Added a profile-level Structured Output Retries setting that is locked per ticket and now covers PR draft parsing before GitHub side effects.
- Standardized automatic retry inspection in Raw tabs and manual retry review through archived phase versions.
- Kept structured retry audit controls clearer by making model labels passive, labeling validated retry outputs with their attempt number, and limiting intervention warnings to the primary artifact tab.
- Kept structured adjustment notice badges aligned with the fixes and retry attempts shown in expanded details.
- Removed duplicate Raw selector tabs so identical payloads appear once, preferring per-attempt retry tabs over generic raw-output shortcuts.
- Kept single-model Raw views focused by omitting the aggregate selector when only one model source has raw output.
- Kept Raw attempt inspection focused by removing stored artifact JSON shortcuts and grouping single-model attempts under model/mode labels.
- Kept Raw attempt buttons in numeric attempt order across statuses.
- Kept voting-phase winner artifact Raw views scoped to the winning draft instead of vote scorecards.
- Kept previous draft Raw views canonical after drafting by showing only the validated draft in voting/refining artifacts.
- Raised the OpenCode event-listener warning threshold to reduce noisy stream warnings during parallel ticket activity.
- Made `npm run dev` startup maintenance output include package names, version changes, and held-release eligibility times by default.
- Added a global reconnecting banner that appears on all views when the backend is unreachable, polling every 3 seconds.
- Fixed error navigation from Full Log so selecting an error opens its review view.
- Fixed coverage reports so unresolved PRD, interview, and blueprint gaps are visible from the report instead of only approval warnings.
- Kept human-input workflow phases visually paused by replacing left-timeline spinners with static waiting indicators.
- Improved blocked-error diagnostics so OpenCode usage-limit failures remain visible when structured coverage output is empty.
- Made blocked-error diagnostics explain when AI output was cut off by an OpenCode/model length stop, including finish reason and token counts.
- Added a Continue recovery action for eligible blocked OpenCode sessions so temporary model interruptions can resume without starting a fresh phase attempt.
- Preserved ticket artifacts during execution resets so retries no longer lose bead plans or planning context.

### Detailed Changes

#### Added
- Added configurable structured-output retry counts with profile/API/UI validation, ticket-start locking, and documented continued-session versus fresh-session retry classes.
- Added structured retry for pull request title/body drafting before branch push or PR create/update, with diagnostics and deterministic fallback text when parsing remains invalid.
- Added raw attempt persistence for PRD/interview/beads refinement, relevant-files scan, coverage audit/revision, execution setup plan/runtime generation, and final-test generation.
- Added Raw tab variants for structured artifacts with `rawAttempts`, including diagnostic entries when a retry failed before model text existed.
- Added a global backend reconnecting banner in the app header that polls `/api/health` every 3 seconds and shows an amber "Reconnecting to server…" badge whenever the backend is unreachable, covering all views including the Kanban board.
- Added a conditional `Continue` action for `BLOCKED_ERROR` tickets with resumable OpenCode/provider diagnostics and a matching active preserved session; it dispatches `CONTINUE` and sends exactly `continue please` to the same OpenCode session.

#### Changed
- Replaced hardcoded one-shot structured retries across scanning, interview/PROM4 parsing, PRD/beads planning, coverage repair, execution setup, coding marker repair, and final-test generation with the locked ticket retry count while keeping broader workflow attempt budgets separate.
- Documented the four retry classes and standardized status/details wording around **continued session**, **fresh session**, and broader **new attempt** loops.
- Manual Retry from `BLOCKED_ERROR` now archives the failed tracked phase attempt and creates a fresh active attempt before rerunning, so rerun artifacts and logs are versioned separately.
- Blocked-error history now records `CONTINUED` resolutions separately from `RETRIED`, and CODING continuation preserves the interrupted bead/session instead of running the normal reset-first retry recovery.
- Canonical artifact flow keeps rejected malformed model output diagnostic-only while downstream phases continue to consume accepted normalized content.
- Structured artifact viewers now keep parser/retry intervention notices on the primary artifact tab, while retry producers share one raw-attempt helper so accepted/rejected attempt metadata stays consistent across phases.
- Made grouped Raw selector model labels passive metadata, labeled validated retry outputs with their accepted attempt number, and deduplicated identical Raw variants, with per-attempt retry/validated tabs preferred over generic `Raw Output`, `Model Output`, `Accepted Output`, `Validated`, or `Rejected` shortcuts.
- Removed explicit stored `Artifact JSON` Raw variants from structured attempt viewers; Raw now focuses on model output attempts grouped under their model/mode source label.
- Raw attempt variants now retain numeric attempt order after duplicate raw/model-output shortcuts are collapsed, with log-derived rejected retry shortcuts labeled by their inferred attempt number.
- Added a project-level OpenCode plugin that sets the Node/Bun event listener warning threshold to 20 inside the OpenCode process.
- Development maintenance output now renders a single default startup summary with package-level dependency update details, held direct dependency details, and held audit remediation eligibility times.
- Removed the separate verbose dev-startup mode so dependency maintenance details appear in normal `npm run dev` output.
- The `npm run dev` startup summary now prints the docs URL once instead of repeating its port as a suffix.

#### Fixed
- ApprovalView tests now mock the async UI-state save mutation used by debounced approval draft persistence, preventing timer-driven false failures during full-suite runs.
- Selecting an error from the navigator while Full Log is open now exits full-log mode and opens the error review.
- Blocked coverage errors now preserve underlying OpenCode retry/provider diagnostics, such as usage limits, and avoid repeating an identical parser-wrapper message in the error details.
- Structured-output failures caused by OpenCode `finish_reason=length` are now classified as output truncation and shown in the blocked-error underlying details instead of only surfacing secondary parser messages like missing fields.
- Single-model Raw artifact views no longer show a redundant aggregate selector; raw, validated, and retry variants remain available under the model source.
- Voting-phase winner artifacts now ignore vote-phase model logs when draft raw output is missing, so Raw and validated views stay focused on the selected draft across interview, PRD, and beads voting.
- Previous draft artifacts shown after their drafting phase now render only the validated draft in Raw, keeping rejected/raw model text scoped to the original drafting diagnostics while downstream phases show the canonical content they actually consume.
- Structured artifact notice badges now count the owner-level fixes and retry attempt totals shown in expanded details, so aggregate vote details and multi-retry council drafts no longer underreport adjustments.
- Coverage reports now render the current open gap list from `remainingGaps`, `gaps`, `parsed.gaps`, or the latest gap attempt so terminal cap warnings match the inspectable report details.
- Needs-input phases now use static waiting indicators in the left timeline, and workspace setup approval now follows the same side-navigation styling as the other approval gates.
- Execution setup, coding, and final-test retry resets now preserve LoopTroop-owned `.ticket` artifacts while still rolling back project file changes.

---

## 0.2.0 (2026-05-12)

### Summary
- Added expanded runtime diagnostics, output-normalization documentation, operations guidance, configuration reference material, and refreshed onboarding docs.
- Added richer ticket/workspace surfaces for setup-plan review, regenerated approval versions, raw/rejected artifact inspection, live phase logs, GitHub links, and completed-ticket worktree cleanup.
- Added broader test coverage across middleware, routes, workflow phases, logs, structured output repair, UI components, dev maintenance, and diagnostics.
- Refined the planning flow around interview/PRD approval edits, member-specific council artifacts, winner-model context, coverage warnings, and beads planning.
- Improved dashboard and workspace ergonomics with tighter status chrome, clearer phase summaries, better artifact rendering, keyboard/menu fixes, and more resilient ticket normalization.
- Updated development maintenance behavior so dependency sync, npm audit remediation, and OpenCode maintenance are coordinated through the startup preflight.

### Detailed Changes

#### Added
- Added expanded runtime diagnostics, output-normalization documentation, operations guidance, configuration reference material, and refreshed onboarding docs.
- Added richer ticket/workspace surfaces for setup-plan review, regenerated approval versions, raw/rejected artifact inspection, live phase logs, GitHub links, and completed-ticket worktree cleanup.
- Added broader test coverage across middleware, routes, workflow phases, logs, structured output repair, UI components, dev maintenance, and diagnostics.

#### Changed
- Refined the planning flow around interview/PRD approval edits, member-specific council artifacts, winner-model context, coverage warnings, and beads planning.
- Improved dashboard and workspace ergonomics with tighter status chrome, clearer phase summaries, better artifact rendering, keyboard/menu fixes, and more resilient ticket normalization.
- Updated development maintenance behavior so dependency sync, npm audit remediation, and OpenCode maintenance are coordinated through the startup preflight.

#### Security & Reliability
- `npm run dev` now restores daily startup dependency/audit/OpenCode maintenance while gating npm dependency updates to releases that are at least 7 days old; if `latest` is too fresh, dependency sync installs the newest eligible older version instead, and audit remediation holds the whole fix when any proposed package version is too fresh. OpenCode CLI and `@opencode-ai/sdk` updates remain immediate.
- Fixed timing side-channel in API token comparison: `constantTimeEquals` now always runs `timingSafeEqual` even when token lengths differ, preventing length-leak via response timing.
- SSE authentication: `apiToken` query parameter now accepted exclusively on `/api/stream` (the only endpoint where browser `EventSource` clients cannot set custom headers); all other endpoints reject query-param tokens.
- Vite dev proxy now injects the ephemeral `LOOPTROOP_API_TOKEN` server-side for same-origin `/api` requests, keeping the token out of the frontend bundle while preserving protected local development.
- `LOOPTROOP_ALLOW_UNAUTHENTICATED=1` only bypasses auth when no API token is configured; non-loopback binds still require `LOOPTROOP_API_TOKEN`.
- Request body size limit now enforced while reading chunked requests without a `Content-Length` header, preventing memory exhaustion via large unbounded bodies.
- `validateJson` middleware now validates JSON syntax early and returns 400 rather than allowing handlers to surface unhandled 500 errors.
- Fixed permanent memory leak in SSE stream handler: `await new Promise(() => {})` replaced with a resolvable promise; stream now cleanly resolves on client disconnect.
- Fixed race condition in SSE double-cleanup: added `cleanedUp` guard to prevent `broadcaster.removeClient` from running twice on concurrent abort and error, including initial write/replay failures.
- Project SQLite database cache now evicts the oldest entry when it exceeds 50 entries, preventing unbounded memory and file-descriptor growth.
- `startingTickets` set now cleaned up in a `finally` block, preventing permanent blocking of ticket starts after unexpected errors.
- `isLoopbackHost` and `isLocalhostRequest` now recognise IPv4-mapped IPv6 loopback addresses (`::ffff:127.0.0.1`, `::ffff:7f00:1`).
- Basic auth header builder now validates that the username does not contain `:` (RFC 7617 compliance).

#### Performance
- OpenCode text/reasoning live AI detail updates now use a 10ms live cadence with no large-growth bypass, making thinking/model output feel closer to tool-call responsiveness while keeping streaming upserts out of persisted log files until a final row is emitted.
- `npm run dev` startup logs are quieter by default while preserving dependency/audit summaries in the normal startup output.
- Dev port inspection now avoids `netstat` unless earlier inspectors cannot identify the listener, removing noisy platform warnings during normal startup while preserving fallback diagnostics in verbose mode.
- `contextCache` in `contextBuilder.ts` now evicts stale entries on cache misses, preventing unbounded accumulation in long-running processes.
- `persistedFingerprintsByTicket` map capped at 100 entries to prevent unbounded memory growth.
- Pre-compiled credential-redaction regex in `errorDiagnostics.ts` (was re-created on every call).
- `errorDiagnostics` `modelId` and similar fields now computed once and reused instead of double-sanitising.

#### Bug Fixes
- OpenCode live AI detail streaming now reads the SDK global event feed and filters it back to the active session, restoring real-time thinking/tool/output rows after the `@opencode-ai/sdk` 1.14.48 event behavior change while keeping the existing streaming throttle.
- AI detail logs now backfill finalized thinking, tool, and step rows from all OpenCode assistant message parts for the completed prompt, so AI/model tabs can restore extended tool-use histories even when the browser was not open during the phase or the live event stream closed early.
- Ticket dashboards now normalize partially cached ticket runtime/action/model data before rendering, preventing a full-page crash during fast start and workflow phase transitions.
- `isRecord` type guard now correctly excludes `Date`, `Map`, and `Set` instances.
- `parsePort` now accepts only digit-only TCP port strings so malformed values like `"3000abc"`, `"123.4"`, or `"300e0"` fall back instead of being partially accepted.
- `isBeforeExecution` in `workflowMeta.ts` now has a recursion depth guard to prevent stack overflow on cyclic workflow states.
- `useSSE` stale-closure bug fixed: `ticketIdRef` used inside `onerror`/`onopen` handlers instead of the captured closure variable.
- `AIQuestionContext` polling interval no longer restarts on every render; `activeTicketKey` is now computed inside a stable `useMemo`.
- `readYamlArray` JSON Lines fallback now falls through to YAML parsing on parse failure instead of returning `null`.
- App SQLite database now uses lazy initialization via Proxy, preventing DB file creation at module import time.
- `drizzle.project.config.ts` default DB path now resolved relative to the config file instead of the current working directory.
- `DraftView` state sync moved into `useEffect` to prevent React anti-pattern of setting state during render.
- `DropdownPicker` now repositions on window resize and scroll while open.
- `KeyboardShortcuts` `?` shortcut now suppressed on `contentEditable` elements and `<select>` in addition to `<input>`/`<textarea>`.
- `dev-preflight.mjs` deduplicated: now delegates to `tsx scripts/dev-preflight.ts` instead of duplicating utility functions.
- Completed log entries are no longer entry-count capped in the log API or browser cache; server log files remain the durable source of truth, while streaming partials are still folded to avoid repeated in-progress snapshots.

#### Configuration
- `vitest.config.ts`: all test projects now use `isolate: true` to prevent test state leakage.
- `tsconfig.json`: `scripts/` directory added to `include` so dev scripts are fully type-checked.

---

## 0.1.0 (2026-04-27)

### Summary
- Clarified the README around local AI coding orchestration for repo-scale work, LLM Council planning, Ralph-loop recovery, OpenCode worktrees, and human-in-the-loop PR automation.
- Added repository trust files for licensing, security reporting, contribution flow, conduct expectations, citation metadata, issue templates, and pull request review.
- Added a GitHub social preview asset for shared repository links.
