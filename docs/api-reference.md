# API Reference

> [!IMPORTANT]
> **TL;DR** — LoopTroop exposes a local REST API for ticket lifecycle actions, artifact access, settings, and real-time SSE streams. The frontend and external tools use this API — there is no separate internal protocol.

All backend routes are mounted under `/api`.

This page documents the current HTTP surface exposed by `server/index.ts` and the route handlers in `server/routes/*`.

## Conventions

| Convention | Meaning |
| --- | --- |
| Ticket identifiers | Ticket route params such as `:id` and `:ticketId` use the public composite ticket ref `projectId:externalId` (for example `1:AUTH-12`), not the project-local numeric DB id |
| JSON validation | Most write routes validate request bodies with Zod or route-specific parsers |
| Streaming | Live ticket updates use Server-Sent Events from `/api/stream` |
| Error shape | Error responses usually include `error` and sometimes `details` or `message` |
| Content hashes | Human-reviewed artifacts expose lowercase SHA-256 hashes so approval requests can prove which bytes were reviewed |
| Action responses | Most workflow action routes return `message`, `ticketId`, `status`, `state`, and the latest `ticket` snapshot |

When `LOOPTROOP_API_TOKEN` is configured, every `/api/*` route requires either `X-LoopTroop-Token: <token>` or `Authorization: Bearer <token>`. The only query-token exception is `/api/stream`, where browser `EventSource` clients may use `apiToken=<token>` because they cannot set custom headers. That query-token path is intentionally stream-only and less secure than header auth because URLs can be logged. `npm run dev` generates an ephemeral token when needed and keeps it server-side; the Vite dev proxy injects it for same-origin `/api` requests.

Invalid or missing credentials return `401`. If auth is required but no backend token is configured and unauthenticated mode is not allowed, the middleware returns `503`.

API routes use a global per-client rate limit, with separate buckets for read requests, normal write actions, and UI-state autosave writes. The default local-tool budget is 200 reads/minute, 120 normal writes/minute, and 300 autosaves/minute per client. The lightweight `GET /api/health` liveness probe is exempt so reachability checks remain available after the normal read budget is exhausted; authentication still applies. When another route exceeds its limit, the backend returns `429` with a JSON error body and a `Retry-After` header containing the number of seconds to wait before retrying. Forwarded client IP headers are ignored unless `LOOPTROOP_TRUST_PROXY=1` is set, so local development typically uses a single shared `local` bucket identity.

## Health, Models, Workflow Meta, And Streaming

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | Basic process health; exempt from the normal read-rate bucket |
| `GET` | `/api/health/opencode` | OpenCode reachability and version |
| `GET` | `/api/health/startup` | Startup recovery and restore status |
| `POST` | `/api/health/startup/restore-notice/dismiss` | Dismiss startup restore notice |
| `GET` | `/api/models` | Models from configured providers; pass `scope=all` to request the full catalog |
| `GET` | `/api/workflow/meta` | Current workflow groups and phases |
| `GET` | `/api/stream?ticketId=<id>` | Ticket-scoped SSE stream using the composite ticket ref; validates the ticket and enforces stream caps |

`/api/stream` also accepts `lastEventId` and, when header auth is not available, `apiToken` query parameters. Browsers normally send `Last-Event-ID` automatically only for native reconnects; the frontend persists the last event id per ticket and sends the query value after reloads so the backend can replay buffered events when possible. The stream route rejects the 7th concurrent client for the same ticket and rejects new streams once the global total reaches 100 active clients.

Example health payload:

```json
{
  "status": "ok",
  "timestamp": "2026-04-23T09:00:00.000Z",
  "uptime": 1234.56
}
```

Example models payload:

```json
{
  "models": [],
  "allModels": [],
  "connectedProviders": [],
  "defaultModels": {},
  "message": "OpenCode server is not reachable. Start it with `opencode serve`."
}
```

## Profile Routes

