# CLI and execution-hook recovery audit ledger

This ledger covers only the accepted CLI/process and execution-hook recovery
changes in this part. `BOUNDED ACCEPTED` records local evidence plus the fresh
source/integration review for this part's narrow scope only; it is not
whole-audit or final acceptance.

## Scope and boundaries

The source scope is the 27-file CLI/process manifest and the 10-file execution
hook manifest supplied with this part. The implementation covers CLI cleanup,
daemon ownership, process identity, log-follow handoff, IPv6 origins, OpenCode
step-cap recovery, protected Git-hook validation, bead checkpoint ordering, and
the staging exclusions required by those safeguards.

Git/filesystem durability, release/installers, parser and bead contracts,
interview and approval saves, client routing, and unrelated workflow changes
remain outside this ledger. No website files or lifecycle/E2E tests are part of
this isolated worktree.

## Narrow review checkpoint

Fresh Astra-low aggregate review ACCEPTed the actual source/integration diff
for this part: 270 independent tests across 14 suites and the 43-path narrow
manifest were exact for the reviewed scope. The review did not accept the
whole audit, broaden the source boundary, or replace the platform and
lifecycle limits below.

## Findings

| Finding | Status | Evidence and detailed coverage | Limits |
| --- | --- | --- | --- |
| G04 | BOUNDED ACCEPTED | The authoritative OpenCode step-cap marker lives in owner-only app configuration keyed by the ticket-directory hash; the ticket-side copy is convenience-only. Exact-original/absent settlement is allowed, while edited, malformed, foreign, or unreadable existing-authority cases preserve the capped config and refuse destructive reset. An active handle stops with the exact marker path if it cannot reapply the cap after a reset; after restart with no marker, ownership is not inferred from absence or the local copy. Bead and squash staging exclude only the proven root config. | No E2E or full lifecycle run. |
| G07 | BOUNDED ACCEPTED | Coding no longer writes a common Git exclude rule for the temporary root config. Root-path detection follows the actual worktree and keeps nested and distinct legal names separate. | Native Windows/macOS equivalent-case behavior is not locally verified. |
| G17 | BOUNDED ACCEPTED | `clean --apply` rechecks managed-root containment, ownership markers, activity, ticket registration, and Git state immediately before removal. | No E2E or lifecycle run; native Windows is not locally verified. |
| G18 | BOUNDED ACCEPTED | Stale daemon cleanup re-reads the requested instance under the existing lock before deleting state, preserving a successor record. | No E2E or lifecycle run. |
| G19/G20 | BOUNDED ACCEPTED | G19 covers signal identity: destructive signals require a matching process start token and recheck identity before each signal, leaving missing, recycled, or unverifiable identities alone. G20 covers concurrent start ownership: readiness accepts only the originally spawned child’s PID plus matching start token; a tokenless same-PID record is reported as unverifiable, and another start’s ready state is reported as already running. Incomplete OpenCode shutdown persists a shutdown-pending guard with the daemon lock/state and retry path; accepted or pending CLI shutdown is never force-escalated or cleared prematurely, and the daemon keeps capped-backoff retries after listener loss. The supervisor retains its direct handle until tree termination is proven; Windows requires successful `/T` taskkill completion plus leader exit, so leader-only exit remains retryable. | No E2E or lifecycle run. |
| G21 | BOUNDED ACCEPTED | Timeout escalation carries the captured process token and, on Linux, a group snapshot captured while the leader is verified so descendants can still be terminated after the leader exits. A tokenless platform uses only the owned `ChildProcess` handle and never invents numeric-pid ownership. | Native Windows and non-Linux retained-group behavior are not locally verified. |
| G27 | BOUNDED ACCEPTED | Shared daemon-origin formatting brackets bare and already-bracketed IPv6 literals across CLI output and health URLs. | Native Windows/macOS are not locally verified. |
| G28 | BOUNDED ACCEPTED | `logs --follow` registers its watcher before draining the handoff and carries byte offset, partial-line, and UTF-8 decoder state across reads and rotation. | No E2E or lifecycle run. |
| G29 | BOUNDED ACCEPTED | Protected Git-hook validation persists an identity-bound marker with worktree/Git-directory identities, index/worktree trees, and initial untracked paths. Reentry restores only attributable state and preserves unknown additions. | No E2E or full lifecycle run. |
| G29 follow-up | BOUNDED ACCEPTED | The crash marker now lives in owner-only application data outside the worktree. Reentry preserves Git path bytes, validates marker/index data, compares tracked, staged, and untracked state before any restore, preserves later edits, and carries exact index bytes so intent-to-add and index flags survive. | No E2E or full lifecycle run. |
| G30.5-.7 | BOUNDED ACCEPTED | Cap handles retain ownership evidence on conflicts; root-config path checks follow actual filesystem equivalence; stale temp cleanup removes only a regular file with a positive exited writer PID and leaves live, fresh, invalid, symlink, and unknown-error temps visible. | Symlink and equivalent-case coverage is host-specific; Windows symlink creation may require privileges. |
| G30 sidecar integrity | BOUNDED ACCEPTED | Malformed, foreign, unreadable, and mismatched existing authoritative markers remain pending/conflicting instead of being silently ignored or overwritten. Exact original bytes (or absent original plus absent current file) settle ownership; the mutable ticket copy is never authority. Active retries stop rather than proceed uncapped when the marker or expected config cannot be verified; a restart with no marker does not guess ownership. | No E2E or full lifecycle run. |
| G31.1/G31.4 | BOUNDED ACCEPTED | Windows path-safe log shortening preserves safe path boundaries, and runtime ordering awaits the prior close before starting the successor process. | Native Windows behavior is not locally executed; no E2E or full lifecycle run. |
| G31.2/G31.3 | OWNED BY PART2 | These G31 subsets belong to the Git/filesystem part and are not accepted or claimed by this ledger. | Part2 evidence and limits apply. |
| W13 | BOUNDED ACCEPTED | Coding records `HEAD` before publishing `in_progress`; a failed checkpoint leaves the bead pending and makes no execution call. | No E2E or full lifecycle run. |
| S09 (shared-guard subset) | BOUNDED ACCEPTED | OpenCode step-cap JSON validation reuses the shared record guard. This row covers that subset only. | The remaining S09 scope is outside this part. |

## Evidence and limits

The review follow-up and permanent test evidence are recorded in
[`pr166-review-dispositions.md`](../pr166-review-dispositions.md).
The isolated checks include the exact manifest tests, application and test
typechecks, full lint, package/build/version/install-script/license checks, and
workflow shell/action checks that are available on this host. Fixture stderr is
reported separately from actual warnings. The fresh Astra-low review described
above is the source/integration review for this narrow ledger; it does not
claim whole-audit acceptance.

The packet covers Linux/Node fixtures and contained temporary Git repositories.
It does not claim native Windows or macOS execution, physical power-loss
behavior, E2E, startup or daemon lifecycle behavior, live remote operations,
installation, deployment, or final acceptance.
