# Configuration Reference

> [!IMPORTANT]
> **TL;DR** — Most runtime behavior — council size, retry budgets, timeouts, quorum rules, and model selection — is configurable through the UI settings panel. Defaults are tuned for overnight runs; adjust them to match your provider limits and cost tolerance.

The singleton profile is the baseline configuration, accessible through the **Configuration** button in the LoopTroop UI. You do not need to restart the server after editing it, but settings are not all consumed at the same moment: some are frozen when a ticket starts, while others are read later at phase or session boundaries.

## Scope And Inheritance

LoopTroop applies configuration in three layers:

| Layer | What it controls | When it applies |
| --- | --- | --- |
| Profile | App-wide baseline values | Used whenever no project override exists |
| Project override | Optional overrides for a small execution/planning subset, including Manual QA and Git hooks | Applied when the value is resolved |
| Ticket override | Optional Draft-only Manual QA and Git-hook choices | Wins over project and profile when the ticket starts |
| Ticket start lock | Frozen planning-critical values captured on **Start** | Stays fixed for that ticket run |

The Configuration dialog edits the singleton profile. Project-level overrides are stored by the project API/local project state; the Project form provides focused Manual QA and Git-hook editors, while the other project overrides do not have a general editor in the Configuration dialog. The overrideable fields are:

- `councilMembers`
- `maxIterations` (`Max Bead Retries`)
- `perIterationTimeout`
- `executionSetupTimeout`
- `councilResponseTimeout` (`AI Response Timeout`)
- `minCouncilQuorum`
- `interviewQuestions`
- `manualQaOverride`
- `gitHookPolicy`

If a project override is set, it wins over the profile for that field. Fields without project-override support always come from the profile.

### What locks when you press Start

These values are captured before the ticket enters `SCANNING_RELEVANT_FILES` and stay fixed for that ticket even if you edit the profile afterward:

| Locked at start | Why it is frozen |
| --- | --- |
| Main implementer model + effort variant | The same model lineup must own the full run for auditability and retry consistency |
| Council members + their effort variants | Council drafting/voting must stay comparable across the ticket lifecycle |
| Max Interview Questions | The compiled interview contract should not change mid-run |
| Coverage Follow-Up Budget | Interview follow-up budget is part of the approved planning envelope |
| Interview / PRD / Beads Coverage Passes | Coverage-loop budgets must stay stable for that ticket |
| Structured Output Retries | Repair behavior must stay stable across the ticket's structured phases |
| Manual QA effective value + source | The post-test route must not change after work starts; missing locks on older/in-progress tickets mean disabled |
| Git-hook policy effective value + source | Repository-hook behavior must stay stable throughout setup, internal commits, and integration |

### What is read later instead of locked

These values are not frozen into the ticket-start lock. They are picked up when the relevant phase, prompt, or log pipeline reads them:

| Read later | Typical read timing |
| --- | --- |
| AI Response Timeout, Min Council Quorum | When a planning/final-test model phase starts |
| Per-Iteration Timeout, Execution Setup Timeout, Max Bead Retries | When execution setup, coding, or final-test attempts are prepared |
| OpenCode Retry Limit, OpenCode Retry Grace Window, OpenCode Max Steps | When new OpenCode prompt/session settings are assembled |
| Tool Input / Output / Error Max Chars | When tool-log formatting runs (backend cache is refreshed periodically) |

That means an edit can affect a ticket that is already in progress **only if the ticket has not yet crossed the boundary where that specific value is read**. It does not rewrite already-running prompts, already-started timers, or already-locked planning budgets.

## Configuration Dialog Behavior

The docs links on each control point back to this page, but the UI itself also has a few behaviors worth knowing:

- **OpenCode health is checked live.** The dialog shows whether OpenCode is reachable, whether model discovery is still loading, and whether the connected providers currently expose any models.
- **The reload button performs a strong provider/model refresh.** It spins and remains disabled until the refresh finishes, disposes only LoopTroop's OpenCode catalog/root instance, then fetches the provider catalog again and replaces the cached model query. Use it after adding or changing OpenCode provider credentials, or when the catalog was empty during startup. This does not restart `opencode serve` or interrupt active ticket worktree instances.
- **Model pickers load configured providers only by default.** Inside the picker you can search by model name, provider, or family and filter to free models. The much larger full OpenCode catalog is not requested until you enable **Show all providers**; turning the option off returns to the configured-provider list.
- **Duplicate model selection is prevented.** The main implementer is auto-included in the council, and the picker disables models already chosen in another council slot.
- **Effort controls are conditional.** The effort / thinking picker only appears when the selected model advertises variants, and the saved variant is stored per slot.
- **Numeric validation is strict.** All numeric fields must be whole numbers. AI Response Timeout, Execution Setup Timeout, Per-Iteration Timeout, and OpenCode Retry Grace Window keep total seconds as the saved value and show compact synchronized Minutes and Seconds editors inside the same field; changing either representation updates the other immediately. Coverage remains displayed in percent, while the API stores timeout/delay values in milliseconds.
- **The `About` button opens a separate window for application details.** It starts with the current runtime environment, then shows the application's storage locations and a short note explaining that each attached project also keeps local LoopTroop state inside `<repo>/.looptroop/`.

