# Context Engineering

> [!IMPORTANT]
> **TL;DR** — Every single phase, every single status, and most retries use as input the smallest possible context derived from the previous status. LoopTroop almost **never** keeps the previous conversation history. This is a core principle of the project's design and implementation.

LoopTroop uses context engineering to keep model work focused. The engine does not treat an LLM session as the source of truth, and it does not keep appending every previous message to the next prompt. Each status rebuilds the smallest useful prompt from durable artifacts and the active task contract.

The implementation-level source of truth is `server/opencode/contextBuilder.ts`. The user-facing phase metadata is in `shared/workflowMeta.ts`. For a catalogue of built-in prompts and runtime prompt builders, see [Prompt Inventory](prompts.md).

## 1. Core Idea

Long-running AI work degrades when every phase inherits the full conversation:

- old failed attempts stay in the model's attention window
- unrelated planning details compete with the active task
- compacted chat summaries replace exact artifacts with lossy memory
- later retries can overfit to stale reasoning instead of the current requirement

LoopTroop avoids that by treating context as an explicit input contract. A status receives only the artifact slices it is allowed to use, plus any small task-specific section that the status appends itself.

## 2. Prompt Assembly Contract

Every model prompt follows the same broad pattern:

1. Load durable ticket state from SQLite, `.ticket/**`, phase artifacts, bead state, and runtime notes.
2. Pick the context allowlist for the active prompt type.
3. Build independent `PromptPart` slices, such as `ticket_details`, `prd`, `bead_data`, or `final_test_notes`.
4. Sort the slices so the primary ticket requirement stays visible first.
5. Trim lower-priority slices first if the token budget is exceeded.
6. Send only the assembled prompt for the active task.

This is why LoopTroop can show rich history in the UI without feeding that whole history back into every model call.

## 3. Implementation Contract

The core helper is `buildMinimalContext()`.

It accepts:

- a phase key such as `prd_vote`, `coding`, or `final_test`
- a `TicketState` snapshot assembled from durable artifacts

It returns ordered `PromptPart[]` slices after applying the allowlist, loading cacheable slices where appropriate, sorting by prompt priority, and trimming to the token budget if necessary.

## 4. TicketState Inputs

The current `TicketState` fields used by the context builder are:

```yaml
ticketState:
  ticketId: string
  title: string
  description: string
  relevantFiles: string
  interview: string
  fullAnswers: string[]
  prd: string
  beads: string
  beadsDraft: string
  drafts: string[]
  votes: string[]
  beadData: string
  beadNotes: string[]
  executionSetupProfile: string
  executionSetupPlan: string
  executionSetupPlanNotes: string[]
  executionSetupNotes: string[]
  finalTestNotes: string[]
  userAnswers: string
  tests: string
  errorContext: string
```

## 5. Context Keys

| Key | Meaning |
| --- | --- |
| `ticket_details` | The ticket title and description, formatted as the primary user requirement. |
| `relevant_files` | The relevant-file scan artifact. It gives later phases repo-grounded hints without dumping the full repository. |
| `drafts` | Current-stage council drafts, usually anonymized or labeled for voting/refinement. |
| `votes` | Structured vote artifacts when a status needs them explicitly. This is not broadly inherited. |
| `interview` | The approved or current interview artifact. |
| `full_answers` | Per-model completed interview answers used by PRD generation and PRD coverage. PRD coverage uses the winning model's Full Answers artifact. |
| `user_answers` | The collected user answers from the interview flow. |
| `prd` | The current PRD candidate or approved PRD. |
| `beads` | The current expanded bead plan or semantic implementation blueprint, depending on phase. |
| `beads_draft` | The refined semantic blueprint before it is expanded into execution-ready beads. |
| `bead_data` | The one active bead contract: description, acceptance criteria, file targets, dependencies, and test intent. |
| `bead_notes` | A coding-only grouping that emits three separate headed prompt parts: append-only Failed Iteration Notes, User Retry Notes, and Finalization Failure Notes. |
| `execution_setup_profile` | Reusable setup/tooling profile from earlier runtime preparation. |
| `execution_setup_plan` | The generated candidate in drafting history or the separately published, potentially user-edited approval copy. Runtime setup consumes only the approval copy. |
| `execution_setup_plan_notes` | Durable regeneration commentary and baseline context consumed by setup-plan drafting. |
| `execution_setup_notes` | Retry notes from failed runtime setup attempts. |
| `final_test_notes` | Retry notes from failed final-test attempts. |
| `tests` | Test/result material used by review surfaces where available. |
| `manual_qa_previous` | Latest prior checklist/results/summary slices used only to preserve lineage and identify affected rechecks. |
| `manual_qa_checklist` | The immutable active or selected checklist shown in Manual QA context/review surfaces. |
| `manual_qa_results` | Immutable item results created by Submit; skipped rounds use the archived draft, skip receipt, and summary instead. |
| `error_context` | A compact failure summary for recovery prompts, especially context-wipe and final-test retry-note generation. |

