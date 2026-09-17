# PR 167 review dispositions

This is the permanent review record for PR 167. Each observation is classified
as fixed, accepted design, superseded by a later owner decision, not applicable,
or informational. The branch owns the implementation and focused regressions;
the root worker owns aggregate checks and the website. This branch does not merge
the pull request.

No E2E, full-lifecycle, live-provider, live-GitHub, native Windows/macOS, or
standalone-binary validation is claimed here.

## Top-level comments

| Comment ID | Classification | Disposition |
| --- | --- | --- |
| 5713248070 | Not applicable | CodeRabbit skipped review because the branch is not the default branch. There was no finding to action. |
| 5713248154 | Informational | Codex review-status summary only; no finding. |
| 5713272897 | Informational | Codacy reported zero new issues. The metric is retained as CI evidence, not treated as proof of workflow correctness. |
| 5713277964 | Informational | Qodo summary accurately describes the scope; the individual findings and later decisions below are the actionable record. |
| 5713279809 | Correct, fixed | Council cleanup now starts remote stop confirmation from the tracked session before waiting for prompt settlement. If session publication is late, the bounded wait fails closed and `runOpenCodePrompt` aborts the published session before rethrowing the closed callback; `server/workflow/__tests__/runOpenCodePrompt.test.ts` covers that late-publication path. |
| 5713289616 | Correct CI evidence, no local claim | macOS and Windows CI reported path/recovery assertion failures. Those native jobs cannot be reproduced in this environment; no native-platform pass is claimed. The root worker owns the aggregate CI follow-up. |
| 5713303250 | Correct quality signal, owner follow-up | Sonar reported 6% duplicated new lines. The council helper duplication was removed here; remaining aggregate Sonar analysis belongs to the root worker and any later cleanup packet. No exclusion hides the finding. |
| 5713304944 | Correct, fixed | Greptile identified planning saves committed before restart confirmation and failed Cancel allowing coding re-entry. Planning writes now occur after confirmed stop and a second baseline check; cancellation writes the private `.ticket/runtime/cancellation-pending.json` marker before cleanup, retries failed cleanup without re-entering coding, and removes the marker through the contained ticket-file boundary only after terminal cleanup. |
| 5714109940 | Mixed; fixed or accepted per item | (1) Exact missing-session 404 is confirmed stopped, while message-only 404 and transport errors are not; a transport 500 cannot be masked by nested business data that says 404. (2) Confirmed planning restarts clear budget/question/continuation state. (3) CANCELED cleanup retries and persists its pending-stop marker. (4) Setup action projection is fixed by the root worker and retained. (5) Planning save ordering and post-stop recheck are fixed. (6) Manual QA uses strict route-entry revision semantics while preserving the click snapshot. (7) Claim tokens include a process-boot ID. (8) Close-unmerged resume writes its idempotent receipt. (9) Missing-PID supervisor coverage is fixed. (10) Unlimited `maxIterations: 0` remains an explicit owner decision. (11) Council stop confirmation is shared and bounded. |
| 5714191386 | Correct, fixed or superseded | The close race is fixed by the later PR164 parent and retained for propagation. Planning save ordering and strict Manual QA entry checks are fixed in this branch. |
| 5714217398 | Mixed; fixed or not applicable | History reattachment removes the phantom batch entry; exact remote 404 handling, planning post-stop revalidation, interview edit claim/CAS, setup-plan hash/claim/CAS, and synchronous coverage claim/CAS are fixed. The setup-action projection is root-owned and retained. The mock-session replay observation was unreachable under the actual restore contract and required no production change. |
| 5714248652 | Correct, fixed | PROM4 now writes a durable in-flight marker before publishing the intermediate answered snapshot, restores it only when the fingerprint still matches, and clears it after a result or mismatch. |
| 5714252879 | Correct, fixed | Planning saves validate the loaded baseline, confirm remote stop, re-read the document, and only then archive attempts or publish the edit. |
| 5714273172 | Mixed; superseded or fixed | The W17 branch-delete race is covered by the later PR164 parent. Receipt identity is attempt-scoped and the existing owner decision accepts the current W23 behavior. The council helper duplication is fixed. The remaining suggestions are non-blocking observations or belong to another packet. |
| 5714283723 | Correct, fixed | Interview retries revalidate the stored session. An abandoned remote session is reactivated only after liveness and durable ownership are confirmed; if it is gone, a replacement session resumes from the normalized answered snapshot. |
| 5714330582 | Mixed; fixed or accepted design | W13 is fixed across the packets: the checkpoint is recorded before `in_progress`, and this branch lets Retry recover a runnable pending bead that never started without inventing a reset anchor. The non-expiring `.ticket/runtime/cancellation-pending.json` marker is a private known runtime artifact: absent means no pending stop, while malformed or unreadable content fails closed and blocks coding. Cleanup uses the contained ticket-file removal helper, and no arbitrary project file supplies ownership. Boot identity, strict QA semantics, and the supervisor missing-PID test are fixed. Unlimited question/continuation windows remain owner-accepted decisions. |
| 5714614713 | Mixed; fixed or accepted design | The edit route now requires a positive `batchNumber`. Setup recovery action projection is root-owned and retained. Pending-stop markers survive until confirmed terminal cleanup, supervisor missing-PID coverage is present, and Manual QA keeps the intentional click-time snapshot contract. |
| 5714879351 | Mixed; fixed or superseded | Setup recovery projection remains root-owned; boot identity, per-session question isolation, and missing-PID supervisor coverage are fixed. |
| 5714893207 | Accepted design | Question windows and `maxIterations: 0` are intentionally unlimited for their documented paths. The product decision is not reversed by this review; the UI and status descriptions make the behavior explicit. |
| 5716501887 | Correct CI evidence, superseded | Gitar reported five atomic-I/O orphan-recovery failures. The refreshed report was read; the later PR164 parent contains the bounded quarantine/recovery corrections and tests. No local native or aggregate pass is claimed here. |
| 5716694342 | Correct CI evidence, superseded | This is the refreshed Gitar report of the same atomic-I/O recovery failure family. It is covered by the later PR164 parent and remains an aggregate/root verification item. |
| 5717202556 | Correct quality signal, owner follow-up | The refreshed Sonar report still measured 6% duplication. The shared council helper reduces known production duplication; remaining quality-gate analysis belongs to the root worker and later packet. |

