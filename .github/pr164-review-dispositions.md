# PR #164 review dispositions

Windows CI follow-up: PR 168 job `105308919869` exposed a test-only path-spelling
mismatch inherited from this branch. Recovery deliberately scans canonical
paths, so its legacy-temp warning uses `runneradmin`, not the `RUNNER~1` alias
in Windows' temporary-directory environment. The assertion now compares the
native canonical path; it still requires the exact preserved file to be named.

This ledger covers every captured PR comment, review, inline finding, and CI
notice in `/tmp/looptroop-pr-review/164.json`, `164.md`, `164-refresh.json`,
and `164-delta.md`. The dispositions were checked against the current branch,
the accepted audit decisions, and the focused tests listed below.

Disposition labels:

- **correct** — the finding applies and this branch fixes it, or records the
  required cross-platform test/diagnostic.
- **better** — the concern is real, but the safer root-cause change differs
  from the suggested patch.
- **wrong** — the reported data flow or security premise does not hold.
- **not-applicable** — a status summary, duplicate, an accepted decision, or
  work owned by another stacked packet.
- **deferred** — a real observation outside this packet's owned changes, kept
  visible for the owner or a later packet.
- **withdrawn** — targeted verification found that the proposed defect does not
  apply to the current platform or writer contract.

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
| 5717133545 | Codacy status | not-applicable | A status summary with no file, rule, or source details; the concrete analyzer findings are assessed in the inline records below. |
| 5717565922 | SonarCloud quality gate | correct | The gate accurately reports open security findings, which are individually classified below. The reachable log-injection sink is fixed; the remaining path/oracle reports are documented false positives for intentional project discovery and diagnostics. |

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
| 4038893711 | `server/phases/manualQa/checkpoint.ts` | correct | Reusing an existing quarantine copy now proves that both opened descriptors still match their pathnames by device/inode (with size and timestamps as the portable fallback) before and after the bounded comparison. The regression replaces the source while its old descriptor is being read and verifies the replacement is retained at an action-specific retry destination. |
| 4038934279 | `server/git/runCommand.ts` | wrong | The requested project directory is passed as the child working directory, never concatenated into an argument or shell command. `runGit*` requires an absolute, NUL-free path; callers derive it from the explicitly selected repository, and the generic `gh` working directory is likewise a project root. |
| 4038934330 | `server/git/runCommand.ts` | wrong | `gitIndexLockPath` reads `.git` metadata below the caller-selected project solely to improve a timeout diagnostic. It does not publish, mutate, or expose a path outside that requested repository boundary. |
| 4038934358 | `server/git/runCommand.ts` | wrong | The reported `resolve`/`lstat` path is the same validated project working directory used for the Git operation; this diagnostic lookup cannot turn a request into an arbitrary write or shell execution. |
| 4038934395 | `server/git/runCommand.ts` | wrong | Async Git uses the validated project directory as `spawn`'s `cwd`; it is not interpolated into a command string and the child receives an argv array. The runner's generic `cwd` is internal CLI/GitHub project context, not a path component assembled from an untrusted filename. |
| 4038934428 | `server/git/runCommand.ts` | wrong | The existence check only decides whether to add a timeout explanation for the index lock in the same requested repository. It is not an authorization check or a cross-root file read, so Sonar's filesystem-oracle taint is not a reachable disclosure boundary here. |
| AaCwCmwAYG7j__vPWQCi | `server/routes/projects.ts` | wrong | `access` is the deliberate first probe for the folder-picker and repository-discovery endpoints. `normalizeFolderPath` rejects relative paths and constrains WSL drive mappings; users are selecting the local repository they want to attach, not supplying a path to a hidden project-root join. |
| AaCwCmwAYG7j__vPWQCh | `server/routes/projects.ts` | wrong | `/projects/ls` is explicitly a directory browser for choosing a project. Its absolute normalized path is the requested directory, and the response lists only directories found there; restricting it to an already attached root would remove the attach flow rather than fix traversal. |
| AaCwCmwAYG7j__vPWQCg | `server/routes/projects.ts` | correct | A POSIX filename may contain newline and other control bytes. The missing-path warning now JSON-encodes both path values so user-controlled bytes cannot forge additional log records while the diagnostic remains readable. |
| AaCwCm3mYG7j__vPWQCk | `server/git/runCommand.ts` | wrong | `spawnSync` receives a resolved executable path and a separately validated working directory; no path is parsed as a shell command or appended to argv. The runner intentionally supports inspection of the user-selected folder before it is attached. |
| AaCwCm3mYG7j__vPWQCj | `server/git/runCommand.ts` | wrong | The async runner has the same boundary as the synchronous path: executable resolution is trusted, argv is an array, and `cwd` is the selected absolute project directory. This is not a traversal through a repository-relative filename. |
| AaCwCm3mYG7j__vPWQCo | `server/git/runCommand.ts` | wrong | `statSync` is only a post-spawn check used to distinguish a missing working directory from a missing Git executable. It follows the caller's requested directory and does not use the result to authorize a write. |
| AaCwCm3mYG7j__vPWQCl | `server/git/runCommand.ts` | wrong | The `.git` lookup is a read-only timeout diagnostic rooted at the selected project directory; it does not accept a separate user-controlled suffix and cannot escape through a pathspec. |
| AaCwCm3mYG7j__vPWQCn | `server/git/runCommand.ts` | wrong | Reading the linked-worktree `.git` file and resolving its `gitdir` is required to name a lock in the repository Git is already operating on. The value is diagnostic-only and is never used as a command or mutation target. |
| AaCwCm3mYG7j__vPWQCm | `server/git/runCommand.ts` | wrong | The lock existence probe only enriches a timeout error for the caller's selected repository. It does not reveal an unrelated path and cannot be used to choose a later filesystem operation. |

