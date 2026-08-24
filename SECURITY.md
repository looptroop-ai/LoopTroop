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

Reports that describe LoopTroop running commands or modifying repositories you
attached to it are describing intended behaviour. Reports that describe a way to
escape those boundaries — reaching outside attached repositories, escalating
beyond the local user, or executing commands without user action — are
vulnerabilities.

### Known limit: the loopback cookie jar

A browser session is held in a cookie, and cookies are scoped by host, never by
port. Every service on `127.0.0.1` therefore shares one cookie jar, which is a
property of the platform rather than of this daemon. LoopTroop refuses that
cookie on any request the browser does not vouch for as same-origin, which is
what stops another local page from driving the API through your browser. It
cannot stop a program already running as you from reading the cookie out of the
browser's store and replaying it by hand — such a program can forge every header
a server could check, and it could equally read the API token from the state
file. Anything running as your user is inside the boundary.

Binding to a secret `*.localhost` hostname would close the remaining gap, by
scoping the cookie to a name no other local service knows. It is deliberately
not done: the residual risk is code already running as your user, which no
same-host mechanism can exclude, and the hostname costs a URL people have to
trust and a DNS path that corporate resolvers interfere with. This is a
reviewed position rather than an oversight.

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
