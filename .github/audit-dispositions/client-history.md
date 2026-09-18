# Client history and state audit ledger

This ledger records the bounded client/history findings and their dispositions
for PR169's second review. The client fixes below have passed their focused
checks; the root owner owns the merged-branch aggregate checks.

The follow-up review keeps the same scope: cursorless SSE recovery is re-armed
for each connection, while non-zero cursors remain replay-quiet; nested partial
ticket patches preserve cached siblings; delayed project restoration cannot
overwrite later typing; and Ticket/Profile Cancel uses the existing dirty
confirmation. Reset-all prompts now carry a request identity through active
refetch, and project creation adopts the returned canonical repository root.
Dirty modal backdrops use the same confirmation as Escape and the close button.
The initial-list pop/error route edge is fixed in the App handoff, and native
reader changes are committed by the native owner in `89e8c485`.

## Scope and boundaries

The reviewed client changes stay within the existing client/history surface.
Overlapping files were merged by focused hunks rather than copied from a
later whole-file snapshot:

- routing and overlays retained the existing URL/focus foundation;
- recovery and cache changes share the existing query-key collector, delete
  event, cursor-generation fence and UI-state revision handoff;
- forms added explicit semantic dirty state to the routed modal callers and
  preserved the overlay and focus behavior;
- the final historical-log stage changed `isCancelledError` to the existing
  `@tanstack/react-query` export, with no dependency change.

No website, package, lockfile, generated notice, Git, E2E, lifecycle, or
dependency files were changed by this client handoff.

## Findings

| Area | Status | Coverage |
| --- | --- | --- |
| Routed dialogs and forms | PASS | URL ownership, focus/overlay behavior, semantic dirty state, async hydration, failed saves, later edits, model-picker accessibility, folder retry and prompt-preview fencing are covered by the direct client tests. |
| Questions and live streams | PASS | Request/session tombstones, ticket-scoped gap recovery, bounded session probing, startup-only model retry, initial cursor recovery and replay-gap behavior are covered by actual hooks and their fixtures. |
| Full log history | PASS | Retained snapshots, model/phase/attempt scope, explicit full drains, export/navigation actions, typed cursor expiry and diagnostics are covered by server projection/route tests and client log views. |
| Normalization and deletion | PASS | Strict detail reads, tolerant list rows, sparse patch validation, complete ticket-keyed cache cleanup, delete barriers, late GET/save fences, pending-question cleanup and reissued cursor fencing are covered without touching another ticket. |

The detailed review evidence is in the PR169 comment, delta, CI, and finding
packets supplied to the review; this ledger records the resulting decisions.

## Verification and limits

- Focused client regressions pass, including 21 prompt-reset tests, 45 App
  route tests, and the retained project, log, SSE, modal, and cache suites.
- `npm exec tsc -- --noEmit -p tsconfig.tests.json`: passed.
- ESLint over the retained client source and tests: passed with no issues.
- `git diff --check`: clean.

The full local build, package/version, native-addon, installer, license and
platform checks are recorded separately in the final evidence. No browser E2E,
full lifecycle, live provider/GitHub, native Windows/macOS, or publication run
is claimed here. The root worker owns the merged-branch aggregate review and
final acceptance.
