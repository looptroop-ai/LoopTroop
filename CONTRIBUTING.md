# Contributing to LoopTroop

Thanks for helping improve LoopTroop. Contributions, bug reports, documentation fixes, workflow feedback, and focused feature ideas are welcome.

LoopTroop is early alpha software. It is useful today, but reports that include clear context, exact steps, logs, and expected behavior are especially valuable.

## Project context

LoopTroop is a local GUI orchestrator for repo-scale AI coding work. It plans tickets with LLM councils, breaks work into beads, runs OpenCode in isolated Git worktrees, and keeps human approval gates around important transitions.

Because LoopTroop can run coding agents with broad local permissions, avoid sharing secrets or private repository content in public issues. When testing runtime behavior, use a disposable VM, sandboxed development environment, or a repository you are comfortable modifying.

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

Client changes should preserve three boundaries: a draft belongs to the ticket
and form that created it, a live-stream recovery belongs to the connection and
cursor generation that is still current, and confirmed deletion clears only
the deleted ticket's client state. Tests should cover hydration/refetch races,
late responses, failed saves, replay gaps, and reissued ticket identifiers
when those boundaries are involved. Keep full-history actions explicit rather
than mounting an unbounded archive during ordinary navigation.

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

**When a release changes an install path, a command, a flag or a channel, the website repository ships in the same batch.** The published documentation lives in `looptroop-ai/LoopTroop-Website`, so nothing in this repository's CI can notice when it falls behind — and it did, for four releases, while every page still opened with `git clone` and `npm run dev`. Two automated guards now catch part of it (`verify:site` requires Getting Started to lead with an install command, and `sync:cli --check` fails when the CLI reference drifts from `USAGE`), but neither knows about a new channel or a changed flag. This repository now also exposes `node scripts/docs-install-catalog.mjs`, which prints the published-smoke install table as JSON so the website can verify its consolidated installation docs against the channels and commands this repository actually ships. Bumping `CLI_SOURCE_REF` in the website's `scripts/sync-cli-reference.mjs` to the new tag, and re-running `npm run sync:cli`, is part of shipping a release.

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