LoopTroop uses a singleton profile, not a collection.

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/profile` | Returns the singleton profile or `null` |
| `POST` | `/api/profile` | Creates the singleton profile |
| `PATCH` | `/api/profile` | Updates the singleton profile |

`POST /api/profile` returns `409` when the profile already exists. `PATCH /api/profile` returns `404` when no profile has been created yet.

Example profile update payload:

> [!NOTE]
> Timeout and delay fields (`perIterationTimeout`, `executionSetupTimeout`, `councilResponseTimeout`, `opencodeRetryDelay`) are stored and used in **milliseconds**. The values shown below are the current defaults.

```json
{
  "mainImplementer": "openai/gpt-5.4",
  "mainImplementerVariant": "high",
  "councilMembers": "[\"openai/gpt-5.4\",\"anthropic/claude-sonnet-4\"]",
  "councilMemberVariants": "{\"openai/gpt-5.4\": \"high\"}",
  "gitHookPolicy": "validate_explicitly",
  "minCouncilQuorum": 2,
  "perIterationTimeout": 1200000,
  "executionSetupTimeout": 1200000,
  "councilResponseTimeout": 1200000,
  "interviewQuestions": 50,
  "coverageFollowUpBudgetPercent": 20,
  "maxCoveragePasses": 2,
  "maxPrdCoveragePasses": 5,
  "maxBeadsCoveragePasses": 5,
  "structuredRetryCount": 1,
  "maxIterations": 5,
  "opencodeRetryLimit": 10,
  "opencodeRetryDelay": 60000,
  "opencodeSteps": 0,
  "toolInputMaxChars": 4000,
  "toolOutputMaxChars": 12000,
  "toolErrorMaxChars": 6000
}
```

`councilMemberVariants` is a JSON-encoded map of model ID → variant string (e.g. `"high"` or `"low"`) that pins specific effort levels per council member.

`structuredRetryCount` controls automatic structured-output retry prompts after the first invalid or missing structured response. It defaults to `1`, accepts `0` through `5`, and is locked onto each ticket at start; missing locked values on older tickets fall back to the current profile value and then the default.

`opencodeRetryLimit` and `opencodeRetryDelay` control prompt-level OpenCode retry handling for continuable provider interruptions across all phases that use OpenCode. The limit defaults to `10` retry status events and accepts `0` through `50`; the delay defaults to `60000` ms and accepts `0` through `3600000`. Exhaustion of either budget blocks with diagnostics and preserves the active session for Continue when the interruption is resumable.

`opencodeSteps` sets the maximum number of steps OpenCode is allowed to perform per session. When the limit is reached, OpenCode instructs the model to summarize its work and close the session; LoopTroop then starts a fresh session to continue. Defaults to `0` (no limit — OpenCode default), accepts `0` through `500`.

Selected validation ranges that are easy to miss when calling the API directly:

| Field(s) | Accepted values | Notes |
| --- | --- | --- |
| `minCouncilQuorum` | `1` to `6` | Must not exceed the practical council size |
| `interviewQuestions` | `0` to `50` | `0` is accepted, though normal runs typically keep a positive interview budget |
| `coverageFollowUpBudgetPercent` | `0` to `100` | Percentage budget for coverage follow-up questions |
| `maxCoveragePasses` | `1` to `10` | Shared generic coverage loop |
| `maxPrdCoveragePasses`, `maxBeadsCoveragePasses` | `2` to `20` | PRD and beads coverage loops have a stricter lower bound |
| `maxIterations` | `0` to `20` | `0` is allowed for tickets that should not iterate |
| `gitHookPolicy` | `validate_explicitly`, `use_on_internal_commits`, `ignore_internal_only` | Controls LoopTroop-owned commits and pushes; it does not alter repository Git configuration |
| `toolInputMaxChars`, `toolErrorMaxChars` | `500` to `50000` | Applied to OpenCode tool transcript truncation |
| `toolOutputMaxChars` | `1000` to `100000` | Higher lower bound because tool output is usually larger |

## Project Routes

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/projects/check-git?path=...` | Validates git/GitHub origin status and previews existing LoopTroop state for a folder |
| `GET` | `/api/projects/ls?path=...` | Directory browser used by the attach-project flow |
| `GET` | `/api/projects` | List attached projects |
| `GET` | `/api/projects/:id` | Get one project |
| `POST` | `/api/projects` | Attach a project |
| `PATCH` | `/api/projects/:id` | Update project settings |
| `DELETE` | `/api/projects/:id` | Delete a project if no active tickets remain |
| `GET` | `/api/projects/:id/worktrees/size` | Get the total disk size of all worktrees for a project |
| `DELETE` | `/api/projects/:id/worktrees` | Delete worktrees for completed and canceled tickets only, including same-user read-only cache trees; active ticket worktrees are left untouched |

`GET /api/projects/check-git` returns attach-flow metadata in addition to simple validity. When relevant, the response also includes `scope` (`root` or `subfolder`), `repoRoot`, `githubRepoSlug`, `hasLoopTroopState`, `existingProject`, and `performanceWarning` for WSL mounted-drive performance warnings. The `existingProject` preview contains the saved `name`, `shortname`, `icon`, `color`, `ticketCounter`, total `ticketCount`, `activeTicketCount`, `gitHookPolicy`, and `manualQaOverride`. `activeTicketCount` counts statuses other than `DRAFT`, `COMPLETED`, and `CANCELED`. This lets clients show exactly which project settings and ticket data each attachment action keeps or removes before submitting.

Example existing-state preview:

```json
{
  "isGit": true,
  "status": "valid",
  "scope": "root",
  "repoRoot": "/home/liviu/MeiliSearch",
  "githubRepoSlug": "meilisearch/meilisearch",
  "hasLoopTroopState": true,
  "existingProject": {
    "name": "MeiliSearch",
    "shortname": "MESE",
    "icon": "🔎",
    "color": "#a855f7",
    "ticketCounter": 7,
    "ticketCount": 7,
    "activeTicketCount": 2,
    "gitHookPolicy": "validate_explicitly",
    "manualQaOverride": false
  },
  "message": "Existing LoopTroop project found at repository root"
}
```

Example project attachment payload:

```json
{
  "name": "LoopTroop",
  "shortname": "LOOP",
  "folderPath": "/home/liviu/LoopTroop",
  "icon": "📁",
  "color": "#3b82f6",
  "profileId": 1,
  "existingStateAction": "restore"
}
```

When the resolved repository root already contains `.looptroop` project state, `existingStateAction` controls the attachment:

| Value | Behavior |
| --- | --- |
| `restore` | Keeps tickets, workflow/artifact state, ticket counter, saved short name, and project-level overrides. Applies current form edits to visible project settings. |
| `clear_tickets` | Keeps the project row, saved short name, appearance, creation time, profile association, and every project-level override; applies current visible form edits; removes all ticket-linked database state, ticket content, and managed worktrees; then resets `ticketCounter` to `0` and advances the update time. |
| `start_fresh` | Removes managed worktrees and the complete `.looptroop` folder, then creates a new project from the submitted form values. |

The field is optional for API compatibility and defaults to `restore` when existing state is found. All three existing-state paths update the saved `folderPath` to the repository root resolved on the current machine. Destructive modes remove active tickets as well as terminal tickets, but never delete repository source files, commits, or local/remote branches. Because `clear_tickets` resets numbering, its next ticket is `<SHORTNAME>-1`; an old branch retained in the repository can therefore have the same ticket identifier.

Direct attachment/update validation and mutability rules:

| Field | Create | Patch | Notes |
| --- | --- | --- | --- |
| `name` | required | optional | `1` to `100` characters |
| `shortname` | required | not accepted | `3` to `5` uppercase letters or digits |
| `folderPath` | required | not accepted | Must resolve to a git repository; outside tests, the repository must also have a GitHub `origin` |
| `profileId` | optional | not accepted | Attach-time only |
| `icon`, `color` | optional | optional | `color` must be `#RRGGBB` |
| `existingStateAction` | optional | not accepted | Existing state only: `restore`, `clear_tickets`, or `start_fresh`; defaults to `restore` |
| Project overrides listed below | optional | optional | Apply only to future ticket starts |

Create and update routes also accept optional project-level overrides for future tickets in that project:

```json
{
  "councilMembers": "[\"openai/gpt-5.4\",\"anthropic/claude-sonnet-4\"]",
  "gitHookPolicy": "use_on_internal_commits",
  "maxIterations": 7,
  "perIterationTimeout": 1500000,
  "executionSetupTimeout": 1800000,
  "councilResponseTimeout": 1500000,
  "minCouncilQuorum": 2,
  "interviewQuestions": 40
}
```

