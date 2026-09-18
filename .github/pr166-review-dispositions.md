# PR166 review dispositions

## Second review: cleanup checkpoint (2026-09-18)

- `5720943681`, failed worktree enumeration: correct, fixed. A failed or empty
  listing is unknown registration state, not an empty set of registered trees.
  Both planning and the final removal recheck preserve the directories.
- Additional related finding: newline-delimited registration output split
  valid project paths. Cleanup now uses Git's documented
  [NUL-delimited porcelain format](https://git-scm.com/docs/git-worktree).
- Regression evidence: the two real cleanup paths deleted their fixture
  worktrees before the fix; the unusual-path test also failed. All three now
  pass, along with the full cleanup suite (34 tests) and localized lint.
- The owner decision is implemented in both CLI cleanup and Free Disk Space:
  ignored files block removal except LoopTroop-owned runtime artifacts. CLI
  preview and final removal use the shared PR164 guard. Its 37-test cleanup
  suite includes ignored `.env`, dependency directories, and a non-Git ticket
  skeleton beside an unrelated parent repository's ignored files.

## Refreshed review results

Review envelopes `5711203814`, `5711214465`, `5232949839`, `5232966028`, and `5232968427` contain summaries or no independent finding. Qodo's suggested native handles, disposable worktrees and stash recovery are alternatives, not required changes; the scoped identity and durable-marker approach is retained. Human finding `5714260774` is correct and fixed: destructive clean holds the daemon lock through worktree removal and orphan termination, preventing a concurrent daemon from adopting that service before it is stopped.

The refresh of `5711202910` is a skipped-review notice, `5711240530` marks all three hook-recovery findings resolved, and `5711263036` reports no new finding. Sonar `5717800525` identified repeated start-command test setup; the fixtures now share their setup without dropping cases. Codacy `5717789800` reports nine critical findings; the linked detail and inherited filesystem boundaries are being investigated separately, not claimed fixed from the summary alone.

This is the permanent disposition for every review comment, inline finding,
summary, and CI/analyzer observation collected for PR166. Statuses describe the
decision made here, not an assertion that the full repository or every target
platform was tested.

## Round 3 implementation updates (2026-09-18)

- OpenCode step-cap recovery now keeps the authoritative record in
  `<app-config>/opencode-steps/<ticket-directory-hash>.json`; the ticket-side
  file is only a live-run convenience copy. Exact original bytes (or an absent
  original with an absent current file) settle ownership. Existing malformed,
  foreign, unreadable, or otherwise unverified authoritative records preserve
  the config and block destructive recovery. An active handle stops its retry
  with the exact marker path if it cannot verify or reapply the cap after a
  reset; after a restart with no marker, the code does not infer ownership from
  absence or from the mutable local copy.
- Incomplete managed OpenCode shutdown retains daemon state, lock ownership, a
  referenced heartbeat, and the authenticated control plane when it remains
  available. A persisted shutdown-pending guard blocks generic cleanup and CLI
  force escalation; POSIX can trigger an identity-checked in-process retry, and
  the daemon itself retries with capped backoff when its listener is gone. The
  supervisor retains the direct child handle until the owned tree is proven
  gone; on Windows, a successful `/T` taskkill completion plus leader exit is
  required, so leader-only exit remains retryable. The CLI returns a retryable
  incomplete result rather than clearing ownership.
  Startup cleanup that cannot prove its child tree stopped records the owned
  base URL, pid, and optional start token; later starts remain blocked until an
  identity-proven cleanup settles the tree.
- Hook-validation recovery failures are structured refusals naming the exact
  retained marker path and manual remedy. Advisory validation does not continue
  over a state whose restoration could not be proven.
- Windows live child handles use tree termination even when start-token lookup
  is unavailable; once the direct handle exits, an unproved numeric pid remains
  untouched. Timed identity/group probes are asynchronous/bounded and Linux
  refreshes are minimized to the live ownership window.
- CLI cleanup applies the shared strict non-Git skeleton guard at the final
  destructive boundary and preserves ignored files. Log follow handles
  copytruncate with a private pending/completed generation witness, bounded
  initial-tail retries, and captured-generation checks before emitting chunks;
  interrupted read windows are discarded rather than emitted as unverified data.

Historical baseline references (not this round's evidence) are commit
`3b2bf11` on `fix/audit-cli-hooks` and the PR164 dependency `aa3c4685`;
the current implementation evidence is the commit produced from this round.

## Findings and review comments

| Source and item | Disposition | Committed evidence and impact |
| --- | --- | --- |
| Qodo inline 4034624868; Greptile 4034638650; Codex inline 4034640672 — interrupted hook recovery overwrote later tracked or staged edits | FIXED | `server/phases/executionSetup/hookValidation.ts` compares tracked, staged, untracked, and exact index bytes before any restore. Mutating `write-tree`, `read-tree`, `add`, and `restore` calls now use the bounded async Git runner, so hook/filter work cannot block the event loop. `hookValidation.test.ts` covers a later untracked addition, an index flag change whose tree is unchanged, and path-preserving recovery. Ambiguous worktrees retain the marker and all current edits. |
| Qodo inline 4034624876 — a hook can delete its in-worktree crash marker | FIXED | `getHookValidationRestoreMarkerPath` stores the marker in owner-only application data, with contained no-follow reads/writes. The worktree cannot remove the only recovery record; README, status metadata, and changelog describe the boundary. |
| Qodo inline 4034624889; Union 5714232585 — retained marker replays a stale snapshot after a later repair or temporary cleanup warning | FIXED | Recovery preflights before mutation and `restoreWorktreeSnapshot` removes the marker after successful restoration before best-effort temp disposal. A failure retains the marker and refuses replay. |
| Greptile 4034638655; Copilot 5714237947 — malformed or missing OpenCode sidecar silently loses cap ownership protection | FIXED | `server/phases/execution/opencodeStepsConfig.ts` keeps the authoritative record in owner-only app configuration, distinguishes absent, foreign, valid, and malformed records, and treats every unverified existing authoritative record as pending/conflicting. The ticket-side copy is convenience-only; an active retry throws with the exact marker path instead of continuing uncapped when reapplication cannot be proven. With no marker after restart, it does not guess ownership from the local copy. Existing sidecar tests cover missing local copies, exact-original settling, malformed records, foreign-marker refusal, and active retry stopping. |
| Claude Opus 5714128308.1; Union 5714223829; DeepSeek 5714879050.2; Codex 5714893017.1; Union follow-up 5719143791.1; Claude round 2 5719232398.1 — timeout misses descendants after the launcher exits | FIXED / BOUNDED | `server/lib/commandExecutor.ts` captures timed-command identity and a verified Linux process-group snapshot at spawn, refreshes it at a bounded one-second interval for three seconds, and refreshes again while the leader is still verified at escalation. `processTree.ts` retains verified descendants after leader exit, uses the shared refresh path, and falls back only to the owned direct handle when identity probing is transiently unavailable. Descendants created after the final verified scan remain intentionally unproven. Process-tree and command-executor regressions cover late membership, leader exit, recycled PIDs, and direct-handle safety. |
| Claude Opus 5714128308.2; Antigravity 5714188298.1; Codex 5714893017.2 — edited capped `opencode.json` blocks reset/retry | ACCEPTED OWNER DECISION | The accepted G04 decision deliberately keeps the conflict guard: destructive reset must not overwrite user edits or reverse the cap's ownership protection. `gitOps.ts`, the app-owned marker and convenience copy, status details, README, and changelog explain the retained file/evidence. The requested retry-route redesign belongs to the workflow owner and is not silently weakened here. |
| Claude Opus 5714128308.3; Antigravity 5714188298.2; Muse 5714329284 marker item — unknown hook-created paths cause destructive replay or an opaque loop | FIXED | `recoverPersistedWorktreeSnapshot` checks additions before `read-tree`/`restore`, leaves unknown paths and the marker intact, and returns an actionable path-specific message. Status details and README describe the refusal. |
| Claude Opus 5714128308.4; Antigravity 5714188298.3; Copilot 5714237947; DeepSeek 5714879050.3; Union follow-up 5719143791.2; Muse 5719612558.1 — concurrent start adopts another PID or reports a healthy winner as failure | FIXED | `waitForReady` is one token-aware result function. It returns `ready`, `other-instance`, `unverifiable`, or `not-ready`; same-PID state without a token remains accepted only when this invocation still holds a live direct `ChildProcess` handle, including the inverse case where the parent has a token but the published state does not. `startCommandAbandon.test.ts` covers PID mismatch, both token-missing directions, live direct-child readiness, and an exited handle representing a recycled PID. |
| Claude Opus 5714128308.5; DeepSeek scope-gap; Muse 5714614437 — stale daemon cleanup can race startup | FIXED / BETTER | `clearStaleDaemonState` delegates to instance-scoped lock-safe cleanup. `clean --apply` now holds the daemon lock through removal and orphan termination, preventing a new daemon from adopting an orphan during cleanup. A start that cannot safely serialize fails closed rather than deleting a successor. |
| Claude Opus 5714128308.6 — missing `beadStartCommit` retry fallback | FIXED IN PR167 | PR167 captures the initial checkpoint before publishing `in_progress`, rechecks cancellation after capture, and persists checkpoint and active status together. A capture failure keeps the bead pending for the existing retry path. Focused workflow regressions pass; the branches are also tested together. |
| Claude Opus 5714128308.7 — non-follow logs lack a prompt-separating newline for a partial final line | NOT APPLICABLE TO THIS DIFF | The current logs implementation intentionally preserves whether the tail ended in a complete newline and the existing focused log-follow changes cover byte/decoder handoff. Adding a newline in non-follow mode is a CLI presentation choice outside the reviewed ownership fixes; no correctness or cleanup state is lost. |
| Claude Opus 5714128308.8; Muse 5714329284 lookup item — `closedByProject` key normalization | FIXED | `cleanCommand.ts` normalizes the candidate lookup key before reading the map, while final removal still revalidates ownership and Git state. |
| Claude Opus 5714128308.9 — G04 implementation is sound | CORRECT | Retained as an explicit owner decision; no weakening was introduced. |
| Claude Opus 5714128308.10 — G29 marker design is sound | CORRECT | Strengthened further with external storage, preflight checks, exact index bytes, and malformed-index validation. |
| Claude Opus 5714128308.11 — test mock uses fixed PIDs | NOT APPLICABLE | The mock is isolated behind `vi.doMock` and never signals host PIDs; production process identity remains token-checked. No runtime behavior is affected. |
| Claude Code 5714260602.1 — title/part numbering mismatch | NOT APPLICABLE | Metadata wording is not a source defect and changing the title is outside this worktree's code ownership. The permanent ledger and scoped audit ledger identify the actual CLI/hook scope. |
| Claude Code 5714260602.2; Muse pass-one token note — legacy tokenless daemon records are not adopted | ACCEPTED OWNER DECISION | This alpha project does not preserve old installs. A tokenless record is deliberately unverifiable and is never treated as a concurrent winner or signalled by numeric PID; a spawned handle may still be stopped directly. |
| Claude Code 5714260602.3; Union follow-up 5719143791.5; Muse 5719612558.3 — `defaultTermination.request` changed tokenless semantics / injected termination was bypassed | FIXED / ACCEPTED OWNER DECISION | Numeric process-group and taskkill operations remain token-gated. `OpenCodeSupervisor` now uses its own live `ChildProcess` handle when the token probe is unavailable, waits through the injected `ProcessTermination`, and retains the cleanup handle until termination is confirmed. `supervisor.test.ts` covers direct-handle cleanup, injected waits, retry after failed cleanup, and deterministic fake-PID termination. |
| Claude Code 5714260602.4 — missing positive stop test | CORRECT | Existing PR166 `tests/stopCommand.test.ts` covers valid-token termination; new supervisor and process-tree tests cover positive owned-handle termination. |
| Claude Code 5714260602.5 — invalid/overlong UTF-8 suffix edge cases | NOT APPLICABLE | `incompleteUtf8Suffix` only withholds valid incomplete sequences; invalid bytes are decoded by Node as replacement characters and are not treated as ownership or file data. The review supplied no data-loss or cleanup consequence. |
| Claude Code 5714260602.6 — Unix `redactCwd` test gap | BETTER | The finding is test breadth, not a production defect; existing path redaction is unchanged and the PR's Windows-specific regression is covered. Root owns any broader cross-platform fixture expansion. |
| Claude Code 5714260602.7 — missing-file case asymmetry in root OpenCode config detection | NOT APPLICABLE | A missing differently-cased file is not a config that can be excluded. Existing path resolution and realpath checks cover existing equivalent files; no caller supplies the latent spelling as a valid root config. |
| Claude Code 5714260602.8 — hook recovery restores tracked files aggressively | FIXED | Covered by the Qodo/Greptile recovery fix above; restore is now preceded by tracked/index/untracked divergence checks. |
| Claude Code 5714260602.9–10 — G04/G29 positive observations | CORRECT | Recorded as accepted/correct evidence; no action beyond the hardening above. |
| Muse pass 2 5714614437 — leading-slash root config spelling | NOT APPLICABLE / FAIL CLOSED | Absolute `/opencode.json` is not a repository-relative path and is intentionally not treated as the root config. Git callers provide repository-relative paths. |
| Muse pass 2 5714614437 — IPv6 zone-id origin | NOT APPLICABLE TO THE CURRENT URL CONTRACT | Node's WHATWG URL parser rejects both raw and percent-escaped IPv6 zone identifiers with `ERR_INVALID_URL`. Merely escaping `%` does not add working health/browser URL support, so that proposed fix was removed. Ordinary IPv6 literals remain covered; scoped-address support would require an explicit transport-level design. |
| Muse pass 2 5714614437 — tokenless Git runner timeout residual | PENDING DEPENDENCY | The synchronous Git runner is owned by the PR164 filesystem/runner work and remains fail-closed under its existing contract. No unsafe new signal was added in PR166. |
| Muse pass 2 5714614437 — `closedByProject` lookup is only an info concern | FIXED | Normalized lookup is harmlessly defensive and preserves the fail-closed cleanup decision. |
| Muse pass 1 retractions — lookup bug, null-token safety, and G30.5 restart claim | CORRECT / SUPERSEDED | The lookup is now normalized anyway; tokenless numeric signaling remains prohibited; sidecar integrity is explicitly tested and malformed owned records stay pending. |
| OpenCode/DeepSeek 5714879050.1 — W-13 pending bead route | FIXED IN PR167 | Same checkpoint-ordering and pending-bead retry fix as Claude Opus 5714128308.6. It stays on the workflow PR. |
| Codex inline 4034640677 — edited tracked hook state can be overwritten | FIXED | Same preflight and exact-index evidence as Qodo inline 4034624868. |
| Codex inline 4034640688; Union follow-up 5719143791.1; Claude round 2 5719232398.1 — synchronous process-token/group work and incomplete timeout membership | FIXED / BOUNDED | `commandExecutor.ts` performs identity/group capture only for commands with a timeout, after handlers and the deadline are installed; the short-lived-launcher refresh window is bounded to five seconds. Untimed commands avoid the lookup, and descendants created outside the verified window remain fail-closed rather than guessed. |
| Muse 5719612558.2 — transient null identity probe skips escalation despite an owned direct child | FIXED / BOUNDED | `terminateProcessTreeWithEscalation` keeps numeric group ownership fail-closed but uses the retained `ChildProcess` handle when a live leader's identity probe is temporarily unavailable and no descendant provenance remains. The process-tree regression verifies direct SIGTERM without a numeric signal. |
| Gitar 5711267244 — eight Windows path/assertion failures | FIXED / PENDING DEPENDENCY | Hook path equivalence now preserves POSIX backslashes and applies case/slash equivalence only on Windows; trailing-space Git identity output is byte-preserving. Atomic I/O and final-test-runner failures belong to PR164 and are carried by historical baseline `aa3c4685`; root will rerun aggregate Windows checks. |
| CodeRabbit 5711202910; Sourcery 5232922697; Qodo/Greptile/Codex empty review records; Amazon Q 5232927969 | NOT ACTIONABLE | CodeRabbit skipped the non-default base, Sourcery exceeded its diff limit, and the empty/summary records supplied no additional source finding. Amazon Q's positive summary is covered by the concrete dispositions here. |
| Codacy 5711226004 — summary of eight critical alerts without rules/locations | NOT ACTIONABLE / PENDING EXTERNAL RECHECK | The intake supplied no rule IDs, paths, or reproducible diagnostics; Sonar's independent quality gate passed. Root will assess any actionable Codacy details if the analyzer reruns with rule output. |
| SonarQube 5711239793 — quality gate passed, no new issues/hotspots | CORRECT | No remediation required; the result is retained as a clean analyzer observation. |
| Windows install smoke check `105310638089`; Union follow-up 5719143791.4; DeepSeek 5719612558.2 — live daemon was reported unverifiable or abandoned when a start-token probe returned `null` | FIXED | `launchDaemon` passes its direct `ChildProcess` handle to `waitForReady` and `abandonFailedStart`; a matching live handle proves the child this invocation spawned, while dead/recycled handles and numeric/tokenless persisted records remain refused. Bounded direct-handle SIGTERM/SIGKILL cleanup clears only safe artifacts. `tests/startCommandAbandon.test.ts` covers both sides without a lifecycle smoke. |
| Union/Muse log-follow findings 5719612558.4; 5720189602.2 — `logs --follow` loses output after rename-and-create rotation or skips a larger replacement | FIXED | `server/cli/logsCommand.ts` watches the directory and checks file identity between drains. The tail reader supplies its opened file's identity; rotation during handoff or an active read resets the next drain, while duplicate events cannot reset an active stream. Copytruncate retains the size-shrink reset. Eight log tests cover these cases, larger replacements, absent watcher filenames, split UTF-8, and partial lines. |
| Codex 5720943681 — daemon health accepts an unrelated successful JSON response | FIXED | `probeRecordedDaemon` now requires an exact `instanceId` match before classifying the endpoint as the recorded daemon. A missing or mismatched identity is `different`, so credentials and control requests are never sent to an unrelated responder. `tests/stopCommand.test.ts` covers the missing-id response. |
| Round 3 — incomplete OpenCode shutdown and startup cleanup ownership | FIXED / BOUNDED | `OpenCodeSupervisor` retains a failed child handle; `startDaemon` persists shutdown-pending before runtime close, keeps a referenced heartbeat and authenticated listener when available, resets failed retry promises/guards, and leaves lock/state intact. CLI stop returns a retryable incomplete result without force-killing a pending generation; POSIX can trigger one identity-checked retry and the daemon keeps retrying with capped backoff after listener loss. Startup cleanup writes durable owned-child evidence and blocks successor starts; later cleanup requires token and detached-tree proof before clearing it. |
| Round 3 — structured hook recovery refusal | FIXED | Hook recovery returns a structured refusal with the exact retained marker path and manual remedy. Execution setup treats unresolved restoration as a hard boundary under both required and advisory hook policies; ordinary hook command failures retain their existing advisory behavior. |
| Round 3 — copytruncate follow handoff | FIXED | Root commit `fd2db949` adds a private owner-only pending/completed generation witness, bounded initial-tail retry, and captured-generation checks before chunk emission/offset advance. Completed copytruncate resets once even when the replacement has regrown; pending windows are skipped and interrupted read bytes are discarded. |

## Verification and limits

Fresh Windows CI exposed two platform-specific test assumptions rather than
production failures. The active-command close-resolution assertion is skipped
on Windows because an unverified taskkill tree intentionally keeps shutdown
retryable; the shutdown-pending force-escalation assertion accepts a terminated
Windows leader—or one that has not exited at the instant of observation—while
requiring the retained lock and state. The same tests remain strict on POSIX,
and the focused cross-platform suite passes locally.

The final second-review focused sweep passed eight suites: 149 tests passed
and one was skipped. This includes all cleanup, startup/stop, log-follow,
command, protected-hook, supervisor, and process-tree regressions. Touched-file
ESLint and application type-checking passed. The supervisor now retains verified
descendant provenance after leader exit, including a repeated stop, and process
group refresh discards newly scanned members if the leader changes mid-scan.

Focused checks run before handoff include:

- `npm exec vitest -- run server/opencode/__tests__/supervisor.test.ts
  server/lib/__tests__/processTree.test.ts server/lib/__tests__/commandExecutor.test.ts
  server/phases/executionSetup/__tests__/hookValidation.test.ts
  server/cli/__tests__/logsCommand.test.ts tests/startCommandAbandon.test.ts
  tests/stopCommand.test.ts` — 106 passed, 1 skipped; the matching ESLint
  invocation reported no issues.

The broader daemon, clean, sidecar, and command-focused suites also passed in
the preceding sweep. Root runs the combined repository checks; native
Windows/macOS execution remains with the CI runners.
E2E/full lifecycle tests and a final CI wait are explicitly excluded by the
owner. No disposition above claims those checks were run here.

Root's integration follow-up rejects final restore-marker symlinks even within
the app directory and reads exact Git-index bytes through the shared no-follow
opener. A snapshot copies and persists the same read, avoiding two independent
index reads. The hook/daemon regressions pass (42 tests), and the final hook
suite passes all 28 cases. The CI sidecar type error is fixed with an explicit
numeric PID guard; sidecar/start tests pass all 49 cases. Repeated readiness
fixtures are table-driven to address Sonar duplication without losing either
ownership scenario. The proposed IPv6-zone escaping change was removed because
it did not make Node's URL parser accept scoped addresses.

## Refreshed external check annotations

Codacy check `105302977341` on `14f64f17` completed with `ACTION_REQUIRED` and
nine annotations. All nine were retrieved through GitHub's check-run API:

- `server/cli/commands.ts:330,579`: the two URL warnings are not remote-input
  SSRF in this flow. The CLI contacts the owner's daemon using its owner-only
  local state, written from the bound server address. Someone able to replace
  that state already has access to its API token; the record is not an untrusted
  HTTP parameter. No general URL fetch endpoint or new URL allowlist was added.
- `server/lib/processTree.ts:67`: a process-start identity token's null check is
  not a secret comparison. Constant-time comparison does not apply.
- `server/phases/execution/opencodeStepsConfig.ts:104,105`: the path comparison
  rejects separators, requires ordinary non-symlink files, and compares real
  paths against the fixed root configuration. The two path-resolution warnings
  do not demonstrate a traversal past that boundary.
- `server/workflow/__tests__/executionPhase.test.ts:1521,1529,1532,1562`: these
  four path warnings concern test fixtures, not a production input boundary.

These are reasoned false-positive dispositions, not external dismissals. The
Codacy gate remains action-required until its provider accepts the dispositions
or a later run changes the result. Kilo check `105302681716` was still queued;
its detail link requires sign-in, and it supplied no finding to classify.
