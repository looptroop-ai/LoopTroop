# PR21 review dispositions

Review baseline: PR #158 at `d313cf6b`, 2026-09-13. All eight local reports in `tmp/pr21`, all GitHub review threads and comments, and both CI runs were read before changes. Reports remain local and untouched. This is a review snapshot, not ongoing product documentation.

## Owner decisions preserved

- Keep provider-collapse controls above the model results.
- Return the complete model catalog with newest history responses, independent of filters and page limits.
- Keep **Copy failed** visible for the same target until success. The owner additionally approved clearing it on target changes and announcing every failed retry. Streaming updates within the same bead-log target do not reset feedback.
- Recover AI-only surviving log records, remove mirrored duplicates, and order AI history by timestamp with a stable tie-breaker. Normal and system views retain their existing ordering.

## Decisions by topic

| ID | Finding and disposition |
| --- | --- |
| L1 | **Fixed:** repeated JSON parsing in model discovery and AI filtering. Derive model identity and AI membership during projection ingestion; query stored columns. Measure the representative workload and retain complete metadata on newest responses. No new metadata endpoint, request flag, or compatibility fallback. |
| L2 | **Fixed differently:** the AI projection was unread, but deleting it would lose audit records when the second append fails. Recover surviving AI rows and deduplicate mirrors. Anonymous repeated appends remain distinct; canonical updates retain the latest record. |
| L3 | **Fixed:** share model identity, AI membership, and debug detection across ingestion, live context, and log formatting. Include `model_output`; literal `[DEBUG]` inside model prose must not hide the answer. AI membership remains separate from SYS/overview classification. |
| L4 | **Retained:** session- and OpenCode-attributed system milestones belong in AI history as before on the client. SYS/AI overlap is intentional; membership does not imply exclusive classification. An empty `model:` source must not invent a model tab. |
| L5 | **Rejected:** infer model usage metrics from source-only log attribution. AI-details metrics use explicit persisted metric model IDs; logs do not establish token usage or cost. Shared display identity does not justify inventing metrics. |
| H1 | **Fixed:** store the catalog once per history scope in React Query. Only fresh newest-page responses update it, so cached filter replay and component remounts cannot restore an older catalog. Per-scope request revisions reject delayed responses older than the last successful catalog; a later failed request does not discard an earlier success. Remove wall-clock arbitration and the per-page metadata scan. |
| H2 | **Fixed:** use coherent tab identity for requests, display, metrics, and export, including pending/error states and scope changes. Disable export before initial history is available and cancel obsolete export work. Preserve tabs contributed by live entries. |
| H3 | **Fixed:** export-fetch failure retracts a previous success indicator. Shared export-copy handling resets by target and announces repeated failures. |
| C1 | **Partly accepted:** reset on target changes and reannounce failures; retain persistent same-target feedback per the owner's decision. Reject automatic dismissal and replacing visible wording with a tooltip-only error. |
| C2 | **Fixed:** AppCrashScreen uses the shared clipboard hook and reports denial or a missing API, then clears failure after successful retry. |
| C3 | **Checked/fixed where needed:** keep visible failure next to sticky log actions, keep retry icons visible on failure, and exercise narrow layouts. Compact log typography is intentional. Tooltip Root is a context provider and permits these siblings; no extra wrapper is required solely to satisfy a claimed Radix restriction. |
| A1 | **Rejected:** `aria-selected` must represent only the saved model while navigating. The W3C combobox pattern explicitly uses selection following focus in its listbox; Enter accepts the choice, Escape preserves the saved value. Current value remains identifiable on the contextual trigger. |
| A2 | **Rejected:** a disclosure trigger must claim a dialog or listbox popup. It controls the search surface; the inner combobox controls the actual options-only listbox. A modal role or focus trap would change behavior unnecessarily. The combobox's implicit listbox popup type is sufficient. |
| A3 | **Fixed:** distinguish picker/search names by profile role and include the current choice; safely encode external model/provider IDs; avoid sticky headings covering keyboard-active options; explain when all providers are collapsed. |
| A4 | **Already handled:** global CSS suppresses native WebKit search affordances; no duplicate clear control needs another fix. |
| A5 | **Documented:** Tab moves among search and controls; arrow keys navigate options and Enter accepts. This replaces the old row-by-row Tab navigation. Home/End retain native text editing; list navigation with those keys is optional for editable comboboxes. |
| A6 | **Improved:** setup disclosures expose controlled-panel IDs and hide decorative arrows. `aria-controls` is optional in the W3C disclosure pattern, so its previous absence was not itself a conformance failure. |
| A7 | **Retained:** Enter activates the identified option's existing click handler. Encoded per-instance IDs make the target unambiguous; replacing it with duplicated selection logic brings no functional benefit. |
| T1 | **Fixed:** consolidate repeated panel catalog scenarios with parameterized tests to address Sonar duplication without suppressions. Add focused regressions for recovery, cache remounts, errors, live-only tabs, export races, and repeated copy failure. |
| T2 | **Verify rather than assume:** earlier full local suites and CI passed. No reproducible unawaited-act warning was established from the reports; await meaningful UI transitions in the updated tests and run the full suite. Do not add arbitrary microtask flushing or blanket timeouts. |
| D1 | **Updated:** changelog, implementation snapshot, and published frontend/API docs (marked unreleased). Retain the implementation snapshot as the project's existing review record. No status definitions, prompts, parsers, dependency versions, or ignore rules change. |