These fields override the profile baseline only for newly started tickets in that project. Existing tickets keep their locked values.

Worktree size response:

```json
{ "bytes": 1234567 }
```

Worktree delete response:

```json
{ "success": true, "freedBytes": 1234567 }
```

Project deletion (`DELETE /api/projects/:id`) returns 409 when any ticket in the project is not in `DRAFT`, `COMPLETED`, or `CANCELED` status. Finish or cancel all active tickets before deleting the project. Worktree deletion is narrower: it only removes completed and canceled ticket worktrees and leaves active ticket worktrees untouched. Before removal, LoopTroop safely restores owner permissions throughout each managed worktree without following symlinks, allowing cleanup of read-only outputs created by project tooling while preserving targets outside the worktree.

## Ticket Routes

Ticket routes are implemented using a modular handler architecture located in `server/routes/ticketHandlers/*`. This splits the broad ticket API into focused domains:

- `crudHandlers.ts` for lifecycle creation and basic updates
- `artifactHandlers.ts` for artifact retrieval
- `approvalHandlers.ts` for human approval gates
- `uiStateHandlers.ts` for frontend draft persistence
- `executionSetupHandlers.ts` for environment setup plan routes
- `interviewHandlers.ts` for Q&A persistence
- `lifecycleHandlers.ts` for workflow progression
- `devEventHandlers.ts` and `openCodeQuestionHandlers.ts` for advanced integrations

### CRUD And UI State

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/tickets` | Optionally filtered with `?project=` or `?projectId=` |
| `GET` | `/api/tickets/:id` | Get one ticket by composite ticket ref |
| `GET` | `/api/tickets/:id/size` | Recursively measure the ticket worktree and return logs/artifacts/source breakdown; returns `{ "size": 0, "exists": false }` when no worktree exists yet |
| `POST` | `/api/tickets` | Create a ticket; title max 500 characters, description max 10,000 characters, priority `1` through `5`, with optional Manual QA and Git-hook overrides |
| `PATCH` | `/api/tickets/:id` | Update title, description, priority, Manual QA, or Git-hook settings; the two configuration overrides are Draft-only |
| `DELETE` | `/api/tickets/:id` | Only allowed for `COMPLETED` or `CANCELED` |
| `GET` | `/api/tickets/:id/ui-state?scope=...` | Read persisted UI state |
| `PUT` | `/api/tickets/:id/ui-state` | Save persisted UI state |

Example ticket creation payload:

```json
{
  "projectId": 1,
  "title": "Implement refresh-token rotation",
  "description": "Rotate refresh tokens and invalidate the family on reuse.",
  "priority": 2,
  "manualQaOverride": null,
  "gitHookPolicy": "validate_explicitly"
}
```

Create-ticket validation requires a non-empty title up to 500 characters. The optional description is capped at 10,000 characters. `gitHookPolicy` accepts `validate_explicitly`, `ignore_internal_only`, `use_on_internal_commits`, or `null`; `manualQaOverride` accepts a boolean or `null`. Update validation is slightly narrower: patched titles are capped at 200 characters, configuration overrides return `409` outside Draft, and `status` is API-protected so workflow transitions must go through the action routes below.

Before Start, ticket responses expose the stored overrides plus `effectiveGitHookPolicy` / `effectiveGitHookPolicySource` and the equivalent Manual QA effective fields. At Start, LoopTroop freezes `lockedGitHookPolicy` and `lockedGitHookPolicySource` using ticket → project → profile precedence, so later parent-setting changes do not alter that run.

All ticket route params shown as `:id` or `:ticketId` use the composite public ticket ref, such as `1:AUTH-12`. The browser URL uses only the external ticket id (`/ticket/AUTH-12`), but API callers should send the composite ref returned by ticket list/detail payloads.

Ticket list/detail payloads also include `isDisplayOnlyMock`, a boolean UI hint for board-only mock/demo tickets. These tickets keep their raw `externalId` for routing and storage, but clients can use the flag to add display-only markers without parsing reserved branch names. Non-terminal mock/demo tickets expose only the `cancel` action; runnable workflow actions remain hidden and rejected.

Example ticket size response:

```json
{
  "size": 1234567,
  "exists": true,
  "breakdown": {
    "logs": {
      "total": 4096,
      "children": [
        { "name": "execution-log.jsonl", "size": 2048, "isDirectory": false }
      ]
    },
    "artifacts": {
      "total": 8192,
      "children": [
        { "name": "runtime", "size": 8192, "isDirectory": true }
      ]
    },
    "source": {
      "total": 12288,
      "children": [
        { "name": "src", "size": 12288, "isDirectory": true }
      ]
    }
  }
}
```

Example UI-state payload:

```json
{
  "scope": "interview-drafts",
  "expectedRevision": 12,
  "actionId": "autosave:manual-qa-v2:9f5c",
  "data": {
    "draftAnswers": {},
    "skippedQuestions": {},
    "selectedOptions": {}
  }
}
```

Example UI-state response:

```json
{
  "scope": "interview-drafts",
  "exists": true,
  "data": {
    "draftAnswers": {},
    "skippedQuestions": {},
    "selectedOptions": {}
  },
  "updatedAt": "2026-04-23T09:00:00.000Z",
  "revision": 12,
  "clientRevision": 12
}
```

The UI-state channel is server-owned compare-and-set storage. Each mutation supplies an `expectedRevision` and unique `actionId`. Saves are serialized per ticket/scope; an exact revision match increments the server revision, while stale, equal-but-conflicting, or otherwise mismatched writes return `409` with the latest state and revision. Reusing the same action id is idempotent. `clientRevision` remains as a response compatibility alias for `revision`.

UI-state `scope` must match `^[a-zA-Z0-9:_-]+$` and be at most 80 characters. Stored UI-state payloads are capped at 2 MiB. A successful `PUT` returns the incremented revision; a conflict response includes `conflict: true`, the latest `data`, and the current revision so the caller can reconcile before retrying.

Manual QA live drafts use the sole scope `manual_qa_draft:vN`; only evidence metadata/references enter that state. New items initialize as `pending`; Pass and Waive require no evidence, Pass notes and waiver reasons are optional, and the frontend keeps the five-second debounce plus keepalive flush on `pagehide`/`beforeunload`. There is no separate manual-save endpoint: the workspace derives its relative last-save indicator and exact hover timestamp from the successful UI-state response.

### Manual QA Routes

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/tickets/:id/manual-qa` | Round index/current projection: active version plus structured per-version artifact availability, outcome/status, completion time, and matching phase attempt |
| `GET` | `/api/tickets/:id/manual-qa/versions/:version` | Checklist, coverage, results, summary, evidence metadata, hash, read-only state, and any resumable `{ actionId, operationType, state }` journal |
| `PUT` | `/api/tickets/:id/manual-qa/versions/:version/evidence?itemId=...` | Stream one evidence file; filename/media metadata use headers/query fields; 250 MiB per-file limit |
| `GET` | `/api/tickets/:id/manual-qa/versions/:version/evidence/:itemId/:evidenceId` | Secure read/download; `?inline=true` works only for safe raster media types |
| `DELETE` | `/api/tickets/:id/manual-qa/versions/:version/evidence/:itemId/:evidenceId` | Remove one evidence file and metadata record while waiting |
| `POST` | `/api/tickets/:id/manual-qa/submit` | Validate the round; for failures require read-only repository inspection and persist a complete `fix-beads.yaml` candidate before idempotently creating configured improvements and normal QA-fix beads |
| `POST` | `/api/tickets/:id/manual-qa/skip` | Bypass ordinary result/observation/group completeness validation, preserve all entered data plus an optional reason as an immutable draft, create no drafted work, then integrate |
| `POST` | `/api/tickets/:id/manual-qa/workspace-drift/include` | Commit only the selected audited drift files into the QA checkpoint |
| `POST` | `/api/tickets/:id/manual-qa/workspace-drift/discard` | Discard only the selected audited drift files |

