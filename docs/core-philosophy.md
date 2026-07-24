# Core Philosophy

> **TL;DR:** LoopTroop is a tool you run locally with a graphical interface that helps you create and edit applications using AI. It does this by employing modern AI engineering methodologies — context engineering, Ralph-style retry loops, LLM council planning, thorough upfront planning, Git worktree isolation, and more.

LoopTroop is opinionated about how AI coding systems should behave. The app trades speed and conversational convenience for controllability, recovery, and durable correctness.

## The Five Core Commitments

| Commitment | What it means in practice |
| --- | --- |
| Engineer context, do not accumulate it blindly | Context engineering is applied at every phase: each one assembles only the artifacts it is allowed to see, and never inherits chat history or useless context from previous phases. |
| Plan thoroughly before you build | Interview, PRD, and bead planning invest heavily in upfront planning using multi-model draft, vote, and refine, so execution starts from a rigorous spec rather than a guess. |
| Keep a human in the loop at irreversible boundaries | Interview, PRD, beads, and execution setup all have human approval gates, so you stay in control before every expensive or hard-to-reverse transition. |
| Retry with fresh state, not with stale chat memory | Bead execution uses bounded Ralph-style retry loops with fresh context + notes from failures |
| Let a council decide, not a single model | An LLM Council scores anonymized drafts, then refines the winner with the best ideas from the losing drafts to reduce single-model bias |

The fifteen sections below describe each idea behind LoopTroop in detail. Every section opens with a one-paragraph summary, then explains the idea and how it shows up in the real system.

## 1. A Local, Fully Open-Source App

**Summary:** LoopTroop is a local, fully open-source AI coding orchestrator. It runs on your own machine, attaches to your local Git repositories, and gives you control over models, artifacts, logs, execution, and the final code changes.

LoopTroop is released under the MIT license and runs entirely on your machine: a local backend, a local frontend, and a local SQLite database. It does not route your repository through a hosted black box. You attach a project by pointing it at a folder on disk (the project record stores a local `folder_path`), and all planning artifacts, logs, and code changes live locally where you can inspect them.

It is designed for developers who want more control than a single cloud chat or a black-box coding agent can offer. You decide which models run, you can read every intermediate artifact, and you own the resulting diff before anything is merged.

**Read more:** [Getting Started](getting-started.md).

## 2. A Modern GUI Interface

**Summary:** LoopTroop is meant to be used through a modern GUI, not as an invisible background agent. It gives you a Kanban-style workflow for projects and tickets, with easy navigation between phases, artifacts, logs, diffs, configuration, model selection, council output, bead status, execution progress, errors, and final review.

The primary product experience is the graphical interface. A Kanban board organizes projects and tickets across lifecycle columns, and dedicated views let you move between phase artifacts, structured logs, code diffs, council output, bead status and approval, execution progress, configuration, model selection, and final review. Nothing important happens off-screen; the workflow is built to be watched and steered.

There is also a local backend API and a set of development scripts, so automation and integration are possible. But the GUI is the main way you are expected to drive and observe the system, precisely because the goal is transparency rather than hidden automation.

