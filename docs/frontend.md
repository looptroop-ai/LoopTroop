# Frontend

> [!IMPORTANT]
> **TL;DR** — The frontend is a local React + TypeScript SPA using Vite, React Query, React Context, and SSE for real-time updates. It renders ticket workflow, approval gates, coding progress, bead grids, artifact inspection, and phase-versioned history.

The frontend is a React 19 SPA that renders the ticket dashboard, the live workspace, review panes, and the navigator surfaces around them.

The UI is data-driven from:

- `/api/*` REST endpoints
- `/api/stream` SSE updates
- workflow metadata in `shared/workflowMeta.ts`
- ticket artifacts and runtime state from the backend

In development, same-origin `/api/*` calls go through the Vite proxy. When `npm run dev` generates or receives `LOOPTROOP_API_TOKEN`, the proxy supplies the token to the backend server-side so the browser bundle does not contain the secret. Vite completes one explicit optimization pass for every production browser dependency before accepting requests, and dev resources use `Cache-Control: no-store`. This prevents a restored tab from combining cached React/React Query modules from an earlier server process with a newly loaded workspace module.

The app shell also polls `/api/health` for the global reconnecting banner. After the backend has been reached once, a failed health probe is confirmed by two more probes spaced 1.5 seconds apart before the banner appears. A `429` probe still proves that the backend is reachable, and the basic liveness route does not consume the normal read-rate budget. Backend reconnects retain the mounted workspace and recover through normal query/SSE retries instead of forcing a page reload, so native file pickers, hidden tabs, and transient proxy pressure cannot discard the active screen. Guarded reloads remain limited to sustained post-initial ticket-data recovery, recoverable lazy-chunk failures, and the development-only null hook dispatcher produced when restored React and React DOM dependency generations differ.

Most modal routes and workspace views are also lazy-loaded through `lazyWithChunkReload()`. Recoverable chunk-load failures trigger at most one full-page reload per surface, using `sessionStorage` markers so the browser does not loop forever on a broken import. The app-wide error boundary also recognizes the exact development-only signature produced when one React or React Query module appears under two Vite dependency generations; it requests one cooldown-limited recovery reload while leaving ordinary render errors and all production behavior unchanged.

## 1. Top-Level Composition

| Area | Purpose | Primary files |
| --- | --- | --- |
| App shell | App bootstrap, startup overlays, lazy modal routes, global header chrome | `src/App.tsx`, `src/components/layout/AppShell.tsx` |
| Ticket dashboard | Selected-ticket orchestration, live status bridging, navigator/workspace wiring, loading/reconnect banners | `src/components/ticket/TicketDashboard.tsx` |
| Active workspace | Chooses the live view for the selected phase | `src/components/ticket/ActiveWorkspace.tsx` |
| Navigator | Timeline, approval navigation, context tree, errors, full log entry point | `src/components/ticket/NavigatorPanel.tsx` |
| Workspace views | Draft, council, interview, approval, coding, error, canceled, review, full log | `src/components/workspace/*` |
| App providers | React Query bootstrap, UI state, tooltips, error boundary | `src/main.tsx`, `src/context/*` |

### App Shell, Startup Overlays, And Modal Routes

`App.tsx` and `AppShell.tsx` also own several shell-level surfaces outside the active ticket workspace:

- `WelcomeDisclaimer` for the first-run long-workflow warning, including the optional WSL mounted-drive warning from startup status
- `StartupRestorePopup` when LoopTroop restores existing local profile/project state
- centered modal routes for Configuration (`/config`), Projects (`/project/new`), and New Ticket (`/ticket/new`)
- deep-link ticket selection from `/ticket/:externalId`
- header controls for dashboard search, New Ticket, Projects, Configuration, Docs, Refresh, and theme switching; on desktop the ticket search sits beside **New Ticket**, while mobile uses a search popover to preserve header space
- display-only mock/demo ticket IDs render with a superscript `(M)` marker in board cards and selected-ticket dashboard surfaces while keeping the raw external ID for routing, file paths, and artifacts; the dashboard exposes Cancel for non-terminal mock/demo tickets while keeping runnable workflow controls hidden

### Ticket Dashboard Coordination

`TicketDashboard.tsx` is the live-ticket coordinator rather than a passive wrapper.

- mounts `LogProvider` and the SSE bridge (`SSELogConnector`) around the active ticket workspace
- reconciles the polled ticket snapshot with live `state_change` events so the workspace can advance immediately while the REST snapshot catches up
- tracks selected phase, selected error occurrence, archived attempt review, full-log mode, and the `Back to live` flow
- forwards workspace navigation/focus events so approval panes can jump directly to a requested anchor
- owns loading and reconnecting banners plus the guarded auto-reload path for sustained ticket-data recovery; stream reconnection recovers through targeted query invalidation without reloading the workspace

## 2. Active Workspace Routing

`ActiveWorkspace.tsx` maps workflow metadata to concrete views.

| `uiView` | Current component |
| --- | --- |
| `draft` | `DraftView` |
| `council` | `CouncilView` |
| `interview_qa` | `InterviewQAView` |
| `approval` | `ApprovalView` |
| `coding` | `CodingView` |
| `manual_qa` | lazy-loaded `ManualQAView` |
| `error` | `ErrorView` |
| `done` | `CodingView` |
| `canceled` | `CanceledView` |

Additional routing rules:

- historical phases usually render through `PhaseReviewView`
- `fullLogOpen` forces `FullLogView` until the user selects another phase or error occurrence
- reviewable past coding still uses `CodingView` in read-only mode
- active or selected error occurrences render `ErrorView`

## 3. Navigator Surfaces

`NavigatorPanel.tsx` is more than a left rail. It combines several different navigation modes:

- `PhaseTimeline` for the workflow spine
- `ErrorOccurrencesPanel` for active and past failures; active or selected errors auto-expand as a starting state but remain user-collapsible, its compact header shows only count/state, and expanded coding-error rows use the ticket's runtime bead counters while leaving deeper bead/error details to the workspace view
- `ApprovalNavigator` for interview, PRD, and beads approval context
- `ContextTree` for context visibility
- a full-log toggle that opens `FullLogView`
- error occurrence selection exits full-log mode and opens `ErrorView` for the selected failure