Evidence upload/remove calls carry `X-Action-Id`, `X-Checklist-Hash`, and `X-Draft-Revision` (query/body equivalents are supported). The raw upload body is streamed; `X-Checklist-Item-Id`, `X-File-Name`, and optional stable `X-Evidence-Id` identify it. The client publishes a successful upload into the active item immediately and initially discloses five evidence entries, with the rest controlled locally by Show more/Show less. HTTP(S) link evidence is created on demand from separate Link and Details fields rather than from a default blank row.

Submit, skip, and drift decisions carry `actionId`, `expectedChecklistHash`, and `expectedDraftRevision` in JSON. Improvement drafts also carry priority `1–5` and an explicit Manual QA enabled/disabled snapshot. Submit validation permits multi-select merge-group drafts to refer to any checklist item while editing, but returns item number/title diagnostics if a selected member is not Fail. For failures, model/tool/parser errors occur before any child side effect and route to `BLOCKED_ERROR`; Retry resumes the same journal action. Evidence uploads/removals must settle before Submit or Skip. On Submit, the durable evidence index is canonical: stored files and their metadata are retained, dangling optional IDs are omitted, and known cross-item references remain integrity errors that identify both checklist items and the original filename without exposing internal evidence IDs. Skip intentionally ignores incomplete result-specific fields and group membership because it creates neither fix beads nor Improvement tickets; it still archives the entered draft read-only. Action IDs use the strict workflow identifier grammar and are rejected before any reservation or filesystem mutation. Mutations are allowed only during `WAITING_MANUAL_QA` and return `409` for stale guards or detected workspace drift. Interrupted Submit/Skip calls must resume the journal's same action and operation type. The client retains upload, removal, and drift action/evidence identities until confirmation, but refreshes the checklist/revision CAS guards on every retry. Ambiguous failures refetch the round, and failed uploads retain the exact selected `File` in an explicit retry state; the server uses the stable identities to reconcile contained file/index/receipt windows without duplicate effects.

Only PNG, JPEG, GIF, WebP, and AVIF may be served inline. SVG, HTML, executable/unknown content, and all other files are sent with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and `Cache-Control: private, no-store`. Evidence links in results accept HTTP or HTTPS only.

Ticket projections expose `visitedStatuses`, monotonic `workflowRevision`, and `manualQa`. The Manual QA projection distinguishes reservations from checklist-backed versions and maps each available version to its phase attempt, so clients never request an unavailable active reservation and can bind historical artifacts and logs to the same version. These fields also let SSE and polling clients reconcile a deliberate reverse transition (`WAITING_MANUAL_QA → CODING`) without comparing status positions in a linear list.

### Workflow Actions

| Method | Route | Notes |
| --- | --- | --- |
| `POST` | `/api/tickets/:id/start` | Starts a `DRAFT` ticket using locked profile and project settings |
| `POST` | `/api/tickets/:id/approve` | Generic workflow approval endpoint |
| `POST` | `/api/tickets/:id/cancel` | Cancel active work — accepts an optional JSON body (see below) |
| `POST` | `/api/tickets/:id/approve-interview` | Approve interview artifact |
| `POST` | `/api/tickets/:id/approve-prd` | Approve PRD artifact |
| `POST` | `/api/tickets/:id/approve-beads` | Approve bead plan artifact |
| `POST` | `/api/tickets/:id/approve-execution-setup-plan` | Approve execution setup plan |
| `POST` | `/api/tickets/:id/edit-execution-setup-plan` | After UI confirmation, rewind a blocked workspace runtime setup to setup-plan approval |
| `POST` | `/api/tickets/:id/coverage/fix-gaps` | Run one approval-screen extra fix for unresolved PRD or beads coverage gaps |
| `POST` | `/api/tickets/:id/merge` | Merge delivered PR |
| `POST` | `/api/tickets/:id/close-unmerged` | Close without merge |
| `POST` | `/api/tickets/:id/verify` | Alias for the merge handler — both routes call the same handler |
| `POST` | `/api/tickets/:id/retry` | Retry a blocked ticket or failed phase; an optional `{ "note": "..." }` body adds CODING bead guidance or sends one direct message to a preserved execution setup session |
| `POST` | `/api/tickets/:id/continue` | Continue a blocked ticket only when eligible OpenCode/provider diagnostics, including `HTTP 402 Payment Required`, have a matching active preserved OpenCode session |
| `POST` | `/api/tickets/:id/dev-event` | Disabled by default; requires `LOOPTROOP_ENABLE_DEV_EVENT=1`, `LOOPTROOP_DEV_EVENT_TOKEN`, and `X-LoopTroop-Dev-Event-Token` |

