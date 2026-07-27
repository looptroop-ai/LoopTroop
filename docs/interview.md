# Interview

> [!IMPORTANT]
> **TL;DR** — Before PRD drafting starts, LoopTroop runs a council-designed, adaptive interview that turns a vague ticket into an approved, structured requirements artifact. Downstream planning relies on that approved artifact as the authoritative record of user intent instead of carrying forward a raw chat transcript.

The interview is LoopTroop's ambiguity-removal stage. A ticket often starts as a short request, but implementation usually depends on decisions that are still missing: expected behavior, target users, constraints, edge cases, integrations, testing expectations, explicit non-goals, and what should stay out of scope.

LoopTroop resolves those decisions before specs drafting. The goal is not to preserve a long conversation. The goal is to produce a reviewable artifact that later phases can trust.

For the state-machine view, see [Ticket Flow - Interview](/ticket-flow#interview-loop).

## 1. What The Interview Is For

The interview exists to make intent durable before expensive planning begins.

That matters because later phases intentionally use narrow, purpose-built context. LoopTroop does **not** want PRD drafting, beads planning, or execution to depend on every earlier conversational turn, abandoned model attempt, or half-formed idea. Instead, the approved interview becomes the planning baseline, and later phases only add extra context where the workflow explicitly requires it, such as ticket details, relevant-file scans, or AI-filled answers for skipped questions.

## 2. Lifecycle At A Glance

The interview phase has four distinct steps:

1. **Council drafting and voting** create the initial question plan.
2. **Interactive answering** presents adaptive batches of questions to the user.
3. **Coverage review** checks whether anything important is still missing and may generate targeted follow-ups.
4. **Approval** freezes the reviewed interview artifact before PRD drafting begins.

That means the interview is not a single prompt. It is a small workflow with its own drafting, user-input, coverage, and approval loop.

## 3. How Questions Are Designed

Interview planning starts with the LLM council. Each council member receives the ticket details and relevant-file scan, then independently drafts a candidate question set. When that bounded context cannot confirm a discoverable repository fact, drafting and refinement may inspect the smallest relevant repository area read-only; voting remains limited to the supplied anonymized drafts and context.

The drafted questions follow a three-part structure:

- **Foundation**: problem framing, goals, constraints, target users, non-goals, and scope boundaries.
- **Structure**: feature inventory, major workflows, priorities, sequencing, and dependencies between behaviors.
- **Assembly**: feature-level behavior, edge cases, acceptance criteria, tests, implementation constraints, and integration details.

The council then votes on anonymized drafts using a structured rubric. The winning model refines the selected draft and produces the canonical compiled interview session used by the UI.

Each question keeps stable metadata, including:

- `id`
- `phase`
- `source`
- `follow_up_round`
- `answer_type`
- `options` for choice questions
- answer state and timestamps

Stable question IDs matter because later artifacts can trace requirements back to the exact interview question that produced them.

## 4. Question Types And Sources

Questions can be:

- `free_text`
- `single_choice`
- `multiple_choice`

Choice questions still support additional free-text notes, so the user can select the closest option and add nuance when needed.

Question sources are also explicit:

| Source | Meaning |
| --- | --- |
| `compiled` | Part of the original council-approved interview plan |
| `prompt_follow_up` | A follow-up added while adapting the next batch after earlier answers; the UI labels these as **PROM4 Follow-ups** |
| `coverage_follow_up` | A follow-up generated later by the coverage pass because important gaps remained |
| `final_free_form` | The last catch-all question for anything else the user wants recorded |

This distinction is important because not all follow-ups mean the same thing. Some are local batch adaptation, while others are explicit coverage-driven gap checks.

## 5. Live Interview Session Behavior

The interview UI is backed by a **live session snapshot** as well as the final `interview.yaml` artifact.

During answering, LoopTroop persists:

- the current batch
- the full question list
- recorded answers
- skip state
- follow-up rounds
- batch history
- completion timestamps

This is what lets the UI show answered/skipped history, restore in-progress state, and continue the same interview across batches.

Questions are presented in adaptive batches of **1 to 3**:

- **1** for complex or high-priority questions
- **2** for moderately related questions
- **3** only for simple, tightly related questions

While a batch is open:

- answers can be filled in any order
- choice selections and free-text notes are tracked locally before submit
- already answered or skipped questions remain visible in grouped history
- previously recorded answers can still be edited while the ticket is in `WAITING_INTERVIEW_ANSWERS`
- skipped questions can be unskipped and answered later

After submit, LoopTroop persists the batch into the session snapshot, updates the canonical interview state, and either prepares the next batch or advances to coverage.

When a user mentions an existing component, behavior, path, command, limitation, or architecture detail, the live interview model may inspect the relevant repository area read-only before deciding whether the next batch needs a follow-up. It does not perform a broad survey or use repository contents to decide stakeholder intent: desired behavior, scope, priorities, preferences, and acceptance decisions remain questions for the user.

The progress counter is an estimate, not a hard promise. The current batch number is real, but the total can change because later questions may become unnecessary, be merged, be lightly split, or be replaced by targeted follow-ups.

## 6. Skips, Final Free-Form, And Coverage

Skipping is explicit and durable. A skipped question is not silently deleted and is not treated as answered.

In the final interview artifact, skipped answers remain present with `answer.skipped: true`. Later, during PRD drafting, each council model may fill those skipped answers in its own Full Answers artifact. Those AI-filled answers are marked with `answered_by: ai_skip`, so they remain distinguishable from user-provided answers.

Once the compiled interview has been answered, skipped, or made redundant, LoopTroop asks one final free-form question for anything else the user wants captured before specs drafting.

After that, the winning interview model runs coverage. Coverage checks for:

- unresolved ambiguity
- missing constraints
- missing edge cases
- missing non-goals or out-of-scope boundaries
- inconsistent answers
- gaps that would force PRD drafting to guess

Coverage may use the same focused read-only inspection to confirm technical facts, but it cannot infer product decisions from existing code.

If real gaps remain and the follow-up budget allows it, coverage generates targeted follow-up questions and sends the ticket back to `WAITING_INTERVIEW_ANSWERS`.

If coverage is clean, the interview moves to approval.

If the follow-up budget is exhausted, the interview still moves to approval, but the remaining gaps stay visible in the resulting artifacts instead of being hidden.

If the user chooses **skip all**, LoopTroop:

1. preserves anything already answered
2. marks every remaining unanswered question as skipped (which are answered by AI models at the beginning of the PRD phase)
3. advances directly to interview approval
4. writes a **synthetic clean coverage record** for audit continuity

That is intentionally different from real coverage. It is an explicit user bypass.

## 7. What Gets Stored

The final interview artifact is structured YAML, not a transcript. Its core fields are:

| Field | Purpose |
| --- | --- |
| `schema_version` | Artifact schema version |
| `ticket_id` | External ticket reference |
| `artifact` | Always `interview` |
| `status` | `draft` or `approved` |
| `generated_by` | Winning model, generation timestamp, and canonicalization metadata |
| `questions` | Canonical question list with per-question metadata and answers |
| `follow_up_rounds` | Round-by-round follow-up history with source and question IDs |
| `summary` | Goals, constraints, non-goals, and final free-form answer |
| `approval` | Human approval metadata |

Each question answer stores:

- `skipped`
- `selected_option_ids`
- `free_text`
- `answered_by` (`user` or `ai_skip`)
- `answered_at`

In practice, this gives LoopTroop two complementary records:

1. a **live session snapshot** for the interactive Q&A workflow
2. a **canonical interview artifact** for review, approval, and downstream planning

## 8. Approval, Editing, And Downstream Impact

Approval is a real gate. PRD drafting does not start until the interview is approved.

At the approval step, the user can review the artifact in:

- a structured question-and-answer view
- a raw YAML editor

Approval includes the SHA-256 hash of the exact raw content the user reviewed. If the stored artifact changes before approval lands, the server rejects the request with a stale-content `409` instead of approving a different version by mistake.

Editing rules are intentionally strict:

- **At `WAITING_INTERVIEW_APPROVAL`**: saving edits rewrites the interview into canonical form and clears approval state, so the updated artifact must be reviewed and approved again.
- **After approval but still before `PRE_FLIGHT_CHECK`**: interview edits are still allowed, but saving them archives the current approved interview and any downstream PRD/beads planning attempts, invalidates stale downstream planning artifacts, saves the edited interview as the new approved version, and restarts PRD drafting from that edited baseline.
- **At `PRE_FLIGHT_CHECK` or later**: interview edits are rejected, because execution planning is already being locked for implementation.

This behavior is why the interview is more than a form. It is the first durable planning contract in the pipeline.

## 9. How Later Phases Use It

Once approved, the interview becomes the authoritative planning artifact for the rest of the pre-implementation workflow.

The PRD phase uses it to:

- generate per-model Full Answers artifacts
- distinguish real user answers from AI-filled skipped answers
- draft competing PRDs
- verify PRD coverage against the approved interview baseline

Beads planning, execution setup, coding, final testing, and pull-request generation all sit downstream of that PRD. So although the interview happens early, it is the point where vague intent becomes durable, reviewable planning input for everything that follows.
