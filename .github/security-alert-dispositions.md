# Reviewed code-scanning dispositions

Reviewed on 2026-09-11 against PR17, based on `main` at `377628ec`.
Match future findings by rule and code location; alert numbers are references to this scan only.

## Install scripts

Repository installs retain the exact-version esbuild approvals in `package.json`.
Disabling all scripts here would skip esbuild's binary setup. The npm pin script asserts the
reviewed major as well as the declared version. The Node Current lane keeps its bundled npm,
but refuses to install unless it is npm 12. Policy tests exercise an approved and a denied
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

## Dismissal ledger

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
  an HTTPS request can never downgrade to that fixture. Published curl bootstrap and upgrade
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
script restrictions are unchanged. No app route, status, parser, or payload key changes in this
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

The floating Node Current job reported npm 11.19.1 and refused installation as intended: its
policy still requires npm 12. No build or tests run in that lane until the bundled npm meets
the policy; it currently reports a toolchain-policy mismatch, not Node compatibility results.
The latest Kilo review completed with no findings; its earlier output-limit failure is superseded.

### Scanner dashboard findings

GitHub alert #158 repeats the exact-approved OpenCode tooling finding. Its dismissal was read
back from the GitHub API. The separate
[SonarCloud issue](https://sonarcloud.io/project/issues?id=looptroop-ai_LoopTroop&issues=AaCQ17S6Ad9JgHF7hF2t&pullRequest=154)
still requires acceptance in SonarCloud; a GitHub dismissal does not resolve that quality gate.

[Codacy's new finding](https://app.codacy.com/gh/looptroop-ai/LoopTroop/pull-requests/154)
flags the fetch call in the exported installer download helper as accepting user-controlled URLs.
This is a standalone local installer, not a server endpoint: callers obtain URLs from release
metadata or explicit operator configuration. Every redirect is scheme-checked before dispatch,
and cross-origin authorization is removed. A fixed hostname list would break configured release
mirrors or changes to GitHub's asset delivery hosts without addressing an exposed server route.
Treat this as a scoped false positive for the current local callers; reassess if the helper ever
handles remote application requests. Codacy's dashboard decision remains pending.

No authenticated SonarCloud or Codacy connection was available for these dashboard decisions.
No blanket analyzer exclusions or line-moving workarounds were introduced to hide the findings.

### Upstream warnings retained after review

Rechecked on 2026-09-11. No released, drop-in fix was found for the two warning sources below.
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

These are CI-tool limitations, not changes to LoopTroop's runtime dependency tree. Deprecation
does not by itself establish an exploitable vulnerability in these jobs; it also does not prove
the affected code is safe. Recheck when the upstream action fixes its extraction dependencies,
when Renovate removes these chains, or if an advisory identifies an applicable vulnerability.
Any replacement must preserve artifact digest enforcement or equivalent configuration validation.

Repository-owned warning fixes remain in place. The TypeScript checker and installer generator
filter only Node's exact parser API-status advisory, preserving other warning details and
one-shot listeners.
