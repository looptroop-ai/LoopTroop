# PR19 review dispositions

Review target: [PR #156](https://github.com/looptroop-ai/LoopTroop/pull/156), through
`988a9e0694fbaf4a5b1cc6fab5e0cee9ab2ec26f`. Read all eight local reports, nine PR comments,
six review records, and nine inline comments before choosing these follow-ups.
Accepted fixes below are implemented on the existing branch. It is not a claim that
unpublished changes have passed CI. The owner subsequently approved receipt-ID uniqueness,
squash/rebase completion with candidate-head validation, and final cleanup/repeated-Merge fixes.

## Source keys

Numbers refer to the original finding numbers, including observations explicitly judged correct.
Muse has no numbered findings; M, R, and S below number its bullets in order under
"Merge poller / completion," "Runner / typed errors," and "Skip receipts," respectively.

| Key | Local report |
| --- | --- |
| Claude | `tmp/pr19/claude-review.md`, findings 1 through 16 |
| Deepseek | `tmp/pr19/deepseek-v4.1-flash-review.md`, findings 1 through 9, departure note and invariant note |
| GPT | `tmp/pr19/gpt-5.4-pr19-review.md`, findings 1 through 6 |
| Mimo | `tmp/pr19/pr19-review-mimo.md`, findings F-1 through F-15 |
| Opus | `tmp/pr19/opus-5-review.md`, findings 1 through 10 |
| Grok | `tmp/pr19/grok-4.6-review.md`, findings 1 through 11 and plan notes |
| Gemini | `tmp/pr19/gemini-3.8-flash-review.md`, findings 1 through 10 |
| Muse | `tmp/pr19/muse-spark-pr19-review.md`, M1 through M14, R1 through R3, S1 through S4 |

## Accepted follow-ups

| Topic | Sources | Disposition |
| --- | --- | --- |
| Orphan skip claims | Deepseek 1; Opus 1; Grok 7; Muse M1; Gitar finding 1 | The omission was valid for the initial action table. The owner has now chosen receipt-ID uniqueness in existing artifact storage, so the action table and its custom cleanup are removed. Existing artifact orphan cleanup applies. |
| Drizzle index metadata | Mimo F-1; Gemini 7; Muse S4; Amazon Q inline 3995951892 | The original runtime index already enforced action uniqueness, so the claimed lack of any database constraint was false. The final design mirrors a partial unique ticket/receipt-ID expression index in Drizzle and runtime SQL, preserving bulk actions without a claim table. |
| Cheap waiting-ticket discovery | Claude 7; Deepseek 2; GPT 1, 3; Grok 6; Muse M12 | Query waiting, nonmock ticket references directly in each project database. Avoid constructing every ticket's UI projection, reading artifacts, and resolving Git metadata on every sweep. Keep the sync helper's own eligibility check because callers can invoke it independently. |
| Durable merge recovery | Deepseek 3; Gemini 2; CodeRabbit inline 3995966490; Grok 3 | Recognize a successful, verified merge report for the current ticket attempt and candidate, then resume its pending workflow transition without repeating remote completion or inserting another success report. A PR report merely saying `merged` is insufficient proof that local verification finished. |
| Lock scope and stale observations | GPT 3; Grok 5; Muse M14; Claude 11; Mimo F-4 | Move the advisory GitHub read outside the mutation lock. Re-read and validate ticket status and relevant merge identity after acquiring the lock, before updating reports or completing. Merge, close and cancel remain serialized while mutations run. A stale observation must not recreate artifacts after cancellation or deletion. |
| Advisory logging failures | Opus 7; Mimo F-5 | Isolate each ticket's log failure so it cannot skip other tickets in the sweep. The sync helper continues to reject to its caller; the poller owns advisory logging. Adding a second log in the helper would duplicate it. |
| Report provenance and labels | GPT 4; Muse M11; Claude 14 | Preserve the creation report's completion timestamp during routine refreshes and merge completion. Present stored title/body as generated content and use neutral report labels while separately showing refreshed GitHub state. Do not present a refreshed status as evidence that every generated field matches current GitHub content. |
| Mock exhaustiveness | Mimo F-7; Opus 9; Grok 10; Gemini 8; Muse R1, R3 | Use `Record<WorkflowPhaseId, handler \| undefined>` with explicit idle/terminal entries. Every new workflow state now needs a deliberate choice, and recognized mock states cannot fall through to real handlers. Keep the existing live runner structure. Add idle-state and prototype/unknown-state regressions. |
| Review-state documentation | Claude 5; Deepseek 5, 7, 9; Grok 11; Gemini 4; Opus 10; CodeRabbit inline 3995966494 | Describe the interval as 30 seconds after the serial sweep completes, plus each ticket's failure backoff. Add review-specific restart guidance. Clarify that app-only runtimes using `skipStartupSequence` also omit the database-dependent merge poller. |
| Published documentation | Grok 8; Opus 10 | Check the website separately, including its database-schema page. Document receipt-ID uniqueness and ordinary artifact cleanup. Mark unshipped behavior as unreleased. |

## Approved owner decisions

| Topic | Sources | Final behavior |
| --- | --- | --- |
| GitHub squash/rebase completion | Grok 2, 9 and plan notes; GPT 2 | Approved: use the stored PR number and verify GitHub's recorded landed commit on the remote base. Keep exact base, head branch and approved candidate-head validation; reject missing verification evidence. Merge requests also send the expected candidate SHA so GitHub refuses concurrent head changes. Branch deletion or reuse does not redirect the lookup. [GitHub REST contract](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request). |
| Final cleanup and repeated Merge | Grok 1; Gemini 1; Opus 2; Muse M8, M9; CodeRabbit inline 3995966484 | Approved: CLEANING_ENV is noncancelable in the API, state machine and available actions. Repeated Merge during cleanup or completion returns success only with verified completion evidence. Canceled, blocked, closed-unmerged and unrelated tickets still fail. |

## Existing contracts and suggestions not taken

| Topic | Sources | Disposition |
| --- | --- | --- |
| No legacy receipt backfill | GPT 5; Opus 8; Muse S2; Greptile 3995957442; Qodo 3995957897; Codex 3995959335; CodeRabbit 3995966482 | Explicit alpha policy: installs are fresh and previous project databases do not need compatibility. No backfill or migration is added. Current receipt batches remain atomic; duplicates are constrained by receipt ID in existing storage. |
| Claim table instead of receipt-row uniqueness | Claude 9; Deepseek departure note; Mimo F-11; Muse S1; Grok plan notes | Superseded by the owner: use a unique ticket/receipt-ID pair in phase_artifacts. A ticket/action pair on receipts would still break valid bulk skips; different receipt IDs may share the action ID. No separate claim table remains. |
| Claim authority, replay precheck and timestamps | Claude 6, 8; Deepseek invariant note; Opus 8; Muse S3 | The action lookup reads valid stored receipts as a fast replay exit. The partial unique index independently rejects duplicate receipt IDs even when a caller bypasses that lookup. Bulk writes remain transactional; only inserted receipts are returned and broadcast. Existing timestamps provide audit history. |
| Ticket deletion, content cleanup and reattachment | Claude 12, 13; Gemini 6; Muse M2; Grok 7 | All receipt state now lives in phase_artifacts, so existing content cleanup, ticket cascades, project reattachment and orphan repair handle it. No action-claim deletion paths remain. |
| Receipt rollback transaction handle | Muse M3 | No lost atomicity was demonstrated. The project handle and transaction use the same synchronous node:sqlite connection; the callback does not yield. Receipt rollback still runs in one transaction. |
| Typed codes and native Error shape | GPT 6; Mimo F-8, F-9, F-10, F-13; Claude 4; Muse R2; Opus 9 | Preserve exact messages, native `name`, serialized shape and existing phase-specific codes. Only council deliberation previously mapped these causes to dedicated codes. Error subclasses identify the cause at the throw boundary; adding enumerable `code` fields or forwarding dedicated codes in every phase would change the contract. Assigning an own `name` property can also change enumeration and string/stack output. |
| Interview refinement wrapper | Gemini 3; CodeRabbit inline 3995966492 | Keep the existing `PROM3 refinement output failed validation: …` wrapper and compilation-phase codes. This path does not use the deliberation classifier. Rethrowing the workspace error unchanged would alter the required message contract, not repair a currently misclassified deliberation failure. |
| Remaining route workspace throw | Claude 2; Opus 9 | The ordinary route-only workspace error does not reach the classified deliberation path. Converting it is a consistency improvement, not a current classification defect. Preserve the separate `ContainedPathError` for unsafe paths; its security behavior must not change. |
| Process-local, non-reentrant lock | Claude 3; Gemini 5; Opus 4, 10; Grok 5; Muse M7 | Document the constraint and single-daemon scope. Current callers do not reacquire the lock recursively. Keep canonical ticket resolution so supported aliases serialize together. A distributed lease or AsyncLocalStorage reentrant lock has no demonstrated requirement here. The missing-ticket fallback cannot race ticket creation in current callers. |
| Direct ticket deletion during merge | Opus 3 | Delete accepts terminal tickets only. An active merge remains at the review state until completion and cannot pass that guard; cancel-and-delete already takes the merge lock. No reachable deletion race was established that requires another wrapper. Keep regression coverage of stale background observations after cancellation. |
| Reading request bodies under the lock | Deepseek 6; Grok 5 | The public API installs `validateJson` before route handlers. It buffers JSON and enforces the 2 MiB limit before any merge lock is acquired. Handlers reparse a bounded in-memory body, so the alleged slow-network-body lock hold does not occur on this path. |
| Second GitHub read at completion | Deepseek 8; Grok 9; Muse M4 | An advisory observation outside the lock can become stale. Keep authoritative verification before completion. Both reads use the stored PR number, and merged results verify the recorded landed SHA. |
| Worktree safety after external merge | Grok 4 | Keep the existing worktree safeguard pending any separately approved change. Background completion must not discard local modifications merely because GitHub reports a merge. Skipping the check or changing which files it protects requires evidence about cleanup behavior. |
| Serial polling, backoff and manual refresh | GPT 2, 3; Opus 6; Grok 5, 11; Gemini 10; Muse M5, M6, M10, M13; Mimo F-6; Qodo architecture assessment | Preserve the chosen single sweep and 30-second post-sweep delay. Failure backoff is 60, 120, 240 and then 300 seconds, with success resetting it. Failures remain advisory instead of dispatching `ERROR`. Restart reconstructs waiting work and resets the in-memory schedule. No jitter, persisted queue, webhook, new sync route, bounded-concurrency worker, success-side slowdown or stop-after-N policy is added. The existing Merge action remains available immediately. |
| Shutdown deadline | Deepseek 4; Grok 3; Muse M14 | Normal runtime shutdown stops scheduling and drains active work before storage closes. Process entry points retain their 30-second force-exit deadline; a remote operation may take longer. Document that limit and recover from the durable verified report on restart. Do not promise an unlimited drain or close storage underneath a live poll. |
| Initial tick and lock-map lifetime | Mimo F-2, F-3, F-12 | The first sweep is queued at zero delay. Stop before that tick intentionally prevents discovery; the next daemon start rediscovers persisted waiting work. Pending lock entries are removed when their operations settle. App-only test runtimes do not start this poller. |
| Post-completion state guard | Opus 5; Muse M9 | Keep the fresh-state guard before mutation. Verified recovery handles interrupted dispatch, cleanup rejects Cancel, and repeated Merge acknowledges already recorded verified success. |
| Missing report on a waiting ticket | Claude 16 | Report missing context or PR metadata as an advisory sync failure, without a GitHub request. This gives the inconsistent state a visible diagnostic and the existing per-ticket retry delay instead of silently retrying every sweep. Never invent missing report content. |
| Mock cancellation signals | Gemini 9 | Preserve existing mock behavior. Current mock handlers do not have a demonstrated long-running cancellable operation that needs a new signal interface. Real workflow cancellation remains unchanged. |
| Helper reuse and test scope | Claude 10, 15; Mimo F-14, F-15; Grok plan notes | Shared completion logic is the correct reuse boundary; background work should not fabricate an HTTP context or inherit explicit Merge's error dispatch. Keep focused poller, route, storage and runtime tests. The route tests protect passive GET semantics; unchanged wire-name tests are insufficient by themselves. Do not add end-to-end or full lifecycle testing against the owner's instruction. |
| Ponytail comment and docstring coverage | Claude 1; Grok 11; CodeRabbit summary | The active skill explicitly requires a `ponytail:` comment naming a deliberate ceiling and upgrade path; retain the serial-loop note. CodeRabbit's 80% docstring target is a service default, not a repository requirement. Add useful contract documentation, not generated docstrings to reach a percentage. |

## Bot comment accounting

Inline IDs below are permanent GitHub discussion IDs. Their review summaries repeat the same
findings and do not add separate defects.

| Review source | Saved comment or inline IDs | Disposition |
| --- | --- | --- |
| Amazon Q | [3995951892](https://github.com/looptroop-ai/LoopTroop/pull/156#discussion_r3995951892), review summary | Existing SQLite uniqueness disproved the claimed runtime race; the owner chose receipt-ID uniqueness, now represented in both runtime SQL and Drizzle. Its large-diff warning reports review coverage, not a test failure. |
| Greptile | [3995957442](https://github.com/looptroop-ai/LoopTroop/pull/156#discussion_r3995957442), [5645362600](https://github.com/looptroop-ai/LoopTroop/pull/156#issuecomment-5645362600) | Legacy-backfill request conflicts with the fresh-install scope. |
| Qodo | [3995957897](https://github.com/looptroop-ai/LoopTroop/pull/156#discussion_r3995957897), [5645363938](https://github.com/looptroop-ai/LoopTroop/pull/156#issuecomment-5645363938), [5645349221](https://github.com/looptroop-ai/LoopTroop/pull/156#issuecomment-5645349221) | Same backfill request. Architecture comparison recommends retaining the daemon poller and deferring webhooks/durable queues; no additional defect in its file summary. |
| Codex | [3995959335](https://github.com/looptroop-ai/LoopTroop/pull/156#discussion_r3995959335), [5645345785](https://github.com/looptroop-ai/LoopTroop/pull/156#issuecomment-5645345785), review summary | Same backfill request; remaining text reports review completion and service usage. |
| CodeRabbit | [3995966482](https://github.com/looptroop-ai/LoopTroop/pull/156#discussion_r3995966482), [3995966484](https://github.com/looptroop-ai/LoopTroop/pull/156#discussion_r3995966484), [3995966490](https://github.com/looptroop-ai/LoopTroop/pull/156#discussion_r3995966490), [3995966492](https://github.com/looptroop-ai/LoopTroop/pull/156#discussion_r3995966492), [3995966494](https://github.com/looptroop-ai/LoopTroop/pull/156#discussion_r3995966494) | Respectively: no backfill; cleanup fix approved; durable recovery accepted; refinement wrapper preserved; safe-resume documentation accepted. |
| CodeRabbit summary | [5645347547](https://github.com/looptroop-ai/LoopTroop/pull/156#issuecomment-5645347547), review summary | Repeats those five findings. Reported docstring coverage is 16.67% against its default 80%; see the disposition above. No automatic service-generated fix or stacked PR requested. |
| Gitar | [5645358236](https://github.com/looptroop-ai/LoopTroop/pull/156#issuecomment-5645358236), finding 1 | Original omission accepted; the owner’s receipt-index choice removes the action table and uses existing artifact cleanup. Reused-ID consequence was overstated. |
| Sourcery | [5645346349](https://github.com/looptroop-ai/LoopTroop/pull/156#issuecomment-5645346349), review summary | Guide contains no actionable finding. Detailed review exhausted its seven-day diff-character budget; the guide is not evidence of a completed correctness review. |
| Codacy | [5645350514](https://github.com/looptroop-ai/LoopTroop/pull/156#issuecomment-5645350514), check 103540303147 | Guarded handler lookup false positive; exact rule and scoped handling below. Complexity/duplication metrics do not add another code finding. |
| SonarCloud | [5645365608](https://github.com/looptroop-ai/LoopTroop/pull/156#issuecomment-5645365608) | Quality gate passed with zero new issues and zero security hotspots. Its displayed 0% new-code coverage does not replace the actual test results. |

## CI and analyzer evidence

The [push CI run](https://github.com/looptroop-ai/LoopTroop/actions/runs/34688730135),
[PR CI run](https://github.com/looptroop-ai/LoopTroop/actions/runs/34688719279), and
[CodeQL run](https://github.com/looptroop-ai/LoopTroop/actions/runs/34688729019) all completed
successfully at `988a9e0`. The saved head check set contains 89 successes, three skips,
one Codacy `action_required`, and one Kilo failure. These results precede the review fixes.

Both full CI logs contain the warning families already approved in
[the upstream-warning dispositions](security-alert-dispositions.md#upstream-warnings-retained-after-review):

- Artifact extraction reports Node's deprecated `Buffer()` constructor. The pinned download action
  matches [v8.0.1](https://github.com/actions/download-artifact/releases/tag/v8.0.1), and
  [upstream issue 484](https://github.com/actions/download-artifact/issues/484) remains open.
  Retain artifact digest enforcement.
- Renovate validation reports deprecated transitive packages (`inflight`, `boolean`, `rimraf`,
  `glob`, `node-domexception`) and optional RE2 falling back to JavaScript RegExp. Registry metadata
  for the newer validator still contains the dependency roots; updating the validator alone does
  not remove these warnings. Keep the reviewed script policy and visible validation limitation.
- Binary injection reports Linux `.note` section diagnostics and Windows signature diagnostics.
  Postject's latest release remains the pinned `1.0.0-alpha.6`; existing binary verification passes.
  Do not strip or suppress these messages merely to clean a green log.
- Node 26's early-warning job reports bundled npm `11.19.1` outside the reviewed policy, then
  successfully installs approved npm `12.0.2`. This is the intended policy fallback.

No additional action-retirement warning was found. CodeQL's occurrences of "DEPRECATED" are
extractor-option schema descriptions, not a warning that this workflow uses a deprecated option.

[Codacy's issue API](https://app.codacy.com/api/v3/analysis/organizations/gh/looptroop-ai/repositories/LoopTroop/pull-requests/156/issues)
identifies the added finding at `runner.ts:244` as
`Semgrep_javascript.lang.security.audit.unsafe-dynamic-method.unsafe-dynamic-method`, emitted by
Opengrep. The preceding `isWorkflowPhaseId` call checks own keys of static workflow metadata;
input cannot select prototype members or supply executable code. The handler record is now
exhaustive, with invalid/prototype-state regressions. A single rule-specific `nosemgrep` annotation
records that reviewed false positive. No rule or file is excluded globally.
[Codacy's integration](https://github.com/codacy/codacy-opengrep/blob/main/internal/tool/command.go)
respects ignored findings, and [Opengrep documents rule-scoped annotations](https://github.com/opengrep/skills/blob/main/skills/opengrep/SKILL.md).
The old switch's asynchronous-error finding is reported fixed. A new service run must confirm
whether the scoped annotation is reflected in its dashboard.

[Kilo's check](https://app.kilo.ai/code-reviews/52768e55-01d7-4bcd-a4dd-ccc205512320) failed because
"The model output limit was reached." It reports no code finding and does not establish a completed
review. No service status was dismissed or changed during this audit.

## Follow-up verification

After the owner-approved changes, the full application suite passed: 413 files,
5,749 tests passed and 10 skipped. Focused receipt, GitHub, route and machine regressions,
full lint, both typecheck projects, application build, package contents, native-addon,
type-stripping, notices and installer checks passed. Website build, 79 tests and
site/CLI-reference verification passed; the updated documentation was pushed directly to
website main in commit `2b2a34b` and remains marked unreleased. No end-to-end or full
lifecycle tests were run. New CI runs are left for the owner to verify.


## Round 2: review of `9e5c8b6e`

All eight refreshed reports in `tmp/pr19/`, PR conversation/review comments, inline comments,
and current CI results were read before this round's fixes. The report paths are session-local,
gitignored inputs; the dispositions below preserve their finding references for later readers.
Claude, Deepseek, GPT, Gemini, Grok and Opus references use their numbered findings. Mimo uses
its numbered confirmations and O-1/O-2. Muse's unnumbered bullets are identified here as M1–M14
(merge section) and R1–R9 (receipt section), in their original order. This round supersedes earlier
service statuses; it does not reopen the owner's recorded behavior decisions.

| Findings | Disposition |
| --- | --- |
| Claude 1–2; Deepseek 1, 5; Gemini 4; Grok 2; Opus 6; Muse M3–M4 | Numbered GitHub lookup now returns valid metadata or throws. Malformed successful responses become visible advisory failures with backoff. Removed the unused branch lookup, obsolete mock and stale branch diagnostic. Missing head metadata still fails safely; branch/candidate validation was not relaxed. |
| Grok 2; Muse M9 | Recognize `merged: true` as well as `merged_at`. Ready/merge refreshes reuse the numbered lookup and its requested/returned PR identity check. |
| Grok 3 | Explicitly pin the supported REST API version that retains `merge_commit_sha`; retain the post-merge GET and exact candidate check. A future API migration is needed before the pinned version retires, rather than adding a second metadata source now. |
| Deepseek 2; Grok 1; Muse M10 | A durable verified merge cannot be overwritten by Cancel or Finish Without Merge. If work after persisting proof fails, keep the waiting attempt available for recovery instead of dispatching ERROR and archiving its proof on Retry. Normal cleanup remains noncancelable. |
| Claude 3; Deepseek 3; Muse M1–M2 | Checkpoint recovery validates the current attempt, stored PR number, candidate and recorded head. It repairs PR metadata and emits the structured merge audit details before resuming completion. |
| Deepseek 4 | Rejected fallback to the checkpoint's self-declared identity when current runtime authority is missing. Recovery remains fail-closed against the current attempt and approved candidate; an older report cannot authorize a different attempt. |
| Muse M6–M8 | Revalidate project root after the unlocked advisory read, alongside the existing waiting-state, PR-number, branch and candidate checks. Avoid the redundant advisory write when authoritative merged completion will update the report. Both callers already check the waiting state under the ticket lock; no duplicate entry guard added. |
| Muse M5; Claude 17 | Preserve the generation timestamp and valid metadata provenance. Do not blanket-coalesce all nullable remote timestamps: `closedAt: null` can correctly mean the PR reopened. The merge report's completion time and the PR report's generation time describe different events. |
| GPT 1; Opus 1, 6–8; Gemini 2; Muse M13–M14 | Retain the owner's advisory policy for all background failures, including validation failures: serial sweeps, 30 seconds after a sweep, 60/120/240/300-second failure backoff. Closed PRs remain observable because they can reopen. No terminal-error classifier, automatic skip, new sync route, concurrency, jitter or persistent retry policy. Missing approved candidate/PR identity prevents completion; documentation describes the limits. |
| GPT 2 | Runtime import-time timeout was not reproduced: the existing runtime suite passed 14 tests in 8.14 seconds. Existing app routes already import merge completion, so lazy-loading only the poller would not remove the claimed dependency graph. No speculative import refactor. |
| Opus 5; Grok 4; Gemini 5 | Update published ticket-flow and post-implementation guidance for noncancelable cleanup, checkpoint recovery, restart after a stall, and candidate-head plus landed-commit verification. In-app Merge still requires merge commits to be enabled; external squash/rebase remains supported. No merge-method configuration added. |
| Gemini 1 | Repeated Finish Without Merge success was not requested. Preserve its existing state-conflict response; the owner's idempotent acknowledgement applies to a proven successful Merge. |
| Gemini 3 | Preserve the interview phase's existing wrapper text and error-code behavior. Moving the workspace throw outside that wrapper would change the wire contract the owner explicitly retained. |
| Grok 5 | Mock cleanup's unsupported-execution behavior is intentional and unchanged. Exhaustive mock dispatch does not introduce a new mock lifecycle. |
| Claude 4, 7; Muse M11–M12; Opus 9 (logging) | Keep lock-scoped revalidation and bounded explicit merge serialization. No extra DB cache, lock-key redesign or per-process log suppression without a demonstrated need. Recovery's richer log is addressed above. Existing git/gh deadlines remain in force. |
| Claude 5; Gemini 6; Deepseek minor (index); Opus 3; Muse R9 | SQLite is the chosen driver and the runtime index and Drizzle metadata agree. Existing tests write an actual generated receipt and reject a direct duplicate, so prefix/key drift that disables the runtime constraint is already detected. No additional schema framework or speculative constraint-target change. |
| Claude 6; Opus 9 (receipt return); Muse R1–R4 | Retain receipt-ID uniqueness and duplicate-ignore behavior, including duplicates within one batch. The return contains newly written receipts. Action-level uniqueness would reject valid multiple receipts for one action; no extra action index/table, conflict exception or new summary identity scheme. |
| Opus 2, 4; Muse R5–R7 | Fresh installs only: no backfill, deduplication, obsolete-table drop or opening a database after its required unique constraint fails. Production writers validate receipt JSON before inserting. Manually malformed rows do not justify weakening validation or changing the approved collision policy. |
| Gemini 7; Muse R8 | Current small synchronous deletion transactions are correct on the same `node:sqlite` connection. No bulk-delete or transaction-handle rewrite solely for style. |
| Deepseek minor (viewer label and report paths) | The repeated viewer ternary has no behavioral defect and does not require a separate refactor. Session-local report provenance is clarified above. |
| Claude 8–16; Mimo 1–7, O-1/O-2; Opus “Verified, no action needed”; Gemini resolved-items section | These confirm prior fixes or chosen contracts: receipt-ID index, candidate-pinned merge, unlocked advisory reads with revalidation, noncancelable cleanup, repeated proven-Merge acknowledgement, exhaustive mock dispatch, lightweight discovery and isolated poller logging. No additional implementation was requested by these confirmations. |

[Greptile comment 3996227636](https://github.com/looptroop-ai/LoopTroop/pull/156#discussion_r3996227636)
identified one attached project's database failure preventing discovery in every other project.
Discovery now isolates and reports each project failure while continuing healthy projects. This
preserves required schema validation; it does not open a failing database without its constraint.
Other saved comments repeat findings already accounted for in this ledger.

The [GitHub API version policy](https://docs.github.com/en/rest/about-the-rest-api/api-versions?apiVersion=2022-11-28)
sets retirement of the pinned `2022-11-28` API to March 10, 2028. The explicit pin makes the
landed-SHA dependency visible; it is not a claim of indefinite API support.

### Round 2 CI and verification

The PR page showed 94 checks: 90 successful, three skipped and one failed. The REST check-runs
endpoint listed 93 because it excludes the additional commit status (89 successful, three skipped,
one failed). Both [CI run 34695291630](https://github.com/looptroop-ai/LoopTroop/actions/runs/34695291630)
and [CI run 34695294347](https://github.com/looptroop-ai/LoopTroop/actions/runs/34695294347) passed,
as did [CodeQL run 34695292044](https://github.com/looptroop-ai/LoopTroop/actions/runs/34695292044).

Actual log warnings match the retained upstream dispositions above: artifact extraction's Buffer
deprecation, Renovate's transitive deprecations and RE2 fallback, postject's Linux section/Windows
signature diagnostics, and the approved npm fallback in the Node Current job. No new action
retirement warning was found. Session-local logs are `/tmp/pr19-round2-run-<run-id>.log`.

[Codacy](https://app.codacy.com/gh/looptroop-ai/LoopTroop/pull-requests/156) now passes and reports
two solved findings; the previous action-required result is superseded. Sonar reports no new issues
or security hotspots. [Kilo's latest review](https://app.kilo.ai/code-reviews/45123389-16ec-4d7b-8b44-3fa83de77972)
failed because its assistant request was rate limited. This is an incomplete service review, not a
code finding. No service status was dismissed or changed.

The combined follow-up passed all 413 application test files: 5,767 tests passed and 10 skipped.
Full lint, both typecheck projects, build, type-stripping, notices, installer consistency, package
contents, native-addon and version checks passed. Focused regressions cover GitHub metadata,
checkpoint recovery and conflicting actions, project-root revalidation, and discovery isolation.
Website build, all 79 tests and site/CLI-reference verification passed; documentation was pushed
to website main in `8d79d5a`, with new behavior still marked unreleased. No end-to-end or full
lifecycle tests were run. The green remote CI results above describe `9e5c8b6e`; fresh CI after
this follow-up is left for the owner to verify.


## Round 3: final review of `0bfca48e`

Read the latest conversation, review and inline comment updates and CI results before editing.
CodeRabbit's new outside-diff finding is valid: Cancel parsed its request stream while holding
its ticket's merge lock. Finish Without Merge had the same issue. Both now parse and validate
before acquiring the lock, then read current ticket state and verified checkpoints under the
lock. Delayed uploads cannot stall daemon completion; a request arriving after completion is
rejected by the existing state checks. Malformed payloads are rejected before ticket-state
validation, so an invalid payload receives 400 even for a missing or completed ticket.

CodeRabbit's remaining workspace-error summary repeats the deliberately preserved interview
validation wrapper; the owner's wire-contract choice still applies. Its default docstring
coverage target is not a repository gate. Greptile reports no remaining finding and 5/5
confidence; Codacy and Sonar report zero new issues. Qodo and Gitar have no new actionable
finding. Their old action-table observations remain resolved by the receipt-ID design.

An independent bounded review of the complete PR found no other important defect in candidate
and landed-commit verification, current-attempt recovery, polling/shutdown, receipt uniqueness,
or typed-error/mock dispatch. No speculative refactors were added.

The latest CI snapshot contained 87 successes, three running Windows test checks, three skips
and one failure.
[Kilo's review](https://app.kilo.ai/code-reviews/55155d3f-e53f-4f48-b646-b794ee6212b5)
again failed because its assistant request was rate limited, with no code annotations. Sampled
completed workflow-lint, Node Current and Linux/Windows binary logs contained only the already
reviewed npm fallback and postject diagnostics. No new deprecation was identified.

Round 3 verification passed: 413 application test files, 5,769 tests and 10 skips; full lint,
both typecheck projects, build and version checks. The test cleanup needed a type guard for
Hono’s HTTP/HTTP2 server union; after that test-only correction, all 39 PR-route tests and
scoped lint passed again. Website build, 79 tests and site/CLI-reference verification passed;
the documentation is published on website main in `1ea845c`. No end-to-end or full lifecycle
tests were run. Fresh CI after this follow-up is left for the owner; no merge was performed.
