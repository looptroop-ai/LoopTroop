# Review of PRs 163–169

## Second review, 2026-09-18

All seven PRs' refreshed CI results, issue comments, reviews, inline comments,
and bot notices were collected and read before implementation. One GPT-5.6 Luna
max agent was assigned to each PR; the root agent correlated findings and
verified the combined result. The earlier review below is retained as history,
not presented as this pass's test results.

The second pass adds these corrections:

- PR163: Linux overflow ownership remains unverifiable even when the numeric
  overflow ID is also mapped. Installer probes fail closed on unexpected exits,
  Windows affected-file discovery fails closed, and published POSIX download
  recipes require HTTPS. Linux-only resolver fixtures are deterministic on macOS.
- PR164: ignored-file protection for Free Disk Space, target-generation checks
  after awaited Git removal, recovery-copy completion evidence, preservation of
  later appends and quarantine symlinks, detached Git shutdown, and native
  temporary-path fixtures for Windows.
- PR165: complete executable-bead validation, duplicate authoritative-ID checks,
  canonical server responses after saves, retained command metadata, and YAML
  repairs that preserve nested, standalone, and folded scalar text.
- PR166: ignored-file protection in CLI preview and final removal, failed Git
  enumeration handling, exact daemon health identity, direct-child readiness and
  cleanup, verified descendant retention, log rotation across active reads, and
  asynchronous protected-hook Git mutations.
- PR167: partial question-poll isolation, cancellation fences and bounded cleanup
  retries, cancellation-aware PROM4 restoration, replacement-session ownership,
  confirmed stop before Coding Retry, skip-all compare-and-set, initial coding
  checkpoint ordering, and setup-evidence refresh compare-and-set.
- PR168: runtime forwarding of the explicit public HTTPS origin, transport abort
  before releasing SSE admission, wildcard-origin rejection, and computed-literal
  coverage in the existing static security rules.
- PR169: retained create-to-edit drafts, dirty Cancel guards, stale restore-response
  protection, validated nested ticket patches, cursorless reconnect recovery,
  lazy history folding, corrected overlay order, and native prefix verification
  with bounded reads and fail-closed source checks. Follow-up checks also cover
  explicit prompt resets, canonical created-project folders, failed initial-load
  navigation, and stopping history drains when their panel unmounts.

The additional owner choice is implemented in both housekeeping paths:
ignored user files, including `.env`, dependencies, and build output, block
automatic removal. LoopTroop-owned runtime artifacts are exempt. Explicit
ticket and project deletion stays destructive. The four earlier owner choices
remain unchanged.

The initial refreshed CI included a PR164 Ubuntu installer child killed with
`SIGKILL` after 23 seconds (run `35255493436`). Its cause is not established;
the duration was below both relevant timeout limits. The complete local
installer fixture suite passed 92 tests with two platform skips. No timeout
increase or retry was added to conceal the failure. Upstream artifact-download
and Renovate validator deprecation warnings remain recorded, as do external
analyzer false positives and bot capacity failures. New pushes are not claimed
green, and there is no final CI wait.

A later status read still showed queued/running GitHub jobs. PR164's CodeQL
check `105506101343` repeats the integrity-hash and fixed-command-fixture
reports already assessed in its ledger. Sonar check `105506931825` repeats
the same five Git path/oracle reports and the JSON-encoded project diagnostic
(`AaCwTSgwT2w_qkSFC5HS`). Their annotations were re-read; no new source finding
was identified, and no analyzer report was dismissed or suppressed.

Codacy annotations were also fetched directly on the pushed heads. Check
`105494762069` (PR165) repeats ten style locations whose assertions, callback
bodies, and header guard are already corrected; its remaining HTML-to-`expect`
report is a test assertion, not an HTML execution sink. Check `105506184140`
(PR166) flags intentional CLI requests to the locally configured daemon,
public process-start identity comparisons rather than secrets, root-config
identity checks, and fixed-path test fixtures. Check `105506335092` (PR167)
flags a table-driven atomic-write test whose filenames are fixed literals.
These concrete annotations do not establish additional production defects.

The final native/server integration checkpoint is `e2581640` in the detached
combined worktree. Both server Vitest projects passed: 316 files, 5,032 tests
passed, and 13 platform/conditional skips. This includes the native prefix,
captured-boundary, and source-identity changes in `89e8c485`.

