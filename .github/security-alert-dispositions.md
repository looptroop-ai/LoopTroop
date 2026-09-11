# Reviewed code-scanning dispositions

Reviewed on 2026-09-11 against PR17, based on `main` at `377628ec`.
Match future findings by rule and code location; alert numbers are references to this scan only.

## Install scripts

Repository installs retain the exact-version esbuild approvals in `package.json`.
Disabling all scripts here would skip esbuild's binary setup. The npm pin script asserts the
reviewed major as well as the declared version. The Node Current lane keeps its bundled npm,
but refuses to install unless it is npm 12. Policy tests exercise an approved and a denied
local package using npm's own tarball identity resolution on every platform, and check workflow
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

## Dismissal ledger

All 26 rows below were dismissed as `won't fix` on GitHub on 2026-09-11, and their
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
  an HTTPS request can never downgrade to that fixture. Published curl bootstrap and upgrade
  commands also restrict initial requests and redirects to HTTPS.
- The OpenCode tooling install is exact-pinned (#18). LoopTroop channel selection is unchanged.
- Workflow permission alerts #16 and #20 were already fixed before this stage.

No CSP script restriction is weakened. No app route, status, parser, or payload changes in this
stage; the existing upgrade-command value now includes HTTPS enforcement. Container build inputs
are limited to the selected tarball and Dockerfile; WinGet Git credentials move from process
arguments to fork-scoped process configuration without replacing inherited Git settings.
Installer locking protects live owners and serializes abandoned-lock recovery. PID checks
assume one host and PID namespace. A reused PID remains conservatively blocked and requires
manual cleanup after verifying no installer is running, just like an abandoned recovery claim.

## Published documentation

The website checkout was checked separately. Its installation page now includes conditional
recovery guidance for an installer that reports `.install.lock` or `.install.lock.claim`: wait and retry, and
remove only the named file after verifying no installer is running. Its released CLI source
reference and the installer updates already scheduled for release are unchanged. Its curl
bootstrap commands now enforce HTTPS, including redirects; those flags were checked against
the published wrapper with `--help` before documenting them.

## CI review observations

The first PR17 CI run exposed a Windows-only local-tarball approval mismatch, corrected by
letting npm write the fixture's resolved identity. The floating Node Current job reported
npm 11.19.1 and refused installation as intended: its policy still requires npm 12.
The Kilo review failed because its model output limit was reached, without a code finding.

Two external tools still emit upstream deprecation warnings: the current pinned
download-artifact action's archive dependency uses deprecated Buffer construction
([upstream issue](https://github.com/actions/download-artifact/issues/484)), and Renovate's
validator dependency tree contains deprecated packages. A plain `gh run download` replacement
would lose the action's artifact digest verification. These warnings are separate from the
repository-owned warnings corrected here. The TypeScript checker and installer generator
filter only Node's exact parser API-status advisory, preserving other warning details and
one-shot listeners.
