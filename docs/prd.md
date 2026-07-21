# PRD

> [!IMPORTANT]
> **TL;DR** — After interview approval, LoopTroop runs a two-part PRD loop: each council member first completes skipped interview answers into its own Full Answers artifact, then drafts, votes, refines, and coverage-checks a structured PRD. The approved PRD becomes the implementation contract that beads planning decomposes.

The PRD is the ticket's implementation contract. It turns approved interview intent into a durable, reviewable spec that later phases can decompose, verify, and trace back to what the user actually meant.

The core PRD document shape lives in `src/lib/prdDocument.ts`. Drafting and council orchestration live in `server/workflow/phases/prdPhase.ts`, coverage/versioning in `server/workflow/phases/verificationPhase.ts`, and approval/edit handling in `server/phases/prd/document.ts` plus `server/routes/ticketHandlers/approvalHandlers.ts`.

For the state-machine view, see [Ticket Flow - PRD](/ticket-flow#prd-loop).

## 1. What The PRD Is For

The PRD exists to stop implementation from starting on a vague ticket plus a fuzzy memory of earlier conversation.

LoopTroop intentionally narrows context from phase to phase. That only works if planning decisions are converted into explicit artifacts instead of being left inside raw transcripts. The PRD is the artifact that says:

- what must be built
- what is explicitly out of scope
- which constraints and risks matter
- how the work should be verified

Beads planning decomposes this contract, not the raw ticket.

## 2. Lifecycle At A Glance

The PRD phase is a small workflow, not a single prompt:

1. **Full Answers generation** completes any skipped interview answers on a per-model basis.
2. **Independent PRD drafting** turns those completed answers into competing specs.
3. **Anonymized voting and refinement** pick the strongest draft baseline and improve it with ideas from losing drafts.
4. **Versioned coverage** revises the PRD in-place until it is clean or the configured cap is reached.
5. **Approval** freezes the reviewed PRD before beads planning begins.

That means the PRD loop produces assumptions, draft history, candidate versions, approval state, and audit artifacts - not just one final YAML file.

## 3. Part 1: Full Answers

PRD drafting starts from the approved interview, but not every interview answer is always user-provided. Skipped questions are completed first through a **Full Answers** artifact.

The Full Answers artifact keeps the approved interview structure intact, including:

- stable question IDs and order
- question phase and source metadata
- answer types and option lists
- follow-up rounds
- summary and approval metadata
- every non-skipped user answer exactly as approved

The model may change only the answer blocks for skipped questions. When it fills one in, LoopTroop marks it with `answered_by: ai_skip`, flips `answer.skipped` to `false`, and stores the inferred answer in the same artifact shape as a real answer. For choice questions, the model must reuse existing option IDs and may add concise free text only when the selected option needs nuance. If supplied context cannot confirm a needed technical fact, it may inspect the smallest relevant repository area read-only; it does not use repository contents to overwrite approved user answers or infer stakeholder decisions.

If no skipped answers exist, LoopTroop can synthesize the Full Answers artifact without making another model call.

### Why Full Answers Are Per-Model

Each council member creates its own Full Answers artifact on purpose.

Skipped questions are unresolved requirements. Different models may infer different but still reasonable completions from the same ticket, repo, and approved interview. LoopTroop wants those assumptions to stay attached to the PRD draft they produced, so voting chooses both:

1. the PRD structure and content
2. the assumption set behind that PRD

### Validation And Failure Rules

If a council member cannot produce a valid Full Answers artifact, its PRD draft is not started. LoopTroop records a concise skipped/invalid diagnostic instead of letting malformed Full Answers output leak into the PRD draft stage.

Full Answers normalization is intentionally conservative:

- safe formatting repairs may fix YAML around existing text
- canonical interview metadata such as `follow_up_rounds` is restored from the approved interview when possible
- unrecoverable or invented structure still fails validation

Rejected model output remains diagnostic-only in Raw attempt views and logs.

## 4. Part 2: Drafting, Voting, And Refining

After Full Answers are ready, the PRD council runs the normal draft -> vote -> refine pattern:

| Step | What happens |
| --- | --- |
| **Drafting** | Each council member receives relevant files, ticket details, and its own Full Answers artifact, then independently writes a full PRD draft. |
| **Voting** | Drafts are anonymized, presentation order is randomized, and the council scores them against a requirements-focused PRD rubric. |
| **Refining** | The winning model keeps its own structure but selectively adopts stronger requirements, acceptance criteria, edge cases, risks, and verification ideas from losing drafts. |

The refined result becomes **PRD Candidate v1**.

LoopTroop treats malformed or rejected model text as diagnostics, not as artifact body content. The structured UI shows accepted, validated PRD bodies; raw/rejected attempts remain available separately for audit.

## 5. What The PRD Contains

The PRD artifact is structured YAML with stable top-level sections:

| Field | Purpose |
| --- | --- |
| `schema_version`, `ticket_id`, `artifact`, `status` | Artifact identity and lifecycle state (`draft` or `approved`) |
| `source_interview.content_sha256` | Hash tying the PRD back to the canonical interview content it came from |
| `product` | Problem statement and target users |
| `scope` | Explicit in-scope and out-of-scope boundaries |
| `technical_requirements` | Implementation constraints that later phases should honor |
| `epics` | The main chunks of work the feature breaks into |
| `risks` | Known implementation or product risks |
| `approval` | Human approval metadata |

`technical_requirements` is split into these stable sections:

- `architecture_constraints`
- `data_model`
- `api_contracts`
- `security_constraints`
- `performance_constraints`
- `reliability_constraints`
- `error_handling_rules`
- `tooling_assumptions`

Each epic includes:

- an ID
- title
- objective
- implementation steps
- one or more user stories

Each user story includes:

- an ID and title
- acceptance criteria
- implementation steps
- `verification.required_commands`

Every in-scope feature from the completed interview should map to at least one concrete user story. In practice, the PRD approval UI is organized around the same core sections: product, scope, technical requirements, risks, and epics/stories.

## 6. Coverage And Candidate Versioning

Coverage starts after refinement. The important detail is that PRD coverage uses the **winning model's Full Answers artifact** as the canonical comparison source, not the entire interview transcript.

PRD coverage checks for:

- missing requirements
- vague or weak acceptance criteria
- missing edge cases
- missing constraints
- missing out-of-scope or non-goal boundaries
- contradictions between Full Answers and the PRD
- weak verification guidance
- missing traceability from completed interview answers into the PRD

Unlike interview coverage, PRD coverage does **not** ask the user new questions. If gaps are found and the configured cap allows another pass, LoopTroop revises the PRD inside the same phase and promotes it to the next candidate version (`v1`, `v2`, and so on).

Coverage metadata is also filtered conservatively. LoopTroop keeps revision/change metadata only when it contains real, text-preserving semantic before/after items. If a model emits only section paths or vague summaries, LoopTroop records warnings and falls back to deriving the visible diff from the validated PRD versions themselves.

If the candidate becomes clean, it advances to approval cleanly. If the cap is exhausted first, the latest candidate still advances, but unresolved coverage warnings stay visible for review instead of being hidden. From the approval warning, the user can request manual extra fixes one at a time; each extra fix reloads the latest server artifacts, revises only the listed gaps, runs a fresh coverage check, and records an `Extra Fix N` entry in the coverage report.

## 7. Approval, Editing, And Downstream Impact

Approval is the gate between specs and beads planning.

At `WAITING_PRD_APPROVAL`, the user can:

- review the PRD in structured form
- switch to raw YAML for direct editing
- inspect the winning model's read-only Full Answers artifact
- review any unresolved coverage warnings from a capped coverage loop
- click `Fix gaps with AI` when unresolved warnings remain, or explicitly approve with gaps

### Saving Before Approval

Saving while the ticket is still in `WAITING_PRD_APPROVAL` canonicalizes the document back into a draft PRD:

- `ticket_id` is rewritten to the canonical ticket external ID
- `status` is forced back to `draft`
- approval metadata is cleared
- a `user_edit_receipt:prd` artifact records the change

That means a saved edit is not silently treated as already approved. You must approve the newly saved draft version.

### Approving

Approval includes the SHA-256 hash of the exact raw bytes the user reviewed. If the stored PRD changed before the approval request lands, the server rejects the request with a stale-content `409` instead of approving a different version by mistake.

The approval receipt stores both:

- `content_sha256` for the reviewed draft bytes
- `stored_content_sha256` for the approved YAML after approval metadata is injected

That distinction matters because approval changes the stored file.

### Editing After Approval

Post-approval PRD edits are still allowed only while the ticket is before `PRE_FLIGHT_CHECK`.

When a post-approval save happens in a downstream planning state, LoopTroop:

1. archives the current approved PRD attempt
2. archives downstream beads-planning attempts
3. clears stale beads artifacts and related UI state
4. saves the edited PRD as the new approved version
5. restarts the workflow at `DRAFTING_BEADS`

Once the ticket reaches `PRE_FLIGHT_CHECK` or later, PRD edits are rejected because the execution plan is already entering implementation territory.

## 8. What Gets Stored

Beyond the final `prd.yaml`, LoopTroop persists PRD-phase audit history, including:

- per-model Full Answers artifacts
- PRD draft artifacts
- vote artifacts and outcome metadata
- refinement diff metadata when available
- coverage attempts and candidate-version history
- approval-screen extra-fix attempts labeled `Extra Fix N` in the coverage history
- approval snapshots and approval receipts
- append-only `user_edit_receipt:prd` artifacts
- archived phase attempts created by retries, regenerations, or post-approval edits

This is what makes the PRD reviewable, restartable, and auditable instead of being a one-shot prompt result.

## 9. How Later Phases Use The PRD

Once approved, the PRD becomes the authoritative input for beads planning.

The beads council uses it to:

- choose task boundaries
- preserve scope and non-goals during decomposition
- carry forward acceptance criteria into bead verification intent
- keep implementation work traceable back to explicit PRD stories

Execution setup, coding, and final verification then work downstream of those approved beads. So the PRD is not ceremonial documentation - it is the contract that turns interview intent into executable planning.