That split matters because the workspace is designed for both live work and historical review.

## 4. Key Workspace Views

| View | Primary purpose |
| --- | --- |
| `DraftView` | Ticket editing and start controls |
| `CouncilView` | Multi-model draft and vote phases with artifacts |
| `InterviewQAView` | Interactive interview batches, visible autosave state and last-save time, draft persistence, and skip flow |
| `ApprovalView` | Review and edit interview, PRD, beads, and execution setup artifacts with visible draft-autosave feedback; PRD approval also exposes the winning model's Full Answers as compact read-only context, and execution setup approval keeps live logs expanded until the setup plan is ready |
| `CodingView` | Active bead execution, bead list, logs, diffs, verification actions |
| `ManualQAView` | Live verification draft, evidence, submission/drift recovery, and read-only round history after the generated checklist is handed off |
| `ErrorView` | Live blocked state or historical error occurrence review |
| `PhaseReviewView` | Historical artifact review for completed phases |
| `FullLogView` | Full folded execution log stream |

## 5. Coding Workspace Surfaces

The coding workspace is broader than a simple log pane.

Current `CodingView` composes:

- bead list and progress UI
- `PhaseAttemptSelector` when reviewing archived non-live attempts
- `BeadDiffViewer`
- per-bead `Details`, `Changes`, `Log`, `Input`, and `Output` tabs, plus a `Versions` selector when multiple bead iterations exist
- `PhaseArtifactsPanel`
- `VerificationSummaryPanel`
- `CollapsiblePhaseLogSection`

It also merges persisted bead artifacts with runtime bead overlays from the live ticket payload so the UI can show in-progress status and notes without waiting for a full artifact refresh. Bead details render append-only **Failed Iteration Notes**, **User Retry Notes**, and **Finalization Failure Notes** sections independently, preserving their timestamp, iteration, content, and optional error code.

The live bead countdown uses the runtime bead's attempt-level `updatedAt` as its deadline anchor and falls back to the first-attempt `startedAt` only for legacy data. Restart recovery advances `updatedAt` when the replacement attempt begins, so the displayed clock and backend-owned per-iteration deadline both restart from the new attempt instead of remaining at `00:00`.

QA-origin beads receive a **Manual QA Fix** badge and keep their version, source items, observations, expected behavior, and evidence thumbnails/references visible across Coding, Details, selected-bead, artifact, and log surfaces. Normal retry notes are presented separately.

Execution setup approval exposes workspace inputs, functional workspace probes, and Git-hook handling as first-class plan fields. The user can review and edit each ignored or untracked file or directory before approval. Detected hooks are read-only evidence; the selected policy and ordered validation commands are editable, including adding, reordering, changing, or removing every command without an additional waiver gate. The runtime/final review surfaces whether input materialization and hook validation executed, failed, or was deliberately skipped.

A live `BLOCKED_ERROR` from `PREPARING_EXECUTION_ENV` orders its setup actions as **Edit setup plan...**, **Retry with extra note...**, then **Retry**. The two retry actions sit beside each other. Both dotted labels open a dialog before changing anything. The retry dialog sends only the entered note to the preserved setup session and grants one manual attempt beyond the configured automatic retry budget. It keeps the current runtime phase attempt. The edit dialog asks for confirmation before archiving the failed runtime attempt and returning to the setup approval editor. Historical error occurrences show neither action. Coding uses the same **Retry with extra note...** label, but keeps its existing fresh-bead retry behavior.

### Manual QA workspace

`GENERATING_QA_CHECKLIST` uses the standard non-interactive coding/phase-review workspace. Its activity line and log expose checkpoint, version reservation, context assembly, model/tool work, validation, persistence, and handoff milestones. The clickable `Manual QA Checklist` artifact opens a readable structured checklist first and preserves the exact canonical YAML on a Raw tab. `WAITING_MANUAL_QA` then lazy-loads `ManualQAView` as the interactive consumer, rendering prerequisites, actions, expected results, watch notes, advisory PRD coverage, Pending/Pass/Fail/Waive/Improvement controls, validation, failure merge groups, and evidence. PRD coverage and the Manual QA phase log are collapsed by default, and the log height when expanded is manually adjustable up or down.

The handoff deliberately avoids querying a merely reserved checklist version while generation is still writing it. The round index distinguishes checklist-backed versions from reservations and associates available rounds with their phase attempt, outcome, and completion metadata. Both status titles stay version-free; the existing phase-attempt selector appears only when more than one checklist-backed version is available and drives both the artifact and matching logs. Checklist artifact events, Manual QA status transitions, and SSE gap recovery invalidate the Manual QA query family so the interactive gate opens the durable version without requiring a browser refresh.

Pending is the first and default result for every checklist item. It displays only a short instruction to choose Pass, Fail, Waive, or Improvement, with no evidence or result-specific fields until another result is selected. Waiver reasons are optional. Failure merge groups use selectable item buttons labeled with checklist number and title, support multiple selections, and may include items that have not yet been marked Fail; Submit identifies and blocks on every selected member that is still not Fail.

Only safe raster evidence uses inline previews; SVG, HTML, executables, unknown types, and other files remain downloads. **Extra evidence** presents matching **Add link** then **Add files** actions; link and **Details** inputs are not rendered until Add link is selected. Add files is a real button that synchronously opens a separate hidden native input, keeping the Manual QA workspace mounted before selection in Chromium- and Firefox-family browsers. Uploaded files are inserted into the item immediately on success instead of requiring a page refresh. Five evidence entries are shown initially, with Show more/Show less controlling the remainder. Pass and Waive do not require evidence. Submit and Skip remain disabled while a file upload/removal is active; submission then uses the durable evidence index, retaining valid files and omitting stale optional references. Actionable integrity errors name the item number/title and original filename, never the internal evidence identifier.