The final client integration checkpoint is `92fcd030`. Both client Vitest
projects passed: 127 files and 1,610 tests. There is no server, shared, root-test,
package, or Vitest configuration diff from the server checkpoint. Together,
the four projects pass 443 files and 6,642 tests, with 13 skips.

Full ESLint, application/test type checks, and the production client/server
build pass at the client checkpoint. Version validation checks 1,244 tracked
files; all 57 TypeScript scripts pass the native type-stripping check.
Installer synchronization and the no-native-addon gate pass. The latter
checks 18 installed top-level entries and finds no platform-gated production
packages in the lockfile. Workflow lint passed with the repository's configured
shellcheck warning level. No new dependency was needed.
The rebuilt npm package passes its 82-entry contents check, and third-party
notices match all 80 redistributed packages.

Implementation checkpoints are `51550a3b` (163), `f4b422aa` (164), `a7dacb3a`
(165), `9c7e5872` (166), `2b1591d1` (167), `74acb444` (168), and `85a6145e`
(169). All seven existing PR branches were pushed; this summary is the final
documentation-only follow-up on PR163. Existing helpers were reused and no
dependency or new recovery framework was added.

Website changes label unreleased behavior and retain the published CLI source
pin `f784f055b45854016c245a2d902d6799b7e8265c`. The first documentation update is
`67410a3` on website `main`, followed by the final behavior documentation in
`ea30c87`; 88 tests, build, site/reference verification, and third-party notices
passed. No E2E/full lifecycle tests or GitHub PR merges were performed.

## Earlier review, 2026-09-17

Review date: 2026-09-17. Changes stay on the seven existing PR branches. No PR
was merged, and no E2E or full lifecycle test was run.

Each branch contains `.github/prNNN-review-dispositions.md`, with an outcome
for every captured issue comment, review body, inline comment, and bot notice.
The initial CI and review snapshots were read before implementation; a second
paginated refresh included edited comments as well as new ones. Accepted owner
decisions take precedence over suggestions based on an older roadmap.

## Changes by PR

