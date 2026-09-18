# PR169 review dispositions

## Third-review live native append follow-up (2026-09-18)

The two independent round-three reviews (`5726618521` and `5726963063`) found
the same real defect: an OpenCode native log can grow normally while a bounded
scan is parsing it, but the old exact size/mtime checks turned that append into
a 500 for DEBUG history and export. This is separate from the accepted
same-size rewrite, captured-boundary, identity, fairness, and parent-generation
work in `89e8c485`.

The reader now records a digest of complete bytes through its committed
`indexedOffset`, excluding a partial tail. Projection ingestion accepts
same-identity growth beyond the captured `endOffset`, verifies each parsed
range against that digest, verifies a reused parent prefix, and rechecks both
after any full-prefix hash before publishing the generation. A single
start-at-zero read uses its captured digest as the persisted prefix hash; the
missing-session plus append two-plan case retains separate range checks. A
prefix rewrite still fails closed. Focused route and native-reader regressions
cover growth success, rewrite failure, bounded-tail hashing, retained cursors,
and append/history behavior.

The later Greptile P1 (`4045461220`) found that the excluded partial tail was
still inserted without a digest. The native reader now records `tailHash`, and
projection ingestion verifies the exact captured tail range before publishing;
a same-size tail rewrite deletes the provisional generation instead of exposing
stale history.

The fresh-alpha decision remains unchanged: no native-index compatibility
migration or `ALTER TABLE` backfill is added. The edited Greptile shutdown note
is inherited runtime work in `server/createRuntime.ts`, not a PR169 source
change; root owns its cross-PR drain ordering.

## Nested overlays and housekeeping confirmation (2026-09-18)

The directory-picker stacking and unrelated-tooltip Escape observations are
correct. The only `FullScreenModal` caller is the directory picker; its existing
portal now layers above the Projects modal without a new stacking abstraction.
The shared Escape guard excludes informational tooltip wrappers while keeping
dialogs and interactive popups protected. Folder-picker and centered-modal
regressions cover both cases.

The owner also chose to preserve ignored files in CLI cleanup and Free Disk
Space, while explicit ticket/project deletion remains destructive. PR164 owns
the shared removal guard and housekeeping consumer; this branch updates the
confirmation text to explain that ignored dependencies and build output block
cleanup along with configuration files.

The follow-up review also confirmed that a cursorless outage must recover on
every later connection, including after an earlier replay-gap recovery on the
same connection lineage. `useSSE` now derives the open-time recovery flag from
the current zero cursor, while the per-handshake guard still prevents duplicate
recovery from `open` and `replay_gap`; the repeated-outage regression is in the
focused SSE suite. Ticket and profile Cancel actions reuse their dirty guards,
and the Create-and-Start success path only selects the returned ticket when no
later edit is waiting to be saved, so a save cannot remount over newer typing.

The native reader's captured-boundary, source-identity, rewrite, and fairness
follow-up is owned by agent168 in the native files and is committed in
`89e8c485`; this ledger records the client handoff without duplicating those
edits.

## Second-review intake dispositions (2026-09-18)

These are the new candidate topics traced during the second read, including
items already fixed by the root owner or intentionally left with another PR.