Every checklist item, required or optional, can become a non-blocking Improvement. The editor expands inline within the same item rather than opening a modal or separate window. It lets the user review/edit the title, description, appended Manual QA context, and P1–P5 priority (default P3 Normal). A collapsed Advanced section mirrors normal ticket creation’s Manual QA Enabled/Disabled control and starts from the effective project/profile value. Manual QA context, the final-description preview, and the evidence/provenance preview are collapsed by default. Structured provenance and receipts retain the selected priority and explicit Manual QA setting together with the source ticket/project, round, checklist lineage, PRD/bead references, result type, and planned file/link evidence.

Coverage presents a fourth **Not applicable to Manual QA** count and badge beside covered, partially covered, and uncovered. Each such criterion includes the model-supplied reason; criteria cannot be both referenced by a checklist item and marked not applicable.

Draft conflicts stop submit/skip until the user explicitly reloads the server's latest draft. If Submit or Skip was interrupted, the workspace becomes read-only for that operation and reuses the action ID/type exposed by the durable journal; it cannot switch operation types or edit the revision underneath a partial batch. Successful files from a multi-file upload are linked immediately even when a later file fails. Each failed upload retains its exact browser `File` object in an explicit Retry/Dismiss state, so files with identical names/sizes/timestamps still have distinct action/evidence identities. Upload, removal, and drift retries keep those identities, refresh checklist/revision CAS guards from the latest round, refetch after ambiguous failures, and expose recoverable error states. Historical rounds preserve their complete outcome summary, item/coverage counts, waivers, child IDs, evidence/model delivery metadata, and remain selectable while a newer checklist is generating or after a later loop blocks/cancels.

The view distinguishes autosaving, QA-bead generation, submission, child creation/resume, workspace-drift decisions, and skip states. The collapsed selected-version log records validation, the required repository tool activity, candidate persistence, every created ticket/bead and its settings, completion, and errors. There is one primary **Submit** action and no manual Save button. Beside the required-check count, the UI explains that drafts save automatically and shows a relative “Last saved” value; hovering reveals the exact local date and time. Live drafts save only to `manual_qa_draft:vN` after the standard five-second debounce, use server compare-and-set revisions/action IDs, and flush with keepalive on `pagehide`/`beforeunload`. A `409` conflict returns the latest server draft for reconciliation.

The **Skip Manual QA…** action opens a concise warning that no QA fix bead or Improvement ticket will be created. Confirming it bypasses normal result, observation, and merge-group completeness checks, but preserves every entered result, note, merge-group selection, Improvement draft, and evidence reference in the archived round. That snapshot becomes read-only and cannot be edited later. The version selector likewise keeps earlier submitted rounds read-only after a failure returns the live ticket to Coding or after delivery continues.

The timeline is visit-aware rather than solely status-index based. Ticket payloads combine `visitedStatuses` with monotonic `workflowRevision`; SSE and polling prefer the higher revision, so a valid reverse transition from Manual QA to Coding cannot leave a newer-indexed stale screen mounted. Manual QA also participates in needs-input attention, context trees, status summaries, artifact viewers, cancellation/retry surfaces, progress labels, and completed-ticket review.

## 6. Data Hooks

### Workflow, Ticket, And UI-State Data

| Hook | Current role |
| --- | --- |
| `useWorkflowMeta()` | Loads phase/group metadata, seeded from `shared/workflowMeta.ts`, and exposes `{ groups, phases, phaseMap, isLoading }` |
| `useTicketArtifacts(ticketId, opts?)` | Fetches, caches, and merges ticket artifacts for live and archived review surfaces |
| `useTicketPhaseAttempts(ticketId?, phase?)` | Reads archived phase-attempt history for selectors and review panes |
| `useTicketUIState(ticketId, scope)` / `useSaveTicketUIState()` | Persists per-ticket draft/editor UI state such as interview drafts, approval editors, and error-attention markers |
| `useTickets(projectId?)` | Ticket list with 10-second auto-refresh while any ticket is non-terminal |
| `useTicket(id)` | Individual ticket query with 5-second auto-refresh while active, seeded from cached ticket lists when possible |
| `useProjects()` | Attached project metadata for the dashboard, kanban cards, ticket forms, and project management modal |
| `useProfile()` | Singleton profile query against `/api/profile` |
| `useStartupStatus()` | Startup storage/runtime state for restore notices and WSL warnings |
| `useOpenCodeModels()` / `useAllOpenCodeModels()` | Connected-model list versus full provider catalog |
| `useBackendHealth()` | Global backend-reachability banner with confirmation probes to avoid startup false positives |
| `useRecoveryAutoReload(source, active)` | Guarded full-page recovery reload after a sustained, continuously attended reconnect/loading episode clears; browser blur and hidden-tab intervals suppress the reload |

### Live Updates

`useSSE({ ticketId, onEvent })` is the ticket stream hook.

Current behavior:

- connects to `/api/stream`
- persists the latest SSE event id per ticket in browser storage
- sends `ticketId` and `lastEventId` on reconnect when available
- refreshes ticket, artifact, Manual QA, interview, bead, and log queries after a stream gap instead of full-page reloading the active workspace
- waits for the dev backend readiness guard before opening the stream during local Vite development
- uses the same-origin Vite proxy during development, which injects token auth server-side; outside that path, `apiToken` query auth is only valid for `/api/stream`
- listens for `state_change`, `progress`, `log`, `app_error`, `bead_complete`, `needs_input`, and `artifact_change`
- receives AI/model log detail as fast live-only `log` upserts plus persisted finalizations/backfills backed by `.ticket/runtime/execution-log.ai.jsonl`, so OpenCode thinking, tool calls, and model output can appear live without bloating durable logs and remain available after reconnect or tab close
- patches or invalidates React Query caches in response, including direct artifact snapshot merging for `artifact_change`
- refetches ticket details, ticket lists, artifacts, interview state, setup-plan state, bead state, and server logs after a reconnect gap
- lets the dashboard trigger the guarded recovery reload once the visible live-update reconnecting episode has cleared
- returns `{ lastEventIdRef, connectionState }`

Current `connectionState` values are:

- `connecting`
- `connected`
- `reconnecting`

## 7. Interview Draft Persistence

