# Contributing to LoopTroop

Thanks for helping improve LoopTroop. Contributions, bug reports, documentation fixes, workflow feedback, and focused feature ideas are welcome.

LoopTroop is early alpha software. It is useful today, but reports that include clear context, exact steps, logs, and expected behavior are especially valuable.

## Project context

LoopTroop is a local GUI orchestrator for repo-scale AI coding work. It plans tickets with LLM councils, breaks work into beads, runs OpenCode in isolated Git worktrees, and keeps human approval gates around important transitions.

Because LoopTroop can run coding agents with broad local permissions, avoid sharing secrets or private repository content in public issues. When testing runtime behavior, use a disposable VM, sandboxed development environment, or a repository you are comfortable modifying.

Selected projects are trusted code, including their local Git configuration.
Preserve `core.sshCommand` for custom SSH setups; do not describe remote Git
checks as sandboxed or assume a repository-local wrapper is inert metadata.

## Ways to contribute

- Report bugs with steps to reproduce and relevant logs.
- Suggest workflow improvements for ticket planning, approvals, execution, retries, or review.
- Improve documentation when behavior is unclear or has drifted from the implementation.
- Submit focused pull requests that fix one problem or add one clearly scoped improvement.

## Local setup

```bash
git clone https://github.com/looptroop-ai/LoopTroop.git
cd LoopTroop
npm install
npm run dev
```

Open `http://localhost:5173` after the dev server starts.

Running the stack over a tunnel or a remote link? The dev server sends every
source file as a separate request, and each one pays the round trip. Serve the
built bundle instead:

```bash
LOOPTROOP_DEV_FRONTEND=preview npm run dev
```

Same URL, same backend, same ports — but the frontend is built once and served
as a bundle. Hot reload is the trade: code changes need a restart. Use it when
you are running LoopTroop rather than developing it; leave it unset otherwise.

Useful commands:

```bash
npm run lint
npm run typecheck
npm run test
```

`typecheck` runs two projects: the application (`tsconfig.json`) and the root
`tests/` directory (`tsconfig.tests.json`). They are separate so that adding a
test cannot change the compiler settings the application is checked under. A
test that imports one of the plain-ESM scripts under `scripts/` reads its types
from the `.d.mts` file beside it; keep the two in step.

For code changes, run the relevant linting, typechecking, and tests for the area you touched.

Changes to CLI or process behavior also belong in the website's CLI and
operations docs. Keep process-safety notes explicit about identity checks,
forceful Windows termination, and platform limits; do not promise lifecycle
behavior that was not verified.
For workflow recovery documentation, distinguish a local cancellation request
from confirmed remote stopping. Keep unconfirmed session ownership visible and
retryable, and say that restart recovery needs the project database or its
session-ownership marker, `runtime/opencode-pending-sessions.json`. That marker
contains the durable session IDs; cancellation's separate private runtime marker is
`.ticket/runtime/cancellation-pending.json`: it is written before cleanup,
treated as pending when malformed or unreadable, and removed only after
terminal cleanup through the contained ticket-file helper. It records a stop
request but does not identify or recover a remote session. If both storage
layers are unavailable, only the current process guard remains. Interview
examples must include a positive `batchNumber` and
explain that missing or invalid values fail schema validation while valid stale
values are rejected before mutation. Automatic bead-response continuation
within each bead iteration is bounded by a finite `maxIterations`; `0` means
unlimited for that path. User-facing Continue across workflow phases is
separate.

## Documentation and changelog

