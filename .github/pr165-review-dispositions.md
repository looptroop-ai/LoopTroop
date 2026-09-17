# PR 165 review dispositions

This ledger covers every review, issue comment, inline comment, and check
summary captured in `/tmp/looptroop-pr-review/165.md` and its JSON snapshot.
The source snapshots predate the final fixes on this branch, so external
quality checks need a rerun after this commit. No E2E or full lifecycle test is
claimed here.

## Findings and comments

| ID | Disposition | Evidence and action |
| --- | --- | --- |
| 5706627136 | Not applicable — informational | Codex review summary only; its actionable observations are recorded under their individual comments below. |
| 5706629493 | Not applicable — quality warning | CodeRabbit walkthrough and 35.34% docstring-coverage warning identify a non-gating style metric, not a correctness defect. Bulk docstrings were not added; behaviour is covered by focused tests. |
| 5706636537 | Not applicable — informational | Qodo summary/assessment only; actionable observations are tracked by their specific findings. |
| 5706636785 | Correct — external rerun pending | Codacy reported `ACTION_REQUIRED` and 11 new findings, but the captured detail page is unavailable. Overlapping parser and editor findings were fixed or assessed here; the fresh Codacy result must be checked after push. |
| 5706648553 | Correct — fixed | Persisted Manual QA repair candidates now use schema version 2; stored version 1 candidates are discarded for regeneration. Tests cover read, write, and legacy-version handling. |
| 5706649782 | Correct — fixed, rerun pending | Sonar's green quality gate still listed 4 regex-complexity findings and 7 label-control findings in the pre-fix snapshot. Parser scans are bounded/linear and editor headings are no longer label elements; focused tests and typecheck pass. Sonar must rerun on the final commit. |
| 5706662691 | Correct — fixed | Approval sends the current fetched content hash, not the immutable draft baseline hash; refresh and approve tests cover the distinction. |
| 5706663126 | Correct — fixed | Greptile's two approval-baseline defects are addressed: the current hash is sent on approval, and optional UI-state failure no longer disables approval. |
| 5714088380 | Correct — fixed/narrowed | Runtime tracker read failures now stay in per-ticket diagnostics; stale approval hashes, literal block-scalar preservation, unknown statuses, and the adapter's diagnostic skip are fixed. The suggested broad P10 expansion was narrowed to the relevant helper regression. |
| 5714176184 | Correct — fixed | Partial nested collection normalization, unknown status validation/reconciliation, cycle-path diagnostics, and canonical-empty alias precedence are covered by parser/route tests. |
| 5714227628 | Correct — fixed | Anchored and tagged block-scalar headers share the bounded repair grammar and preserve their bodies; YAML regression tests cover both forms. |
| 5714278243 | Correct — fixed | Raw string `free_text` values are preserved while non-string values receive schema-directed repair; the selective merge regression covers valid folded prose beside a malformed value. |
| 5714282549 | Mixed — fixed where in scope; deferred elsewhere | Alias precedence and changelog scope were corrected, and parser hash/integration coverage remains. ArtifactContentViewer positional pairing (P12/P13), interview timestamps, and the uncertain-node standalone-test request remain outside this part and are owned by root/other work. |
| 5714328979 | Not applicable — informational | Muse pass 1 reported no in-scope finding. |
| 5714613170 | Mixed — fixed/narrowed | Adapter diagnostics use `malformedEntries: 'skip'`; priority/iteration producers validate positive integers. The proposed generator skip is rejected as wrong for checklist generation: omitting a damaged bead could silently reduce verification scope, so the generator remains fail-closed. Unrelated operation-reader items remain outside this part. |
| 5714878772 | Mixed — fixed/deferred | Runtime read errors, cycle paths, adapter diagnostics, and UI-state approval failure are fixed. The interview warning-test gap is outside PR 165's bead/parser scope. |
| 5714892772 | Mixed — fixed/deferred | Partial nested collections, adapter skip, duplicate block handling, and cycle diagnostics are fixed; snake_case retry/finalization note aliases are now covered. Interview timestamps and ArtifactContentViewer P12/P13 remain outside this part. |
| 5229770199 | Not applicable — informational | Sourcery reported the diff-size threshold; it supplied no correctness finding. |
| 5229771908 | Not applicable — informational | Amazon Q gave a positive assessment and a diff-size warning; no actionable defect was identified. |
| 5229782329 | Not applicable — empty review | Qodo review contained no finding. |
| 5229790240 | Not applicable — empty review | Gitar review contained no finding. |
| 5229791738 | Not applicable — empty review | Greptile review contained no finding. |
| 5229815088 | Not applicable — metadata/summary | Codex review metadata and summary contain no additional finding beyond the linked comments. |
| 5229826168 | Correct — addressed | CodeRabbit's four actionable areas are covered by parser repairs, free-text preservation, bounded scans, and editor accessibility/argument controls. |
| 4032034647 | Correct — fixed | Manual QA candidate persistence now writes and reads schema version 2 and regenerates version 1 data. |
| 4032042308 | Correct — fixed | Approval uses the fetched current content hash in its request. |
| 4032043499 | Correct — fixed | The approval button is not disabled by failed optional UI-state loading; the regression mocks that failure and approves loaded beads. |
| 4032043506 | Correct — fixed | Refetches update the approval hash while retaining the draft baseline; stale-save and approval tests cover the two hashes. |
| 4032064296 | Correct — fixed | Runtime tracker reads isolate non-ENOENT failures, retain healthy tickets, and expose `readError` diagnostics to the client warning surfaces. |
| 4032064301 | Correct — fixed | Source-line metadata moved into the PUT body envelope with exact-count, positive, strictly increasing validation; no unbounded custom header is used. |
| 4032074744 | Correct — fixed | PRD warning text now says document-level edits are not listed in the change set. |
| 4032074757 | Correct — fixed | Block-scalar repair recognises bounded anchor/tag properties without rewriting the scalar body. |
| 4032074763 | Correct — fixed | WeakSet cycle protection is used for free-text traversal, with a regression for cyclic values. |
| 4032074766 | Correct — fixed/expanded | Structured editor group headings use non-label containers, native fields have unique names, and command arguments now use individual literal textareas so sequential edits cannot revert. |

## Check and tooling notes

The captured CI set was green for workflow lint, unit/integration checks,
build/package checks, CodeQL, and the Sonar quality gate. The same capture
reported CodeRabbit's non-gating docstring metric, Codacy `ACTION_REQUIRED`,
and a Kilo Code Review failure without a downloadable detail payload. Sourcery
was skipped by the diff-size rule. Central logs also contain dependency and
runtime deprecation warnings; those are not treated as dependabot noise and
remain follow-up work for the workflow owner. The final branch commit needs a
fresh external run to resolve the Codacy/Kilo/Sonar pending statuses.

Focused verification on this branch:

- `npx vitest run src/components/workspace/__tests__/BeadsApprovalEditor.test.tsx src/components/workspace/__tests__/ApprovalView.test.tsx server/phases/beads/__tests__/beadsFile.test.ts server/structuredOutput/__tests__/yamlUtils.test.ts` — 4 files, 121 tests passed.
- `npm run typecheck` — passed.
- Earlier parser/beads/route focused packet — 436 tests passed; root owns the aggregate suite, lint, build, and integration checks.