`useBatchSubmit(ticketId)` is one of the higher-value stateful hooks in the app.

It does more than submit answers:

- stores draft answers per interview batch
- tracks skipped questions
- tracks selected options
- restores drafts from persisted UI state
- auto-saves drafts with debounce through ticket UI-state artifacts and only marks a draft saved after the write succeeds
- exposes pending, saving, saved, conflict, and failure states through the shared autosave indicator near the batch actions
- shows a relative last-save time that refreshes every five seconds, with the exact local timestamp on hover
- flushes the latest unsaved snapshot with a keepalive request on `pagehide` or `beforeunload`
- coordinates submit and skip mutations
- listens for interview batch updates coming back from the runtime

That makes `InterviewQAView` resilient across reloads, view changes, and follow-up question rounds.

### Interview View Structure

`InterviewQAView` pairs `useBatchSubmit()` with concrete editor/history surfaces rather than a separate "flow controls" layer:

- `QuestionList` renders answered and skipped history groups, plus in-place edits for previous answers
- `AnswerEditor` renders the active batch, choice inputs, AI commentary, per-question skip actions, a skip-all confirmation path, and batch progress badges
- a bottom `CollapsiblePhaseLogSection` keeps the live phase log available while the user answers questions

The current batch can come from the persisted interview session snapshot or the latest SSE-driven batch. History groups are derived from the normalized question source (`compiled`, `prompt_follow_up`, `coverage_follow_up`, `final_free_form`) and rendered with user-facing labels such as `PROM4 Follow-ups` and `Coverage Follow-ups`.

Approval panes use the same success-aware debounced UI-state pattern for editor drafts. While the active Interview Approval, Specs Approval, Blueprint Approval, or Workspace Setup Approval editor is editable, a shared **Draft autosave on** indicator beside **Save** reports pending, saving, saved, conflict, and failure states. Its relative last-save time refreshes every five seconds, and its hover text gives the exact local timestamp of the last server-acknowledged save. Historical and other read-only views do not show autosave as enabled.

Approval autosave protects the editor draft across reloads; it does not update the authoritative interview, PRD, blueprint, or execution setup artifact. The user must still click **Save** to apply the draft, including any downstream invalidation or workflow effects.

Artifact edits in the approval panes are made through the shared `YamlEditor` (`src/components/editor/YamlEditor.tsx`), a CodeMirror-based YAML surface with line numbers, syntax highlighting, and bracket matching, used in both editable and read-only modes. When a manual edit would invalidate downstream artifacts, the pane raises a `CascadeWarning` (`src/components/editor/CascadeWarning.tsx`) confirmation dialog before committing the change, so the user knows the edit cascades into later phases. The interview, PRD, and execution-setup-plan approval panes all share these two surfaces via `ApprovalView`.

`PrdApprovalPane` keeps the PRD editor as the primary surface. When the winning PRD draft has a Part 1 Full Answers artifact, the header shows a compact `Full Answers` chip that opens the read-only complete interview answer set used by that winning draft.

## 8. Artifact And Review Surfaces

Several UI components exist specifically to inspect durable workflow state:

| Component | Purpose |
| --- | --- |
| `PhaseArtifactsPanel` | Phase-specific artifact viewer |
| `PrdApprovalPane` | PRD approval editor plus compact read-only Full Answers context for the winning draft |
| `WorkspacePhaseSummary` | Compact summary for the selected phase; its `(details)` button opens the expanded workflow metadata from `shared/workflowMeta.ts` while keeping the selected status lightweight above the workspace |
| `DashboardHeader` details dialog | Ticket metadata, project info, Markdown-rendered ticket descriptions, file locations, copy/reveal actions, and on-demand ticket size breakdown |
| `VerificationSummaryPanel` | Delivery actions during PR review |
| `PhaseReviewView` | Historical artifact review with phase-attempt support |
| `FullLogView` | Ticket-wide log inspection |

The frontend is built around the assumption that users must be able to inspect prior attempts and artifacts without replaying the run mentally from logs.

Ticket descriptions use Raw/Markdown tabs while users create or edit draft descriptions. Raw remains the editable/plain-text source, while Markdown previews the same stored text as safe rich text. Read-only Ticket Details descriptions render the Markdown view directly without extra view controls.

`WorkspacePhaseSummary` enriches only the live status title with transient progress details. While a ticket is actively implementing, it shows bead and iteration wording such as `Implementing (working on bead 3 of 10, iteration 2 of 5)`. While coverage is active, it shows pass details and, for PRD/Beads coverage, the candidate version being checked. Manual non-implementation retries show the active phase attempt, for example `Refining Specs (retry attempt 2)`. For `BLOCKED_ERROR`, the summary names the phase that failed, shows a cleaned and length-bounded first line of the captured error, and explains only the recovery actions currently available; a selected historical occurrence is labelled read-only. Display cleaning removes terminal escape codes and repeated warning noise without changing raw logs. These live additions disappear as soon as the ticket transitions away from that status, so ordinary historical phase review returns to the plain phase label.

Council-style live workspace phases keep their current-action card dense: compact heading text, tight paragraph leading, and minimal header/content padding so artifacts and logs remain visible without scrolling past oversized status chrome.

`LogProvider` treats the server-side normal execution log as durable truth for the lifecycle view. SSE-delivered rows merge into the in-memory log state immediately so the phase log viewer and full log can render live updates without waiting for file persistence. The browser opens the ticket stream through the same-origin `/api/stream` route, matching normal API fetches and avoiding dev-environment host/CORS drift. In dev, that same-origin path lets Vite inject backend auth without exposing the token to client code; direct stream clients may use `apiToken` only on `/api/stream` when they cannot send headers. Browser-local logs are a best-effort responsiveness cache, but reconnect recovery requests the complete matching server log again and merges by stable entry identity so a frontend restart does not leave the visible log pane stale.