All approval routes, including the generic `/approve` route, require the hash of the content currently shown to the user:

```json
{
  "expectedContentSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

Malformed or missing hashes return `400`. If the current server artifact no longer matches the expected hash, the route returns `409` and leaves the workflow paused:

```json
{
  "error": "Stale approval",
  "artifactType": "prd",
  "expectedContentSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "currentContentSha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
}
```

Successful approvals write durable `approval_receipt` phase artifacts. Approval snapshots and receipts include `content_sha256`; interview and PRD receipts also include `stored_content_sha256` when approval stamping changes the persisted YAML.

`POST /api/tickets/:id/coverage/fix-gaps` accepts `{ "domain": "prd" }` only while the ticket is in `WAITING_PRD_APPROVAL`, or `{ "domain": "beads" }` only while the ticket is in `WAITING_BEADS_APPROVAL`. The server reloads the latest coverage artifact and source artifacts before prompting, ignores stale browser gap text, runs exactly one fresh targeted fix attempt followed by one fresh coverage check, and returns the updated result. Concurrent fix attempts for the same ticket/domain return `409`, and approval routes also return `409` while a matching fix is in progress. If no gaps remain, the route returns a no-op success.

Most action routes in this section respond with the latest machine snapshot so callers can refresh local state without making an immediate follow-up read:

```json
{
  "message": "Start action accepted",
  "ticketId": "1:AUTH-12",
  "status": "SCANNING_RELEVANT_FILES",
  "state": "SCANNING_RELEVANT_FILES",
  "ticket": {
    "id": "1:AUTH-12",
    "status": "SCANNING_RELEVANT_FILES"
  }
}
```

The Continue endpoint is available only from `BLOCKED_ERROR`. It requires a known `previousStatus`, an unresolved active error occurrence with a diagnostic `sessionId`, a matching active `opencode_sessions` row for that ticket and previous phase, and an OpenCode session that is still addressable by that exact id. It returns `409` and leaves the ticket blocked when those checks fail. On success it dispatches `CONTINUE`, records the pending session continuation, and the next owned prompt sends exactly `continue please` without creating a fresh phase attempt.

The Retry endpoint accepts an empty body for ordinary recovery. It also accepts the following body when the ticket is currently in `BLOCKED_ERROR` with `previousStatus: "CODING"` or `previousStatus: "PREPARING_EXECUTION_ENV"`:

```json
{
  "note": "Check the migration ordering before rerunning the focused tests."
}
```

`note` must contain at least one non-whitespace character and must not exceed 20,000 characters. For coding, LoopTroop first proves it can reset the same failed or paused bead, then appends a structured `userRetryNotes` entry containing the ISO timestamp, iteration, and the user's text unchanged. This keeps the existing fresh-bead recovery behavior.

For execution setup, the request requires the preserved `PREPARING_EXECUTION_ENV` OpenCode session. LoopTroop sends only the user's text as the next prompt in that session and allows exactly one manual setup attempt beyond the configured automatic retry budget. The current runtime phase attempt is not archived, and the text is not appended to `execution_setup_notes` or reused as future setup context. If the session cannot be resumed or the manual attempt cannot start, the ticket remains blocked. Note-bearing requests for historical errors, other phases, blank notes, or oversized notes are rejected. Omitting `note` preserves ordinary Retry behavior.

`POST /api/tickets/:id/edit-execution-setup-plan` is available only for the live `BLOCKED_ERROR` whose `previousStatus` is `PREPARING_EXECUTION_ENV`. The UI opens a confirmation dialog before calling it. Once confirmed, the route archives the failed runtime attempt, preserves it in phase history, and returns the ticket to `WAITING_EXECUTION_SETUP_APPROVAL` with the current plan available for editing or regeneration. Other phases and historical error occurrences return `409`.

Bead API/read-model payloads expose three independent append-only arrays: `failedIterationNotes`, `userRetryNotes`, and `finalizationFailureNotes`. Each entry contains `timestamp`, `iteration`, `content`, and optional `errorCode`. Runtime bead overlays also expose the original `startedAt` and the current attempt's `updatedAt`, which is the live countdown anchor. LoopTroop strips ANSI terminal sequences from machine-generated failed-iteration and finalization content; user retry content is preserved exactly.

Final-test file effects no longer expose include/discard recovery endpoints. The audit preserves explicit candidate intent and tracked or staged changes, keeps recognized untracked generated/cache/setup-local outputs on disk as local-only, and retries classification once for unknown untracked files. Files that remain undeclared are excluded with a warning so unattended delivery can continue; unresolved tracked changes remain candidates for the later PR audit.

The cancel endpoint accepts an optional JSON request body to trigger cleanup or complete deletion at cancellation time.

```json
{
  "deleteContent": false,
  "deleteLog": false,
  "deleteTicket": false
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `deleteContent` | `boolean` | `false` | Permanently removes all AI-generated artifacts (interview Q&A, PRD drafts, beads plan) from the database and deletes the isolated git worktree and its branch |
| `deleteLog` | `boolean` | `false` | Permanently removes the execution log files (`.ticket/runtime/execution-log.jsonl`, `.ticket/runtime/execution-log.debug.jsonl`, and `.ticket/runtime/execution-log.ai.jsonl`) for this ticket. This is only effective when the worktree still exists; if `deleteContent` is also `true` the worktree removal already covers the logs |
| `deleteTicket` | `boolean` | `false` | Permanently deletes the ticket record from the database and removes all related files (equivalent to the DELETE ticket action once canceled) |

### Interview And Planning Editing

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/tickets/:id/interview` | Returns interview payload with `winnerId`, `raw`, `document`, `session`, and `questions` |
| `PUT` | `/api/tickets/:id/interview` | Save raw interview YAML |
| `PUT` | `/api/tickets/:id/interview-answers` | Save structured interview answers during approval or planning restart |
| `POST` | `/api/tickets/:id/answer` | Deprecated, returns `410`; use `answer-batch` |
| `POST` | `/api/tickets/:id/answer-batch` | Submit interview answers |
| `POST` | `/api/tickets/:id/skip` | Skip remaining interview questions |
| `PATCH` | `/api/tickets/:id/edit-answer` | Edit a previously recorded answer while waiting for interview answers |

Interview responses include `contentSha256` for the reviewed raw interview bytes. PRD file responses from `/api/files/:ticketId/prd` include `contentSha256` for the returned file content.

`POST /api/tickets/:id/skip` accepts the same body shape as `answer-batch`, so the client can persist already entered answers before skipping the remaining questions.

Interview and PRD approval edits are planning-only. After approval, saving an interview edit is allowed while the ticket is still before `PRE_FLIGHT_CHECK`; if PRD or beads planning already exists, LoopTroop archives the current approved interview version and downstream PRD/beads phase attempts, cancels active downstream sessions as intentional cancellation, clears stale downstream artifacts and approval UI state, writes a `user_edit_receipt:interview` artifact, saves and approves the edited interview as the new active version, and starts `DRAFTING_PRD`. Saving a PRD edit follows the same contract for the current approved PRD version and downstream beads attempts, writes `user_edit_receipt:prd`, then starts `DRAFTING_BEADS`.

Archived versions are read-only approved planning generations backed by phase attempts. Once a ticket reaches `PRE_FLIGHT_CHECK` or any later execution-band status, interview and PRD edit saves return `409`. Intentional downstream session aborts during these planning restarts are cancellation, not blocked errors, and existing tickets/projects such as `PCKM-22` are not migrated or repaired.

Current batch-answer payload:

```json
{
  "answers": {
    "q-auth-1": "Support both password login and SSO."
  },
  "selectedOptions": {
    "q-auth-2": ["option-password", "option-sso"]
  }
}
```

Possible `answer-batch` response shapes:

`202 { "accepted": true }` means the user answers were accepted and asynchronous AI processing is continuing in the background. A non-complete batch response keeps the ticket in `WAITING_INTERVIEW_ANSWERS` with another batch to answer. When `isComplete` is `true`, the backend dispatches interview completion and the workflow advances to coverage.

```json
{
  "accepted": true
}
```

```json
{
  "questions": [
    {
      "id": "q-auth-3",
      "question": "What session lifetime should SSO tokens use?",
      "type": "free_text"
    }
  ],
  "progress": {
    "current": 4,
    "total": 8
  },
  "isComplete": false,
  "isFinalFreeForm": false,
  "aiCommentary": "Need one more clarification about session lifetime.",
  "batchNumber": 2,
  "source": "coverage",
  "roundNumber": 1
}
```

Structured interview-answer approval payload:

```json
{
  "questions": [
    {
      "id": "q-auth-1",
      "answer": {
        "skipped": false,
        "selected_option_ids": [],
        "free_text": "Support password login and SSO."
      }
    }
  ]
}
```

Edit-answer payload:

```json
{
  "questionId": "q-auth-1",
  "answer": "Support password login and SSO."
}
```

### Execution Setup Plan Routes

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/tickets/:id/execution-setup-plan` | Read the current setup plan |
| `POST` | `/api/tickets/:id/edit-execution-setup-plan` | Return a blocked workspace runtime setup to setup-plan approval |
| `PUT` | `/api/tickets/:id/execution-setup-plan` | Save setup plan as raw content or structured plan |
| `POST` | `/api/tickets/:id/regenerate-execution-setup-plan` | Regenerate the plan with commentary |

Execution setup plan read response:

```json
{
  "exists": true,
  "artifactId": 42,
  "updatedAt": "2026-04-23T09:00:00.000Z",
  "contentSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "raw": "{\"schemaVersion\":1,\"ticketId\":\"AUTH-12\",\"artifact\":\"execution_setup_plan\",\"status\":\"draft\",\"summary\":\"Prepare the workspace before implementation.\"}",
  "plan": {
    "schemaVersion": 1,
    "ticketId": "AUTH-12",
    "artifact": "execution_setup_plan",
    "status": "draft",
    "summary": "Prepare the workspace before implementation.",
    "readiness": {
      "status": "ready",
      "actionsRequired": false,
      "evidence": ["Dependencies are already installed."],
      "gaps": []
    },
    "tempRoots": [".looptroop/worktrees/AUTH-12"],
    "workspaceInputs": [],
    "workspaceProbes": [
      {
        "id": "workspace-test",
        "command": "npm test -- --runInBand",
        "purpose": "Prove the repository test runner can load the project."
      }
    ],
    "gitHooks": {
      "policy": "validate_explicitly",
      "detected": [
        {
          "name": "pre-commit",
          "path": ".husky/pre-commit",
          "source": "core.hooksPath",
          "executable": true,
          "managerHint": "husky"
        }
      ],
      "validationCommands": []
    },
    "steps": [
      {
        "id": "setup-1",
        "title": "Install dependencies",
        "purpose": "Ensure commands run with the expected packages.",
        "commands": ["npm install"],
        "required": true,
        "rationale": "The project uses npm scripts for verification.",
        "cautions": ["Do not update unrelated dependencies."]
      }
    ],
    "projectCommands": {
      "prepare": ["npm install"],
      "testFull": ["npm test"],
      "lintFull": ["npm run lint"],
      "typecheckFull": ["npm run typecheck"]
    },
    "qualityGatePolicy": {
      "tests": "Run targeted tests first, then the full suite before handoff.",
      "lint": "Run the project linter after code changes.",
      "typecheck": "Run TypeScript typecheck after code changes.",
      "fullProjectFallback": "If targeted checks are inconclusive, run all required project checks."
    },
    "cautions": ["Keep generated artifacts out of source control."]
  }
}
```

Execution setup plan reads may select archived versions with `phaseAttempt`. Archived reads stay available, but explicit writes to non-current phase attempts return `409` because archived versions are read-only. Invalid `phaseAttempt` values return `400`. Successful manual saves write `user_edit_receipt:execution_setup_plan`.

Successful `PUT /execution-setup-plan` responses return the saved `raw`, normalized `plan`, `contentSha256`, and current route state (`status`, `state`, `ticket`) so the client does not need an immediate follow-up fetch.

`workspaceInputs`, `workspaceProbes`, and `gitHooks.validationCommands` are ordered editable lists. Each workspace input contains `path`, `kind`, `sourceStatus`, and `reason`; the server checks it against the original checkout before accepting the plan. `gitHooks.detected` is refreshed from repository/Git evidence and cannot be changed through the plan editor. An empty validation-command list is valid; no waiver field or secondary confirmation is required.

`PUT /execution-setup-plan` and `POST /regenerate-execution-setup-plan` are normally accepted only while the ticket is in `WAITING_EXECUTION_SETUP_APPROVAL`. They are also accepted from `PREPARING_EXECUTION_ENV` as a one-step runtime rewind: LoopTroop stops active runtime setup, archives the approved setup-plan attempt and current runtime attempt with `execution_setup_runtime_rewind`, clears stale setup profile/runtime outputs while preserving `.ticket/runtime/execution-setup/tool-cache`, returns the ticket to `WAITING_EXECUTION_SETUP_APPROVAL`, and requires approval again. During that route-driven rewind, the restored approval actor does not auto-draft from the empty fresh attempt; manual edits save the supplied plan, and regenerate starts only the requested commented generation. `POST /regenerate-execution-setup-plan` returns immediately after scheduling background regeneration; the new draft then arrives through normal artifact/log/SSE updates. These routes still reject from `CODING` and later statuses.

Regeneration payload:

```json
{
  "commentary": "Tighten the temp-root cleanup steps and add the full lint command.",
  "plan": {
    "schemaVersion": 1,
    "ticketId": "AUTH-12",
    "artifact": "execution_setup_plan",
    "status": "draft",
    "summary": "Prepare the workspace before implementation.",
    "readiness": {
      "status": "ready",
      "actionsRequired": false,
      "evidence": [],
      "gaps": []
    },
    "tempRoots": [],
    "workspaceInputs": [],
    "steps": [],
    "projectCommands": {
      "prepare": [],
      "testFull": ["npm test"],
      "lintFull": ["npm run lint"],
      "typecheckFull": ["npm run typecheck"]
    },
    "qualityGatePolicy": {
      "tests": "Run full tests before handoff.",
      "lint": "Run lint before handoff.",
      "typecheck": "Run typecheck before handoff.",
      "fullProjectFallback": "Run all required project checks when unsure."
    },
    "cautions": []
  }
}
```

### OpenCode Question Routes

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/opencode/questions` | Aggregate pending OpenCode question requests across active tickets |
| `GET` | `/api/tickets/:id/opencode/questions` | List pending OpenCode question requests |
| `POST` | `/api/tickets/:id/opencode/questions/:requestId/reply` | Submit question answers |
| `POST` | `/api/tickets/:id/opencode/questions/:requestId/reject` | Reject a question request |

List responses return `{ "questions": [...] }`, and the aggregate route may also include `{ "errors": [...] }` when some tickets fail question discovery.

Reply payload:

```json
{
  "answers": [
    ["yes"],
    ["postgres", "redis"]
  ]
}
```

The outer `answers` array must stay in the same order as the returned `questions` array for that request. Each inner array carries the answer values for one question, which lets multi-select prompts submit more than one string.

### Artifact And History Routes

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/tickets/:id/artifacts` | List ticket artifacts, optionally filtered |
| `GET` | `/api/tickets/:id/artifacts/manifest` | List lightweight artifact metadata and previews without artifact bodies |
| `GET` | `/api/tickets/:id/artifacts/:artifactId/content` | Read one ticket-isolated artifact body; supports SHA-256 ETags and `304 Not Modified` |
| `POST` | `/api/tickets/:id/artifacts/content/batch` | Read up to 20 artifact bodies, capped at approximately 2 MB of content per response |
| `GET` | `/api/tickets/:id/phases/:phase/attempts` | List phase attempt history |

`GET /api/tickets/:id/artifacts` accepts optional `phase` and `phaseAttempt` query filters. When `phaseAttempt` is omitted, the backend resolves the current active attempt for that phase; supplying `phaseAttempt=1` is how clients intentionally read archived planning generations after an edit/retry/regenerate flow.

The manifest route accepts the same filters and returns `{ "artifacts": [...] }`. Every entry includes its identity, phase and attempt, type, timestamps, `contentByteCount`, lowercase `contentSha256`, availability, and a compact scalar preview. It never includes the raw artifact body. Fetch bodies from the content routes after selecting the artifact; batch requests use `{ "artifactIds": [1, 2] }` and return unavailable or byte-budget-deferred IDs in `omittedIds`.

Example artifact list item:

```json
{
  "id": 84,
  "ticketId": "1:AUTH-12",
  "phase": "WAITING_PRD_APPROVAL",
  "phaseAttempt": 1,
  "artifactType": "approval_receipt",
  "filePath": null,
  "content": "{\"content_sha256\":\"...\"}",
  "createdAt": "2026-04-23T09:00:00.000Z",
  "updatedAt": "2026-04-23T09:00:00.000Z"
}
```

Example phase-attempt list item:

```json
{
  "ticketId": "1:AUTH-12",
  "phase": "WAITING_PRD_APPROVAL",
  "attemptNumber": 2,
  "state": "active",
  "archivedReason": null,
  "createdAt": "2026-04-23T09:00:00.000Z",
  "archivedAt": null
}
```

Ticket list and detail responses include a cleanup summary derived from the latest `cleanup_report` artifact:

```json
{
  "cleanup": {
    "status": "warning",
    "errorCount": 2,
    "latestReportArtifactId": 123
  }
}
```

`cleanup.status` is `clean`, `warning`, or `null`. Cleanup warnings do not change the ticket's terminal `COMPLETED` status.

## File Routes

These routes are intentionally narrow.

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/files/:ticketId/logs` | Read folded normal execution logs from `.ticket/runtime/execution-log.jsonl` |
| `GET` | `/api/files/:ticketId/logs?channel=debug` | Read folded debug/forensic execution logs from `.ticket/runtime/execution-log.debug.jsonl`; the same `status`, `phase`, and `phaseAttempt` filters apply |
| `GET` | `/api/files/:ticketId/logs?channel=ai` | Read folded AI detail logs from `.ticket/runtime/execution-log.ai.jsonl`; loaded by AI/model log views |
| `GET` | `/api/files/:ticketId/logs?channel=all` | Merge all three LoopTroop log files plus OpenCode native server log lines filtered by the ticket's session IDs; used by the DEBUG tab to show every log line |
| `GET` | `/api/files/:ticketId/:file` | Only `interview` or `prd`; returns `{ content, exists }` and adds `contentSha256` when the file exists |
| `PUT` | `/api/files/:ticketId/:file` | Only `interview` or `prd`; delegates to the dedicated interview/PRD save handlers rather than exposing a generic file write route |
| `POST` | `/api/files/open-path` | Reveal a file or folder in the user's native file explorer; file paths open their containing folder |

Log routes accept optional `status`, `phase`, and `phaseAttempt` filters. The same filters apply to the default normal log channel, `channel=debug`, and `channel=ai`. The `channel=all` endpoint merges and deduplicates entries from all channels server-side, then sorts by timestamp; phase/status filters still apply to LoopTroop log entries but OpenCode native log entries (which have no ticket phase) are always included. Matching completed log entries are returned from the durable log files without an entry-count cap; streaming partial upserts are folded so the UI receives the latest completed or current streaming row for each stable entry. Live `log` and `state_change` SSE payloads carry the resolved `phaseAttempt` used for the durable JSONL row so active multi-attempt phase views can keep streaming while filtering to the selected attempt.

When `GET /api/files/:ticketId/:file` cannot find the requested artifact file, it returns:

```json
{
  "content": "",
  "exists": false
}
```

`POST /api/files/open-path` expects:

```json
{
  "path": "/absolute/path/to/file-or-folder"
}
```

On success it returns `{ "success": true }`. LoopTroop resolves file paths to their containing directory before opening the native explorer, and the implementation supports Windows, macOS, Linux, and WSL.

There is no generic filesystem browser or arbitrary file read route under `/api/files`.

## Bead Routes

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/tickets/:id/beads` | Read bead plan; accepts optional safe relative `?flow=` |
| `PUT` | `/api/tickets/:id/beads` | Replace bead plan only while the ticket is in `WAITING_BEADS_APPROVAL`; accepts optional safe relative `?flow=` |
| `GET` | `/api/tickets/:id/beads/:beadId/diff` | Read diff artifact for a bead |

The `flow` value must be a safe relative branch/flow name. Absolute paths, backslashes, `.` segments, and `..` traversal segments are rejected. When `flow` is omitted, the route falls back to the ticket's base branch. Bead reads and writes expose the canonical plan hash through the `X-Content-Sha256` response header; even an empty plan returns `[]` with the hash of the empty content. Manual bead edits write `user_edit_receipt:beads` and invalidate the execution setup plan. `GET /api/tickets/:id/beads/:beadId/diff` returns `{ "diff": "", "captured": false }` when no diff artifact exists yet.

## SSE Events

The stream endpoint emits two categories of events:

**Stream lifecycle events** — sent directly by the stream handler on connection and periodically, not through the broadcaster:

- `connected` — emitted once when the SSE connection is established
- `heartbeat` — emitted every 30 seconds to keep the connection alive

**Typed ticket events** — broadcast through `server/sse/broadcaster.ts` and defined in `server/sse/eventTypes.ts`:

| Event type | When emitted | Key payload fields |
| --- | --- | --- |
| `state_change` | Ticket transitions between workflow phases | `ticketId`, `from`, `to`, `phaseAttempt`, `previousStatus` |
| `log` | A new execution log entry is written | flat `LogEvent` fields: `ticketId`, `type`, `content`, `kind`, `op`, `phase`, `entryId`, … (no `logEntry` wrapper) |
| `bead_complete` | A single bead finishes execution | `ticketId`, `beadId`, `title`, `completed`, `total` |
| `needs_input` | A pending question or interview batch needs the user | `ticketId`, `type`, plus a shape that varies by source (interview batch: `batch`; OpenCode question: `requestId`, `questions`, `answers`, `tool`, …) |
| `artifact_change` | A phase artifact is created or updated | `ticketId`, `phase`, `artifactType`, `artifact` |

> The `SSEEventType` union in `server/sse/eventTypes.ts` also declares `progress` and `app_error`, but no broadcaster call site emits them today. They are reserved type slots, not live events — runtime errors surface as `log` entries (`kind: 'error'`) instead.

SSE replay is an optimization, not the only recovery path. After a reconnect with a remembered event id, the frontend also invalidates the ticket, list, artifacts, interview, setup-plan, bead, and server-log queries so missed events outside the replay buffer are reconciled from durable storage.

Example `state_change` event payload:

```json
{
  "ticketId": "AUTH-12",
  "from": "DRAFTING_PRD",
  "to": "WAITING_PRD_APPROVAL",
  "phaseAttempt": 1,
  "previousStatus": "VERIFYING_PRD_COVERAGE",
  "timestamp": "2026-04-23T09:00:00.000Z"
}
```

Example `bead_complete` event payload:

```json
{
  "ticketId": "AUTH-12",
  "beadId": "session-store-foundation",
  "title": "Session store foundation",
  "completed": 3,
  "total": 8
}
```

Example `log` event payload (flat `LogEvent`, no wrapper):

```json
{
  "ticketId": "AUTH-12",
  "type": "session",
  "kind": "session",
  "op": "append",
  "phase": "CODING",
  "entryId": "log-1742839200-001",
  "content": "Bead session-store-foundation started (iteration 1)"
}
```

Example `artifact_change` event payload:

```json
{
  "ticketId": "AUTH-12",
  "phase": "CODING",
  "artifactType": "bead_diff:api-refresh-endpoint",
  "artifact": {
    "id": 84,
    "ticketId": "AUTH-12",
    "phase": "CODING",
    "phaseAttempt": 1,
    "artifactType": "bead_diff:api-refresh-endpoint",
    "filePath": null,
    "content": "diff --git a/server/routes/auth.ts b/server/routes/auth.ts\n...",
    "createdAt": "2026-04-23T09:00:00.000Z",
    "updatedAt": "2026-04-23T09:00:00.000Z"
  },
  "timestamp": "2026-04-23T09:00:00.000Z"
}
```

## Related Docs

- [Frontend](frontend.md)
- [OpenCode Integration](opencode-integration.md)
- [Ticket Flow & State Machine](ticket-flow.md)
- [System Architecture](system-architecture.md)
