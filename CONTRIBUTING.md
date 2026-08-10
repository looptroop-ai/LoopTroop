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

Useful commands:

```bash
npm run lint
npm run typecheck
npm run test
```

For code changes, run the relevant linting, typechecking, and tests for the area you touched.

## Documentation and changelog

Keep documentation updated with behavior changes. Published documentation lives in the public [LoopTroop-Website repository](https://github.com/looptroop-ai/LoopTroop-Website), while the canonical application changelog lives in `CHANGELOG.md`.

For user-visible changes, add a concise entry under `## Unreleased` in `CHANGELOG.md`. Use the existing Summary and Detailed Changes structure. Documentation changes should be submitted to the website repository as a companion update when relevant.

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