Keep documentation updated with behavior changes. Published documentation lives in the public [LoopTroop-Website repository](https://github.com/looptroop-ai/LoopTroop-Website), while the canonical application changelog lives in `CHANGELOG.md`.

For user-visible changes, add a concise entry under `## Unreleased` in `CHANGELOG.md`. Use the existing Summary and Detailed Changes structure. Documentation changes should be submitted to the website repository as a companion update when relevant.

When reporting interrupted writes, startup recovery, or Manual QA evidence issues, keep the diagnostic and owning artifact paths, and preserve the relevant `.proof`, `.recovery`, `.recovery.write-*`, retained `.remove-*`, or SQLite lock sidecars until their role is known. An orphan YAML or whole-file JSONL temp without a matching proof, including an empty JSONL temp, is warned about and left unpromoted; only an in-progress fallback whose `.recovery` ownership or completeness cannot be verified raises `RECOVERY_BLOCKED` and stops startup. The persistent SQLite lock database is outside transient cleanup, while selected runtime/temp roots and explicit worktree deletion have their own removal scope.

OpenCode step-cap conflicts preserve the edited root config and restore
sidecar, refusing only a destructive reset that would overwrite them; a later
bead may continue without a fresh cap when no reset is needed, with valid marker
evidence excluding the root config from delivery. Protected Git-hook validation
uses an identity-bound marker; invalid or escaped markers fail before recovery
writes, and unknown untracked additions remain until attribution is resolved.
Do not claim native-platform or lifecycle verification beyond the evidence for
the change.

**When a release changes an install path, a command, a flag or a channel, the website repository ships in the same batch.** The published documentation lives in `looptroop-ai/LoopTroop-Website`, so nothing in this repository's CI can notice when it falls behind — and it did, for four releases, while every page still opened with `git clone` and `npm run dev`. Two automated guards now catch part of it (`verify:site` requires Getting Started to lead with an install command, and `sync:cli --check` fails when the CLI reference drifts from `USAGE`), but neither knows about a new channel or a changed flag. This repository now also exposes `node scripts/docs-install-catalog.mjs`, which prints the published-smoke install table as JSON so the website can verify its consolidated installation docs against the channels and commands this repository actually ships. Bumping `CLI_SOURCE_REF` in the website's `scripts/sync-cli-reference.mjs` to the new tag, and re-running `npm run sync:cli`, is part of shipping a release.

If website CI must verify that catalog before a release tag exists, use an
immutable app commit that contains the catalog, check out that same ref in the
website job, and fail closed when the catalog is missing. Do not replace the
source pin with a branch or silently fall back to a reduced catalog.

Release jobs verify the npm tarball, the matching `package-lock.json`, the
managed-channel bundle, installer scripts, binaries, and checksums as one
manifest. Container builds install the released tarball with its lockfile using
`npm ci --ignore-scripts --omit=dev`; the finished multi-architecture index is
attested and each image records its installed package versions. Registry fetches
use three retries bounded to 10 to 60 seconds. Dependency and build jobs that do
not publish lack attestation and OIDC permissions; the container build-and-push
job retains the release environment, `packages: write` permission and registry
login needed to publish images. Finished-index attestation runs in a separate
download-only job. Git and package-feed credentials are scoped to the single
invocation that needs them. Release scripts reject unknown flags and positional
arguments, while published smoke checks read `doctor --json`'s structured
`checks[].install.channel` and `checks[].install.upgradeCommand` fields instead
of display prose.

Standalone binary jobs use Node `v26.9.0`'s native `--build-sea` builder. This is
an embedded-runtime pin only. Application, package and container jobs run the
toolchain pin in `.nvmrc`, which sits above the `engines.node` floor users are
held to. Workflows read it with `node-version-file: .nvmrc` rather than typing
the number, so changing `.nvmrc` moves every one of them; only the Dockerfile's
two `FROM node:` lines repeat it. If that embedded runtime changes, review Node's release
schedule and security maintenance separately, and preserve the CommonJS asset
bundle, disabled code cache and disabled snapshot settings across all four
binary target lanes.

Renovate (`.github/renovate.json`) opens every dependency update as a pull
request, and none of them merges itself: a person, or an agent acting for one,
reviews and merges each. Updates below a major arrive in a few grouped pull
requests: what ships to users (runtime dependencies and the frontend Vite
bundles), dev tooling, CI actions with container base-image digests, and CI
tools. Bun, pnpm, Yarn and the two OpenCode test lanes share the CI-tools group
for patch and minor updates; their major updates stay separate per package.
Yarn stays on Classic, and each OpenCode lane stays on its tested major. The
weekly lockfile refresh covers the root lockfile and all five CI-tool lockfiles
in one pull request.

Pull requests that need a hand edit or move together stay on their own: esbuild,
Drizzle, the OpenCode SDK, the toolchain (`.nvmrc`, `packageManager` and the
Dockerfile base), the Node floor, the weekly lockfile refresh and security
fixes. A major arrives alone unless its packages have to move together: React
with react-dom and their types, Vite with its React plugin, the Drizzle pair,
Tailwind with its Vite plugin, node with npm, and the families Renovate's
built-in presets keep together (CodeMirror, Radix, ESLint, and the upload and
download artifact actions). At most ten are open at once, and security fixes
open even past that.

CI tools use exact-pinned manifests and integrity lockfiles, with package
lifecycle scripts disabled. The setup helper places verified native binaries
on the normal PATH and checks that they run. Windows Bun uses its native
binary directory; OpenCode retains its npm shim so the Windows tests exercise
that launcher. CI does not add trusted-executable directory overrides.

The production container uses the npm bundled in its digest-pinned Node image.
The root `packageManager` pin declares the npm toolchain for repository
dependency installs, and `scripts/pin-npm.mjs` enforces its reviewed policy in
CI. The container install uses the release lockfile with lifecycle scripts
disabled, so it does not download a second npm version.

`main` requires a branch to be up to date, so merging one Renovate pull request
leaves the others behind. Renovate rebases them itself in its nightly window.
To have one sooner, tick the rebase box in its description. Do not press
GitHub's *Update branch*: that commit is yours, not Renovate's, and Renovate
stops maintaining a branch someone else has committed to.

Renovate raises `engines.node` on its own, to the newest Node release that has
been out for 90 days within the same major. Everything but the merge happens
without you.
`.github/workflows/renovate-node-floor.yml` writes the new floor into every file
that states it. Any pull request that changes the floor, Renovate's or yours,
fails the required Verify check until
[winget](https://github.com/microsoft/winget-pkgs/tree/master/manifests/o/OpenJS/NodeJS/LTS),
[Chocolatey](https://community.chocolatey.org/packages/nodejs-lts),
[Scoop](https://github.com/ScoopInstaller/Main/blob/master/bucket/nodejs-lts.json)
and [Homebrew](https://formulae.brew.sh/formula/node@24) all offer the new
version, because winget can trail a Node release by weeks and a floor above it
breaks the Windows install instructions. The same workflow re-runs whatever
failed on Renovate's pull request once a day, or, once a run is too old for
GitHub to re-run, ticks the pull request's rebase box so every check starts
afresh, so it is green by the time you look. Merging it is yours, like every
other Renovate pull request. It gets no changelog line, like any other non-major
update. Within a day of the merge, the website's *Follow LoopTroop main*
workflow writes the new floor into its pages and publishes them.

A new major is never raised automatically, because moving to one drops every
user still on the previous line. Do it by hand: change `engines.node`, then run

```bash
node scripts/sync-node-floor.ts
node scripts/check-node-feeds.ts
```

The website follows the new number on its own, but not sentences that name the
old major in words, so read its pages for those.

The floor cannot go below the oldest Node the npm in `packageManager` supports,
because the declared-floor test lanes install dependencies on it.

## Issues

Before opening an issue, please check whether a similar issue already exists.

For bug reports, include:

- What you were trying to do.
- What happened.
- What you expected to happen.
- Steps to reproduce the problem.
- Your OS, Node.js version, browser, and OpenCode/provider context when relevant.
- Relevant logs or screenshots, with secrets removed.

For feature requests, describe the problem first, then the change you think would help.

## Pull requests

Keep pull requests focused and easy to review. A good pull request usually includes:

- A short summary of what changed.
- Why the change is needed.
- Notes about affected workflow areas.
- Tests or checks you ran.
- Documentation and changelog updates when relevant.

Avoid mixing unrelated refactors with behavior changes. If a change affects ticket statuses, artifacts, parsers, prompts, or workflow transitions, explain the impact clearly in the pull request.