**Read more:** [Frontend](frontend.md), and the [Kanban Board](frontend.md#_12-kanban-board) and [Key Workspace Views](frontend.md#_4-key-workspace-views) sections.

## 3. End-To-End Ticket Orchestration

**Summary:** LoopTroop treats AI coding as a full ticket lifecycle, not a single prompt. A ticket moves through repository scan, interactive interview, PRD generation, bead planning, execution setup, bead-by-bead implementation, Ralph-style recovery when needed, final verification, and PR creation and review — all followed from one place.

A ticket is a state machine, not a chat thread. It progresses linearly through clearly named stages:

1. **Repository scan** — identify the files relevant to the ticket.
2. **Interactive interview** — multi-model question generation, then your answers, then a coverage check.
3. **PRD generation** — draft, vote, refine, and verify a structured spec.
4. **Bead planning** — decompose the PRD into small units, then expand them.
5. **Execution setup** — a pre-flight check and an approved setup plan before the environment is mutated.
6. **Bead-by-bead implementation** — coding one bead at a time.
7. **Ralph-style recovery** — fresh-session retries when a bead fails (see §10).
8. **Final verification** — a final test pass over the integrated changes.
9. **PR creation and review** — open a pull request and wait for human review before cleanup.

Because the whole process is modeled explicitly, you can follow it from one place instead of losing state inside a long conversation, and the system can resume from storage rather than from a model's memory.

**Read more:** [Ticket Flow](ticket-flow.md), especially the [State Machine Transition Model](ticket-flow.md#_3-state-machine-transition-model) and [Phase Inventory](ticket-flow.md#_5-phase-inventory).

## 4. An AI Orchestrator For Projects And Tickets

**Summary:** LoopTroop is an orchestration layer around AI coding agents. You attach repositories, create tickets, configure models, review generated planning artifacts, approve execution, inspect logs, and follow implementation progress without leaving the app.

The value is not only "AI writes code." The value is that the whole coding workflow becomes structured, inspectable, restartable, and reviewable. Projects (attached repositories), tickets, phase artifacts, execution attempts, model sessions, and errors are all first-class records. Configuration — including which model is the main implementer and which models form the council — is attached to projects and tickets, so each piece of work runs under a known, auditable setup.

This is the difference between a coding assistant and a coding *orchestrator*: LoopTroop manages the lifecycle, the artifacts, and the recovery, not just the next message.

**Read more:** [System Architecture](system-architecture.md), especially [Runtime Actors](system-architecture.md#_2-runtime-actors) and [Authoritative Data Ownership](system-architecture.md#_3-authoritative-data-ownership).

## 5. Context Engineering

**Summary:** LoopTroop fights context rot by avoiding one huge, growing conversation. Instead of constantly appending history, it stores durable artifacts outside the model and rebuilds minimal context for each phase. During implementation, the model focuses on the active bead and compact retry notes, not the entire previous workflow.

Long-context models are useful, but they are still vulnerable to positional bias and long-run context drift. Performance can drop severely well before the maximum context window is reached — excessive conversational history and irrelevant files overwhelm the model, leading to missing files, broken imports, and "AI slop." LoopTroop treats this as a systems problem, not as a prompt-wording problem.

That leads to three hard rules:

1. Phase prompts are built from durable artifacts, not from inherited chat history.
2. A phase only sees the context keys it is explicitly allowed to see.
3. When a retry is needed, LoopTroop prefers a fresh session plus a compact post-mortem over continuing a polluted transcript.

This keeps the agent focused and reduces drift during long-running tasks.

**Read more:** [Context Engineering](context-engineering.md) for the design model, status matrix, and implementation allowlists.

## 6. LLM Council Planning

**Summary:** LoopTroop uses an LLM Council for the major planning phases — interview, PRD, and beads. Multiple configured models draft independently; their outputs are compared, scored, and voted on; the winning result is refined by incorporating the strongest ideas from the losing drafts, then checked for coverage before moving forward. This reduces single-model bias and makes planning more robust.

The council runs as a constrained pipeline, not a free-form model group chat:

1. **Independent drafts** from multiple models, generated in parallel.
2. A **quorum check** so the system does not proceed on too few valid drafts.
3. **Structured voting** over anonymized drafts, scored against an explicit rubric (coverage, correctness/feasibility, testability, decomposition, and risks/edge cases).
4. **Winner selection** from the votes.
5. **Refinement** by the winner, which folds in the strongest ideas from the losing drafts.
6. **Coverage verification** before the phase is allowed to advance.

Early planning quality dominates downstream execution quality, so the council is deliberately applied at the three planning phases — interview, PRD, and beads — where a single model's blind spots would be most costly.

`LLM council` is a useful current label, not a universal standard term. In LoopTroop it specifically means this draft-vote-refine pipeline, not any arbitrary multi-agent conversation.

**Read more:** [LLM Council](llm-council.md), and the per-phase pages it feeds — [Interview](interview.md), [PRD](prd.md), and [Beads & Execution](beads.md).

## 7. Interview Before Spec

**Summary:** Before writing the PRD, LoopTroop asks targeted questions to resolve ambiguity. The interview clarifies requirements, intent, edge cases, constraints, and design choices, so the final implementation matches what you actually wanted instead of guessing from an incomplete ticket.

The interview phase generates questions whose job is to remove meaningful ambiguity — establishing intent, target user, core value, constraints and non-goals first, then going feature-by-feature into behavior, edge cases, acceptance criteria, test intent, and dependencies. The question budget is treated as a hard upper bound, never a target: the system asks only as many questions as are genuinely needed, and a coverage check can surface follow-ups if gaps remain.

You answer in the GUI, and only an approved interview proceeds to PRD generation. This is where the system buys down the risk of building the wrong thing.

**Read more:** [Interview](interview.md), especially [How Questions Are Designed](interview.md#_3-how-questions-are-designed) and [Skips, Final Free-Form, And Coverage](interview.md#_6-skips-final-free-form-and-coverage).

## 8. PRD As Source Of Truth

**Summary:** After the interview, LoopTroop turns the ticket and your answers into a structured PRD. The PRD captures scope, user stories, technical direction, edge cases, validation expectations, and implementation intent. It becomes the planning contract used to generate beads and guide execution.

The PRD is a structured document, not prose: it records what is in and out of scope, organizes work into epics and user stories, attaches acceptance criteria and verification to each story, and captures technical direction and constraints. It is produced through the council pipeline (draft → vote → refine → coverage check) so the contract itself is reviewed before it is trusted.

Everything downstream — bead decomposition and execution — references this PRD. It is the single agreed statement of what the ticket means, which is why it gets its own approval gate.

**Read more:** [PRD](prd.md), especially [What The PRD Contains](prd.md#_5-what-the-prd-contains) and [Approval, Editing, And Downstream Impact](prd.md#_7-approval-editing-and-downstream-impact).

## 9. Beads: Small Implementation Units

**Summary:** LoopTroop decomposes complex plans into beads. A bead is a small, independently implementable coding task with a clear objective, target files, dependencies, acceptance criteria, validation steps, and test commands. Instead of asking the AI to solve a whole feature in one giant pass, LoopTroop makes it work on focused units one by one.

A bead carries everything a single focused coding attempt needs: an id and title, a description and objective, PRD references, context guidance (patterns and anti-patterns), acceptance criteria, target files, dependencies (`blocked_by` / `blocks`), tests, and test commands. Beads are decomposed from the approved PRD and then expanded with execution metadata such as priority, labels, status, and a `beadStartCommit` snapshot used for clean retries.

Beads are both the execution plan and the execution memory layer:

- small enough to execute in focused context
- rich enough to encode acceptance criteria, tests, files, and dependencies
- durable enough to survive retries, restarts, and review

They define what gets worked on next, what blocks what, and exactly what context each coding attempt needs.

**Read more:** [Beads & Execution](beads.md), especially [What An Approved Bead Contains](beads.md#_2-what-an-approved-bead-contains).

## 10. Ralph Loop Recovery

**Summary:** The Ralph Loop is LoopTroop's recovery mechanism for failed bead execution. If a bead fails or times out, LoopTroop does not keep pushing the same polluted session. It writes a compact note about what went wrong, resets the worktree back to the bead start snapshot when possible, starts a fresh execution session, and retries with clean context plus the useful failure note.

Execution work fails in two broad ways: the model produces the wrong code, or the model gets stuck in a bad loop while carrying broken context forward. LoopTroop addresses the second case with a bounded, Ralph-style retry discipline:

1. Capture what failed in a compact **context-wipe note**.
2. **Reset the worktree** back to the bead start commit (`beadStartCommit`).
3. Start a **fresh session** with the bead spec plus the wipe note.
4. **Stop after the configured retry limit** (`maxIterations`).

This connects directly to the context-engineering philosophy: preserve the lesson, discard the context pollution. It keeps the learning signal while throwing away the poisoned conversational state.

`Ralph-style retry` is a current community term rather than a formal standard. LoopTroop uses it narrowly: fresh-session retry with preserved failure context, not unlimited unattended looping.

**Read more:** [Beads & Execution](beads.md), especially [Retry, Reset, And Context-Wipe Notes](beads.md#_9-retry-reset-and-context-wipe-notes), and the [Recovery Flow](system-architecture.md#_7-recovery-flow) in System Architecture.

## 11. OpenCode Execution Engine

**Summary:** LoopTroop uses OpenCode as the execution layer for model sessions, file edits, terminal commands, coding, verification, and PR work. The main implementer model handles scanning, implementation, final checks, and PR creation, while council models are used for planning and review. LoopTroop can use the models exposed by your configured OpenCode providers, so different models can serve as the main implementer and the council.

LoopTroop runs an OpenCode server (`opencode serve`) and talks to it through the OpenCode SDK adapter. Because it drives your own OpenCode installation, it can use the providers and models your OpenCode is configured with — and it also inherits the skills, MCP servers, and any other configuration you have set up in OpenCode. The main implementer and the council are configured separately (`main_implementer` versus `council_members`), so you can pair a strong implementer model with a diverse planning council.

For long-running automation, OpenCode may run with permissive local execution permissions (an allow-all execution policy). That is powerful, but it also means you should run LoopTroop in a VM or a sandboxed development environment.

**Read more:** [OpenCode Integration](opencode-integration.md), especially [OpenCode Configuration Pass-Through](opencode-integration.md#_4-opencode-configuration-pass-through) and [Health And Model Discovery](opencode-integration.md#_10-health-and-model-discovery).

## 12. Git Worktree Isolation

**Summary:** LoopTroop runs implementation work inside isolated Git worktrees. This keeps AI-generated changes away from your active checkout, makes diffs easier to inspect, and allows cleaner retries. Worktrees protect the repository workflow, but they are not a machine-level security sandbox.

LoopTroop treats isolation as a correctness boundary, not just a convenience. It uses `git worktree` as the main execution primitive so the coding agent works inside a ticket-owned workspace rather than your main checkout. Fresh worktrees make it possible to:

- keep your attached project checkout out of the execution blast radius
- reset a bead back to a known snapshot during retry
- preserve inspectable ticket artifacts beside the isolated code changes
- clean up temporary runtime state without confusing it with your normal working directory

At the host layer, unattended AI execution is safer in a disposable VM, container, cloud dev machine, or similarly sandboxed environment. Worktrees protect the repo boundary; they do not replace process isolation, filesystem policy, or host-level blast-radius reduction. If an agent can run commands for hours, the safer default is to give it a safe host to operate in.

**Read more:** [Authoritative Data Ownership](system-architecture.md#_3-authoritative-data-ownership) and [Execution Isolation](context-engineering.md#_11-execution-isolation), plus Git's official [`git worktree`](https://git-scm.com/docs/git-worktree.html) documentation.

## 13. Slow Planning To Avoid AI Slop

**Summary:** LoopTroop is intentionally not optimized for instant answers. The planning phase can be slow because the goal is correctness, alignment, and traceability. It is built for complex, multi-file tasks where a rushed one-shot answer would likely miss details or produce low-quality code.

The idea is simple: plan carefully, execute narrowly, recover cleanly, and review before shipping. Councils, coverage checks, and approval gates all cost time on purpose, because the failure mode LoopTroop is built to avoid is confidently wrong, half-finished, slop-filled output on a large task. For one-shot trivial edits this overhead will feel slow, and that is the expected trade-off (see §14 for what LoopTroop is *not* for).

**Read more:** [What This Prevents](context-engineering.md#_12-what-this-prevents) in Context Engineering.

## 14. Human-In-The-Loop Delivery

**Summary:** LoopTroop keeps you in control at important boundaries. You can review and approve the interview, PRD, bead plan, and execution setup, and you inspect diffs, logs, test results, the final implementation, and the PR output. The result is not hidden automation — it is a transparent, auditable ticket lifecycle from raw requirement to reviewable pull request.

Explicit approval gates sit before the most expensive and hardest-to-reverse transitions:

- approve the interview before PRD generation
- approve the PRD before bead planning
- approve the beads before execution
- approve the execution setup plan before environment mutation and coding
- review the pull request before cleanup completes

This keeps the system honest. The model is allowed to move quickly inside a phase, but you decide when the pipeline is good enough to cross into the next expensive stage, and the final result is always a reviewable diff and PR rather than a silent merge.

**Read more:** [Pre-Implementation](pre-implementation.md) for the setup-plan approval gate and [Post-Implementation](post-implementation.md#_5-waiting-pr-review-human-merge-or-finish-gate) for the PR review gate.

## 15. Manual QA Verification

**Summary:** LoopTroop offers an optional Manual QA checkpoint after final tests pass. Instead of assuming automated tests are enough, it generates a human-facing verification checklist from the approved PRD and bead work, hands it to you to run the application and record results, and turns any failures into AI-planned QA-fix beads that re-enter the coding loop. Non-blocking observations become improvement tickets in the backlog.

Automated tests catch regressions, but they cannot verify that the application actually feels right to a human user — layout, interaction flow, visual correctness, and real-world behavior often need a person at the screen. Manual QA fills that gap as a structured, auditable checkpoint rather than an ad-hoc "try it and see" step:

1. **Checklist generation** — after final tests pass, LoopTroop assembles a versioned checklist from the approved PRD, bead metadata, and final-test report, with advisory PRD coverage states (covered, partially covered, uncovered, not applicable).
2. **Human verification** — you run the application yourself, mark each item as Pass, Fail, or Waive, attach optional evidence (screenshots, files, links), and record observations for any failures.
3. **Failure → fix beads** — submitted failures are grouped and fed to the main implementer, which plans full QA-fix beads that re-enter the standard coding pipeline, followed by a fresh final-test attempt and a new checklist version.
4. **Improvements → backlog** — non-blocking observations can be turned into prioritized improvement tickets in the same project, keeping the current ticket unblocked while capturing the insight.
5. **Versioned rounds** — each QA round is recorded with timestamps, outcomes, evidence references, and created work, so the full verification history is inspectable and resumable.

Manual QA is configured per profile, project, or ticket and locked when the ticket starts, so the pipeline behavior is known and auditable from the beginning. When disabled, tickets proceed directly from final tests to integration.

**Read more:** [Post-Implementation](post-implementation.md#_15-optional-manual-qa-route) for the full Manual QA route and [Beads & Execution](beads.md#manual-qa-fix-beads) for QA-fix bead details.

## Why LoopTroop Over Direct Agent Loops?

Direct coding-agent loops are highly useful, but they degrade rapidly when task complexity or repository scale increases. The fifteen ideas above add up to a set of structural fixes:

| Core Challenge | Direct Agent Behavior | LoopTroop's Structural Fix |
| :--- | :--- | :--- |
| **Flawed Planning** | A single model attempts to draft a multi-step plan in one pass, frequently missing structural edge cases. | **LLM Council Consensus:** Competing models draft, vote on, and synthesize a single, rigorous implementation plan. |
| **Monolithic Overload** | Direct agents try to solve a complex feature in a single massive prompt, leaving incomplete files or "TODO" placeholders. | **Atomic Bead Decomposition:** Automatically breaks the feature into independent, test-backed "beads" to focus on the smallest change at a time. |
| **Single-Provider Bias** | Relying on one model makes your pipeline highly vulnerable to that model's logical blind spots and systemic failures. | **Cross-Model Councils:** Harnesses diverse providers and architectures to critique and align planning drafts. |
| **Context Rot** | Long-running chats suffer from token bloat and context degradation, leading to broken imports or forgotten criteria. | **Modern Context Engineering:** The environment strictly isolates context, feeding the agent only the minimum it needs at each step. |
| **Degenerate Retries** | When a command fails, the agent tries to fix it within the same polluted chat session, compounding previous errors. | **Ralph-Style Retries:** Discards the broken chat session entirely and retries the exact bead with a fresh context window plus notes from previous failures. |
| **Risky Edits** | Code modifications are made directly in your active checkout, potentially leaving your main branch in an unstable state. | **Isolated Git Worktrees:** Executes all changes in dedicated, isolated worktrees away from your primary working branch. |
| **Opaque Execution** | Internal states, planning notes, and test outputs are lost inside unstructured chat history. | **Structured Durability:** Maintains state locally inside SQLite, JSONL logs, and easily inspectable `.ticket/**` YAML artifacts. |

## Related Docs

- [Ticket Flow](ticket-flow.md)
- [System Architecture](system-architecture.md)
- [Context Engineering](context-engineering.md)
- [LLM Council](llm-council.md)
- [Beads & Execution](beads.md)
