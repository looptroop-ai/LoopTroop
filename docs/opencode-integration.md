# OpenCode Integration

> [!IMPORTANT]
> **TL;DR** — OpenCode is LoopTroop's only interface to AI models. LoopTroop creates and owns sessions, assembles phase-specific prompt context, applies tool policy, streams and normalizes events, and decides when retries or human recovery are required. It never calls model providers directly.

LoopTroop uses OpenCode as the model-execution layer, but it wraps that layer heavily so ticket state, retries, approvals, and recovery remain durable outside any one model transcript.

At runtime, LoopTroop chooses exactly one adapter: the real SDK adapter for a live OpenCode server, or the in-process mock adapter for tests and offline development.

## 1. Core Modules

| Area | Modules | Responsibility |
| --- | --- | --- |
| Adapter bootstrap | `server/opencode/adapter.ts`, `factory.ts`, `mockAdapter.ts`, `runtimeConfig.ts`, `types.ts` | Select SDK vs mock mode, resolve the base URL, attach auth headers, and expose the typed OpenCode surface |
| Session lifecycle | `server/opencode/sessionCreation.ts`, `sessionManager.ts`, `sessionContinuation.ts`, `permissions.ts` | Retry session creation, persist ownership in the project DB, manage reconnect/completion/abandonment, and decide whether Continue may reuse a preserved session |
| Prompt execution | `server/opencode/contextBuilder.ts`, `toolPolicy.ts`, `assistantMessageAnalysis.ts`, `server/workflow/runOpenCodePrompt.ts` | Build phase context, apply tool restrictions, stream prompt events, reconcile streamed output with durable assistant messages, and produce attempt metadata |
| Catalog and selection | `server/opencode/providerCatalog.ts`, `modelValidation.ts` | Discover OpenCode models, normalize provider-catalog responses, and validate saved model selections against connected providers |
| Diagnostics and recovery | `server/opencode/retryPolicy.ts`, `errorDetails.ts`, `blockedErrorDiagnostics.ts`, `logDiagnostics.ts` | Classify retryable interruptions, sanitize provider errors, enrich generic failures from local OpenCode logs, and surface blocked-error diagnostics to the UI |

## 2. Adapter Surface

The `OpenCodeAdapter` interface currently exposes:

| Method | Purpose |
| --- | --- |
| `createSession()` | Create a new OpenCode session for a project path |
| `promptSession()` | Send prompt parts into an existing session |
| `getSession()` | Verify and read one remote session by exact id |
| `listSessions()` | Enumerate remote sessions |
| `getSessionMessages()` | Read session message history |
| `subscribeToEvents()` | Stream OpenCode events |
| `listPendingQuestions()` | Read pending human-input requests |
| `replyQuestion()` | Answer a pending request |
| `rejectQuestion()` | Reject a pending request |
| `abortSession()` | Abort a remote session |
| `assembleBeadContext()` | Build bead-context prompt parts |
| `assembleCouncilContext()` | Build council prompt parts |
| `checkHealth()` | Health and availability check |

`getOpenCodeAdapter()` returns a singleton. In normal mode it uses `@opencode-ai/sdk/v2`; in mock mode it returns `MockOpenCodeAdapter`, which also supplies a mock health result and provider catalog for the rest of the app.

The SDK adapter automatically adds a Basic auth header when `OPENCODE_SERVER_PASSWORD` is configured. Prompt dispatch also passes OpenCode prompt options such as `model`, `agent`, `variant`, `tools`, and `stepFinishSafetyMs`.

Session creation, exact session lookup, session listing, and message reads accept `AbortSignal`s and are wrapped with bounded SDK-operation timeouts. Session creation also runs through a shared retry wrapper: after the initial failure, LoopTroop waits 1 s, 3 s, and 7 s before the three retry attempts. Each failed create attempt collects lightweight OpenCode health diagnostics, but the health probe is diagnostic-only and never replaces the actual session-create result.

LoopTroop creates sessions with a session-scoped allow-all permission rule. If the connected OpenCode server is too old to support session-scoped permissions, session creation fails with an explicit upgrade message instead of silently degrading behavior.

