# Security Policy

## Supported Versions

LoopTroop has not yet reached a stable release. Security fixes are applied to
the latest published version only; there are no backports to earlier versions.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Anything older | No |

## Reporting a Vulnerability

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/looptroop-ai/LoopTroop/security/advisories/new).

Please do not open a public issue for a security problem, and do not include
credentials, API keys, or tokens in a report.

A useful report includes the affected version and platform, what an attacker
gains, the steps to reproduce it, and any relevant logs with secrets removed.

Expect an acknowledgement within a few days. This is a small project, so
timelines are best-effort rather than contractual. You will be credited in the
advisory unless you ask otherwise.

## Research authorization and Safe Harbor

LoopTroop maintainers authorize source review and testing of a local copy only
on systems, accounts, and data you control or have explicit permission from
their owner to use. This policy does not authorize active testing of
`looptroop.ovh`, hosted or provider services, or another person's LoopTroop
installation. Reports about those assets are still welcome.

Use the minimum proof needed to explain a finding. Do not disrupt services,
access another person's data, or modify or destroy data. Stop and report
privately if you encounter real user data or affect a real user or service.
Give the maintainer a reasonable time to remediate before public disclosure.
There is no bounty; response and remediation are best-effort.

For good-faith research within this scope, the maintainers authorize testing
with respect to applicable anti-hacking laws, waive relevant terms of service,
acceptable-use restrictions, and anti-circumvention claims they control, and
will not initiate or support legal action for policy-compliant research,
including accidental, good-faith violations of this policy. If a third party
brings legal action, the maintainers will clarify the authorization they gave,
to the extent they control the relevant claims. This Safe Harbor does not bind
independent third parties; researchers remain responsible for laws that apply
to them.

The maintainers consider research conducted under this policy lawful, helpful
to security, and conducted in good faith.