The Current Activity strip above phase and full log views is intentionally diagnostic-only after the first model activity. It shows waiting-for-first-activity and provider retry states before output starts, terminal timeout/empty-output diagnostics from trusted LoopTroop/OpenCode status rows, and an `Approaching timeout` warning only when prompt deadline metadata says the configured timeout is close and the prompt has not yet emitted model activity or completion. Model text, tool output, debug raw messages, and repository source snippets are never scanned for generic timeout words, so target-code symbols such as `ErrTimeout` or `fsWatcherTimeoutS` cannot produce a false workflow timeout banner.

Internal command rows in `SYS > CMD` are result-only summaries. LoopTroop records the command after it completes, prefers concise semantic outcomes for quiet internal commands (for example, clean worktree, push completed, or no files removed), and avoids recurring progress-style command output in deterministic git/GitHub operations.

Streaming AI upserts are also written to `.ticket/runtime/execution-log.ai.jsonl`, a separate AI detail channel that is loaded lazily only for AI and model log views. The backend still does not append those intermediate snapshots to `execution-log.jsonl`; finalized AI rows remain in the normal log for lifecycle history, while the AI detail log preserves prompts, thinking, tool calls, session rows, and latest streaming snapshots for reopening a ticket. After each OpenCode prompt completes, LoopTroop also backfills finalized thinking/tool/step rows from every assistant message in the completed prompt segment of the SDK `session.messages()` parts snapshot, so durable AI detail captures multi-message tool-use turns and does not depend on whether the browser was watching the phase live or whether the event stream stayed connected for the whole response. Loading that detail channel must not broaden `SYS`, `ERROR`, or `CMD` filters; those tabs classify entries from structured source/audience/kind fields and leading runtime tags, not tag-like strings inside raw model output.

AI log rows use consistent visible headers for prompts, reasoning, tools, and output. In combined AI views these render as `[PROMPT-<model-id>]`, `[THINKING-<model-id>]`, `[TOOL-<model-id>]`, and `[OUTPUT-<model-id>]`, using the complete configured model ID (including provider and router segments). Truncated streaming previews render that header once above the retained tail instead of repeating it inside the response. Persisted canonical tags remain unchanged so historical records and internal extraction continue to work.

The `DEBUG` tab provides a complete view of every log line for the ticket. It loads `channel=all` on demand, which merges all three LoopTroop log files (`execution-log.jsonl`, `execution-log.debug.jsonl`, `execution-log.ai.jsonl`) plus OpenCode native server log lines filtered by the ticket's session IDs. All OpenCode SDK stream event types — including `part_removed` — are logged to the debug channel. OpenCode native logs are always written at `--log-level DEBUG` (the managed server is always started with this flag), so they are always available for the DEBUG tab without any extra configuration. Use `npm run dev --opencode-logs=all` to also print them to the terminal. Other tabs (`ALL`, `SYS`, `AI`, `ERROR`) are unaffected — they classify entries from structured `source`, `audience`, and `kind` fields regardless of which channel loaded them.

Artifact raw tabs show line, character, and tokenizer counts. Coverage report cards intentionally omit line-count details because JSON envelopes and escaped multiline payloads can make a displayed card total misleading. Coverage result summaries show status, gap counts, termination/budget notes, open coverage gaps, and interview follow-up questions; the underlying model output and retry attempts remain available in Raw. Versioned coverage reports list normal transition tabs in version order, include user-triggered approval fixes as `Extra Fix N` tabs in the same history, keep `Latest Check` last but selected by default, and suppress open-gap lists when the latest candidate has no remaining gaps; transition tabs still show the gaps found in that specific earlier version.

Structured artifacts that include `rawAttempts` expose those attempts as Raw variants. Single-model attempt views group the attempts under a passive source label that includes the model when known and the mode/substep, then show only concrete attempt buttons in numeric order, such as `Attempt 1 Output - Rejected` followed by `Attempt 2 Output - Accepted`; they do not add a separate stored artifact JSON shortcut. Future attempts may also include an `Initial Prompt` variant before the attempt buttons when the original model prompt was persisted; this shows only the first prompt sent for that model run, never retry prompts or inferred legacy log content. Normalized validated draft/vote selectors include the accepted retry number when known, such as `Attempt 2 Validated`, while preserving the surrounding attempt order. Log-derived rejected retry shortcuts also use the inferred rejected attempt number, such as `Attempt 1 Output - Rejected`, when raw attempt records are unavailable. Diagnostic attempts without model text show the captured error/failure class instead of fabricated raw content. Grouped Raw selectors show model names as passive labels and keep only concrete variants clickable, so model labels do not duplicate an attempt tab. When two variants render the same payload, the viewer shows it once and prefers the more specific retry/validated attempt tab over generic shortcuts such as `Raw Output`, `Model Output`, `Accepted Output`, `Validated`, or `Rejected`; `Initial Prompt` is kept separate even if its text matches another variant. Parser/retry intervention notices stay on the primary artifact tab rather than Raw/Diff diagnostics, and full malformed model text remains confined to Raw output panes and execution logs. Council draft/vote artifacts can still fall back to existing phase model-output logs scoped by phase, model, and PRD sub-stage where needed. Draft raw-log fallback is limited to draft-producing phases; voting-phase winner artifacts never use vote scorecard logs as draft Raw output, so both Raw and validated winner views stay scoped to the selected draft. After a drafting phase, previous draft artifacts shown in voting/refining views expose only the validated draft in Raw, matching the canonical content consumed downstream.

Council drafts with `invalid_output`, `failed`, or `timed_out` outcomes are diagnostic-only in the structured tab. The viewer suppresses draft body rendering even when older companion artifacts still contain a body for that member, and vote/refine merged views strip those failed draft bodies before display. Raw model output, raw attempts, validation errors, and retry excerpts remain available from diagnostics and the Raw tab only while inspecting the drafting phase that produced them; later previous-draft views stay validated-only.

Failed execution setup plan and runtime reports keep `modelOutput` out of the structured details/body. When available, that model output and any `rawAttempts` are exposed through Raw tab variants so failure diagnostics remain inspectable without presenting rejected setup text as accepted plan content.

