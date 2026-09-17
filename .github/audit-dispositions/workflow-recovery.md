# Workflow, OpenCode, and interview recovery audit ledger

This ledger covers only the accepted PART5 workflow, OpenCode, interview, approval-save, and final workflow packets. Statuses remain `PASS, final pending` until the root worker completes the fresh aggregate review. It does not claim final acceptance.

## Scope and boundaries

The source scope is the exact 93-path manifest in `/tmp/looptroop-workflow-part-manifest.json`, applied through the three ranges in `/tmp/looptroop-workflow-part-provenance.json`: core OpenCode and interview recovery, approval saves, and final workflow recovery. The documentation scope is `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, and this ledger only.

Git and contained durable I/O are inherited prerequisites from the part2 base. CLI/process recovery, hooks, bead/parser contracts, broad client history/log/cache work, and unrelated status prose remain outside this part. The website is separately accepted and was not edited here.

## OpenCode and interview packet

| Finding | Status | Evidence and coverage | Limits |
| --- | --- | --- | --- |
| W01 | PASS, final pending | Interview compilation keeps unanswered compiled-question IDs stable while allowing compatible rewording. Answered IDs, source metadata, rounds, and answer controls remain immutable. | No E2E or full lifecycle run. |
| W03 | PASS, final pending | OpenCode context lookup uses project-scoped ticket keys, external-id read-through, and canonical invalidation. | No E2E or full lifecycle run. |
| W04 | PASS, final pending | Question list, reply, and rejection resolve the stored session directory. Missing directory state fails closed, and caller-supplied project paths cannot choose ownership. | No E2E or full lifecycle run. |
| W05 | PASS, final pending | Generation, answer edits, interrupted PROM4 recovery, and retry-session reactivation share durable batch claims, exact intermediate-state fingerprints, and raw-content CAS. Late results and rollback cannot overwrite a newer edit, batch, completion, or released claim; an abandoned remote session is reactivated only after exact ownership and liveness checks, otherwise a replacement session resumes from the answered snapshot. | SQLite close/reopen is an in-process cache boundary, not a process restart. |
| W07 | PASS, final pending | Foreign claims can be reclaimed after a proven lease expiry or dead recorded PID, and same-PID claims carry a process-boot identity so a daemon restart cannot mistake an older process for itself. A live, invalid, or unverified owner remains protected. The non-expiring pending-stop marker cannot be bypassed by lease expiry. | No E2E or full lifecycle run. |
| W08 | PASS, final pending | Answer and skip routes require a positive `batchNumber`; missing, invalid, stale, unknown-question, unknown-option, and unknown-reason payloads fail before claim or mutation. | No E2E or full lifecycle run. |
| W09/W10 | PASS, final pending | Council stop-before-settlement and shared cancellation cleanup confirm the remote stop before cleanup, continuation, skip-all advancement, or pending-marker promotion. Adapter lookup accepts only exact HTTP 404 evidence; message-only 404 text and transport failures remain unconfirmed. False, thrown, and unverified stops remain retryable, while failed CANCELED cleanup retries without re-entering coding. Prompt callback failures clean up before rethrow. | No live model or lifecycle run. |
| W18 | PASS, final pending | Cancellation reaches session-directory and assistant reads, and health checks honor the abort signal. | No E2E or full lifecycle run. |
| W20/W21/W22 | PASS, final pending | Completed streamed text remains usable after a final assistant-read failure; terminal completion and confirmed abort release directory maps; per-session streams reject events without an explicit matching session ID. | No E2E or full lifecycle run. |
| W24/W25/W26 | PASS, final pending | Context trimming visits all expendable parts until the budget is met. Automatic bead-response continuation is finite per bead iteration, while `0` remains unlimited for that path. Adapter, supervisor, orphan-row, and expired-budget seams have deterministic coverage. | User-facing Continue across phases remains separate. No process restart or native-platform claim. |
| P17(4)/U19(3) | PASS, final pending | Interview snapshot timestamps require non-empty parseable values, and invalid `updatedAt`/`answeredAt` snapshots are rejected by the restoration validator. Client submit and skip share a same-tick guard set before the first await and cleared in `finally`. | No E2E or full lifecycle run. |

Approval saves preserve the loaded interview or PRD content hash. Missing baselines return 428, stale baselines return 409, and raw and structured saves do not silently rebase over newer content. Queued keepalive and GET reconciliation keep the predecessor revision and later edits visible. Failed saves and best-effort unload flushes remain unsaved and retryable. Execution setup-plan saves use the same contract, add a durable planning claim, and use a compare-and-set write; runtime rewinds recheck the baseline after confirmed stop and before archival or status changes. The UI persists and restores a dirty setup draft's loaded hash, holds it across background refetches, sends it for both raw and structured saves, and uses the latest fetched hash for approval.

## Final workflow and merge packet

| Finding | Status | Evidence and coverage | Limits |
| --- | --- | --- | --- |
| W11 | PASS, final pending | Execution-setup regeneration parses before the lock, then re-reads state inside it. Concurrent route requests produce one accepted request, one 409, one commentary artifact, one restart, and one workflow event. | No E2E or full lifecycle run. |
| W12/W14 | PASS, final pending | Closed-unmerged checkpoints are durable and fenced against Merge, Close, and Cancel replacement. Remote reads happen outside the lock, failures create typed retryable receipts, and state is revalidated after reacquiring the lock. | No live GitHub or remote lifecycle run. |
| W15/W16 | PASS, final pending | Error and execution-setup views render server-advertised actions and warnings. Unknown statuses advertise no actions, setup approval does not invent edit-plan or note-bearing retry controls, and hook-policy/parser warnings remain visible. | No browser E2E. DOM fixtures only. |
| W19/W23 | PASS, final pending | Observed merged PR state is persisted before candidate or close conflict rejection. Skip receipt identity includes action, item, phase, and attempt, so retries do not deduplicate prior attempts. | No E2E or live GitHub run. |
| W27 | PASS, final pending | Manual QA Submit and Skip capture draft, evidence, round, and revision at click, and require the server revision observed when the QA route was entered. A later autosave remains newer while the clicked snapshot drives the mutation and any fix-bead generation; an edit in another tab is rejected before mutation. | No browser E2E. |
| W28/W29 | PASS, final pending | Explicit null attempts remain distinct from synthetic current attempts. Unknown statuses expose no actions. Close reads the live PR before deciding and revalidates under the ticket lock. Durable close-unmerged receipts make a successful decision idempotent across a crash. | No E2E or live GitHub run. |

The related W13 observation from the adjacent filesystem/recovery packet is also
covered here: a checkpoint failure leaves the selected bead `pending`, and the
retry route can recover that runnable, never-started bead without pretending a
reset anchor exists. A genuinely started bead without `beadStartCommit` still
fails closed; the G04 restore-conflict guard remains unchanged.

## Recovery and documentation rules

Only a confirmed remote stop releases ownership. SQLite ownership may fall back to the ticket marker during startup recovery. If both storage layers are unavailable, only the current process guard remains, so a restart cannot claim recovery. Do not describe a database reopen as a process restart or claim that a simultaneous database and marker failure is recoverable across restart.

Final workflow metadata describes both status `description` and `details` for closed-unmerged recovery, fresh merged observations, and server-advertised blocked actions. The README and contributor guidance describe the same limits. The changelog records confirmed-stop ownership, positive interview batch identity, and bounded automatic continuation.

Native Windows, physical power loss, live model/provider calls, live GitHub calls, E2E, full lifecycle tests, package/install smokes, and CI are not claimed. Fixture processes, fixture repositories, local SQLite, route tests, and DOM tests are allowed evidence only.

Frozen source evidence: `/tmp/looptroop-opencode-evidence.md`, `/tmp/looptroop-interview-core-evidence.md`, `/tmp/looptroop-interview-saves-evidence.md`, and `/tmp/looptroop-workflow-merge-evidence.md`.