## Every local finding

Numbers below match the corresponding report headings; shared topic IDs above avoid repeating the same explanation.

| Report | Findings and decisions |
| --- | --- |
| Claude Opus 5 | 1.1 → L1; 1.2 → L2; 1.3 → L3; 1.4 → retained: raw JSONL can contain debug rows even in the normal channel; 2.1 → H2/T1; 2.2 → H1; 3.1 → C1; 3.2 → C3; 3.3 → C2; 4.1 → A5; 4.2 → A1; 4.3 → A2; 4.4–4.5 → A3; section 5 → D1. |
| Claude Sonnet | 1 → L2; 2 → L3; 3 → C1; 4 → A2; 5 → L1/L3 (SQL substring removed); 6–7 → H1; 8 → C3; 9 → D1; 10 → T2; 11 → L1; 12 → A7. |
| GPT-5.4 | 1 → A3; 2 → H1; 3 → H2; 4 → L1. |
| Gemini 3.8 Flash | 1 → H1; 2 → L1; 3 → A1/A2; 4 → A4; 5 → A3; 6 → C3 (indentation tidied where touched); 7 → A6; 8 → C1; 9 → L3/L4; 10 → T2. |
| Muse Spark 1.3 | 1 → A1; 2 → A2; 3 → C3; 4 → C1; 5 → A6; 6–7 → L3; 8 → H1; 9 → H2 (no extra discovery request); 10 → L1; 11 → H2. |
| OpenCode / MiMo v2.5 | 1 → A2; 2 → already false at the reviewed head: provider controls are outside the listbox, as approved; 3 → C1; 4–5 → C3; 6 → L4; 7 → confirmed bounded prepared-statement cache, no action; 8 → L4; 9 → intentional guarded React state adjustment, no generic prohibition; 10 → H1 (older pages have no catalog); 11 → H2/T1. |
| Grok 4.6 | 1 → H2; 2 → H3; 3 → L1; 4 → H1; 5 → A2; 6 → A6; 7 → L4; 8 → C1/C3; 9 → L4. |
| DeepSeek v4.1 Flash | 1 → T1; 2 → L2; 3 → L3; 4 → L5; 5 → C2; 6 → C1; 7 → H1; 8 → L1; 9 → A6. Its “checked and not defects” conclusions on combobox selection, render-time correction, and explicit owner decisions are retained. |

## GitHub comments and CI