See the full [vulnerability disclosure policy](https://www.looptroop.ovh/docs/operations#vulnerability-disclosure).

## Threat Model

LoopTroop is a local developer tool. Understanding what it is designed to do
makes it easier to judge whether a finding is a vulnerability.

By design, LoopTroop:

- runs on `localhost` and is not built to be exposed to a network;
- executes `git`, `gh`, and shell commands against repositories you attach;
- drives an AI agent that reads and writes files in those repositories, and
  creates branches, commits, and pull requests;
- stores its database and prompt overrides in your user configuration
  directory.

Binding LoopTroop to a non-loopback address requires both
`LOOPTROOP_ALLOW_REMOTE_API=1` and `LOOPTROOP_API_TOKEN`, and it refuses to
start otherwise. Doing so exposes a control-plane API that can execute commands
in your repositories, and it is not a supported configuration.

The opt-in development LAN mode is narrower: Vite may be reachable from a
trusted network while the API and OpenCode remain on loopback. When another
trusted proxy terminates the frontend origin before Vite, the development proxy
translates that origin for the loopback API hop only if the browser marks the
request as same-origin and its `Origin` authority exactly matches the incoming
frontend `Host`. An unrelated page fails those checks and reaches the API host
guard unchanged. This development path does not make exposing the installed
daemon a supported configuration.

The authenticated folder picker can browse local directories before a project is
attached. Its paths are not restricted to a single workspace root. Git discovery
also reads Git metadata, including linked-worktree metadata outside the selected
working tree. The API token grants control of these local-machine operations.

Reports that describe LoopTroop running commands or modifying repositories you
attached to it are describing intended behaviour. Reports that describe a way to
bypass authentication, escape ticket-artifact containment, escalate beyond the
local user, or execute commands without user action are vulnerabilities.

### Known limit: the loopback cookie jar

A browser session is held in a cookie, and cookies are scoped by host, never by
port. Every service on `127.0.0.1` therefore shares one cookie jar, which is a
property of the platform rather than of this daemon. LoopTroop refuses that
cookie on any request the browser does not vouch for as same-origin, which is
what stops another local page from driving the API through your browser. It
cannot stop a program already running as you from reading the cookie out of the
browser's store and replaying it by hand. Such a program can forge every header
a server could check, and it could equally read the API token from the state
file. Anything running as your user is inside the boundary.

Binding to a secret `*.localhost` hostname would close the remaining gap, by
scoping the cookie to a name no other local service knows. It is deliberately
not done: the residual risk is code already running as your user, which no
same-host mechanism can exclude, and the hostname costs a URL people have to
trust and a DNS path that corporate resolvers interfere with. This is a
reviewed position rather than an oversight.

### Filesystem containment

Ticket artifact access validates canonical paths from the attached project
through its worktree and ticket directory. Ordinary internal links remain
supported; Manual QA evidence rejects links. Ticket-relative filenames reject
colons, including NTFS alternate-stream syntax. Cleanup unlinks final aliases and
refuses redirected managed roots so it cannot delete their destinations.
Worktree initialization also refuses these redirects before creating files.

These checks are not an operating-system sandbox. Node has no portable
directory-relative open/rename API, and another process running as the local
user can still replace an ancestor between validation and a filesystem call.
Verified file descriptors and repeated containment checks narrow that race.
The AI agent's own command execution retains the local user's permissions.

Generated runtime launchers validate shell environment names and encode or quote
values as literal data. Shell-specific inputs that cannot be represented safely
are rejected before the launcher is written.

Recovery checks the temporary path against the validated source descriptor
before each hard-link attempt and verifies the published target afterward.
A mismatch before linking leaves the target uncreated. A mismatched published
target remains untouched because another writer may have replaced it; recovery
also keeps the temporary source for inspection. The check-to-link race remains
subject to the local-process limitation above.

Ordinary draft creation rolls back its database row if artifact materialization
fails. Files already written are not part of the database transaction and may
remain after a later failure. Manual QA improvement-origin mappings remain
durable so retries can recover the same child ticket.

## Data Handling

LoopTroop collects no telemetry and sends no usage data anywhere.

Prompts and file contents are sent to whichever AI provider you configure in
OpenCode. LoopTroop does not store provider API keys: they live in OpenCode's
own configuration, and LoopTroop never reads them.

Ticket logs are written inside the repository being worked on, under
`.looptroop/`. Treat them as you would any other build artefact and avoid
committing them.

## Dependencies

`npm audit` runs on every push and pull request as a report. Fixes are applied
as reviewed changes rather than automatically, so an advisory never rewrites the
lockfile without a human deciding to.

Routine dependency updates are grouped and held behind a seven-day
release-maturity delay; security advisories shorten that delay to two days. The
full policy is documented in
[Operations Guide](https://www.looptroop.ovh/docs/operations#scheduled-dependency-updates).

### Install-script policy

Repository dependency installs require npm 12. The `allowScripts` policy in
`package.json` approves only the exact locked esbuild versions needed for its
binary setup, explicitly denies fsevents, and blocks other dependency install
scripts. Review the approvals and npm's policy before changing the npm major.
The root allowlist applies only to repository installs; global installs and npx
use separate contexts. CI bootstraps npm with lifecycle scripts disabled.

The Node Current lane keeps bundled npm within the reviewed major and otherwise
warns and installs the repository's declared npm version before dependencies.
Production container and standalone-bundle installs disable lifecycle scripts.

CodeMirror and Radix components inject runtime CSS, so the browser CSP permits
inline styles while restricting scripts to the same origin. Removing that style
permission requires nonce support in both HTML serving and the style consumers.

## Repository security checks

CI-only Bun, pnpm, Yarn and OpenCode installs use committed integrity lockfiles
with third-party lifecycle scripts disabled. The setup helper selects already
verified native binaries; live-feed tests still install LoopTroop from the feed
under test. Generated-input tests exercise network trust boundaries through
fast-check in the ordinary test suite.

Dependency Review checks pull requests for known vulnerabilities in runtime,
development, and unknown dependency scopes. The required Packaging check blocks
failed, cancelled, or skipped reviews on every CI event. Pull requests compare
their base and head commits. Pushes and manual runs compare the workflow commit
with the default branch, so a branch-push check cannot bypass the review.

Renovate manages dependency updates. CI runs its strict configuration validator
from the official container, pinned by version and image digest, with a read-only
repository mount. The prebuilt distribution avoids installing deprecated npm
dependencies during validation.

Standalone binaries use Node's native single-executable builder. Cross-platform
binary checks run before publication; the third-party Postject injector is no
longer used.

GitHub's CodeQL default setup scans the
application and workflows. OpenSSF Scorecard publishes repository security
results on pushes to main and weekly, using the workflow token to read rulesets.
The maintainer accepts the current lack of required independent human approvals
and an OpenSSF Best Practices badge. Per-alert evidence and dashboard decisions
remain in GitHub's code-scanning alerts and the associated pull requests.

Harden-Runner audits network activity in supported jobs that have read-only
permissions and no publishing credentials or protected environment. Audit mode
does not enforce an outbound allowlist. Publishing and other write-capable jobs,
jobs running inside containers, and whole job matrices containing Linux ARM64
are excluded. Harden-Runner starts through an action pre hook, which runs before
a step condition; excluding the whole matrix also leaves its other platforms
without runner auditing.

### Artifact integrity

Artifact downloads use the pinned official GitHub action in raw-download mode
and fail on a digest mismatch. Python's standard library extracts the verified
ZIPs and rejects paths that would escape the destination, including through an
existing symlink. This avoids the action's deprecated unzip dependency
([upstream issue #484](https://github.com/actions/download-artifact/issues/484))
while preserving artifact names, merged downloads and integrity checks.
Credentialed jobs keep extraction code inside the workflow; read-only jobs
share a local action. Python runs in isolated mode so repository files cannot
replace its standard-library imports.