## 3. Base URL And Modes

| Setting | Meaning |
| --- | --- |
| `LOOPTROOP_OPENCODE_BASE_URL` | Base URL for the OpenCode server; defaults to `http://127.0.0.1:4096` |
| `LOOPTROOP_OPENCODE_MODE=mock` | Use the mock adapter instead of the SDK adapter |
| `LOOPTROOP_OPENCODE_PERMISSION_MODE=inherit` | Do not override the OpenCode server permission mode during `npm run dev`; by default LoopTroop starts its managed OpenCode server with `OPENCODE_PERMISSION='"allow"'` |
| `LOOPTROOP_OPENCODE_LOGS=all` | Direct watcher fallback that starts managed OpenCode with `--print-logs --log-level DEBUG` when `npm run dev:opencode` actually launches the server |
| `LOOPTROOP_OPENCODE_LOG_DIR` | Optional OpenCode log directory used to enrich generic provider errors from an external or nonstandard OpenCode server |
| `OPENCODE_SERVER_USERNAME` | Basic auth username for requests to the local OpenCode server; defaults to `opencode` |
| `OPENCODE_SERVER_PASSWORD` | Basic auth password for requests to the local OpenCode server; `npm run dev` auto-generates an ephemeral credential if not set |

Both the LoopTroop backend and the OpenCode process must share the same credentials. `npm run dev` handles this automatically by propagating the generated credential to all child processes. To use a persistent credential, set `OPENCODE_SERVER_PASSWORD` (and optionally `OPENCODE_SERVER_USERNAME`) before running `npm run dev`.

Base-URL resolution depends on the mode:

- **Loopback URL:** `npm run dev` probes the configured address first. If OpenCode is already responding there, LoopTroop reuses that instance.
- **Default local URL with a conflicting non-OpenCode process:** LoopTroop scans for the next available port and starts managed OpenCode there instead.
- **Explicit local URL:** the configured port is treated as authoritative. If a different process is occupying it, startup fails instead of silently moving to another port.
- **Remote URL:** the launcher treats the server as external and never tries to start or port-shift it.
- **Mock mode:** no network probe happens at all.

## 4. OpenCode Configuration Pass-Through

LoopTroop sends work through your OpenCode server rather than replacing OpenCode's provider layer.

| Layer | Owned by | Notes |
| --- | --- | --- |
| Provider credentials, MCP tools, skills, and server configuration | OpenCode | Whatever you configured in OpenCode remains available to LoopTroop sessions |
| Session ownership, prompt assembly, timeout/retry policy, blocked-error routing, question APIs, and ticket-log projection | LoopTroop | This is the orchestration layer that makes OpenCode durable inside the ticket workflow |