| Intake topic | Disposition | Evidence / owner |
| --- | --- | --- |
| TicketForm Cancel dirty-guard bypass | correct / fixed | Cancel now calls the form's semantic dirty confirmation; `TicketForm.test.tsx` covers reject and accept paths. |
| ProfileSetup Cancel dirty-guard bypass | correct / fixed | Cancel reuses the profile dirty confirmation; `ProfileSetup.test.tsx` covers reject and accept paths. |
| Create-and-Start followed by later Save loses selection/navigation | correct / fixed | The form adopts the server-returned ticket and dispatches `SELECT_TICKET` only when the successful Save has no newer draft; the in-flight later-edit regression covers the no-remount path. |
| Delayed project `/check-git` restore overwrites later name/settings edits | correct / fixed | `ProjectForm` compares restore snapshots without the folder identity and skips stale defaults after later edits; the deferred-response regression retains the draft. |
| Canonical repository root is hidden after creating from a subfolder | correct / fixed | `ProjectForm` adopts the returned `folderPath` for the mounted editor and its State Folder while comparing later editable fields against the canonical submitted baseline; the create-race regression checks the returned root. |
| Invalid numeric or nested partial ticket patches clobber valid cache fields/siblings | correct / fixed | Normalization omits invalid fields and `ticketStatusCache` recursively merges supported nested patch records; focused normalization/cache tests cover malformed values and sibling retention. |
| Reset-all prompts leaves the active editor dirty or adopts a stale pre-reset copy | correct / fixed | Reset requests carry a pending/success/failure identity, active prompt refetches are awaited with errors surfaced, and success advances the baseline while replacing the draft only when no later typing exists; PromptEditor and usePrompts regressions cover success, later edits, and refetch failure. |
| Non-AI merge places an unmatched old live row after the historical page | correct / fixed | `mergeEntriesBatch` partitions older unmatched overlay rows before the canonical page in one pass; `LogContext.test.ts` covers chronology and the implementation avoids an overlay membership scan. |
| Full-history fold becomes quadratic while pages drain | correct / fixed | `useTicketHistoricalLogs` retains page-sized node groups and lazily materializes the display array; history stats assert one visit per row with no arbitrary page/setting cap. |
| Cursor-0 reconnect skips recovery after an earlier replay-gap recovery | correct / fixed | `useSSE` re-arms open-time recovery from the current zero cursor; the gap → disconnect → open regression expects a second scoped refresh while non-zero replay remains quiet. |
| Folder picker behind the raised Projects modal | correct / fixed by root | Root commit `0633cc94` raises the sole `FullScreenModal` caller; focused FolderPicker/modal checks cover the stacking contract. |
| Shared Escape gate lets informational tooltip wrappers claim Escape | correct / fixed by root | Root commit `0633cc94` excludes informational Radix tooltip wrappers while retaining interactive overlay ownership; focused keyboard/modal checks cover it. |
| Dirty CenteredModal backdrop silently refuses close | correct / fixed | Backdrop close now uses the same unsaved-change confirmation as Escape and the close button; `CenteredModal.test.tsx` covers both rejection and acceptance. |
| Deferred pop reconciliation freezes the route after initial ticket-list error | correct / fixed | Agent164’s `App` fix clears the deferred pop error before hydration, preserves the deep-link success gate, and allows modal/board navigation after the initial list error; the loading→pop→error and later recovery regressions pass in the 45-test App suite. |
| Native growth rewrite, prefix fingerprint, captured-size boundary, missing-session indexing, source identity/stat races, and fairness modulo | correct / fixed by native owner | Agent168's handoff is committed in `89e8c485`: strict source identity/stat validation deletes provisional generations on change, prefix fingerprints gate append reuse, reads use captured `endOffset`, and complete-line yields are periodic; native focused suites cover the regressions. No client-side duplicate was added. |
| Fresh-alpha schema versus compatibility migration | intentional policy | The alpha database is fresh-only, so no `ALTER TABLE prefix_hash` migration is added. |
| W27 click-time Manual QA snapshot and later autosave | intentional owner choice | Preserve the click-time snapshot and later edits; no replacement with a live mutable read was justified. |
| Positional P12/P13 equal-length expansion pairing | intentional owner choice | The ordered server contract preserves count and position even when execution IDs change; ID matching would change behavior. |
| Dirty reload / `beforeunload` promise | deferred / no supported contract | The reviewed scope promises modal/navigation guards, not browser reload protection; no broad unload prompt was added without a product decision. |
| Unlimited settings and full-history draining | intentional owner choice | No arbitrary cap was introduced; existing `0`/unlimited semantics and complete history traversal remain intact. |
| HTTPS public origin, unknown executable-owner policy, configured `core.sshCommand`, and inherited Windows session-manager failures | not applicable here | These are respectively owned by PR168, PR163, PR164, and PR167/root aggregate work; PR169 does not duplicate their fixes. |

