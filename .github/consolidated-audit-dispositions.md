# Consolidated audit documentation ledger

This ledger records documentation coverage for the reviewed release and
installer part. `PASS` means the named packet evidence passed its bounded
review; final integration and acceptance remain with the root worker. A row
never implies that an unreviewed or unimplemented finding is complete.

## Reviewed release packet

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| R01 | PASS, final pending | `scripts/smoke-published.mjs` preserves the resolved launch file, errno, and operating-system message when a child cannot start; `tests/smokePublished.test.ts` exercises that production `run()` path with a real executable and a missing working directory. | Native Windows gate remains CI-only here. |
| R02 | PASS, final pending | `release-workflow-evidence.md`; scheduled and repair smoke checks use the tested release tag and the reviewed OpenCode npm pin. | The moving official installer path is intentionally not asserted; scheduled smoke was not run locally. |
| R03 | Documented | Website `docs/installation.md#standalone-executable` describes current source flags and keeps the served release's `-DryRun`/`-Help` warning. | The served installer remains unsafe for those two flags until a release updates it. |
| R04 | PASS, final pending | `release-workflow-evidence.md`; release-PR and Renovate Git credentials are per-invocation headers and are removed before unrelated Git work. | No live push was performed. |
| R05 | PASS, final pending | `release-workflow-evidence.md`; attestation jobs download bytes only, while publish/build credentials stay separated. | No live attestation or publish was performed. |
| R06 | PASS, final pending | `release-workflow-evidence.md`; manifest-derived channel values cross workflow steps through environment variables after safe-basename validation. | Workflow execution was not run locally. |
| R07 | PASS, final pending | `release-workflow-evidence.md`; Renovate notices are validated outside the checkout as one regular top-level file before copy. | No Renovate workflow run was performed. |
| R11 | PASS, final pending | `release-scripts-evidence.md`; `tests/docsInstallCatalog.test.ts` and `node scripts/docs-install-catalog.mjs` cover the machine-readable install catalog. | Website source pin remains `83ae324348164c6f4d1c5dedaebcba69359d15c9` until root supplies the final public commit. |
| R12 | Documented | Website verification checks out the immutable source ref and fails closed when the catalog is absent; the existing R12 section below records the design. | The ref must move with the final accepted app commit. |
| R13 | PASS, final pending | `scripts/build-binary.mjs`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, and `tests/releaseScriptArgs.test.ts`/`tests/workflowPolicy.test.ts`; package, application and container jobs retain the Node `24.18.1` floor, while each standalone binary job pins the exact Node `26.9.0` native SEA builder and blocks on an embedded-runtime application check. Detailed results are in `/tmp/looptroop-release-part-evidence.md`. | CI-only policy execution was not run locally beyond the packet checks. |
| R14 | PASS, final pending | `release-scripts-evidence.md`; all five install-smoke consumers compare structured `checks[].install.channel` and `checks[].install.upgradeCommand`, not `detail`. Website `docs/diagnostics.md#the-install-check` documents that contract. | No package-manager, container, or lifecycle smoke was run. |
| R15 | PASS, final pending | `release-scripts-evidence.md`; WinGet gives Git and GitHub CLI only the copied child environment credentials they need and removes ambient token aliases. | No live WinGet submission was performed. |
| R16 | PASS, final pending | `release-workflow-evidence.md`; release assets include the npm tarball and matching `package-lock.json`; Docker copies both and runs locked `npm ci --ignore-scripts --omit=dev`. Website `docs/installation.md#running-in-a-container` describes the resulting image. | A local amd64 image build passed; multi-architecture registry publication and lifecycle remain CI-only. |
| R17 | PASS, final pending | `release-workflow-evidence.md`; Scoop bootstrap uses the explicit `https://get.scoop.sh` URL. | Native Windows execution remains CI-only. |
| R18 | PASS, final pending | `release-scripts-evidence.md` and `release-workflow-evidence.md`; release/channel argument parsers reject unknown, missing, flag-shaped, and positional inputs before side effects. | No publish-side effect was exercised. |
| R19 | PASS, final pending | `release-scripts-evidence.md`; npm 12 JSON errors and failing empty objects remain unavailable, while successful empty JSON means current. | Only the bounded loopback failure probe was run; no registry update was attempted. |
| R21 | PASS, final pending | `release-workflow-evidence.md`; the bounded local check built the amd64 image and inspected its recorded package-version inventory, while the workflow keeps multi-architecture assembly/index attestation after publication. Website `docs/installation.md#running-in-a-container` records this evidence boundary. | No multi-architecture build or attestation, live registry publication, Docker lifecycle, native Windows, or package-feed operation was run here. |
| R24 | PASS, final pending | `release-workflow-evidence.md`; release, repair, CI, and Docker npm fetches use three retries with 10 to 60 second retry bounds. App `CONTRIBUTING.md` records the scope. | This does not change package-manager retry defaults for users. |
| R26 | Documented | App `README.md` and website prerequisites state Node `24.18.1+` and npm `12.0.2+`. | No additional limitation. |
| R27 | Documented | App `README.md` and website installation pages label Yarn commands as Bash/zsh and recommend npm on Windows without an unverified PowerShell PATH recipe. | Native Windows Yarn PATH behavior is not claimed as verified. |
| R29 | PASS, final pending | `release-scripts-evidence.md`; WinGet submission prose declares Git and GitHub CLI dependencies. The app changelog records the correction. | No live WinGet submission was performed. |
| R30 | PASS, final pending | `tests/wireContract.test.ts` keeps the API routes, live-event names, and `doctor --json` check names as explicit wire contracts; `CHANGELOG.md` describes those names without fragile numeric totals. | The contract lists remain intentionally hand-maintained and final integration review remains with the root worker. |
| S09 | PASS, final pending | `release-scripts-evidence.md`; the release-script ANSI subset uses shared stripping, including C1 CSI and OSC sequences. | Only this release-script ANSI subset is covered here; `isPlainObject` and other source cleanup belong to later parts. |