| PR | Main corrections | Owner policy |
| --- | --- | --- |
| [163](https://github.com/looptroop-ai/LoopTroop/pull/163) | Fail-closed damaged-install recovery and executable ownership, explicit Windows executable paths, installer locking, container repair, stable structured doctor facts, workflow fixtures | Require an explicit trusted directory for unverifiable ownership |
| [164](https://github.com/looptroop-ai/LoopTroop/pull/164) | Bounded Git operations and quarantine comparisons, safe path handling, atomic recovery proofs, final-symlink rejection, descriptor identity checks, escaped path diagnostics | Keep and document trusted repository-local SSH wrappers |
| [165](https://github.com/looptroop-ai/LoopTroop/pull/165) | Lossless parser repairs, unknown-status preservation and rejection, isolated read errors, baseline hashes, usable argument editors, accessible names, all 11 current Codacy style findings | None |
| [166](https://github.com/looptroop-ai/LoopTroop/pull/166) | External hook-recovery marker and exact index snapshot, ambiguity checks before restore, process identity checks, live direct-child readiness after a Windows token-probe miss, cleanup locking, malformed sidecar protection | None |
| [167](https://github.com/looptroop-ai/LoopTroop/pull/167) | Confirmed and bounded session cancellation, durable cancellation guards, atomic recovery of pending markers, planning-save rechecks, setup draft hashes, interview ownership and batch recovery, retry actions | None |
| [168](https://github.com/looptroop-ai/LoopTroop/pull/168) | Public HTTPS origin and proxy sign-in links, Secure cookies, filesystem-lint bypass coverage, child credential filtering, SSE admission cleanup, port validation | One explicit public HTTPS origin; remote plain HTTP remains token-only |
| [169](https://github.com/looptroop-ai/LoopTroop/pull/169) | Create-to-edit transitions, history scope/cancellation races, native rewrite detection, question snapshot ordering, coded discovery retries, dirty-form protection, folder retry and modal focus | Keep later edits and switch to editing the newly created item |

The review preserves intentional unlimited continuation settings, positional
matching of equal-length expansion arrays, click-time Manual QA snapshots,
and recovery rules that retain work when ownership cannot be proven.

The final implementation checkpoints are `c85d70d9` (163), `f18297ff` (164),
`bca91e58` (165), `f68f63ae` (166), `b5f3b475` (167), `11149be8` (168), and
`b17ae32d` (169). Website documentation is on `main` at `775260a`. The detached
combined verification tree is `7a14cf86`. Existing helpers and mutation paths
were reused; these follow-up fixes add no dependency or new recovery framework.

## Verification

The combination was built in a detached scratch worktree, not pushed or used
to merge the PRs. Each source branch also has focused regression results in
its own ledger. Final checks passed on 2026-09-17:

- All four Vitest projects: 443 files passed; 6,567 tests passed, 13 skipped.
  Server projects contributed 316 files and 4,976 passing tests; client
  projects contributed 127 files and 1,591 passing tests. Server checks began
  at `d29c8d94`; the final client merge changed no server, shared, root-test,
  package, or Vitest configuration files. Client and other full checks used
  the combined `7a14cf86` tree.
- Full lint, application/test type-checking, and production build.
- Version consistency across 1,243 tracked files; generated-installer
  consistency; all 82 packed package entries; no production native addons.
- PR 163 also passed script type-stripping, third-party notices, and pinned
  Actionlint/ShellCheck. No install lifecycle or E2E smoke was run locally.
- Website: 87 tests, production build, and site/published-reference checks.
  Published notes identify unreleased behavior; the released CLI source pin
  was not advanced.

The earlier combined baseline also passed 442 files and 6,539 tests before
the final owner-approved changes. The final run above includes those changes
and the Windows CI follow-ups.

## CI findings that are not claimed green

- PR 164 retains CodeQL, Sonar, and Codacy annotations assessed as false
  positives, including integrity hashes mistaken for password hashes,
  guarded filesystem paths, test fixtures, and an already JSON-encoded log
  message. Its ledger records every current annotation and the evidence.
- PR 166's nine Codacy annotations concern owner-local daemon URLs,
  non-secret process identity checks, guarded configuration paths, and tests.
  They are classified individually; no external dismissal was performed.
- PR 167's packaging jobs failed on the same nullable HTTP-status helper
  type error found locally. The fix is included. Its last inspected Sonar
  result had zero open issues and 3.5% duplication; further fixture reuse
  removes the remaining reported repeated setup without exclusions.
- PR 167's later Codacy annotation flags a path joined from three literal
  test-table filenames. Its ledger records the fixture evidence; no external
  dismissal was performed.
- Kilo cancelled an older PR 165 review after a newer push. Its authenticated
  detail pages were unavailable; a cancelled or queued review is not a source
  finding or a pass.
- PR 163's Kilo check `105297450923` failed because the review model reached
  its output limit; it attached no annotations. The inspected platform test
  and install jobs passed, but this review-tool failure is not called green.
- PR 169's Kilo check `105309124366` failed because its assistant request was
  rate limited, with no annotations attached.
- Windows test job `105308919869` failed because a recovery assertion compared
  an 8.3 temporary-path alias with the canonical path. PR 164 now compares the
  exact canonical path; the fix is propagated to all dependent branches.
- Windows install job `105310638089` found a healthy daemon incorrectly
  reported as a failed start when the parent start-token lookup returned null.
  PR 166 now recognizes only its own still-live child handle in that case.
  Persisted tokenless records and exited handles remain refused. The fix and
  regressions are also in PR 168; no local lifecycle smoke was run.
- Upstream artifact-download `DEP0005` warnings and Renovate validator
  transitive deprecations/optional RE2 fallback remain. They were investigated
  and recorded in PR 163, not hidden or described as fixed.

Final pushes trigger new CI runs. There is deliberately no final CI wait.

## Confirmed owner choices

1. Configure one public HTTPS origin. Do not infer it from forwarded headers;
   remote plain HTTP remains token-only.
2. Keep edits made during creation and transition the form to editing the
   created entity.
3. Require an explicit trusted directory for unverifiable Linux ownership,
   rather than automatically accepting the overflow UID.
4. Keep repository-local `core.sshCommand` under the existing trusted-project
   model and explicitly document its execution permissions.

All four choices were explicitly confirmed on 2026-09-17, implemented, tested
with focused regressions, documented, and pushed. Public-origin configuration
uses `LOOPTROOP_PUBLIC_ORIGIN` or `config.json` `publicOrigin`, with no new CLI
flag. Remote browser deployments still require `LOOPTROOP_ALLOW_REMOTE_API=1`,
including a loopback-bound backend behind a proxy. No-Origin cookie requests
need same-origin fetch metadata and a preserved public Host.
