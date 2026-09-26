# Reviewed code-scanning dispositions

## September 26 security and quality review

The review started with 24 open GitHub code-scanning findings at
`88a38cb1a60c9b811b912ac08ea602a550de218c`. The owner requested one new branch,
a pull request only after implementation and local verification, no merge, and
no wait for CI. Documentation describes the implemented behavior immediately.
No backward-compatibility work or end-to-end/lifecycle tests are required.

The owner authorized dismissal of proven false positives with evidence and
accepted the existing merge policy and absence of an OpenSSF Best Practices
badge. Required CI and pull requests remain enforced; independent human
approvals and code-owner reviews are not added. No badge enrollment or
maintainer attestation is claimed. The owner explicitly chose to keep policy
alerts #192, #200 and #201 open rather than dismiss them as accepted risk.
The container uses npm bundled in its digest-pinned Node image, as requested;
the separate npm download is removed.

### Source findings

| GitHub alert | Resolution and evidence |
| --- | --- |
| #174 | The process-tree test passes its marker path and child source through argv. Both programs use fixed source; no path is interpolated into JavaScript. |
| #163 | False positive. `writeDaemonRecord` writes the API token to owner-only `daemon.json`. Atomic recovery proofs apply only to YAML/JSONL, so this token does not reach the hash. SHA-256 verifies whole-file crash completeness, not a password. A regression inspects the temporary file before rename and asserts no proof exists. |
| #187 | False positive. The SHA-256 digest identifies exact wire credentials in an in-memory protocol cache. It is not persisted or used as a password verifier. The cache already holds the Basic authorization header required by the connection. Existing tests verify credential changes produce distinct cache entries. |
| #184 | False positive. The trusted resolver supplies the executable; `spawn` receives a separate argument array. Windows command scripts go through the shared launcher, which escapes arguments and rejects unsafe expansion. A POSIX real-process regression preserves shell metacharacters in an absolute path argument; separate shared-launcher tests cover Windows quoting and unsafe expansion. |
| #176 | False positive. The authenticated folder picker intentionally lists owner-selected absolute local directories before attachment. There is no single workspace boundary for this operation. |
| #177 | False positive. Project discovery checks existence of normalized owner-selected local paths. The check is behind Host/Origin and authentication middleware. |
| #178 | False positive. Timeout diagnosis reads only the selected repository's fixed `.git` metadata file to locate its Git directory. Linked-worktree metadata can legitimately reside outside the worktree. File contents are not returned through the API. |
| #179 | False positive. The selected project path is the subprocess working directory, not its executable or shell source. `gitWorkingDirectory` rejects empty, relative and NUL-containing paths; the program comes from the trusted resolver. |
| #180 | False positive. Git timeout diagnosis checks the fixed `.git` entry's type. It does not read arbitrary file content. |
| #181 | False positive. After a spawn ENOENT/ENOTDIR error, the runner checks the selected working directory to distinguish a missing directory from a missing executable. This is a local-owner diagnostic. |
| #182 | False positive. Timeout diagnosis checks only the fixed `index.lock` path below the repository's Git metadata. It neither returns file contents nor removes the lock. |
| #183 | False positive. Both diagnostic paths already use `JSON.stringify`, which escapes CR/LF and ASCII control bytes instead of creating extra log records. |

The project-discovery integration regression proves existing and missing paths
both return the same unauthorized response without a token, and a valid owner
token can select folders outside the daemon root. Ticket-artifact containment
remains separate from the owner's filesystem browsing and command permissions.
No status, prompt, parser, payload key or ticket lifecycle behavior changes.

### CI tooling and generated inputs

- #190 and #191: OpenCode tooling installs use committed npm integrity locks and
  disable third-party lifecycle scripts. The setup helper copies the selected
  optional native binary into the package's declared executable path after npm
  creates its shims. OpenCode keeps the real npm-generated Windows command shim; Bun exposes its native Windows executable directory. Native binaries must pass a version probe before entering PATH.
- #193: the container uses the npm already included in its digest-pinned Node
  image. Production installation retains the release lockfile and disabled
  lifecycle scripts. It no longer downloads a separate npm package merely to
  match the development toolchain.
- #194 through #197: Bun, pnpm, Yarn and both OpenCode tooling versions have
  isolated lockfiles under `scripts/ci-tools`. This avoids executable-name
  collisions and installing unrelated tools. Upstream optional dependencies can still include multiple native variants for the selected platform. Renovate maintains these
  manifests; Yarn remains Classic and each OpenCode lane stays within its major.
  Bun setup no longer races its postinstall against npm's Windows cleanup.
- #198: fast-check generates network-trust inputs in the ordinary Vitest suite.
  Eight thousand generated cases check normalized IPv4 and IPv6 forms, the IPv4 loopback range and mapped IPv6 forms, invalid ports,
  and hostile hostname suffixes; fixed cases check Host/Origin port parity and rejected URL syntax. The pinned Scorecard v5.5.0 recognizes this
  integration. It adds only development dependencies and no runtime fuzzer.

Published-feed checks still install LoopTroop from the live feed. Their driver
comes from the release being tested; their tooling manifests and helper come
from the workflow's exact source commit, so a weekly check can use maintained
tooling while testing the current published release. The job summary records the release version, exact tooling commit and installed tool versions. Tools resolve through normal PATH without setting a trusted-directory override.
No user runtime trust policy is widened.

### SAST coverage (#199)