## Installer foundation

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| R08 | PASS, final pending | `installer-evidence.md`; lock recovery requires proof that the recorded owner exited and blocks malformed or unverifiable owners. Website `docs/installation.md#standalone-executable` describes the conservative recovery. | No install lifecycle was run. |
| R09 | PASS, final pending | `installer-evidence.md`; signal cleanup releases only the current lock token before re-raising. | No install lifecycle was run. |
| R10 | PASS, final pending | `installer-evidence.md`; an unreadable status plus an unexecutable installed copy fails closed and leaves it untouched. | No install lifecycle was run; no native Windows or Docker run. |
| R20 | PASS, final pending | `installer-evidence.md`; the Windows-only forwarding check inspects the handwritten forwarding block. | PowerShell is unavailable on this Linux runner. |
| R22 | PASS, final pending | `installer-evidence.md`; POSIX forces installer style and PowerShell rejects empty bound values before forwarding. | PowerShell is unavailable on this Linux runner. |
| R25 | PASS, final pending | `installer-evidence.md`; launcher and installer help point to `nvm install 24`, verified with isolated nvm `v0.40.7` and Node `v24.21.0`. | The nvm run was Linux-only; no native Windows verification. |

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
- `installer-evidence.md`: `/tmp/looptroop-installer-evidence.md`
- A local Linux amd64 Docker image build and package-version inventory passed, and a local Linux x64 standalone build used the checksum-verified Node `26.9.0` native SEA builder twice with byte-identical output, clean ELF notes/segments, and non-lifecycle `--version`/`doctor --json` checks. No E2E, full lifecycle, live publish, native Windows, macOS or arm64 binary success, multi-architecture build or registry attestation/publication, or website source-pin update is claimed here.
- The root worker must rerun any app version/catalog checks after final source integration and update the website immutable source ref and matching CI checkout together.
- Future not-yet-implemented report packets need their own documentation pass; this ledger does not pre-document them.