## Round 2 captured comments and CI

The second-pass corpus and CI were reread after the first intake. Every new
comment is classified below, including observations that were withdrawn after
verification. The four confirmed source defects are fixed in this branch; the
conservative ignored-file guard is also shared by `removeWorktree` for the
root-owned cleanup preview to call. Real Git worktrees use Git's ignored-file
listing; pre-start ticket skeletons are inspected directly so parent-repository
ignored files cannot block them, while unknown skeleton entries still fail
closed.

| ID | Observation(s) | Disposition |
| --- | --- | --- |
| 5718956696 | Sonar quality-gate status with no new source claim. | not-applicable — status only; concrete analyzer keys remain classified below. |
| 5719140396.1 | Detached async Git/GitHub children survive daemon shutdown. | correct — fixed with an active child set, awaited SIGTERM/SIGKILL cleanup, and runtime-close integration coverage. |
| 5719140396.2, .10 | Synchronous `core.sshCommand`/`gh` availability probes add per-call latency. | deferred — genuine performance work, outside this packet's four correctness fixes. |
| 5719140396.3 | Hook-validation mutations still use the sync runner. | not-applicable — owned by PR 166. |
| 5719140396.4 | The G-03 regression mock can pass with the source fix reverted. | deferred — test-quality follow-up; the source boundary and alias tests remain intact. |
| 5719140396.5 | Darwin case folding should match Windows. | withdrawn — case-sensitive APFS is valid; no blanket lowercasing is safe without a platform-volume probe. |
| 5719140396.6 | Symlink-ancestor refusal is absent from some Manual QA callers. | deferred — the supplied-root fail-closed policy is intentional and caller-wide normalization belongs to its owning packet. |
| 5719140396.7 | Manual QA tail repair is outside the append lock. | withdrawn — one daemon owns this synchronous repair/read/dedupe/append sequence and no supported cross-process writer exists. |
| 5719140396.8, .9, .11, .12 | Dead sync restore path, lock-file documentation, mutation-command heuristic, and unrelated `.gitignore` change. | not-applicable — cleanup/documentation follow-ups or unrelated scope, not this packet's filesystem defects. |
| 5719140396.13 | `RECOVERY_BLOCKED` needs an operator path. | correct — README and the recovery ledger now say that preserved files require manual inspection/reconciliation before restart. |
| 5719152175.1 | Preserved final quarantine symlinks fail before collision handling. | correct — parent-only containment plus no-follow final-entry checks allow a retry copy without touching the link target. |
| 5719152175.2 | Quarantine comparison needs stable descriptor snapshots. | correct — existing descriptor/path identity checks and bounded comparison regressions cover replacement during reads. |
| 5719152175.3 | Manual QA repair/read/dedupe/append needs a cross-process lock. | withdrawn — same single-daemon writer contract as 5719140396.7. |
| 5719152175.4 | Fallback cleanup can delete a replacement worktree target. | correct — target device/inode/birthtime generation is rechecked after Git yields. |
| 5719152175.5 | Completed fallback markers can rewind later appends. | correct — markers distinguish incomplete from complete publication; completed targets are never recopied over newer bytes. |
| 5719164166 | Mutation-argument heuristic, SSH probe cost, and trailing-slash behavior. | deferred/withdrawn — heuristic and probe are low-risk follow-ups; trailing slashes are valid POSIX distinctions. |
| 5719164166.O-1/O-2 | Startup remains blocked on unresolved recovery; cleanup timers stay referenced. | correct/not-applicable — fail-closed recovery and awaited timer cleanup are intentional; README records the manual recovery path. |
| 5719170844.1 | Timeout path may wait for the full abandon grace after a fast child exit. | deferred — lifecycle/timing redesign is outside this focused fix and remains bounded. |
| 5719170844.2 | Symlinked repository roots are rejected by candidate filtering. | not-applicable — supplied-root symlink refusal is the accepted fail-closed policy. |
| 5719170844.3-.5, .8-.9 | Recovery allowlist additions, Windows signature normalization, staged deletion, parser consolidation, and marker-rename retry. | deferred — separate artifact/Git packets; no ownership assigned here. |
| 5719170844.6 | Windows ADS path handling. | correct — already fixed by the shared contained-path and repo-path guards. |
| 5719170844.7 | Windows `ino: 0` weakens parent/target generation checks. | correct — portable birthtime is now part of the worktree entry identity. |
| 5719265675 | Append final-symlink, index snapshot, candidate fallback, and SSH-probe concerns. | deferred — separate atomic/index/integration/performance work; Darwin case-fold item withdrawn for the reason above. |
| 5719612146.1 | Preserved quarantine symlink retry is unreachable. | correct — fixed by the quarantine-path helper and regression. |
| 5719612146.2-.4 | Project attach error mapping, human-vs-NUL candidate display, and launcher allowlist. | deferred — other route/integration/recovery ownership. |
| 5719612146.open-1 | Symlinked root aliases are rejected by candidate filtering. | not-applicable — intentional supplied-root policy. |
| 5719612146.open-2 | A source-only torn marker with no target blocks startup. | correct — when the target is absent, recovery retires the unusable marker and republishes the already validated temp with an exclusive create; an existing target still remains blocked because no owner can be inferred. Regression coverage exercises both cases. |
| 5720118916.1, .5 | SSH probe overhead and allowlist maintenance. | deferred/not-applicable — performance/documentation follow-ups. |
| 5720118916.2 | Synchronous append locking can block under contention. | not-applicable — bounded, near-zero-contention path; no new cross-process writer contract. |
| 5720118916.3-.4 | Missing `@{` test and relative-folder-path behavior. | deferred/correct — test gap is separate; relative paths intentionally fail closed and routes map them. |
| 5720118916.6 | Duplicate marker publication. | correct — completion markers now publish an explicit incomplete state before copy and complete state after fsync. |
| 5720937325.1-.5, .8, .10, .12 | Bead projection, stale cleanup plan, OpenCode conflict, revision validation, index rollback, ignore-rule ownership, and nested config recovery. | deferred/not-applicable — separate owners or later packets; root owns cleanup-plan revalidation. |
| 5720937325.3 | Recursive fallback can race an abandoned Git child. | deferred — requires lifecycle/process-confirmation work beyond this cleanup-generation fix. |
| 5720937325.6 | Manual QA dedupe outside append lock. | withdrawn — no supported cross-process writer; same verified contract as 5719140396.7. |
| 5720937325.7, .11 | Sync lock contention and SSH probe latency. | not-applicable/deferred — bounded current behavior and separate performance follow-up. |
| 4039445727 | Sonar log-injection key duplicates the already encoded project diagnostic. | wrong — no new unescaped sink. |
| 4039492795 | Sonar log-injection key is the same encoded diagnostic under a new analysis. | wrong — duplicate of 4039445727. |
| 4039872942 | First target-identity marker publication needs recovery evidence. | correct — fallback writes an identity-bearing incomplete marker before copy and a complete marker after publication. |
| 4039872956 | Quarantine copy should fsync before source discard. | deferred — physical power-loss durability is unclaimed in this packet and remains in the audit limits. |