For full local OpenCode DEBUG logs in your terminal, run `npm run dev --opencode-logs=all`. The launcher maps that opt-in to OpenCode's documented [`--print-logs` and `--log-level DEBUG` CLI flags](https://opencode.ai/docs/cli/) for [`opencode serve`](https://opencode.ai/docs/server/) and propagates `LOOPTROOP_OPENCODE_LOGS=all` to the watcher. This only changes logging for an OpenCode server that LoopTroop starts itself; reused, remote, or mock servers keep their own logging configuration. OpenCode's [troubleshooting docs](https://opencode.ai/docs/troubleshooting/) describe DEBUG logs as detailed diagnostic output; treat them as sensitive local data because they may contain request or provider details.

When OpenCode emits only a generic `Provider returned error` stream event, LoopTroop best-effort scans the newest local OpenCode log files for the same `session.id` and surfaces the exact provider cause in the ticket log and blocked-error diagnostics. The enrichment keeps compact fields only: HTTP status, retryability, OpenCode provider/model, request model, provider error type/title/message, and a short response-body preview. It discards prompt bodies, raw request payloads, headers, cookies, authorization values, and URL query strings before persisting anything. By default it reads OpenCode's documented local log directory; set `LOOPTROOP_OPENCODE_LOG_DIR` when LoopTroop is attached to an external server with logs stored elsewhere.

For trusted local LoopTroop sessions, the managed OpenCode server is permissive by default: `scripts/dev-opencode.ts` sets `OPENCODE_PERMISSION='"allow"'` when it starts `opencode serve`, unless `LOOPTROOP_OPENCODE_PERMISSION_MODE=inherit` is set. LoopTroop also creates execution sessions with a robust set of SDK permission rules (including patterns `*`, `/*`, `/**/*`, `**`, and `**/.*` under the `allow` action), so server-level permission policy and session-scoped permissions both allow required tool use and pre-approve absolute paths. This removes OpenCode approval prompts from trusted automation (especially when setup scripts read system config directories like `/etc` to determine OS and CPU architecture properties), but it does not bypass normal OS privileges or make passworded `sudo` a dependency of setup.

### 4.1 Tool Policy Layer

Prompt templates choose from four OpenCode tool policies:

| Policy | Effect |
| --- | --- |
| `default` | Leaves the normal OpenCode tool surface intact, but forces `webfetch` and `websearch` off |
| `disabled` | Explicitly disables all tools for prompts that should be pure reasoning/structured output |
| `read_only` | Allows only read-style tools (`codesearch`, `glob`, `grep`, `list`, `lsp`, `read`) |
| `execution_setup_online` | Re-enables `webfetch` and `websearch` for setup prompts that may need official installer or launcher lookup |

That policy layer is applied per prompt at the `runOpenCodePrompt()` / `runOpenCodeSessionPrompt()` boundary. For the prompt-to-policy mapping, see [Prompt Inventory](prompts.md).

Planning prompts that can make or preserve repository-specific claims use `read_only` selectively: they review their supplied context first and inspect the repository only when they need concrete evidence. This covers Full Answers, PRD and beads drafting, refinement, and coverage, plus blueprint expansion and the non-voting interview workflow. Council voting remains tool-disabled; no planning prompt receives shell execution or mutation tools through this policy.

## 5. Session Ownership

LoopTroop does not treat OpenCode sessions as anonymous chat handles. It tracks who owns a session in the project database.

Ownership is keyed by the workflow slot that is allowed to use that session. In practice that means `phase` plus an ownership tuple that can include:

```json
{
  "ticketId": "AUTH-12",
  "phaseAttempt": 1,
  "memberId": null,
  "beadId": "api-refresh-endpoint",
  "iteration": 2,
  "step": null
}
```

This is what lets the backend distinguish:

- one council member's vote session from another
- the first execution attempt for a bead from the second
- a planning session from a coding session on the same ticket

`keepActive` and `forceFresh` are prompt-runner controls layered on top of this ownership model; they are not part of the persisted ownership key itself.

## 6. Prompt Runner

`runOpenCodePrompt()` is the main orchestration helper. It resolves session ownership, timeout budget, tool policy, and prompt dispatch in one place.

It currently does the following:

1. Resolve or create the session, retrying session-creation failures before the prompt is sent.
2. If `sessionOwnership` is present, call `SessionManager.validateAndReconnect()` first.
3. Dispatch the prompt with model, agent, variant, tool policy, and timeout settings.
4. Subscribe to stream events while the prompt is running.
5. Track OpenCode `session.status` retry events against the profile retry budget and grace window.
6. Reconcile the streamed reply with assistant messages and stream status.
7. Mark the session completed, keep it active, or preserve/abandon it depending on the outcome.

`runOpenCodeSessionPrompt()` is the lower-level helper for prompting a known session.

Retry-status handling is driven by OpenCode stream events, not only by log text. The runner watches `session.status` retry events across OpenCode-backed phases and treats matching rate-limit, usage-limit, resource-exhaustion, overload/capacity, temporary-unavailability, timeout/deadline, fetch, network, and socket-reset messages as continuable provider interruptions. The profile's `OpenCode Retry Limit` blocks after a configured number of matching retry events, and `OpenCode Retry Grace Window` blocks when a matching retry state produces no progress for the configured window. A zero retry limit blocks on the first matching retry event; a zero grace window disables the timer.

When a ticket is blocked by a resumable OpenCode/provider interruption, the prompt runner can preserve the active owned session instead of abandoning it. Eligible interruptions include retryable diagnostics, HTTP 402/408/429/500/502/503/504/529, rate or usage limits, overload/capacity messages, timeouts, and transport failures. `HTTP 402 Payment Required` is treated as externally clearable, so Continue can resume the same session after payment or workspace access is restored. Auth, invalid request, request-size, permission, missing API key, model-not-found, and non-402 insufficient-quota signals remain non-continuable.

CODING also carries the latest meaningful OpenCode retry/session/output-limit diagnostic forward when a bead later blocks for completion-marker or bead retry-budget reasons, so the Error view can show the underlying provider/session cause alongside the bead wrapper failure.

When a pending continuation exists for the preserved session, the next owned prompt body is replaced with exactly:

```text
continue please
```

Continue does not archive the active phase attempt or create a fresh attempt. Retry still keeps the fresh-attempt behavior.

### 6.1 Session Reuse Controls

| Control | Effect |
| --- | --- |
| `keepActive` | Leaves the owned session active after a successful prompt so a later prompt in the same workflow slot can reuse it |
| `forceFresh` | Aborts and abandons the currently owned active session before creating a new one for the same workflow slot |

These controls are what let multi-turn phases reuse a durable session when appropriate, while still allowing hard resets for flows that must discard the old transcript.

## 7. Reconnect Behavior

Reconnect is intentionally conservative.

`SessionManager.validateAndReconnect()` only succeeds when:

- the ticket still exists
- the ticket is still in the same phase, or is in `BLOCKED_ERROR` with an unresolved centrally classified continuation whose `previousStatus`, blocked-from phase, and diagnostic session id exactly match the owned session
- the owned active session record still exists in the project DB
- the same session still exists remotely in OpenCode

Startup resolves ticket ownership inside the project database currently being reconciled because local numeric ticket ids may repeat across projects. It then classifies exact verification as reconnected, confirmed missing, stale ownership, or temporarily unverified. Confirmed missing and stale records are abandoned; timeouts, transport failures, and OpenCode 5xx responses preserve the active record for a later check.

That means LoopTroop can survive restart and resume safely, but it does not try to magically continue any random broken stream from the past.

If OpenCode cannot verify an exact session because the server is down or restarting, validation fails closed without abandoning the database record. This applies both to active phases and to every resumable `BLOCKED_ERROR` condition accepted by the central continuation classifier, including eligible limits, payment blocks, overloads, timeouts, and transport failures. The prompt runner then either creates a new owned session when OpenCode is reachable or lets the phase fail into the normal retry/block path. Owned same-session reuse is also revalidated immediately before prompting, so a stale session cannot be prompted after the ticket has moved phases.

For Continue, the route performs one extra live check: if the OpenCode server can no longer read the preserved session by exact id, the request returns `409` and leaves the ticket in `BLOCKED_ERROR`.

### 7.1 Session Continuation

`server/opencode/sessionContinuation.ts` manages the eligibility logic for Continue actions. It determines whether a blocked ticket can resume its preserved OpenCode session instead of starting a fresh attempt.

**Eligibility criteria:**

- The ticket must be in `BLOCKED_ERROR` with a known `previousStatus`.
- An active error occurrence with a diagnostic `sessionId` must exist.
- A matching active `opencode_sessions` row must exist for that ticket, previous phase, and session ID.
- The OpenCode server must still have the session addressable by that exact ID.
- The error diagnostics must be of a continuable type (retryable provider errors, HTTP 402/408/429/500/502/503/504/529, rate/usage limits, transport failures, timeout-style interruptions).

Backend, OpenCode, WSL, OS, and machine restarts preserve the same eligibility when those exact ownership checks still match. A temporary inability to verify OpenCode leaves the session active rather than removing Continue permanently; a later read or restart may verify it again. Only confirmed remote absence or provably stale ownership abandons the local session record.

**Non-continuable errors:** Auth failures, invalid requests, permission errors, missing API keys, model-not-found, and non-402 insufficient-quota signals are not eligible for Continue.

When all checks pass, the Continue action records a pending continuation keyed by `sessionId`. The next owned session prompt consumes this and sends exactly `continue please` — no context rebuild and no new attempt version.

Blocked execution setup also has a same-session action called **Retry with extra note...**. It uses the same exact session ownership checks, but sends only the user's entered text instead of `continue please`. The action keeps the current runtime phase attempt and allows one manual setup attempt beyond the automatic retry budget. It does not add the text to future setup context. Coding uses its existing fresh-bead recovery path for the button with the same label.

## 8. Streaming

OpenCode stream events are consumed server-side and then translated into LoopTroop's own ticket event model.

The SDK adapter subscribes to OpenCode's global event stream, unwraps `{ directory, payload }` frames, and filters them back to the owned session before emitting LoopTroop events. This keeps live model detail working when the directory-scoped OpenCode event endpoint closes early, while still preventing unrelated project/session events from entering the ticket log.

LoopTroop ships a project-level OpenCode plugin at `.opencode/plugins/looptroop-listener-limit.js` that raises the Node/Bun EventTarget listener warning threshold to 20 inside the OpenCode process. This only changes the warning threshold for legitimate parallel stream listeners; it does not create a hard concurrency limit or replace stream cleanup.

The prompt runner tracks:

- text events
- reasoning events
- tool events
- step start and finish events
- session status events, including retry budget/grace-window detection
- session error events
- question and permission events that contribute to ticket-side recovery or UI prompts

The runner also backfills finalized assistant message parts from the current prompt segment of `session.messages()` after completion so thinking, intermediate assistant narration, tool activity, and terminal output are durable even if no browser was watching in real time. It never treats older messages from a reused session as new activity. Intermediate text is logged as an `ASSISTANT` Other event and the final response remains `OUTPUT`, both keyed by stable session/message identities.

Each newly completed assistant message also produces one idempotent AI-turn metrics row. OpenCode step-finish data supplies cost and input/output/reasoning/cache tokens; assistant timestamps supply duration; message provenance supplies the actual model and variant. Persistence and SSE invalidation are best-effort diagnostics and cannot fail the workflow. Collection is forward-only and does not scan historical OpenCode sessions.

Tool normalization retains reported elapsed time, compaction time, and attachment filename/MIME metadata while discarding attachment payloads. `session.status.action` recovery metadata is sanitized into an error event; unsafe non-HTTP(S) links are discarded before persistence.

The adapter keeps a short step-finish safety window near prompt deadlines so terminal finish metadata still has a chance to arrive before the stream is treated as done.

Step-finish metadata is also used for blocked-error diagnostics. If OpenCode reports a finish reason such as `length`, LoopTroop records the failure as model output truncation, carries through token counts when available, and explains that subsequent structured-output validation errors may be secondary symptoms of an incomplete response.

The frontend never talks directly to OpenCode. It receives normalized ticket events over `/api/stream`.

## 9. Questions And Human Input

OpenCode may request user input during execution. LoopTroop exposes that queue through:

- `GET /api/opencode/questions`
- `GET /api/tickets/:id/opencode/questions`
- `POST /api/tickets/:id/opencode/questions/:requestId/reply`
- `POST /api/tickets/:id/opencode/questions/:requestId/reject`

The per-ticket route filters the global OpenCode question queue down to active sessions that LoopTroop currently owns for that ticket. Reply/reject actions emit deduplicated question lifecycle log entries and `needs_input` SSE updates, so the browser can remove resolved prompts without polling OpenCode directly.

## 10. Health And Model Discovery

LoopTroop uses related but distinct OpenCode probes:

| Surface | Backing code | Purpose |
| --- | --- | --- |
| `adapter.checkHealth()` and `GET /api/health/opencode` | `server/opencode/adapter.ts`, `server/routes/health.ts` | Basic OpenCode reachability, version, and a lightweight model list |
| `GET /api/models` | `server/opencode/providerCatalog.ts`, `server/routes/models.ts` | Fetch and flatten active models from configured providers; `?scope=all` explicitly requests every provider |
| `POST /api/models/refresh` | `server/opencode/providerCatalog.ts`, `server/routes/models.ts` | Dispose LoopTroop's catalog/root OpenCode instance, then return freshly fetched models from configured providers |

Provider-catalog fetch first tries `/provider` and falls back to `/config/providers`. The normalizer accepts both catalog shapes and filters inactive models out of the flattened list. The default response returns `models` from configured providers plus `connectedProviders` and `defaultModels`. The full OpenCode catalog is returned in `models` only for `GET /api/models?scope=all`.

If model discovery fails but health still passes, the API returns empty model arrays plus a message instead of crashing the UI. The frontend treats that startup message as retriable so model selectors can recover automatically while OpenCode is still coming up.

The Configuration model pickers fetch configured-provider models by default. Their separate full-catalog query remains disabled until the user enables **Show all providers**, avoiding transfer and browser processing of thousands of unrelated models during normal configuration. Turning the option off immediately restores the configured-provider list, while a full-catalog failure does not replace its independent cached result.

The Configuration reload button uses `POST /api/models/refresh` for a stronger refresh after provider credentials change. The route first calls OpenCode's instance-scoped `/instance/dispose` endpoint for the catalog/root directory, using the same Basic authentication as other OpenCode requests, and only then fetches `/provider` again. It clears both frontend model scopes, repopulates configured-provider models, and leaves the full catalog unloaded until explicitly requested again. It does not restart `opencode serve`, use global disposal, or dispose the separate worktree instances owned by active ticket sessions. A disposal or subsequent catalog-fetch failure is surfaced to the model-discovery error state rather than returning a catalog known to be stale.

When `LOOPTROOP_OPENCODE_MODE=mock`, health and model discovery come from in-process mock data rather than network calls. The refresh route returns that mock catalog without attempting instance disposal.

## 11. Question Log Fingerprinting

LoopTroop uses deterministic fingerprinting to track OpenCode question lifecycle events across log entries. The system is implemented in `shared/logIdentity.ts`.

### 11.1 Why Fingerprinting

OpenCode questions produce multiple log entries: when a question is asked, replied to, rejected, or when a reply or rejection fails. Without a stable identity, the same question could appear multiple times in log views and deduplication would be unreliable.

### 11.2 How It Works

`buildOpenCodeQuestionLogIdentity()` generates a stable identity for each question lifecycle event:

- **`entryId`** — A deterministic SHA-256 fingerprint combining the ticket ID, session ID, request ID, and action type (`asked`, `replied`, `rejected`, `reply_failed`, `reject_failed`). The same question+action combination always produces the same `entryId`.
- **`fingerprint`** — A broader SHA-256 fingerprint spanning ticket ID, session ID, and request ID. All events for the same question share the same fingerprint, so separate lifecycle stages can still be correlated.

### 11.3 Usage

`extractLogFingerprint()` reads the fingerprint from a log record's metadata. `hasMatchingLogFingerprint()` compares fingerprints across records to detect duplicate or related entries.

The fingerprinting system is used by the OpenCode question polling loop and the execution-log pipeline to prevent duplicate question entries when the same pending question state is observed multiple times.

## 12. Why LoopTroop Wraps OpenCode This Heavily

OpenCode is the model execution engine. LoopTroop adds:

- phase-aware context assembly
- ticket-aware session ownership
- prompt-level tool policy
- durable restart behavior
- workflow-aware retries and blocked-error recovery
- frontend-ready event and question projection

Without that wrapper, the rest of the system would have no safe way to restart, audit, or recover a long-running ticket lifecycle.

## Related Docs

- [Configuration](configuration.md)
- [Operations Guide](operations.md)
- [Prompt Inventory](prompts.md)
- [API Reference](api-reference.md)
- [Beads & Execution](beads.md)
- [Context Engineering](context-engineering.md)
- [System Architecture](system-architecture.md)
