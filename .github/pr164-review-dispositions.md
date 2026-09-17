# PR #164 review dispositions

This ledger covers every captured PR comment, review, inline finding, and CI
notice in `/tmp/looptroop-pr-review/164.json` and `164.md`. The dispositions
were checked against the current branch, the accepted audit decisions, and the
focused tests listed below.

Disposition labels:

- **correct** — the finding applies and this branch fixes it, or records the
  required cross-platform test/diagnostic.
- **better** — the concern is real, but the safer root-cause change differs
  from the suggested patch.
- **wrong** — the reported data flow or security premise does not hold.
- **not-applicable** — a status summary, duplicate, an accepted decision, or
  work owned by another stacked packet.

## Captured comments

| ID | Source | Disposition | Evidence and decision |
| --- | --- | --- | --- |
| 5706274980 | Codex summary | not-applicable | Summary only; its actionable filesystem and Git points are covered by the corresponding inline records below. |
| 5706277887 | CodeRabbit summary | not-applicable | Summary only; the six actionable records are independently disposed below. |
| 5706282743 | Codacy status | not-applicable | Metrics/status notice without a concrete source finding; Sonar’s four regex findings are addressed in 5706304681. |
| 5706303123 | Gitar CI | correct | macOS `/private` and Windows 8.3 path spellings caused the atomic-IO failures; recovery now reports caller-visible paths. The Windows Manual QA integration test gets a 120-second budget for its real Git teardown; focused integration tests pass. |
| 5706304286 | Qodo summary | not-applicable | High-level description and diagram only; individual findings are covered by 5706355269 and the inline records. |
| 5706304681 | SonarCloud | correct | The four S8786 warnings were confirmed in the captured Sonar response. Trailing-separator/setup-root normalization now uses linear loops; the anchored drive-prefix check remains a linear regular expression. |
| 5706311043 | Greptile summary | correct | The empty/unproved JSONL concern is fixed with proof sidecars and regression tests. Legacy JSON-lock migration is deliberately not applicable: fresh installs are the supported contract and migration would race SQLite creation. |
| 5706355269 | Qodo detailed review | correct | Recovery rechecks the canonical root and every ancestor before filesystem access, scans stale known proof sidecars, and records fallback target identity before copying. JSONL is proof-backed, rename status preserves its column, Darwin case folding was removed, and the legacy-lock item is not applicable under the fresh-install decision. |
| 5714089461 | Claude Opus | correct | Configured `core.sshCommand` is preserved; Manual QA restore/discard/commit mutations use bounded async Git operations and index rollback; timeout cleanup timers remain referenced until settlement. The detached-child and broader route-ownership suggestions are outside this packet. |
| 5714175157 | Antigravity | correct | Fallback markers now record the exclusive target before copying, so an interrupted copy can resume or block with ownership evidence. Timeout cleanup keeps its bounded escalation alive; focused recovery and run-command tests pass. |
| 5714225863 | Union Alpha | correct | Quarantine collisions are idempotent for identical entries and use an action-ID-derived `.attempt-<hash>` destination for different retries; the actual destination is stored in the receipt and event. |
| 5714240245 | Union Alpha | correct | Empty and non-empty JSONL whole-file writes require a matching length/hash proof and a complete trailing newline; unproved temps remain for inspection. |
| 5714240296 | Union Alpha | correct | Manual QA restore, clean, add, and commit paths now use bounded asynchronous mutation calls; checkpoint and operations callers await them. |
| 5714275039 | Claude Code | better | The trailing-slash test weakness is fixed with direct normalization coverage. Missing findings in beads, shared excludes, clean planning, CLI/process cleanup, and marker schema are accepted decisions or other stacked packets; no duplicate changes were made. |
| 5714295405 | Union Alpha | correct | Git probes preserve an effective repository `core.sshCommand` and only add the noninteractive fallback when no SSH configuration is active; a wrapper-based regression test proves it. |
| 5714328746 | Muse Spark pass 1 | correct | The route error regression and trailing-space repository-root path were fixed in the path boundary and project routes. Bead aliases, execution setup exclusions, shared `info/exclude`, and case-sensitive execution exclusions belong to other packets/accepted decisions. |
| 5714612944 | Muse Spark pass 2 | correct | The route root parser now requests untrimmed Git output and removes only its platform terminator; Manual QA sync mutations are converted. The `ssh -G` request-path latency and hook-validation sites are outside this packet. |
| 5714878480 | OpenCode independent review | correct | NUL-delimited Git diff output is retained alongside the human summary and consumed by candidate audits without trimming path bytes. The supplied-root symlink policy is intentionally fail-closed in the shared path helper; hardlink-unavailable fallback records ownership before copying. |
| 5714892533 | Codex independent review | correct | The in-scope synchronous Manual QA mutations and trailing-space Git-root truncation are fixed. OpenCode conflict ownership, shared excludes, clean-plan races, CLI lifecycle, and nested config recovery are accepted decisions or other packets. |

## Captured reviews

