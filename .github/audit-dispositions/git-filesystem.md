# Git and filesystem durability audit ledger

This ledger covers only the reviewed Git safety and durable-IO packets for
this part. `PASS, final pending` records packet evidence and still requires a
fresh review of the finished part diff. It is not final acceptance.

## Scope and boundaries

The part includes Git G01, G05, G06, G13, G15, G22-G24, G31.2/G31.3, R23,
W17 and W29.1, plus durable IO G03, G08-G14, G16, G25, G30.1-G30.4, G32 and
S12(2). The shared workflow metadata source and test were copied unchanged.

Release and installer work, executable resolution, parser and bead contracts,
client routing, CLI/process recovery, hooks, and unrelated status changes are
outside this part. No website files or source files outside the accepted
packet were changed.

## Git safety packet

| Finding | Status | Evidence and detailed coverage | Limits |
| --- | --- | --- | --- |
| G01 | PASS, final pending | Local Git mutations use bounded async cleanup, including SIGTERM, SIGKILL escalation, descendant termination, and awaited settlement. The process-tree fixture covers a redirected-stdio, SIGTERM-ignoring descendant and leaves no index lock after timeout. | No E2E or full lifecycle run. |
| G05 | PASS, final pending | Staged-then-deleted paths are omitted from the commit pathspec while real files remain attributable; a repeat finalization is a no-op. | No E2E or full lifecycle run. |
| G06 | PASS, final pending | Origin fetch uses the explicit bounded fetch timeout and preserves the repository failure contract. | No live remote fetch or lifecycle run. |
| G13 | PASS, final pending | NUL-delimited readers keep spaces, tabs, newlines, backslashes, non-ASCII, and rename/copy paths opaque. | No E2E or full lifecycle run. |
| G15 | PASS, final pending | Repository, base-branch, GitHub, push, initialization, and focused-diff boundaries share strict ref validation for option-leading, control, whitespace, duplicate-dot, slash, `@`, dot-component, and `.lock` names. | No E2E or full lifecycle run. |
| G22 | PASS, final pending | Synchronous spawn setup failures return the documented failed outcome instead of throwing; NUL argv and missing-command cases are covered. | No E2E or full lifecycle run. |
| G23 | PASS, final pending | Candidate paths reject absolute, drive, dot, control, and symlink-ancestor escapes while allowing a legal final symlink and valid POSIX bytes. | Native Windows is not locally verified. |
| G24 | PASS, final pending | Git child environments add `BatchMode=yes` when SSH settings are absent, preserve genuine caller settings and intentional empty values, and resolve availability against the effective environment. | No live remote authentication run. |
| G31.2/3 | PASS, final pending | SSH alias discovery caches only successful non-empty results and retries transient failures; GitHub and push share command-availability and timeout semantics without a permanent negative cache. | No live remote authentication run. |
| R23 | PASS, final pending | Malformed or oversized `GIT_CONFIG_COUNT` skips helper injection with a warning and preserves caller-provided configuration keys. | No live remote authentication run. |
| W17 | PASS, final pending | Remote branch deletion requires a 40-64 character hexadecimal expected head and combines an explicit branch refspec with `--force-with-lease`; invalid or missing heads skip deletion. | No live remote deletion. |
| W29.1 | PASS, final pending | Worktree cleanliness and bead commit capture share the generated-file allowlist; tracked and unexpected untracked changes remain visible. | No E2E or full lifecycle run. |

The packet evidence is in `/tmp/looptroop-git-evidence.md`. Its focused Git
and integration run passed 185 tests across 16 files, the process-tree
regression rerun passed 23 tests across 2 files, and the workflow/routes/CLI
run passed 173 tests across 10 files. Packet lint and diff checks passed.

## Durable IO packet