### Manual QA generation contract

Manual QA checklist generation uses a dedicated focused builder rather than inheriting the entire generic ticket state. It supplies the ticket title/description, frozen approved PRD, selected bead behavior and verification fields, the **current** final-test report, the latest previous checklist/results/coverage/summary, and targeted metadata spanning the complete merge-base-to-clean-checkpoint candidate range. Read-only focused diff inspection is permitted, but raw whole-repository dumps are prohibited. Coverage and source-category counts come from the same strict response and are computed in code—there is no second coverage model call. Later-round output must keep stable lineage for referenced prior items, retain every failed item as `pending_recheck`, and may mark only prior passes as `previously_passed`.

Checklist items receive app-assigned version IDs and stable cross-round `lineageId` values. A failed round archives its attempts; after normal fix-bead execution, generation receives a fresh final-test report instead of old round reports or retry notes.

For a `qa-fix` bead, typed `qaOrigin` is part of the narrow active-bead contract and stays separate from the three bead note histories. It contains the QA version/source items, observations, expected behavior, evidence references, locked model ID/image-capability result, and Manual-QA creation timestamp. If the locked model advertises image input, every detected image evidence file is added as an OpenCode SDK file part with no extra prompt-size cap; non-images remain references. Capability false/unavailable records `references_only`, while provider/context overflow follows normal bead error recovery and never silently drops images.

QA-fix planning uses its own focused builder during Manual QA Submit. It supplies all failed merge groups plus ticket details, approved PRD, existing beads, current final-test report, checklist/results, evidence references, and targeted diff metadata. At least one successful read-only repository inspection tool call is mandatory so the model can discover files outside the original bead targets. The model returns complete candidate bead content; LoopTroop owns identifiers and lifecycle fields and persists the validated batch before any child creation.

## 6. Current Phase Allowlists

The block below mirrors the current phase mapping in `server/opencode/contextBuilder.ts`.

```yaml
interview_draft:
  - relevant_files
  - ticket_details
interview_vote:
  - relevant_files
  - ticket_details
  - drafts
interview_refine:
  - relevant_files
  - ticket_details
  - drafts
interview_qa:
  - ticket_details
interview_coverage:
  - ticket_details
  - user_answers
  - interview
prd_draft:
  - relevant_files
  - ticket_details
  - interview
  - full_answers
prd_vote:
  - relevant_files
  - ticket_details
  - interview
  - drafts
prd_refine:
  - relevant_files
  - ticket_details
  - full_answers
  - drafts
prd_coverage:
  - full_answers
  - prd
beads_draft:
  - relevant_files
  - ticket_details
  - prd
beads_vote:
  - relevant_files
  - ticket_details
  - prd
  - drafts
beads_refine:
  - relevant_files
  - ticket_details
  - prd
  - drafts
beads_expand:
  - relevant_files
  - ticket_details
  - prd
  - beads_draft
beads_coverage:
  - prd
  - beads
execution_setup_plan:
  - ticket_details
  - relevant_files
  - prd
  - beads
  - execution_setup_profile
  - execution_setup_plan_notes
execution_setup_plan_regenerate:
  - ticket_details
  - relevant_files
  - prd
  - beads
  - execution_setup_profile
  - execution_setup_plan
  - execution_setup_plan_notes
execution_setup:
  - ticket_details
  - beads
  - execution_setup_plan
  - execution_setup_notes
coding:
  - bead_data
  - bead_notes
context_wipe:
  - bead_data
  - error_context
final_test:
  - ticket_details
  - prd
  - beads
  - final_test_notes
pull_request:
  - ticket_details
  - prd
preflight:
  - ticket_details
```

