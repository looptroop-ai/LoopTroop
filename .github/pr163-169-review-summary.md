# Review of PRs 163–169

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
