# PR163 review dispositions

This is the permanent disposition record for the substantive PR163 review
comments and inline findings. Evidence names committed tests or checks; no
temporary `/tmp` report is treated as proof. A previously held overflow-UID
choice is now resolved by the explicit trusted-directory policy recorded below.

| Review comment(s) | Disposition | Evidence and resulting scope |
| --- | --- | --- |
| `4030919510`, `5714201036.1`, `5714480580`, `5714878138.1`, `5714892259.1` | correct — fixed | `whichLooptroop()` now inherits the parent environment when no hint is supplied; `tests/smokePublished.test.ts` proves a launcher is found through inherited `PATH`. |
| `4030919519`, `4030924389`, `4030998343`, `5714117602.5`, `5714474287`, `5714892259.5` | correct — fixed | Linux overflow ownership is no longer trusted through root, the current UID, the Node interpreter owner, or canonical OpenCode placement. `server/lib/__tests__/executablePath.test.ts` covers default refusal, an unmapped interpreter owner, configured overflow UID `0`, canonical OpenCode refusal, and exact-directory opt-in; `npm run installers:check` covers the generated copies. |
| `4030905957` | correct — fixed | Explicit Windows paths no longer require their extension in `PATHEXT`; extensionless names still use normalized `PATHEXT` siblings. `server/lib/__tests__/executablePath.test.ts` covers an explicit absent-`PATHEXT` `.EXE` path, and `npm run installers:check` covers generated copies. |
| `4030905951`, `4030998332` | correct — fixed | Container repair conditionally downloads/verifies/builds with `package-lock.json` only when the release manifest records it, and accepts a legacy image without the inventory while keeping strict checks for current assets. `tests/workflowPolicy.test.ts` and `tests/packagingProbes.test.ts` cover the workflow contract. |
| `5714117602.1`, `5714201036.1.3`, `5714363672.2a`, `5714892259.2` | correct — fixed | Damaged-binary replacement now requires a valid daemon record with a dead PID and closed recorded endpoint; missing, malformed, live and inconclusive evidence stays blocked with usable PID/removal advice. `tests/installer.test.ts` covers repair, wildcard host, missing/malformed state, live PID and unprobeable endpoint cases. |
| `5714201036.1.2`, `5714892259.1`, `4030998354` | correct — fixed | The published binary upgrade recipe uses the HTTPS-only curl flags emitted by `doctor`; the smoke assertion and generated `tests/fixtures/install-catalog.json` are synchronized. `tests/smokePublished.test.ts` and `tests/docsInstallCatalog.test.ts` cover it. |
| `5714201036.2.1` | correct — fixed | The serial release-argument child-process test has a bounded 45-second timeout in `tests/releaseScriptArgs.test.ts`. |
| `5714201036.2.2`, `5714878138.2` | correct — fixed | Workflow policy reuses `shared/nodeFloor.ts`, parses quoted numeric selectors, and treats omitted minor/patch components as zero for concrete selectors. The policy test includes `"24.18"` and `v24.18.1` evidence; bare major selectors remain floating compatibility lanes. |
| `5714201036.2.3` | correct — fixed | Stale lock cleanup uses forced removal so a concurrent cleanup's `ENOENT` is harmless; `tests/installerLock.test.ts` covers stale recovery and ownership. |
| `5714201036.2.4` | correct — fixed | Custom `PATHEXT` entries are normalized to leading-dot extensions in the shared resolver and regenerated installer copies; executable-path tests cover the resolver contract. |
| `5714201036.2.5` and CodeRabbit structured-node suggestion | correct — fixed | `doctor --json` adds `checks[].node.version` on both Node branches. CI/release parse that field as JSON, and `tests/doctorCommand.test.ts` plus `tests/workflowPolicy.test.ts` keep the machine-readable contract. |
| `5714327501` (R-20) | correct — fixed | The PowerShell forwarding test asserts both generated-block markers exist and are ordered before slicing; `tests/installer.test.ts` remains the permanent guard. |
| `5714327501` (release permission comment) | correct — fixed | The release build comment now describes read-only build permissions and the separate download-only attestation jobs. `tests/workflowPolicy.test.ts` checks the permission split. |
| `5714612716` (channel-inputs usage) | correct — fixed | Argument errors include the executable usage line; `tests/channelInputs.test.ts` asserts it for an unknown option. |
| `5714612716` (workflow output interpolation) | correct — fixed | Published-smoke matrix and release versions cross steps through `env` and shell-safe `printf`/variables. `tests/workflowPolicy.test.ts` rejects output expressions inside workflow shell source. |
| `5714612716` (release no-side-effect assertion) | correct — fixed | The malformed-argument test keeps the build-script-specific output assertion and checks the shared marker for every script, avoiding an unrelated string contract. `tests/releaseScriptArgs.test.ts` runs the sixteen bounded child cases. |
| `5714892259.4` | not-applicable after verification | The generated Linux guidance already says `nvm install 24`; it is floor-compatible with the current `24.18.1` launcher floor and is covered by installer/node-floor checks, so no speculative wording change was made. |
| `5714117602.4` (namespace wording) | correct — fixed | Changelog, README and this ledger describe fail-closed namespace handling: an overflow or unverifiable owner is refused unless the operator explicitly names its exact directory with `LOOPTROOP_TRUSTED_EXECUTABLE_DIRS`. |
| `5714117602.6` (temporary evidence) | correct — fixed | Permanent evidence now lives in this file and committed tests/contract checks; temporary packet paths are not cited as completion evidence. |
| `5714327501`, `5714363672.1`, `5714892259.3` (R-23 `server/git/push.ts`) | correct — addressed in PR168 | PR168 already rejects non-digit and unsafe `GIT_CONFIG_COUNT` values in `server/git/push.ts`; `tests/push.test.ts` cases 185 and 210 preserve caller Git configuration. PR163 carries the cross-part disposition without duplicating the fix. |
| `5714363672` (S-03/S-04 and S-05–S-12 scope) | wrong in part — corrected | The review's claim that S-03/S-04 are absent is contradicted by the existing `exposedOnSecondRead` cross-argument quote-state and `expandableReferenceAcrossParts` implementations plus their permanent tests. S-05–S-12 remain outside this branch and are not claimed here. |
| S-03/S-04 implementation coverage | correct — fixed before intake | `server/lib/__tests__/executablePath.test.ts` covers quote state crossing arguments and percent pairs crossing or not crossing independent quoted arguments; `CHANGELOG.md` and the consolidated ledger now record these security behaviors. |
| `5714117602.5`/`5714474287` (S-01 overflow) and `5714117602.4` | correct — fixed | The security concern is valid and is fixed with an explicit exact-directory opt-in. Mapped root/current/interpreter owners remain trusted only when the namespace map proves them mapped; overflow-owned tools are refused by default, including canonical OpenCode binaries. |
| `5714117602.6`/`5714892259` (exact Node 26.9.0) | not-applicable | Reproducible native SEA output intentionally requires the exact builder; `tests/releaseScriptArgs.test.ts` and workflow policy retain the pin. |
| `5714117602` (second lock abstraction) | not-applicable | The smallest conditional workflow edits are sufficient; `tests/packagingProbes.test.ts` exercises the existing build-context contract. |
| `5714117602` (explicit SEA chmod) | not-applicable after verification | Existing native output/package checks did not show a mode regression; no speculative chmod was added. |
| `5714117602` (POSIX `findToolPath` trust policy) | not-applicable | The shared resolver is the intentional security boundary; restoring `command -v` would undo the accepted PATH/trust fix. |
| `5714117602` (`--force` damaged-binary override) | not-applicable | An override would weaken the fail-closed installer boundary; independent state/port evidence is the safer repair path. |
| `5704664935`, `5704668841`, `5704683795`, `5704688436`, `5705733968`, `5705774805` | not-applicable / no additional action | These summaries, quality-gate notices, and review-limit/deprecation notices supplied no distinct owned fix beyond the findings above; CI/workflow policy and focused tests retain their relevant checks. |