| Finding | Status | Evidence and detailed coverage | Limits |
| --- | --- | --- | --- |
| G03 | PASS, final pending | Execution-log appends resolve the canonical project root before containment checks, including symlink aliases, while rejecting outside roots. | No E2E or full lifecycle run. |
| G08 | PASS, final pending | Fallback copies use exclusive no-follow targets, record target identity before copying, short-write loops, fsyncs, identity checks, and a matching `.recovery` ownership marker. Unresolved ownership or completeness preserves the files and raises a typed recovery error. | Physical power loss and native Windows are not locally verified; names-based checks cannot eliminate every ancestor replacement race. |
| G09 | PASS, final pending | YAML and whole-file JSONL temps require an exclusive, fsynced `.proof` with byte length and SHA-256 before promotion; stale proof sidecars are removed only for known artifacts. | Physical power loss and native Windows are not locally verified. |
| G10 | PASS, final pending | Whole-file JSONL recovery accepts only proof-backed empty files or complete newline-terminated records; unproved, torn, invalid, oversized, and unrelated temps remain untouched. | Physical power loss and native Windows are not locally verified. |
| G11 | PASS, final pending | Atomic appends hold one process-shared SQLite lock across the size read, short-write loop, fsync, and returned byte range. | Physical power loss and native Windows are not locally verified. |
| G12 | PASS, final pending | Manual QA discard and quarantine use `lstat`, copy final symlink entries without dereferencing them, protect outside or dangling targets, and verify source/destination device-inode identity before and after bounded quarantine comparisons so an atomic replacement cannot be mistaken for an identical backup. | Native Windows is not locally verified. |
| G13 | PASS, final pending | Manual QA operations use NUL-safe Git readers without trimming, backslash rewriting, or path reinterpretation. | Native Windows is not locally verified. |
| G14/S12(2) | PASS, final pending | Project and ticket roots are absolute and contained; POSIX slashes, spaces, trailing backslashes, carriage returns, and legal colons remain usable while Windows ADS syntax is rejected after a valid drive. Invalid route paths return structured client errors. | Native Windows is not locally verified. |
| G16 | PASS, final pending | Manual QA event reads use safe parsing, skip and warn on invalid shapes, return diagnostics, retain raw lines, and keep later appends working. | No E2E or full lifecycle run. |
| G25 | PASS, final pending | Evidence locking uses a persistent native SQLite database with `BEGIN IMMEDIATE`, bounded async retries, rollback/close release, and process-death release. The database is never unlinked. | Physical power loss and native Windows are not locally verified. |
| G30.1-4 | PASS, final pending | Startup scans canonical roots and known config/ticket allowlists, skips unsafe unknown artifacts, verifies identity before cleanup, fsyncs promotion parents, and preserves unrelated configuration. | No E2E or full lifecycle run. |
| G32 | PASS, final pending | `RecoveryBlockedError` propagates from config and ticket recovery only for unresolved in-progress fallback ownership or completeness, before projections, hydration, timers, or execution. | No E2E or full lifecycle run. |

The packet evidence is in `/tmp/looptroop-io-evidence.md`. The scoped rerun
passed 198 tests across 10 files, with 4 platform-conditional skips. Both
application and test typechecks, packet lint, and packet diff checks passed.

## Recovery and preservation rules

An ordinary orphan YAML or whole-file JSONL temp without proof, including an
empty JSONL temp, is warned about and left unpromoted. An unresolved in-progress fallback whose
ownership or completeness cannot be proved raises `RecoveryBlockedError` and
reports `RECOVERY_BLOCKED` before startup projections, ticket hydration,
timers, or execution. The target, source temp, marker, and any retained
cleanup sidecar remain available for manual recovery. This daemon-level
startup failure is separate from ticket `BLOCKED_ERROR`.

YAML `.proof`, fallback `.recovery`, marker staging `.recovery.write-*`, and
retained `.remove-*` files are intentional. SQLite may create `-journal`,
`-wal`, and `-shm` files beside the persistent lock database. Cleanup of
selected runtime and temporary children preserves runtime logs; the persistent
Manual QA SQLite database is outside that transient cleanup scope. Evidence
uploads reject symlinks, while workspace-drift quarantine copies the link
entry itself instead of its external target. Existing quarantine files are
reused only when the compared descriptors still belong to both pathnames; a
replacement is retained at its action-specific retry destination.

## Round-two verification

The second review pass added four confirmed filesystem/process defects and one
shared cleanup guard. Worktree fallback removal now verifies the original target
generation as well as its managed parent after the awaited Git call. The Free
Disk Space terminal-ticket path opts into the shared remover's conservative
ignored-file check; explicit deletion APIs remain destructive. The guard
enumerates ignored untracked entries with a NUL-delimited Git listing; inspection
failures are fatal, and only `.ticket/` or `.looptroop/` entries are treated as
LoopTroop-owned. Recovery markers now say
whether the fallback target is complete, so a later boot preserves a target that
received newer appends. Manual QA contains quarantine parents without following
an existing final symlink, and runtime shutdown drains tracked detached Git/GitHub
children before closing the server.

The second-pass ledger classifies the remaining observations as deferred or
owned by their relevant packets: timeout/probe performance, the sync index
helper, parser consolidation, recovery allowlist expansion, and power-loss fsync
suggestions were not part of this fix. Hook-validation mutations and the cleanup
preview belong to PR 166/root. Darwin case folding and cross-process Manual QA
append repair were withdrawn after tracing the current platform and writer
contracts. Sonar path/log annotations remain false positives or duplicates of
the earlier dispositions. Shared CI now uses native temporary paths and the
isolated database-test bucket; this review did not alter those root-owned files.

Native Windows, physical power loss, unsupported directory fsync behavior, E2E,
full lifecycle runs, and live remote operations are not claimed here. The
documentation integration notes and source traces are in
`/tmp/looptroop-git-io-docs-evidence.md`; the original audit report remains
read-only at `tmp/report/consolidated-report.md`.