| ID | Source | Disposition | Evidence and decision |
| --- | --- | --- | --- |
| 5229554823 | Sourcery | not-applicable | Review-limit notice; no source finding. |
| 5229557316 | Amazon Q | not-applicable | Approval summary only; no actionable comment. |
| 5229561932 | GitHub Advanced Security | not-applicable | Empty review body; the concrete CodeQL records are 4031832093 and 4031832103. |
| 5229570617 | Codex | not-applicable | Informational review card with no actionable body. |
| 5229577822 | Greptile | not-applicable | Informational review card; detailed Greptile findings are captured separately. |
| 5229606370 | Qodo | not-applicable | Informational review card; detailed Qodo findings are captured separately. |
| 5229621160 | CodeRabbit | correct | Six actionable prompts duplicate the inline records below; each has an explicit disposition and regression evidence. |

## Inline findings

| ID | Path | Disposition | Evidence and decision |
| --- | --- | --- | --- |
| 4031832093 | `server/io/atomicWrite.ts` | wrong | CodeQL interpreted the SHA-256 integrity proof as a password hash. It hashes artifact bytes for crash-completeness validation and never handles credentials; SHA-256 is the required integrity primitive. |
| 4031832103 | `server/git/__tests__/runCommand.test.ts` | wrong | CodeQL’s command-sanitization warning is in a test-only `execFileSync` fixture with fixed executable and argument arrays; no request value reaches a shell. |
| 4031840234 | `server/io/fileLock.ts` | not-applicable | Legacy JSON-lock migration is intentionally excluded for fresh installs; attempting rename/unlink migration would race new SQLite creation. Incompatible old files fail explicitly. |
| 4031840237 | `server/phases/manualQa/checkpoint.ts` | correct | Quarantine retries use deterministic action-specific destinations, compare identical existing entries idempotently, and record the actual destination in receipts/events. |
| 4031847151 | `server/io/recovery.ts` | correct | Unproved empty JSONL temps are left in place; proof-backed empty JSONL is promoted. The test suite covers both cases. |
| 4031847155 | `server/io/fileLock.ts` | not-applicable | Same fresh-install decision as 4031840234; no unsafe legacy migration was retained. |
| 4031873523 | `server/git/worktreeChanges.ts` | correct | Darwin is no longer assumed case-insensitive; only Windows folds case. Setup-root trailing separators are removed without a superlinear regex. |
| 4031873552 | `server/io/recovery.ts` | correct | The mandatory recovery path guard rechecks the canonical root and all ancestors before opens, links, marker publication, promotion, and cleanup, rejecting symlink substitutions. |
| 4031873557 | `server/git/github.ts` | correct | `readGitDiff` now requests a NUL-delimited, no-renames name-status stream, and candidate parsing preserves spaces, non-ASCII bytes, and other opaque path bytes. |
| 4031873567 | `server/io/fileLock.ts` | not-applicable | Fresh installs do not promise migration of a pre-SQLite JSON lock; preserving an optional migration path would add a deletion race. |
| 4031873572 | `server/io/atomicWrite.ts` | correct | `safeAtomicWriteWithin` requires the shared path resolver to reject final symlinks during initial resolution and every recheck. Root's failing-then-passing regression inserts a link immediately before canonical resolution, proving a separate precheck was insufficient. Contained directory links remain supported. |
| 4031887209 | `server/git/runCommand.ts` | correct | Timeout kill and abandonment timers remain referenced while settlement is deferred and are cleared only after settlement; focused command tests cover bounded timeout behavior. |
| 4031887228 | `server/git/worktreeChanges.ts` | correct | Filesystem case behavior is platform-aware, preserving case-sensitive macOS volumes; trailing setup separators use a linear loop. |
| 4031887231 | `server/git/worktreeRemoval.ts` | correct | After the awaited Git removal, cleanup revalidates managed-root containment and the parent directory device/inode identity before fallback deletion; a replacement-parent regression test preserves the outside tree. This narrows, but cannot mathematically eliminate, a names-based check/use race. |
| 4031887234 | `server/io/atomicAppend.ts` | correct | A process-shared SQLite lock spans fstat, newline repair, every short write, fsync, and the returned byte range. |
| 4031887237 | `server/io/fileLock.ts` | not-applicable | Legacy JSON-lock migration is excluded by the fresh-install decision; SQLite errors remain explicit rather than deleting an unknown file. |
| 4031887244 | `server/storage/paths.ts` | correct | WSL drive mapping uses `resolve` and verifies the result remains below the mounted drive; traversal such as `D:/../../etc` is rejected. |

## Verification

Root's follow-up bounds quarantine comparison memory to two 64 KiB buffers,
uses the shared no-follow regular-file opener, and checks file size and
modification time after reading. A multi-chunk regression verifies identical
backup reuse and preservation of a later same-sized change at its recorded
retry destination.

Focused checks on this branch included:

- `vitest` pure path/Git tests: path normalization 16 passed, 3 skipped;
  worktree removal 11 passed; related pure tests were rerun after each fix.
- `vitest` integration recovery: 20 passed; atomic IO: 60 passed; project
  routes: 27 passed; Manual QA operations/checkpoint: 26 passed.
- `tsc --noEmit --pretty false` passed before the final route/path additions;
  it is rerun as part of the handoff checks.
- `git diff --check` passed before the final documentation and disposition
  edits; it is rerun before commit.

Native macOS/Windows runs, physical power-loss recovery, live remote
authentication, E2E, and full lifecycle tests remain unclaimed. Website
documentation is root-owned; the source-doc changes here require the matching
website impact review before publication.