This ledger records every review record in the current PR169 evidence (`169.json`, `169-delta.md`, comment/CI packets), including automated summaries, inline comments, and empty review records. Older `169-refresh` rows are historical context, not the current authority. The consolidated audit dispositions remain the authority for work assigned to another PR. The owner chose to retain edits made during creation and transition the mounted form to the item returned by the server; PR169 implements that choice for tickets and projects.

### Refreshed record cross-reference and remaining suggestions

| Record | Outcome |
| --- | --- |
| 5719146013 | Tooltip ownership and reader fairness fixed; unmounted history drains now stop (30 history tests). Patch validation has concrete malformed/nested regressions; no extra field-schema framework added. Empty AI overlays already arrive timestamp-sorted from both callers. Tombstones deliberately suppress resolved identities; comparing their stored generation would weaken that contract. |
| 5719151436 | Cursor-expiry restart is covered by the existing 409 regression. Native read/stat failures now abort rather than publish incomplete history. Snapshot retention remains bounded with explicit expiry/retry; no export pinning or speculative DEBUG visibility column added. Equal invalid timestamps do not violate transitivity. Async iteration uses stream backpressure; no manual pause/resume machinery is needed. Different confirmation text does not cause two confirmations on one close path. |
| 5719168265 | Older live-row placement, cursorless recovery, Reset all, picker layering, and captured-size native scans fixed. |
| 5719185811 / 5719267314 | Create-and-Start navigation and initial-load pop failure fixed. Reload persistence remains outside the stated draft contract. Right-click dismissal and resetting dirty state when opening a new modal have no demonstrated data-loss path; retained behavior. |
| 5719613146 | Cancel guards, larger rewrites, and zero-cursor recovery fixed. The stale-folder test exercises the public generation fence; the inner guard is defensive, not a separately reachable public path. Additional mutation-test and test-isolation suggestions do not establish another production defect. |
| 5720276597 | Dirty backdrop now confirms. The route dependency still wakes URL reconciliation and is retained. The claimed missing session-probe timeout is stale: `probeSessionAfterStreamFailure` already uses `AbortSignal.timeout(BACKEND_HEALTH_TIMEOUT_MS)`. Cross-PR findings retain their existing owners and accepted policies. |
| 5720948817 | Invalid sparse patches, delayed project restoration, and repeated full-history materialization fixed. |
| 4040001315 / 5239623772 | Canonical project-root display fixed; the associated review body is empty. |
| Edited CodeRabbit/Qodo/Greptile summaries, Codacy 5717815384, Sonar 5719080412 | Status and summary records are correlated with the concrete findings above. A skipped review or green analyzer summary is not evidence that every source issue is resolved. |

Final focused checks: 191 client-DOM tests across nine files, 30 client-node
normalization/cache tests, and 45 App tests pass. The native/server combined
checkpoint passes 5,032 tests with 13 skips. Aggregate lint/type/build/client
results are recorded in the root review summary.

## Earlier-review evidence (historical)

The independent PR169 changes are covered by these focused checks:

- `npx vitest run --project client-dom src/components/project/__tests__/ProjectForm.test.tsx src/components/project/__tests__/FolderPicker.test.tsx src/components/shared/__tests__/CenteredModal.test.tsx src/components/shared/__tests__/KeyboardShortcuts.test.tsx src/components/ticket/__tests__/renderedTickets.test.ts src/context/__tests__/AIQuestionContext.test.tsx src/context/__tests__/LogContext.test.ts src/hooks/__tests__/useTicketHistoricalLogs.test.tsx src/hooks/__tests__/useOpenCodeModels.test.ts src/lib/__tests__/ticketNormalization.test.ts` — 9 files, 131 tests passed before the follow-up drain regression; the focused history suite now passes 29 tests.
- `npx vitest run --project server-integration server/routes/__tests__/models.test.ts` — 1 file, 4 tests passed.
- ESLint over every changed source and test file — no issues.
- The Sonar duplication snapshot’s three changed test files are reduced with shared `SnapshotRecovery`, history-response, and JSON-response fixtures; their focused regressions pass (3 files, 52 tests). The snapshot’s two native S2871 records are stale against the native owner’s `89e8c485` deterministic comparators; no exclusion was added.
- The merged branch passed `npm run lint`, `npm run typecheck`, and `npm run build`; the test-only fixture refactor was then rechecked with the focused suite and ESLint.
- The create-race regressions pass in the focused client suite (25 tests): a later ticket/project edit changes the action to Save and PATCHes the server-returned ID, while the original create runs once. Create-and-start also records the returned running status and omits draft-only ticket settings from the later PATCH.
- The first `npx tsc --noEmit --pretty false` run caught the new deferred-response test’s too-narrow resolver type; it is corrected to accept `PromiseLike<Response>`. Root’s aggregate typecheck is the final verification for the merged branch (the local rerun was not repeated while that aggregate check was running).

