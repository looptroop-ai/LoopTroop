# Consolidated audit documentation ledger

This ledger records documentation coverage for reviewed packets. `PASS` means
the named packet evidence passed its bounded review; final integration and
acceptance remain with the root worker. A row never implies that an unreviewed
or unimplemented finding is complete.

## Current delivery checkpoint

The current root delivery checkpoint supersedes earlier provisional delivery
counts. All seven delivery PRs below completed their bounded local gates and
fresh Astra review, remain open, and are unmerged; no CI result was awaited or
accepted for this checkpoint. The root source-acceptance checkpoint is
**154/154**. The older packet rows retain their original `PASS, final pending`
labels as historical bounded dispositions; this current aggregate does not
claim that every partial branch contains all 154 findings.

| PR | Immutable head | Base | Delivery relationship |
| --- | --- | --- | --- |
| [#163](https://github.com/looptroop-ai/LoopTroop/pull/163) | `476c33ee74575b3f932c01d90f0dd3ccafa329f0` | `main` | Independent main-base concern |
| [#164](https://github.com/looptroop-ai/LoopTroop/pull/164) | `5295ccdc7cb4622d52fb95e0579494f07c09d68f` | `main` | Git/filesystem and related application coverage |
| [#165](https://github.com/looptroop-ai/LoopTroop/pull/165) | `22ffe8b0db253a9a3188c045c4e675fbe9383b49` | `main` | Independent main-base concern |
| [#166](https://github.com/looptroop-ai/LoopTroop/pull/166) | `72688adc6e49be9a0902c847ee66bba8a044a244` | `#164` | Security prerequisite on PR164 |
| [#167](https://github.com/looptroop-ai/LoopTroop/pull/167) | `431663e0530769a34fc5e064a925394a7dd90336` | `#164` | Client prerequisite on PR164 |
| [#168](https://github.com/looptroop-ai/LoopTroop/pull/168) | `54019cb88071013e9c09d274d682bb0e2307f3ce` | `#166` | Security follow-on |
| [#169](https://github.com/looptroop-ai/LoopTroop/pull/169) | `0b8c358c5f1c2bba4078eb4166596a02fcf84959` | `#167` | Client follow-on |

The final combined verification evidence records **6,458 passed** and **13
skipped** tests across **440 files**, plus the verified native Linux SEA build
and Linux `amd64` container-build checks. The final published website
checkpoint is main commit `2226ab575a2e37d0cb0f63651d2a070f0ee33c6d`; its
immutable CLI source ref remains `f784f055b45854016c245a2d902d6799b7e8265c`.
All 358 changed paths are covered by the part manifests, which is a
path inventory and not independent proof of behavior. These results remain a
delivery checkpoint for root review, not final repository or PR acceptance.

## Reviewed release packet

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| R01 | PASS, final pending | `scripts/smoke-published.mjs` preserves the resolved launch file, errno/code, and operating-system message when a child cannot start; `tests/smokePublished.test.ts` exercises the production `run()` path with a real executable and a missing working directory. | Native Windows gate remains CI-only here. |
| R02 | PASS, final pending | `release-workflow-evidence.md`; scheduled and repair smoke checks use the tested release tag and the reviewed OpenCode npm pin. | The moving official installer path is intentionally not asserted; scheduled smoke was not run locally. |
| R03 | Documented | Website `docs/installation.md#standalone-executable` describes current source flags and keeps the served release's `-DryRun`/`-Help` warning. | The served installer remains unsafe for those two flags until a release updates it. |
| R04 | PASS, final pending | `release-workflow-evidence.md`; release-PR and Renovate Git credentials are per-invocation headers and are removed before unrelated Git work. | No live push was performed. |
| R05 | PASS, final pending | `release-workflow-evidence.md`; attestation jobs download bytes only, while publish/build credentials stay separated. | No live attestation or publish was performed. |
| R06 | PASS, final pending | `release-workflow-evidence.md`; manifest-derived channel values cross workflow steps through environment variables after safe-basename validation. | Workflow execution was not run locally. |
| R07 | PASS, final pending | `release-workflow-evidence.md`; Renovate notices are validated outside the checkout as one regular top-level file before copy. | No Renovate workflow run was performed. |
| R11 | PASS, final pending | `release-scripts-evidence.md`; `tests/docsInstallCatalog.test.ts` and `node scripts/docs-install-catalog.mjs` cover the machine-readable install catalog. | Website already pins source ref `f784f055b45854016c245a2d902d6799b7e8265c` in website commit `83cdf633`; this docs checkpoint makes no pin change. |
| R12 | Documented | Website verification checks out the immutable source ref and fails closed when the catalog is absent; the existing R12 section below records the design. | The accepted website pin and its CI checkout are independently reviewed; no pin change is needed for this docs checkpoint. |
| R13 | PASS, final pending | `scripts/build-binary.mjs`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, and `tests/releaseScriptArgs.test.ts`/`tests/workflowPolicy.test.ts`; package, application, and container jobs retain the Node `24.18.1` floor, while each standalone binary job pins the exact Node `26.9.0` native SEA builder and blocks on an embedded-runtime application check. Detailed results are in `/tmp/looptroop-release-part-evidence.md`. | CI-only policy execution was not run locally beyond the packet checks. |
| R14 | PASS, final pending | `release-scripts-evidence.md`; all five install-smoke consumers compare structured `checks[].install.channel` and `checks[].install.upgradeCommand`, not `detail`. Website `docs/diagnostics.md#the-install-check` documents that contract. | No package-manager, container, or lifecycle smoke was run. |
| R15 | PASS, final pending | `release-scripts-evidence.md`; WinGet gives Git and GitHub CLI only the copied child environment credentials they need and removes ambient token aliases. | No live WinGet submission was performed. |
| R16 | PASS, final pending | `release-workflow-evidence.md`; release assets include the npm tarball and matching `package-lock.json`; Docker copies both and runs locked `npm ci --ignore-scripts --omit=dev`. Website `docs/installation.md#running-in-a-container` describes the resulting image. | A local Linux amd64 image build passed; multi-architecture registry publication and lifecycle remain CI-only. |
| R17 | PASS, final pending | `release-workflow-evidence.md`; Scoop bootstrap uses the explicit `https://get.scoop.sh` URL. | Native Windows execution remains CI-only. |
| R18 | PASS, final pending | `release-scripts-evidence.md` and `release-workflow-evidence.md`; release/channel argument parsers reject unknown, missing, flag-shaped, and positional inputs before side effects. | No publish-side effect was exercised. |
| R19 | PASS, final pending | `release-scripts-evidence.md`; npm 12 JSON errors and failing empty objects remain unavailable, while successful empty JSON means current. | Only the bounded loopback failure probe was run; no registry update was attempted. |
| R21 | PASS, final pending | `release-workflow-evidence.md`; the local check built the amd64 image and inspected its recorded package-version inventory, while the workflow keeps multi-architecture assembly and index attestation after publication. Website `docs/installation.md#running-in-a-container` records this evidence boundary. | No multi-architecture build or attestation, live registry publication, Docker lifecycle, native Windows, or package-feed operation was run here. |
| R24 | PASS, final pending | `release-workflow-evidence.md`; release, repair, CI, and Docker npm fetches use three retries with 10 to 60 second retry bounds. App `CONTRIBUTING.md` records the scope. | This does not change package-manager retry defaults for users. |
| R26 | Documented | App `README.md` and website prerequisites state Node `24.18.1+` and npm `12.0.2+`. | No additional limitation. |
| R27 | Documented | App `README.md` and website installation pages label Yarn commands as Bash/zsh and recommend npm on Windows without an unverified PowerShell PATH recipe. | Native Windows Yarn PATH behavior is not claimed as verified. |
| R29 | PASS, final pending | `release-scripts-evidence.md`; WinGet submission prose declares Git and GitHub CLI dependencies. The app changelog records the correction. | No live WinGet submission was performed. |
| R30 | PASS, final pending | `tests/wireContract.test.ts` keeps API routes, live-event names, and `doctor --json` check names as explicit wire contracts; `CHANGELOG.md` describes those names without fragile numeric totals. | The contract lists remain hand-maintained and final integration review remains with the root worker. |
| S09 | PASS, final pending | `release-scripts-evidence.md`; maintenance and stall diagnostics use shared ANSI stripping, including C1 CSI and OSC sequences. | No additional platform limit beyond the packet test environment. |

## Accepted Git safety packet

The Git packet is accepted for this integration checkpoint, but its final
source review and the full part verification remain with the root worker.

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| G01 | PASS, final pending | Bounded asynchronous local mutations cover commit, squash, worktree creation/removal, reset, and base synchronization; descendant cleanup is awaited before the caller continues. | No E2E or full lifecycle run. |
| G05 | PASS, final pending | Staged-then-deleted scratch paths are omitted from the commit pathspec while real files remain attributable; repeated finalization is a no-op. | No E2E or full lifecycle run. |
| G06 | PASS, final pending | Origin fetch uses an explicit bounded asynchronous timeout and preserves the caller's failure contract. | No live remote fetch or lifecycle run. |
| G13 | PASS, final pending | NUL-delimited Git readers preserve spaces, tabs, newlines, backslashes, non-ASCII, and control bytes, including rename/copy paths; the Manual QA reader portion is covered by the durable IO packet below. | No E2E or full lifecycle run. |
| G15 | PASS, final pending | Repository, base-branch, GitHub, push, initialization, and focused-diff paths share strict ref validation for option-leading, control, whitespace, duplicate-dot, slash, `@`, dot-component, and `.lock` names. | No E2E or full lifecycle run. |
| G22 | PASS, final pending | Spawn setup failures become failed outcomes instead of uncaught exceptions; NUL argv and missing-command cases are covered. | No E2E or full lifecycle run. |
| G23 | PASS, final pending | Request-scoped candidate paths reject absolute, drive, dot, control, and symlink-ancestor escapes while allowing a legal final symlink and valid POSIX bytes. | Native Windows is not locally verified. |
| G24 | PASS, final pending | SSH configuration treats absent variables as absent, adds `BatchMode=yes`, preserves real `GIT_SSH_COMMAND`, `GIT_SSH`, and intentional empty values, and resolves against the effective caller environment. | No live remote authentication run. |
| G31.2/3 | PASS, final pending | SSH alias discovery caches only successful non-empty results and retries transient `ssh -G` failures; GitHub and push share command-availability and timeout semantics without permanent negative caching. | No live remote authentication run. |
| R23 | PASS, final pending | Malformed or oversized `GIT_CONFIG_COUNT` input skips helper injection with a warning and preserves caller-provided configuration keys. | No live remote authentication run. |
| W17 | PASS, final pending | Remote branch deletion requires a 40–64 character hexadecimal expected head and combines an explicit branch refspec with `--force-with-lease`; missing or invalid heads skip deletion. | No live remote deletion. |
| W29.1 | PASS, final pending | Worktree cleanliness and bead commit capture share the generated-file allowlist; tracked and unexpected untracked changes remain visible instead of being silently swept into delivery. | No E2E or full lifecycle run. |

Independent Git coverage passed 229 tests across 18 files, with 174 previously
covered downstream tests, plus lint and diff checks. The packet did not verify
native Windows, physical power loss, E2E behavior, or the complete application
part gate.

## Accepted CLI/process packet

The CLI/process packet is accepted for this integration checkpoint. Its source
snapshot is `be5d4e0414c061602b38608f4800945aa9f4054c`, based on
`330962d76618f1de14cb9a176ba0f000ba5e2eed`; detailed evidence is in
`/tmp/looptroop-cli-evidence.md`. Final source review and the full part gate
remain with the root worker.

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| G17 | PASS, final pending | `clean --apply` rechecks managed-root containment, ownership markers, activity, ticket registration, and Git state immediately before removal; `tests/cleanCommand.test.ts` keeps a worktree after a post-plan edit. | No E2E or lifecycle run; native Windows is not locally verified. |
| G18 | PASS, final pending | Stale daemon cleanup re-reads the requested instance under the existing `daemon.lock` before deleting `daemon.json`; start publication uses that lock, so a successor record is preserved. | No E2E or lifecycle run; native Windows is not locally verified. |
| G19/G20 | PASS, final pending | Destructive signals require a matching process start token and are rechecked before each signal; missing or changed identity refuses cleanup, and a concurrent start cannot report another invocation's daemon as its own. | No E2E or lifecycle run; native Windows is not locally verified. |
| G21 | PASS, final pending | Timeout escalation carries the captured process start token, retains validated descendants when the leader closes, and refuses recycled or unverifiable identities. The existing Git descendant behavior remains separately covered. | Native Windows and non-Linux retained-group behavior are not locally verified; Windows `taskkill /T /F` is forceful. |
| G27 | PASS, final pending | Shared daemon-origin formatting brackets bare or already-bracketed IPv6 literals across health, status, open, setup, and diagnostics output. | Native Windows/macOS are not locally verified. |
| G28 | PASS, final pending | `logs --follow` registers its watcher before draining the handoff, preserves byte offset, partial-line, and UTF-8 decoder state, and handles rotation without duplicate or corrupted output. | Native Windows/macOS are not locally verified. |
| G31.1/4 | PASS, final pending | Windows command-log redaction handles both slash styles and keeps only the final visible path segments; runtime `start` waits for an active `close` before reusing or creating startup state. | Native Windows is not locally verified. Together with G31.2/3 above, this covers the whole G31 finding. |

The exact 18-file reserved CLI/process suite passed 263 tests with one skip,
including shuffled runs; the daemon lock/state coverage passed 56 tests. A
separate integration rerun adds the test-only OpenCode log fixture forwardport
from PR164 commit `5295ccdc7cb4622d52fb95e0579494f07c09d68f`; PR164 remains
open, and this checkpoint does not wait for or rely on its CI.

The packet does not claim native Windows or macOS execution, E2E, daemon
lifecycle behavior, or forced removal of unknown descendants on unsupported
platforms. Missing, recycled, or unverifiable process identity fails closed.

## Accepted durable IO packet

The durable IO packet is accepted for this integration checkpoint, with final
source integration and the full part gate still pending.

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| G03 | PASS, final pending | Execution-log appends resolve the canonical project root before checking relative containment, including symlink aliases, while rejecting outside roots. | No E2E or full lifecycle run. |
| G08 | PASS, final pending | Fallback copies use exclusive no-follow targets, short-write loops, fsyncs, identity checks, and a complete matching `.recovery` ownership marker; an in-progress fallback with unresolved ownership or completeness raises a typed error and preserves files. | Physical power loss and native Windows are not locally verified. |
| G09 | PASS, final pending | YAML temps require an exclusive, fsynced `.proof` containing byte length and SHA-256; only a matching complete parseable document is promoted. | Physical power loss and native Windows are not locally verified. |
| G10 | PASS, final pending | Whole-file JSONL recovery accepts empty files or a final newline plus valid records; torn, invalid, oversized, and unrelated files remain untouched. Trailing-line repair is limited to append logs. | Physical power loss and native Windows are not locally verified. |
| G11 | PASS, final pending | Atomic appends loop short writes, reject zero progress, fsync after completion, and preserve the exact appended byte range. | Physical power loss and native Windows are not locally verified. |
| G12 | PASS, final pending | Manual QA discard/quarantine handles final symlinks with `lstat`, copies the link itself, and never dereferences outside or dangling targets. | Native Windows is not locally verified. |
| G13 | PASS, final pending | Manual QA operations use NUL-safe readers and do not trim, reinterpret backslashes, or rewrite opaque path records. | Native Windows is not locally verified. |
| G14/S12 | PASS, final pending | Project and ticket roots are absolute and contained; POSIX slashes, spaces, backslashes, and legal colons remain usable while Windows ADS syntax is rejected after a valid drive. | Native Windows is not locally verified. |
| G16 | PASS, final pending | Manual QA event reads safely parse each line, skip and warn on invalid shapes, return diagnostics, retain the raw line, and keep later appends working. | No E2E or full lifecycle run. |
| G25 | PASS, final pending | Evidence locking uses a persistent native SQLite database per attempt with `BEGIN IMMEDIATE`, zero busy timeout, bounded asynchronous retries, rollback/close release, and process-death release; the database is never unlinked. | Physical power loss and native Windows are not locally verified. |
| G30.1–4 | PASS, final pending | Startup scans canonical roots and known config/ticket allowlists, skips unsafe unknown artifacts, verifies identity before cleanup, fsyncs promotion parents, and preserves unrelated configuration. | No E2E or full lifecycle run. |
| G32 | PASS, final pending | `RecoveryBlockedError` propagates from config and per-ticket recovery only for unresolved in-progress fallback ownership/completeness, before projections, hydration, timers, or execution; preserved files and actionable diagnostics remain available. | Physical power loss and native Windows are not locally verified. |

The complete sidecar inventory is intentional: YAML `.proof`, fallback
`.recovery`, marker staging `.recovery.write-*`, retained private cleanup
`.remove-*`, and the persistent SQLite lock database (with possible SQLite
`-journal`, `-wal`, and `-shm` files). Unknown temp artifacts are warned about
and left untouched; unproved orphan content is warned about and left unpromoted;
unresolved in-progress fallback ownership is not automatically recovered or
deleted and blocks startup.

Independent durable IO coverage passed 198 tests with 4 documented skips; the
scoped typecheck, lint, and diff checks passed. Physical power loss, native
Windows, directory-fsync behavior where the platform does not provide it, E2E,
and the full application/part gate remain unverified.

## Accepted execution and hook-recovery packet

This bounded packet covers the accepted execution and Git-hook source snapshot
at tree `a6103dd299d900c568170b6327c6b6136050b34c`, based on the app baseline
`d51318f500a4b2a6b777827444104575fbd7833d`. The exact source/test manifest is
the ten files named in `/tmp/looptroop-steps-hooks-evidence.md`; this ledger
does not attribute unrelated working-tree edits to the packet. Final source
assembly, fresh review, and acceptance remain with the root worker.

The prior documentation review used frozen tree inputs `3b40df98` for the app
and `3ccdac9e` for the website (both tree objects) and received `REVISE`.
Those inputs remain provenance only; they do not represent current accepted
documentation or final acceptance. Bounded docs evidence is recorded in
`/tmp/looptroop-hooks-docs-evidence.md` and the companion save-safety evidence;
the website grant is the existing ten-page scope plus the narrowly granted
`docs/beads.md` page.

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| G04 | PASS, final pending | The OpenCode step-cap sidecar remains on a real restore conflict, including when the cap created the root config. CODING refuses a destructive reset only when current bytes conflict with that marker; bead and squash staging exclude the valid root marker path, so an edited config remains visible and out of delivery. | No E2E or full lifecycle run. |
| G07 | PASS, final pending | The execution phase no longer writes a common Git exclude rule for the temporary root config. A linked-worktree fixture resolves Git's existing `info/exclude` and proves no `/opencode.json` rule is added. | No native Windows/macOS equivalent-case run. |
| G29 | PASS, final pending | Protected Git-hook validation persists an owner/schema-bound marker with worktree and Git-directory identities, index/worktree trees, and the initial untracked set. Reentry restores through Git APIs, preserves unknown additions when attribution is ambiguous, and retains the marker until recovery is safe. | No E2E or full lifecycle run. |
| G30(5) | PASS, final pending | In-memory cap handles report a conflict when the exact capped bytes remain after the sidecar disappears; ordinary project ownership is not inferred. | A process restart with no durable sidecar has no ownership evidence. |
| G30(6) | PASS, final pending | Root-config detection follows actual worktree path equivalence, keeping legal distinct Linux names and nested copies separate. | Coverage is limited to the current host filesystem; native Windows/macOS equivalent-case behavior is unverified. |
| G30(7) | PASS, final pending | Temporary root-config cleanup accepts only a valid stale writer file with a positive exited PID and freshness bound; invalid, live, symlink, fresh, or unknown-error files remain visible. | The symlink fixture is skipped on Windows where arbitrary symlink creation needs host privileges. |
| W13 | PASS, final pending | CODING records `HEAD` before publishing `in_progress`; a failed checkpoint leaves the bead pending and makes no execution call. | No E2E or full lifecycle run. |
| S09 (shared-guard subset) | PARTIAL, final pending | This row covers only the OpenCode step-cap JSON-shape checks reusing the shared `isRecord` guard instead of a duplicate local helper; it is a partial subset, not a whole-finding S09 acceptance. | No additional platform claim; the remaining S09 scope is not covered by this row. |

The focused direct suites passed 5 files and 172 tests. Exact granted-file
ESLint reported no issues, the test-project typecheck reported no errors, and
the granted-file diff check was clean. The repository source typecheck remained
blocked by unrelated peer edits in `server/routes/__tests__/logs.test.ts` and
`src/components/workspace/__tests__/PrdApprovalPane.test.tsx`; no packet file
appeared in those diagnostics.

The packet covers Linux/Node fixtures only. It does not claim native Windows or
macOS filesystem equivalence, physical power-loss behavior, E2E, startup sweep,
full lifecycle testing, or Git mutation/staging/commit/push from the shared
working tree. The status and changelog prose that follows this packet records
conditional safeguards, not whole-finding totals or final acceptance.

## Accepted approval-save and UI-state documentation packet

This documentation packet covers the accepted save source snapshot at tree
`82c96acf6b0957445d1548b798bcb9afc41a91ce`, based on app baseline
`d51318f500a4b2a6b777827444104575fbd7833d`; source evidence is recorded in
`/tmp/looptroop-interview-saves-evidence.md`. The exact 21-file source/test
manifest is:

- `server/phases/interview/finalDocument.ts`
- `server/phases/prd/document.ts`
- `server/routes/__tests__/tickets.interviewApproval.test.ts`
- `server/routes/__tests__/tickets.prdApproval.test.ts`
- `server/routes/ticketHandlers/approvalHandlers.ts`
- `server/routes/ticketHandlers/interviewHandlers.ts`
- `server/routes/ticketHandlers/routeUtils.ts`
- `server/routes/ticketHandlers/schemas.ts`
- `server/workflow/__tests__/interviewBatchClaims.test.ts`
- `server/workflow/phases/interviewPhase.ts`
- `server/workflow/runner.ts`
- `src/components/workspace/InterviewApprovalPane.tsx`
- `src/components/workspace/PrdApprovalPane.tsx`
- `src/components/workspace/__tests__/InterviewApprovalPane.test.tsx`
- `src/components/workspace/__tests__/PrdApprovalPane.test.tsx`
- `src/components/workspace/__tests__/approvalHooks.test.tsx`
- `src/components/workspace/approvalHooks.ts`
- `src/hooks/__tests__/useBatchSubmit.test.tsx`
- `src/hooks/__tests__/useTicketUIState.test.tsx`
- `src/hooks/useBatchSubmit.ts`
- `src/hooks/useTickets.ts`

The source changes require the loaded content hash for raw and structured
interview/PRD saves, return HTTP 428 for a missing baseline and the existing
typed HTTP 409 shape for a stale one, and fence post-approval restart work
against the exact durable claim. Competing live writers are rejected before
restart or invalidation; the exact interview batch, pending-stop, lease, and
question-deadline contracts remain unchanged. Approval panes retain dirty
draft baselines across refetch/remount and only advance them after a durable
success. UI-state GETs retain pending or failed local drafts while remembering
the server revision, normal and keepalive writes use latest-wins ordering, and
leaving flushes remain best-effort with no browser-unload guarantee.

The bounded source evidence reports the focused server, client, claim/CAS,
QueryClient, approval-consumer, lint, TypeScript, and diff checks as passed;
the exact commands and result counts remain in the source evidence file. The
source snapshot and this docs packet do not claim E2E, browser-unload delivery,
full lifecycle, native-platform, or final acceptance. The app documentation
grant is exactly `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`,
`.github/consolidated-audit-dispositions.md`, `shared/workflowMeta.ts`, and
`src/lib/__tests__/workflowMeta.test.ts`; metadata edits are prose/assertion
only and no enum or action changed.

The companion website grant is the existing six pages
`docs/operations.md`, `docs/configuration.md`, `docs/diagnostics.md`,
`docs/opencode-integration.md`, `docs/ticket-flow.md`, and
`docs/system-architecture.md`, plus the four newly granted pages
`docs/api-reference.md`, `docs/frontend.md`, `docs/interview.md`, and
`docs/prd.md`, plus the narrowly granted `docs/beads.md`, for eleven website
files total. Website baseline is
`1c948d6aa56329f1346108b81293f3ff0e7a439e`; immutable CLI pin
`f784f055b45854016c245a2d902d6799b7e8265c` remains unchanged. Final source
review and acceptance remain with the root worker. The prior docs review used
tree inputs `3b40df98` (app) and `3ccdac9e` (website) and received `REVISE`;
those inputs are provenance only and do not claim current docs acceptance or a
final state. The two companion docs evidence files record the bounded
corrections.

## Parser foundation

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| P02 | PASS, root accepted | `parser-evidence.md`; block scalar bodies, including list-item bodies, remain byte-identical through repair. | No E2E or full lifecycle run. |
| P03 | PASS, root accepted | `parser-evidence.md`; raw valid YAML has authority and nested sequence entries stay nested during sibling repair. | No E2E or full lifecycle run. |
| P05 | PASS, root accepted | `parser-evidence.md`; quoted block headers track their bodies without repairing shell text inside. | No E2E or full lifecycle run. |
| P06 | PASS, root accepted | `parser-evidence.md`; uncertain flow, quoted, anchor, and tag nodes remain byte-for-byte unchanged. | No E2E or full lifecycle run. |
| P07 | PASS, root accepted | `parser-evidence.md`; CRLF and lone CR normalize before parsing and cache-key creation. | No E2E or full lifecycle run. |
| P08 | PASS, root accepted | `parser-evidence.md`; canonical alias precedence is preserved across buckets and payload order, with one conflict warning. | No E2E or full lifecycle run. |
| P09 | PASS, root accepted | `parser-evidence.md`; XML-looking lines are stripped only outside literal blocks and warnings name only removed tags. | No E2E or full lifecycle run. |
| P10 | PASS, root accepted | `parser-evidence.md`; list-item block-scalar indentation uses the mapping key column and preserves siblings. | No E2E or full lifecycle run. |
| P16.1 | PASS, root accepted | `parser-evidence.md`; fallback interview batch attempts retain candidate warnings. | No E2E or full lifecycle run. |
| P16.2 | PASS, root accepted | `parser-evidence.md`; PRD warnings distinguish reconstructed item changes from document-only changes. | No E2E or full lifecycle run. |
| P17.1 | PASS, root accepted | `parser-evidence.md`; YAML/JSON fence labels are case-insensitive. | No E2E or full lifecycle run. |
| P17.2 | PASS, root accepted | `parser-evidence.md`; bead iteration accepts only positive integers or numeric strings. | No E2E or full lifecycle run. |
| P17.5 | PASS, root accepted | `parser-evidence.md`; duplicate final-test file effects emit one warning per path while retaining merged content. | No E2E or full lifecycle run. |
| P17.6 | PASS, root accepted | `parser-evidence.md`; explicit blank status becomes pending with a warning, while absent/null keeps the default. | No E2E or full lifecycle run. |
| P18 | PASS, root accepted | `parser-evidence.md`; parse-cache invalidation fingerprints the complete repair/parser sources without runtime source reads. | No E2E or full lifecycle run. |

## Accepted beads contract packet

The beads packet is accepted for this integration checkpoint, with final source
assembly and the full part gate still pending. It covers the authoritative
JSONL contract, structured command producers, approval validation, runtime
diagnostics, and the affected board and workspace displays.

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| G02 | PASS, final pending | `/tmp/looptroop-beads-evidence.md`; runtime projections retain valid rows, expose `runtime.beadsDiagnostics`, and show board/workspace repair warnings while suppressing completion summaries when the tracker is damaged. | No E2E or full lifecycle run; five server suites need the later integration gate after the active CLI process exits. |
| W02 | PASS, final pending | Bead route, document, and graph tests treat `blocked_by` as authoritative and derive the inverse `blocks` edges on approval and save, so the editable dependency edge remains symmetric. | No E2E or full lifecycle run. |
| P01 | PASS, final pending | Approval and editor tests validate structured `CommandSpec` entries without bare-string shell guessing and surface actionable repair reasons for unrepresentable commands or damaged rows. | No E2E or full lifecycle run. |
| P04/P14 | PASS, final pending | ApprovalView keeps the immutable original draft baseline hash through edit, autosave, reload, save, and approve; stale writes return a typed `409` conflict rather than matching an English message. | No E2E or full lifecycle run. |
| P11 | PASS, final pending | Canonicalization and route tests retain unknown top-level and dependency metadata, while original JSONL source-line and field diagnostics remain attached to validation errors. | No E2E or full lifecycle run. |
| P15 | PASS, final pending | Damaged-tracker navigator/editor tests disclose malformed or unrepresentable lines and suppress anchors that cannot point to the raw editor content. | Native browser and assistive-technology verification remain unclaimed. |
| P17(3) | Partial, final pending | Alias precedence is covered for the accepted precedence subitem only; the remaining P17 findings are not attributed to this packet. | No E2E or full lifecycle run. |
| P19 | PASS, final pending | Shared dependency-graph and approval tests reject dangling `blocked_by` references and cycles before approval or write, reporting the offending ids. | No E2E or full lifecycle run. |
| U06 | PASS, final pending | BeadsApprovalEditor tests connect field labels and disclosure panels to native controls with programmatic names, `aria-expanded`, and `aria-controls`. | Native browser and assistive-technology verification remain unclaimed. |

The bounded packet evidence reports 264 server-pure tests, 53 doctor tests, 74
server integration tests in the later rerun, 71 workflow setup/execution/refine
tests, 3 draft/vote tests, 59 Manual QA tests, 85 client-node tests, and 62
client-DOM tests, with both TypeScript projects, focused lint, and diff checks
passing before the unrelated active-process error. Linux/Node execution was
used; native Windows/macOS, real-browser accessibility, E2E, and full lifecycle
checks remain outside this checkpoint.

## Accepted client recovery packet

The client recovery packet is accepted for this integration checkpoint. Its
source snapshot is `0c0ec89dab2da492983e4ce1993901288e745f3d`, based on
`2c6da1c4`; detailed evidence is in
`/tmp/looptroop-client-recovery-evidence.md`. It covers U24, U25, U26, U29,
U32, and U33(4,6); U33 was partial at that packet boundary. The combined forms
and log-history entries below complete the remaining U33 source scope. Final source integration, a
fresh Astra-low review, and the full application/part gate remain with the root
worker. No workflow status metadata changed in this packet.

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| U24 | PASS, final pending | `AIQuestionProvider` records a resolved `(ticket, session, request)` tombstone. Successful snapshots skip that identity until a later accepted snapshot omits it, so an in-flight or stale response cannot reopen a resolved question. Actual-hook tests cover GET-before-resolution, resolution-before-a-new-GET, a later request, and ticket removal/re-addition fencing. | No E2E or full lifecycle run; native Windows/macOS and the complete application/part gate remain unverified. |
| U25 | PASS, final pending | `useSSE` keeps the ticket-list refresh and uses the existing `collectQueryKeyStrings` predicate to invalidate cached families containing the affected ticket id. Contract coverage includes ticket, artifacts, interview, beads, skips, bead diffs, Manual QA, AI details, phase attempts, UI state, and log history, while another ticket remains untouched. | No E2E or full lifecycle run; native Windows/macOS and the complete application/part gate remain unverified. |
| U26 | PASS, final pending | Current ticket metadata is read through a ref, so ten-second ticket-list object replacement does not recreate the question-recovery callback. The recovery effect stays keyed to active-ticket membership, with an immediate poll and a 30-second interval verified by fake timers. | No E2E or full lifecycle run; native Windows/macOS and the complete application/part gate remain unverified. |
| U29 | PASS, final pending | The persisted-cursor flag triggers one initial cache recovery on `open` without clearing the cursor or reconnecting. An explicit `replay_gap` clears the cursor while retaining the live subscription and refreshes once; after that gap, later reconnects omit the cursor until a new event supplies one. Ordinary transport errors still invalidate the current ticket and ticket list without broad cache recovery, and the SSE tests cover both paths and duplicate-recovery avoidance. | No E2E or full lifecycle run; native Windows/macOS and the complete application/part gate remain unverified. |
| U32 | PASS, final pending | `useSSE` probes once per failed connection, re-arms after `open`, and leaves a normal 200 response signed in. `probeSessionAfterStreamFailure` uses the five-second backend-health deadline and releases its shared in-flight promise in `finally`; direct and actual-hook tests cover the deadline and next-probe behavior. | No E2E or full lifecycle run; native Windows/macOS and the complete application/part gate remain unverified. |
| U33(4) | PASS, final pending | Model queries and manual refresh retry only the exact startup response ``OpenCode server is not reachable. Start it with `opencode serve`.``. HTTP 500 failures use the existing normalized error and one request; query tests exercise the real hook retry and the manual-refresh no-retry path. | The forms packet below completes the remaining U33 source item; no E2E or full lifecycle run. |
| U33(6) | PASS, final pending | No source change was needed: the existing delivery path is `AIQuestionProvider.getRemainingMs` to `PendingQuestionsPanel`; `useCountdown` is enabled only for a non-null value, and `applyTimer` generation/revision checks accept only current frames. The focused review found no asynchronous stale-null delivery path to change. | The forms packet below completes the remaining U33 source item; no E2E or full lifecycle run. |

The exact focused Vitest command passed 4 files and 77 tests. Focused ESLint
reported no issues, `git diff --check` was clean, and `npm run typecheck` passed
with no diagnostics. `useSSE` is consumed by `TicketDashboard`; session probing
is called only by `useSSE`, while the fetch session watch remains installed by
`main.tsx`. OpenCode model queries feed `ModelPicker` and `ProfileSetup`; only
the explicit startup response retries.

## Accepted workflow safety documentation packet

This packet documents only the jointly accepted OpenCode and interview-core
source snapshots. The OpenCode source correspondence is tree
`2fb5495bce14c1019f2fd138e6ba03e6222f3ac4`, the interview-core correspondence
is tree `f98b6ab1d90889ef2efa5c342ebacea72e338d4b`, and both are based on
`27d4b28f16cb49fde66b888fa4d9a620b75ad60c`. Evidence is recorded in
`/tmp/looptroop-opencode-evidence.md` and
`/tmp/looptroop-interview-core-evidence.md`. This is a bounded documentation
checkpoint; final source integration and acceptance remain with the root worker.

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| W01 | PASS, final pending | Accepted interview compilation preserves an unanswered compiled question's stable ID while allowing a compatible reword; answered IDs, source/round, and answer controls remain immutable. | No E2E or full lifecycle run. |
| W03 | PASS, final pending | Accepted OpenCode context cache uses project-scoped composite ticket keys, external-id read-through, and canonical invalidation. | No E2E or full lifecycle run. |
| W04 | PASS, final pending | Accepted question and reply paths use the trusted stored session directory and fail closed when it is missing; caller-supplied project paths do not choose ownership. | No E2E or full lifecycle run. |
| W05 | PASS, final pending | Accepted interview generation and answer-edit paths share a durable claim, content fingerprint, and raw-content CAS. Late results and rollback cannot overwrite a newer edit, batch, completion, or released claim. | No E2E or full lifecycle run. |
| W07 | PASS, final pending | Foreign interview claims can be reclaimed after ordinary lease expiry—the fallback when liveness cannot be checked—or when a recorded PID is proven gone; a live lease protects live, invalid, or otherwise unverified owners. A pending-stop marker is separate non-expiring safety ownership and cannot be bypassed by lease expiry. | No E2E or full lifecycle run. |
| W08 | PASS, final pending | Answer and skip payloads require a positive `batchNumber`; stale or missing identity and unknown question, option, or reason IDs are rejected before claim or mutation. | No E2E or full lifecycle run. |
| W09 | PASS, final pending | The OpenCode and interview seams jointly require confirmed remote stop before cleanup, continuation, skip-all advancement, or exact pending-marker promotion. False, thrown, or unverified stops remain retryable, and delayed timeout recovery is fenced by the exact marker. | SQLite close/reopen is an in-process cache boundary, not a process restart. No live model or lifecycle run. |
| W10 | PASS, final pending | Prompt callback failures clean up before rethrow; timeout, transport, and context-wipe paths retain the accepted ownership and retry boundaries. | No E2E or full lifecycle run. |
| W18 | PASS, final pending | Cancellation propagates through session-directory and assistant reads, while health checks honor the cancellation signal. | No E2E or full lifecycle run. |
| W20 | PASS, final pending | Completed streamed text remains usable when the final assistant read fails, while abort errors still propagate. | No E2E or full lifecycle run. |
| W21 | PASS, final pending | Terminal completion, confirmed abort, and abandonment release directory maps; terminal abort is not cached by session id, so later prompts require fresh confirmation. | No E2E or full lifecycle run. |
| W22 | PASS, final pending | Per-session streams omit events without an explicit session ID and do not attribute unrelated global or directory-only events. | No E2E or full lifecycle run. |
| W24 | PASS, final pending | Context trimming visits all expendable parts at each priority until the budget is satisfied and retains mandatory details. | No E2E or full lifecycle run. |
| W25 | PASS, final pending | Automatic bead-response continuation within each bead iteration is bounded by finite configured `maxIterations`; `0` remains unlimited for that path. User-facing Continue across phases is separate. Context-wipe prompts use a short bounded timeout and do not swallow cancellation. | No E2E or full lifecycle run. |
| W26 | PASS, final pending | Mutation-tested seams cover adapter tool state, supervisor child identity, the schema-derived orphan foreign key, and expired-work-budget dispatch refusal. | No E2E or full lifecycle run. |
| P17(4) | PASS, final pending | Interview snapshot validation requires non-empty parseable timestamps for updated, completed, answer, skip, and submission fields without inventing repairs. | No E2E or full lifecycle run. |
| U19(3) | PASS, final pending | The client shares one same-tick submit/skip guard, sets it before the first await, and clears it in `finally`. | No E2E or full lifecycle run. |

The accepted OpenCode evidence reports the latest owned surface at 31 files and
505 tests, plus council boundary and downstream phase suites, with focused lint,
type checks, and diff checks passing. The accepted interview evidence reports
2 files and 60 pure tests, 3 files and 24 integration tests, 1 file and 1
safety test, 2 client files and 20 tests, 3 claim/CAS/storage files and 9
tests, plus lint, both TypeScript projects, and diff checks passing. Linux and
local SQLite fixtures were used. No E2E, full lifecycle, live model, native
Windows or macOS, physical-power-loss, or real process-restart result is
claimed. The startup marker fixture proves replay from a seeded marker without
module-map dependence; the SQLite close/reopen fixture is not a process restart.
If both SQLite and marker storage fail, only the current-process guard remains,
so restart safety is not promised.

The newer W06 and U18 save/log changes remain unaccepted and are intentionally
outside this packet. Their behavior is not used as source correspondence here.

## Accepted workflow and log-history documentation checkpoint

This prose checkpoint corresponds to accepted source trees
`c7357fe7eac855492961a7fd3edd7bd1083aa979` (workflow, 25 accepted source
files) and `64f08125396ef6dd19cb9ef23a8e831d71749f1f` (log history, 15 accepted
source files), reviewed against app baseline
`c662309ef80bd23a66b4f6a048e5d694a9b803e0` and website baseline
`353a36a1cc98d50b5a777c89aba300af3d0f9012`. It updates only the granted app
prose and website pages. This is a bounded documentation checkpoint: **PASS,
final pending**. It does not claim whole-repository source acceptance, final
part-gate acceptance, or delivery acceptance.

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| W11 | PASS, final pending | Serialized execution-setup regeneration parses before the lock, rereads state under the lock, and preserves commentary plus the structured/raw baseline; the actual route caller is covered by the focused route test. | No E2E or full lifecycle run. |
| W12 | PASS, final pending | Persisted merge/close decisions resume after interrupted dispatch and fence conflicting actions for the same PR; lifecycle callers and the actual close-completion writer are covered. | No live GitHub or full lifecycle run. |
| W14 | PASS, final pending | Initial remote refresh failures write typed `refresh_pull_request` receipts with the PR number, error, and null remote state/URL while leaving `WAITING_PR_REVIEW` without a decision; receipt persistence uses the real database writer, with deterministic provider failures in the tests. | Provider failures are mocks; no live GitHub or E2E run. |
| W15 | PASS, final pending | Recovery UI renders only server-advertised actions; metadata and the actual `ErrorView` DOM caller tests cover setup editing, note retry, and truthful details. | No E2E or full lifecycle run. |
| W16 | PASS, final pending | Parser and unknown hook-policy warnings remain visible in the approval pane and the real artifact viewer; DOM tests exercise the rendered callers. | No E2E or full lifecycle run. |
| W19 | PASS, final pending | Observed merged state is persisted before candidate/head rejection, so merged observation remains visible without representing close as success. | No E2E or full lifecycle run. |
| W23 | PASS, final pending | Skip receipt identity includes action, item, phase, and phase attempt; same-attempt writes are idempotent and later attempts receive new receipts using the existing uniqueness boundary. | No compatibility migration or legacy deduplication is claimed. |
| W27 | PASS, final pending | Manual QA Submit and Skip capture click-time draft/evidence/round synchronously; a later autosave remains the newer draft and does not replace submitted checks or cancel follow-up generation. Actual DOM and operation callers cover both actions. | Click snapshots are not unload-delivery guarantees; no E2E or full lifecycle run. |
| W28 | PASS, final pending | Null artifact attempts remain unknown rather than becoming zero, and unknown workflow statuses advertise no actions; route and metadata callers cover both. | No E2E or full lifecycle run. |
| W29 | PASS, final pending | Close reads live PR state before deciding, preserves generated artifact exclusions, and refuses arbitrary untracked-file exemptions; actual lifecycle callers cover merged and same-PR checkpoint fencing. | No E2E or full lifecycle run. |
| U20 | PASS, final pending | Historical cache identity keeps `all` distinct from other scopes while the debug wire view remains stable. | No E2E or full lifecycle run. |
| U21 | PASS, final pending | DEBUG history merges the three durable LoopTroop channels with ticket-session native OpenCode rows, preserving session filtering and mixed-source cursors. | Complete history still depends on available native files; upstream-deleted files cannot be recovered. |
| U22/U23 | PASS, final pending | Non-AI rows preserve server ordering; AI rows use stable timestamp/mirror/occurrence identity through JSON serialization. | No E2E or full lifecycle run. |
| U27 | PASS, final pending | Full drains retain native TanStack Query cancellation/refetch semantics, use `cancelRefetch: false` for older pages, and retry canceled or unchanged-cursor work without a global query interception. | No dependency or full lifecycle run. |
| U30 | PASS, final pending | Attempt-scoped bead identities and occurrence suffixes remain covered by the actual Full Log and Phase Log callers. | No E2E or full lifecycle run. |
| U31 | PASS, final pending | Action-triggered full drains suppress intermediate growing-array publication/sorts; native page materialization is LIMIT-bounded while lineage visibility work grows with ancestry depth. | No constant total query-work, bounded archive, or memory-free rendering claim. |
| U33(3) | PASS, final pending | Coding tail identity includes timestamps. | The forms packet below completes the remaining U33 source item. |
| U33(5) | PASS, final pending | Go-to-top scope and operation tokens retain canceled-owner isolation. | The forms packet below completes the remaining U33 source item. |
| U33 overall | PASS, final pending | Combined U33(1), U33(3), U33(4), U33(5), and U33(6) coverage across the forms, log-history, and recovery packets; item 2 does not exist. | No E2E or full lifecycle run. |

The workflow evidence reports 9 focused server files and 164 tests, a
three-file follow-up of 96 tests with 47 overlapping verify tests, four client
DOM files and 86 tests, one client-node file and 6 tests, passing typecheck,
focused lint, and diff checks. The log evidence reports 8 files and 234 focused
tests, four production probes, passing scoped lint and diff checks, and an
earlier handoff typecheck blocked only by the peer-owned
`server/workflow/mergeCompletion.ts` error. The current forms checkpoint passed
both configured TypeScript projects, superseding that historical handoff note
for this docs checkpoint. These totals are not double-counted. Exact source
manifests, commands, results, and limits remain in
`/tmp/looptroop-workflow-merge-evidence.md` and
`/tmp/looptroop-log-history-evidence.md`; no E2E, lifecycle, destructive,
staging, commit, or push operation is claimed.

The documented history boundary is deliberate: diagnostic native-log reads
remain bounded to ten files and 5 MiB per file, while complete DEBUG/history
actions read the available native set. Four retained snapshots support cursor
stability; expired cursors return `LOG_CURSOR_EXPIRED` rather than a partial
page. Cold or unseen sessions still scan the needed prefix, upstream-deleted
files cannot be recovered, and lineage visibility work grows with ancestry
depth. Initial mount remains paginated; full drains are action-triggered.

## Accepted client forms documentation checkpoint

This prose checkpoint also corresponds to the accepted forms source tree
`7575003e2ffb13f297afc35110d080dd14960b5b`, reviewed against app baseline
`c662309ef80bd23a66b4f6a048e5d694a9b803e0`. The packet covers the owned form,
model-picker, folder-picker, prompt-editor, diff, artifact-viewer, and routed
modal callers listed in `/tmp/looptroop-client-forms-evidence.md`. This is a
bounded documentation checkpoint: **PASS, final pending**. It does not claim
whole-repository source acceptance, final part-gate acceptance, or delivery
acceptance.

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| P12/P13 | PASS, final pending | `ArtifactContentViewer` pairs equal-length plan/refined beads positionally, falls back to IDs when lengths differ, and uses the same pairs for rows and added-field counts; parsed expansion inputs are reused for the displayed sections. | No E2E or full lifecycle run. |
| U05/U13 | PASS, final pending | `ModelPicker` distinguishes committed selection from keyboard-active option state with `aria-selected` and `aria-activedescendant`, and announces loading and model-query errors through live status/alert regions. | Native browser and assistive-technology verification remain unclaimed. |
| U08 | PASS, final pending | Prompt editing keeps canonical save echoes, failed-save/revert feedback, later typing, prompt switches, dirty refetches, and preview results fenced to the current prompt and draft; explicit Revert adopts the returned default when the request snapshot is still current, while later edits remain dirty. | No E2E or full lifecycle run. |
| U09 | PASS, final pending | Folder navigation and Git checks fence out-of-order responses; transient check failures are an error state with Retry, distinct from a valid path that is not a Git repository. | No E2E or full lifecycle run. |
| U14 | PASS, final pending | The implemented `/` shortcut is board search only. | No E2E or full lifecycle run. |
| U19 | PASS, final pending | Profile, project, ticket, and prompt forms compare actual snapshots, including custom controls; hydration/refetch does not absorb edits, successful saves acknowledge the submitted snapshot, failed saves retain drafts, and dirty modal close warns only while current values differ. The text diff has a bounded fine-grained fallback that returns full replacement text. | Unsaved in-memory modal drafts are not claimed to persist across reload; no E2E or full lifecycle run. |
| U33(1) | PASS, final pending | Artifact readers use the current phase log rows through the log context and a stable load action, so structured expansion parsing/counting is not repeated for unrelated streamed log-context updates. | Combined U33 completion is recorded above; no E2E or full lifecycle run. |

Forms evidence reports 8 independent real probes, 12 focused files with 292
tests, focused lint and diff checks, both TypeScript projects, and the final
Profile test plus all 22 blob-equality checks. The changed-path manifest is the
22 source/test paths recorded in `/tmp/looptroop-client-forms-evidence.md`;
the packet-listed `PromptsDialog` and `ProjectsPanel` test paths are absent in
this checkout. No source, status metadata, cache implementation, or security
file was edited.
The combined accepted count was **141/154 (~92%)** at the forms boundary; the
cache packet raised it to **145/154 (~94%)** before the security packets. The
accepted A, B, and C security packets now bring the root source-finding
checkpoint to **154/154**. At that earlier delivery checkpoint, the four
finished delivery PRs were 163, 164, 165, and 166; the current seven-PR
delivery checkpoint above supersedes that provisional count.

## Accepted client ticket-cache documentation checkpoint

This prose checkpoint also corresponds to the accepted cache source tree
`3631150064d4e689a227cb5e3a2deaf3601b41e3`, reviewed against app baseline
`c662309ef80bd23a66b4f6a048e5d694a9b803e0`. The exact source and test manifest
and bounded results are recorded in `/tmp/looptroop-client-ticket-cache-evidence.md`.
This is a bounded documentation checkpoint: **PASS, final pending**. It does
not claim whole-repository source acceptance, final part-gate acceptance, or
delivery acceptance.

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| U10 | PASS, final pending | Ticket-list rows are normalized independently, so a malformed row is warned and skipped while valid rows survive; detail responses remain strict. Sparse action patches accept only valid fields, preserve good cached values when a field is invalid, and allow an explicit valid empty array to clear a collection. | No E2E or full lifecycle run. |
| U11 | PASS, final pending | Patch scalar and occurrence validation is presence-sensitive, and project deletion matches the exact project-id prefix instead of numeric coercion. The direct action test proves invalid title/project data cannot erase a cached value while a valid status still applies. | No E2E or full lifecycle run. |
| U15 | PASS, final pending | Confirmed ticket/project deletion cancels and removes ticket-keyed query families, clears durable logs, seen notices, UI revisions, rendered state, SSE cursor generations, question-collapse state, pending AI-detail invalidation, and the UI-state deletion fence; lists are retained for their normal refetch and unrelated tickets remain untouched. Reissued ids therefore start without the old cursor or rendered marker. | No E2E or full lifecycle run; cross-tab cleanup is not claimed. |
| U17 | PASS, final pending | The delete barrier settles pending UI-state saves before DELETE, releases the queue on a failed delete, and fences late responses after confirmed deletion so stale writes cannot recreate state. Direct mocked coverage exercises both failed-delete recovery and same-id reissue. | No E2E or full lifecycle run. |

Cache evidence reports 8 focused files and 100 tests, the supplied Astra-low
reviewer repro with 1 pass and 5 skips, focused ESLint with no issues, both
configured TypeScript projects, and a clean manifest diff. The current-tab
boundary is intentional: no cross-tab deletion broadcast or other untested
remote cleanup is promised. The cache packet boundary was **145/154 (~94%)**;
the accepted A, B, and C security packets now bring the root source-finding
checkpoint to **154/154**.

## Accepted security documentation checkpoint

This prose checkpoint corresponds to the accepted security source trees
`e08fc7cb1345732d571228506b1bae26bffef511` (A),
`6751ecc73c27cc7bc284cca594a15a6cce6e48af` (B), and
`77c385a6f1604861e25d5cbf5620faefb66c09f3` (C), reviewed against the current
application and website checkpoints. The security source-finding count is
**154/154**. This is a bounded documentation checkpoint. Its earlier timing
language that four PRs remained open, five were active, and parts 6 and 7 were
pending is historical and superseded by the current seven-PR delivery
checkpoint above; it does not claim final acceptance.

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| S05 | PASS, final pending | Local mode recognizes only loopback Host authorities; Origin parsing rejects non-canonical hostname spellings and explicit port `0`, and same-authority Origins must match the actual scheme, hostname, and effective port. Explicit configured development origins retain their configured scheme. Remote opt-in does not claim a new strict Host-name validator for requests without an Origin; bearer-only requests remain supported. | No E2E or full lifecycle run. |
| S06 | PASS, final pending | Project, Git and hook commands, and managed or development OpenCode launches remove only the two LoopTroop daemon credential names after merged overrides, while retaining intentional provider and Git credentials and the trusted CLI handoff. | Child-environment filtering is not a process sandbox; no E2E or full lifecycle run. |
| S07/S08/S09 remaining/G26 | PASS, final pending | Static launch and filesystem checks cover the tested AST forms and exact filename-plus-operation boundaries. Existing contained, no-follow, managed-root and ticket-root helpers remain the runtime contract; the project browser is metadata-only. | The rules do not claim whole-program alias or dataflow analysis; no E2E or full lifecycle run. |
| S10 | PASS, final pending | SSE admission reserves before asynchronous setup, preserves six per-ticket and 100 global slots, and cleans up reservations idempotently. | No E2E or full lifecycle run. |
| S11 | PASS, final pending | Local-mode Host validation is limited to loopback authorities. Origin parsing rejects non-canonical hostname spellings such as alternate IPv4 forms and explicit port `0`; same-authority Origins must match the actual scheme, hostname, and effective port. Remote mode does not add a strict Host-name validator to requests without an Origin. | No native Windows/macOS run. |
| S12(1) | PASS, final pending | Manual QA action IDs use the documented restricted character set and 160-character maximum. | The row covers action IDs only. |
| S12(2) | PASS, final pending | The existing G14/S12 row covers contained project and ticket roots, opaque legal path characters, and Windows ADS rejection. | This row is the durable path subset; it does not absorb the other S12 rows. |
| S12(3) | PASS, final pending | Authority parsing rejects explicit port `0`, including zero-padded forms, before remote request handling. | No E2E or full lifecycle run. |

The A, B, and C packets reported their focused tests, active full lint and both
TypeScript projects, scoped diffs, and platform limits in
`/tmp/looptroop-request-security-evidence.md`,
`/tmp/looptroop-child-env-evidence.md`, and
`/tmp/looptroop-lint-security-evidence.md`. The S09 row above covers the
remaining static-boundary subset; the release-maintenance S09 row at the top of
this ledger remains a separate disposition. Likewise, S12(1) and S12(3) are
request-boundary rows, while S12(2) remains the earlier contained-path row.
No E2E, full lifecycle, live provider, native Windows/macOS, physical-power-loss,
or all-PR completion result is claimed here.

## Installer foundation

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| R08 | PASS, root accepted | `installer-evidence.md`; lock recovery requires proof that the recorded owner exited and blocks malformed or unverifiable owners. Website `docs/installation.md#standalone-executable` describes the conservative recovery. | No install lifecycle was run. |
| R09 | PASS, root accepted | `installer-evidence.md`; signal cleanup releases only the current lock token before re-raising. | No install lifecycle was run. |
| R10 | PASS, root accepted | `installer-evidence.md`; an unreadable status plus an unexecutable installed copy fails closed and leaves it untouched. | No install lifecycle was run; no native Windows or Docker run. |
| R20 | PASS, root accepted | `installer-evidence.md`; the Windows-only forwarding check inspects the handwritten forwarding block. | PowerShell is unavailable on this Linux runner. |
| R22 | PASS, root accepted | `installer-evidence.md`; POSIX forces installer style and PowerShell rejects empty bound values before forwarding. | PowerShell is unavailable on this Linux runner. |
| R25 | PASS, root accepted | `installer-evidence.md`; launcher and installer help point to `nvm install 24`, verified with isolated nvm `v0.40.7` and Node `v24.21.0`. | The nvm run was Linux-only; no native Windows verification. |

## Existing baseline coverage

| Finding | Status | Documentation coverage |
| --- | --- | --- |
| G36 | Documented | Fresh project databases are the supported starting point. No legacy duplicate-receipt migration or deduplication is promised; the documented recovery is backup, remove the named old project database, and attach again. |
| S01–S04 / R01 root | Documented current behavior | Windows extensionless resolution follows `PATHEXT` sibling order before trust checks; verified unmapped-owner handling is noted for containers and sandboxes. |
| U01–U04, U07, U12 | Documented current behavior | Modal route/back synchronization, popup Escape and focus ownership, modal stacking, mobile drawer dialog behavior, focus restoration, breakpoint cleanup, and hidden-ancestor focus handling are summarized for users. |

## R12 source evidence and applied choice

The install catalog is present in the current app worktree and is checked out by
the website at immutable source ref
`f784f055b45854016c245a2d902d6799b7e8265c`, pinned in website commit
`83cdf633`. Website CI checks out that ref into `.source/LoopTroop`, and the
verifier uses `LOOPTROOP_SOURCE_ROOT` when set or the local sibling checkout
otherwise. A missing catalog fails with an actionable error; there is no reduced
two-channel fallback. The implementation ref and website pin were reviewed
independently; this docs checkpoint does not advance either one.

## Integration limits

- The current seven-PR delivery checkpoint above is complete for its bounded
  local gates and fresh Astra review; all seven PRs remain open and unmerged,
  and no CI result was awaited or accepted.
- The final combined validation evidence records the local application,
  package, workflow, and documentation gates as passing: 6,458 tests passed,
  13 were skipped across 440 files, and the verified native Linux SEA build plus
  Linux `amd64` container-build checks passed. This does not turn the bounded
  evidence into final repository or PR acceptance.
- All 358 changed paths are covered by the part manifests. That is a
  path inventory, not independent behavior proof for each path.
- `release-scripts-evidence.md`: `/tmp/looptroop-release-scripts-evidence.md`
- `release-workflow-evidence.md`: `/tmp/looptroop-release-workflow-evidence.md`
- `parser-evidence.md`: `/tmp/looptroop-parser-evidence.md`
- `installer-evidence.md`: `/tmp/looptroop-installer-evidence.md`
- No E2E, full lifecycle, live publish, native Windows, physical-power-loss, or website source-pin change is claimed in this checkpoint. The final published website checkpoint is independently reviewed at main commit `2226ab575a2e37d0cb0f63651d2a070f0ee33c6d`; the release packet's local Linux amd64 Docker build is evidence only, with no multi-architecture, publication, or container lifecycle result claimed.
- The accepted release packet now includes the R01 published-smoke launch diagnostic, count-free R30 wire-contract documentation, and the exact native SEA Node `26.9.0` source behavior. The app/package/container floor remains Node `24.18.1`; local release evidence covers Linux amd64 and Linux x64 only. No E2E, full lifecycle, live publish, native Windows, macOS or arm64 binary success, multi-architecture build, registry attestation/publication, or website source-pin update is claimed here.
- The root worker must rerun any app version/catalog checks after final source integration. The current website immutable source ref and matching CI checkout point at `f784f055b45854016c245a2d902d6799b7e8265c`; later source integration must update them together if required.
- Future not-yet-implemented report packets need their own documentation pass; this ledger does not pre-document them.
