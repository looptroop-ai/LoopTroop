# PR169 review dispositions

This ledger records every review record in the refreshed PR169 snapshot (`169-refresh.json`), including automated summaries, inline comments, and empty review records. The consolidated audit dispositions and `169-handoff.md` remain the authority for work assigned to another PR. The owner chose to retain edits made during creation and transition the mounted form to the item returned by the server; PR169 implements that choice for tickets and projects.

## Evidence

The independent PR169 changes are covered by these focused checks:

- `npx vitest run --project client-dom src/components/project/__tests__/ProjectForm.test.tsx src/components/project/__tests__/FolderPicker.test.tsx src/components/shared/__tests__/CenteredModal.test.tsx src/components/shared/__tests__/KeyboardShortcuts.test.tsx src/components/ticket/__tests__/renderedTickets.test.ts src/context/__tests__/AIQuestionContext.test.tsx src/context/__tests__/LogContext.test.ts src/hooks/__tests__/useTicketHistoricalLogs.test.tsx src/hooks/__tests__/useOpenCodeModels.test.ts src/lib/__tests__/ticketNormalization.test.ts` — 9 files, 131 tests passed before the follow-up drain regression; the focused history suite now passes 29 tests.
- `npx vitest run --project server-integration server/routes/__tests__/models.test.ts` — 1 file, 4 tests passed.
- ESLint over every changed source and test file — no issues.
- The Sonar duplication snapshot’s three changed test files are reduced with shared `SnapshotRecovery`, history-response, and JSON-response fixtures; their focused regressions pass (3 files, 52 tests). The snapshot’s two native S2871 records are stale against root’s `baa491b9` deterministic comparators; no exclusion was added.
- The merged branch passed `npm run lint`, `npm run typecheck`, and `npm run build`; the test-only fixture refactor was then rechecked with the focused suite and ESLint.
- The create-race regressions pass in the focused client suite (25 tests): a later ticket/project edit changes the action to Save and PATCHes the server-returned ID, while the original create runs once. Create-and-start also records the returned running status and omits draft-only ticket settings from the later PATCH.
- The first `npx tsc --noEmit --pretty false` run caught the new deferred-response test’s too-narrow resolver type; it is corrected to accept `PromiseLike<Response>`. Root’s aggregate typecheck is the final verification for the merged branch (the local rerun was not repeated while that aggregate check was running).

The native-log same-size rewrite, native session discovery, unused snapshot helpers, and deterministic sort are owned by the root agent in commit `baa491b9`; they are referenced below and are not duplicated here. Beads-editor accessibility belongs to PR165; Manual QA hooks belong to PR167. No E2E or full-lifecycle run is claimed.

## Issue comments

| Comment ID | Author | Disposition | Evidence / decision |
| --- | --- | --- | --- |
| 5713776135 | coderabbitai | not-applicable | Review was explicitly skipped on this non-default branch; it contains no finding. |
| 5713776510 | chatgpt-codex-connector | not-applicable | Status summary only; the underlying inline findings are recorded below. |
| 5713788731 | codacy-production | accepted | Codacy reported zero new issues. The changed files also pass the focused ESLint check. |
| 5713799265 | qodo-code-review | accepted as summary | High-level description and alternatives; each actionable observation is dispositioned by its own record below. |
| 5713805572 | qodo-code-review | correct / fixed | Same-size native rewrite now uses changed mtime; root added the regression in the native projection tests (`baa491b9`). Its drain, draft, and retry observations are covered by the corresponding rows below. |
| 5713815929 | gitar-bot | deferred / superseded | The reported atomicIO and session-manager CI failures came from the earlier cross-PR state and are owned by the 164/root aggregate work. They are not silently ignored or attributed to PR169; root’s aggregate checks are the final evidence. |
| 5713837819 | greptile-apps | mixed | The history-drain and startup-retry findings are fixed here. Equal-length bead expansion remains intentionally positional: `orchestration.md` and the consolidated disposition record the server order/count contract, so changing it to ID matching would be a regression. |
| 5714101041 | looptroop-ai | mixed | Drain scope, model retry codes, DEBUG interleaving, applied snapshot generations, and full-ticket patch fields are fixed. Native helper cleanup is in `baa491b9`. The accepted create-success choice is fixed: later edits stay mounted and the form adopts the returned ticket/project identity for its next save. |
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
| 5717851535 | sonarqubecloud | accepted | Sonar quality gate passed with no new issues or security hotspots. The two native S2871 sorts and unused helpers are handled by `baa491b9`. |

## Inline comments

| Comment ID | Author | Disposition | Evidence / decision |
| --- | --- | --- | --- |
| 4036449249 | qodo-code-review | correct / fixed | `fetchAllOlder` and `requestOlderPage` now bind in-flight work to the current query scope; scope identity and mixed-caller cancellation regressions pass. |
| 4036449255 | qodo-code-review | correct / fixed | `App` confirms dirty routed forms on Back/Forward and restores the modal route when the user declines. |
| 4036449262 | qodo-code-review | wrong under the accepted contract | Equal-length plan/expanded arrays are positional by design: expansion preserves order and count while execution IDs may be renamed. The consolidated disposition contains the permanent contract evidence. |
| 4036449266 | qodo-code-review | correct / fixed elsewhere | Root’s native projection change in `baa491b9` detects same-size mtime rewrites and has a permanent regression test. |
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
