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

## Round 2 dispositions and implementation

The second-pass comments below were correlated with the current source before
editing. This section includes the review comments, provider summaries, and
tooling noise captured after the prior ledger section; no external review
comment was dismissed by this change.

| ID | Disposition | Evidence and action |
| --- | --- | --- |
| 5719012357 | Not applicable — quality gate summary | Sonar's captured gate was green; its summary supplied no new correctness finding. The final branch still needs the external rerun owned by the root agent. |
| 5719175022 | Mixed — fixed or accepted design | The missing approval array checks and command metadata concern are fixed below. P12 remains the accepted equal-length positional expansion mapping, and the low source-tree cache-test concern remains covered by the existing source-fingerprint regression. |
| 5719176400 | Correct — fixed | Block-scalar ownership now recognises compact nested sequence headers, standalone indicators, quoted sequence keys, and header comments; literal bodies remain outside formatting repairs. |
| 5719224699 | Correct — fixed | Nested sequence literal HTML and standalone duplicate-looking literal lines now survive unrelated repair. Valid folded `free_text` keeps its folded value when a sibling needs reserved-indicator repair. |
| 5719265936 | Mixed — fixed or accepted design | The client now caches the canonical response tuple and matching hash. The server's explicit canonical-empty precedence remains authoritative, so a canonical empty list still clears a populated alias. Test fixtures also isolate the priority assertion. |
| 5719271096 | Mixed — fixed or accepted design | Unknown command metadata survives validated PUT saves, and the canonical response is returned to the editor. The JSONL-only damaged-row gate is documented; fail-closed authoritative reads and legacy bare-command handling remain deliberate contracts. Raw internal read errors and the optional details-shape compatibility concern are outside this scoped fix. |
| 5719612344 | Mixed — fixed or accepted design | Duplicate-key standalone scalar tracking and the nested block-scalar gaps are fixed with focused regressions. The no-slot failure tracker and missing lower-priority tests are not correctness blockers for this parser change. |
| 5720123441 | Not applicable — resolved/low-risk follow-up | P13 is already resolved and P12 remains the owner-approved positional mapping. The duplicated helper/performance and non-record normalization observations are low-risk follow-ups with no behavior change here. |
| 5720939642 | Correct — fixed or accepted design | Approval now requires prompt-executed arrays, QA provenance validates the nested values the adapter dereferences, and authoritative reads reject duplicate IDs. The low 409 presentation wording concern remains protocol-compatible and outside this fix. |
| 5716828825 | Not applicable — stale provider summary | The Codacy summary counted findings; the concrete annotations and their dispositions are recorded in the prior ledger. |
| 5716846598 | Not applicable — provider status noise | Gitar's pause acknowledgement supplied no source finding. |
| 105297465626 | Correct — fixed; rerun pending | The captured Codacy annotations were already fixed in `ee1efc34`/`bca91e58`; a fresh provider run is still required on the final branch. |
| 105307286454 | Not applicable — stale provider annotations | The follow-up repeated old locations already fixed by the indexed assertions, navigator guard, editor callbacks, and scoped cycle-walker change. |
| 105296249091 | Not applicable — cancelled tool run | Kilo was cancelled with no annotations after a newer commit superseded it; it supplied no code failure. |
| 5229770199 | Not applicable — rate/diff-size tool noise | Sourcery skipped review because the diff exceeded its configured size; it supplied no source finding. |

The shared CI note for this pass is recorded in `CHANGELOG.md`: native
canonical paths and isolated integration tests cover the fixture-sensitive
routes without changing the shared `node_modules` symlink.

## Round 3 dispositions and implementation

The fresh round-3 comments were rechecked against this branch. The following
items are implemented here unless explicitly marked as an accepted contract or
root-owned website work. No E2E or full lifecycle test is claimed.

| ID | Disposition | Evidence and action |
| --- | --- | --- |
| 5726611317 | Accepted contract; client fixed | Canonical non-nullish values, including explicit empty strings, lists, and records, remain authoritative over aliases. Client readers, guidance/command checks, and alias stripping now match the server; conflicting-alias rejection is not added. |
| 5726634915 | Mixed — parser fixed; website root-owned | Compact nested sequence headers enter the shared block-scalar guard before list fast paths, structural dash detection ignores comment/chomping hyphens, and the exact scalar body survives colon/dedup repairs. The JSONL-only PUT 422 and `X-Edit-Surface` documentation remains root-owned. The exact 422 payload is `{ error: "Damaged bead plan must be repaired in JSONL mode", details: "The structured editor cannot preserve every stored row.", malformedLines: number[], unrepresentableLines: number[] }`. |
| 5726705885 | Fixed or accepted design | Quoted sequence mapping keys now retain their block body boundary; approval rejects missing status or priority without defaults; client canonical-empty precedence is covered by focused tests. |
| 5726962772 | Fixed | Reserved-indicator repair no longer returns before nested-mapping and `free_text` repairs. Valid folded text is restored from the successful reserved-only parse, while non-string `free_text` receives the schema-directed string repair; warning regressions cover both paths. |
| 5727030583 | Fixed | Malformed or empty JSON bodies return HTTP 400 with `{ error: "Invalid JSON body" }` and do not write a ticket file; valid non-array JSON keeps its existing 400 response. |
| 5725459146 | Fixed; external rerun pending | Codacy action-required annotations from the captured review are addressed by the branch fixes; the provider must rerun on the final commit. |
| 5725705604 | Assessed; no expansion | Sonar's two regex-complexity warnings are non-gating. The compact-header changes use bounded literal regexes and a comment-stripped structural prefix; no broad refactor or suppression was added. |

Focused verification on this branch:

- `npx vitest run shared/__tests__/yamlRepair.test.ts server/structuredOutput/__tests__/yamlUtils.test.ts src/lib/__tests__/beadsDocument.test.ts server/phases/beads/__tests__/document.test.ts server/routes/__tests__/beads.test.ts` — 5 files, 504 tests passed.
- `git diff --check` — passed.

The root integrator owns the full aggregate checks, website docs, shared CI, and
the final external review reruns.
