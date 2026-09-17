# Client history and state audit ledger

This ledger records the bounded client/history packet assembled on the
immutable part5 base. `PASS, final pending` means the packet evidence and
isolated checks passed; it is not final acceptance of the branch.

## Scope and boundaries

The source is the exact six-stage manifest in
`/tmp/looptroop-client-part-manifest.json`, applied through the stage-specific
`from` and `to` ranges in `/tmp/looptroop-client-part-provenance.json`. The
assembly was performed in `/tmp/looptroop-client-pr.QktOqU` from
`431663e0530769a34fc5e064a925394a7dd90336`.

Only the manifest paths were changed. Overlapping files were merged by
stage-specific hunks rather than copied from a later whole-file snapshot:

- routing and overlays retained the existing URL/focus foundation;
- recovery and cache changes share the existing query-key collector, delete
  event, cursor-generation fence and UI-state revision handoff;
- forms added explicit semantic dirty state to the routed modal callers and
  preserved the overlay and focus behavior;
- the final historical-log stage changed `isCancelledError` to the existing
  `@tanstack/react-query` export, with no dependency change.

No website, package, lockfile, source outside the exact manifest, generated
notice, Git, E2E, lifecycle, or dependency files were changed.

## Findings

| Area | Status | Coverage |
| --- | --- | --- |
| Routed dialogs and forms | PASS, final pending | URL ownership, focus/overlay behavior, semantic dirty state, async hydration, failed saves, later edits, model-picker accessibility, folder retry and prompt-preview fencing are covered by the direct client tests. |
| Questions and live streams | PASS, final pending | Request/session tombstones, ticket-scoped gap recovery, bounded session probing, startup-only model retry, initial cursor recovery and replay-gap behavior are covered by actual hooks and their fixtures. |
| Full log history | PASS, final pending | Retained snapshots, model/phase/attempt scope, explicit full drains, export/navigation actions, typed cursor expiry and diagnostics are covered by server projection/route tests and client log views. |
| Normalization and deletion | PASS, final pending | Strict detail reads, tolerant list rows, sparse patch validation, complete ticket-keyed cache cleanup, delete barriers, late GET/save fences, pending-question cleanup and reissued cursor fencing are covered without touching another ticket. |

The detailed packet evidence is in `/tmp/looptroop-client-part-evidence.md`.
The source packets used during assembly were the recovery, forms, log-history
and ticket-cache evidence files in `/tmp/looptroop-client-*-evidence.md`.

## Verification and limits

- Focused client tests: 25 files, 575 passed.
- Focused server log tests: 2 files, 44 passed.
- Full Vitest: 430 files, 6,269 passed and 12 skipped (6,281 total).
- `npm run typecheck`: passed for the application and test TypeScript projects.
- `npm run lint`: passed with no issues.
- `git diff --check`: clean before documentation edits.

The full local build, package/version, native-addon, installer, license and
platform checks are recorded separately in the final evidence. No browser E2E,
full lifecycle, live provider/GitHub, native Windows/macOS, or publication run
is claimed here. The root worker still owns fresh aggregate review and final
acceptance.
