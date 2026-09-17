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
| 5706636785 | Correct — fixed; external rerun pending | Codacy's current PR 165 check run `105297465626` reported `ACTION_REQUIRED` with 11 GitHub annotations. All 11 low-risk lint findings are fixed here: two test non-null assertions, one impossible navigator header guard, seven editor callback bodies, and one accessibility-test non-null assertion. |
| 5706648553 | Correct — fixed | Persisted Manual QA repair candidates now use schema version 2; stored version 1 candidates are discarded for regeneration. Tests cover read, write, and legacy-version handling. |
| 5706649782 | Correct — fixed, rerun pending | Sonar's green quality gate still listed 4 regex-complexity findings and 7 label-control findings in the pre-fix snapshot. Parser scans are bounded/linear and editor headings are no longer label elements; focused tests and typecheck pass. Sonar must rerun on the final commit. |
| 5706662691 | Correct — fixed | Approval sends the current fetched content hash, not the immutable draft baseline hash; refresh and approve tests cover the distinction. |
| 5706663126 | Correct — fixed | Greptile's two approval-baseline defects are addressed: the current hash is sent on approval, and optional UI-state failure no longer disables approval. |
| 5714088380 | Correct — fixed/narrowed | Runtime tracker read failures now stay in per-ticket diagnostics; stale approval hashes, literal block-scalar preservation, unknown statuses, and the adapter's diagnostic skip are fixed. The suggested broad P10 expansion was narrowed to the relevant helper regression. |
| 5714176184 | Correct — fixed | Partial nested collection normalization, unknown status validation/reconciliation, cycle-path diagnostics, and canonical-empty alias precedence are covered by parser/route tests. |
| 5714227628 | Correct — fixed | Anchored and tagged block-scalar headers share the bounded repair grammar and preserve their bodies; YAML regression tests cover both forms. |
| 5714278243 | Correct — fixed | Raw string `free_text` values are preserved while non-string values receive schema-directed repair; the selective merge regression covers valid folded prose beside a malformed value. |
| 5714282549 | Mixed — fixed or accepted design | Alias precedence and changelog scope were corrected, and parser hash/integration coverage remains. P12/P13 intentionally pair equal-length expansion arrays positionally because expansion renames IDs while preserving order and count; this is an implemented owner decision, not deferred work. Interview timestamp validation is covered in PR 167; uncertain-node standalone coverage belongs to PR 163. |
| 5714328979 | Not applicable — informational | Muse pass 1 reported no in-scope finding. |
| 5714613170 | Mixed — fixed/narrowed | Adapter diagnostics use `malformedEntries: 'skip'`; priority/iteration producers validate positive integers. The proposed generator skip is rejected as wrong for checklist generation: omitting a damaged bead could silently reduce verification scope, so the generator remains fail-closed. Unrelated operation-reader items remain outside this part. |
| 5714878772 | Correct — fixed across packets | Runtime read errors, cycle paths, adapter diagnostics, and UI-state approval failure are fixed here. PR 167 preserves rejected-candidate interview warnings and adds the missing regression. |
| 5714892772 | Mixed — fixed or accepted design | Partial nested collections, adapter skip, duplicate block handling, and cycle diagnostics are fixed; snake_case retry/finalization note aliases are covered. PR 167 verifies interview timestamp validation. P12/P13 retain the accepted positional expansion contract described above. |
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

### Review refresh

- `4038574570` and review `5237878160`: correct, fixed. Raw YAML string restoration matches exact keys before aliases, preserving distinct canonical and aliased answers in either order.
- `4038675631`: correct, fixed. Primary-key repair now enters block-scalar mode for sequence headers; a regression preserves literal nested dash text and repairs the next real item.
- `4038675647`: correct, fixed. Accessible command names use an explicit item label instead of adjacent ambiguous numbers.
- Reviews `5238007388` and `5238650175`: correct outside-diff observations, fixed. Unknown stored statuses remain visible as unrepresentable rows and block structured saves and approval; recognised aliases remain supported. Edit and Save require an artifact baseline hash. Runtime diagnostic reads retain their separately documented fallback.
- `5716846598`: informational review acknowledgement, no additional defect.
- `5717458997`: fresh Sonar quality gate passed with no open findings.
- `5716828825`: the captured Codacy review summary reported 13 findings; the later GitHub check run `105297465626` exposed the exact 11 annotations listed below, all fixed in this follow-up.
- Codacy check run `105297465626` at head `0fb3a3ce` was `ACTION_REQUIRED` with these annotations: `server/structuredOutput/__tests__/beadStatusAndIteration.test.ts:302,303` forbidden non-null assertions; `src/components/navigator/BeadsApprovalNavigator.tsx:30` unnecessary always-falsy conditional; `src/components/workspace/BeadsApprovalEditor.tsx:161,167,203,209,213,219,225` forbidden void-expression arrow callbacks; and `src/components/workspace/__tests__/BeadsApprovalEditor.test.tsx:39` forbidden non-null assertion. The GitHub annotations API was available even though Codacy's detail page returned only its application shell.
- Kilo check run `105296249091` was later completed as `cancelled` with zero annotations because a newer commit superseded it. Its provider detail page requires sign-in, so it supplied no source finding to classify.
- Refreshed `5706629493`: the non-gating docstring percentage is not a request for boilerplate; the concrete outside-diff defects are covered above. Refreshed `5706648553` marks the candidate schema issue resolved; `5706663126` includes the alias defect now fixed. Updated existing inline comments mark their earlier findings resolved.

The refresh regressions and affected parser, route, document and UI suites passed: 460 tests across six files. The complete suite and cross-PR checks are run separately after integration.

Root's integration review also removed the list fields' competing
`aria-labelledby` attributes: those overrode the numbered `aria-label` names.
The editor test now checks the computed accessible names of two list items.

The captured CI set was green for workflow lint, unit/integration checks,
build/package checks, CodeQL, and the Sonar quality gate. The same capture
reported CodeRabbit's non-gating docstring metric and Codacy `ACTION_REQUIRED`;
the 11 Codacy annotations are fixed by this follow-up. Kilo's review was later
cancelled as superseded and had no annotations. Sourcery was skipped by the
diff-size rule. Central logs also contain dependency and runtime deprecation
warnings; those are not treated as dependabot noise and remain follow-up work
for the workflow owner. The final branch commit needs a fresh external Codacy
run after these fixes.

Focused verification on this branch:

- `npx vitest run src/components/workspace/__tests__/BeadsApprovalEditor.test.tsx src/components/workspace/__tests__/ApprovalView.test.tsx server/phases/beads/__tests__/beadsFile.test.ts server/structuredOutput/__tests__/yamlUtils.test.ts` — 4 files, 121 tests passed.
- `npm run typecheck` — passed.
- Earlier parser/beads/route focused packet — 436 tests passed; root owns the aggregate suite, lint, build, and integration checks.

Root verification after follow-up fixes: all 422 test files passed (6,082 tests,
10 skipped), full lint and build passed, and the full application/test
typecheck passed. The initial aggregate failure was a stale reader expectation
for safely defaulted collections; its corrected regression still rejects
malformed commands and evidence. Website updates are on main through
`3968e13`, with 87 tests, the site build and published-reference checks passing.

Codacy follow-up `105307286454` repeats ten annotations on code already corrected
in `ee1efc34` (the indexed assertions, navigator guard, and editor callbacks).
It also reports a block-scoped function declaration in `dependencyGraph.ts`.
The cycle walker is now a block-scoped function expression, retaining the same
closure and recursion without widening its scope. No suppression was added.