## Review records without separate findings

| Review ID | Classification | Disposition |
| --- | --- | --- |
| 5234684060 | Not applicable | Sourcery stopped at its diff-size limit and supplied no code finding. |
| 5234689862 | Informational | Amazon Q reported no blocking defects and noted the size limitation. It does not replace the finding-by-finding record above. |
| 5234714917 | Informational | Qodo review record contained no actionable text. |
| 5234738482 | Informational | Greptile review record contained no actionable text. |
| 5234768624 | Informational | Codex review record contained no actionable text. |
| 5237605746 | Informational | Refreshed Greptile review record contained no actionable text. |

## Inline review IDs

| Inline ID | Classification | Disposition |
| --- | --- | --- |
| 4036078646 | Correct, fixed | Same council deadlock as 5713279809; bounded session publication waits fail closed, and a session published after that boundary is aborted by the callback-failure cleanup before the error is rethrown. |
| 4036097525 | Correct, fixed | Same planning half-write as 5713304944; baseline is checked before stopping and again after confirmed stop, before archival or publication. |
| 4036097540 | Correct, fixed | Same failed-Cancel race as 5713304944; local coding restart is fenced while remote stop remains unconfirmed, and cleanup retries. |
| 4036121044 | Correct, fixed | Duplicate planning-order report; the post-stop baseline and claim checks now fence the write. |
| 4036121048 | Correct, fixed | Manual QA no longer accepts an arbitrary newer revision at route entry. The server revision must match the revision observed when the route was entered; the immutable click snapshot is still used after that check. |
| 4036121056 | Not applicable / superseded | The reported fallback branch was rechecked against the current setup generator and handled by the root worker’s setup recovery changes. No duplicate or speculative fallback was added here. |
| 4038373610 | Incorrect / not applicable | The refreshed Greptile claim that setup fallback reuses a stopped session was traced against the actual control flow and is unreachable: the deterministic fallback path is selected only after the stopped retry session has been cleared. The root handoff records the proof; no production change is warranted. |