The earlier same-size rewrite, native session discovery, helper cleanup, and
deterministic sort were introduced in `baa491b9`. Captured-size boundaries,
prefix verification, source identity checks, and fairness follow in `89e8c485`.
These changes are referenced below and are not duplicated here. Beads-editor accessibility belongs
to PR165; Manual QA hooks belong to PR167. No E2E or full-lifecycle run is
claimed.

## Issue comments

| Comment ID | Author | Disposition | Evidence / decision |
| --- | --- | --- | --- |
| 5713776135 | coderabbitai | not-applicable | Review was explicitly skipped on this non-default branch; it contains no finding. |
| 5713776510 | chatgpt-codex-connector | not-applicable | Status summary only; the underlying inline findings are recorded below. |
| 5713788731 | codacy-production | accepted | Codacy reported zero new issues. The changed files also pass the focused ESLint check. |
| 5713799265 | qodo-code-review | accepted as summary | High-level description and alternatives; each actionable observation is dispositioned by its own record below. |
| 5713805572 | qodo-code-review | correct / fixed | Same-size native rewrite now uses changed mtime; the native owner added the regression in the native projection tests (`89e8c485`). Its drain, draft, and retry observations are covered by the corresponding rows below. |
| 5713815929 | gitar-bot | deferred / superseded | The reported atomicIO and session-manager CI failures came from the earlier cross-PR state and are owned by the 164/root aggregate work. They are not silently ignored or attributed to PR169; root’s aggregate checks are the final evidence. |
| 5713837819 | greptile-apps | mixed | The history-drain and startup-retry findings are fixed here. Equal-length bead expansion remains intentionally positional: `orchestration.md` and the consolidated disposition record the server order/count contract, so changing it to ID matching would be a regression. |
| 5714101041 | looptroop-ai | mixed | Drain scope, model retry codes, DEBUG interleaving, applied snapshot generations, and full-ticket patch fields are fixed. Native helper cleanup is in `89e8c485`. The accepted create-success choice is fixed: later edits stay mounted and the form adopts the returned ticket/project identity for its next save. |
| 5714233224 | looptroop-ai | correct / fixed | Deferred fold, older-page requests, and drain state are keyed to the serialized query scope; scope identity also fences an A→B→A stale run, and a mixed-caller regression proves an uncancellable consumer keeps the drain alive. |
| 5714245891 | looptroop-ai | mixed | Project Back/Cancel now use the dirty guard. The native-only model catalog concern is not applicable to the current reader contract: `OpenCodeNativeLogEntry` and its parser emit no model identity, so inventing model metadata would be a new feature. |
| 5714251667 | looptroop-ai | mixed | FolderPicker timer ownership, history drain cancellation, project/prompt dirty navigation, modal layering, and test-state reset are fixed. The single-key log-cache claim is wrong because `clearPersistedTicketLogs` already calls the broad `clearServerLogCache`. Beads accessibility is assigned to PR165; Manual QA and other cross-PR items are recorded below. |
| 5714258893 | looptroop-ai | mixed | U06 is PR165, U21/U23/native history are root-owned, U18 is PR167, and the accepted create-success choice is fixed by the mounted TicketForm/ProjectForm transitions. Dropdown capture behavior, broad SSE invalidation, preview state, and route-effect dependencies are intentional and covered by existing tests; no safe independent change was justified. Full-ticket normalization now has validated optional-field coverage. |
| 5714264614 | looptroop-ai | correct / fixed | Live AI rows now use a total timestamp/identity order when interleaved with historical rows; non-AI server order remains intact. The LogContext regression covers an older unkeyed live row. |
| 5714296137 | looptroop-ai | correct / fixed | The owner chose to preserve newer project typing and switch to the returned project. ProjectForm keeps the mounted draft, changes to Save Changes, and PATCHes the returned project ID; identity-only folder/short-name fields lock while creation is pending because the existing PATCH contract cannot change them. |
| 5714331073 | looptroop-ai | mixed | Tombstoned identities no longer make a whole snapshot non-authoritative; healthy rows are pruned and timers advance. Arbitrary tombstone expiry is deferred because it could resurrect a resolved request. FolderPicker, drain, comparator, and retry issues are fixed. U06/U18/cross-PR cache concerns are dispositioned above. |
| 5714615236 | looptroop-ai | mixed | Hydration commits the calculated baseline immediately, preventing a commit-window edit from leaving `isDirty` false. FolderPicker retry/timer and reset-state issues are fixed. Dropdown nested-overlay ownership, tombstone expiry, and rapid modal reopen had no safe reachable regression beyond existing tests; z-order is fixed at `z-[70]`/`z-[80]`. |
| 5714879877 | looptroop-ai | correct / fixed | Drain ownership is scoped per query key with independent caller cancellation; uncancellable callers contribute a non-canceling predicate, scope identity fences A→B→A reuse, and `drainError` clears on scope changes. The history suite passes 29 tests. |
| 5714893619 | looptroop-ai | correct / fixed | Generation is checked before clearing the Git debounce timer; the timer clears only after its current generation starts, and a stale-listing regression proves the current check remains pending. |
| 5717815384 | codacy-production | accepted | Codacy again reported zero new issues after the later changes. |
| 5717851535 | sonarqubecloud | accepted | Sonar quality gate passed with no new issues or security hotspots. The two native S2871 sorts and unused helpers are handled by `89e8c485`. |

