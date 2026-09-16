# Consolidated audit documentation ledger

This ledger records documentation coverage for reviewed packets. `PASS` means
the named packet evidence passed its bounded review; final integration and
acceptance remain with the root worker. A row never implies that an unreviewed
or unimplemented finding is complete.

## Reviewed release packet

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| R01 | PASS, final pending | `release-workflow-evidence.md`; Windows published smoke uses the shared PATHEXT-aware resolver and an affected-file gate. | Native Windows gate remains CI-only here. |
| R02 | PASS, final pending | `release-workflow-evidence.md`; scheduled and repair smoke checks use the tested release tag and the reviewed OpenCode npm pin. | The moving official installer path is intentionally not asserted; scheduled smoke was not run locally. |
| R03 | Documented | Website `docs/installation.md#standalone-executable` describes current source flags and keeps the served `v0.5.9` `-DryRun`/`-Help` warning. | The served installer remains unsafe for those two flags until a release updates it. |
| R04 | PASS, final pending | `release-workflow-evidence.md`; release-PR and Renovate Git credentials are per-invocation headers and are removed before unrelated Git work. | No live push was performed. |
| R05 | PASS, final pending | `release-workflow-evidence.md`; attestation jobs download bytes only, while publish/build credentials stay separated. | No live attestation or publish was performed. |
| R06 | PASS, final pending | `release-workflow-evidence.md`; manifest-derived channel values cross workflow steps through environment variables after safe-basename validation. | Workflow execution was not run locally. |
| R07 | PASS, final pending | `release-workflow-evidence.md`; Renovate notices are validated outside the checkout as one regular top-level file before copy. | No Renovate workflow run was performed. |
| R11 | PASS, final pending | `release-scripts-evidence.md`; `tests/docsInstallCatalog.test.ts` and `node scripts/docs-install-catalog.mjs` cover the machine-readable install catalog. | Website source pin remains `83ae324348164c6f4d1c5dedaebcba69359d15c9` until root supplies the final public commit. |
| R12 | Documented | Website verification checks out the immutable source ref and fails closed when the catalog is absent; the existing R12 section below records the design. | The ref must move with the final accepted app commit. |
| R13 | PASS, final pending | `release-workflow-evidence.md`; workflow Node versions, matrix versions, and numeric Docker tags are checked against the package engine floor. | CI-only policy execution was not run locally beyond the packet checks. |
| R14 | PASS, final pending | `release-scripts-evidence.md`; all five install-smoke consumers compare structured `checks[].install.channel` and `checks[].install.upgradeCommand`, not `detail`. Website `docs/diagnostics.md#the-install-check` documents that contract. | No package-manager, container, or lifecycle smoke was run. |
| R15 | PASS, final pending | `release-scripts-evidence.md`; WinGet gives Git and GitHub CLI only the copied child environment credentials they need and removes ambient token aliases. | No live WinGet submission was performed. |
| R16 | PASS, final pending | `release-workflow-evidence.md`; release assets include the npm tarball and matching `package-lock.json`; Docker copies both and runs locked `npm ci --ignore-scripts --omit=dev`. Website `docs/installation.md#running-in-a-container` describes the resulting image. | Docker daemon unavailable locally; container build and lifecycle remain CI-only. |
| R17 | PASS, final pending | `release-workflow-evidence.md`; Scoop bootstrap uses the explicit `https://get.scoop.sh` URL. | Native Windows execution remains CI-only. |
| R18 | PASS, final pending | `release-scripts-evidence.md` and `release-workflow-evidence.md`; release/channel argument parsers reject unknown, missing, flag-shaped, and positional inputs before side effects. | No publish-side effect was exercised. |
| R19 | PASS, final pending | `release-scripts-evidence.md`; npm 12 JSON errors and failing empty objects remain unavailable, while successful empty JSON means current. | Only the bounded loopback failure probe was run; no registry update was attempted. |
| R21 | PASS, final pending | `release-workflow-evidence.md`; the finished multi-architecture index is attested after assembly, and each architecture records installed package versions by immutable image digest. Website `docs/installation.md#running-in-a-container` records this evidence boundary. | Docker and registry jobs remain CI-only; no live image publication was performed. |
| R24 | PASS, final pending | `release-workflow-evidence.md`; release, repair, CI, and Docker npm fetches use three retries with 10 to 60 second retry bounds. App `CONTRIBUTING.md` records the scope. | This does not change package-manager retry defaults for users. |
| R26 | Documented | App `README.md` and website prerequisites state Node `24.18.1+` and npm `12.0.2+`. | No additional limitation. |
| R27 | Documented | App `README.md` and website installation pages label Yarn commands as Bash/zsh and recommend npm on Windows without an unverified PowerShell PATH recipe. | Native Windows Yarn PATH behavior is not claimed as verified. |
| R29 | PASS, final pending | `release-scripts-evidence.md`; WinGet submission prose declares Git and GitHub CLI dependencies. The app changelog records the correction. | No live WinGet submission was performed. |
| S09 | PASS, final pending | `release-scripts-evidence.md`; maintenance and stall diagnostics use shared ANSI stripping, including C1 CSI and OSC sequences. | No additional platform limit beyond the packet test environment. |

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

The install catalog was introduced in app commit `68a8a5f3…` and is also present
in `0b782f6c…` and the current app worktree. No published tag contains it. The
website's owner-approved source ref remains the immutable app commit
`83ae324348164c6f4d1c5dedaebcba69359d15c9` until root supplies the final public
accepted commit. Website CI checks out that ref into `.source/LoopTroop`, and
the verifier uses `LOOPTROOP_SOURCE_ROOT` when set or the local sibling checkout
otherwise. A missing catalog fails with an actionable error; there is no reduced
two-channel fallback.

## Integration limits

- `release-scripts-evidence.md`: `/tmp/looptroop-release-scripts-evidence.md`
- `release-workflow-evidence.md`: `/tmp/looptroop-release-workflow-evidence.md`
- `parser-evidence.md`: `/tmp/looptroop-parser-evidence.md`
- `installer-evidence.md`: `/tmp/looptroop-installer-evidence.md`
- No E2E, full lifecycle, live publish, native Windows, Docker daemon, or website source-pin update is claimed here.
- The root worker must rerun any app version/catalog checks after final source integration and update the website immutable source ref and matching CI checkout together.
- Future not-yet-implemented report packets need their own documentation pass; this ledger does not pre-document them.