Some statuses append small task-specific sections outside this reusable allowlist. For example, interview resume appends the current question/session state, PRD and beads voting append a rubric, coverage revision appends the concrete gaps for that pass, execution setup regeneration appends the current plan and user note, and pull-request creation appends narrow reports or diffs.

## 7. Status Context Matrix

The table below describes what the model receives during each status. "No model prompt" means the status is deterministic or waiting for a user action; the UI may still show artifacts for review.

| Status | Model context |
| --- | --- |
| `DRAFT` | No model prompt. The saved title and description become future `ticket_details`. |
| `SCANNING_RELEVANT_FILES` | `ticket_details`. The scan may inspect the repository through tools, but the inline prompt does not receive a full source dump. |
| `COUNCIL_DELIBERATING` | `relevant_files`, `ticket_details`. Each council member drafts interview questions independently from the same bounded context and may use focused read-only inspection only when it needs to confirm a discoverable repository fact. |
| `COUNCIL_VOTING_INTERVIEW` | `relevant_files`, `ticket_details`, `drafts`. The drafts are the only prior model outputs brought into the vote. |
| `COMPILING_INTERVIEW` | `relevant_files`, `ticket_details`, `drafts`. The winner is normalized into the interactive interview and may use focused read-only inspection only when it needs to confirm a discoverable repository fact. |
| `WAITING_INTERVIEW_ANSWERS` | Usually no background model work while waiting for the user. When the interview assistant needs to continue or resume, it receives `ticket_details` plus the compiled question/session state appended explicitly by the interview flow; it may inspect a focused repository area only when confirmation affects the next batch or follow-up. |
| `VERIFYING_INTERVIEW_COVERAGE` | `ticket_details`, `user_answers`, `interview`. The model may use focused read-only inspection to confirm discoverable repository facts, but follow-up questions remain based on the current interview and collected answers. |
| `WAITING_INTERVIEW_APPROVAL` | No model prompt while waiting for approval. The user reviews the interview artifact. |
| `DRAFTING_PRD` | Split phase. Part 1 Full Answers receives `relevant_files`, `ticket_details`, `interview` plus a small runtime checklist; if no skipped answers need filling, Full Answers can be synthesized without a model call. It may use focused read-only inspection only to confirm a technical fact needed for a skipped answer. Part 2 PRD drafts receive `relevant_files`, `ticket_details`, and that member's `full_answers`; they may use focused read-only repository inspection only when this context cannot support a concrete repository-specific claim. |
| `COUNCIL_VOTING_PRD` | `relevant_files`, `ticket_details`, `interview`, `drafts`. The vote evaluates PRD drafts without inheriting Full Answers attempts or earlier chat history. |
| `REFINING_PRD` | `relevant_files`, `ticket_details`, labeled `full_answers`, and labeled `drafts` containing the winner and alternatives. Focused read-only inspection is available only when this context lacks concrete repository evidence. |
| `VERIFYING_PRD_COVERAGE` | Winning `full_answers` and current `prd`. Revision prompts append the specific coverage gaps they are fixing, not unrelated planning history. The audit and revision may use focused read-only inspection when they need to confirm a repository-specific claim. |
| `WAITING_PRD_APPROVAL` | No automatic model prompt while waiting for approval. If the user clicks `Fix gaps with AI`, one fresh targeted revision prompt receives the current PRD, winning Full Answers artifact, current remaining gaps, and previous extra-fix history, followed by one fresh PRD coverage check. |
| `DRAFTING_BEADS` | `relevant_files`, `ticket_details`, `prd`. Council members independently decompose the approved spec and may use focused read-only inspection only when this context lacks concrete repository evidence. |
| `COUNCIL_VOTING_BEADS` | `relevant_files`, `ticket_details`, `prd`, `drafts`, plus the voting rubric appended by the beads vote phase. |
| `REFINING_BEADS` | `relevant_files`, `ticket_details`, `prd`, `drafts`. The winner is strengthened with selected alternatives and may use focused read-only inspection only when concrete repository evidence is missing. |
| `VERIFYING_BEADS_COVERAGE` | Current `prd` and `beads`. Revision prompts append the specific coverage findings for the current pass. The audit and revision may use focused read-only inspection when they need to confirm a repository-specific claim. |
| `EXPANDING_BEADS` | `relevant_files`, `ticket_details`, `prd`, `beads_draft`. The model turns the refined blueprint into execution-ready bead records and may use focused read-only inspection only when supplied context cannot confirm an execution detail. |
| `WAITING_BEADS_APPROVAL` | No automatic model prompt while waiting for approval. If the user clicks `Fix gaps with AI`, one fresh targeted revision prompt receives the current semantic beads blueprint, approved PRD, current remaining gaps, and previous extra-fix history, followed by one fresh beads coverage check and expansion refresh when the blueprint changes. |
| `PRE_FLIGHT_CHECK` | No planning context is sent. The status performs deterministic readiness checks and a minimal connectivity probe rather than asking a model to reason over ticket artifacts. |
| `GENERATING_EXECUTION_SETUP_PLAN` | Initial drafting receives `ticket_details`, `relevant_files`, `prd`, `beads`, optional `execution_setup_profile`, and `execution_setup_plan_notes`. Regeneration also receives the durable current structured/raw baseline, user commentary, and any cleaned prior setup failure. The generated candidate and diagnostics remain attached to this drafting attempt. |
| `WAITING_EXECUTION_SETUP_APPROVAL` | No model prompt runs while approval is pending. The status receives a self-contained copy of the generated plan/report for review; edits change this approval copy without rewriting the original drafting artifact. |
| `PREPARING_EXECUTION_ENV` | `ticket_details`, `beads`, the approved `execution_setup_plan`, and `execution_setup_notes`. Setup retries get compact setup notes, not a replay of earlier setup sessions or the unedited drafting candidate. |
| `CODING` | `bead_data` plus `bead_notes`, which expands into separately headed Failed Iteration Notes, User Retry Notes, and Finalization Failure Notes prompt parts. The model receives only the active bead plus compact, meaning-preserving histories from earlier attempts. It does not receive the full PRD, interview, full bead list, or earlier coding transcript inline. The prompt points to `.ticket/runtime/execution-setup-profile.json` for optional setup/tooling lookup when needed. |
| `RUNNING_FINAL_TEST` | `ticket_details`, `prd`, `beads`, `final_test_notes`. The final-test retry-note generator uses `ticket_details` plus `error_context` to summarize a failed attempt; the next final-test prompt receives that summary as `final_test_notes`. |
| `INTEGRATING_CHANGES` | No normal model prompt. Integration is deterministic git/file handling using stored artifacts and the worktree state. |
| `CREATING_PULL_REQUEST` | PR drafting receives `ticket_details` and `prd`. The pull-request phase appends narrow reports, diffs, candidate-file audit details, or final-test material as task-specific sections instead of broadening the reusable context allowlist. |
| `WAITING_PR_REVIEW` | No model prompt while waiting for the user. The UI shows the draft PR, final net diff, bead activity, ignored-file audit, and test results. |
| `CLEANING_ENV` | No model prompt. Cleanup is deterministic runtime-state cleanup with preserved artifacts. |
| `COMPLETED` | No model prompt. The ticket is terminal and artifacts remain available for review. |
| `CANCELED` | No model prompt. The ticket is terminal; partial artifacts may remain available. |
| `BLOCKED_ERROR` | No model prompt while blocked. `retry` re-enters the saved `previousStatus` and uses that status's normal context contract, including `GENERATING_EXECUTION_SETUP_PLAN` after an operational drafting failure. For a live CODING block, **Retry with extra note...** appends the user's guidance to `userRetryNotes` before starting the fresh bead attempt. For a live `PREPARING_EXECUTION_ENV` block, the same label opens a dialog, sends only the entered note to the preserved setup session, and allows one manual attempt beyond the automatic budget. The setup note is not appended to `execution_setup_notes` or any future setup context. **Edit setup plan...** asks for confirmation before it rewinds directly to approval; a subsequent Regenerate action enters setup-plan drafting with the cleaned failure context. Finalization failures append only to `finalizationFailureNotes` and remain manual Retry/Cancel blocks; they do not invoke Ralph recovery. Eligible `continue` sends exactly `continue please` into the preserved OpenCode session instead of rebuilding or appending a new broad prompt. CODING context-wipe prompts use only `bead_data` and `error_context`. |