### About Window

The **About** window is a read-only summary of the current runtime environment and storage layout.

It shows:

- the app version;
- the operating system / runtime environment;
- the application location;
- the app database path;
- the global configuration directory;
- the current number of attached projects;
- a short note explaining that each attached project also keeps local LoopTroop state inside its own `.looptroop/` folder.

This is meant to answer two quick questions without opening logs or artifacts:

- "Where does the app keep its own data?"
- "Where does each project keep its local LoopTroop state?"

## Quick Reference

| Setting | Default | Range | Group | Read timing |
| --- | --- | --- | --- | --- |
| [Main Implementer Model](#main-implementer-model) | _(required)_ | any available model | AI Models | ticket start lock |
| [Council Members](#council-members) | _(required, 1–3 additional)_ | any available models | AI Models | ticket start lock |
| [OpenCode Retry Limit](#opencode-retry-limit) | 10 | 0–50 | OpenCode Provider Recovery | next OpenCode prompt/session |
| [OpenCode Retry Grace Window](#opencode-retry-grace-window) | 60 s | 0–3600 s | OpenCode Provider Recovery | next OpenCode prompt/session |
| [OpenCode Max Steps](#opencode-max-steps) | 0 (no limit) | 0–500 | OpenCode Provider Recovery | next coding/final-test session |
| [AI Response Timeout](#ai-response-timeout) | 1200 s | 10–3600 s | AI Thinking | next planning/final-test model phase |
| [Min Council Quorum](#min-council-quorum) | 2 | 1–4 | AI Thinking | next planning phase |
| [Max Interview Questions](#max-interview-questions) | 50 | 0–50 | AI Thinking | ticket start lock |
| [Structured Output Retries](#structured-output-retries) | 1 | 0–5 | AI Thinking | ticket start lock |
| [Coverage Follow-Up Budget](#coverage-follow-up-budget) | 20 % | 0–100 % | Coverage | ticket start lock |
| [Interview Coverage Passes](#interview-coverage-passes) | 2 | 1–10 | Coverage | ticket start lock |
| [PRD Coverage Passes](#prd-coverage-passes) | 5 | 2–20 | Coverage | ticket start lock |
| [Beads Coverage Passes](#beads-coverage-passes) | 5 | 2–20 | Coverage | ticket start lock |
| [Manual QA](#manual-qa) | disabled | enabled / disabled | Post-Implementation | ticket start lock |
| [Git Hook Policy](#git-hook-policy) | Validate | Validate / Ignore / Run | Pre-Implementation | ticket start lock |
| [Per-Iteration Timeout](#per-iteration-timeout) | 1200 s | 0–3600 s | Implementation & Workspace Setup | next coding/final-test attempt |
| [Execution Setup Timeout](#execution-setup-timeout) | 1200 s | 0–3600 s | Implementation & Workspace Setup | next execution-setup attempt |
| [Max Bead Retries](#max-bead-retries) | 5 | 0–20 | Implementation & Workspace Setup | next execution/final-test attempt |
| [Tool Input Max Chars](#tool-input-max-chars) | 4,000 | 500–50,000 | Logging | live log formatting (cached briefly) |
| [Tool Output Max Chars](#tool-output-max-chars) | 12,000 | 1,000–100,000 | Logging | live log formatting (cached briefly) |
| [Tool Error Max Chars](#tool-error-max-chars) | 6,000 | 500–50,000 | Logging | live log formatting (cached briefly) |

## Manual QA

Manual QA is an optional human verification loop between final tests and integration. Its profile default is `manualQaEnabled: false`. Configuration places it in **Post-Implementation**, while Project **Advanced** settings place it beside Git hooks in one collapsed section. Ticket controls expose it in Advanced and the Draft workspace until **Start**. All scopes offer only `Enabled / Disabled`; new project and ticket saves persist the selected boolean explicitly. Legacy unset values remain readable and display their resolved parent/default boolean until the user chooses an explicit value.

Hovering **Enabled** or **Disabled** explains the resulting workflow route, including whether LoopTroop creates a checklist and waits for user verification. The help button beside each Manual QA control explains that scope and opens this section in the locally served documentation started with the application.

Resolution is deterministic:

1. a non-null ticket `manualQaOverride` wins;
2. otherwise a non-null project `manualQaOverride` wins;
3. otherwise the profile `manualQaEnabled` boolean is used.

On Start, LoopTroop persists both `lockedManualQaEnabled` and `lockedManualQaSource` (`ticket`, `project`, or `profile`). Only Draft tickets may change their override, and later profile/project edits cannot change the route of a started ticket. Existing in-progress tickets that do not have a locked value behave as disabled.

Manual QA Improvement drafts use the same explicit Enabled/Disabled choice for the new child ticket. Their collapsed Advanced control starts from the current effective project/profile value and is stored with the chosen P1–P5 priority, so child creation does not depend on a later configuration change.

When the lock is disabled, `TESTS_PASSED` keeps the direct `RUNNING_FINAL_TEST → INTEGRATING_CHANGES` route. When enabled, it enters `GENERATING_QA_CHECKLIST → WAITING_MANUAL_QA`; a submitted failure creates QA-fix beads and loops through Coding and fresh final tests before the next checklist version.

---

## AI Models

### Main Implementer Model

**Type:** model selector  
**Required:** yes

The main implementer is the primary model LoopTroop assigns to a ticket. LoopTroop validates and locks it when you press **Start**, then uses that same model from `SCANNING_RELEVANT_FILES` through final verification.

**What it does:**

- Runs the initial single-model groundwork (`SCANNING_RELEVANT_FILES`) before any council phase starts.
- Is automatically included in every council phase — it always participates in drafting and voting.
- Handles all coding iterations during `CODING`.
- Runs the final verification pass in `RUNNING_FINAL_TEST`.

**How to choose:**

Pick the model you trust most for sustained reasoning and code generation. Other council members exist to challenge the plan quality; the main implementer is the one writing and validating the code, so reliability matters more than pure creativity here.

If the model supports effort or thinking variants (see [Effort / Thinking Variant](#effort--thinking-variant)), prefer a higher-effort variant for complex tickets.

::: tip
You can change the main implementer between tickets. The choice is locked per-ticket once work starts, so adjustments to the profile only affect future tickets.
:::

**See also:** [LLM Council → Main Implementer](/llm-council#main-implementer)

---

### Council Members

**Type:** model selector (1–5 slots, in addition to the main implementer)
**Required:** at least 1 additional member

Council members are the additional models that participate in independent drafting and structured voting during the interview, PRD, and beads planning phases.

**What they do:**

- Each member independently drafts an artifact (interview questions, PRD, or bead plan) without seeing other members' work.
- Each member votes on anonymized drafts using a structured rubric.
- The winning direction is refined and used as the planning artifact for the next phase.

**What they do not do:**

Council members do not participate in execution. Coding, final testing, and PR creation are all handled exclusively by the main implementer.

**How to choose:**

Diversity matters more than raw quality here. Mixing models from different families, sizes, or providers tends to surface more varied plans and catch more blind spots than stacking three instances of the same model.

The minimum viable council is the main implementer plus one additional member. The `Min Council Quorum` setting determines how many members must return a valid response before the pipeline trusts the result.

The UI prevents duplicate picks across council slots, so if you cannot select a model twice that is intentional rather than a catalog bug.

::: tip
Up to 9 council slots are available in addition to the main implementer, for a maximum council size of 10.
:::

**See also:** [LLM Council → Council Members](/llm-council#council-members)

---

### Effort / Thinking Variant

**Type:** variant selector (per model, optional)

Some models expose multiple effort or thinking modes (for example, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). When a selected model advertises variants, an effort picker appears below that slot's model selector. The **None** choice is always available and selected by default; it leaves the provider's effort behavior unmodified. If a model exposes no variants, the control stays hidden.

**What it does:**

The selected named variant is passed as part of the model configuration when LoopTroop calls that model. Choosing **None** clears any saved override instead of sending a literal `none` variant. Higher-effort variants generally produce better reasoning at the cost of slower responses and higher token usage.

**How to choose:**

- For the main implementer on complex or large-scope tickets, prefer a higher-effort variant.
- For council members, a balance of one high-effort and one lower-effort member often gives diverse results without making every planning phase slow.
- If a model times out repeatedly under `AI Response Timeout`, lower its effort variant before increasing the timeout.

---

## OpenCode Provider Recovery

These settings apply to OpenCode prompt execution across the workflow, not only to `CODING`. They cover planning, council/coverage prompts, execution setup generation, coding prompts, final-test generation, PR drafting, and other phases that use OpenCode.

### OpenCode Retry Limit

**Type:** integer
**Default:** 10
**Range:** 0–50

How many continuable OpenCode `session.status` retry events LoopTroop allows before it stops waiting for provider recovery and blocks the active prompt for human decision.

This is separate from `Max Bead Retries` and `Structured Output Retries`. It applies to provider/transport interruptions **inside one OpenCode prompt**, such as rate limits, usage limits, overload, temporary unavailability, timeouts, fetch failures, and socket resets.

When the limit is reached, LoopTroop routes the active phase to `BLOCKED_ERROR` with provider diagnostics. If the session is provably resumable, the UI can offer **Continue**; otherwise you fall back to **Retry** or **Cancel**. During `CODING`, provider stalls handled here do **not** consume the bead retry budget by themselves.

**Trade-offs:**

| Lower (0–2) | Higher (10–50) |
| --- | --- |
| Blocks quickly when a provider is unavailable | Gives OpenCode more room to recover internally |
| Saves time and tokens during hard rate limits | May wait longer before manual recovery is offered |
| 0 blocks on the first matching retry event | Useful for bursty providers with short retry windows |

**See also:** [OpenCode Integration → Prompt Runner](/opencode-integration#prompt-runner)

---

### OpenCode Retry Grace Window

**Type:** integer (seconds)
**Default:** 60 s
**Range:** 0–3600 s

How long LoopTroop lets an OpenCode prompt sit in a continuable retry state with no real progress before it blocks, even if the retry count has not yet reached `OpenCode Retry Limit`.

The timer starts when OpenCode reports a matching retry status and is cleared by real prompt progress. Set it to 0 to disable the grace timer and rely only on the retry count.

**Trade-offs:**

| Lower (0–10 s) | Higher (60–3600 s) |
| --- | --- |
| Surfaces stuck retry loops quickly | Allows longer provider backoff windows |
| Better for interactive supervision | Better for unattended runs with temporary provider load |
| 0 disables the timer | Long windows can delay manual intervention |

**See also:** [OpenCode Integration → Prompt Runner](/opencode-integration#prompt-runner)

---

### OpenCode Max Steps

**Type:** integer  
**Default:** 0 (no limit — OpenCode default)  
**Range:** 0–500

Maximum number of steps OpenCode is allowed to perform per session. When the limit is reached, OpenCode instructs the model to summarize its work and close the session; LoopTroop then starts a fresh session to continue.

**Steps vs messages:** Each step is one full round-trip — the model reads the full context, decides which tools to call, and receives their results. Each step generates approximately two messages in the execution log (one assistant message with tool calls, one with tool results). So `messages=25` in the log corresponds roughly to 12–13 steps.

**What 0 means:** No `opencode.json` is written to the worktree. OpenCode runs with no step cap and the model stops whenever it decides naturally. This is the default behavior. When a session ends without producing a text response (the model stopped mid-step), LoopTroop will automatically start a new session and show a visible notification in the **ALL** tab.

**When to set a value:** If you observe sessions running for a very large number of messages and then silently restarting, setting a cap (e.g. `20`) ensures OpenCode wraps up and summarizes at a predictable point. A session that hits the configured limit produces a summary response, so the restart is cleaner than a natural mid-step stop.

**Implementation detail:** When `opencodeSteps > 0`, LoopTroop writes `opencode.json` at the root of the ticket worktree before coding starts and deletes it when coding finishes (including on error). The file is automatically excluded from git via the worktree-local git exclude, so it never appears in commits or `git status`.

**Trade-offs:**

| Lower (5–15) | Higher (30–100) |
| --- | --- |
| Sessions wrap up and summarize more frequently | Fewer session restarts overall |
| More predictable restart points | Model may run longer before being forced to summarize |
| Useful for models that tend to drift in very long sessions | Useful when tasks genuinely need many uninterrupted steps |
| 0 = no limit, same as not setting the value | 0 is the OpenCode default |

**See also:** [OpenCode Integration → Prompt Runner](/opencode-integration#prompt-runner)

---

## AI Thinking

### AI Response Timeout

**Type:** integer (seconds)  
**Default:** 1200 s (20 minutes)  
**Range:** 10–3600 s

The maximum time LoopTroop will wait for a model response in non-coding model-output phases. It covers relevant-files scanning, council drafting/voting/refinement, coverage and expansion prompts, interview QA prompts, execution setup-plan drafting/regeneration, final-test model prompts, and PR title/body drafting.

This setting does **not** govern coding attempts or `PREPARING_EXECUTION_ENV` workspace setup. Use [Per-Iteration Timeout](#per-iteration-timeout) for coding and [Execution Setup Timeout](#execution-setup-timeout) for pre-implementation workspace setup.

**What happens when it expires:**

The request is abandoned and the active phase handles the timeout according to its workflow. In council phases, timed-out responses do not count toward `Min Council Quorum`; if quorum is no longer met, the phase enters `BLOCKED_ERROR`. In single-model planning phases, the ticket blocks with timeout diagnostics. In `RUNNING_FINAL_TEST`, only model prompt waits use this setting; shell command execution remains governed by the execution/final-test timeout budget.

**Trade-offs:**

| Lower | Higher |
| --- | --- |
| Fail fast when a provider is stalled or slow | Tolerate larger context windows, heavy thinking variants, or slow providers |
| More likely to block on slow models | Less likely to block due to transient slowness |

**When to change:**

- Increase if you are using high-effort thinking variants and see frequent timeout blocks.
- Increase if your OpenCode provider has high network latency or rate-limited batches.
- Decrease if you want fast failure feedback when a model is unavailable instead of waiting 20 minutes.

**See also:** [LLM Council → AI Response Timeout](/llm-council#ai-response-timeout)

---

### Min Council Quorum

**Type:** integer  
**Default:** 2  
**Range:** 1–4

The minimum number of valid council responses LoopTroop requires before it trusts a drafting or voting phase.

**What "valid" means:**

A model response is valid if it returns within `AI Response Timeout` and its structured output can be parsed without terminal errors. Malformed or timed-out responses do not count toward quorum.

**What happens when quorum is not met:**

The phase enters `BLOCKED_ERROR`. This is intentional — a plan built from one draft when you configured two is not trustworthy, so LoopTroop refuses to advance silently.

**Trade-offs:**

| Lower (1) | Higher (3–4) |
| --- | --- |
| Survives when one model is unavailable | Requires all models to be healthy and responsive |
| Lower diversity guarantee | Stronger diversity guarantee |
| Useful if running a lean council | Only practical with a full council of that size |

::: warning
Setting quorum higher than your total council size guarantees permanent blocks. Keep quorum ≤ the number of configured council members (including the main implementer).
:::

**See also:** [LLM Council → Min Council Quorum](/llm-council#min-council-quorum)

---

### Max Interview Questions

**Type:** integer  
**Default:** 50  
**Range:** 0–50

Caps how many initial clarifying questions the compiled interview document can contain before the UI starts presenting them to you across one or more batches.

**What it controls:**

After `COMPILING_INTERVIEW` finishes, the interview document can have up to this many questions in the initial compiled checklist. The UI may present that checklist across multiple batches, but questions beyond the cap are not generated — this is a hard ceiling on initial intake depth.

**Trade-offs:**

| Lower | Higher |
| --- | --- |
| Faster intake for simple tickets | Richer context for the PRD and beads planning |
| May leave ambiguities unresolved | More questions to answer before planning can start |

**When to change:**

- Lower for routine or well-scoped tickets where you already know the requirements.
- Keep at maximum (50) for exploratory or large-scope work where ambiguity is costly later.
- Treat `0` as an edge-case/testing value, not as the normal way to skip the interview. The workflow still expects a real compiled interview artifact; use **Skip All** during the interview itself if you want to advance with minimal answers.

**See also:** [Ticket Flow → Interview](/ticket-flow#interview)

---

### Structured Output Retries

**Type:** integer
**Default:** 1
**Range:** 0–5

Controls how many automatic retry prompts LoopTroop may send after the first model response fails structured-output validation. The value is locked onto each ticket when it starts, so profile changes affect future tickets and unstarted tickets only.

This setting applies to structured-output repair paths such as council drafts/votes/refinements, relevant-files scan, interview batch generation, PRD/beads coverage, execution setup reports, final-test generation, PR drafting, and the completion-marker structured retry inside one coding iteration. It does not change coverage pass limits, coding bead iteration count, execution setup/final-test attempt budgets, or manual Retry from `BLOCKED_ERROR`.

**Session behavior:**

- Validation errors normally use a **continued session** retry prompt so the model can correct only the malformed output.
- Empty responses, provider/session errors, and transport-style failures use a **fresh session** where the original prompt is sent again.
- Council draft/vote/refine retries are documented fresh-session structured retries by design.

**Trade-offs:**

| Lower (0) | Higher (2–5) |
| --- | --- |
| Fails fast and spends fewer tokens | More tolerance for malformed YAML/JSON or transient provider output |
| 0 disables automatic structured repair prompts | Higher values can delay surfacing persistent prompt/parser issues |

---

## Coverage

Coverage settings control the self-checking loops that run after drafting. LoopTroop uses coverage passes to improve artifact completeness before you review and approve. All three domains (interview, PRD, beads) have independent pass budgets.

### Coverage Follow-Up Budget

**Type:** integer (percent)  
**Default:** 20 %  
**Range:** 0–100 %

Limits how many additional coverage follow-up questions the `VERIFYING_INTERVIEW_COVERAGE` pass can add relative to the original compiled interview size.

**Example:** With `Max Interview Questions = 50` and `Coverage Follow-Up Budget = 20 %`, the follow-up pass can add at most 10 extra questions (20 % of 50).

**What it controls:**

After the initial compiled interview is complete, the coverage pass checks whether important gaps remain. If it finds gaps, it generates targeted follow-up questions. This setting prevents an unbounded coverage loop of "just a few more questions"; it does not limit how the initial compiled checklist is batched for presentation.

**Trade-offs:**

| Lower (0–10 %) | Higher (50–100 %) |
| --- | --- |
| Minimal extra questions after first round | Deep coverage at the cost of more follow-up rounds |
| Risks shipping a PRD with unresolved ambiguities | May feel exhaustive for simple tickets |

**When to change:**

- Raise for high-stakes tickets where missed requirements are expensive.
- Lower or zero for tickets where you trust your initial answers are complete.

**See also:** [Ticket Flow → Coverage Follow-Up Budget](/ticket-flow#coverage-follow-up-budget)

---

### Interview Coverage Passes

**Type:** integer  
**Default:** 2  
**Range:** 1–10

Caps how many times `VERIFYING_INTERVIEW_COVERAGE` may run follow-up cycles before LoopTroop stops extending the loop and advances to interview approval regardless of remaining gaps.

**What happens at the cap:**

When this limit is reached, LoopTroop moves to `WAITING_INTERVIEW_APPROVAL` with whatever coverage state exists. Any unresolved gaps are visible to you at approval time.

**Trade-offs:**

| Lower (1–2) | Higher (5–10) |
| --- | --- |
| Faster path to interview approval | More thorough gap-filling before approval |
| May leave small coverage gaps for you to notice at approval | Can feel slow on well-scoped tickets |

**See also:** [Ticket Flow → Interview Coverage Passes](/ticket-flow#interview-coverage-passes)

---

### PRD Coverage Passes

**Type:** integer  
**Default:** 5  
**Range:** 2–20

Caps how many revision cycles `VERIFYING_PRD_COVERAGE` may run while reconciling the PRD against the winning model's Full Answers artifact.

Each pass reads the current PRD candidate, identifies gaps relative to that winning Full Answers artifact, and rewrites the candidate in-place. When coverage is clean or the cap is reached, LoopTroop advances to `WAITING_PRD_APPROVAL`.

**What you see at approval:**

If the cap was reached before coverage was clean, unresolved gap warnings appear on the PRD approval screen. You can still approve with gaps, edit the PRD manually, or click `Fix gaps with AI` to run one fresh targeted extra fix and one fresh coverage check. These approval-screen extra fixes are manual and unlimited; this pass setting only controls the automatic coverage loop before approval.

**Trade-offs:**

| Lower (2–3) | Higher (10–20) |
| --- | --- |
| Faster PRD approval, smaller token cost | Higher chance of a complete PRD before you review |
| More manual editing may be needed at approval | Slower for large PRDs with many gaps |

**See also:** [Ticket Flow → PRD Coverage Passes](/ticket-flow#prd-coverage-passes)

---

### Beads Coverage Passes

**Type:** integer  
**Default:** 5  
**Range:** 2–20

Caps how many revision cycles `VERIFYING_BEADS_COVERAGE` may run while reconciling the semantic bead blueprint against the PRD.

Once coverage is clean or this cap is reached, LoopTroop advances to `EXPANDING_BEADS`, which is a separate step that converts the blueprint into execution-ready bead records. If unresolved gaps are still visible on the later beads approval screen, you can click `Fix gaps with AI` to run one fresh targeted extra fix and one fresh coverage check; if the semantic blueprint changes, expansion is rerun so the approval plan stays current. These approval-screen extra fixes are manual and unlimited; this pass setting only controls the automatic coverage loop before approval.

::: tip
`EXPANDING_BEADS` runs independently after `VERIFYING_BEADS_COVERAGE` finishes. Increasing this setting does not affect the expansion step — it only controls the semantic blueprint revision loop.
:::

**Trade-offs:**

| Lower (2–3) | Higher (10–20) |
| --- | --- |
| Faster path to beads approval | Higher chance of a coverage-clean blueprint |
| More likely to miss PRD requirements in the bead plan | Slower for large or complex PRDs |

**See also:** [Ticket Flow → Beads Coverage Passes](/ticket-flow#beads-coverage-passes)

---

## Pre-Implementation

### Git Hook Policy

**Type:** three-choice policy
**Default:** **Validate** (recommended)

Choose how LoopTroop handles repository hooks. The same linked buttons appear in Configuration, Project **Advanced** settings, and the new-ticket **Advanced** settings; Draft tickets can also change their choice before Start. The active inherited choice is highlighted, so there is no separate or duplicate **Inherit** option. Hovering each button summarizes whether hooks are bypassed, whether explicit checks run, and whether a hook can block an internal Git operation.

| Choice | Stored value | What LoopTroop does |
| --- | --- | --- |
| **Validate** (recommended) | `validate_explicitly` | Bypasses hooks on LoopTroop-owned Git operations, then runs the visible approved validation commands during setup and again before integration |
| **Ignore** | `ignore_internal_only` | Bypasses hooks on LoopTroop-owned Git operations and records that hook validation was skipped |
| **Run** | `use_on_internal_commits` | Lets Git run repository hooks normally on LoopTroop-owned commits and pushes; it does not add separate hook-equivalent commands |

**Validate and Run are not the same.** Validate turns off hooks for internal Git commands and performs the approved checks explicitly, where they are visible and auditable. Run leaves the repository hooks active inside those Git commands, so a hook can directly block an internal commit or push.

Resolution is deterministic:

1. a non-null ticket `gitHookPolicy` wins;
2. otherwise a non-null project `gitHookPolicy` wins;
3. otherwise the profile `gitHookPolicy` is used.

LoopTroop freezes the effective choice and its source when the ticket starts. Only Draft tickets may change the ticket override, and later profile or project edits do not change a started ticket. The approved execution setup plan records the ticket-specific policy alongside detected hooks and editable validation commands.

Execution setup shows detected hooks as read-only evidence and lets you add, edit, reorder, or remove validation commands. An unknown hook never causes LoopTroop to invent an ecosystem-specific command. Removing all validation commands is allowed and the approval receipt records that exact decision.

This policy affects only LoopTroop's internal Git operations. It does not alter the repository's hook configuration for your own Git commands. The `?` beside each control opens this section.

---

## Implementation & Workspace Setup

### Per-Iteration Timeout

**Type:** integer (seconds)  
**Default:** 1200 s (20 minutes)  
**Range:** 0–3600 s

The maximum runtime for a single bead attempt in `CODING`, including implementation, agent-owned bead-scoped checks, and structured completion. Planned test commands are starting guidance and may be adapted when repository evidence requires it; LoopTroop does not independently rerun them after `done/pass`. If the deadline expires before valid completion, LoopTroop treats it as a failed iteration and routes it through the standard Ralph retry path. This timeout is separate from OpenCode/provider interruption handling, which can preserve an addressable session for Continue. Ticket-level Final Testing remains a separate mandatory gate.

**What retry means here:**

LoopTroop generates a context wipe note summarizing the failure when possible, abandons the timed-out session so stale completions cannot finalize the bead, resets the worktree to the bead's start snapshot, opens a fresh OpenCode session, and retries — up to `Max Bead Retries` times. Repeated iteration timeouts consume this same attempt budget; once it is exhausted, CODING blocks with `BEAD_RETRY_BUDGET_EXHAUSTED`.

**Trade-offs:**

| Lower | Higher |
| --- | --- |
| Fails faster on stuck sessions | Allows more time for large beads or slow models |
| Wastes less time on runaway coding loops | Risk of waiting a long time before a stuck session is aborted |

**When to change:**

- Increase for beads that involve large test suite runs, slow builds, or high-latency tool calls.
- Decrease for projects where you want fast failure feedback and the model tends to get stuck.
- Setting to 0 disables the timeout (not recommended for production use).

**See also:** [Beads & Execution → Per-Iteration Timeout](/beads#per-iteration-timeout)

---

### Execution Setup Timeout

**Type:** integer (seconds)  
**Default:** 1200 s (20 minutes)  
**Range:** 0–3600 s

The maximum total active-work budget for one `PREPARING_EXECUTION_ENV` attempt, which runs after the setup plan is approved and before any coding begins. One deadline is shared by session acquisition, the initial and fallback prompts, OpenCode provider recovery, progress continuations, structured-output corrections, setup-scoped online lookup, backend wrapper/probe/hook validation, worktree inspection, and retry-note generation. None of those steps restarts the current attempt's clock.

**What execution setup does:**

The setup phase can materialize user-approved ignored or untracked files and directories from the original checkout, install user-space toolchains under `.ticket/runtime/execution-setup/tool-cache`, warm caches, build native dependencies, or prepare repository-local runtime artifacts. It runs in the ticket's worktree before coding, records reusable wrapper commands when prepared runtime environment variables are needed, and validates declared tooling probes, repository-level workspace probes, and approved explicit Git-hook commands before the workflow enters coding. Setup follows repository evidence without assuming a language, build system, package manager, shell, or operating system. LoopTroop automatically recovers the canonical executable `.ticket/runtime/execution-setup/run` when a setup result omits its declaration, records the repair, and uses a non-login nested shell so the wrapper's prepared `PATH` is preserved. The agent must return an honest `ready` result when every check passes or `blocked` when any check fails; only ready profiles become reusable runtime state. If required launcher setup fails, a blocked profile records `tool_requirements.provisioning_attempts` evidence showing distinct attempted temp-root provisioning strategies and commands, or why no safe provisioning path exists. Workspace inputs have no size limit and use the setup plan approval gate rather than a separate configuration setting. Manual approval authorizes the listed paths. A future unattended mode must limit materialization to paths covered by a project allowlist.

The long setup timeout remains available for real provisioning work such as toolchain downloads. When a completed setup turn contains only a short progress update, LoopTroop continues the same session up to two times without consuming a setup attempt or structured-output repair, but each continuation receives only the time remaining on the current attempt. Completed but malformed results use the separate Structured Output Retries setting under that same deadline. OpenCode Retry Limit and Retry Grace Window still apply within each prompt, but cannot extend the setup attempt beyond its deadline. A third progress-only response fails that attempt with a plain incomplete-setup explanation. Actionable blocked results can use the normal setup-attempt budget; a blocked result proving that no safe provisioning path exists stops immediately.

Every genuine automatic, tooling-persistence, manual, or user-requested retry receives a new full Execution Setup Timeout budget. When setup exhausts its automatic retry budget, **Retry with extra note...** can grant one manual setup attempt. This does not raise or replace the configured retry budget. It sends the entered text directly to the preserved setup session for that one attempt.

When the deadline expires, LoopTroop stops scheduling new setup work and returns a setup-timeout error. Process termination, session cleanup, safe worktree reset, and approved-input rematerialization may finish just after the deadline so a later retry starts safely; cleanup does not consume the new attempt's budget. A timeout before session creation is still an ordinary failed setup attempt and is eligible for configured retries.

**Trade-offs:**

| Lower | Higher |
| --- | --- |
| Fails fast if setup is stuck or misconfigured | Allows more time for heavy installs or slow network downloads |
| Fine for repos with no heavy setup step | Needed if setup involves large dependency downloads |

**When to change:**

- Increase for projects with heavyweight setup steps such as installing toolchains, running `docker pull`, or bootstrapping large `node_modules`.
- Leave at default for most repos where setup runs in seconds or is not needed.
- Setting to 0 disables the aggregate setup deadline; existing command-level safety limits still apply.

**See also:** [Beads & Execution → Execution Setup Timeout](/beads#execution-setup-timeout)

---

### Max Bead Retries

**Type:** integer  
**Default:** 5  
**Range:** 0–20

How many fresh-session re-attempts LoopTroop allows for a failing bead before it enters `BLOCKED_ERROR`. The same limit is also used for final-test retries in `RUNNING_FINAL_TEST`.

**What "fresh session" means:**

Each retry discards the polluted conversational state from the failed attempt, resets the worktree to the bead's start commit, opens a brand-new OpenCode session, and starts over with the context wipe note from the previous attempt as context. See [Beads & Execution — Bounded Ralph-Style Retry](/beads#bounded-ralph-style-retry) for the full design rationale.

Startup and manual-retry recovery can avoid a fresh attempt when the interrupted bead already has a current matching `bead_execution` checkpoint or an explicitly preserved session continuation. In those cases LoopTroop finalizes the checkpointed result or continues the exact session. An otherwise unresumable in-progress attempt is appended to Failed Iteration Notes, safely reset, and advanced to the next iteration under this retry budget. Its replacement receives a fresh per-iteration timeout window.

**Trade-offs:**

| Lower (0–2) | Higher (10–20) |
| --- | --- |
| Fails fast, lower token cost | More attempts before giving up |
| Less tolerance for transient model failures | Useful for flaky tests or non-deterministic environments |
| 0 means zero retries — the first failure immediately blocks | High values can mask persistent coding problems |

**When to change:**

- Lower for tickets in well-understood codebases where repeated failures usually indicate a real problem, not a fluke.
- Raise for greenfield work, unstable test suites, or providers with high per-call variance.
- Setting to 0 effectively disables retry: any iteration failure immediately blocks the bead.

**See also:** [Beads & Execution → Max Bead Retries](/beads#max-bead-retries)

---

## Logging

These three settings control how much of each tool call is stored in the LoopTroop logs. They do not affect what the model sees during execution — only what is persisted for display in the UI and diagnostics.

The backend reads these caps live from the profile, but it caches them briefly to avoid a database read on every stream event. In practice, a change usually shows up quickly without requiring a restart, but it may not affect lines already emitted moments earlier.

### Tool Input Max Chars

**Type:** integer (characters)  
**Default:** 4,000  
**Range:** 500–50,000

Hard cap on the number of characters stored for tool inputs in the execution log. Input beyond this limit is truncated at log write time.

**When to change:**

- Increase if log entries for write-heavy tools (large file writes, bulk inserts) are being cut off and you need the full content for debugging.
- Decrease to reduce database size in long-running or high-throughput tickets.

---

### Tool Output Max Chars

**Type:** integer (characters)  
**Default:** 12,000  
**Range:** 1,000–100,000

Hard cap on the number of characters stored for tool outputs in the execution log.

Tool outputs are typically larger than inputs (think: test run output, command stdout, file read results), which is why the default is higher than the input cap.

Internal `SYS > CMD` entries are logged after command completion. Quiet deterministic commands use concise summaries, while real stdout/stderr remains capped here.

**When to change:**

- Increase if you need to see the full output of long test suites or verbose build commands in the log.
- Decrease for projects where tool outputs are consistently short and you want to reduce storage pressure.

---

### Tool Error Max Chars

**Type:** integer (characters)  
**Default:** 6,000  
**Range:** 500–50,000

Hard cap on the number of characters stored for tool errors in the execution log.

Error output is usually more compact than stdout but often more important to preserve for debugging, which is why the default is between the input and output caps.

**When to change:**

- Increase if stack traces or compiler errors are being truncated in a way that makes debugging difficult.
- Decrease if error output is consistently short for your stack.

**See also:** [Beads & Execution → Tool Log Truncation](/beads#tool-log-truncation)
