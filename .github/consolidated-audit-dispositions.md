# Consolidated audit documentation ledger

This ledger records documentation coverage for the reviewed release and
installer part. `PASS` means the named packet evidence passed its bounded
review; final integration and acceptance remain with the root worker. A row
never implies that an unreviewed or unimplemented finding is complete.

The release implementation is carried by open PR163. Its immutable website
source pin was reviewed independently at website commit `83cdf633`; this
release-part ledger records that bounded result and does not claim whole-audit
acceptance.

## Reviewed release packet

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| R01 | PASS, final pending | `scripts/smoke-published.mjs` preserves the resolved launch file, errno, and operating-system message when a child cannot start; `tests/smokePublished.test.ts` exercises that production `run()` path and the inherited-`PATH` launcher lookup. | Native Windows gate remains CI-only here. |
| R02 | PASS, final pending | `.github/workflows/published-smoke.yml`, `.github/workflows/container-republish.yml`, and `.github/workflows/release.yml` use the tested release tag; `tests/workflowPolicy.test.ts` checks tag/output wiring and `tests/smokePublished.test.ts` checks the hardened binary upgrade recipe. | The moving official installer path is intentionally not asserted; scheduled smoke was not run locally. |
| R03 | Documented | Website `docs/installation.md#standalone-executable` describes current source flags and keeps the served release's `-DryRun`/`-Help` warning. | The served installer remains unsafe for those two flags until a release updates it. |
| R04 | PASS, final pending | `release-workflow-evidence.md`; release-PR and Renovate Git credentials are per-invocation headers and are removed before unrelated Git work. | No live push was performed. |
| R05 | PASS, final pending | `release-workflow-evidence.md`; attestation jobs download bytes only, while publish/build credentials stay separated. | No live attestation or publish was performed. |
| R06 | PASS, final pending | `release-workflow-evidence.md`; manifest-derived channel values cross workflow steps through environment variables after safe-basename validation. | Workflow execution was not run locally. |
| R07 | PASS, final pending | `release-workflow-evidence.md`; Renovate notices are validated outside the checkout as one regular top-level file before copy. | No Renovate workflow run was performed. |
| R11 | PASS, final pending | `release-scripts-evidence.md`; `tests/docsInstallCatalog.test.ts` and `node scripts/docs-install-catalog.mjs` cover the machine-readable install catalog. | Website pins source ref `f784f055b45854016c245a2d902d6799b7e8265c` in website commit `83cdf633`; implementation and pin were reviewed independently. |
| R12 | Documented | Website verification checks out the immutable source ref and fails closed when the catalog is absent; the existing R12 section below records the design. | The accepted implementation ref and website pin are already aligned; no pin treadmill is needed for this docs-only correction. |
| R13 | PASS, final pending | `scripts/build-binary.mjs`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, and `tests/releaseScriptArgs.test.ts`/`tests/workflowPolicy.test.ts`; package, application and container jobs retain the Node `24.18.1` floor, while each standalone binary job pins the exact Node `26.9.0` native SEA builder and parses the embedded `doctor --json` `node.version` field. | CI-only policy execution was not run locally beyond the packet checks. |
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
| R08 | PASS, final pending | `tests/installerLock.test.ts` and the installer lock implementation require proof that the recorded owner exited, tolerate stale-lock `ENOENT`, and block malformed or unverifiable owners. Website `docs/installation.md#standalone-executable` describes the conservative recovery. | No install lifecycle was run. |
| R09 | Not applicable | The active synchronous lock-release callback and direct signal fixture were dead code: the signal is queued until the action's `finally` releases the lock. The real handler still removes temporary work and re-raises; `tests/installerLock.test.ts` covers ownership/finally cleanup. | This synchronous path has no separately callable lock-release signal race. |
| R10 | PASS, final pending | `tests/installer.test.ts` covers damaged-copy repair with a complete dead daemon record and closed recorded endpoint, wildcard live endpoint/PID protection, missing/malformed state refusal, and inconclusive endpoint refusal. The implementation gives PID/removal advice and leaves uncertain files untouched. | No install lifecycle was run; no native Windows or Docker run. |
| R20 | PASS, final pending | `tests/installer.test.ts` asserts both PowerShell forwarding markers exist and are ordered before slicing the handwritten forwarding block. | PowerShell is unavailable on this Linux runner. |
| R22 | PASS, final pending | `tests/installer.test.ts` and the generated wrappers cover POSIX installer style and PowerShell rejection of empty bound values before forwarding. | PowerShell is unavailable on this Linux runner. |
| R25 | PASS, final pending | `scripts/sync-installers.mjs`, `tests/nodeFloor.test.ts`, and installer help keep `nvm install 24`, which is compatible with the current `24.18.1` floor. | Native Windows verification remains CI-only. |
| R23 | Addressed in PR168 | PR168 already rejects non-digit and unsafe `GIT_CONFIG_COUNT` values in `server/git/push.ts`; `tests/push.test.ts` preserves the caller's Git config for the invalid-count cases. | No implementation change in this branch; root should retain PR168's fix when integrating the parts. |
| S01 | Held | Namespace overflow UID trust remains unchanged pending the root/user security choice; the concern and non-claim are recorded in `.github/pr163-review-dispositions.md`. | Do not mark complete until root answers the held choice. |
| S02 | PASS, final pending | Explicit Windows paths are accepted independently of `PATHEXT` while extensionless siblings remain normalized and tested in `server/lib/__tests__/executablePath.test.ts`. | Native Windows execution remains CI-only. |
| S03 | PASS, final pending | `server/lib/executablePath.ts` carries second-read quote state across command-line parts; `server/lib/__tests__/executablePath.test.ts` covers a quote opened in one argument and a metacharacter in the next. | Native Windows execution remains CI-only. |
| S04 | PASS, final pending | `server/lib/executablePath.ts` checks percent-reference pairs that cross command-line parts while keeping independent quoted arguments separate; `server/lib/__tests__/executablePath.test.ts` covers both boundaries. | Native Windows execution remains CI-only. |

## R12 source evidence and applied choice

The install catalog is present in the accepted implementation ref
`f784f055b45854016c245a2d902d6799b7e8265c`, which the website pins in commit
`83cdf633`. Website CI checks out that ref into `.source/LoopTroop`, and the
verifier uses `LOOPTROOP_SOURCE_ROOT` when set or the local sibling checkout
otherwise. A missing catalog fails with an actionable error; there is no reduced
two-channel fallback. The implementation ref and website pin were reviewed
independently; PR163 remains open while whole-audit acceptance remains pending.

## Integration limits

- Permanent evidence is the committed test and workflow-policy coverage named
  above and in `.github/pr163-review-dispositions.md`; temporary packet files
  are not evidence links.
- A local Linux amd64 Docker image build and package-version inventory passed, and a local Linux x64 standalone build used the checksum-verified Node `26.9.0` native SEA builder twice with byte-identical output, clean ELF notes/segments, and non-lifecycle `--version`/`doctor --json` checks. No E2E, full lifecycle, live publish, native Windows, macOS or arm64 binary success, multi-architecture build or registry attestation/publication is claimed here. The website source pin is independently reviewed and already points at the accepted implementation ref; this docs correction made no pin change.
- The root worker must rerun any app version/catalog checks after final source integration. If the accepted implementation ref changes later, update the website immutable source ref and matching CI checkout together.
- Future not-yet-implemented report packets need their own documentation pass; this ledger does not pre-document them.