- [Codex AI-only records](https://github.com/looptroop-ai/LoopTroop/pull/158#discussion_r3998816399): accepted, L2.
- [CodeRabbit catalog clock](https://github.com/looptroop-ai/LoopTroop/pull/158#discussion_r3998819067): accepted, H1. Scope-owned request revisions also cover concurrent responses without a wall clock.
- [Qodo stale filters after failure](https://github.com/looptroop-ai/LoopTroop/pull/158#discussion_r3998811713): accepted, H2.
- [Qodo selection semantics](https://github.com/looptroop-ai/LoopTroop/pull/158#discussion_r3998811717): rejected, A1. The top-level review repeats these two findings.
- CodeRabbit's suggested 80% docstring coverage is a generic advisory, not a repository check. Keep useful behavioral comments; do not add repetitive function descriptions merely to increase a ratio. Its title/description and scope checks passed.
- [Greptile target cleanup](https://github.com/looptroop-ai/LoopTroop/pull/158#discussion_r3998909235), added during the follow-up: reproduced with a new-target copy started in a layout effect. Clipboard and export cleanup now run in the layout cleanup phase, before a new target can start work; regression checks fail with the previous passive cleanup.
- Codacy reported zero issues. Gitar and the initial Greptile review reported no actionable defects; the later Greptile finding above is fixed. Sourcery supplied a guide, with its review check skipped for quota. Bot summaries do not supersede the reproduced defects above.
- Baseline CI: 90 successful contexts, three skipped, two failed. All GitHub Actions jobs passed. Sonar failed on **3.8% new-code duplication**, above its 3% limit; T1 addresses the repeated tests. Kilo failed because **the model output limit was reached**, not because it identified a code defect. No gate or warning is suppressed.
- Both Actions logs were inspected. Existing upstream warnings remain covered by the approved exceptions in `security-alert-dispositions.md`: the Node Current npm fallback works as designed; Renovate's current dependency metadata still contains the deprecated chains; the pinned download-artifact action is still the latest release and its [Buffer warning remains open](https://github.com/actions/download-artifact/issues/484). Replacing artifact download with the CLI would remove its digest validation. No warning-only dependency churn is warranted.

Accessibility references: [W3C combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) and [disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/).

## Query measurement

Synthetic in-memory SQLite workload using the baseline and final projection schemas/query fragments: 20,000 normal rows plus 12,000 AI mirrors, 2 KiB content per row, six models, one phase/attempt. After warm-up and ANALYZE, nine runs of model discovery + one model's totals + a 21-row page had median **499.59 ms before / 51.93 ms after**. Both returned 2,000 entries and 4,000 text lines for that model. EXPLAIN confirmed indexed AI/model and mirror lookups. This measures hot-query work; it excludes ingestion, disk catch-up, network, and rendering. Normalized fields and mirror indexes add ingestion/storage work in exchange for avoiding JSON parsing on each read. This is not a whole-application latency claim.

## Additional findings during verification

The independent follow-up review found that AI pagination could repeat an entry if its winning physical mirror changed between page requests. AI cursors therefore use logical entry identity rather than physical channel/position. Cursor fields are validated without string coercion so array-valued fields return a client error rather than reaching SQLite. Regression tests cover both cases.

Full local verification before these final cursor regressions passed: 418 test files, 5,950 passing tests and 10 skipped; lint, typechecking, application build, package contents, native-addon exclusion, type-stripped scripts, licenses, and version checks passed. Final cursor, concurrent-catalog, and copy-cleanup regressions also pass (16 API tests, 102 history/panel tests, and 12 clipboard/export hook tests), with the relevant build/type/lint checks repeated. Chromium component checks at a 400-pixel viewport cover picker navigation under sticky headings, whitespace-containing model IDs, provider collapse/recovery, copy failures/retries, disclosures, and both log export error layouts. These are isolated component fixtures, not ticket lifecycle or end-to-end tests. Website build and site/reference verification passed. Final CI is left for the owner and the PR is not merged.


## Second review: refreshed reports

Baseline: `1f8a3b48`, 2026-09-13. Read all five replacement reports, current CI, PR comments, and reviews before implementation; later CodeRabbit findings were checked too. The local reports were left untouched.

| Finding | Disposition |
| --- | --- |
| Empty export reports failure | **Fixed:** known-empty views disable Copy when no live rows are present. An empty successful response releases the pending state without writing an empty clipboard, showing success, or adding a failure. A previous same-target failure remains until an actual successful copy. Hook and both-panel regressions cover these cases. |
| Status changes clear a row's copy failure | **Fixed:** key feedback by the same logical identity used to merge log rows. Changing status alone preserves feedback; changing the entry clears it. |
| Short log rows hide retry after pointer exit | **Fixed:** the shared row-copy button stays visible on failure and keyboard focus, for both short and long variants. |
| Empty model search is not announced | **Fixed:** expose the existing message as a status region outside the listbox. |
| Copy-failure CSS on Edit title | **Removed:** the pencil does not perform a copy or set that attribute. |
| Bare model output disappears from ALL | **Fixed:** use the existing audience/kind inference before indexing as well as raw-file reads; remove the divergent normalization option. Explicit fields win. Regression checks cover ALL totals, older pages, export, exclusion of tool details before LIMIT, and preserved SYS milestones. |
| Existing projection tables lack new columns | **Valid only for upgrades; outside scope:** the owner explicitly requires fresh installs and no existing-project compatibility. Fresh databases receive the complete schema. No migration or automatic rebuild is added. Existing installations are not claimed to work. |
| Recover AI-only survivors in ALL/ERROR too | **Not applied:** the approved recovery is AI history with timestamp ordering. ALL/ERROR continue reading normal storage. This is a known scope limit, not a claim that every view recovers every survivor. |
| Committed-only `aria-selected`, popup role, or remove trigger `aria-controls` | **Not applied:** A1/A2 still hold. Selection follows focus within the combobox listbox; Enter commits. The outer disclosure controls its own surface and the combobox controls the listbox. Neither a menu claim nor a modal focus trap fits this behavior. |
| Controlled-panel ID missing while collapsed | **No defect:** the panel is unmounted while collapsed; omitting its optional ID reference avoids a dangling target. See the W3C disclosure reference above. |
| Model catalog array changes on every refresh | **Disproved:** a new regression confirms same-content refreshes preserve the model-ID array reference through React Query's default [structural sharing](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults). No custom equality helper is needed. |
| Replace line splitting with a counter or content keys with hashes | **Not applied:** no measured bottleneck was supplied. Line counts are calculated once at ingestion; refs retain existing strings without copying payloads. Custom scanners and hashes would add work and code without an established benefit. |
| Crash-detail target changes on render | **No defect demonstrated:** equal strings compare by value. Changed error details are a different copy target and should clear feedback. |

Every replacement-report finding is accounted for below; positive confirmations require no change.

| Report | Findings |
| --- | --- |
| DeepSeek v4.1 Flash | 1 → empty export fixed; 2 → upgrade-only concern excluded; 3 → Edit-title CSS removed; 4 → missing audience/kind inference fixed. |
| OpenCode / MiMo v2.5 | 1 → retain correct disclosure/combobox controls; 2–6 → confirmed contextual names, sticky offset, collapsed message, layout cleanup, and abort handling; 7 → crash string-key claim unsubstantiated; 8–18 → confirmed retry visibility, indexed fields, anonymous-repeat handling, stable mirror timestamp/identity, debug-prose classification, empty source handling, scope resets, pending tabs, shared classification, and exclusion of debug-only model tabs. Short-row visibility receives the additional fix above. |
| Grok 4.6 | 1 → upgrade-only concern excluded; 2 → broader recovery outside approved scope; 3 → existing nonmodal Tab behavior retained: the configuration focus trap includes the picker portal and wraps its last control back to the dialog; the report did not demonstrate obscured focus, and close-on-focus-exit remains an optional UX change; 4 → short-row retry fixed. |
| Gemini 3.8 Flash | 1.1 → empty export fixed; 1.2 → stable row identity fixed; 1.3 → Edit-title CSS removed; 2.1 → unmeasured scanner optimization declined; 3.1 → popup-role claim rejected; 3.2 → empty-search announcement fixed. |
| Muse Spark 1.3 | 1 → empty export fixed; 2 → short-row retry fixed; 3 → speculative content hashing declined; 4 → collapsed ID reference not required; 5 → Edit-title CSS removed; 6 → structural-sharing regression disproves redundant array claim. |

[CodeRabbit's row identity finding](https://github.com/looptroop-ai/LoopTroop/pull/158#discussion_r3998929563) is fixed. [Greptile](https://github.com/looptroop-ai/LoopTroop/pull/158#discussion_r3998937030) and [CodeRabbit](https://github.com/looptroop-ai/LoopTroop/pull/158#discussion_r3998968269) repeat the upgrade-only schema concern above. CodeRabbit's outside-diff selection suggestion and Qodo's remaining selection suggestion repeat A1; its docstring percentage remains a generic advisory, not a reason to add boilerplate. Gitar/Codacy supplied no new defect, and Sourcery skipped for quota.

CI at this review baseline: all GitHub Actions jobs passed, including both Windows advisory jobs. Sonar now passes at **0.1% new-code duplication**, with no new issues or hotspots. CodeRabbit passes. Final baseline snapshot: 90 successful checks, three skipped, and Kilo failed because its model output limit was reached; its check output contains no code finding. Verify-job deprecation warnings match the already documented Renovate upstream exceptions; the Windows advisory log contains no deprecation warnings. No checks or warnings were suppressed.

Independent verification also caught a sparse-row fallback mismatch: OpenCode session rows without explicit kind could become milestones after reload. Missing-field inference now follows the live client's source precedence and session/text kind rules, while explicit system sources and metadata retain their meaning. This protects activity detection without changing complete events from current emitters.

Second-review checks: 215 targeted tests passed for the changed UI/hooks, history APIs, raw-file routes, shared classification, and sparse-row normalization; 99 additional log-emission/canonicalization tests passed. Targeted ESLint, full typechecking, application build, and website build/site/reference verification passed. A 400-pixel Chromium component fixture confirms short-row retry remains visible after pointer/focus exit, empty search exposes a status message, and both empty log views disable Copy without a false alert. No end-to-end or lifecycle test was run.


## Final quick review

Reviewed head: `b34e1e4b`, 2026-09-13. All new comments and reviews were checked; independent reviews covered the full server/shared, picker/disclosure, and clipboard/export diffs. No additional defect was found in those areas. Greptile repeats the excluded existing-install migration; Qodo repeats A1; CodeRabbit marks the stable row-identity fix addressed. Gitar approves and Codacy reports no new issue.

Current-head CI: 90 successful checks, three skipped, and Kilo failed on its model output limit again. All Actions jobs pass; Sonar passes at 0.1% new-code duplication. Both complete CI log archives were inspected. Existing artifact-action Buffer, Renovate dependency, and Node Current npm-policy warnings match the documented upstream exceptions. One cache-restore DNS failure was transient: installation and verification completed successfully, and the parallel push run had no such warning. No dependency, workflow, or gate change is justified by these results.

The final client-history review reproduced a refresh bug after loading older pages: React Query refetched the oldest stored page, then stopped because no next-page cursor was defined. This dropped the newest page and its totals; the shared model catalog could then remain stale. The existing test hid this by returning a newest-page payload for an old-cursor request. Checking the actual request URL makes the regression fail. The cause matches [TanStack's documented sequential refetch behavior](https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries#what-happens-when-an-infinite-query-needs-to-be-refetched).

**Fixed with owner approval to refresh loaded history:** the shared hook stores the newest page first and uses native forward paging to load older history. Refresh therefore requests the newest page without an old cursor, updates totals and model metadata, and sequentially follows fresh cursors through the previously loaded page count, stopping earlier if history ends. Only the entry-folding pass reverses the pages, preserving newer finalizations across page boundaries. Phase logs, Full Log, and bead logs all use this behavior, including their existing older-page and complete-history actions. Incoming logs may shift page boundaries; the fix preserves loaded page depth, not the exact oldest row. No custom refetch loop or cache reset is needed.


Final refresh verification: 114 focused tests passed across the history hook, phase/full panels, selection/export behavior, and bead logs. The strengthened regression verifies the actual newest-page request, the fresh older cursor, retained loaded pages, and refreshed totals/model catalog. Existing regressions retain oldest-first undated rows, finalized content, and cancellation behavior. Targeted ESLint, typechecking, and application build passed. No end-to-end or lifecycle testing was performed.