Manual Retry from `BLOCKED_ERROR` is represented as a phase version for every non-implementation status, not another Raw variant. Views that load archived phase attempts use the existing previous-version selector and `phaseAttempt`-scoped artifact/log queries, including non-`CODING` runtime/delivery phases shown through `CodingView`; error occurrence history remains the source for the blocked-error timeline. Active selected attempts use the live `LogContext`/SSE stream with a `phaseAttempt` filter, while archived selected attempts use a static `/api/files/:ticketId/logs?phaseAttempt=N` snapshot and do not merge live rows. `CODING` keeps its bead-scoped retry UI instead of phase versions.

When a bead is selected in `CodingView`, the bead panel exposes `Details`, `Changes`, `Log`, `Input`, and `Output` tabs with tooltips on each tab. `Input` shows the raw initial prompt captured for the selected bead iteration, using the same readable raw formatting, line count, character count, GPT-5 tokenizer count, and compact copy button as artifact Raw panes. `Output` shows the final model response for that bead iteration, or a captured diagnostic when no model text was available; it stays disabled until the selected iteration has a terminal output or diagnostic. If multiple bead iterations exist, a `Versions` selector appears below the tab bar, sorted by iteration number and labelled by outcome so failed, timed-out, rejected, and accepted attempts remain inspectable without mixing inner same-session retry prompts into the history.

### Artifact Processing Notices

Future artifact companion payloads should persist parser and normalizer intervention details in `structuredOutput.interventions`. The collapsed notice stays compact and may include cheap category or rule labels, while the expanded notice treats `interventions` as the display source of truth for exact corrections, before/after examples, rule, category, stage, target, raw validator/parser messages, validation errors, and retry diagnostics. Retry notices summarize counts, failure classes, validation errors, and short excerpts; they do not duplicate full rejected responses from Raw attempts.

`structuredOutput.repairWarnings` remains a raw audit string list and can be shown as source messages. When a legacy `.ticket/**` artifact has recognized warning strings but no explicit interventions, the frontend derives best-effort notice categories at render time without rewriting or migrating the artifact. Generic legacy repair strings stay quiet unless a structured intervention or retry diagnostic is present.

Parser repairs and structured retries are artifact processing notices, not coverage warnings. Coverage warnings should stay reserved for unresolved planning gaps, including unresolved contradictions inside the source artifacts when a prompt reports them.

Voting artifacts keep one collapsed aggregate processing notice so scorecard repairs remain visible at the top of the results. Expanding that notice shows the full intervention details grouped by affected voter model only; the normal **Voter Details** scorecard section does not repeat the same notices.

## 9. Frontend-State Relationship To Workflow Metadata

The frontend does not hardcode the full workflow. Instead, it derives major behavior from `shared/workflowMeta.ts`:

- group ordering for the timeline
- phase labels
- `uiView` mapping
- whether a phase exposes a review artifact type
- whether a phase is editable
- whether multi-model logs are expected
- whether a phase has question or bead progress semantics

The current timeline group order is To Do, Discovery, Interview, Specs (PRD), Blueprint (Beads), Pre-Implementation, Implementation, Post-Implementation, Done, and Errors. `PhaseTimeline` hides empty groups, so Errors only appears when the blocked-error phase is visible.

This is why keeping the docs aligned with `workflowMeta` matters: the UI is built around that shared metadata contract.

## 10. Configuration, Projects, And Settings UI

`ProfileSetup` (`src/components/config/ProfileSetup.tsx`) is the main configuration form. It is opened from the app header and lets you set all model and workflow defaults. The adjacent Projects modal (`ProjectsPanel` / `ProjectForm`) handles repository attachment, restore, and cleanup operations for local projects.

### Model Selection

| Field | Purpose |
| --- | --- |
| Main Implementer | The primary model used for coding phases. Shown with an optional `EffortPicker` when the model exposes variants. |
| Council Members | Additional models that participate in planning drafts and voting. The main implementer is always added to the council automatically and cannot appear twice. |

`ModelPicker` (`src/components/config/ModelPicker.tsx`) is the shared dropdown for selecting models from the live OpenCode catalog. It defaults to connected models only, but the footer toggle can expand to the full provider catalog. The picker also supports provider grouping, text search, and a free-only filter.

`EffortPicker` (`src/components/config/EffortPicker.tsx`) appears next to a model selector when that model exposes variants (for example `high`, `low`, `medium`). The selected variant is stored per model id in `councilMemberVariants`.

`ProfileSetup` also pings `/api/health/opencode` so the modal can show whether OpenCode is reachable, surface model-discovery failures separately from connection failures, and expose a reload button for the provider/model catalog. Model pickers keep configured-provider and full-catalog queries separate: the configured list loads normally, while the full catalog remains disabled until **Show all providers** is selected. Reload clears both caches and refreshes only the configured list.

### Numeric Settings

All numeric fields are validated against min/max bounds defined in `numericFieldConfig.ts`. The inline help links open the matching `/configuration#...` anchor:

| Field | Docs link |
| --- | --- |
| Per-Iteration Timeout | [Configuration Reference](configuration.md#per-iteration-timeout) |
| Execution Setup Timeout | [Configuration Reference](configuration.md#execution-setup-timeout) |
| AI Response Timeout | [Configuration Reference](configuration.md#ai-response-timeout) |
| Max Bead Retries | [Configuration Reference](configuration.md#max-bead-retries) |
| OpenCode Retry Limit | [Configuration Reference](configuration.md#opencode-retry-limit) |
| OpenCode Retry Grace Window | [Configuration Reference](configuration.md#opencode-retry-grace-window) |
| OpenCode Max Steps | [Configuration Reference](configuration.md#opencode-max-steps) |
| Min Council Quorum | [Configuration Reference](configuration.md#min-council-quorum) |
| Max Interview Questions | [Configuration Reference](configuration.md#max-interview-questions) |
| Structured Output Retries | [Configuration Reference](configuration.md#structured-output-retries) |
| Coverage Follow-Up Budget | [Configuration Reference](configuration.md#coverage-follow-up-budget) |
| Interview Coverage Passes | [Configuration Reference](configuration.md#interview-coverage-passes) |
| PRD Coverage Passes | [Configuration Reference](configuration.md#prd-coverage-passes) |
| Beads Coverage Passes | [Configuration Reference](configuration.md#beads-coverage-passes) |
| Tool Input Max Chars | [Configuration Reference](configuration.md#tool-input-max-chars) |
| Tool Output Max Chars | [Configuration Reference](configuration.md#tool-output-max-chars) |
| Tool Error Max Chars | [Configuration Reference](configuration.md#tool-error-max-chars) |

> [!NOTE]
> Timeout and delay fields are stored in **milliseconds**. `ProfileSetup` converts those stored milliseconds to seconds for display and back to milliseconds on save. Count-style fields such as `OpenCode Max Steps` remain raw integers in both storage and UI.

Profile settings are inherited by new tickets at start time. The locked copies in the ticket record are what the workflow actually uses for that run.

### Git Hook Policy

Configuration, Project **Advanced** settings, new-ticket **Advanced** settings, and the Draft workspace expose the linked **Validate**, **Ignore**, and **Run** choices documented in [Git Hook Policy](configuration.md#git-hook-policy). Hovering any choice gives a multi-sentence explanation of its internal Git and validation behavior. Each scope also includes a contextual `?` link to the full details, and started-ticket Details repeats the locked choice under **Advanced Settings** with the same help link. **Validate** (`validate_explicitly`) is the recommended profile default; nullable project/ticket values display the inherited active choice without adding a duplicate Inherit option. Start freezes the effective ticket → project → profile value and source, while the execution setup plan remains the ticket-specific review point for detected hooks and explicit validation commands.

### Manual QA Settings

Configuration **Post-Implementation**, Project **Advanced** settings, the ordinary new-ticket form, and the Draft workspace expose `Enabled / Disabled` Manual QA controls. Hovering either choice gives a multi-sentence explanation of the resulting checkpoint route, and every editable scope retains its contextual link to the canonical Manual QA documentation. The ticket controls use a compact single-row layout and omit redundant effective-setting/source copy. Directly below **Models Selected**, Ticket Details has an extensible **Advanced Settings** section that displays the effective Manual QA and Git-hook choices, including the Git-hook documentation link. No surface shows an `Inherit` choice. Legacy unset project/ticket values display their currently resolved boolean, while new saves persist an explicit selection. Once a ticket starts, the backend freezes the effective value/source for the run.

Improvement ticket Details/audit UI reads `.ticket/meta/manual-qa-origin.json` provenance, while later planning still uses only the saved title/description as prompt context; the structured origin record is not injected into future implementation prompts.

### Project Attachment And Maintenance

`ProjectsPanel` is more than a list modal:

- it lists attached repositories, supports sort-by name/ticket-count/created/updated, and opens `ProjectForm` for create/edit flows
- the create flow validates the selected folder with `/api/projects/check-git`, requires a git-initialized repository, and surfaces WSL mounted-drive performance warnings before attachment
- if the selected repository already contains LoopTroop local state, the form previews saved project settings plus total and active ticket counts, then offers **Restore everything**, **Keep project settings, clear tickets**, or **Start fresh**
- the comparison for each action clearly separates retained project metadata/settings from deleted tickets, artifacts, logs, and managed worktrees; the saved short name remains locked for restore/clear and becomes editable only for start-fresh
- restore remains the default and submits immediately, while either destructive action opens a confirmation dialog that prominently names active tickets, the counter reset to `<SHORTNAME>-1`, possible collisions with surviving old branches, and the repository data that remains untouched
- destructive confirmation stays open with its controls disabled while the request is pending; a failure remains visible without discarding the chosen action, and success refreshes both project and ticket caches
- the edit flow focuses on project identity and maintenance: rename, recolor, re-icon, inspect timestamps, delete the project, or open `DeleteWorktreesDialog` to reclaim disk space

Restore keeps all existing workflow state. Clear-tickets preserves project identity, appearance, creation time, profile association, and project-level overrides while removing every ticket and its content; its last-update time records the clear. Start-fresh deletes and recreates `.looptroop` from the current form. Both destructive paths can remove active ticket worktrees, but none of the attachment choices delete repository source files, commits, or branches.

The current frontend project modal is intentionally scoped to attachment metadata, restore/clear/start-fresh decisions, and cleanup. It does not expose every advanced per-project workflow override in the modal today.

## 11. Context Providers

The provider stack is split across `main.tsx`, `App.tsx`, and `TicketDashboard.tsx`. `main.tsx` installs the React Query client, `UIProvider`, `TooltipProvider`, and the app-wide `ErrorBoundary`; `App.tsx` adds `ToastProvider` and `AIQuestionProvider`; `TicketDashboard.tsx` mounts `LogProvider` for the active ticket. The app-wide `ErrorBoundary` renders the `AppCrashScreen` fallback, which shows the `App crashed` message plus a `Show details` panel exposing the caught error message, stack trace, and React component stack (with copy-to-clipboard and a Refresh action).

Among the custom LoopTroop state providers, three carry most of the frontend-specific cross-cutting state:

| Provider | Location | Purpose |
| --- | --- | --- |
| `LogProvider` | `LogContext.tsx` | Owns the in-memory execution log for the active ticket. Merges SSE-delivered log rows immediately and handles reconnect recovery by re-requesting the server log and merging by stable entry identity. |
| `UIProvider` | `UIContext.tsx` | Manages app UI state such as the selected ticket, `filters.search`, Kanban triage filters (`status`, `phase`, `priority`, `stuckDays`, `errorState`, `sortBy`), project-scoped triage presets (`presetsByProject`), sidebar state, log panel height, and theme. It persists that state to `localStorage` before paint after UI updates and keeps the browser URL in sync with the active view. |
| `AIQuestionProvider` | `AIQuestionContext.tsx` | Manages the queue of pending OpenCode human-input requests across active tickets, including minimize/reopen state, answer/reject actions, and periodic recovery from `/api/opencode/questions`. |

Interview draft persistence is separate: `InterviewQAView` uses `useBatchSubmit()` and ticket UI-state artifacts for interview answers, while `AIQuestionProvider` is specifically for execution-time OpenCode questions.

## 12. Kanban Board

`KanbanBoard` (`src/components/kanban/KanbanBoard.tsx`) is the alternate ticket overview. It groups `TicketCard` components into four fixed board locations: To Do, Needs Input, In Progress, and Done.

Ticket placement comes from the `kanbanPhase` mapping in `workflowMeta.ts`/`STATUS_TO_PHASE`. To Do is for created-but-not-started tickets, Needs Input is for any user-owned pause including blocked errors, In Progress is for active AI or system workflow work, and Done is for completed or canceled terminal tickets. `KanbanColumn` handles the per-column layout and empty-column suppression.

The board keeps fixed relative column weights on wide screens, with To Do and Done intentionally narrower than the middle workflow columns. Ticket cards therefore wrap long titles, project names, status badges, and timestamps inside the existing column width rather than forcing horizontal scrolling or clipping narrow edge columns. Kanban columns opt into block-based scroll-area content so the scroll viewport does not expand to the widest card.

The Kanban board is the default root view when no ticket is selected. Clicking the app logo or closing the active ticket returns to it.

Dashboard ticket search is shell-level chrome for the root board. `AppShell` renders the search input beside **New Ticket** on desktop and moves the same control into a mobile search popover on small screens. The value is stored as `filters.search` in persisted `UIState`, so it survives refreshes and normal dashboard navigation.

Kanban search filtering is client-side and intentionally narrow. It filters the already-loaded ticket list by external ticket ID, title, ticket description, attached project name, and project shortname only; status labels, phase text, priority labels, and other metadata are not part of the dashboard search index. External IDs use compact matching that strips separators and ignores case, so a search such as `LOO15` matches `LOO-15`. Matching cards show a compact field hint such as `ID match`, `Title match`, `Description match`, or `Project match`.

The Kanban filter slider opens the Triage & Filter Control Bar for project, status, phase, priority, stale/inactive, errors, saved preset, and sort controls. Status is a multi-select of every workflow step grouped by phase; Phase is a multi-select of all ten workflow groups (To Do, Discovery, Interview, Specs (PRD), Blueprint (Beads), Pre-Implementation, Implementation, Post-Implementation, Done, Errors); both narrow tickets within their existing Kanban columns. The Errors control is tri-state: `All states`, `Has errored before` (tickets with `hasPastErrors`, including currently blocked), and `Currently blocked` (only `BLOCKED_ERROR`). The hidden slider button shows a count badge when any non-search triage filter or non-default sort is active. Saved presets are project-scoped and stored only in the durable UI-state record (`looptroop-ui-state`, under `presetsByProject`), the same channel as filters and theme; committed state is written before the refreshed UI paints, so a saved preset survives an immediate refresh. On load the provider rehydrates from that record and skips writing state back on its first render, so a failed or empty read can never overwrite good data. As a one-time recovery, any legacy standalone `looptroop-presets-*` keys from older builds are read back into UI state at startup; the app no longer writes those keys. Presets expose their full saved details on hover instead of expanding the dropdown row. The default sort is `Last Updated (Newest first)`.

The stale/inactive filter is intentionally scoped to live operator triage: when a stale age is selected, To Do and Done are cleared and only matching Needs Input and In Progress tickets remain visible. Active Needs Input and In Progress cards also show a compact run-health chip with phase, bead progress, ticket-update age as the available model-response freshness signal, retry count, and an error-message hash when an active error message is present.

Project-name prefix suggestions are generated from all attached projects, not only projects that currently have visible matching tickets. Choosing a suggestion writes that project name into the search field and uses the same client-side filter path as typed input.

When a search has no matches, the board shows an explicit empty search-results state with a clear action while keeping the dashboard search control available. Clearing the search restores the normal unfiltered board; it does not change ticket status placement, column grouping, auto-refresh behavior, or selected-ticket routing.

## 13. Keyboard Shortcuts

`KeyboardShortcuts` (`src/components/shared/KeyboardShortcuts.tsx`) registers the global `?` help overlay. Dashboard search adds its own `/` focus shortcut, and `Escape` is shared across the overlay, dashboard search, ticket dashboard, and modal wrappers.

| Key | Action |
| --- | --- |
| `?` | Toggle the keyboard shortcuts overlay unless focus is already inside an input-like control |
| `/` | Focus dashboard search from the kanban/root dashboard unless focus is already inside an input-like control; on mobile, open and focus the search popover |
| `Escape` | Close the keyboard overlay; in dashboard search, clear a non-empty search or close the mobile search popover; elsewhere the dashboard and modal wrappers also use `Escape` to close the current surface |

Shortcut toggling and dashboard-search focusing are suppressed when focus is inside an `<input>`, `<textarea>`, `<select>`, or another textbox-like editable control.

## 14. Ticket Cancel Confirmation Dialog

Every ticket-cancel entry point, including Draft and Blocked Error, is labeled **"Cancel…"** (the ellipsis signals that a dialog will open before any action is taken). Cancellation never starts directly from the first click.

Clicking the button opens a confirmation dialog with two optional, unchecked-by-default cleanup checkboxes:

| Checkbox | Effect when checked |
| --- | --- |
| **Delete AI-generated artifacts and worktree** | Permanently removes interview Q&A, PRD drafts, and beads plan entries from the database, and deletes the isolated git worktree (including its branch and any code written to it) |
| **Delete execution log** | Permanently removes `.ticket/runtime/execution-log.jsonl`, `.ticket/runtime/execution-log.debug.jsonl`, and `.ticket/runtime/execution-log.ai.jsonl` for this ticket; effective only when the worktree still exists (worktree removal via the first checkbox already covers these logs) |

Both options default to unchecked — canceling without checking anything preserves all artifacts exactly as the basic cancel behavior did before.

The shared `CancelTicketDialog` calls `useCancelTicket`, which POSTs `{ deleteContent, deleteLog }` to `POST /api/tickets/:id/cancel`. The hook invalidates the ticket and ticket-list queries on success.

## Related Docs

- [API Reference](api-reference.md)
- [Configuration](configuration.md)
- [Ticket Flow & State Machine](ticket-flow.md)
- [OpenCode Integration](opencode-integration.md)
- [System Architecture](system-architecture.md)