## Related PR 165 observations reviewed for this handoff

These comments are not PR 167 findings, but the owner asked that they be
checked before closing the workflow packet.

| Comment ID | Classification | Disposition |
| --- | --- | --- |
| 5714282549 | Accepted positional owner decision | P12/P13 equal-length expansion arrays are intentionally paired by position because expansion renames plan IDs to execution IDs while preserving order and count; the viewer falls back to ID pairing when lengths differ. The implementation and source report accept this contract, rather than deferring it to a later artifact-viewer packet. Other parser observations were handled in PR 165 or are scope notes. |
| 5714878772 | Correct, fixed in workflow packet | Projection isolation, diagnostic malformed-line handling, cycle identification, and approval hash behavior were addressed by the PR 165 owner packet. The fallback interview normalizer now retains warnings from the rejected batch candidate, with a regression in `server/structuredOutput/__tests__/index.test.ts`; the implementation uses `batchCandidateWarnings` at `server/structuredOutput/interviewOutput.ts:1364`. |
| 5714892772 | Correct, fixed or superseded per item | Nested collection normalization, diagnostic bead reads, retry-history aliases, and YAML repair behavior belong to the PR 165 parser packet and its owner decisions. The interview snapshot timestamp item is already fixed in `server/phases/interview/snapshotValidation.ts:82-90,172-224,359-386`, with invalid `updatedAt` and `answeredAt` coverage in `server/phases/interview/__tests__/sessionIntegrity.test.ts:196-200`; equal-length positional expansion pairing is implemented and accepted under the expansion order/count contract, with ID fallback for unequal arrays. |

## Implementation evidence

Focused regressions cover bounded council stop ordering and late-session
cleanup, strict remote 404 evidence,
failed-cancel fencing and cleanup retry, planning and setup-plan CAS ordering,
the setup-plan UI retaining a persisted dirty-draft hash across a background
refetch before PUT, Manual QA entry CAS, interview batch recovery and ownership, close receipts,
question-list isolation, PID/boot claims, interrupted PROM4 recovery, durable
pending-stop marker recovery and malformed-marker fail-closed behavior, W13
pending-bead retry, and synchronous coverage persistence. Root-owned aggregate
lint, build, website, and full-suite checks are intentionally not duplicated in
this packet.

The refreshed review delta was read in full. It repeats the council-stop,
planning-save, and duplication observations above, adds the superseded
atomic-I/O CI reports 5716501887 and 5716694342, adds Sonar update 5717202556,
and adds inline observation 4038373610. The blank refreshed review record is
5237605746; it contains no actionable finding.

Final integration follow-up adds both pending markers to the exact known-file
recovery inventory; the existing complete-JSON and containment checks still
apply. All 63 atomic-I/O regressions pass, including interrupted writes of each
marker. Remaining duplicate session and Manual QA test setup now reuses the
existing fixture or a parameterized case; all 53 focused tests pass without
production abstractions or analyzer exclusions. Runner tests explicitly mock
the durable query and verify that a pending cancellation blocks restored coding
(56 passing tests).

The later Codacy check `105311021642` reports one possible user-input path at
`server/io/__tests__/atomicIO.test.ts:477`. This is a false positive: `filename`
comes only from the three literal artifact names in the adjacent `it.each`
table, joined under the test-owned temporary root. No request or repository
input enters this fixture. The annotation was not dismissed externally.
