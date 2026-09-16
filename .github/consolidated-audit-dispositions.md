# Consolidated audit documentation ledger

This ledger records documentation coverage for reviewed packets. `PASS` means
the named packet evidence passed its bounded review; final integration and
acceptance remain with the root worker. A row never implies that an unreviewed
or unimplemented finding is complete.

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

- `release-scripts-evidence.md`: `/tmp/looptroop-release-scripts-evidence.md`
- `release-workflow-evidence.md`: `/tmp/looptroop-release-workflow-evidence.md`
- `parser-evidence.md`: `/tmp/looptroop-parser-evidence.md`
- `installer-evidence.md`: `/tmp/looptroop-installer-evidence.md`
- No E2E, full lifecycle, live publish, native Windows, physical-power-loss, or website source-pin change is claimed in this checkpoint. The existing website pin is independently reviewed at commit `83cdf633`; the release packet's local Linux amd64 Docker build is evidence only, with no multi-architecture, publication, or container lifecycle result claimed.
- The accepted release packet now includes the R01 published-smoke launch diagnostic, count-free R30 wire-contract documentation, and the exact native SEA Node `26.9.0` source behavior. The app/package/container floor remains Node `24.18.1`; local release evidence covers Linux amd64 and Linux x64 only. No E2E, full lifecycle, live publish, native Windows, macOS or arm64 binary success, multi-architecture build, registry attestation/publication, or website source-pin update is claimed here.
- The root worker must rerun any app version/catalog checks after final source integration. The current website immutable source ref and matching CI checkout already point at `f784f055b45854016c245a2d902d6799b7e8265c`; later source integration must update them together if required.
- Future not-yet-implemented report packets need their own documentation pass; this ledger does not pre-document them.