## Inline comments

| Comment ID | Author | Disposition | Evidence / decision |
| --- | --- | --- | --- |
| 4036449249 | qodo-code-review | correct / fixed | `fetchAllOlder` and `requestOlderPage` now bind in-flight work to the current query scope; scope identity and mixed-caller cancellation regressions pass. |
| 4036449255 | qodo-code-review | correct / fixed | `App` confirms dirty routed forms on Back/Forward and restores the modal route when the user declines. |
| 4036449262 | qodo-code-review | wrong under the accepted contract | Equal-length plan/expanded arrays are positional by design: expansion preserves order and count while execution IDs may be renamed. The consolidated disposition contains the permanent contract evidence. |
| 4036449266 | qodo-code-review | correct / fixed elsewhere | The native owner’s projection change in `89e8c485` detects same-size mtime rewrites and has a permanent regression test. |
| 4036468320 | chatgpt-codex-connector | correct / fixed | `normalizeTicketPatch` now validates and preserves pending questions, Manual QA metadata/origin, policy/source fields, council variants, and PR165’s optional `runtime.beadsDiagnostics.readError`; the normalization test covers the full patch shape. |
| 4036470099 | greptile-apps | correct / fixed | A new scope starts its own Go-to-top/full-history drain instead of awaiting the canceled prior scope. |
| 4036470105 | greptile-apps | wrong under the accepted contract | Same rationale as 4036449262: ID pairing would contradict the server’s ordered expansion contract for equal-length arrays. |
| 4036470113 | greptile-apps | correct / fixed | `/api/models` returns `OPENCODE_UNREACHABLE` or `OPENCODE_DISCOVERY_FAILED`; client retry logic uses those codes rather than English text and does not retry arbitrary HTTP 500 responses. |

## Review records

| Review ID | Author | Disposition |
| --- | --- | --- |
| 5235138846 | sourcery-ai[bot] | not-applicable; review was skipped because the diff exceeded its review limit. |
| 5235143595 | amazon-q-developer[bot] | accepted; positive review with no blocking issue. |
| 5235160120 | qodo-code-review | not-applicable; empty review record. |
| 5235183202 | chatgpt-codex-connector | not-applicable; empty/status-only review record. |
| 5235185379 | greptile-apps | not-applicable; empty/status-only review record. |