## Review contract retained

Root's post-push CI review found and fixed a missing command-substitution
parenthesis in container repair. The Windows scope regression now supplies Git
as a Bash function because a native PATH override still resolved the runner's
Git. Sonar's new duplication failure was traced to repeated test setup;
damaged-install fixtures and malformed-argument cases now share that setup
without dropping scenarios or excluding files from analysis.

Local aggregate verification passed all 424 test files (6,042 tests,
11 skipped), full lint and build, version consistency, generated installer
consistency, package contents, production native-addon checks and script
type-stripping checks. The subsequent CI fixes passed the same pinned
Actionlint/ShellCheck checks and all 20 focused workflow, daemon-evidence and
argument-contract tests. Native Windows execution is left to CI; the Bash
fixture change is not claimed as a locally executed Windows test.

CI warnings were inspected separately from test failures. The artifact-download
`DEP0005` warning comes from the pinned upstream action's extraction dependencies;
[upstream issue 484](https://github.com/actions/download-artifact/issues/484)
remains open. The Renovate validator invocation also emits transitive package
deprecations and an optional native RE2-load warning before falling back to
JavaScript regular expressions. These are not application dependency warnings
and were not fixed or hidden by this review. Replacing the validator or vendoring
the artifact action would be separate maintenance work, not evidence that these
warnings have disappeared.

The remaining review envelopes are accounted for here:

- `5704700507`: correct; its container-repair and explicit Windows-path
  findings are fixed by the corresponding rows above.
- `5704729991`: correct; repeats the now-fixed overflow-UID security finding.
- `5228597247`: mixed; structured Node facts, container inventory handling,
  and HTTPS recipes are fixed; overflow ownership now uses the explicit opt-in
  policy described above.
- `5228460355`: not applicable; Sourcery's diff-size limit supplied no finding.
- `5228482549`: informational approval, not independent proof of namespace
  safety; the concrete overflow finding remains valid despite that approval.
- `5228490619` and `5228513632`: empty review bodies; their associated issue
  and inline comments are assessed above.
- `5228508008`: Codex review envelope; the associated inline findings are
  assessed above.
- Check `105297450923`: the review model reached its output limit and supplied
  no annotation; this is a review-envelope failure, not a source finding.

The overflow-UID behavior is resolved in this packet: the default is
fail-closed, and an operator can opt in only an explicitly named directory.
All other rows above are either fixed, explicitly deferred to another scope,
or verified as not applicable.

The refreshed comments retain the same dispositions: `5704668841` is a rate-limit notice and non-gating docstring metric; `5704700507` marks both defects resolved; `5704729991` reports no new finding; `4030998332` confirms the legacy inventory fix. `5717159324` reports no Codacy findings. Sonar `5717659102` passes the gate but still identified two `S7773` style warnings; both now use `Number.NaN`, and the embedded installers were regenerated from the shared source. Unknown overflow ownership is refused by default and never made trusted by a container-wide fallback.