## Verification

### Additional refreshed envelopes

Reviews `5238175126`, `5238259722`, and `5238307294` have empty bodies; associated inline/analyzer findings are assessed individually. Greptile `4038819640` correctly observes that repository-local `core.sshCommand` can execute an arbitrary configured wrapper. On 2026-09-17 the owner explicitly chose to keep trusted-project behavior and document it. G24 therefore continues to preserve repository-local SSH configuration. README, contributor guidance, and website notes warn that remote Git operations and connection checks can execute a wrapper with the user's permissions. This is an accepted trust boundary, not a sandbox guarantee or an unresolved choice.

Root's follow-up bounds quarantine comparison memory to two 64 KiB buffers,
uses the shared no-follow regular-file opener, and checks file size and
modification time after reading. This branch also checks descriptor device and
inode identity before and after reading, so a replacement cannot be mistaken
for the opened file. Multi-chunk regressions verify identical backup reuse and
preservation of a later same-sized change at its recorded retry destination.

Focused checks on this branch included:

- The latest focused rerun covered six files and 127 tests: run-command and
  fallback (28), worktree removal, recovery, GitOps, and runtime-close; all
  passed. It includes the Windows-shaped taskkill cleanup and already-closed
  server retry regressions.
- The cleanup follow-up reran worktree removal with 19 passing tests, the
  project-router read-only-cache regression (1/1), and project storage cleanup
  (4/4), including parent-ignored and skeleton-owned `.env` cases.