The [Scorecard run](https://github.com/looptroop-ai/LoopTroop/actions/runs/36231324008)
reported 21 of 30 recent changes scanned. Its GitHub GraphQL lookup missed the
check cache and used a REST fallback that reads only the default first page of
30 check runs. The
[pinned implementation](https://github.com/ossf/scorecard/blob/c395761df6afe1a69e476bc60a013a94bcbc153f/clients/githubrepo/checkruns.go)
does not paginate that fallback. These PRs have more than 30 check runs.

Replaying that first page reproduces 21/30 exactly. Reading the full check lists
finds successful recognized SAST results for eight additional PRs: #193, #192,
#184, #178, #172, #168, #167 and #166. All 30 changes were scanned; 29 have a
successful recognized result. [PR #164's CodeQL result](https://github.com/looptroop-ai/LoopTroop/runs/105648887452)
failed because it reported two findings, not because scanning was absent. That
historical failure remains a failure. The current default CodeQL setup remains
configured for the application and Actions, including weekly scans. No duplicate
scanner or workflow is added. The missing-scanning claim is a false positive;
this disposition does not claim every historical security check passed.

### Repository policy

- #192 (branch protection) and #200 (human review): accepted limitations at the
  owner's request. Existing required checks, PR requirement, deletion protection
  and force-push protection remain in place. AI reviews do not satisfy
  Scorecard's independent-human-review criterion.
- #201 (OpenSSF badge): accepted limitation at the owner's request. Earning a
  badge requires external registration and truthful maintainer attestations;
  adding a badge image to the repository would not satisfy that requirement.

### Dashboard state and verification

Twelve false positives (#163, #176–#184, #187 and #199) were dismissed with the
owner's authorization, and their GitHub states were read back. Nine findings
(#174, #190, #191 and #193–#198) have code or test changes and remain open until
GitHub scans the merged default branch. The three accepted policy findings
(#192, #200 and #201) deliberately remain open. No analyzer exclusions or
blanket suppressions were added. This records GitHub decisions, not separate
SonarCloud source-dashboard resolutions.

The website operations guide was updated and pushed directly to its main
branch in [80e7568](https://github.com/looptroop-ai/LoopTroop-Website/commit/80e7568).
Existing ignore rules cover all nested tool installations and test/build output.

Final local verification passed: 458 test files, 7,027 tests and 13 existing skips;
full lint, both typecheck projects, production build, package contents,
production native-addon scan, version consistency, script type stripping,
installer synchronization and license notices. Actionlint with ShellCheck and
strict Renovate validation passed. All five tools reported their actual versions
through the existing trusted launcher on Linux; Windows command-shim generation
was inspected separately. The website passed 97 tests, its build and site/CLI
verification. No end-to-end or lifecycle smoke was run; cross-platform runtime
verification remains with CI, whose completion is not awaited.

### PR #194 review follow-up

Read the complete PR conversation, submitted reviews, inline comments, bot
reports and the linked local 20-point review together with CI before editing.
Both [push CI](https://github.com/looptroop-ai/LoopTroop/actions/runs/36243457413)
and [PR CI](https://github.com/looptroop-ai/LoopTroop/actions/runs/36243464149)
passed at `6043e07a`, including Windows and macOS tool smokes. SonarCloud and
DeepSource reported the separate analysis findings below.

| Review finding | Resolution |
| --- | --- |
| Job-wide executable trust override masks normal discovery | Removed the override. All five installed tools resolve through the existing trusted launcher on Linux with ordinary PATH. Windows Bun exposes its native bin directory; OpenCode retains its command shim. |
| Native setup aliases, missing binaries and incompatible executables | Deduplicate declared targets and run a bounded version probe before adding PATH. Tests cover missing and invalid binaries, both OpenCode lanes and Bun, using independent platform metadata from committed locks. No speculative musl runner or package-layout fallback is added. |
| CI tools grouped with runtime updates; majors lose labels; lock refresh splits | Restrict runtime rules to the root manifest. Apply CI metadata separately from the patch/minor group. Major updates keep their major label and separate PRs; the weekly lock refresh covers root and nested locks together. Yarn Classic and both OpenCode major lanes remain explicit; Bun and pnpm majors remain reviewable. |
| Weak install-policy assertions | Compare the exact installation commands in each setup step, verify every tooling lock and integrity field, reject local links, and assert the helper cannot write a trust override. Use real interpolation with a computed GitHub-expression prefix in test data so static analysis does not mistake it for JavaScript interpolation. |
| Broader network and authentication coverage | Add normalized IPv4/IPv6, bracketed dotted mapped IPv6, hostile syntax and Host/Origin port parity. Every private API route in the contract inventory must reject an unauthenticated request before its handler. Fast-check reports the seed and shrink path on failure; a fixed seed would unnecessarily reduce exploration. |
| JSON proof test and leftover sidecars | Name the JSON check precisely, assert its final directory contents, and verify successful YAML/JSONL writes clean temporary sidecars. Credential hashing behavior is unchanged. |
| Process quoting coverage overstated | Distinguish POSIX real-process coverage from shared Windows launcher tests; add command substitution and a trailing-backslash path to the latter. |
| Workflow tooling differs from the release tested | Preserve that intentional separation and record the release version, exact tooling commit and installed tool versions in the job summary. |
| Restore a separate npm download or enforce npm 12 in the container | Rejected per the owner's explicit choice. Production installation disables all scripts and uses the release lock; the development npm lifecycle allowlist is a separate policy. |
| SonarCloud S8689 / GitHub #202 | Proven false positive: the log contains the public npm package name, package.json version checked against its committed pin, and CI installation path. No credential reaches it. Dismissed the GitHub import under the owner's authorization. The refreshed SonarCloud bot comment and both Sonar checks now report success with zero new issues. |
| DeepSource parser and test findings | The standalone CI helper now uses `.cjs`, `require` and `__dirname`, matching the analyzer's script parser without analyzer configuration changes or exclusions. A small metadata predicate keeps the native-fixture test's complexity down; workflow marker assertions use real interpolation with a separately constructed prefix. Non-null assertions and an empty callback were removed earlier. |
| Unrelated artifacts, hardlinks, extra config guards, exact fixture listing and separate disposition PR | No demonstrated defect warrants changes. Existing cleanup and fixture assertions are intentional; the owner requested one branch and PR. Security notes clarify existing authenticated-owner behavior rather than relaxing runtime controls. |

Codex, Amazon Q, Greptile, Kilo and CodeRabbit supplied no additional actionable
code findings. Sourcery requested human review, Socket supplied package scores,
and Gitar did not run a review on its free plan. None changes the owner's
accepted human-review and badge limitations.

The successful CI logs retain upstream download-artifact Buffer deprecations,
Renovate transitive-package deprecations and its optional RE2 fallback. The
bundled npm-to-approved-development-npm notice is expected. Runner/cache service
diagnostics are external to these changes. No action retirement warning or new
application warning was found; these are recorded rather than hidden.
The refreshed review at `ab2f33d` contained 14 conversation comments, eight
submitted reviews and 17 inline comments. On `78fb340`, the latest refresh had
14 conversation comments, ten submitted reviews and 23 inline comments.
Greptile reviewed that head and found no actionable issue; Kilo reports no
issues, Codacy reports zero new issues, and SonarCloud's gate passes with zero
new or accepted issues and zero hotspots. CodeRabbit and the latest Copilot note
again recommend restoring or checking the Docker npm pin. That conflicts
with the owner's explicit choice to use the npm bundled in the digest-pinned
image; the script-free production install remains locked by the release
lockfile. DeepSource's JavaScript check failed at `78fb340` on three newly
reported findings: the local identifier `name`, a browser-only console rule on
the Node-only setup helper, and a module-scope function declaration in a Vitest
test. The identifier is now `packageName`, redundant console output is removed
while tool versions remain in the GitHub step summary, and the test predicate
uses an arrow expression. The next DeepSource scan will verify those changes;
its Docker, Shell and Secrets checks pass.
Greptile's incremental review then found that renaming the setup helper's
package binding had left the native probe error message using the old identifier.
That error path now reports the package name, and the regression asserts the
exact package-specific diagnostic so a ReferenceError stack frame cannot satisfy
the test accidentally.

The next CI run at `44da9d61` failed in both macOS test lanes because the native
fixture searched every lock entry and selected the OpenCode wrapper package,
whose `os`/`cpu` metadata also matches macOS ARM, instead of selecting from the
wrapper's native optional dependencies. The fixture now filters only the root
package's optional dependencies and then checks their locked platform metadata.
The same run's sole Codacy critical flagged a fixed `it.each` filename as
possible user input to `path.join`; the test now uses static filenames directly.
Using ordinary quoted strings for literal GitHub expressions caused three new
DeepSource `Unexpected template string expression` reports at `ab2f33d`. The
literal-concatenation workaround then caused three minor reports at `b079ade`.
The regression data now uses real interpolation with a separately constructed
GitHub-expression prefix, preserving the asserted workflow text without either
scanner pattern. The `b079ade` analysis also retained the `.mjs` parser report
and medium-risk complexity report; the standalone helper now uses CommonJS and
the native metadata predicate is separated from the test callback. No analyzer
settings, exclusions or suppressions were added.
The corrected fixture passes all 82 focused atomic-write and install-policy
tests locally, test TypeScript checking, and ESLint. A platform-metadata check
also selected the correct locked native package for Bun and both OpenCode lanes
on macOS ARM64, Linux x64 and Windows x64. The full local suite passed before
this test-only correction. At the `ab2f33d` CI snapshot, macOS install smoke
and binary jobs passed while test jobs were still running. The install-policy
suite now passes all 17 tests, test TypeScript and ESLint pass, and Actionlint
with ShellCheck passes after updating both workflow paths. The latest
DeepSource result at `b079ade` remained failed on the findings described above;
the current analyzer run will assess these final test-only and helper changes.

Follow-up verification: 458 test files passed, with 7,071 tests passed and 13
existing skips. Full lint, both typecheck projects, build, package contents,
production native-addon scan, version consistency, script stripping, installer
synchronization, license checks, Actionlint/ShellCheck and strict Renovate
validation passed. Website verification passed 97 tests, build, site/CLI checks
and license checks. No end-to-end or lifecycle smoke was run.

## PR18 identifier and test fixes

Rechecked on 2026-09-12 against `fe3d7d4c`: this stage started with 11 open alerts.
The installer shell-command alert from the original plan was already fixed by PR15.
The closed PR #129 was reviewed as a reference and reimplemented, not replayed; its process-launch changes are superseded
by the trusted resolver now on `main`.

- S2245 alerts #35 and #36: toast IDs use a provider-local ref so their lifetime matches retained
  state during Fast Refresh; progress-ring gradient IDs use React's `useId` and remain stable
  when progress changes. The unused explicit gradient-ID prop was removed after checking callers.
- S2245 alerts #12 and #37: ticket UI and Manual QA actions share a cryptographic ID generator.
  Native UUIDs remain preferred. HTTP LAN origins use 16 random bytes encoded as hex, since
  [Web Crypto](https://w3c.github.io/webcrypto/#Crypto-interface) exposes `getRandomValues`
  outside secure contexts but restricts `randomUUID`. These IDs reach server deduplication
  and evidence persistence, so a counter that resets on reload would be insufficient.
  Both formats are opaque IDs accepted by the existing server validators. Missing Web Crypto
  now gives an explicit error; it never falls back to weak randomness.
- S2245 alert #38: the diagnostic disk probe uses Node's UUID generator for its temporary filename.
- CodeQL alert #1: the daemon-lock race harness writes fixed source and passes its paths,
  contender index and contender count through argv. It keeps the start barrier, wait for every
  loser, bounded lock hold and overlapping-holder assertions. The old patch's hardcoded
  contender count was not carried forward. The neighboring claim-takeover test now passes
  its paths through argv too, using the same fixed-source approach.
- CodeQL alert #9: the prompt-template test reads the file directly before appending its user
  comment; the identity replacement served no purpose.

These changes affect internal identifiers, test setup and local-address recognition. Ticket revision ordering, action
prefixes, status descriptions, API keys and diagnostic output fields retain their contracts.
The website checkout was checked separately, including its operations and diagnostics pages;
its loopback-only guidance remains accurate and its released source reference is unchanged.
Existing ignore rules cover the build, test and temporary outputs.

The four S1313 findings (#94, #95, #118 and #119) compare hosts against the dotted
and hexadecimal IPv4-mapped forms of loopback. These are protocol addresses, not deployment
endpoints; see [RFC 4291, section 2.5.5.2](https://www.rfc-editor.org/rfc/rfc4291#section-2.5.5.2).
Regression cases cover both spellings, bracketed uppercase input, rejection of mapped
non-loopback addresses by the backend, and omission of mapped loopback hosts from LAN URLs.
With the owner's approval, all four were dismissed as `false positive` on GitHub on
2026-09-12. Their dismissed states were read back from the API. The owner subsequently approved
broader mapped-loopback support and one shared predicate during PR review. That functional
change supersedes the exact-literal comparisons; it does not invalidate the original false-positive
rationale. This records GitHub dispositions; it does not claim a separate SonarCloud dashboard
resolution. The seven code fixes await merge and a scan of `main` before their alerts can close.

Initial local verification for the implementation in `a330a1a2` passed: the full suite (408 files, 5,543 tests passed, 10 skipped),
focused identifier and lock-race tests, lint, typechecks, production build, package contents,
production native-addon scan, version consistency, script type stripping and license notices.
The diagnostic help entry point also ran successfully. No end-to-end or lifecycle smoke was run.

### Review follow-up

The shared predicate uses the platform URL parser to normalize valid IPv6 literals before
checking IPv6 loopback and the IPv4-mapped 127/8 range. Its input check rejects URL syntax,
partial brackets and zone IDs rather than allowing the URL parser to repair them.
The dev URL printer reuses that predicate, so hostnames that merely start with `127.` are
advertised normally. The backend's remote opt-in and token requirements are unchanged.
Bracketed IPv6 request authorities are canonicalized before Origin comparison; ports and
different addresses still distinguish origins. Bare IPv6 addresses now use the same canonical
spelling as bracketed addresses, although browser Host headers use brackets.

All eight local reports and all PR conversation, review and inline comments at `71d94d2c`
were read together before changes. Findings shared by several reviewers are grouped below.

| Finding | Disposition |
| --- | --- |
| Toast IDs reset during Fast Refresh (Qodo, Greptile, GPT-5.4, DeepSeek) | Fixed with a provider-local ref. Added rerender coverage; this is not a simulation of the Vite Fast Refresh runtime. |
| Codacy non-null assertions and floating promise in the toast test | Fixed by querying accessible dismiss buttons and awaiting the React update. Dismiss buttons now have labels. |
| Missing Web Crypto guard (Gitar and several reports) | Added explicit failure and tests for missing/incomplete crypto. The reported HTTP-LAN failure was overstated: supported browsers expose `getRandomValues` on HTTP. |
| Hex IDs should become UUIDs | No format change. Server consumers accept opaque strings; a hypothetical future UUID-only validator is not a current requirement. The helper documents both formats. |
| Divergent dev predicate and incomplete mapped-loopback recognition | Included with explicit owner approval. Both consumers share strict address recognition; equivalent IPv6 Host/Origin spellings also need canonical comparison. This expands accepted local addresses without admitting mapped remote addresses. |
| Replace literals with generated or named constants | Superseded by the approved shared predicate. The original dismissal was valid; rejecting some other loopback addresses did not make these literal comparisons unsafe. |
| Claim-takeover test still builds source from values | Converted to fixed source plus argv. This removes the neighboring pattern without claiming the old fixture was exploitable or predicting where CodeQL will report next. |
| Unused gradient-ID prop and misplaced tests | Removed the unused prop; ring tests now belong to the ring. Pure action-ID tests run in the client-node project and still exercise both public consumers. |
| Remove toast clock/random mocks | Rejected: fixing both inputs forces collisions if the old implementation returns. Kept them and explained the regression guard. No test-reset export or counter factory is needed. |
| SVG selector, older React ID spelling, dynamic imports and temporary-script cleanup | No defect found. Gradient tests assert two IDs and their references; the child uses an absolute file URL with tsx, and suite cleanup removes its directory. No compatibility work for older React is needed. |
| Additional IPv6 spellings and zone IDs | Covered by the shared recognition tests. IPv4-translated/SIIT addresses are distinct from IPv4-mapped addresses and must not inherit loopback trust. |
| PR17 reference, absent constants and verification record | Separated the PR17 heading and clarified the record. PR154 already exists; the generated constants claimed by one report existed only in the old unmerged patch. |
| Diagnostic UUID justification, remaining random test port, generic docstring quota | The UUID avoids incidental temporary-name collisions. The unrelated supervisor port fixture is outside this change. Added the useful action-ID contract comment; no boilerplate docstrings or speculative port allocator. |

At `71d94d2c`, both full CI runs passed, including the Windows and macOS race tests:
[push](https://github.com/looptroop-ai/LoopTroop/actions/runs/34673381565) and
[pull request](https://github.com/looptroop-ai/LoopTroop/actions/runs/34673390878).
CodeQL and Sonar passed. Codacy's two test findings are addressed above.
Kilo failed because its model output limit was reached and produced no code findings.
Sourcery exhausted its review budget. Neither failure establishes a code defect.
Amazon Q's claim of 50 concurrent scenarios is inaccurate: 50 was the combined prompt-store
and daemon-lock test count, not the count of contention scenarios.

Review-fix validation on 2026-09-12: 411 test files passed (5,574 tests passed, 10 skipped),
plus 66 focused network tests and an independent 3,072-case mapped-address boundary sweep.
Full lint, both typecheck projects, the production build, script type stripping, version checks
and license checks passed, as did package contents and production native-addon checks.
The first build process was killed while heavy checks ran together;
the sequential rerun passed. A new Vite native-config warning was fixed by adding the explicit
extension to the dev-host module's shared import. New CI results are left for the owner to review.

### Refreshed review at `d3ca1356`

Read all five refreshed local reports, including the completed Opus report, alongside all PR
comments and CI results before finishing these follow-ups.

| Finding | Disposition |
| --- | --- |
| IPv6 OpenCode URLs classified as remote; diagnostics miss the listener | Fixed both consumers through shared loopback/wildcard recognition. Socket probes and both OpenCode launch paths use bare IPv6; HTTP probes retain brackets. Diagnostic output fields and port-zero behavior stay unchanged. |
| Expanded IPv6 wildcard binds print unusable LAN URLs and disable WSL guidance | Canonicalize IPv6 through the shared platform helper and recognize `::`. IPv4-mapped zero is a distinct address, not IPv6 unspecified; it retains explicit-host behavior rather than assuming identical bind semantics across platforms. |
| Duplicated IPv6 parsing, empty ports, inconsistent port bounds and bare IPv6 spelling | Shared canonical IPv6 helper and one authority parser. Empty ports use the default, as specified by [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-4.2.1); invalid authorities cannot produce a canonical comparison key. Different addresses and ports remain different origins. |
| Toast rerender test does not simulate Fast Refresh | Renamed the test to state what it proves and documented the ref lifetime next to the counter. No artificial HMR harness. |
| WSL numeric-address prefix filter | Already gated by dotted numeric address validation; it does not misclassify hostnames or define backend trust. No change needed. |
| Duplicate dismiss labels, React variable names, mock style and UUID formatting | No current defect. Tests deliberately use distinct messages; IDs remain opaque and accessibility labels remain meaningful. |

Both full CI runs at `d3ca1356` passed:
[push](https://github.com/looptroop-ai/LoopTroop/actions/runs/34675113565) and
[pull request](https://github.com/looptroop-ai/LoopTroop/actions/runs/34675115114).
CodeQL, Sonar and Semgrep passed. Codacy's
[issue API](https://app.codacy.com/api/v3/analysis/organizations/gh/looptroop-ai/repositories/LoopTroop/pull-requests/155/issues)
still attributes both toast findings to `71d94d2c`, quoting the removed non-null assertion and
unawaited React update. Its current-head dashboard metadata does not mean those issue details
were refreshed. Kilo again exhausted its model output limit. Full CI logs contained only the
previously reviewed warning families documented below; no additional warning suppression was added.

The website checkout was checked separately again. Its generic loopback, startup and diagnostic
guidance remains accurate; no unreleased documentation was published. No new ignore rule is needed.

Current follow-up validation: all 411 test files passed (5,642 tests passed, 10 skipped),
including 165 focused network, startup and toast checks. Full lint, both typecheck projects,
production build, package contents, production native-addon scan, script type stripping,
version consistency and license checks passed. Diagnostic help ran successfully.
No end-to-end or lifecycle smoke was run; the owner will review CI for the pushed update.

### Final bot and CI review at `215aecb3`

Both [push CI](https://github.com/looptroop-ai/LoopTroop/actions/runs/34676906940) and
[PR CI](https://github.com/looptroop-ai/LoopTroop/actions/runs/34676908163) passed, including
platform and packaging jobs. Full logs contain only the reviewed upstream warning families.
Kilo again reached its model output limit. Gitar, Greptile and Qodo report no outstanding
findings; CodeRabbit adds the two probe findings considered below. Its generic docstring
quota does not justify boilerplate comments.

Codacy has now refreshed: its current findings are the toast test's shorthand void callback
and the provider probe's fetch, rather than the earlier stale assertions. The callback now
uses a block. The fetch finding names existing developer-tool behavior moved by the IPv6
fix: callers use operator configuration, and remote hosts return before this local probe.
It is not a new application route accepting an untrusted destination.

The redirect concern is relevant: a different listener could redirect a readiness probe and
be mistaken for OpenCode. Provider, daemon health and doctor probes reject redirects, with local HTTP
regression coverage. This follows the [Fetch redirect policy](https://fetch.spec.whatwg.org/#http-redirect-fetch)
without adding a custom redirect validator.

The request to omit authentication for all HTTP probes is rejected. The probe reaches local
loopback/wildcard destinations, and [OpenCode supports HTTP Basic authentication](https://opencode.ai/docs/server/#authentication)
on its local HTTP server. Removing the header breaks existing password-protected startup,
including the dev launcher's generated credentials. Loopback does not authenticate the
identity of a process occupying that port; TLS or authenticated IPC would address that broader
threat but would require a separate transport design. No claim is made that redirects are the
only possible local-process threat. The scanner finding may remain until its dashboard review.

The whole PR diff and sibling network callers were checked again. Identifier contracts,
daemon-lock contention coverage and remote-address rejection remain intact. The website's
released startup/authentication instructions remain accurate; no website edit is needed.

Follow-up validation passed: 411 test files, 5,645 tests passed and 10 skipped; full lint,
both typecheck projects, production build, package contents, version consistency and script
type stripping. The focused identifier/lock regressions and direct HTTP redirect/authentication
tests also passed. No end-to-end or lifecycle smoke was run. New CI is left for owner review.

## PR17 workflow, container and page hardening

Reviewed on 2026-09-11 for roadmap stage PR17, implemented in
[GitHub PR #154](https://github.com/looptroop-ai/LoopTroop/pull/154), based on `main` at `377628ec`.
Match future findings by rule and code location; alert numbers are references to this scan only.

## Install scripts

Repository installs retain the exact-version esbuild approvals in `package.json`.
Disabling all scripts here would skip esbuild's binary setup. The npm pin script asserts the
reviewed major as well as the declared version. The Node Current lane keeps bundled npm when
it is major 12. Otherwise it reports the mismatch and installs the declared npm with scripts
disabled before installing project dependencies. Node compatibility tests therefore still run
without trusting an unreviewed install-script policy. Policy tests exercise an approved and a denied
local registry package with exact name/version approvals, and check workflow
ordering and the lockfile's script-bearing dependencies. The optional fsevents install script
is explicitly denied, so npm no longer reports it as awaiting review. npm's own global bootstrap
also disables scripts. Windows installer smoke checks retain and verify the pinned npm even
after switching to an isolated global prefix.

This is a scoped acceptance of vetted install scripts, not a claim that scripts are harmless.
Only repository installs read the root allowlist: global installs and npx do not.
See [npm script approvals](https://docs.npmjs.com/cli/v12/commands/npm-approve-scripts/)
and [the policy resolver](https://github.com/npm/cli/blob/v12.0.2/lib/utils/resolve-allow-scripts.js).

Reasons used in the ledger:

- **Project policy:** npm 12 is checked before installation; the root allowlist approves only
  the two exact esbuild versions in the lockfile. All other dependency install scripts are blocked.
- **npx policy:** Renovate is exact-pinned; npm 12 blocks unapproved install scripts in its
  separate exec context. The root esbuild allowlist is not used here.
- **OpenCode tooling:** the global install and its script approval name the same exact OpenCode
  version. Its postinstall installs the platform binary. This is smoke tooling; the LoopTroop
  release under test still comes from the live channel.
  Global package-manager approvals likewise include the exact version. Their fixed matrix and
  the Renovate validator pin are checked by policy tests; OpenCode tooling updates remain manual.
- **Test fixture:** this helper only sets up temporary repositories under the developer/CI
  account using the test runner's Git. It does not handle application requests or ship in the
  daemon. Production tool launches use trusted executable resolution; importing that resolver
  into test setup would make fixtures depend on the behavior they test.
- **Runtime styles:** the script directive already permits only same-origin scripts. CodeMirror
  injects stylesheet text through style-mod, and Radix dialogs/menus inject scrollbar-dependent
  CSS through react-style-singleton. Removing the style allowance breaks those components.
  Static hashes cannot cover measured CSS; nonce support requires fresh per-response nonces
  in every HTML serving path plus wiring the style consumers. This is separate work, as the
  plan specifies. Vite's production shell itself has no inline script or stylesheet.
  See [CodeMirror nonce support](https://codemirror.net/docs/ref/#view.EditorView%5EcspNonce).

## PR17 dismissal ledger

All 27 rows below were dismissed as `won't fix` on GitHub on 2026-09-11, and their
dismissed state was read back from the API. Each is accepted only for the stated scope.

| Alert | Rule | Location at review | Reason | Date |
| --- | --- | --- | --- | --- |
| #13 | `githubactions:S6505` | `.github/workflows/release-pr.yml:88` | Project policy | 2026-09-11 |
| #14 | `githubactions:S6505` | `.github/workflows/release-pr.yml:134` | Project policy | 2026-09-11 |
| #15 | `githubactions:S6505` | `.github/workflows/renovate-notices.yml:86` | Project policy | 2026-09-11 |
| #17 | `githubactions:S6505` | `.github/workflows/published-smoke.yml:341` | OpenCode tooling | 2026-09-11 |
| #19 | `Web:S7039` | `index.html:9` | Runtime styles | 2026-09-11 |
| #22 | `githubactions:S6505` | `.github/workflows/ci.yml:88` | Project policy | 2026-09-11 |
| #23 | `githubactions:S6505` | `.github/workflows/ci.yml:127` | npx policy | 2026-09-11 |
| #24 | `githubactions:S6505` | `.github/workflows/ci.yml:207` | Project policy | 2026-09-11 |
| #25 | `githubactions:S6505` | `.github/workflows/ci.yml:238` | Project policy | 2026-09-11 |
| #26 | `githubactions:S6505` | `.github/workflows/ci.yml:283` | Project policy | 2026-09-11 |
| #27 | `githubactions:S6505` | `.github/workflows/ci.yml:368` | Project policy | 2026-09-11 |
| #28 | `githubactions:S6505` | `.github/workflows/ci.yml:432` | Project policy | 2026-09-11 |
| #29 | `githubactions:S6505` | `.github/workflows/ci.yml:504` | Project policy | 2026-09-11 |
| #30 | `githubactions:S6505` | `.github/workflows/ci.yml:759` | Project policy | 2026-09-11 |
| #31 | `githubactions:S6505` | `.github/workflows/ci.yml:904` | Project policy | 2026-09-11 |
| #32 | `githubactions:S6505` | `.github/workflows/ci.yml:939` | Project policy | 2026-09-11 |
| #40 | `typescript:S4036` | `server/test/fixtureRepo.ts:44` | Test fixture | 2026-09-11 |
| #41 | `typescript:S4036` | `server/test/fixtureRepo.ts:45` | Test fixture | 2026-09-11 |
| #42 | `typescript:S4036` | `server/test/fixtureRepo.ts:46` | Test fixture | 2026-09-11 |
| #43 | `typescript:S4036` | `server/test/fixtureRepo.ts:49` | Test fixture | 2026-09-11 |
| #44 | `typescript:S4036` | `server/test/fixtureRepo.ts:50` | Test fixture | 2026-09-11 |
| #45 | `typescript:S4036` | `server/test/fixtureRepo.ts:51` | Test fixture | 2026-09-11 |
| #46 | `typescript:S4036` | `server/test/fixtureRepo.ts:52` | Test fixture | 2026-09-11 |
| #47 | `typescript:S4036` | `server/test/fixtureRepo.ts:53` | Test fixture | 2026-09-11 |
| #48 | `typescript:S4036` | `server/test/tempDir.ts:92` | Test fixture | 2026-09-11 |
| #49 | `typescript:S4036` | `server/test/tempDir.ts:93` | Test fixture | 2026-09-11 |
| #158 | `githubactions:S6505` | `.github/workflows/published-smoke.yml:342` | OpenCode tooling (PR analysis repeat) | 2026-09-11 |

## Fixed instead of dismissed

- Docker's production install disables lifecycle scripts. Its Node base shipped npm 11, so the
  build stage now installs and verifies the npm version from the selected tarball. The production
  dependency tree has no install hooks; esbuild is a development dependency. The old blanket
  esbuild rationale did not apply to alert #33 (`docker:S6505`).
- HTTPS downloads for actionlint and the GitHub CLI signing key restrict both initial requests
  and redirects to HTTPS and require TLS 1.2 or later (#21 and #34).
- Installer metadata and archive requests validate every redirect before following it, retain
  their existing timeout and size limits, and remove authorization on cross-origin redirects.
  Only an explicitly configured HTTP loopback fixture may use HTTP, within its own origin;
  an HTTPS request can never downgrade to that fixture, and HTTP fixtures never receive an
  Authorization header, including inherited GitHub tokens. Published curl bootstrap and upgrade
  commands also restrict initial requests and redirects to HTTPS.
- PowerShell bootstrap and upgrade commands use curl's HTTPS restrictions too, capture the
  complete response, and refuse failed or empty downloads before creating a script block.
  This avoids PowerShell's older automatic-redirect behavior. The curl prerequisite is explicit;
  users without it can use the existing npm channel. POSIX protocol arguments are quoted so
  zsh does not interpret them as command-path expansion.
- The OpenCode tooling install is exact-pinned (#18). LoopTroop channel selection is unchanged.
- Workflow permission alerts #16 and #20 were already fixed before this stage.

Production pages now restrict connections to the same origin; the broad WebSocket scheme allowance
is retained only for development reloads, including remote development. The style exception and
script restrictions are unchanged. Package verification reads the emitted CSP meta tag and checks
its connection directive; matching text in comments, inactive noscript content or elsewhere in the page cannot satisfy it.
The Vite configuration test separately checks the build transform. No app route, status, parser, or payload key changes in this
stage; the existing upgrade-command value now includes HTTPS enforcement. Container build inputs
are limited to the selected tarball and Dockerfile; WinGet Git credentials move from process
arguments to fork-scoped process configuration without replacing inherited Git settings.
Installer locking protects live owners and serializes abandoned-lock recovery. PID checks
assume one host and PID namespace. A reused PID remains conservatively blocked and requires
manual cleanup after verifying no installer is running, just like an abandoned recovery claim.
Concurrent use with installers predating this claim protocol is outside the fresh-install scope.

## Published documentation

The website checkout was checked separately. Its installation page now includes conditional
recovery guidance for an installer that reports `.install.lock` or `.install.lock.claim`: wait and retry, and
remove only the named file after verifying no installer is running. Its released CLI source
reference and the installer updates already scheduled for release are unchanged. Its curl
bootstrap commands now enforce HTTPS, including redirects; those flags were checked against
the published wrapper with `--help` before documenting them.
The POSIX command was also checked in zsh. PowerShell command behavior was checked with harmless
multiline script fixtures, including failed and empty downloads and parameter forwarding.
The published PowerShell wrapper does not support a help switch: an attempted help-only check
instead performed a global npm installation. No daemon was started; subsequent checks used
fixtures. Do not use the live PowerShell wrapper as a help-only verification command.

## CI review observations

The Windows-only local-tarball approval mismatch persisted even with npm's approval writer:
its lockfile reader and policy resolver disagree on Windows path separators. The fixture now
serves two packages through a loopback registry, primes an isolated cache with scripts disabled,
then stops the server before testing real offline clean installs. This exercises the same
name/version policy as repository dependencies without skipping Windows or weakening the checks.
A separate ticket-counter test queried the attached project ID inside a project-local database;
it now uses the local ID and deliberately creates differing IDs to cover that distinction.
Those tests now pass on Windows. A later loaded runner exposed short PowerShell startup budgets
in two other tests: both now use the existing integration pool, bounded subprocess waits, and
explicit subprocess-error diagnostics. Bootstrap scenarios have independent timeout budgets.
Both subsequent CI runs passed all test lanes, including the Windows PowerShell checks. One macOS
Homebrew channel job failed while fetching Homebrew's own tap with an HTTP/2 framing error;
its sibling run passed. The failed Packaging summary aggregates that channel failure.
CI and release setup now reuse an installed GNU tar instead of asking Homebrew to install it again.
This removes the redundant-install warning while retaining installation on runners that lack it.
The latest Windows failure was a stopped tsx/esbuild service in the package-import probe; its
next identical invocation passed. The logs do not establish why the service stopped. That test
now uses the existing isolated integration pool and one child for both assertions, with bounded
timeouts and temporary-file cleanup. No retry or skipped assertion hides a failed import.

The Node Current job originally stopped at bundled npm 11.19.1, leaving its tests unexecuted.
It now warns about an unsupported bundled npm and falls back to the declared approved version.
Bundled npm within major 12 remains floating. A failed bootstrap or version verification still
fails the job before project installation; genuine test failures remain visible.
The latest Kilo review completed with no findings; its earlier output-limit failure is superseded.

### Scanner dashboard findings

GitHub alert #158 repeats the exact-approved OpenCode tooling finding. Its dismissal was read
back from the GitHub API. The separate
[SonarCloud issue](https://sonarcloud.io/project/issues?id=looptroop-ai_LoopTroop&issues=AaCQ17S6Ad9JgHF7hF2t&pullRequest=154)
now reports ACCEPTED with a WONTFIX resolution, verified through SonarCloud's API. The latest
SonarCloud quality gate passes; this source-system acceptance is separate from GitHub's dismissal.

[Codacy's new finding](https://app.codacy.com/gh/looptroop-ai/LoopTroop/pull-requests/154)
flags the fetch call in the exported installer download helper as accepting user-controlled URLs.
This is a standalone local installer, not a server endpoint: callers obtain URLs from release
metadata or explicit operator configuration. Every redirect is scheme-checked before dispatch,
and cross-origin authorization is removed. A fixed hostname list would break configured release
mirrors or changes to GitHub's asset delivery hosts without addressing an exposed server route.
Treat this as a scoped false positive for the current local callers; reassess if the helper ever
handles remote application requests. Codacy's dashboard decision remains pending.

No authenticated Codacy connection was available to resolve its remaining dashboard finding.
No blanket analyzer exclusions or line-moving workarounds were introduced to hide the findings.

### Upstream warnings retained after review

Rechecked on 2026-09-11. No released, drop-in fix was found for the warning sources below.
Retaining these tools and documenting the limitations was approved for PR17. Their warnings
remain visible; this decision does not suppress failures or weaken verification.

- **Artifact downloads:** the pinned action matches the [latest upstream release](https://github.com/actions/download-artifact/releases/latest).
  Its archive extraction dependencies still use deprecated Buffer construction, and the
  [upstream report remains open](https://github.com/actions/download-artifact/issues/484).
  The action transfers build files between CI jobs and
  [fails on a digest mismatch by default](https://github.com/actions/download-artifact/blob/3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/action.yml#L42-L46).
  The [GitHub CLI download implementation](https://github.com/cli/cli/blob/trunk/pkg/cmd/run/download/http.go)
  downloads and extracts the archive without that digest comparison. Replacing the action with
  the CLI alone would therefore remove a check we already rely on.
- **Renovate configuration validation:** [current registry metadata](https://registry.npmjs.org/renovate/latest)
  still includes global-agent and bunyan. Their dependency chains reach deprecated boolean,
  and, through bunyan's optional mv dependency, rimraf, glob and inflight. The dependency
  relationships and deprecation notices were checked in npm's registry. Updating Renovate alone
  does not remove these chains; changing its installation method or hiding npm output does not
  repair them. Retain the validator so dependency-update configuration continues to be checked.
  Its optional RE2 native module is also unavailable under the reviewed script policy. Renovate
  [explicitly falls back to JavaScript RegExp](https://github.com/renovatebot/renovate/blob/44.13.2/lib/util/regex.ts).
  Schema validation continues; RE2-specific syntax checking is reduced. The current configuration
  uses simple patterns and has no identified engine mismatch. Reassess before adding patterns
  that depend on [RE2-specific behavior](https://docs.renovatebot.com/string-pattern-matching/);
  do not suppress the warning or broadly approve native installation scripts.
  PR18's CI logs also contain the Google metadata dependency path through gaxios:
  rimraf brings in a deprecated glob, while node-fetch and fetch-blob bring in node-domexception.
  These paths still exist in [current Renovate registry metadata](https://registry.npmjs.org/renovate/latest)
  and [gaxios metadata](https://registry.npmjs.org/gaxios/7.1.3), checked on 2026-09-12.
  Updating the validator alone therefore does not remove these additional warnings.
- **Linux binary injection:** postject's bundled LIEF emits `Can't find string offset for section name`
  diagnostics for `.note` sections. The [upstream maintainer identifies their source](https://github.com/nodejs/postject/issues/83#issuecomment-1506397578)
  and deliberately retains the diagnostics. The installed postject matches its
  [latest release](https://github.com/nodejs/postject/releases/tag/v1.0.0-alpha.6).
  Current Linux binary jobs pass their reproducibility and execution checks; that evidence does
  not establish compatibility with every ELF tool. Stripping the executable to silence the
  warning is unsafe: an [upstream report describes resulting crashes](https://github.com/nodejs/postject/issues/90).
  Keep the diagnostics and binary checks, and revisit when postject ships an updated LIEF.
  Windows injection also reports a signature diagnostic. The
  [pinned Node documentation](https://github.com/nodejs/node/blob/v24.18.1/doc/api/single-executable-applications.md)
  explicitly makes Windows signature removal optional and permits these warnings when it is
  skipped. The build comment now reflects that distinction from mandatory macOS removal.

These are CI-tool limitations, not changes to LoopTroop's runtime dependency tree. Deprecation
does not by itself establish an exploitable vulnerability in these jobs; it also does not prove
the affected code is safe. Recheck when the upstream action fixes its extraction dependencies,
when Renovate removes these chains, or if an advisory identifies an applicable vulnerability.
Any replacement must preserve artifact digest enforcement or equivalent configuration validation.

Repository-owned warning fixes remain in place. The TypeScript checker and installer generator
filter only Node's exact parser API-status advisory, preserving other warning details and
one-shot listeners.
