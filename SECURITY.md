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

Reports that describe LoopTroop running commands or modifying repositories you
attached to it are describing intended behaviour. Reports that describe a way to
escape those boundaries — reaching outside attached repositories, escalating
beyond the local user, or executing commands without user action — are
vulnerabilities.

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

Routine dependency updates are batched weekly with a maturity delay; security
advisories bypass that schedule. The full policy is documented in
[docs/operations.md](docs/operations.md#scheduled-dependency-updates).