## 8. Retry Behavior

Retries are where context engineering matters most.

Structured-output retries do not turn into long conversations. They keep the same base context and append only the validation error, the failed raw response when useful, and a stricter instruction to return the corrected artifact. Accepted artifacts are stored durably; malformed bodies stay in Raw diagnostics instead of becoming future canonical context.

Execution retries are even narrower. A failed bead produces a context-wipe note from `bead_data` and `error_context` and appends it to `failedIterationNotes`. From a live implementation block, the user may append a timestamped entry to `userRetryNotes` without replacing prior entries. The next coding attempt starts fresh from `bead_data` and the three separately labelled histories, after the worktree is safely reset to the bead start commit.

Provider/session continuation is intentionally different from retry. When a provider stall is continuable and the exact OpenCode session is still preserved, LoopTroop sends only `continue please` into that session. It does not splice a new transcript, regenerate the prompt, or attach unrelated artifacts.

## 9. Ordering, Trimming, And Cache

Context parts are sorted before prompting:

- `ticket_details` always comes first
- other slices preserve assembly order
- each slice is emitted as a separate `PromptPart`

That keeps the primary user requirement visible even when later slices are large.

The current default token budget is `100000`. If assembled context exceeds that budget, LoopTroop trims lower-priority slices first:

1. `error_context`
2. `bead_notes` (all three histories are trimmed together)
3. `execution_setup_plan_notes`
4. `execution_setup_notes`
5. `final_test_notes`
6. `user_answers`
7. `tests`
8. `votes`
9. `drafts`
10. `full_answers`
11. `beads_draft`
12. `beads`
13. `interview`
14. `prd`
15. `relevant_files`
16. `execution_setup_plan`
17. `execution_setup_profile`
18. `ticket_details`