- Earlier packet checks also covered path normalization, atomic IO, project
  routes, and Manual QA operations. Those results remain in the initial
  intake record; they are not repeated as evidence for the final source
  changes here.
- `npm run typecheck` passed after the final recovery and runtime-close
  changes, and the touched-file ESLint check passed.
- `git diff --check` is rerun after this ledger update and before commit.

Native macOS/Windows runs, physical power-loss recovery, live remote
authentication, E2E, and full lifecycle tests remain unclaimed. Website
documentation is root-owned; the source-doc changes here require the matching
website impact review before publication.

## Final analyzer annotation review

At head `2a93137`, CodeQL check `105301519108` repeats the two already assessed
findings: the atomic-write SHA-256 integrity proof is not password hashing,
and the Git SSH command fixture uses a fixed executable with an argv array.
Neither warrants weakening integrity checks or adding shell escaping to argv.

Sonar check `105300939661` and analysis `105300935246` retain the eight
previously assessed project-path findings and assign a new key
`AaCwTSgwT2w_qkSFC5HS` to `projects.ts:142`. Both paths in that diagnostic were
already JSON-encoded by `2404f50c`; embedded line breaks cannot forge another
log record. This new key does not identify a new unescaped logging path.

Codacy check `105299321905` has four path-taint annotations. At
`recovery.ts:224`, the joined segments come from a relative path already checked
against the canonical root, with every component checked for symlinks. At
`recovery.ts:845`, joining the caller's root spelling is only for the returned
report; filesystem operations use the separately guarded canonical path.
At `storage/paths.ts:34,35`, drive mapping checks that the resolved result stays
inside the existing mount before using it. These four reports are false
positives under those explicit checks.

No external finding was dismissed or suppressed. The CodeQL, Sonar, and Codacy
gates still report these annotations; these dispositions do not claim green CI.