The most disposable slices disappear first, while the core ticket requirement is protected as long as possible.

The context builder also keeps a lightweight per-ticket cache for reusable slices.

| Setting | Current value |
| --- | --- |
| Cache structure | `Map<string, { content: string; timestamp: number }>` |
| TTL | `300000` ms |
| Cached slices | Reusable content like relevant files, interview, and PRD |
| Invalidation | `clearContextCache(ticketId)` |

This cache is a performance helper, not a source of truth. Durable artifacts remain authoritative.

## 10. Relevant Files

`relevant-files.yaml` is the first major context artifact. It gives later phases repo-grounded input without forcing them to scan the whole codebase again. Interview, PRD, and bead planning all depend on it.

Older documentation sometimes referenced `codebase-map.yaml`; that is no longer the primary planning artifact.

## 11. Execution Isolation

Planning phases work with broad artifact context. Execution does the opposite:

- `coding` only gets `bead_data` and retry notes inline, with a read-only pointer to `.ticket/runtime/execution-setup-profile.json` for optional setup/tooling lookup
- `context_wipe` only gets the active bead plus failure context
- `final_test` expands back out only to ticket details, PRD, beads, and retry notes
- `pull_request` narrows again to ticket details and PRD; reports and diffs are task-specific prompt sections, not general context-builder slices

This narrowing is intentional. Coding quality improves when the prompt is dominated by the exact bead contract instead of by the full planning transcript.

## 12. What This Prevents

Context engineering protects against:

- context rot from failed attempts
- accidental reliance on stale model reasoning
- irrelevant phase artifacts crowding out the active requirement
- full-history prompts that become expensive, slow, and less precise
- hidden state that exists only in a model conversation

The practical rule is simple: the model should know exactly what it needs for the current job, and nothing more by default.

## Related Docs

- [Core Philosophy](core-philosophy.md)
- [Ticket Flow](ticket-flow.md)
- [Prompt Inventory](prompts.md)
- [Beads & Execution](beads.md)
- [Output Normalization](output-normalization.md)
