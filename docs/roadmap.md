---
search: false
---

# Roadmap

> **Roadmap status:** This roadmap is a living planning document, not the definitive source of current product status. It was started before the app existed, and items have been added continuously during development. Some entries may already be implemented, partially complete, changed, or no longer relevant. Verify the current codebase, tickets, and release notes before treating any item as still pending or authoritative.

## Contents

- [High Priority](#high-priority)
- [Medium Priority](#medium-priority)
- [Low Priority](#low-priority)

## High Priority

*   **Website and Documentation Repository Separation (clean application repository):** Move the marketing website and published documentation source out of the LoopTroop application repository while preserving the existing public URLs, release/version behavior, and contributor-facing documentation links.
    *   Create a dedicated website/documentation repository and move the site-owned source and build boundary into it: `web.html`, the landing-page stylesheet source (`src/web.css` or an extracted site-specific equivalent), `scripts/build-site.mjs`, `vercel.json`, VitePress configuration/theme files, documentation Markdown, documentation media, and site-only build dependencies/configuration.
    *   Move website-only assets with their owning source, including landing-page screenshots, social/SEO images, fonts, `robots.txt`, `sitemap.xml`, and other assets used only by the marketing or documentation site. Do not move the entire `public/` directory without an ownership audit.
    *   Audit every asset and reference shared by the app and website (especially logos, favicons, fonts, README screenshots, and public paths). Keep app-owned assets in the application repository, replace app references before removal, and define an explicit synchronization rule if an asset must temporarily exist in both repositories.
    *   Preserve `https://www.looptroop.ovh/` and `https://www.looptroop.ovh/docs/` routes, canonical links, SEO metadata, social previews, and README links after the deployment moves to the dedicated repository.
    *   Decide how repository-rendered documentation and README media will work after the move: use stable hosted URLs or retain only the minimum app-owned copies needed for GitHub and local contributor workflows. No broken relative image links may remain.
    *   Reconfigure Vercel to build the dedicated repository and remove website-only build scripts, dependencies, configuration, and assets from the application repository once the new deployment is verified.
    *   Keep application version and release information synchronized with the website without reintroducing a source dependency on the application checkout; validate that site version badges, documentation links, and release notes remain correct.
    *   Add CI checks for both repositories: the application build must not depend on website files, and the website build must fail clearly when required documentation, media, or shared asset inputs are missing.
    *   Define the migration boundary for existing Git history separately from the forward-looking repository split. If historical removal is required, plan it as an explicit coordinated history rewrite rather than assuming that moving files in a new commit removes them from existing clones or Git history.

*   **Skip Reason Auditability:** Allow users to provide an optional reason any time they skip a step, prompt, question, or approval gate in the app. The reason is persisted in the relevant ticket artifact for auditability and later review.
    *   Add a skip-reason input surface on every user-facing skip action (e.g., skip interview question, skip phase review, skip approval, skip critique/research generation).
    *   The reason must be optional and not block the skip action when left blank; if blank, record `reason: null` explicitly.
    *   Persist the reason in the corresponding artifact (e.g., `interview.yaml`, `critique.yaml`, `research/repository-brief.yaml`, `planning-context.yaml`, phase review receipts) alongside `skipped_at`, `skipped_by`, and the skipped item identifier.
    *   Include skipped item metadata: item id/type, phase/status where skipped, original prompt text or reference, and user-provided reason.
    *   Make skip reasons visible in the ticket UI and export views so users and auditors can review why items were bypassed.
    *   Ensure skip reasons are treated as user-generated planning context, not as agent instructions, and do not alter model behavior beyond being available for downstream human review.
    *   Add a `doctor` check that flags skips without reasons when the project policy requires reasons, and report aggregate skip statistics per ticket.
*   **Context Slimming Pipeline (per-phase input/output field audit + deterministic strip-and-store contract):** For every workflow phase, manually audit which fields the AI model outputs and which fields downstream phases actually consume, then strip unused fields from the canonical context so future model calls receive slimmer input while stripped data is preserved for UI display and forensic audit.
    *   Audit each phase input and output, status by status, starting with the first (`DRAFT`) and proceeding sequentially through the full lifecycle.
    *   The AI model must continue to output all fields it currently outputs; no model-side changes are required.
    *   After the model returns output, the app applies a deterministic strip pass that removes fields not consumed by any downstream phase, UI surface, or audit/log contract.
    *   Stripped data must be persisted to a companion artifact (`.looptroop/tickets/<ticket-id>/context/stripped-<phase>-<attempt>.json`) so it remains available for UI rendering, diagnostics, and forensic replay.
    *   The canonical context artifact passed to subsequent phases contains only the slimmed payload; the stripped companion is loaded only when the UI or an audit tool requests it.
    *   Manually classify every output field per phase into one of four ownership classes:
        *   `required_downstream`: consumed by at least one subsequent phase, UI surface, or log contract — kept in canonical context.
        *   `required_display_only`: not consumed by any downstream phase but needed for UI display or user-facing detail views — stripped from canonical context, preserved in stripped companion.
        *   `app_derived`: can be deterministically produced by the LoopTroop app itself without AI involvement (e.g., timestamps, IDs, status metadata, computed totals, derived summaries from already-available data, cross-references to existing artifacts, sequence numbers, file-path resolutions, and any field whose value is a pure function of data the app already has) — removed from the AI output schema entirely so models never waste tokens generating them; the app populates these fields deterministically after model output is received.
        *   `obsolete`: not consumed by any downstream phase, UI surface, or log contract, and cannot be produced by the app — stripped from canonical context and preserved in stripped companion with `obsolete: true` marker for future manual removal.
    *   After initial audit, physically remove all `obsolete` and `app_derived` fields from the AI output schema (prompt + structured-output validation) so models no longer waste tokens generating them.
    *   For every `app_derived` field, implement a deterministic derivation function in the app that produces the same value the AI would have produced (or a strictly better one, since the app has full access to runtime state). Persist the derivation function reference in the field manifest (`derivation_fn`, `derivation_inputs[]`) so audits can verify correctness.
    *   The `app_derived` classification must be conservative: only classify a field as `app_derived` when the app can produce the value with zero ambiguity (no creative/AI judgment required). If a field's value depends on interpretation, summarization, or subjective judgment, it remains in `required_downstream` or `required_display_only` even if the app could produce an approximation.
    *   When an `app_derived` field is removed from the AI output schema, update the prompt to instruct the model that the field is no longer needed — this reduces both output tokens and prompt complexity, since the model no longer needs to be told what format to produce for that field.
    *   Track estimated token savings from `app_derived` removal separately in strip receipts (`app_derived_tokens_saved_estimate`) alongside the existing `tokens_saved_estimate` so the impact of app-side derivation vs. pure stripping is measurable in isolation.
    *   Persist the field-classification manifest at `.looptroop/tickets/<ticket-id>/context/field-manifest-<phase>.yaml` with per-field entries: `field_path`, `class`, `consumed_by[]`, `first_audit_at`, `last_verified_at`.
    *   For every retry path (structured retry, coverage-retry loop, context-wipe retry, model-fallback retry), also audit which additional fields the retry adds to the context and classify them the same way; persist retry-specific entries in the field manifest with `retry_kind` and `retry_added_fields[]`.
    *   If a retry variant introduces new fields not present in the base phase output, the strip pass must handle those fields independently and not carry them forward unless a downstream phase explicitly consumes them.
    *   Context pack assembly (`buildMinimalContext`) must consume only the slimmed canonical artifacts; stripped companions are never injected into model prompts.
    *   Add token-savings telemetry per phase: persist `tokens_saved_estimate`, `fields_stripped_count`, `fields_kept_count` in each strip receipt so the impact of slimming is measurable.
    *   Strip receipts must be deterministic: same input always produces the same slimmed output and the same stripped companion, enabling reproducible context-pack audits.
    *   UI must transparently show both the slimmed context (what the model saw) and the full context (with stripped data re-attached) so users can verify nothing important was lost.
    *   When a downstream phase is found to need a previously stripped field, update the field manifest (`required_downstream`), add the consuming phase to `consumed_by[]`, and stop stripping that field from that point forward — no schema migration required.
    *   Add `Doctor` validation that checks every field manifest against actual runtime consumption and warns on stale classifications (fields marked `required_downstream` but never consumed, or fields marked `obsolete` that are actually consumed).
    *   Audit order (status by status, starting with first): `DRAFT` → `SCANNING_RELEVANT_FILES` → `COUNCIL_DELIBERATING` → `COUNCIL_VOTING_INTERVIEW` → `COMPILING_INTERVIEW` → `WAITING_INTERVIEW_ANSWERS` → `VERIFYING_INTERVIEW_COVERAGE` → `WAITING_INTERVIEW_APPROVAL` → `DRAFTING_PRD` → `COUNCIL_VOTING_PRD` → `REFINING_PRD` → `VERIFYING_PRD_COVERAGE` → `WAITING_PRD_APPROVAL` → `DRAFTING_BEADS` → `COUNCIL_VOTING_BEADS` → `REFINING_BEADS` → `VERIFYING_BEADS_COVERAGE` → `EXPANDING_BEADS` → `WAITING_BEADS_APPROVAL` → `PRE_FLIGHT_CHECK` → `GENERATING_EXECUTION_SETUP_PLAN` → `WAITING_EXECUTION_SETUP_APPROVAL` → `PREPARING_EXECUTION_ENV` → `CODING` → `RUNNING_FINAL_TEST` → `INTEGRATING_CHANGES` → `CREATING_PULL_REQUEST` → `WAITING_PR_REVIEW` → `CLEANING_ENV` → `COMPLETED`.
    *   For each status, document: input fields consumed, output fields produced, output fields actually used downstream, and fields added by any retry path.
* **Global CLI Distribution & Multi-Platform Packaging (automated release pipeline):** Refactor the LoopTroop runtime architecture from a dev-centric multi-process concurrent stack into a production-ready global CLI daemon, and implement an automated release workflow that cross-compiles, packages, and synchronizes system package managers on every GitHub Release.
	+ **Automated Version Synchronization on Release:** When a new GitHub Release is created (or a version tag is pushed), automatically propagate the release version number to every file in the repository that references it, so no location is left stale.
		- Treat the `version` field in `package.json` as the single canonical source of truth for the application version.
		- On release trigger, bump `package.json` to the release version (if not already set) and regenerate `package-lock.json` via `npm install --package-lock-only` so both files stay in sync.
		- Sweep all tracked files for hardcoded occurrences of the previous version string and replace them with the new version, covering at minimum: documentation pages, website content (`web.html` `{{VERSION}}` placeholders), configuration files, and any other source or asset that embeds the version literal.
		- Files that already resolve the version dynamically at build or runtime (e.g., `scripts/build-site.mjs` reading `package.json`, `src/components/config/AboutDialog.tsx` importing `package.json`) require no modification but must be validated as part of the sweep.
		- Exclude historical records from replacement: `CHANGELOG.md` version headers, git tags, and transitive dependency versions inside `package-lock.json` must never be rewritten.
		- After the bump, run a deterministic post-sync validation that greps all tracked files for the previous version string and fails the workflow if any non-excluded stale reference remains.
		- Commit the version-bump changes back to the release branch (or tag) with a deterministic commit message (e.g., `chore(release): bump version to <version>`) before any downstream compilation, packaging, or publishing jobs execute.
		- The step must be idempotent: re-running on the same release version is a no-op when every file already carries the correct version.
	+ **Single-Process Production Compilation (CLI Daemon Mode):** Combine the four concurrent development processes (Vite frontend, Node backend API, documentation server, and OpenCode watcher) into a single production compilation unit.
		- The frontend Vite workspace must build statically to `dist/frontend` during compile time.
		- The Express/Fastify backend server must be updated to serve these static files natively, routing all non-API web traffic to `dist/frontend/index.html` to support the client-side SPA router.
		- Spawning external hot-reloaders or dev-servers at runtime must be disallowed in production execution.
	+ **Global User-Space Configuration Separation:** Remove reliance on local `.env` files in the installation directory, which is read-only in global installation environments.
		- Move state configuration to a user-space configuration file: `~/.config/looptroop/config.json` (on Linux/macOS, honouring `XDG_CONFIG_HOME`) or `%APPDATA%\looptroop\config.json` (on Windows). **Done in 0.5.0:** the resolver lives in `server/lib/appConfigDir.ts` and is covered by cross-platform tests.
		- Provider credentials are explicitly out of scope. LoopTroop reads no provider API keys; they live in OpenCode's own configuration and are never handled here.
		- Fall back to standard environment variables only if the configuration directory/file is missing or unreadable.
		- No migration receipts are needed: there is no prior on-disk configuration format to migrate from.
	+ **OIDC-Protected Registry Publication (npm, Bun, and pnpm):** Configure a secure, automated publishing pipeline using OpenID Connect (OIDC) "Trusted Publishing" with npmjs.com.
		- On publication of a GitHub Release, compile production JavaScript targets, bundle the static assets, and run `npm publish` securely without storing long-lived, static npm tokens in GitHub secrets.
		- Ensure the published package maps the main executable entrypoint to `"bin": { "looptroop": "dist/cli.js" }` so that `npm i -g`, `bun add -g`, and `pnpm add -g` work natively.
	+ **Matrix Binary Compilation & Release Assets:** Configure a GitHub Actions runner matrix to compile standalone binaries for target platforms (`macos-x64`, `macos-arm64`, `linux-x64`, `win-x64`) using `@yao-pkg/pkg`, `bun build --compile`, or Node's Single Executable Applications. The original `pkg` project is archived and must not be used.
		- Package compiled binaries inside `.tar.gz` (for macOS/Linux) and `.zip` (for Windows) containers.
		- Automatically upload package archives to the matching GitHub Release assets on release confirmation.
		- Generate a SHA-256 checksum manifest (`checksums.sha256`) and publish it alongside the release assets.
	+ **Homebrew Tap Automation (`brew install looptroop-ai/tap/looptroop`):** Automate formula updates in your custom Tap repository `looptroop-ai/homebrew-tap` during the release workflow.
		- The pipeline must commit a updated Ruby Formula (`Formula/looptroop.rb`) dynamically targeting the newly generated archive URLs and their corresponding SHA-256 hashes.
	+ **Arch Linux AUR Pipeline (`paru -S looptroop-bin` / `yay -S looptroop-bin`):** Automate the generation and submission of Arch User Repository package updates.
		- On release, clone the AUR SSH repository `aur.archlinux.org/looptroop-bin.git`.
		- Update the `PKGBUILD` source arrays and checksums with the latest Linux x64 release asset parameters.
		- Execute `makepkg --printsrcinfo > .SRCINFO` to update package metadata, commit, and push changes back to the AUR master branch.
	+ **Windows Scoop & WinGet Automation:** Maintain compatibility across primary Windows package management environments.
		- The release action must commit the updated Windows target URLs and checksums to the app manifest file inside your custom `scoop-bucket` repository.
		- Integrate the `wingetcreate` or equivalent automated tool into the workflow to automatically submit PR manifests to the upstream `microsoft/winget-pkgs` repository.
	+ **Universal Installer Script (`curl | bash`):** Maintain a static shell script at `install.sh` in the root of the primary branch, exposed via a clean rewrite at `looptroop.ovh/install`.
		- The script must query the system `uname -s` and `uname -m` variables to dynamically resolve platform and architecture.
		- Fetch the corresponding pre-compiled archive from the latest GitHub Release, extract the binary, and map it into `/usr/local/bin` using safe system permissions.
	+ **Declarative Nix Flake Packaging (`nix profile install github:looptroop-ai/LoopTroop`):** Add a declarative `flake.nix` file to the root of your primary repository.
		- The flake must define a zero-dependency derivation wrapping the compiled Linux/macOS binaries.
		- Automate the Nix registry updates so developers using declarative shell workspaces can test or execute LoopTroop instantly inside clean, immutable sandbox environments.
    + **Number of downloads:** On the main website, the current terminal that shows how to install LoopTroop will be replaced with multiple tabs for each installation method, the first being the universal installer script. Underneath this terminal, show a total number of downloads, which is an aggregated counter of all installs across all package managers. When clicking on that counter, a new small window will be shown with all the details, e.g., npm has 100 downloads and an official link where details can be shown (if such a thing exists per package manager). It will also show the number of stars, forks, watchers, issues, and PRs for the repo. This number of stars will also be shown next to the counter, so it will be "3214 downloads, 245 stars." I want the numbers to refresh 4 times a day; the website is hosted on Vercel right now.
*   **Adversarial Critique Pre-Pass:** After relevant-file scanning and any enabled research briefs, optionally run a bounded ticket-level critique before Interview begins.
    *   Persist `.looptroop/tickets/<ticket-id>/critique.yaml` with verdict, major risks, counterproposals, interview follow-ups, and stop conditions.
    *   Treat the critique as read-only planning context, not a council vote or automatic cancel path.
    *   Default OFF unless enabled by `phase_flags.critique.enabled`; lock mode at `START`.
    *   Require each major risk to cite a ticket assumption, repository/research evidence, or missing constraint.
    *   Surface the approved critique summary in review UI so users can carry forward or dismiss generated follow-ups explicitly.
    *   Keep council-side `adversarial_critique` as artifact-level critique during Interview/Proposal/Options/Design/Beads.
    *   Editing an approved critique invalidates Interview + Proposal + Options Synthesis + Design + Beads.
*   **Repository Research Brief:** After relevant-file scanning, optionally generate a compact read-only brief of repository facts before critique/interview planning.
    *   Persist `.looptroop/tickets/<ticket-id>/research/repository-brief.yaml` with summary, invariants, relevant paths, reuse candidates, and unknowns.
    *   Briefs must cite concrete files/artifacts and avoid selecting the solution.
    *   Default `auto` for scoped/full planning profiles and OFF for minimal profile.
    *   Use scan output, repo-discovery/codebase-map artifacts, and planning context when available; preserve provenance back to source artifacts.
    *   Regeneration should update only factual claims and must not rewrite approved planning decisions.
    *   Make the concise summary available to Critique, Interview, Proposal, Options Synthesis, Design, and Beads.
*   **Post-interview planning context refresh:** After interview approval, add a mandatory `REFRESHING_PLANNING_CONTEXT` phase before PRD drafting.
    * Transition: `WAITING_INTERVIEW_APPROVAL` -> approve -> `REFRESHING_PLANNING_CONTEXT` -> `DRAFTING_PRD`.
    * This phase runs for every ticket.
    * It reconciles the original ticket-based relevant-file scan with the approved interview answers, skipped-question metadata, current repository state, repo map/index entries, and direct code search results.
    * Replace downstream `relevant_files` context with a new canonical `planning_context` artifact for all future phases.
    * Keep the original relevant-files output only as the initial seed / debug artifact; future phases should consume `planning_context`, not `relevant_files`.
    * Output `.looptroop/tickets/<ticket-id>/context/planning-context.yaml`.
    * Also output `.looptroop/tickets/<ticket-id>/context/planning-context-refresh-receipt.json` with input hashes, refresh result, warnings, and reason codes.
    * `planning-context.yaml` must include:
      * selected files with priority, role, reason, and evidence references;
      * newly added files discovered from interview answers or code search;
      * files demoted or removed from the initial scan, with reasons;
      * relevant symbols, routes, APIs, configs, tests, commands, and docs when detectable;
      * skipped-question topics that may affect implementation context;
      * confidence score and warnings.
    * File role should be explicit: `modify`, `read_for_interface`, `read_for_pattern`, `test`, `config`, `docs`, or `risk_only`.
    * A ticket with no meaningful context changes still writes `planning-context.yaml` and a receipt with `result: no_change`.
    * All PRD council members receive the same `planning_context` before per-model Full Answers and PRD drafting start.
    * Do not fill skipped interview answers in this phase; only record which skipped topics may affect implementation context.
    * If an approved interview is edited after this phase, invalidate downstream PRD/Beads artifacts and restart from `REFRESHING_PLANNING_CONTEXT`, not directly from `DRAFTING_PRD`.
    * Prefer repo index / repo map / changed-only refresh when available; fall back to full scan-style discovery only when the index is missing, stale, or low-confidence.
    * Combine semantic search, grep/text search, path matching, symbol lookup, and the original relevant-file scan instead of relying on only one retrieval method.
    * Keep context bounded: store enough evidence and references to explain why files were selected, but do not dump large full-file contents into the artifact unless required.
    * Add a future UI surface to show `planning_context`, pinned files, demoted files, ignored files, and "why selected" explanations.
    * Add a legacy migration alias so existing prompts/components that still request `relevant_files` receive `planning_context` until all phases are updated.
*   **Optimize components:** Update each component to latest stable and optimize each component of the app, after creation, using ref.tools mcp that can read latest version of docs plus exa mcp that can search the internet and skill for each component.
*   **Other council members:** Implement other AI council members into the flow - at least at final test creation. If TDD is implemented, the test should be created before execution has started.
*   **WYSIWYG editor:** A human-friendly editor for markdown files.
*   **Comments section:** Per phase users can add comments and discuss changes, without affecting the agent's behavior.
*   **Extra safety:** Secrets and sensitive data should not be added to any file in the `.looptroop` folder.
*   **Knowledge Harvest Pipeline (Documentation + Agents memory):** [I1](https://github.com/mj-meyer/choo-choo-ralph/blob/main/docs/workflow.md#step-5-harvest-learnings)
    *   After each ticket reaches `COMPLETED`, run a deterministic harvest pass that scans bead notes, execution logs, and commit receipts for structured `LEARNING` and `GAP` entries.
    *   Generate `.looptroop/tickets/<ticket-id>/harvest-plan.md` containing proposed docs updates, proposed `agents.md` updates, and proposed follow-up beads for unresolved gaps.
    *   **Agents.md (structured memory contract):** [I1](https://github.com/snarktank/ralph/blob/main/prompt.md#update-agentsmd-files)
        *   Keep one project-level `agents.md` as long-term memory per project (while beads are short-term memory).
        *   After each completed ticket, extract reusable learnings from notes/logs/diffs and propose updates (only if necessary). If it does not exist yet, create it and then update it.
        *   Write only reusable guidance: local conventions, cross-file dependencies, recurring gotchas, validation commands, module constraints, limitations, implementation patterns, and hard limits.
        *   Do not write ticket-specific temporary notes, raw error spam, or one-off implementation details.
    *   Include deduplication against existing docs/agents so duplicate guidance is not re-added.
    *   Require user review with explicit action per item: `approved` or `rejected`.
    *   Apply only approved items and persist `harvested_at`, `source_bead_ids`, and `applied_by`.
    *   Persist memory candidates in `.looptroop/tickets/<ticket-id>/memory-candidates.yaml` with lifecycle state: `candidate`, `approved`, `rejected`, `superseded`.
    *   Memory candidate records must include: `memory_id`, `category`, `evidence_refs`, `source_bead_ids`, `status`, `reviewed_by`, `reviewed_at`, `superseded_by`, `source_tag`, `private` (boolean), `scope_path`.
    *   Add hierarchical scope paths for memory retrieval (examples: `/project/<project-id>`, `/project/<project-id>/repo_conventions`, `/ticket/<ticket-id>/runtime_lessons`).
    *   Add read-slice retrieval mode: combine multiple approved scopes in one query while hiding private scope entries unless source matches.
    *   Add deterministic memory retrieval priority for execution context: `safety_rules` -> `repo_conventions` -> `validation_commands` -> `historical_notes`.
    *   Enforce bounded memory injection budget with deterministic top-k selection and explicit skip reasons for excluded memories.
    *   Archive final plan at `.looptroop/tickets/<ticket-id>/archive/harvest-plan-<date>.md`.
*   **Date-Stamped Ticket Archive + Living Project Spec (delta-merge contract):**
    *   On transition to `COMPLETED`, copy the full ticket folder to immutable archive path `.looptroop/archive/YYYY-MM-DD-<ticket-id>/`.
    *   Persist archive index at `.looptroop/archive/index.jsonl` with `ticket_id`, `archived_at`, `source_path`, `archive_path`, `source_commit`, and `snapshot_hash`.
    *   Add scheduled ticket-artifact backups (not only completion archive) under `.looptroop/backups/tickets/<ticket-id>/<timestamp>/` so backups stay inside the LoopTroop directory.
    *   Backup scope must include `interview.yaml`, `prd.yaml`, `beads/main/.beads/issues.jsonl`, `state.yaml`, `execution-log.jsonl`, `execution-log.debug.jsonl`, and `execution-log.ai.jsonl` with a backup manifest (`created_at`, `artifact_paths[]`, `artifact_hashes[]`, `source_state_version`).
    *   Add retention policy + pruning receipts for backups (default: last `N` snapshots + daily checkpoints).
    *   Add UI restore flow for ticket backups: list snapshots, preview metadata/diff, and restore either full snapshot or selected artifacts.
    *   Restore must be atomic and emit `restore-receipt-<timestamp>.json` with `restored_from`, `restored_paths`, `operator`, and `rollback_result` if restore fails.
    *   Run `delta merge` from approved planning artifacts into project-level living specs at `.looptroop/project/specs/<domain>.md`.
    *   Delta merge rules:
        *   `ADDED`: append new requirement entries to target domain spec.
        *   `MODIFIED`: update target requirement and append previous version to `history[]` with `ticket_id` + `date`.
        *   `REMOVED`: remove/strike target requirement and record removal metadata with source ticket.
    *   Domain inference: use ticket epic/domain labels (`auth`, `payments`, `notifications`, etc.); create target domain file if missing.
    *   Merge safety:
        *   non-blocking on failure; write unmapped delta to `.looptroop/tickets/<ticket-id>/unmapped-spec-delta.md`,
        *   persist merge report `.looptroop/tickets/<ticket-id>/spec-merge-report.md`,
        *   require user review of living-spec diff before finalize action.
    *   Add spec visibility surfaces:
        *   CLI command `looptroop spec status` (or equivalent) for cross-domain living-spec status and freshness.
        *   Project UI `Living Spec` view with domain selector and aggregated full-spec reading mode.
    *   Add living-spec conflict policy:
        *   if sequential tickets modify same requirement, emit structured conflict with choices `accept_latest`, `keep_prior`, `merge`.
        *   persist decision receipt with resolver and timestamp.
    *   Add interview/planning context injection:
        *   for `Existing project` tickets, inject relevant living-spec domain excerpts as read-only context.
        *   keep injection bounded and source-cited (`domain`, `requirement_id`, `last_updated_at`).
    *   Add freshness metadata per domain file: `last_updated_at`, `source_ticket_ids[]`; Doctor flags stale domains and recommends refresh bead.
*   **Media upload:** During interviews and in ticket descriptions, users can add images or documents.
    *   Add an option to draw diagrams or anything else the user wants to draw.
    *   This option should be disabled when using non-multimodal LLMs, with a disclaimer explaining why.
*   **Phase 0 Explore + Feasibility + Opportunity Analysis + Audience/JTBD + SLC Release Slicing (planning gate):**
    *   Add an explicit pre-planning phase before Interview/Planning for business-value validation on idea-heavy tickets.
    *   Add ticket-creation action `Explore first` (optional, always available for all scopes including `SMALL`):
        *   Users can ask an open feasibility question before starting formal interview/planning,
        *   use a fast/cheap model for unstructured investigation,
        *   scan codebase map + living specs (if present) and return rough complexity estimate + likely touched files.
    *   Track A `explore`:
        *   open-ended discovery with repository reading and clarification dialogs;
        *   strict no-code-execution / no-project-write guardrail;
        *   Model runs in `thinking_partner` mode (clarify tradeoffs, avoid premature implementation commitments);
        *   No formal artifact by default (ephemeral panel/session);
        *   Optional export as read-only `.looptroop/tickets/<ticket-id>/explore-session.md` or concise `.looptroop/tickets/<ticket-id>/explore-notes.md`;
        *   Allow `Promote to Ticket` to convert exploration into draft ticket text + optional `seed_summary`.
    *   Track B `opportunity`:
        *   business-value validation and prioritization (Opportunity/Audience/JTBD/SLC artifacts below).
    *   Trigger policy:
        *   Track B `opportunity` required for `Fresh project` tickets and `LARGE` scope changes,
        *   Track B `opportunity` optional for `MEDIUM`,
        *   Track B `opportunity` skipped by default for `SMALL` bugfix/maintenance tickets unless user enables it,
        *   Track A `explore` remains optional and available at ticket creation for every scope.
    *   Phase 0 must produce:
        *   `.looptroop/tickets/<ticket-id>/opportunity-brief.yaml`:
            *   problem statement,
            *   target audience,
            *   desired outcome metric(s),
            *   constraints/non-goals,
            *   key assumptions.
        *   `.looptroop/tickets/<ticket-id>/opportunity-map.yaml`:
            *   outcome -> opportunities (customer needs/pain points/desires) -> candidate solutions -> assumption tests.
        *   `.looptroop/tickets/<ticket-id>/opportunity-score.yaml`:
            *   prioritization fields using `Reach`, `Impact`, `Confidence`, `Effort`,
            *   confidence notes and evidence references for each score.
        *   `.looptroop/tickets/<ticket-id>/go-no-go.yaml`:
            *   verdict: `go`, `pivot`, or `no_go`,
            *   rationale,
            *   recommended next action.
    *   Audience/JTBD/SLC contract (existing) remains required:
        *   primary audience (and secondary audience if relevant),
        *   JTBD outcomes per audience,
        *   first release slice using SLC criteria (`Simple`, `Lovable`, `Complete`),
        *   explicit out-of-scope list for the ticket.
    *   Persist artifacts: `.looptroop/tickets/<ticket-id>/audience-jtbd.yaml` and `.looptroop/tickets/<ticket-id>/release-slice.yaml`.
    *   Transition policy:
        *   Interview/Planning (Proposal + Options Synthesis + Design) cannot start unless `go-no-go` is approved (`go` or approved `pivot`) and Audience/JTBD/SLC artifacts are approved.
        *   `no_go` routes ticket to backlog/canceled with archived evidence instead of continuing execution planning.
    *   Iteration policy:
        *   if opportunity verdict or Audience/JTBD/SLC are edited, invalidate downstream Proposal/Options/Design/Beads and require regeneration.
*   **Project Enable Flow + Ticket Entry Mode (idempotent onboarding + discovery + scope triage):**
    *   Before the first ticket in a project, run `Enable Project` (interactive wizard or `--non-interactive` mode) to establish deterministic project defaults.
    *   Add optional `Walkthrough` path for first-time/non-technical users:
        *   Run one planning-only sample ticket (Interview -> Proposal -> Design -> Beads), with no code execution and no project-code writes;
        *   Show where artifacts are stored and how to recover/resume;
        *   Archive walkthrough artifacts at `.looptroop/project/walkthrough/` for later reference.
    *   Enable states:
        *   `none` - no LoopTroop project artifacts exist.
        *   `partial` - some required artifacts exist but validation fails or files are missing.
        *   `complete` - all required artifacts exist and pass validation.
    *   Enable stages (fixed order; idempotent and resumable):
        0. Walkthrough (optional): guided first-run tutorial for non-technical users (planning-only).
        1. Detect: determine enable state (`none`, `partial`, `complete`), discover existing LoopTroop project artifacts, and detect repository runtime/tooling/command candidates.
        2. Preflight: validate discovered artifacts against schemas, generate migration intent (`keep`, `upgrade`, `replace` per artifact), and compute backup plan before any write.
        3. Capture: collect missing inputs (task source, provider defaults, policy profile, timeouts) with prefilled values from detected config when available.
        4. Apply: write or migrate artifacts atomically, preserving previous versions in backup files and recording migration decisions.
        5. Verify & Report: run deterministic validation/doctor checks and emit a final readiness report with blocking/non-blocking findings.
    *   Add init-job lifecycle for enable/workspace bootstrap:
        *   states: `queued`, `running`, `failed`, `completed`, `canceled`
        *   progress stream events must be exposed in the UI and persisted in `.looptroop/project/init-jobs.jsonl`
        *   Provide explicit `retry` action for failed init jobs
    *   Config resolution for setup/teardown and bootstrap scripts must be deterministic (first match wins, no merge):
        1. `~/.looptroop/projects/<project-id>/config.json`
        2. `<ticket-worktree>/.looptroop/config.json`
        3. `<project-root>/.looptroop/config.json`
    *   Persist project-level outputs:
        *   `.looptroop/project/enable-report.yaml`
        *   `.looptroop/project/enable-preflight.yaml`
        *   `.looptroop/project/enable-migration.yaml`
        *   `.looptroop/project/commands.yaml` (canonical `install`, `dev`, `test`, `build`, `lint`, `typecheck`)
        *   `.looptroop/project/enable-history.jsonl`
    *   Non-interactive mode (`--non-interactive`) must produce the same artifacts and validations as interactive mode.
    *   `--force` overwrite is allowed only after preflight + backup plan generation and must emit a post-apply diff report.
    *   When creating a ticket, user must choose:
        *   `Fresh project` - no existing codebase; start from scratch.
        *   `Existing project` - modify an existing codebase.
    *   Add deterministic single-active-ticket start guard (for policies that keep one active ticket per project):
        *   when user attempts to start another ticket while one is active, block with explicit message including `active_ticket_id`, `active_ticket_status`, and allowed actions (`wait`, `open_active`, `cancel_active`);
        *   persist blocked-start receipt at `.looptroop/tickets/<ticket-id>/start-blocked-<timestamp>.json` for auditability.
    *   For `Existing project`, run a read-only codebase mapping pass before planning artifacts are generated:
        *   Explore repository structure and key files with read-only permissions (no writes allowed in this pass).
        *   Spawn parallel mappers for: stack/integrations, architecture/structure, conventions/testing, and risks/concerns.
        *   Save detailed mapping artifacts at `.looptroop/tickets/<ticket-id>/codebase-map/`:
            *   `STACK.md`
            *   `INTEGRATIONS.md`
            *   `ARCHITECTURE.md`
            *   `STRUCTURE.md`
            *   `CONVENTIONS.md`
            *   `TESTING.md`
            *   `CONCERNS.md`
        *   Keep compact `.looptroop/tickets/<ticket-id>/repo-discovery.yaml` as an index that references those files plus canonical commands.
        *   If discovery pass fails, block progression with actionable remediation.
        *   Add provider session discovery pass (read-only) before `change-request.yaml`:
            *   scan provider session stores for sessions whose `cwd` matches the repository (including sessions created before LoopTroop installation),
            *   persist `.looptroop/project/session-discovery.yaml` with `provider`, `session_id`, `last_active_at`, `cwd`, `summary_hint`, and `importable`,
            *   default policy is no auto-import; user explicitly selects sessions to attach as read-only planning context,
            *   unresolved selected sessions produce warning receipts and continue (non-blocking).
    *   Then create a structured change request (`.looptroop/tickets/<ticket-id>/change-request.yaml`) with:
        *   requested change,
        *   affected areas/files,
        *   expected behavior,
        *   constraints/non-goals,
        *   regression risks.
    *   Auto-classify scope:
        *   `SMALL` - usually 1-3 files, no architecture impact.
        *   `MEDIUM` - usually 4-10 files or minor architecture impact.
        *   `LARGE` - 10+ files or architecture-impacting change.
    *   Route planning depth from scope using explicit planning profiles:
        *   `SMALL` -> `profile=minimal` (change request + fast-path planning with optional direct bead generation).
        *   `MEDIUM` -> `profile=scoped` (short intake + scoped Proposal/Options/Design delta + scoped beads).
        *   `LARGE` -> `profile=full` (full interview + full Proposal + Options Synthesis when needed + full Design + scoped beads).
    *   Add ticket-level `execution_profile` selector at creation/start:
        *   `quick` (MVP fast path): single-model planning (`main implementer`) with strict coverage checks.
        *   `council` (default for higher complexity): full multi-model drafting + voting pipeline.
    *   `profile=minimal` defaults to `execution_profile=quick`; allow one-click upgrade to `council` before execution.
    *   Quick-path escalation contract (auto-switch to `council`):
        *   low planning confidence or unresolved ambiguity after coverage verification,
        *   complexity drift beyond `SMALL` thresholds during planning,
        *   user override at any time.
    *   Add planning artifact dependency graph contract per profile:
        *   each profile declares required artifacts and dependencies in deterministic order;
        *   each artifact has runtime state `blocked | ready | done`;
        *   progression is allowed only when dependencies are `done`.
    *   Expose machine-readable planning status at `.looptroop/tickets/<ticket-id>/planning-status.json` with stable fields: `profile`, `artifacts[]`, `state`, `missing_dependencies`, and `next_recommended_step`.
    *   For `MEDIUM` and `LARGE`, require a natural-language `work_scope` and generate one scoped plan artifact per flow:
        *   `.looptroop/tickets/<ticket-id>/plans/IMPLEMENTATION_PLAN.<flow-id>.<scope-slug>.md`
    *   Build mode may read only the active scoped plan and execute the highest-priority open item from that plan; runtime semantic task filtering is disallowed.
    *   If execution drifts outside scope, regenerate the scoped plan (`plan-work`) for the current flow instead of patching ad-hoc filtering rules.
    *   Add deterministic `plan_sync` drift detection after material file edits:
        *   compare step spec expectations (`target_files`, declared interfaces/exports/contracts) against actual implementation changes;
        *   on mismatch, mark step `needs_sync`, append drift evidence to `.looptroop/tickets/<ticket-id>/planning/drift-history.jsonl`, and auto-trigger scoped downstream plan regeneration;
        *   block downstream execution until drift is reconciled or explicitly waived with a persisted decision receipt.
    *   Require explicit user approval of `repo-discovery.yaml` + `change-request.yaml` before execution planning continues.
    *   Allow scope override before approval, but require explicit reason and persist it in ticket artifacts.
    *   Scoped-planning guardrails:
        *   Block scoped planning when active branch/worktree is `main` or `master`;
        *   If scoped plan has uncommitted edits, require explicit overwrite confirmation before regeneration.
    *   **Git Initialization Helper + First Commit Gate:** If the selected project folder is not a Git repository or empty, provide a link to a tutorial on connecting the folder to GitHub (or, in research, implement an automated Git initialization flow with explicit user confirmation).
        *   If the selected folder is not a Git repository, block ticket start and require explicit user choice: `initialize_git` (confirmation required) or `select_different_folder`.
        *   Before any branch/worktree execution path starts, require at least one commit in the repository.
        *   If repository has no commits, block execution with deterministic remediation:
            *   `git add .`
            *   `git commit -m "Initial commit"`
*   **Ticket-Scoped Phase Flags (locked at start):** Extend the ticket start contract with one `phase_flags` object for optional planning/verification behavior.
    *   Include critique, repository research, external research, options synthesis, spikes allowed, manual QA waiver policy, and related budgets.
    *   Persist effective flags in ticket runtime state and approval artifacts.
    *   Treat flags as immutable after `START`, like locked model and coverage settings.
    *   Defaults: critique optional, repository brief auto for scoped/full profiles, external brief optional, options synthesis auto on ambiguity, manual QA required.
    *   Mid-run flag changes require a new planning run or explicit restart, not silent mutation of the active run.
    *   Show effective flags in ticket creation/start UI, phase headers, and diagnostic receipts.
    *   Migrate `execution_profile` into `phase_flags.execution_profile` when this contract lands.
    *   If an upstream approved artifact tied to a flag is edited, downstream invalidation must be deterministic and visible.
    *   *Historical Note (Pre-Consolidation):* This consolidated and replaced several standalone optional phase concepts from earlier roadmap versions:
        *   *Argue the opposite:* An optional step where the main implementer suggests a completely opposite approach to each question's ticket description and interview results to stress-test assumptions.
        *   *Winner model discussion:* An interactive post-winner dialog where the model prompts the user with interesting findings (e.g., suggesting a different framework) and lets the user choose the preferred version.
        *   *Exhaustive Interrogation Mode for Interviews:* An optional mode that ruthlessly interrogates app ideas with endless questions on details, edges, and constraints until zero assumptions remain.
*   **Action-Required Notifications + Escalation Lifecycle (severity-routed, acknowledgment-aware):**
    *   Keep severity bands (`critical`, `warning`, `info`) but map each band to deterministic action routes (`in_app`, `email`, `sms`, `webhook`, `escalation_record`).
    *   Add visibility-aware delivery policy: if the user is currently focused on the affected ticket/pane, suppress external alerts and show in-app only; if not focused, escalate normally.
    *   Add deterministic blocker banner in Kanban cards and ticket header for `WAITING_*` and `BLOCKED_ERROR` states with: `blocked_by`, `required_action`, `owner`, and `since`.
    *   Provide one primary CTA per blocker state (`answer_questions`, `approve_prd`, `approve_beads`, `manual_verify`, `retry_or_fix`) so the next action is unambiguous.
    *   For `BLOCKED_ERROR`, show a deterministic diagnostic summary before retry:
        *   include `failed_bead_id`, `failed_gate`, latest error signatures, and probable-cause codes (`dependency_missing`, `env_misconfigured`, `test_harness_broken`, `requirement_ambiguous`);
        *   provide ordered recovery actions and allow one-click insertion of selected guidance into the next retry notes.
        *   include raw `error_message` text and explicit CTA order (`retry`, `edit`, `cancel`) so remediation is unambiguous.
    *   Persist escalation records at `.looptroop/tickets/<ticket-id>/escalations/escalations.jsonl` with `escalation_id`, `severity`, `status` (`open|acknowledged|closed`), `source_event`, `created_at`, `ack_at`, `closed_at`, `route_actions[]`, and `last_delivery_result`.
    *   Add explicit user/system actions: `acknowledge`, `close`, `list_open`, `list_stale`.
    *   Add stale policy: if `status=open` longer than `stale_threshold` (default `4h`), re-escalate one level and retry route actions until `max_reescalations` is reached.
    *   Delivery failures must never block execution, but every failed action is logged with `channel`, `error_code`, `attempt`, and `next_retry_at`.
    *   `Doctor` must validate escalation route configuration and required contact settings, with actionable remediation text.
*   **Beads Adoption Strategy (complexity-first, optional CLI):**
    *   **Phase A (default / MVP):** LoopTroop-native Beads artifact contract (`issues.jsonl`) only. No required `bd` installation and no Beads daemon dependency.
    *   **Phase B (optional compatibility mode):** Enable official Beads CLI integration only when `beads_mode = compatibility` is explicitly enabled per project.
    *   **Phase-B entry criteria:** measurable need for Beads ecosystem interoperability, no unresolved schema gaps, and stable MVP execution metrics.
    *   When Phase B is enabled: pin `bd` version, validate availability in pre-flight, run `bd doctor` as gate, and run Beads cleanup hooks before finalization.
    *   Landing hygiene is mandatory in both phases: code state and Beads state must reconcile before `COMPLETED`.
    *   Extend Beads dependency/link schema to support typed links:
        *   `blocked_by`: hard prerequisite edges.
        *   `blocks`: hard downstream edges.
        *   `relates_to`: non-blocking informational cross-links.
        *   `duplicate_of`: canonical dedupe link; duplicate bead auto-closes as `skipped_duplicate`.
        *   `supersedes`: replacement edge; superseded bead auto-marks `skipped_superseded`.
        *   `discovered_from`: trace edge to the bead during whose execution this bead was discovered.
    *   Scheduler semantics: only `blocked_by`/`blocks` affect runnability; `relates_to`/`duplicate_of`/`supersedes` are non-blocking metadata links with explicit audit trail updates.
    *   Add dependency-link symmetry contract for hard edges:
        *   if `A.blocks` contains `B`, then `B.blocked_by` must contain `A`;
        *   if `A.blocked_by` contains `B`, then `B.blocks` must contain `A`;
        *   `Doctor` runs deterministic reverse-edge repair for single-sided links and emits `dependency_symmetry_repaired`;
        *   unresolved or conflicting symmetry violations block execution with `dependency_symmetry_violation`.
    *   Runtime discovery contract in `CODING`: if an unforeseen sub-task is required, create a new bead via `bd create --discovered-from <current_bead_id>` and insert it into the graph with explicit `blocked_by`/`blocks` links and optional `relates_to`.
    *   Discovery safety limit: cap runtime-created beads per source bead (default `5`, configurable) to prevent runaway bead creation loops.
    *   User visibility: emit SSE events for discovered/superseded bead changes and include typed-link summaries in ticket completion reports.
    *   Replace free-text bead notes with structured append-only `notes[]` entries.
    *   Notes entry schema: `attempt_id`, `iteration` (integer), `phase` (`bearings|implement|verify|commit`), `status` (`pass|fail|blocked|rework_requested|critical`), `source` (`error|learning|steering|discovery|system`), `summary`, `failure_signature`, `suggested_next_action`, `evidence_refs[]`, `timestamp` (ISO 8601).
    *   Notes write contract: append-only via `bd update --notes` (no in-place rewrite/delete). Every verify failure must append a `rework_requested` entry, every retry start appends `attempt_started`, and max-attempt stop appends `critical`.
    *   Adopt explicit dual-source durability model for Beads:
        *   authoritative runtime source of truth is append-only `issues.jsonl`; `beads.db` (`SQLite`) is a fast, rebuildable projection/cache.
        *   mutation path is `JSONL-first` then `SQLite` hydrate; direct `SQLite`-only bead mutation is forbidden.
        *   include rollback markers for multi-step updates (`tx_begin`, `tx_commit`, `tx_abort` or equivalent).
        *   run startup and periodic integrity checks (`issues.jsonl` vs `beads.db`, orphaned refs, graph invariants).
        *   on mismatch/corruption, auto-repair by rebuilding `SQLite` projections from `issues.jsonl` and persist repair audit artifacts.
        *   keep bead `JSONL` artifacts under git as recovery layer so state can be restored from history if JSONL damage is detected.
        *   expose agent-safe health/repair commands; if repair fails deterministically, transition ticket to `BLOCKED_ERROR` with remediation.
    *   Add agent-native bead ID system for parallel execution:
        *   generate collision-resistant hash-based bead IDs (example: `bd-a1b2`, optionally ticket-scoped as `<ticket-id>-bd-a1b2`) instead of sequential identity.
        *   ID generation must be safe across concurrent agents/worktrees without a central lock.
        *   keep human ordering separate from identity via `order_index` (or equivalent), not via sequential ID.
        *   provide deterministic migration mapping from legacy sequential bead IDs to canonical hash IDs for existing artifacts.
        *   require all dependency/relationship links (`blocked_by`, `blocks`, `relates_to`, `supersedes`, `discovered_from`) to use canonical hash IDs.
    *   Simplify bead schema with explicit ownership classes (`Managed By` contract):
        *   classify every bead field as `ai_readable`, `ai_writable`, or `system_managed` in schema/docs.
        *   minimal `ai_readable` set for implementation loops: `id`, `title`, `description`, `acceptance_criteria`, `dependencies`, `target_files`, `verification_commands`, `notes`.
        *   `ai_writable` should be intentionally narrow (default: append-only `notes` updates and explicit completion/status signals only through approved commands).
        *   mark operational metadata as `system_managed` (for example: timestamps, iteration counters, lifecycle status, audit markers) to reduce accidental state drift.
        *   enforce ownership in runtime validators: reject out-of-scope agent mutations and return actionable errors.
        *   add deterministic migration/compatibility handling when existing beads include legacy fields outside the simplified contract.
*   **Planning Split: Proposal (What/Why) + Options Synthesis + Design (How) (composite PRD contract):**
    *   Replace monolithic PRD authoring with sequential planning artifacts:
        *   Step A `Proposal` (problem, user intent, scope in/out, epics, stories, functional acceptance criteria).
        *   Step B `Options Synthesis` (viable paths, tradeoffs, recommendation, and why alternatives were not selected).
        *   Step C `Design` (architecture constraints, libraries, data/schema decisions, API contracts, security/performance/reliability patterns).
    *   Options Synthesis runs when architectural/product ambiguity is detected or `phase_flags.options_synthesis.mode=required`.
    *   Persist `.looptroop/tickets/<ticket-id>/options-pack.yaml` with `options[]`, `recommended_option`, `why_not_the_others[]`, and optional `spike.required`.
    *   Reserve `spike` for bounded runnable uncertainty reduction that is explicitly approved; do not treat every option comparison as a prototype.
    *   Clear tickets may skip Options Synthesis automatically and record the skip reason in planning status.
    *   Ambiguous tickets should compare at least two materially different viable options, with tradeoffs and a single recommendation.
    *   Selected options feed Design and `TEST_STRATEGY`; rejected options remain as decision history, not active implementation scope.
    *   This replaces standalone winner-model discussion with a documented decision pack before Design.
    *   Design generation is blocked until Proposal and any required Options Synthesis are approved.
    *   Require feasibility cross-check: each Proposal requirement must map to at least one Design decision path or explicit blocker.
    *   Persist approved artifacts:
        *   `.looptroop/tickets/<ticket-id>/proposal.yaml`
        *   `.looptroop/tickets/<ticket-id>/options-pack.yaml` when Options Synthesis runs
        *   `.looptroop/tickets/<ticket-id>/design.yaml`
    *   Keep compatibility PRD composite:
        *   generate `.looptroop/tickets/<ticket-id>/prd.yaml` as derived composite/manifest from approved Proposal + Options Synthesis + Design (not primary authoring surface).
    *   Council role routing:
        *   product-focused roles vote primarily on Proposal quality/value alignment.
        *   engineering-focused roles vote primarily on Design feasibility/coherence.
    *   Council decision contract (deterministic + audit-ready):
        *   apply blind-review protocol before scoring: strip model/provider markers, randomize anonymous labels (`candidate_1`, `candidate_2`, ...), and persist reversible mapping for audit-only use at `.looptroop/tickets/<ticket-id>/council/candidate-map.json`.
        *   required council pipeline for Interview/Proposal/Options/Design/Beads phases when `execution_profile=council`: `draft -> self_reflection -> adversarial_critique -> voting -> synthesis`.
        *   `execution_profile=quick` uses single-model path: `draft -> coverage_verify`; system auto-escalates to full council when quick-path escalation triggers fire.
        *   self-reflection output is mandatory per draft: `top_weaknesses[]` (minimum 3), `assumptions[]`, `confidence_pct` (0-100), and `needs_user_input[]`.
        *   adversarial critique pass is mandatory: each member must record at least one concrete weakness/risk per peer draft (`issue`, `impact`, `evidence_ref`, `suggested_fix`); empty critique payloads are `invalid_output`.
        *   default decision mode is rubric scoring across required Proposal/Options/Design criteria; optional `pairwise` mode is allowed only for close finalists and must emit explicit criterion-level win/loss reasons.
        *   each vote must emit structured evidence fields: `criterion`, `score`, `confidence`, `evidence_refs[]`, `concerns[]`.
        *   persist per-phase scorecards with category totals, score spread, and candidate rank order at `.looptroop/tickets/<ticket-id>/council/scorecard-<phase>-<timestamp>.json`.
        *   stream provisional vote updates during council voting (`council_score_update`) and mark them as provisional until quorum is met.
        *   compute confidence-weighted ranking with `adjusted_score = raw_score * sqrt(max(confidence_pct,1)/100)` and include both raw and adjusted scores in receipts.
        *   compute `decision_confidence` from score spread + cross-model agreement; if all candidates are low-confidence (`confidence_pct < 50`) or `decision_confidence` is below threshold, route to clarification/context-refresh before auto-accept.
        *   if winner selection uses tie-break policy, emit explicit `tie_break_applied` receipt with `policy`, `tied_candidates[]`, and `rationale`, and surface it in council results UI.
        *   enforce council deliberation behavioral rules in system prompts: `equal_standing`, `constructive_dissent_required`, `pass_when_empty`, `collaborative_rivalry`, `evidence_required`.
        *   council decision phases must use the global phase-timeout/quorum policy defined in `Timeout + Inactivity Watchdog + Stagnation Heuristics`.
    *   Invalidation policy:
        *   Proposal edits invalidate Options Synthesis + Design + downstream Beads/Test Strategy.
        *   Options Synthesis edits invalidate Design + downstream Beads/Test Strategy.
        *   Design edits invalidate downstream Beads/Test Strategy only.
    *   Execution cannot start unless Proposal, any required Options Synthesis, and Design are approved.
*   **Test Strategy Phase (risk-first planning contract; TEA-inspired):**
    *   Insert a dedicated `TEST_STRATEGY` planning step after Proposal + Options Synthesis + Design approval and before Beads generation.
    *   Persist `.looptroop/tickets/<ticket-id>/test-strategy.yaml` with:
        *   risk tier per epic/user-story (`critical`, `high`, `medium`, `low`),
        *   critical-path markers (`auth`, `payments`, data integrity, external side effects),
        *   required verification depth per risk tier (`unit`, `integration`, `e2e`, `non-functional`).
    *   Add quality-gate policies per risk tier (examples: timeout/network-failure handling, load/performance checks, rollback safety, idempotency checks).
    *   Require Beads generation to consume `test-strategy.yaml` so high-risk features receive stronger test density and stricter gates than low-risk cosmetic work.
    *   Enforce traceability: every high-risk Proposal acceptance criterion must map to at least one explicit high-confidence verification path before execution start.
    *   If strategy is missing or invalid, block transition to Beads/Execution with deterministic remediation.
*   **Planning Sharding for Beads Generation (proposal/options/design decomposition):**
    *   Add pre-computation sharding step for multi-epic or large approved Proposal/Options/Design composites before bead drafting.
    *   Persist shards at `.looptroop/tickets/<ticket-id>/planning/shards/`:
        *   one self-contained shard per epic with only relevant requirements, constraints, acceptance criteria, and dependency notes,
        *   `index.yaml` containing shard IDs, source section refs, and content hashes.
    *   Beads drafting contract:
        *   each council model drafts beads shard-by-shard (epic-local context),
        *   then run a cross-shard merge pass to reconcile shared dependencies and global ordering.
        *   merge shard outputs per model into one normalized candidate artifact before council voting.
        *   after winning refinement, run final full-field expansion as a mapped one-bead-per-call loop and append sequentially into `issues.jsonl` to avoid large single-response truncation.
        *   if one mapped expansion call fails/truncates, retry only that bead expansion (not full regeneration).
    *   Add deterministic invalidation: when Proposal or Design changes, regenerate only affected shards based on hash/section diff, not the full shard set.
    *   Add overflow guard: if shard size exceeds configured context budget, recursively split by user story before drafting.
*   **Execution Context Pack + XML Codebase Map (Context Optimization):**
    *   Replace standard text/markdown codebase map dumps with structured XML-wrapped context.
    *   Canonical format example:
        *   `<repo><file path="src/main.js" lang="js">...</file></repo>`
    *   Persist map artifacts at `.looptroop/tickets/<ticket-id>/context/codebase-map.xml` with deterministic file ordering and stable node attributes.
    *   Include explicit file-boundary metadata (`path`, `language`, `size_bytes`, `last_modified`, `symbol_summary`) to reduce boundary confusion during model retrieval.
    *   Add optional Tree-sitter repository map generation (signature-only: files, classes, functions, exports/imports) to compress very large repos into bounded planning context.
        *   Persist compact symbol map at `.looptroop/tickets/<ticket-id>/context/repo-map.tree-sitter.json`.
    *   Add adaptive map-fidelity fallback when signature-only context is insufficient:
        *   default to signature-only map for token efficiency;
        *   if repeated failure signatures persist for the same bead (default `>=2` attempts) or diagnosis confidence is low, inject bounded implementation snippets for touched symbols plus direct callers/callees;
        *   persist selected fidelity mode (`signature_only` | `hybrid_snippets`) in context-pack receipts for auditability and resume parity.
    *   Add deterministic per-bead `Context Pack` assembly for each execution iteration:
        *   required inputs: active bead spec, dependency snapshot, target files, bead tests/commands, AST map slice;
        *   enrichment inputs (when available): `CONVENTIONS.md`, `TESTING.md`, `INTEGRATIONS.md`, `CONCERNS.md` from ticket codebase-map artifacts;
        *   retry inputs: previous attempt notes for the same bead only (never cross-ticket memory).
    *   Add a dedicated pure context assembler `buildMinimalContext(phase, ticketState)` and require every model call path to use it before `sdk.session.prompt(...)`.
    *   Enforce phase-locked context allowlists (hard contract, no extras):
        *   interview phases: codebase map + ticket details + rolling interview summary + last `10` Q/A pairs + skip metadata (`skipped_question_ids`, `skipped_topics`, `skip_counts`); full transcript stays in interview artifacts for coverage/final checks.
        *   PRD/Beads council phases: codebase map + interview/PRD summary snippets only (never full planning files by default);
        *   bead execution phases: active bead JSON + referenced PRD section excerpts (by ID) + last `2-3` bead notes + codebase map.
    *   For each prompt call, persist context-pack token estimate and model limit headroom; if estimated usage exceeds `40%` of model context window, emit `context_budget_warning` in execution logs with dropped/kept source breakdown.
    *   Persist each iteration pack receipt at `.looptroop/tickets/<ticket-id>/context/context-pack-<flow-id>-<bead-id>-<iteration>.json` with selected/skipped sources and skip reasons.
    *   Enforce a hard context budget per pack; if budget is exceeded, trim in deterministic priority order (`bead spec` -> `tests/commands` -> `AST slice` -> `conventions/testing` -> `integrations/concerns` -> `retry notes`) and log what was dropped.
    *   If XML map generation fails, fallback to existing map mode but emit warning telemetry (`context_map_fallback`) and remediation hints.
    *   Add repository-map freshness contract to prevent stale map hallucinations:
        *   on file create/update/delete/rename during execution, mark map `stale` and queue `changed-only` regeneration for touched paths,
        *   persist map manifest `.looptroop/tickets/<ticket-id>/context/repo-map.manifest.json` with `map_version`, `source_tree_hash`, `generated_at`, and `changed_paths[]`,
        *   planning/execution phases must load latest `map_version`; if stale/missing, regenerate before next model call.
    *   Pre-generate the base codebase map during `PRE_FLIGHT_CHECK` and reuse it for bead startup to avoid synchronous map generation on each bead.
    *   After each bead commit, trigger background map refresh (`changed-only` first, `full` fallback) and atomically swap map manifest only after successful regeneration.
    *   **Alternative / addition - LSP + AST-Grep query mode:**
        *   Dynamic navigation over static maps: provide `lsp_definition`, `lsp_references`, and `lsp_hover` tools so context is retrieved surgically instead of pre-dumped.
        *   Structural search with `ast-grep`: allow pattern-level queries (for example, find all calls to a deprecated function) instead of fuzzy text-only search.
        *   Context Pack assembly in query mode must run a "Librarian" pass that uses LSP/AST-Grep to trace dependencies of `target_files` and inject only relevant definitions.
        *   Persist context discovery/query logs (`searched`, `reference found`, `file read`) in execution logs for auditability.
*   **AI Code Review (staged, role-based, gate-driven + explicit verdict contract):** [I1](https://github.com/umputun/ralphex) [I2](https://x.com/i/status/2023468856220807539)
    *   Stage 0 (continuous execution watcher; Sage-style, non-blocking):
        *   while a bead is being implemented, run a lightweight secondary monitor model on runtime stream + changed-file deltas.
        *   watcher checks: edits outside `target_files`, repeated error signatures across iterations, divergence from bead acceptance criteria, and test-coverage mismatch.
        *   Add write-time syntax/lint guard for changed files: run fast parser/lint checks on each write batch and reject/rollback invalid writes before the loop advances to full test phase.
        *   watcher emits critique cards with verdict `approved | concerns | critical_issues`, plus `observation` and `suggested_action`.
        *   watcher is read-only by default (`monitor_mode=observe_only`) and cannot mutate code or phase state.
        *   optional policy `monitor_mode=critical_pause` allows auto-pause + `NEEDS_INPUT` on repeated `critical_issues` verdicts.
        *   monitor path must never block main execution; on watcher failure, continue execution and emit `watcher_unavailable`.
        *   persist watcher cards at `.looptroop/tickets/<ticket-id>/observer-reports/<bead-id>-<iteration>-<timestamp>.json`.
    *   Completion handshake (before review starts): implementer must emit structured `mark_complete` payload with `summary`, `files_modified`, and `checks_executed`.
    *   Add deterministic verification queue contract to prevent post-implementation stalls:
        *   on accepted `mark_complete`, enqueue required verifications at `.looptroop/tickets/<ticket-id>/verification/queue.jsonl`;
        *   queue item schema includes `verification_id`, `source_step_id`, `verifier_role`, `attempt`, `timeout_seconds`, `status` (`pending|running|passed|failed|timed_out`), and `result_receipt_path`;
        *   orchestrator must consume this queue and complete required verifications before allowing transition to next step/bead.
    *   Stage 1 (broad parallel review): run 5 reviewer roles in parallel:
        *   `quality` (bugs/security/race conditions),
        *   `implementation` (did we build the requested behavior),
        *   `testing` (coverage and test quality),
        *   `simplification` (over-engineering detection),
        *   `documentation` (docs updates required).
    *   Stage 2 (independent verification): run a separate reviewer/model that executes verification commands first (`typecheck`, `build`, targeted tests) and then issues a verdict.
    *   Stage 3 (strict final pass): run only `quality` + `implementation` and accept only critical/major findings.
    *   Required finding format: `severity`, `file`, `line`, `issue`, `evidence`, `fix_suggestion`.
    *   Required verdict format: `approved` (boolean), `blocking_issues` (array), `reason`, `required_actions`.
    *   Runner behavior: deduplicate findings, validate each finding before fix, and loop `review -> fix -> review` until no valid critical/major findings remain.
    *   Reviewer output rule: report issues only (no positive commentary).
    *   Failure policy: if final verdict is missing/invalid/timed out, do **not** auto-approve; retry reviewer or transition ticket to `BLOCKED_ERROR` with explicit remediation.
*   **Per-bead Fast Quality Gate + Lightweight Security Gate (changed-files first):**
    *   Before a bead can be marked `done`, run deterministic changed-files gates with two mandatory events: `idle_gate` and `completion_gate`.
    *   `idle_gate` blocks immediately on changed files for:
        *   debug traces (`console.log`, `console.debug`, `debugger`, `breakpoint()`),
        *   syntax/parse failures,
        *   obvious secret leaks (API key prefixes, private key headers).
    *   `completion_gate` re-checks changed files and additionally blocks on:
        *   unresolved `TODO` / `FIXME` / `XXX` / `HACK` markers,
        *   placeholder implementations (`NotImplemented`, stub throws, empty placeholder bodies),
        *   failed required lint/typecheck/build/test commands,
        *   validated `high` / `critical` security findings.
    *   Fast quality gate contract:
        *   run formatter/lint checks on changed files only, plus repository pre-commit hooks if configured.
        *   run lightweight syntax checks by file type before broader tests.
        *   fail fast before broader bead tests to reduce expensive retry loops.
    *   Tiered validation contract (iteration-aware):
        *   intermediate iterations run fast lint/type checks first for quick feedback.
        *   final-candidate iteration (or when completion is claimed) must run full bead-scoped verification commands.
        *   allow a bounded greenfield warm-up window before full validation is mandatory when bootstrap artifacts/commands are still being created.
        *   validation command resolution order must be deterministic: bead-defined commands -> `.looptroop/project/commands.yaml` -> detected project scripts (`test`, `lint`, `build`, `typecheck`) -> language fallback checks (for example TypeScript `tsc --noEmit`).
    *   Per-bead execution order:
        *   `implement code -> idle_gate -> fast changed-files gate -> lint/typecheck -> bead-scoped tests -> lightweight security gate -> completion_gate -> completion marker`.
    *   Qualitative-verdict contract for subjective acceptance criteria:
        *   if a bead contains subjective checks (UX wording, docs clarity, visual consistency), require an explicit `qualitative_verdict.v1` step before completion;
        *   when an alternate reviewer model is available, `qualitative_verdict.v1` must be produced by a model identity different from the active implementer;
        *   if no alternate model is available, allow self-verdict only with explicit `self_certified=true` in the receipt and surface warning at review checkpoints;
        *   verdict payload must include `status` (`pass|fail`), `criteria_results[]`, `evidence_refs[]`, and `rationale`;
        *   enforce timeout/retry policy (`qualitative_timeout_seconds` default `120`, `max_qualitative_retries` default `2`);
        *   missing/invalid/timed-out qualitative verdict blocks bead completion unless policy explicitly allows degraded mode with receipt.
    *   Security gate contract:
        *   strict runtime budget (default 90 seconds; configurable range 60-120 seconds).
        *   structured findings output: `severity` (`low|medium|high|critical`), `file`, `line`, `issue`, `evidence`, `fix_suggestion`.
        *   bead completion is blocked only on validated `high` or `critical` findings.
        *   `low` and `medium` findings are warnings: persist and surface in final ticket review summary.
    *   Failure handling:
        *   if fast changed-files gate fails, retry after targeted fixes; repeated failure follows the same bead retry/circuit-breaker policy.
        *   if security pass fails or times out, retry once.
        *   if second attempt fails, mark `security_gate_unavailable`; continue only when policy profile explicitly allows degraded mode.
    *   Persist per-bead reports at `.looptroop/tickets/<ticket-id>/security/bead-security-<flow-id>-<bead-id>-<iteration>.json`.
    *   After all beads complete, run a broader ticket-level security audit to catch cross-bead and integration risks.
*   **Interactive Interview UI + Session Ledger (deterministic persistence):** Enhance the interview phase to support an interface with multiple-choice options (between 1 and 5) and a custom free-text field. The first option (the one the model considers best) is bolded and marked as recommended. Include a short explanation per option plus Pros/Cons/Best-for tooltips. For each question, allow an AI dialog so the user can understand implications/utility/necessity before answering.
    *   Add optional `spec_paste` fast path at interview start:
        *   user can paste an existing spec/README/ticket body as source context;
        *   run a prefill pass that maps source text to interview answers with confidence labels (`high`, `medium`, `low`);
        *   ask only unresolved or low-confidence questions before coverage verification.
    *   **Sources during interview + smart retrieval routing:** For each interview question/option, allow optional context fetch with deterministic query routing. (During interview, per option, the user can select extra information, including source links for articles, internet images, and diagrams.)
        *   classify search intent as `official_docs`, `news`, `general_web`, or `images`.
        *   run hybrid retrieval: snippet search first, then optional full-page extraction for top results when deeper context is needed.
        *   rerank results by relevance + recency before presenting to user.
        *   show source cards with `title`, `url`, `retrieved_at`, `confidence`, and `why_this_source`.
        *   enforce hard bounds (`max_results`, token budget, timeout) so retrieval never stalls planning.
        *   persist retrieval trace at `.looptroop/tickets/<ticket-id>/research/interview-search-<timestamp>.json`.
        *   Persist interview session metadata at `.looptroop/tickets/<ticket-id>/interview/session.json` and append-only Q/A stream at `.looptroop/tickets/<ticket-id>/interview/conversation.jsonl`.
    *   Show interview progress header with deterministic fields: `question N/M`, `phase P/3`, and a rolling ETA range from median answer duration.
    *   Auto-save unsent per-question draft answers on the client (default every 5s), prompt restore on reopen, and provide explicit `discard_draft` action.
    *   If unsent draft text exists, warn on tab/window close to prevent accidental interview data loss.
    *   Every interview question must have immutable `question_id` + `order_index`; UI renders strictly by `order_index`.
    *   Every answer record must include `question_id`, `answer_status` (`answered` | `skipped`), `answer_text`, `answered_at`, and `source`.
    *   Pass structured skip metadata into each follow-up generation loop and avoid re-asking skipped topics unless flagged as `critical_dependency` with explicit reason text.
    *   Add explicit answer mode `assume_default` ("I don't know / use best default") with required metadata: `assumption_scope`, `reversible`, and optional reviewer note.
    *   Follow-up questions must be explicit new records with `question_id`, `parent_question_id`, and `reason` (never silent in-place mutation of prior questions).
    *   Persist final free-form input as deterministic terminal question record (`question_id: final_freeform`).
    *   Before asking `final_freeform`, show up to 3 targeted expansion prompts derived from unresolved low-confidence areas so the final input is guided, not blank-slate.
    *   Add `question_quality` scoring per question with required fields: `decision_category`, `novelty_score`, `ambiguity_reduction_score`, and `reason_to_ask_now`.
    *   Reject candidate questions when `novelty_score` is below threshold or when the same decision is already resolved.
    *   Require minimum category coverage before closing interview: `technical_implementation`, `ui_ux`, `edge_cases`, `tradeoffs`, `integration`, `error_handling`, `performance` (or explicit `not_applicable` with rationale).
*   **Structured output reliability + prompt-contract reliability (all AI phases + deterministic file mutation path):**
    *   Define versioned schemas per phase (`interview.v1`, `prd.v1`, `beads.v1`, `execution.v1`) and reject unknown schema versions.
    *   Add strict post-AI schema validation gate (`zod`) on every response before any artifact write or state transition.
    *   Validation path must be deterministic: `parse -> zod validate -> persist`; if validation fails, store raw response + validation errors in quarantine and auto-retry the exact same step once with the same model/settings; if retry also fails, transition to `BLOCKED_ERROR`.
    *   Split interview machine contracts to remove turn/final ambiguity:
        *   `interview_turn.v1`: output only next `1-3` questions + progress + question mutations (`add` / `update` / `delete`), never the final interview artifact.
        *   `interview_final.v1`: output only the final interview artifact, allowed only when `remaining_questions=0` and ambiguity is resolved.
    *   Add prompt-contract lint rule: one prompt contract cannot simultaneously require iterative follow-up behavior and final-artifact-only output; such conflicts are `invalid_prompt_contract`.
    *   Add prompt migration map so legacy prompt IDs can be remapped to contract-safe targets (for example `PROM4` -> `interview_turn.v1`, finalization -> `interview_final.v1`) with explicit deprecation warnings.
    *   Store canonical schema files at `.looptroop/schemas/<artifact-type>.schema.json`; every persisted artifact must carry `schema_version`.
    *   Enforce artifact-level validation on every write/read path for planning artifacts:
        *   `.looptroop/tickets/<ticket-id>/interview.yaml` must validate against the current interview-final schema.
        *   `.looptroop/tickets/<ticket-id>/prd.yaml` must validate against the current PRD schema.
        *   `.looptroop/tickets/<ticket-id>/beads/main/.beads/issues.jsonl` must validate line-by-line against the current beads issue schema.
    *   If artifact validation fails, quarantine the invalid payload, keep last known-good artifact untouched, and persist a validation report with `phase`, `model_id`, `schema_version`, `errors[]`, and `attempt`.
    *   Add dedicated loop-control schema (`loop_control.v1`) for per-bead loop files (`.looptroop/tickets/<ticket-id>/loops/<flow-id>/<bead-id>.loop.md`) with frontmatter fields + canonical instruction body hash.
    *   Validate `loop_control.v1` at bead start and before every retry (`active`, `ticket_id`, `flow_id`, `bead_id`, `iteration`, `max_iterations`, `loop_mode`, `completion_intent`).
    *   If loop-control validation fails, quarantine the artifact to `.looptroop/tickets/<ticket-id>/quarantine/` with the validation report and force deterministic failure (`BLOCKED_ERROR`) until corrected.
    *   Add a schema migration contract for every schema bump: `from_version`, `to_version`, deterministic migration function, and explicit rollback behavior.
    *   Keep a bounded backward-compatibility window (default: previous 1 version) and auto-migrate older accepted artifacts to current version on write.
    *   Add compatibility fixture suites with frozen historical artifacts for each phase and loop-control artifacts; every fixture must pass parse -> migrate -> validate.
    *   Track LoopTroop-managed component provenance in `.looptroop/system-provenance.json` with: `component`, `version`, `source_commit`, `installed_at`, `updated_at`.
    *   Add a non-destructive `Doctor` update check that compares pinned managed-component versions with allowlisted upstream metadata and reports drift.
    *   Doctor must classify managed-component drift as `advisory` by default (warn + suggest remediation; do not block execution unless policy explicitly elevates severity).
    *   Add deterministic `Doctor` run modes:
        *   `quick` - binary/config/path checks only.
        *   `full` - includes live provider/agent preflight responsiveness checks.
    *   In `full` mode, run provider/model readiness probes and persist snapshots at `.looptroop/tickets/<ticket-id>/doctor/model-readiness-<timestamp>.json` with `model_id`, `status`, `latency_ms`, `failure_class`, and `checked_at`.
    *   Add explicit Doctor check-scope contract (`required` vs `optional`) independent from severity:
        *   required checks (must pass to start): main implementer readiness, OpenCode/provider connectivity, git safety/ownership checks, required ticket artifacts, beads graph integrity, and runnable verification-command availability.
        *   optional checks (warning/advisory): fallback/council model readiness, non-critical tooling hints, and advisory environment drift.
    *   Runtime start gate must block execution if any `required` check is not `pass`; optional failures remain non-blocking unless policy explicitly elevates them.
    *   Add required preflight baseline checks with deterministic remediation output:
        *   git cleanliness gate on the active ticket worktree path (`git -C <active_ticket_worktree_path> status --porcelain` must be empty unless policy explicitly allows dirty start; never validate global `cwd` by accident);
        *   OpenCode reachability + health (`/api/health/opencode` + SDK probe);
        *   artifact paths exist and are writable (`.looptroop`, ticket worktree, runtime log folders);
        *   bead dependency graph has no missing references and is acyclic.
    *   For each failed preflight check, return ordered recovery steps with exact command/path guidance.
    *   For readiness probes and completion detection, enforce strict precedence:
        *   `bead_complete.v1` structured payload (schema-valid) is authoritative.
        *   explicit exit signal is accepted only when minimum completion indicators are present and required gates already passed.
        *   fallback text/file markers are advisory only and must be confirmed by artifact-progress evidence before completion is accepted.
    *   Apply the same validation + one-retry policy to loop markers and completion markers (including `<BEAD_STATUS>` and `<FINAL_TEST_STATUS>` legacy wrappers) before they can influence workflow transitions.
    *   If a completion marker is emitted before required gates pass, classify `marker_gate_mismatch`, fail the iteration, and append mandatory next-attempt guardrail text: `Do not emit completion marker until all required gates pass`.
    *   Persist marker/gate mismatch recurrence count per bead; repeated mismatches must surface as a primary failure pattern in retry notes and blocker diagnostics.
    *   Add tolerant fallback parser when structured output is unavailable: accept wrapped payloads (whitespace, markdown fences, legacy tags), extract first valid JSON object, re-validate against schema, and persist parser-path telemetry.
    *   At run start, freeze `usable_model_set` from the latest valid readiness snapshot and persist it in runtime state; retries/rotation must stay within this frozen set unless the user explicitly triggers a fresh `Doctor` run.
    *   Doctor must classify every check as `critical`, `warning`, or `advisory`, and include deterministic remediation guidance per finding.
    *   Add `Doctor` output formats: `human`, `json`, `copyable` (bug-report friendly).
    *   Define `Doctor` exit-code contract for automation:
        *   `0` healthy,
        *   `1` actionable failures,
        *   `2` internal doctor failure.
    *   Support `Doctor --fix` for safe deterministic remediations only; non-deterministic or destructive remediations are refused with explicit reason codes.
    *   Add Doctor preflight command-validation gate: execute bead `test_commands` in dry-run mode and block start on `command not found`, broken harness boot, or syntax/compile failures in tests.
    *   Add Doctor target-scope gate: every runnable bead must provide non-empty `target_files`; if no file edits are intended, require explicit `target_mode=none` plus restricted no-write execution policy.
    *   Add Doctor graph-repair policy: run cycle detection on Beads dependencies, attempt deterministic edge removal based on lowest-priority conflicting edge, and block only if cycles remain after repair.
    *   Add deterministic topological-sort gate before execution start: compute canonical bead run order and fail fast on cycle or missing-dependency errors with offending bead IDs.
    *   Add Doctor gitignore hygiene check/fix: ensure `.env`, `.env.*`, and `.looptroop/tickets/*/opencode-sessions.yaml` are ignored before execution start.
    *   Add startup config-bounds validation gate and reject out-of-range values before runtime boot:
        *   `per_iteration_timeout_minutes > 0`,
        *   `max_iterations <= 10`,
        *   `council_members <= 4`,
        *   invalid values return deterministic `config_out_of_range` diagnostics plus corrected defaults.
    *   Persist doctor reports at `.looptroop/tickets/<ticket-id>/doctor/doctor-report-<timestamp>.json` with per-check `check_id`, `severity`, `status`, `duration_ms`, and `remediation`.
    *   Allow Runtime Gate to reuse a recent `Doctor` report when freshness window is valid (`max_age_minutes` policy); otherwise force a fresh `Doctor` run.
    *   Add `Doctor` resume-compatibility gate for resumed runs:
        *   validate ownership tuple match (`ticket_id`, `flow_id`, `run_id`, `session_id`), active branch/worktree parity, and tracker-source resolvability (`issues.jsonl`/epic/PRD references).
        *   if compatibility fails, block start and emit deterministic actions: `resume_safe`, `resume_with_explicit_tracker_source`, or `start_fresh_session`.
    *   Add versioned prompt contract schema (`prompt_contract.v1`) with ordered sections: `orientation`, `core_steps`, `hard_invariants`, plus explicit invariant priority bands.
    *   Add canonical runtime contract registry at `.looptroop/contracts/runtime-contracts.v1.yaml`:
        *   required sets: `prompt_ids`, `state_names`, `phase_names`, `schema_versions`, and ownership invariants;
        *   every runtime component must resolve contracts from this registry (not ad-hoc literals).
    *   Add Spec Drift Sentinel gate (`doctor --contracts` and startup preflight):
        *   parse `plan.md`, `architecture.md`, `prompts.yaml`, and runtime contract registry;
        *   detect missing/extra prompt IDs, state-name mismatches, and phase contract conflicts;
        *   hard-fail execution start on unresolved drift and persist diagnostics at `.looptroop/tickets/<ticket-id>/doctor/contract-drift-<timestamp>.json`.
    *   Priority bands:
        *   `P1_hard_stop` (never violate: ownership, safety, forbidden actions),
        *   `P2_safety` (security, sandbox, data protection),
        *   `P3_quality` (tests, typecheck, lint, acceptance checks),
        *   `P4_hygiene` (logging, documentation, cleanup).
    *   Enforce precedence contract: higher-priority bands override lower bands on conflict, and every conflict is logged with both rule IDs.
    *   Persist `prompt_hash` + `prompt_contract_version` + `invariant_band_map` in phase artifacts so any run can be reproduced/audited.
    *   Add explicit `execution_prompt_contract.v1` hard invariants:
        *   completion marker is mandatory for bead state transitions (`<BEAD_STATUS>{...}</BEAD_STATUS>` or validated JSON equivalent).
        *   approved planning artifacts (`interview`, `proposal`, `design`, `prd`) are read-only for the implementer during coding.
        *   reject mixed prose + control payload for state-changing actions; only framed/validated machine payload is accepted.
    *   Add a versioned control-signal schema (`signal.v1`) for machine actions (`ask_question`, `phase_done`, `bead_done`, `phase_failed`, `blocked`, `decision_required`), and reject unknown signal versions/types.
        *   `blocked` requires stable fields: `scope`, `reason_code`, `summary`, optional `remediation`.
        *   `decision_required` requires stable fields: `scope`, `question`, `options[]`, and optional `default_option`.
    *   Add a versioned mutation schema (`mutation.v1`) for machine file operations (`read_file`, `write_file`, `edit_file`, `delete_file`), and reject unknown mutation versions/types.
    *   Require framed machine signals only (example: `<LT_SIGNAL>{...}</LT_SIGNAL>`). Free-form text cannot trigger phase transitions.
    *   Signal routing contract:
        *   valid `blocked` signal routes to `BLOCKED_ERROR`;
        *   valid `decision_required` signal routes to `NEEDS_INPUT`;
        *   missing/invalid signals cannot trigger state transitions and must be logged as validation warnings.
    *   For `edit_file`, require exact unique match semantics for `old_string`; if match count is `0` or `>1`, reject with actionable error.
    *   Support batched mutations in one payload (multiple reads/writes/edits) and validate each operation independently before apply.
    *   Add explicit validator command/API per artifact type and run it before phase transitions (line-numbered errors + actionable fix suggestions).
    *   Validate every model output against schema before acceptance.
    *   Add schema-validation retry ladder for structured outputs:
        *   attempt 1: standard generation against target schema.
        *   attempts 2-3: re-prompt with field-level validation errors from prior attempt.
        *   attempt 4 (optional): escalate to higher-capability repair model for schema-conformant reconstruction.
    *   Add partial-acceptance mode for near-valid payloads: if `valid_field_ratio >= 0.90`, keep valid fields and request only missing/invalid fields in the next retry.
    *   For multi-member council phases, members that fail the retry ladder are marked `invalid_output`; phase continues only if quorum + `min_valid_responses` are still satisfied.
    *   Persist field-level validation reports at `.looptroop/tickets/<ticket-id>/validation/<phase>-<member-id>-<timestamp>.json`.
    *   Add execution-output format contract (`execution_output.v1`) with `json` as primary mode for machine actions/status.
    *   If `json` output is missing/invalid, fall back to text parsing with deterministic extraction rules, then normalize to the same internal schema before any decision/gate evaluation.
    *   Persist parse mode and fallback path used per iteration (`json_primary`, `text_fallback`) for audit/debug.
    *   Add phase-specific `coverage + consistency` gates before transitions:
        *   For each phase, run a read-only analyzer pass first; analyzers may emit findings but cannot mutate artifacts or transition state.
        *   Persist analyzer outputs at `.looptroop/tickets/<ticket-id>/analysis/<phase>-round-<n>.md` and `.json`.
        *   Each finding must include stable `finding_id`, `category`, `severity` (`low|medium|high|critical`), `location`, `summary`, and `recommended_fix`.
        *   Include a requirement coverage matrix in each report: `requirement_id -> mapped_artifact_ids -> mapped_verification_ids`.
        *   Limit detailed findings to 50 per run; summarize overflow by severity/category.
        *   Interview gate: detect unresolved ambiguity, missing constraints, inconsistent answers, and contradiction/overlap collisions (same context/trigger with incompatible outcomes).
        *   If interview analysis detects a contradiction, emit `CONTRADICTION_DETECTED`, add a targeted contradiction follow-up question, and loop back through follow-up answers -> reanalysis until resolved (or explicitly accepted by user policy).
        *   PRD gate: detect missing requirements plus duplicate/overlapping stories with incompatible acceptance criteria.
        *   PRD requirements-writing quality gate: validate PRD text quality (not implementation behavior) for completeness, clarity, consistency, measurability, and edge-case coverage.
        *   Persist PRD writing-quality checklist at `.looptroop/tickets/<ticket-id>/checklists/prd-requirements-quality.md` with item IDs, status (`pass|fail`), and evidence refs.
        *   Beads gate: detect uncovered PRD requirements, missing dependency edges, and sibling overlap on critical files without explicit dependency edges.
        *   Pre-Execution Cross-Artifact Analysis (required, after Beads approval and before execution start):
            *   holistically read Interview + PRD + Beads together and detect contradictions across artifacts;
            *   detect orphaned requirements (Interview requirements not represented in PRD);
            *   detect orphaned epics/stories (PRD items with no corresponding beads);
            *   detect scope creep (beads not traceable to PRD requirements).
            *   Persist machine-readable report at `.looptroop/tickets/<ticket-id>/consistency-report.json`.
            *   Contradictions/orphaned requirements require explicit user resolution or intentional acceptance before execution can start.
            *   Scope-creep findings are warnings by default but require explicit user confirmation.
        *   Verification mapping rule: every acceptance criterion must map to at least one explicit executable verification path.
        *   Auto-refinement loop: each gate may run up to `coverage_refinement_rounds` attempts (default `3`, configurable in settings).
        *   Persist gate telemetry: `phase`, `round`, `findings_count`, `blocking_count`, `status`.
        *   If blocking findings remain after max rounds, transition to `NEEDS_INPUT` or `BLOCKED_ERROR` by policy.
    *   Gate policy (enforcement-layer contract):
        *   analyzers emit findings only and never transition state directly;
        *   classify findings as `blocking` or `warning`;
        *   a dedicated transition guard is the only component allowed to approve/block phase transitions;
        *   any `blocking` finding prevents transition to next phase;
        *   unresolved PRD contradictions route to `NEEDS_INPUT` for explicit user resolution;
        *   do not allow transition to Execution while any blocking coverage/consistency finding remains.
    *   Validate control signals before state transitions; unknown/invalid signals are ignored and logged as warnings.
    *   Normalize tolerated format variants (IDs, whitespace, separators), but log every normalization event as a warning.
    *   Fallback parser chain (bounded): direct JSON parse -> fenced JSON block extraction -> targeted segment extraction -> lightweight JSON repair.
    *   If parsing/validation still fails after bounded retries, mark that member/output as `invalid_output`; continue only when phase quorum + `min_valid_responses` still hold, otherwise move to deterministic failure (`BLOCKED_ERROR`) with exact validation errors and retry guidance.
    *   Persist every parse error + regeneration attempt in ticket-local logs for debugging and future prompt tuning.
    *   Add regression fixture suites for parser behavior, loop-control invariants, and golden end-to-end loop outcomes:
        *   Parser fixtures: LF/CRLF/CR, BOM, unicode, long lines, mixed whitespace, and all real production parse failures.
        *   Loop-control fixtures: max-iteration termination, completion-marker termination, ownership mismatch cleanup, empty-input retry path, and idempotent cancel/stop behavior.
        *   Review-gate invariants:
            *   every epic stores `plan_review_status` and `completion_review_status` with allowed values `unknown | needs_work | ship`;
            *   selector output is normalized for automation: `status = plan | work | completion_review | none` with `reason = needs_plan_review | needs_completion_review | ready_task | blocked_by_epic_deps | none`;
            *   missing/invalid review receipt blocks transition;
            *   wrong ownership fields (`ticket_id` / `flow_id` / `run_id` / `session_id`) block transition;
            *   `needs_work` at plan gate routes back to planning refinement; `needs_work` at completion gate routes back to execution;
            *   transition to manual verification is blocked until completion review is `ship`.
        *   Golden loop suites (multi-language sample repos) must assert: required artifacts are generated and valid, expected terminal states are reached, commit receipts exist for completed beads, and no orphan ownership records remain.
        *   Add `mock-agent replay` E2E mode: replay recorded JSONL cassettes instead of live model calls for deterministic, zero-cost CI.
        *   Cassette naming contract: `<scenario-id>-<model>.jsonl` with `<scenario-id>.jsonl` fallback; missing cassette fails fast.
        *   Allow only explicit safe command prefixes during replay side effects; log skipped commands.
        *   Keep scheduled live-backend E2E runs (for example nightly/weekly) to detect cassette drift.
        *   Add property-based invariant tests alongside fixtures:
            *   state-machine transitions must preserve valid phase progression and reject illegal transitions;
            *   bead-graph operations must preserve DAG validity (no cycles unless explicitly allowed by policy);
            *   parser normalization must be stable/idempotent (normalizing already-normalized input does not change meaning).
            *   loop-controller fixture suites must cover: required-vs-optional preflight gating, machine signal parsing (`bead_done`, `blocked`, `decision_required`), step-timing classifier stability, and control-character/ANSI stripping correctness.
        *   Require each invariant test to declare purpose, invariant statement, and failure impact in test metadata/docs.
        *   Treat every production incident in either class as a permanent fixture test.
    *   Define `runtime.event.v1` normalized stream event types: `assistant_text`, `tool_start`, `tool_result`, `status_marker`, `completion_marker`, `blocked_marker`, `decision_marker`, `final_result`, `error`.
    *   Add optional terminal delta transport for long-running panes/logs: `init` (full snapshot), `patch` (row/column text deltas), `resize`, and `heartbeat` messages.
    *   Add persistent execution shell per ticket run (`node-pty` style): keep one warm terminal session for repeated test/lint commands to reduce cold-start overhead.
        *   shell lifecycle: `spawn_on_coding_start`, `reuse_per_iteration`, `graceful_terminate_on_cleanup`, `force_kill_on_timeout`.
        *   Track ownership-scoped child process trees per active run (`pid`, `ppid`, `command`, `started_at`, `owner_run_id`) and persist snapshots in runtime logs.
        *   On context wipe, retry reset, cancel, or cleanup, terminate owned process trees deterministically (graceful first, bounded forced kill second) and verify no owned children remain.
        *   If owned processes survive kill timeout, emit `child_process_leak` with PID evidence, block the next iteration for that bead, and route by policy (`NEEDS_INPUT` or `BLOCKED_ERROR`).
        *   Persist terminal session receipts in runtime logs (`session_id`, `reused`, `restart_reason`, `latency_delta_ms`).
    *   Persist raw stream lines and parsed events side-by-side; include `parser_version`, `confidence`, and (for delta mode) `sequence_id` + gap-detection metadata.
    *   Add parser sanitation stage before semantic extraction: strip terminal control characters/ANSI artifacts in a derived parsed view while preserving raw source lines unchanged for forensic replay.
    *   Add dual-source marker extraction for completion/block/decision evaluation:
        *   source A: streamed incremental chunks;
        *   source B: final-result envelope/message payload;
        *   if they disagree, emit `marker_source_mismatch`, apply deterministic precedence policy, and continue without silent transition.
    *   Parser line failures must emit `parse_warning` and continue (do not hard-fail on a single malformed line).
*   **Interactive Conflict Resolution (prevent + resolve + `needs_review` contract):** (between bead worktrees)
    *   If a merge conflict is too complex for AI to safely resolve, set state to `needs_review`, trigger an interactive interview with the user, and stop autonomous retries.
    *   Add prevention rules before merge:
        *   define `restricted_shared` files (README, lockfiles, root configs, global manifests);
        *   block edits to `restricted_shared` unless the file is explicitly listed in bead `target_files`;
        *   log blocked write attempts with bead ID and file path.
    *   Add severity routing when conflicts still happen:
        *   `low` -> automatic merge attempt + targeted tests,
        *   `medium` -> AI-assisted merge + focused verification,
        *   `high` -> `needs_review` + interactive user resolution.
    *   For `high` severity (or policy violations), require structured steering payload before retry: `selected_strategy`, `priority_side`, `must_keep_changes[]`, `must_drop_changes[]`, `notes`.
    *   Retry only the conflicted merge step with provided steering; keep prior artifacts immutable for auditability.
    *   Persist one conflict report per event with files involved, severity, attempted strategy, final outcome, `needs_review_reason`, and `review_resolution`.
*   **Project Context Awareness:** During project creation, distinguish between "Demo" and "Production" environments to adjust the AI's safety protocols and architectural rigor.
*   **Sandboxing & Guardrails (policy profiles + permission-denial remediation):**
    *   **Pre-execution command safety guard:**
        *   Every agent-issued shell command must pass a command-safety guard before execution.
        *   The guard must parse command chaining (`&&`, `||`, `;`, pipes) and validate each segment independently.
        *   The guard must detect dangerous commands hidden in command substitution (`$(...)` and backticks) and block them.
        *   Decision contract must be machine-readable: `allow | confirm_required | block`, with reason codes.
        *   Safety-critical parsing/validation failures must be `fail_closed` (block), not silent allow.
        *   The guard must hard-block known destructive signatures (`rm -rf /`, raw-disk `dd`, fork-bomb patterns) even when runtime permission mode is `--yolo`/allow-all.
        *   Enforce path confinement before execution: command targets must resolve inside the active project/worktree root; out-of-bound paths are blocked with deterministic reason codes.
        *   Persist guard decisions to `.looptroop/tickets/<ticket-id>/safety/command-guard.jsonl`.
    *   Research a sandbox isolation solution (Docker / namespaces / VM).
    *   Add explicit sandbox config contract:
        *   `sandbox.enabled`,
        *   `sandbox.mode` (`auto` | `bwrap` | `sandbox-exec` | `off`),
        *   `sandbox.network`,
        *   `sandbox.allow_paths[]`,
        *   `sandbox.read_only_paths[]`.
    *   Add backend request-origin allowlist contract:
        *   default allowlist includes local UI origins (`http://localhost:<ui-port>` and `http://127.0.0.1:<ui-port>`);
        *   support custom comma-separated allowlist via `LOOPTROOP_ALLOWED_ORIGINS` for LAN/remote access;
        *   reject non-allowlisted origins with deterministic `403` + machine-readable reason code;
        *   validate origin policy during `Doctor`; invalid/unsafe origin config blocks run start with actionable remediation.
    *   Add platform/backend mapping contract:
        *   Linux -> `bwrap`,
        *   macOS -> `sandbox-exec`,
        *   Windows -> `off` unless running in WSL2 (then Linux mapping applies).
    *   In `auto` mode, choose the most secure available backend for the current platform; if unavailable, downgrade to `off` with explicit warning diagnostics.
    *   Add isolation fallback contract:
        *   if worktree setup fails due to repo topology/path errors (nested worktree repos, invalid `.git/worktrees` path, unsupported linked-repo state), auto-fallback to sandbox mode for that run;
        *   persist fallback decision at `.looptroop/tickets/<ticket-id>/parallel/<run-id>/isolation-report.yaml` with `requested_mode`, `effective_mode`, `fallback_reason`, `timestamp`.
    *   Add lightweight sandbox profile for fallback:
        *   symlink read-only heavy dependency folders by default (`node_modules`, `.git`, `.venv`, `.pnpm-store`, `.yarn`, `.cache`);
        *   copy writable source/config paths into sandbox with preserved mtimes for deterministic modified-file detection;
        *   detect changed files using `mtime + size`, with hash fallback when metadata is ambiguous;
        *   sync back only detected modified files.
    *   Add sandbox failure handling:
        *   cleanup must retry lock-related filesystem errors (`EBUSY`, `EPERM`, `ENOTEMPTY`) with bounded exponential backoff before giving up;
        *   if sandbox execution fails after modifications, preserve sandbox folder under `.looptroop/tickets/<ticket-id>/preserved-sandboxes/<run-id>/<worker-id>/` for manual recovery;
        *   cleanup report must list removed vs preserved sandbox folders and include failure reason codes.
    *   Add sandbox file-transfer safety contract:
        *   copy-in excludes secrets by default (`.env*`, private keys, credential files) and heavy dependency/build folders;
        *   copy-in skips very large files by default (example `>1MB`) unless explicitly allowlisted by ticket metadata;
        *   copy-out back to local/project branch respects `.gitignore` plus explicit denylist so secrets are never synced.
    *   Add execution policy profiles (`strict`, `balanced`, `afk`) that define command allow/deny/confirm-required lists.
    *   Add action-scoped capability manifests (`allowed_tools.v1`) per phase/bead with exact tool names, command patterns, and writable path globs (default deny outside manifest).
    *   Add deterministic execution-primitives catalog for unattended runs:
        *   provide versioned primitives for common actions (`run_tests`, `run_lint`, `run_typecheck`, `install_deps`, `apply_patch`) with typed input/output contracts;
        *   default execution path uses primitives first; raw shell commands are fallback-only when no matching primitive exists and policy explicitly allows fallback;
        *   primitive responses must return structured failure payloads (`failure_class`, `hint`, `stdout_tail`, `stderr_tail`, `evidence_ref`) to avoid dumping unbounded raw logs into model context.
    *   Require every tool invocation to carry a `capability_id`; orchestrator rejects calls that do not match the active manifest before execution.
    *   Block high-risk actions by default (for example: force-push, destructive deletes outside project root, remote script execution without integrity verification).
    *   Deny destructive git wipe commands by default (`git reset --hard`, `git clean -fd`) unless running inside a disposable ticket workspace with a validated pre-action snapshot + explicit rollback receipt.
    *   If policy explicitly permits destructive cleanup in disposable workspace, require protected exclusions (`-e .looptroop/`, dependency caches such as `node_modules`, `.venv`, and package-manager stores) unless an explicit per-run override is approved and audited.
    *   Before any allowed destructive cleanup/reset, persist a pre-wipe recovery receipt with `state_version`, `issues_jsonl_hash`, `journal_cursor`, and `notes_count`; abort wipe when receipt write/verification fails.
    *   Add non-destructive untracked-file wipe contract for retry/debug safety:
        *   default untracked cleanup path is `git stash push --include-untracked` with deterministic stash message (`looptroop-wipe/<ticket-id>/<run-id>/<iteration>`) and persisted stash ref in wipe receipt;
        *   fallback path moves untracked files into `.looptroop/graveyard/<ticket-id>/<run-id>/<timestamp>/` with `original_path`, `size`, and hash manifest for forensic recovery;
        *   `git clean -fd` is never the default path; allow it only in explicit `full_clean` mode with audited override receipt after operator confirmation.
    *   Add context-wipe correctness verifier: after `git reset --hard` / `git clean -fd`, compare workspace to the bead-start snapshot manifest and fail with `wipe_restore_mismatch` on any drift.
    *   Snapshot manifest must include tracked files plus iteration-created untracked files so each wipe restores exact bead-start state.
    *   Add explicit context-wipe mode selector per project/run:
        *   `tracked_only` (default): restore tracked files to bead snapshot while preserving untracked dependency caches/work dirs;
        *   `full_clean` (opt-in): allow destructive clean only in disposable ticket workspace with protected exclusions plus audited override receipt;
        *   persist selected `wipe_mode` in run state so retries/resume stay deterministic.
    *   Add always-on writable-path sentry before every mutation:
        *   writes must stay inside active project root and ticket workspace allowlist;
        *   deny writes to `.git/`, parent directories, and user-home/global paths by default;
        *   on violation, emit `write_boundary_violation` and route by policy (`strict` -> `BLOCKED_ERROR`, others -> `NEEDS_INPUT`).
    *   Add active-worktree boundary enforcement for every runtime command/session:
        *   resolve canonical `realpath` for each target path and require prefix match with active ticket worktree root;
        *   reject symlink/`..` escapes and branch/worktree mismatches with deterministic reason code (`active_worktree_boundary_violation`);
        *   apply the same boundary check to SDK session `cwd` before prompt execution.
    *   Add post-step forbidden-path diff guard (defense in depth):
        *   after each tool batch/iteration, compute `git diff --name-only` against bead baseline;
        *   if forbidden paths changed (for example approved planning artifacts or paths outside the active ticket/worktree allowlist), auto-revert those files, append structured note to bead `notes`, and emit `forbidden_path_reverted`;
        *   repeated violations follow policy escalation (`strict` -> `BLOCKED_ERROR`, others -> `NEEDS_INPUT`).
    *   Add post-iteration diff-anomaly sentinel (self-correction safety net):
        *   classify `empty_diff_no_progress` when an iteration ends with no semantic changes in target files; do not create commit/push for that iteration and increment stagnation evidence.
        *   classify `oversized_diff` when changed-lines/file-count exceeds policy threshold for the current bead size class.
        *   classify `critical_path_mutation` when runtime/infra-critical files (for example lockfiles, CI config, deployment manifests) are changed outside bead intent.
        *   for `oversized_diff` and `critical_path_mutation`, pause progression, persist anomaly receipt with diff summary, and require explicit user confirmation before continuing.
    *   Validate policy configuration during `Doctor`; invalid/missing policy blocks execution with actionable remediation text.
    *   Validate sandbox backend availability and sandbox path rules during `Doctor`; invalid/unsafe sandbox config blocks execution with actionable remediation.
    *   If `sandbox.network=false` and selected provider/capabilities require network access, block run start with deterministic remediation guidance.
    *   Persist sandbox evaluation artifact at `.looptroop/tickets/<ticket-id>/preflight/sandbox-evaluation.yaml`.
    *   Persist blocked-command attempts in execution logs with timestamp, policy id, and reason.
    *   Add approval request queue for `confirm-required` actions with explicit lifecycle contract:
        *   states: `waiting`, `released`, `expired`, `cancelled`; every transition stores actor + timestamp + reason.
        *   create `approval_request` records with `request_id`, `ticket_id`, `flow_id`, `run_id`, `action`, `reason`, `proposed_command`, `expires_at`, `status`, `released_by`, `released_at`, `feedback`.
        *   pause only the affected worker/loop step and route ticket to `NEEDS_INPUT` with explicit choices: `approve_once`, `deny_once`, `always_allow_for_run`.
        *   on timeout, transition to `expired`, apply deterministic default from policy (`deny` for `strict`, configurable for `balanced/afk`), and log outcome.
        *   after user decision, transition to `released`/`cancelled` and resume from the exact paused step with preserved ownership/run metadata.
    *   Permission-denial contract:
        *   classify denial cause as `policy_denied`, `tool_unavailable`, or `auth_denied`;
        *   extract denied command/tool and generate a suggested remediation patch;
        *   if the same denial repeats for `N` consecutive attempts (default 2), pause execution and route to `NEEDS_INPUT` with explicit user actions;
        *   after user action, resume with preserved ownership/run metadata.
    *   Allow per-ticket temporary override only with explicit user confirmation and audit log entry.
*   **Nested Parallel Flows:** Allow parallel flows (running in its sequential mode) to spawn additional sub-parallel flows that can handle their own blocking dependencies.
*   **Execution Dispatcher + Queue State Contract (atomic claim + lease + transition guards):**
    *   Materialize runnable beads into `.looptroop/tickets/<ticket-id>/execution-queue.jsonl` before dispatch.
    *   Queue item contract: `queue_id`, `ticket_id`, `flow_id`, `bead_id`, `priority`, `state`, `attempt`, `claim_owner_run_id`, `claim_version`, `lease_expires_at`, `enqueued_at`, `started_at`, `completed_at`, `error_code`, `source_signature`, `source_cursor`, `last_transition_at`, `transition_reason`.
    *   Enqueue operation must be idempotent with dedupe key `{ticket_id, flow_id, bead_id, source_signature}`; duplicates emit `enqueue_deduped` and do not create additional runnable items.
    *   Claim operation is compare-and-swap: claim succeeds only when `state=PENDING` and `claim_version` matches current value; on success set `state=RUNNING`, increment `claim_version`, and assign lease fields atomically.
    *   Lease heartbeat can be renewed only by dispatcher. Expired `RUNNING` items are deterministically returned to `PENDING` (with retry metadata), preventing stuck ownership.
    *   Allowed transitions (strict): `PENDING -> RUNNING -> COMPLETED | FAILED | CANCELLED` and `PENDING -> CANCELLED`; terminal states are immutable.
    *   Add a transition validator for every queue state mutation; invalid transition attempts must be rejected and logged as `queue_invalid_transition` with `from_state`, `to_state`, `queue_id`, and `reason`.
    *   Only dispatcher can mutate queue item state. UI and agent signals may request actions, but cannot write queue state directly.
    *   On restart, run two-step recovery:
        *   step 1: reattach to still-alive running workers and preserve `RUNNING` state;
        *   step 2: for non-reattachable `RUNNING` items, transition to `FAILED` with `error_code=worker_interrupted_on_restart`.
    *   After recovery, rebuild dispatcher runtime from queue artifact + ticket runtime state; resume from the highest committed `source_cursor` per flow and continue from the last valid transition without double-processing.
    *   Parallel worker-mode contract:
        *   Dispatcher is the only component allowed to mutate tracker state (`issues.jsonl`, dependency links, and authoritative bead status).
        *   Worker engines run in `worker_mode` with one pre-assigned bead (`forced_bead_id`) and must not run tracker discovery/sync/select-next-task inside worktree folders.
        *   Worker output is merged first; only after merge + verification succeeds may dispatcher mark bead `done` and advance dependency graph state.
*   **Cost-Efficient Model Configuration:** Add an option to select a fast, cheap (or free) model for executing simple beads that do not require high intelligence.
*   **Runtime Resource Budgets, Backpressure & Eviction Policies:**
    *   Define versioned `backpressure-policy.v1` that combines resource backpressure + quality backpressure under one deterministic contract.
    *   Backpressure gate classes:
        *   `technical_gates`: tests, lint, typecheck, security/audit checks.
        *   `behavioral_gates`: readability/maintainability/verdict checks (LLM-as-judge with evidence).
        *   `documentation_gates`: README/API docs/examples/operational notes completeness.
    *   Define hard caps for buffers, map-like registries, watchers, SSE clients, per-ticket stream readers, and pending event queues.
    *   Add explicit backpressure states: `normal`, `degraded`, `critical` based on queue depth, memory usage, and event lag thresholds.
    *   Backpressure actions must be deterministic by state:
        *   `degraded` -> throttle non-critical streams and reduce polling frequency.
        *   `critical` -> pause new non-essential jobs, preserve only safety-critical events, and surface `NEEDS_INPUT` if recovery fails.
    *   Quality backpressure reason codes must be explicit and machine-readable: `missing_tests`, `lint_failed`, `typecheck_failed`, `marker_invalid`, `verifier_missing`.
    *   Resource backpressure reason codes must be explicit and machine-readable: `queue_depth_exceeded`, `memory_cap_exceeded`, `event_lag_exceeded`, `watcher_cap_exceeded`.
    *   Every pause/reject/defer action must emit `reason_code`, `policy_version`, and `recommended_action` in runtime logs and diagnostics.
    *   Support quality-intent profiles by phase/mode:
        *   `prototype` - optimized for speed/learning; keeps core safety checks but allows lighter non-critical quality gates.
        *   `production_app` - default for customer-facing software; requires full technical + behavioral gates.
        *   `production_library` - strictest mode for reusable/public APIs; adds compatibility, docs completeness, and stronger regression gates.
    *   Support explicit backpressure patterns:
        *   `all_or_nothing` - all required gates must pass before completion.
        *   `gradual` - escalate required gates by iteration/phase.
        *   `escape_hatch` - bounded waiver path for exceptional cases (for example flaky tests) with mandatory documentation.
    *   Escape-hatch/waiver contract:
        *   required fields: `waiver_id`, `reason`, `scope`, `approved_by`, `created_at`, `expires_at`, `compensating_checks`.
        *   expired waivers are invalid automatically and must re-enter gate flow.
    *   Anti-pattern guards:
        *   `no_backpressure` is forbidden for unattended execution.
        *   `fake_evidence` claims must trigger verifier re-check before acceptance.
        *   `too_many_gates` detector warns when configured gate set exceeds phase budget and recommends simplification.
    *   Use LRU eviction for bounded caches and TTL expiration for stale runtime entries.
    *   Expose current usage, cap percentages, backpressure state, and last mitigation action in diagnostics (`Doctor`) and health endpoints.
    *   Add deterministic health endpoint contract (liveness vs readiness):
        *   `/api/health/live` (cheap): process uptime, event-loop lag, and server version only.
        *   `/api/health/ready` (bounded checks): SQLite read/write probe, OpenCode connectivity ping, and execution queue lag against thresholds.
        *   Readiness state must be one of `ready`, `degraded`, or `not_ready` with stable reason codes and recommended remediation text.
        *   Persist periodic health snapshots at `.looptroop/project/health/health-<timestamp>.json` for unattended-run diagnostics.
    *   Keep current debounced artifact watchers (default 300ms) as one sub-part of this broader safety budget.
*   **Smart Model Selection:** Display operational model metadata and enforce safe-routing rules.
    *   Show context window, max prompt tokens, cost tier, and modality support (e.g., vision).
    *   Sorting by performance, cost (and mark free options), speed.
    *   Add optional `research_model` role (separate from implementer/council/fallback), intended for web-grounded planning support.
    *   For Interview, Proposal, Options Synthesis, Design, and Beads planning phases, support a bounded research pre-pass that generates an `External Research Brief` (official docs, current versions, breaking changes, security advisories, migration notes, best-practice notes, and source links).
    *   External Research Brief output is read-only context for council drafting and is never counted as a council vote.
    *   Research pass is non-blocking: configurable timeout (default 5 minutes); on timeout/failure, continue planning with warning `research_pass_skipped`.
    *   Persist research artifacts at `.looptroop/tickets/<ticket-id>/research/external-brief-<phase>-<timestamp>.json` with provenance metadata, retrieval time, freshness, confidence, and source type.
    *   Distinguish official docs, vendor announcements, security advisories, and community commentary in the stored source metadata.
    *   Capture conflicts or uncertainty explicitly instead of smoothing over contradictory sources.
    *   Enforce source allowlists, recency filters, and max injected-token budget before adding findings to planning context.
    *   Add optional `council_web_search` during council drafting phases (Interview/Proposal/Options Synthesis/Design/Beads):
        *   provider options: `duckduckgo` (default), `tavily`, `exa`, `brave` (project-configurable).
        *   bounded retrieval contract: max 5 results, max 2000 injected tokens, source allowlist + recency filter.
        *   if ticket mentions specific technologies, auto-generate a focused tech brief (`stable_version`, `breaking_changes`, `security_advisories`, `recommended_patterns`).
        *   persist search snapshots at `.looptroop/tickets/<ticket-id>/research/web-search-<phase>-<timestamp>.json`.
        *   search failure is non-blocking and emits `council_web_search_skipped`.
    *   Add council composition diversity indicator based on provider/model-family mix:
        *   `green`: 3+ families/providers.
        *   `yellow`: 2 families/providers.
        *   `red`: 1 family/provider.
    *   When diversity is red, show warning and optional `recommend_diverse_council` auto-suggestion from configured models.
    *   Add adaptive reasoning budgets per phase with provider-mapped settings:
        *   Interview generation: `medium`.
        *   Proposal/Options/Design drafting: `high`.
        *   Beads decomposition: `high`.
        *   Implementation: `medium`.
        *   Coverage/verification passes: `high`.
*   **Fallback Implementer (provider-aware retries + deterministic rotation):** Configure secondary and tertiary models. If the primary model gets stuck after a set number of iterations (default: 3), the system automatically attempts the bead with the next model.
    *   **Council meeting:** If the main implementer fails to implement the task and makes no progress while trying to fix it, run a council meeting before starting a new iteration, based on what has been done so far and which errors were found. Each member provides a solution, then the main implementer summarizes it and adds it to the bead Notes. This repeats for each iteration until the task is completed or max iterations are reached, then it is passed to the secondary implementer. The same procedure applies until max iterations are reached or the task is completed, then it is passed to the tertiary implementer (if configured).
    *   **Pattern-Based Provider Failure Detection + Failure-Class Contract:** Add configurable case-insensitive patterns (e.g., `rate limit`, `quota exceeded`, `maintenance`, `service unavailable`, `timeout`, `connection reset`) and classify matches as `provider_transient_failure` or `fatal_setup_or_auth_failure`.
    *   **Failure Signal Extraction (structured-first, plain-text fallback):**
        *   parse failures in deterministic order: structured provider/tool payloads -> explicit auth/setup markers -> plain-text fallback parsing;
        *   persist `failure_class`, `parser_mode`, `source_channel`, and `error_excerpt_last_12_lines` for each failed attempt;
        *   feed persisted `failure_class` into deferral/rotation/escalation decisions.
    *   **API Resilience:** Implement automated retry logic with configurable delay (default: 1 minute), exponential backoff + jitter, and max retries (default: 10) for provider/transient failures.
    *   **Provider Deferral Ledger (durable):** Persist transient-failure deferrals per `{ticket_id, flow_id, bead_id, model_id, failure_signature}` in `.looptroop/tickets/<ticket-id>/provider-deferrals.json` with `deferral_count`, `first_seen_at`, `last_seen_at`. Stop run early on repeated transient failures and resume from deferred items first.
    *   **Retry Budget Split (important):**
        *   provider/transient failures do **not** consume bead iteration budget;
        *   code/test failures consume bead iteration budget as usual.
    *   **Escalation:** If provider deferrals exceed `provider_max_deferrals`, switch to next fallback model; if all fallback paths fail, set `BLOCKED_ERROR` with exact reason and next action.
    *   **Deterministic Rotation Mode (optional):** Support proactive rotation policies (`off`, `per_iteration`, `per_bead`) with an explicit ordered list of model targets.
    *   **Rotation Safety Rules:** Freeze rotation order at run start; persist active rotation index in runtime state; on resume, continue from persisted index to avoid non-deterministic behavior.
    *   **Quota Management:** Option to continue with the same model even though the quota has expired, with configurable retry interval (default every 10 minutes) and max wait window (default 24 hours).
    *   **Provider Window Limit Handling:**
        *   Detect provider hard-window limits via explicit pattern matching + provider metadata when available.
        *   When window limit is hit, require deterministic user action selection: `wait_for_reset`, `switch_model`, or `exit_ticket`.
        *   For unattended/AFK mode, apply configured default action with timeout fallback (for example auto-`wait_for_reset` for N minutes, then escalate).
        *   Persist decision + timeout path in runtime logs (`limit_type`, `detected_at`, `selected_action`, `auto_fallback_action`).
    *   Persist retry/rotation timeline in logs (`attempt`, `delay_ms`, `pattern`, `action_taken`, `model_used`, `rotation_index`).
    *   Persist provider command failure evidence in `.looptroop/tickets/<ticket-id>/provider-failures.jsonl` with `provider_id`, `command_id`, `exit_code`, `stderr_tail`, `stdout_tail`, and `classifier_result` (bounded tails: max 30 lines each).
*   **Timeout + Inactivity Watchdog + Stagnation Heuristics:**
    *   Add phase-timeout + quorum policy for council/planning phases (defaults: `AI response timeout = 15 minutes`, `minimum council quorum = 2`):
        *   `AI response timeout` is a hard wall-clock deadline per model-output prompt during scan, planning, drafting, voting, coverage, review, final-test generation, and PR-drafting phases.
        *   `minimum council quorum` defines the minimum number of valid council responses required to proceed with voting; if not met, ticket transitions to `BLOCKED_ERROR`.
        *   start a per-prompt timer when the AI request is dispatched to that model; timeout value comes from `council_response_timeout`.
        *   `first-N-complete`: complete the phase early when `min_completed_votes` is reached and quorum criteria are satisfied.
        *   hard-timeout enforcement: wrap each member dispatch in an abortable deadline; when timeout is reached, force-cancel the active SDK request/stream, mark that member `timed_out`, and emit timeout evidence (`phase`, `member_id`, `elapsed_ms`).
        *   if a member does not respond before timeout, or is force-aborted at deadline, mark that member `timed_out` for the active phase.
        *   if a member responds with malformed/invalid output, mark that member `invalid_output` for the active phase.
        *   if timeout occurs after quorum is met, continue in degraded mode with all valid responses and emit `phase_timeout_degraded` with missing responder IDs.
        *   if valid responses are below minimum quorum, set ticket to `BLOCKED_ERROR`; user can retry the phase or choose different models.
        *   Add quorum-failure fallback policy (`strict_block` or `fallback_to_quick_after_n`); default threshold `n=2` for the same `phase + input_hash`.
        *   On threshold hit, surface one-click `retry_single_model` action that reruns that phase via `execution_profile=quick`, persisting `council_fallback_receipt` with original failure evidence.
        *   persist phase heartbeat/status events (`phase_started`, `phase_heartbeat`, `phase_timeout`, `phase_completed`) including elapsed time and pending responders.
        *   add idempotent phase-job receipts per member dispatch (`phase_job_id = ticket_id + phase + round + member_id`) with `started|completed|failed|timed_out`.
        *   on restart/re-entry, reattach to `started` phase jobs by `phase_job_id` and avoid duplicate dispatch unless explicit retry increments `dispatch_attempt`.
        *   persist pre-dispatch idempotency records for every provider call (`step_id`, `phase`, `member_id`, `input_hash`, `dispatch_attempt`, `status`) before sending requests.
        *   on restart, reconcile by `input_hash`: reuse completed outputs when hashes match, dispatch only missing members, and require explicit retry to re-dispatch completed members.
        *   add durable provider-result replay contract:
            *   derive deterministic `idempotency_key` per provider call (`ticket_id`, `flow_id`, `phase`, `step_id`, `member_id`, `input_hash`, `model_id`);
            *   persist provider result envelope (`status`, `output_hash`, `output_artifact_path`, `completed_at`) before downstream phase mutations;
            *   on crash/restart, if a `completed` record exists for the same `idempotency_key` and hashes validate, reuse cached output and skip duplicate provider dispatch.
    *   Add structured-output resilience for council/planning phases (`json_repair_mode`):
        *   on malformed structured output, attempt repair before invalidation: strip preamble before first `{`/`[`, close unbalanced brackets/braces, then re-validate against schema;
        *   if repair succeeds, accept repaired payload and emit `repaired_output` warning with repair details;
        *   if repair fails, mark payload `invalid_output` and continue existing quorum/failure policy.
    *   Add max duration for a bead iteration (default 30 minutes), then switch model/fallback path.
    *   Enforce per-iteration timeout using provider-call cancellation (`AbortController` + `AbortSignal.timeout`) rather than polling loops; timeout errors must flow through normal retry/evidence paths.
    *   Add explicit circuit-limit keys (with hard maximums) to avoid unbounded loops:
        *   `max_interview_followup_rounds` (default `8`);
        *   `coverage_refinement_rounds` (default `3`, hard max `6`);
        *   `max_phase_wallclock_minutes` (phase-scoped cap, default policy-driven).
        *   track coverage refinement counters per phase (`interview`, `proposal/prd`, `beads`) in runtime state so restart/resume preserves loop budget.
        *   when a coverage counter hits limit with unresolved gaps, emit `coverage_limit_reached` with remaining gap summary and route by policy (`NEEDS_INPUT` default, `BLOCKED_ERROR` strict).
    *   When any circuit limit is reached, stop autonomous retries for that phase and move to `NEEDS_INPUT` with a structured overrun summary + recommended next action.
    *   Add ticket wall-clock budget contract (default `max_ticket_runtime_hours=100`):
        *   preflight computes upper-bound estimate from bead count, iteration caps, and configured timeouts;
        *   if estimate exceeds budget, require explicit user confirmation before run start;
        *   runtime tracks `elapsed_wall_clock_hours` and emits threshold alerts (`80%`, `90%`, `100%`);
        *   at `100%`, transition by policy to `NEEDS_INPUT` (default) or `BLOCKED_ERROR` with budget-overrun diagnostics.
    *   Add explicit loop modes:
        *   `bounded` (default) - `max_iterations > 0`.
        *   `unbounded` - `max_iterations = 0`.
    *   Entering `unbounded` mode requires explicit user confirmation and a visible `UNBOUNDED` runtime warning.
    *   Allow switching from `unbounded` to `bounded` at runtime without resetting current bead progress.
    *   Add context saturation guard:
        *   track `context_used_pct` per iteration using provider telemetry when available;
        *   if `context_used_pct` reaches warning threshold (default 80%), run deterministic compaction before handoff:
            *   compact oldest low-signal logs/tool chatter into a structured summary block with source references;
            *   keep recent iteration evidence raw and prefer trimming historical verbose stderr/stdout first;
            *   persist compaction receipts (`before_tokens`, `after_tokens`, `saved_pct`, `source_ranges`, `model_id`) for auditability.
        *   if post-compaction `context_used_pct` is still above hard threshold (default 90%) or compaction fails, trigger deterministic handoff before next model call;
            *   if provider supports native handoff/compaction, use provider-native handoff;
            *   otherwise generate deterministic fallback handoff artifacts (`handoff-summary.md` + `handoff-queue.json`) and persist bounded resume context at `.looptroop/tickets/<ticket-id>/runtime/next-session-context.md`;
            *   separate handoff reasons: `compaction_handoff` (context saturation) and `session_end_handoff` (runtime/session termination);
            *   on startup/resume, inject only project-matching handoff context and enforce a max context-injection budget before first model call;
            *   persist handoff events (`threshold_reached`, `handoff_started`, `handoff_completed`, `handoff_failed`) in runtime logs with threshold and reason.
    *   Track per-iteration progress signals: file/content delta count, iteration duration, repeated error signatures, and tool-call volume.
    *   Classify progress signals with semantic-change filtering:
        *   ignore non-semantic churn (whitespace/key-order/format-only rewrites in YAML planning artifacts or editor normalization noise);
        *   count progress only when code/test-relevant files change semantically or when verification state advances.
    *   Trigger `stagnation_warning` when no file/content changes occur for N consecutive iterations (default 3) or when very short iterations repeat N times (default 3).
    *   Add inactivity watchdog (default 60s no artifact/code/log activity) with explicit operator actions:
        *   continue waiting,
        *   retry current iteration,
        *   skip bead,
        *   stop ticket.
        *   unattended default: if no OpenCode stream events and no command stdout/stderr for `stuck_no_output_seconds` during `CODING`/`RUNNING_FINAL_TEST`, auto-cancel the hung operation, mark iteration failed as `stuck_no_output`, and follow deterministic retry policy.
        *   Add low-cost OpenCode heartbeat probes during long-running beads (default every `120s`) independent of stream inactivity; persist `agent_heartbeat` events with latency and error class.
        *   On consecutive heartbeat failures (`N`, default 2), attempt deterministic session reattach first; if reattach fails and `opencode_auto_restart` is enabled, run configured restart command with cooldown/backoff and bounded attempts before escalation.
        *   Persist and reuse OpenCode SDK `session_id` values per phase/run so reconnect paths resume prior sessions before creating replacement sessions.
        *   Run explicit OpenCode health checks at startup, preflight, before every AI phase entry/dispatch, and during long-running execution; failures trigger bounded reconnect attempts with deterministic escalation.
        *   If pre-phase OpenCode ping fails, do not enter the target AI phase; transition to `BLOCKED_ERROR` with explicit `phase`, `reason=opencode_unreachable`, and remediation actions.
        *   When OpenCode is unavailable, surface a persistent UI state (`opencode_unavailable`), pause new dispatches, and expose recovery actions (`retry_healthcheck`, `reconnect`, `cancel`).
        *   Heartbeat recovery actions must not consume bead iteration budget until the active bead command is retried and fails under normal loop rules.
        *   after `stuck_auto_recoveries_max` recoveries on the same bead, stop auto-recovery and escalate to `BLOCKED_ERROR` with remediation guidance.
    *   Persist inactivity/stagnation events and selected actions in execution logs for audit/recovery.
*   **Deterministic Bead Loop Control Artifact (Ralph-style, bead-scoped):**
    *   At bead start, create `.looptroop/tickets/<ticket-id>/loops/<flow-id>/<bead-id>.loop.md` with frontmatter: `active`, `ticket_id`, `flow_id`, `bead_id`, `iteration`, `max_iterations`, `loop_mode`, `completion_intent`, `started_at`, `updated_at`.
    *   Keep the markdown body as the canonical bead instruction; retries must reuse this instruction body unchanged to prevent prompt drift.
    *   On each retry, only update runtime evidence fields (iteration counters, notes, validation evidence, failure summaries); do not mutate canonical instruction text.
    *   If loop artifact is missing/corrupted/unreadable, stop autonomous retry and route ticket to `BLOCKED_ERROR` with exact remediation.
    *   Persist loop artifact lifecycle events (`created`, `validated`, `retry_started`, `retry_completed`, `canceled`, `quarantined`) in runtime logs.
*   **Execution Logging + Away Summary + Transcript Intelligence (channelized + visibility-aware + replay-safe):**
    *   Keep structured event logs with stable fields: `event_id`, `event_type`, `severity`, `title`, `details`, `timestamp`, `ticket_id`, `run_id`, `flow_id`, `state_version`, `metadata`, `visibility`.
    *   Treat append-only event logs as the primary SSE replay source; reconnect catch-up must read persisted events by `event_id` (not in-memory cursor state).
    *   Persist per-command execution audit stream at `.looptroop/tickets/<ticket-id>/runs/<run-id>/execution-log.jsonl` with `command_id`, `tool`, `cwd`, `argv_redacted`, `command_hash`, `started_at`, `ended_at`, `duration_ms`, `exit_code`, `timed_out`, and truncated `stdout/stderr` digests.
    *   `execution-log.jsonl` integrity contract: append-only writes with per-write `fsync`; on startup, truncate only one incomplete trailing line (if present) and preserve all prior valid lines.
    *   `execution-log.jsonl` is non-authoritative audit/debug evidence; authoritative resume correctness is SQLite state + run journal. Missing/truncated command logs must not block resume when authoritative stores are healthy.
    *   Add Node/Bun event-loop protection contract for long-running logs:
        *   offload heavy `execution-log.jsonl` work (large readback, parse/stringify, regex search/filter, compaction, index/replay scans) to Worker Threads/process workers;
        *   main API/SSE thread remains orchestration-only (routing, heartbeats, cursor control, streaming) and must avoid synchronous large-log parsing;
        *   worker-to-main responses must stream in bounded chunks so reconnect replay and catch-up never starve heartbeats.
    *   Emit required bead-attempt lifecycle events: `attempt_started`, `attempt_failed`, `attempt_retried`, `attempt_succeeded` with `bead_id`, `attempt`, and failure/exit evidence.
    *   Add deterministic log-retention contract for long runs:
        *   rotate `.jsonl` log streams by size/time into numbered segments and keep a segment manifest with hashes + byte counts;
        *   gzip sealed segments and keep active segment uncompressed for tailing/replay;
        *   enforce per-ticket log-disk budget with deterministic eviction order (oldest successful run segments first; latest failed run is always retained).
    *   Add dependency-aware event handler execution:
        *   handlers can declare `depends_on` relations;
        *   event bus builds deterministic execution levels (dependency order), with async handlers concurrent inside the same level.
    *   Add scoped temporary handlers for tests/diagnostics (`scoped_handlers`) so instrumentation can be attached and removed safely.
    *   Persist append-only audit stream at `.looptroop/tickets/<ticket-id>/events/audit.jsonl` and derive user timeline/feed projection at `.looptroop/tickets/<ticket-id>/events/feed.jsonl`.
    *   Maintain a fast ticket conversation index at `.looptroop/project/conversation-index.json` with `ticket_id`, `title`, `status`, `last_activity_at`, `last_phase`, and `preview`.
    *   Sidebar/filter/search reads this index first for fast lookup; detailed logs are loaded only on open.
    *   If the index is missing/corrupt/stale, rebuild it from ticket artifacts + audit logs on startup and emit `conversation_index_rebuilt` with counts + duration.
    *   Persist index integrity metadata (`source_hash`, `rebuilt_at`, `entry_count`) for diagnostics.
    *   Add live council stage streaming (`Council Chamber`) for planning phases:
        *   stage visibility: `first_opinions`, `adversarial_critique`, `voting`, `synthesis`.
        *   ticket view can expand drafts while deliberation continues; voting matrix is shown with anonymous candidate labels.
        *   at phase completion, show a council scorecard with `candidate_id`, per-voter score, weighted total, and winner rationale (anonymize voter identity by policy).
        *   SSE events: `council_stage_start`, `council_draft_received`, `council_critique_received`, `council_vote_cast`, `council_winner_selected`.
        *   persist council stage timeline at `.looptroop/tickets/<ticket-id>/council/stage-events.jsonl`.
    *   Emit `.looptroop/tickets/<ticket-id>/runtime-status.json` on interval and on state changes with: `phase`, `active_bead`, `loop_count`, `max_iterations`, `loop_mode`, `completion_intent`, `status`, `last_success_at`, `current_blocker`, `recommended_action`, `last_cancel_reason`, `afk_ready`, and `afk_blockers[]`.
    *   Split runtime logs by channel: main run log (global orchestration timeline), per-worker/per-flow logs (isolated execution trace), merge/conflict log (all merge decisions and outcomes); all channels use monotonic `log_id`.
    *   Event identity contract:
        *   `event_id` must be globally unique (ULID/UUIDv7), and duplicate IDs are rejected idempotently.
        *   every state transition increments monotonic `state_version`, persisted atomically with transition receipt and attached to all downstream events.
        *   SSE replay accepts `since_id` by `event_id` (with `log_id` compatibility shim) to keep reconnect behavior deterministic across channel splits.
        *   `/api/stream` must accept both W3C `Last-Event-ID` header and `since_id` query cursor (`Last-Event-ID` takes precedence when both are provided).
        *   frontend must use `EventSource` auto-reconnect with exponential backoff/jitter, persist last `event_id`, and send it via `Last-Event-ID` on reconnect.
    *   Add paginated historical logs endpoint (`GET /api/tickets/:id/logs?cursor=&limit=`) for reconnect catch-up on long runs.
    *   Keep SSE focused on live deltas plus bounded replay from cursor/`since_id`; avoid full-history SSE replay for very large logs.
    *   Add stream replay contract: client subscribes with optional `since_id` (exclusive); server replays backlog by `event_id` cursor (with `log_id` legacy compatibility) before live streaming.
    *   Reconnect replay must be lossless within retention window: server replays all missed events before switching the client to live stream.
    *   Add SSE liveness contract:
        *   emit heartbeat events at fixed interval (default `10s`) with monotonic `stream_seq`;
        *   keep bounded replay buffer by time + size caps (plus optional hot in-memory ring buffer of latest `1000` events); when cursor is too old, emit `replay_gap` with earliest available `event_id`/`log_id`;
        *   on `replay_gap`, client first falls back to paginated logs API for deterministic backfill; if gap still cannot be replayed from retained logs, server emits `full_refresh` and client refetches ticket state/artifacts via REST before resuming live stream.
    *   Add optional SSE payload compression for large stream events (`gzip`/`br` from `Accept-Encoding`) with size threshold + CPU guard; heartbeats stay uncompressed.
    *   Add frontend live-log memory contract (ring buffer):
        *   keep only last `N` live log lines/events in browser memory (default `500`, configurable with hard cap),
        *   full history is read from paginated logs API / on-disk artifacts, not retained in React state,
        *   when older entries are dropped, emit `live_log_truncated` with `dropped_count` and oldest retained `event_id`.
    *   Add strict DOM virtualization contract for Active Workspace log panels:
        *   execution log + reasoning streams must use virtualization (`react-window`, `react-virtuoso`, or equivalent) with viewport-only rendering (target around `~100` mounted rows);
        *   never render full-history logs as raw DOM nodes; historical navigation must page through logs API/artifacts into the virtualized data source;
        *   maintain stable row keys and bounded in-memory row cache so 10+ hour sessions do not degrade tab responsiveness.
    *   Persist per-viewer stream cursor at `.looptroop/tickets/<ticket-id>/stream-cursors/<viewer-id>.json` for reconnect recovery.
    *   Add per-iteration run summary files at `.looptroop/tickets/<ticket-id>/runs/<run-id>/iter-<n>.md` with: start/end time, duration, active bead ID, git head before/after, commits created, changed files, dirty files, verification commands/results, final iteration status, and `session_refs` (`provider`, `session_id`, `thread_url_or_id`, `message_start_offset`, `message_end_offset`) so operators can reopen the exact AI conversation that produced the change.
    *   Add rolling run summary artifact `.looptroop/tickets/<ticket-id>/runs/<run-id>/progress-summary.md` (append-only, one entry per completed bead) to preserve the "big picture" for long unattended runs.
        *   Each entry must include at least: `bead_id`, short objective/result, files changed (compact list), verification commands + pass/fail outcome, open risks, and `next_recommended_bead`.
        *   Context pack builder injects only the latest bounded slice (for example last 3 entries) into execution prompts to reduce token bloat while preserving continuity.
        *   Recovery UI/CLI should surface the latest entry first so operators can resume with immediate situational awareness.
    *   Add branch-change archive contract:
        *   detect target execution branch changes (`previous_branch` != `current_branch`) before a new execution start/resume;
        *   archive prior run-scoped artifacts (`progress`, run summaries, loop snapshots, handoff artifacts) to `.looptroop/tickets/<ticket-id>/archive/<timestamp>-<previous_branch>/`;
        *   initialize a fresh progress ledger for the new branch while preserving immutable archive history;
        *   persist archive index entry in `.looptroop/tickets/<ticket-id>/archive/index.jsonl` with `archived_from_branch`, `archived_to_branch`, `reason`, `archived_at`.
    *   Add transcript parser layer to detect semantic runtime signals: `tool_start`, `tool_end`, `assistant_complete`, `plan_mode_prompt`, `error_detected`.
    *   Add `response_analyzer.v1` for semantic loop interpretation:
        *   classify loop outcome (`progressing`, `stalled`, `blocked`, `candidate_complete`) from normalized events + execution evidence;
        *   compute `completion_indicators` score from multiple independent signals (quality gates, artifact mutations, verification results, marker presence).
    *   Enforce two-stage error filtering before raising runtime/stagnation findings:
        *   Stage 1 (`structural filter`): suppress false positives from schema fields/metadata keys (for example strings containing `error` in non-error contexts).
        *   Stage 2 (`semantic filter`): confirm true failure context from command exits, repeated failure signatures, or explicit blocker statements.
    *   Use semantic events to improve timeline quality, status badges, and user-action prompts.
    *   Persist parser confidence/errors for auditability.
    *   Build timeline/status badges from normalized `runtime.event.v1` events, not ad-hoc string matching.
    *   Add deterministic marker ingestion with dual-source completion validation and explicit validation-result fields: valid machine completion marker + state-machine consistency (bead advanced and quality gates recorded as pass).
    *   Add graph-level completion truth gate before bead/ticket completion transitions:
        *   zero remaining beads with `status != done` in the active scope,
        *   zero unresolved dependency blockers in the active bead graph,
        *   zero required quality gates in `failed` state.
    *   Completion marker output is advisory evidence only; system-computed graph/state checks are the authoritative transition source of truth.
    *   Add dual-condition exit gate for autonomous loop stop decisions: stop only when BOTH are true:
        *   `completion_indicators` meets threshold;
        *   explicit `EXIT_SIGNAL=true` (or equivalent structured completion intent).
        *   Missing/invalid `EXIT_SIGNAL` defaults to `false` (continue loop).
    *   Add terminal stop-reason contract: persist machine-readable `stop_reason` on every stop path (`completed`, `user_interrupt`, `max_iterations`, `no_runnable_beads`, `error`).
    *   `idle`, `paused`, or `interrupted` states must never be interpreted as completion; completion transitions require graph-level completion truth gate pass + finalized verification evidence.
    *   Generate away-summary snapshots from parsed events: last success, current blocker, required user action, next planned step.
    *   Add contradiction detection: if output claims completion but also includes blocker phrases (`needs manual intervention`, `could not complete`, `blocked`), emit `completion_contradiction` and retry.
    *   Persist raw stream lines alongside parsed events for forensic replay; parser line failures must emit `parse_warning` and continue.
    *   Log files are append-only by default and must not be deleted automatically on startup.
    *   Add retention policy controls (`max_age_days`, `max_size_mb`, archive/prune mode) with explicit reports.
    *   Add operator log access contract (CLI/API/UI query) with filters by `iteration`, `bead_id`, `run_id`, `severity`, and time range.
    *   Add dual log display modes:
        *   `summary` - compact triage timeline for fast diagnosis.
        *   `detail` - full prompt/agent/tool output with artifact links.
    *   Add cleanup controls for operator-managed pruning: `dry_run`, `keep_last_n`, and retention by size/time policy.
    *   Add secret-redaction policy before log persistence/display/export (tokens, credentials, key-like values):
        *   use a dual model: typed secret wrappers for known sensitive fields plus runtime pattern scanning for unknown leaks;
        *   vendor and version the detection ruleset with deterministic update workflow and changelog;
        *   persist stable redaction markers (with rule IDs/categories) so operators can audit what was removed without exposing secret content;
        *   add regression tests for idempotence, false positives, and performance overhead.
    *   Add diagnostics export bundle for failed runs (logs + runtime state snapshot + preflight + conflict reports) and auto-generate an investigation template at `docs/investigations/<ticket-or-issue-id>.md` with sections: `symptoms`, `root_cause`, `affected_files`, `fix`, `prevention_checks`.
    *   On resume, remove orphan temp progress files older than configured threshold and emit explicit recovery actions when runtime state is corrupted.
*   **Human-in-the-Loop (HITL) Controls with async provider contract + deterministic resume:** Allow user intervention at any time with explicit actions: `continue`, `follow_up`, `save_and_exit`, `quit_without_save`, `pause`, `stop`, `cancel_loop`, `skip_bead`, `recreate_beads`, `cancel_ticket`, `abort_council_phase`.
    *   Expose a visible `Cancel` control in every ticket phase view (`planning`, `preflight`, `coding`, `final_test`, `blocked`) with consistent confirmation semantics.
    *   Add deterministic `pause_at_checkpoint` behavior (separate from immediate `stop`):
        *   user pause intent is persisted as a run flag (`pause_requested=true`) instead of hard-interrupting mid-command;
        *   executor evaluates the flag only at safe checkpoints (end of command, end of test batch, end of bead iteration) and then transitions to explicit `PAUSED`;
        *   persist pause receipt with `checkpoint_type`, `bead_id`, `iteration`, `git_head`, and `open_processes[]` so resume is exact and auditable.
    *   Add guarded hard-stop contract to prevent accidental run termination:
        *   first `stop` action arms `stop_pending=true` and starts a short confirmation window (default `3s`);
        *   only explicit `stop_confirm` within the active window executes a hard stop; otherwise pending stop auto-expires;
        *   on confirmed hard stop, terminate owned process trees deterministically, persist stop receipt (`checkpoint_type`, `bead_id`, `iteration`, `git_head`, `open_processes[]`, `cleanup_result`), then transition per policy.
    *   Add `feedback_provider` interface for non-blocking human review channels (`in_app`, `email_link`, `slack`, `webhook`).
    *   Persist pending feedback at `.looptroop/tickets/<ticket-id>/hitl/pending-feedback.json` with: `flow_id`, `run_id`, `method_name`, `prompt_message`, `method_output_ref`, `emit_options[]`, `default_outcome`, `requested_at`, `callback_info`.
    *   When waiting on external review, return deterministic runtime state `PENDING_FEEDBACK` (not unstructured error).
    *   Add deterministic resume APIs:
        *   `resume_with_feedback(flow_id, feedback_text)` (sync);
        *   `resume_with_feedback_async(flow_id, feedback_text)` (async).
    *   `cancel_loop` stops only the active bead loop (does not cancel the ticket), writes a mandatory cancellation summary (`iteration`, `last_blocker`, `last_failed_command`, `user_reason`), and preserves branch/worktree for safe resume.
    *   `cancel_ticket` must transition to `CANCELED` and run immediate deterministic ticket-owned git cleanup: remove `.looptroop/worktrees/<ticket-id>/` and delete the ticket branch created for that ticket; persist a cleanup receipt with per-step result and any `left_in_place` reason.
    *   Cancel cleanup must never delete user-owned files outside ticket-managed resources; any boundary violation hard-fails cleanup and emits audit evidence.
    *   Ticket-cancel cleanup must be idempotent: reruns cannot delete unrelated branches/worktrees and must report exact `deleted` vs `left_in_place` resources.
    *   `abort_council_phase` cancels the active council deliberation/voting phase server-side using per-member request IDs, discards all partial phase outputs, and rewinds ticket state to the pre-phase checkpoint.
    *   Abort propagation must reach all active model sessions within 5 seconds and emit lifecycle events: `council_abort_requested`, `council_member_canceled`, `council_phase_aborted`.
    *   If a member does not acknowledge cancel before timeout, mark it `abort_timeout`, detach its stream, and complete rollback without hanging the ticket.
    *   Persist abort receipt at `.looptroop/tickets/<ticket-id>/council/abort-<timestamp>.json` with canceled member count, per-member cancel lag, and rollback status.
    *   Add XState actor lifecycle contract for long-running model calls:
        *   use spawned child actors for council/execution provider streams so parent machine stays responsive to `pause`, `cancel_loop`, `abort_council_phase`, and timeout watchdogs,
        *   reserve `invoke` for short bounded tasks (for example: schema validation, artifact write),
        *   require every spawned actor to emit deterministic terminal event (`*_DONE` or `*_ERROR` or `*_CANCELED`) with request/run IDs for safe reconciliation.
    *   `follow_up` supports two deterministic message types applied only at safe checkpoints (never mid-command):
        *   `guidance_note` - short instruction for the next iteration.
        *   `plan_patch` - user-reviewed update to the current execution plan (approve/refine/cancel workflow before apply).
    *   Persist plan patches at `.looptroop/tickets/<ticket-id>/hitl/plan-patches.jsonl` with `patch_id`, `run_id`, `created_at`, `status`, `approved_at`, and `applied_iteration`.
    *   Resume contract must preserve `ticket_id`, `flow_id`, `run_id`, current iteration number, context summary, `preserve_context` (boolean), `start_iteration`, and pending `guidance_note`/`plan_patch` IDs.
    *   Add append-only execution session ledger for all interruption and recovery actions at `.looptroop/tickets/<ticket-id>/hitl/execution-session-ledger.jsonl`:
        *   required fields per event: `event_id`, `timestamp`, `action` (`pause_requested`, `paused`, `resume_requested`, `resumed`, `stop_requested`, `canceled`, `follow_up_applied`), `ticket_id`, `flow_id`, `run_id`, `iteration`, `checkpoint_type`, `actor`, `result`.
        *   every `resumed` event must include `resumed_from_event_id` and `resume_basis` (`checkpoint_receipt` or `state_rebuild`) for deterministic auditability.
        *   on startup/resume, runtime must reconstruct current interruption state from the ledger first; missing or inconsistent linkage is `resume_state_inconsistent` and blocks execution until resolved.
        *   keep ledger immutable after write (no in-place edits); corrections are appended as new `supersedes_event_id` entries.
    *   `save_and_exit` copies safe artifacts/code back and closes runtime; `quit_without_save` closes runtime without copying back changes.
    *   **Live Interaction:** Ability to pause execution to discuss specific completed bead, diffs, or future steps with the AI while the ticket is in progress.
    *   **Non-blocking Hint Queue:** While execution is running, user can submit short guidance notes that are queued and injected once at the start of the next iteration without pausing the run.
    *   **Keyboard Control Contract (execution + parallel views):**
        *   Add deterministic keyboard actions for run control: `pause_resume`, `stop`, `cancel_loop`, `skip_bead`, `open_logs`, `open_help`.
        *   Add parallel-specific shortcuts for workers/merge UX: workers toggle, merge view toggle, worker drill-down, and conflict action shortcuts (`accept`, `reject`, `abort` path by policy).
        *   Require always-available shortcut help (`?`) and command palette (`Ctrl+K`) during execution.
        *   State-changing keyboard actions must emit audit events (`action`, `ticket_id`, `run_id`, `actor`, `timestamp`, `result`).
        *   Block shortcut execution while text input is focused and require explicit confirmation for destructive actions (`stop`, `cancel_ticket`).
*   **Parallel execution (deterministic orchestration):** MVP remains sequential; parallel mode is introduced after reliability gates.
    *   Use wrapper architecture: `ParallelExecutor` orchestrates multiple worker `ExecutionEngine` instances while the sequential engine path remains unchanged.
    *   Parallel mode policy supports `auto`, `always`, `never` (CLI override > project config > default).
    *   `auto` enables parallel only when all hold: at least one parallel group has `>=2` runnable beads, total runnable beads `>=3`, and dependency-cycle ratio `<=50%`; otherwise fall back to sequential mode.
    *   Persist parallel-activation decision at `.looptroop/tickets/<ticket-id>/parallel/<run-id>/activation-report.yaml` with analyzed groups, cycle ratio, chosen mode, and chosen worker count.
    *   Use a worker worktree per parallel job, not nested worktrees. MVP job granularity is one runnable bead; later lane mode may let one worker execute a sequenced bead group only when dependency and overlap analysis proves the lane safe.
    *   Keep one ticket integration branch as the merge target. Each worker uses a unique worker branch (`looptroop/<ticket-id>/<run-id>/<job-id>` or equivalent), and LoopTroop must not force-checkout the same ticket/session branch into multiple worktrees.
    *   Create worker worktrees outside the project tree (sibling or configured external directory) to prevent agent CLI parent-repo misdetection; persist canonical absolute worktree paths in the run manifest.
    *   On worktree creation, sync local developer state from the ticket integration baseline/source workspace into the new worker worktree: copy untracked files + unstaged tracked modifications, while excluding `.git/`, other worktree roots, runtime logs, and dependency/build caches unless explicitly allowlisted.
    *   Add deterministic worktree-create conflict policy for `path_exists`, `branch_exists`, `worktree_locked`, `branch_checked_out_elsewhere`, and `dirty_source_workspace` with explicit outcomes (`reuse`, `rename`, `retry`, `fail_with_receipt`).
    *   Persist worktree-create receipts at `.looptroop/tickets/<ticket-id>/worktrees/create-<timestamp>.json` with requested path/branch, base ref, target integration branch, conflict kind, chosen resolution, and final result.
    *   Lock active worker worktrees with a reason while an agent owns them, enumerate them via porcelain-formatted `git worktree list`, and unlock/remove them through `git worktree remove` rather than raw filesystem deletion.
    *   Preserve symlinks/junctions during sync where supported, and persist `sync_stats` (`untracked_copied`, `modified_copied`, `skipped`, `errors`) in parallel run artifacts.
    *   **Worktree optimization track:** evaluate `git worktree add --detach` plus shared object/reference cache (`--reference`/alternates) to reduce spawn latency and disk I/O for parallel Ralph loops.
    *   Prefer copy-on-write semantics when the host filesystem supports it; fall back to standard worktree creation when unavailable.
    *   Reuse heavy dependencies across worker worktrees (`node_modules`, pnpm store, caches) via symlink/junction strategy with per-worktree writable overlays for changed artifacts only.
    *   Extend dependency-reuse policy to all ticket worktrees (not only parallel workers):
        *   enforce shared-store-first setup (`pnpm` preferred) and skip full reinstall when reusable dependencies are available;
        *   for non-pnpm projects, create deterministic symlink/junction from source workspace `node_modules` into `.looptroop/worktrees/<ticket-id>/` (or run-scoped worktree path) unless project policy opts out;
        *   persist dependency-link receipt (`mode`, `link_target`, `install_skipped`, `estimated_space_saved_mb`) so worktree startup regressions are measurable.
    *   Persist per-run worktree efficiency metrics (`create_ms`, `disk_mb`, `reuse_mode`) in parallel run artifacts for tuning and regression detection.
    *   Workers must never mutate tracker state directly; they emit lifecycle events only, and tracker writes are applied by the orchestrator/main process.
    *   LoopTroop bead artifacts and optional Beads CLI compatibility files are read-only inputs inside worker worktrees. Final bead status, notes, and discovered follow-up items are returned as structured worker events and applied centrally after merge so parallel workers cannot race on JSONL/SQLite tracker sync.
    *   Any worker-side tracker write attempt is rejected with `tracker_write_violation`, logged, and the worker is paused/fails deterministically by policy.
    *   Add run lock at `.looptroop/locks/parallel.lock`; stale-lock recovery must verify owner PID is dead before takeover and emit `stale_lock_recovered`.
    *   Add `repo_git_mutex` for operations that mutate shared repository metadata across linked worktrees.
        *   Serialize git-sensitive operations (`worktree add/remove/prune/repair`, branch creation/deletion, checkout of shared refs, fetch, commit, merge/cherry-pick, tag creation, tracker sync) through the mutex.
        *   On mutex wait timeout, preserve worker workspace, emit `git_mutex_timeout`, and route to manual recovery.
    *   Before merge queue starts, run deterministic pre-merge overlap analysis (`git diff --name-only`) for each worker branch and compute `overlap_score` against target branch and other worker branches.
    *   Merge ordering policy: process branches by lowest `overlap_score` first; tie-break by dependency depth, deterministic `job_id`, then lowest changed-file count.
    *   Use a session branch per parallel run (`looptroop-session/<run-id-short>`): merge worker branches into the session branch first, then land to target branch in one controlled step.
    *   Before starting merge queue, create session rollback tag `looptroop/session-start/<run-id>` so full parallel run can be reverted to pre-merge baseline.
    *   Before starting merge queue, stash local uncommitted user changes and restore them after merge phase; stash/restore failures must be logged as warnings and must not drop user changes.
    *   Before each worker merge, create backup tag `looptroop/pre-merge/<bead-id>/<timestamp>`; on merge failure, hard reset to backup tag and clean untracked files.
    *   If conflict resolution fails, abort merge and hard reset to pre-merge backup; re-queue that bead once in a sequential lane after current queue settles.
    *   If the one-time sequential re-queue fails again, route bead to `needs_manual_resolution` with preserved conflict artifacts; do not auto-discard either side.
    *   Snapshot + restore tracker state files around each merge so stale worker copies cannot overwrite completed statuses in source-of-truth artifacts.
    *   Worktree cleanup contract: if a worker worktree has uncommitted changes after merge/cleanup attempt, do not delete it; mark it as `left_in_place` and persist absolute path + reason in run manifest for manual recovery. Clean merged workers with `git worktree remove`, then prune stale metadata only after receipts are written.
    *   Persist a run manifest at `.looptroop/tickets/<ticket-id>/parallel/<run-id>/manifest.tsv` with `job_id`, `bead_id`, `flow_id`, `base_ref`, `target_branch`, `worker_branch`, `worktree`, `locked`, `overlap_score`, `status`, `log_path`, `merge_result`, `backup_tag`, `cleanup_state`, `cleanup_reason`.
    *   Unresolved conflicts remain preserved for manual review and are linked in the run manifest with conflict file list.
    *   Implementation impact: scheduler dispatch, OpenCode session ownership, execution logs, tracker writes, merge receipts, cleanup, and UI Worktree Manager must key parallel state by `run_id` + `job_id` + `worker_branch` rather than assuming one ticket worktree.
    *   Add UI Worktree Manager per ticket/project: list active/stale worktrees, open path, retry cleanup, prune stale, and resolve creation/merge conflicts with guided actions.
    *   Every UI worktree action must emit audit receipts at `.looptroop/tickets/<ticket-id>/worktrees/actions-<date>.jsonl`.
*   **Per-ticket override + Council Presets:** You can change the main implementer and council members per ticket to override the general configuration.
    *   Add named model presets (implementer + council + optional quorum/timeout overrides) with CRUD operations and per-ticket one-click apply.
    *   Include built-in starter presets (`budget`, `balanced`, `quality`) and allow full user customization.
    *   Add quick council sizing control (MVP: 2-4 members, later: up to 10) with deterministic auto-fill from preset or ranked available models.
    *   Add `im_feeling_lucky` action to pick a random valid council composition from configured models.
    *   Add optional `wildcard_seat` that reserves one council slot for randomized selection from a curated high-performing pool to reduce echo-chamber behavior.
    *   Persist preset registry at `.looptroop/config/presets.yaml`.
*   **PR Workflow (deterministic + failure-safe):** option to create a PR when creating a ticket.
    *   Create/push ticket branch only after execution + review gates pass.
    *   Exclude operational/generated files from commit by default (`PROMPT.md`, screenshots, temporary review artifacts), unless ticket explicitly allowlists them.
    *   If `git push` or GitHub auth fails, keep local branch/worktree intact and emit exact remediation steps; do not lose runtime state.
    *   If git operations fail mid-sequence (`add`, `commit`, `push`), persist a `git-recovery` receipt with staged files, unstaged files, HEAD SHA, and next-safe actions.
    *   Expose guided recovery actions for partial git failures: `retry_commit`, `retry_push`, `open_terminal`, `skip_push_once` (with audit receipt).
    *   Add deferred push queue for remote outages/auth flaps:
        *   persist pending push jobs with `ticket_id`, `branch`, `commit_range`, `next_retry_at`, and `retry_count`;
        *   continue execution with local commits while background retries run with bounded exponential backoff;
        *   if queue age/count exceeds threshold, route to `NEEDS_INPUT` with explicit recovery actions.
    *   Keep push failures non-blocking by default; accumulate and surface outstanding push failures prominently at the next `WAITING_*` or manual verification checkpoint.
    *   Persist PR metadata in ticket artifacts (`branch`, `commit_sha`, `pr_url`, `created_at`, `status`).
    *   Research stack PRs on GitHub.
*   **Different paths (explicit execution contracts):** At the beginning of a ticket, users can pick their plan:
    *   Add deterministic path recommendation before selection:
        *   choose `traditional/no-persona` mode when task is straightforward and single-focused, role handoffs are unnecessary, or user requests minimal setup.
        *   choose `persona/hats` mode when work naturally decomposes into distinct specialist phases or requires multi-role review.
    *   **Full AFK:** no human review until Manual QA Loop gate (unless blocking error).
    *   **Fast Plan:** short intake + AI-generated initial bead draft from plain-language request, then user reviews/edits selected beads before execution.
    *   **Near-Perfect:** full interview + PRD + Beads with editable artifacts and full council workflow.
*   **Parallel ticketing + optional multi-repo workspace sets (dependency-aware + landing queue):**
    *   Multiple tickets per project can run in parallel using isolated worktrees and explicit ticket dependency metadata.
    *   Add optional `workspace_set` support so one ticket can include multiple repositories when a feature spans repos (for example frontend + backend + shared SDK).
    *   Add `depends_on_tickets` / `unlocks_tickets` to ticket runtime metadata.
    *   Scheduler rule: a ticket is runnable only when all dependencies are `COMPLETED`.
    *   Auto-unlock rule: completion of a prerequisite ticket automatically moves dependents from blocked to runnable.
    *   Workspace creation for multi-repo tickets must be atomic: if any repo worktree creation fails, rollback all newly created worktrees and persist a failure report.
    *   Add per-repo path locks so concurrent runs cannot create/cleanup worktrees for the same repo path at the same time.
    *   Add deterministic landing queue for completed ticket branches/worktrees with idempotent land semantics, persisted as append-only events at `.looptroop/tickets/<ticket-id>/landing/landing-queue.jsonl`.
    *   Landing queue states: `queued -> merging -> merged | needs_review | discarded`; allow retry transition `needs_review -> merging`; terminal states (`merged`, `discarded`) are immutable.
    *   Add optional `bulk_land` operation for multiple completed tickets:
        *   precompute overlap map (`git diff --name-only`) across candidate tickets;
        *   classify as `independent`, `ordered_overlap`, or `manual_conflict`;
        *   auto-land `independent` and `ordered_overlap` tickets in deterministic order (dependency edges first, then oldest `queued_at`).
    *   Queue item contract: `ticket_id`, `workspace_set_id`, `repos`, `integration_branch`, `target_branch`, `head_sha`, `queued_at`, `retry_count`, `status`, `land_id`, `state_version`, `lock_owner`, `overlap_class`, `merge_pid`, `failure_reason`, `discard_reason`.
    *   Landing worker protocol (strict order): fetch latest refs -> idempotency check (`integration_branch` already ancestor of `target_branch`) -> acquire per-target land lock -> create temporary land worktree -> merge with `--no-ff` -> run targeted verification -> push -> cleanup.
    *   Generate merge commit summaries deterministically from landed-branch commit history (bounded subject length + ticket/run suffix) so merge history remains readable and consistent.
    *   Cleanup order must be crash-safe: mark land result first, then delete integration branch/worktree; reruns must skip already-landed merge work and continue cleanup only.
    *   If merge/test/push fails, preserve both sides and transition queue item to `needs_review` (and emit `needs_manual_resolution` at ticket level when applicable) with conflict artifacts and exact paths; never auto-discard either side.
*   **User Feedback + HITL Learning Loop:** After every refinement (when user is presented the winning draft of each council vote), user can still modify the file directly and can also provide chat feedback (e.g., "Add more details on error handling").
    *   Add optional `learn_from_feedback` mode:
        *   distill reusable lessons from `{draft_output + user_feedback}` into short rules;
        *   store rules with metadata: `source=hitl`, `phase`, `created_at`, `confidence`.
    *   Before the next refinement output is shown, run a pre-review pass that recalls top-k HITL lessons and applies them automatically.
    *   Safety behavior:
        *   if lesson extraction fails, continue normally (no block);
        *   if pre-review fails, show raw model output;
        *   log every auto-applied lesson in the diff report.
    *   Other losing ideas: user will hit a button and see rationale deltas from losing drafts (top accepted ideas integrated into winner + rejected ideas with reason), grouped by council member, and can select additional ideas to incorporate.
*   **Visual aid in dashboard:** Opening a ticket in the dashboard should give links to other parts that are related. Clicking a bead will tell what part of the PRD it is related to, and clicking a part of the PRD will show which beads are related to it. This will help users understand the connection between the PRD and the execution plan.
*   **Per-agent `soul.md` personality contracts:**
    *   Each council member and main implementer gets a permanent `soul.md` defining role, tone, and strengths.
    *   Inject the assigned soul content as the first system instruction in every OpenCode call (council drafting, voting, interview/planning artifacts, and bead execution).
    *   Store souls in `.looptroop/agents/` and keep them git-backed like other project artifacts.
    *   Add a profile-settings editor (simple text area) per selected model, with defaults for common models.
    *   Integrate with existing `persona/hats` mode and per-ticket model overrides by resolving souls from the effective model assignment for that run.
    *   Add functional council roles (separate from personality): `drafter`, `critic`, `voter`, `synthesizer`.
    *   Role assignment is phase-driven: draft generation -> `drafter`, adversarial critique -> `critic`, voting -> `voter`, refinement -> `synthesizer`.
    *   Store default role templates at `.looptroop/templates/roles/<role>.md` and allow per-project overrides.
    *   Prompt injection order: `soul.md` -> council deliberation protocol -> role template -> phase task prompt.

















*   **Stuck-bead recovery (model-escalation retry + AI bead re-analysis):** When a ticket fails a coding bead after consuming all of its per-bead retry attempts (so it is blocked and waiting on the user), offer two new recovery actions alongside the existing Retry / Retry with extra note / Cancel — one for escalating the model, one for diagnosing and correcting the bead itself.
    * Scope both actions to coding-phase blocked errors only; they must not appear for other blocked phases (e.g. execution-env setup, final test, PR creation).
    * **Retry with another model:** Add a new recovery action that re-runs the stuck bead using a different model chosen by the user from the connected models, without changing the model locked for the rest of the ticket.
        * The alternate model is used for the entire next bead run (every attempt within that bead until it succeeds or exhausts its retry budget again), then the ticket automatically reverts to its original locked model for all subsequent beads.
        * The user picks the model fresh from a dropdown each time they use the action; there is no permanent fallback model and no automatic model switching.
        * The override is transient and never mutates the ticket's locked model configuration; once the bead completes, the override is gone.
        * Optionally allow a short free-text reason for the model switch, persisted for auditability.
        * The retry still resets the worktree to the stuck bead's start point, exactly like a normal retry, so the alternate model starts from a clean bead state.
        * AI turn metrics for the alternate-model run must be attributable to that model so users can see, after the fact, which model produced which attempts.
    * **Re-analyze stuck bead (one button that branches):** Add a single "Re-analyze" action that produces an AI diagnosis of why the bead keeps getting stuck, then lets the user choose what to do next — either correct the bead spec(s) or turn the diagnosis into a retry note.
        * The action gathers the approved PRD, the full list of beads, and all of the stuck bead's execution logs (the model's assistant outputs plus the error and system lines), prioritizing error and structured-retry-diagnostic entries and staying within the normal context budget so the diagnosis is not drowned in raw debug noise.
        * The model returns a structured diagnosis: the likely root cause, the signals that point to it, a hypothesis, recommended next actions, an optional suggested retry note, an optional suggested bead correction (with a recommended change level: slight, necessary, or major, and a recommended scope: just this bead or this and future beads), and a confidence level.
        * The diagnosis is persisted and surfaced in the blocked-error UI so the user can read it before deciding what to do; nothing is applied automatically.
        * **Branch A — Apply bead correction:** Let the user regenerate the stuck bead's spec from the diagnosis, pre-filled with the suggested correction but adjustable.
            * The user chooses scope (correct only the current stuck bead, or correct the current and all not-yet-started future beads) and change level (slight, necessary, or major), where the level controls how much of the bead spec may be rewritten — slight touches only context guidance and anti-patterns, necessary also rewords acceptance criteria and tests, and major may also rewrite the description and target files.
            * When scope includes future beads, only beads that have not started yet may be changed; already-completed or in-progress beads are never rewritten.
            * For every level, the app must show a diff of the proposed spec changes and require explicit user approval before writing anything; no correction is ever applied silently.
            * On approval, the corrected bead spec(s) are saved, the stuck bead's iteration counter is reset, its machine-generated failure notes are cleared, its user-authored retry notes are preserved, the worktree is reset to the stuck bead's start point, and the ticket resumes coding with the new spec(s).
            * If the OpenCode process dies mid-correction, the ticket must remain blocked and no partial changes may be written.
        * **Branch B — Use as retry note:** Let the user take the diagnosis's suggested retry note (or an edited version of it) straight into the existing "Retry with extra note" flow.
            * The retry-note dialog is pre-filled with the suggested note; the user can edit it before submitting.
            * Submitting uses the existing retry-with-note behavior: the note is appended to the bead's user retry notes, replayed into every future attempt for that bead, and the ticket resumes coding.
            * No new retry mechanism is introduced for this branch; it reuses the existing retry-with-note path.
        * The two branches are reached from the single Re-analyze button (diagnosis first, then choose a branch), so the user always gets the diagnosis before committing to either a correction or a note.
    * Both new actions coexist with the existing Retry, Retry with extra note, and Cancel actions; they are additional escalation options for the user, never automatic, and the user stays in control of which recovery path to take.
    * Keep these actions as a coherent escalation ladder for the user: Retry (same model, same spec) -> Retry with extra note (same model, same spec, more guidance) -> Retry with another model (different model, same spec) -> Re-analyze (diagnose, then either correct the spec or feed the diagnosis back as a retry note).

## Medium Priority

*   **Check documentation:** MANUAL audit of all documentation or information shown to the user that can be considered docs (like details per status, etc).
*   **User background:** Users can write their background, and the interview will be tailored to their knowledge (e.g., carpenter, SRE, doctor), making the interview less or more technical. (It is implemented partially, but it is hidden right now.)
*   **Community playbooks/presets (typed overlay + visual workflow + safe merge contract):** add a new category, besides projects and tickets, called playbooks. It will contain reusable workflows organized in categories (security, marketing, i18n, documentation, refactoring, optimization) and usable across many project types.
    *   Add workflow-oriented preset taxonomy (Ralph-style) alongside domain categories:
        *   `Development Workflows`,
        *   `Bug Fixing & Debugging`,
        *   `Review & Quality`,
        *   `Documentation & Research`,
        *   `Operations`.
    *   Seed built-in examples (name + role flow + best-for):
        *   `feature` (Builder -> Reviewer) - general feature implementation.
        *   `code-assist` (Planner -> Builder -> Validator -> Committer) - structured TDD from spec/task.
        *   `spec-driven` (Spec Writer -> Spec Critic -> Implementer -> Verifier) - contract-first implementation.
        *   `refactor` (Refactorer -> Verifier) - technical debt cleanup.
        *   `bugfix` (Reproducer -> Fixer -> Verifier -> Committer) - reproducible bug fixes.
        *   `debug` (Investigator -> Tester -> Fixer -> Verifier) - unknown-root-cause debugging.
        *   `review` (Reviewer -> Analyzer) - structured quality review.
        *   `pr-review` (Correctness Reviewer -> Security Reviewer -> Architecture Reviewer -> Synthesizer) - multi-angle PR review.
        *   `gap-analysis` (Analyzer -> Verifier -> Reporter) - spec-vs-implementation audit with machine-readable match matrix (`matched` | `partial` | `missing`) including file references.
        *   `docs` (Writer -> Reviewer) - documentation lifecycle grounded in verified implementation facts (no speculative behavior).
        *   `research` (Researcher -> Synthesizer) - investigation without code mutation.
        *   Persist verification report artifacts for these flows as both `.md` and `.json`.
        *   `deploy` (Builder -> Deployer -> Verifier) - deployment/release workflow.
    *   Each playbook should be split into:
        *   `base_policy` (locked defaults),
        *   `user_inputs` (editable fields),
        *   `execution_overlay` (run-specific adjustments).
    *   Add optional `workflow_graph` asset (nodes, edges, trigger labels) stored as JSON for visual editing in UI.
    *   Add optional `persona_topology` block for event-driven specialist coordination:
        *   persona fields: `persona_id`, `name`, `description`, `triggers[]`, `publishes[]`, `default_publish`, `max_activations`.
        *   routing fields: `topic_match_mode`, `fallback_persona_id`, `ambiguous_route_policy`.
    *   Add required preset metadata:
        *   `pattern_type`: `pipeline` | `supervisor_worker` | `critic_actor`,
        *   `best_for`,
        *   `avoid_when`.
    *   Preset picker should rank presets by `pattern_type` + ticket scope and show `best_for`/`avoid_when` guidance before apply.
    *   Routing contract must be deterministic: each event resolves to exactly one persona or explicit fallback; ambiguous routing is a validation error.
    *   Support deterministic conversion both ways: `workflow_graph.json <-> playbook.yaml` with schema validation and diff report.
    *   Support deterministic conversion both ways for persona topology: `persona_topology.json <-> playbook.yaml` with schema validation and diff report.
    *   Apply playbooks through deterministic config merge: `project base config` + `playbook overlay` + `ticket overrides`, with explicit precedence plus per-key merge policy (`replace`, `append`, `block_inheritance`, `additive_int`).
    *   Persist `.looptroop/tickets/<ticket-id>/merged-config.yaml`, `.looptroop/tickets/<ticket-id>/merge-report.yaml`, and `.looptroop/tickets/<ticket-id>/workflow-graph.snapshot.json` with per-key `winning_layer`, `merge_policy`, `blocked_by`, and `effective_value`.
    *   Persist `.looptroop/tickets/<ticket-id>/persona-topology.snapshot.yaml` with resolved personas, routing rules, and validation outcome.
    *   Playbook apply must never silently overwrite safety-critical settings (`policy profile`, budget caps, lock settings, ownership guards).
    *   E.g., Optimize SEO on the project website: user edits only fields marked editable (site name, description, target pages, and constraints).
    *   E.g., Don't Know What to Build? — ideas preset — this launches Idea Mode, a brainstorming session to help users discover project ideas:
        *   Brainstorm with AI - Get creative suggestions
        *   See trending ideas - Based on 2025-2026 tech trends
        *   Based on my skills - Personalized to technologies you know
        *   Solve a problem - Help fix something that frustrates you
    *   It can be set as recursive: user chooses when/how many times to repeat (or sets a Unix cron job).
    *   Users can upload their versions from the interface with their GitHub user, or publish/update on `looptroop/playbooks` repository.
    *   Add local manifest overlay for private/in-progress playbooks:
        *   local manifest file: `~/.looptroop/local-playbooks/manifest.json` (optional; if missing, official catalog works normally),
        *   merge semantics by `id`: local matching `id` overrides official entry; local-only `id` values are appended,
        *   every resolved playbook includes `source: official | local` for UI badges and filtering,
        *   local playbook `path` supports absolute and `~/` forms and must import directly from local filesystem (no network call),
        *   enforce path-traversal guards for local imports; invalid local entries are skipped with warnings (non-fatal),
        *   add hot reload by watching manifest file with debounce and broadcasting `playbook_manifest_changed`.
    *   Keep research track for integration methods with external plugins/channels.
    *   **Deep Repository Analysis + Agent Readiness Audit (two-tier):** before ticket creation, run a structured scan and score 8 pillars.
        *   Tier A (fix-eligible): Style/Validation, Build System, Testing, Documentation, Dev Environment.
        *   Tier B (report-only governance): Observability, Security, Workflow/Process.
        *   Emit `.looptroop/tickets/<ticket-id>/readiness-report.md` and `.json` with per-pillar score, overall maturity level, blockers, and prioritized fixes.
        *   Support modes: `report_only` and `fix_selected`; never overwrite existing files without explicit user confirmation.
        *   Remediation templates can propose `.env.example`, pre-commit hooks, linter/formatter baseline, runtime version pin files, and command docs when missing.
    *   **Proactive Suggestions:** AI provides prioritized suggestions after the audit with rationale, expected impact, and confidence.
*   **Different board views:** Board, spreadsheet, list, gantt.
*   **PRD Export (human-friendly + deterministic template resolution):** Add an export action that transforms the approved PRD into a non-technical report format for sharing and review.
    *   Output is format-agnostic (one or more human-friendly formats), always generated from the same PRD source data.
    *   Add template resolution order: `ticket override` -> `project template` -> `global template` -> `built-in default`.
    *   Validate template before export (syntax + required placeholders). Invalid templates fall back to built-in default and emit warning diagnostics.
    *   Exports are read-only artifacts and must never become source-of-truth or mutate PRD execution status.
    *   Persist exports under `.looptroop/tickets/<ticket-id>/exports/` with `template_source`, `template_version`, `render_hash`, and `generated_at`.
    *   Optional integrations: Export PRD to workflow tools (e.g., Linear tickets, UML diagrams) for immediate action.
*   **Shareable Completion Summary + Image Generator:** When a ticket reaches `COMPLETED`, add a prominent Share action in the ticket detail view/dashboard that creates a polished summary card for celebrating the result.
    *   Generate the summary from approved ticket artifacts and execution evidence: ticket title/ID, completion date, final status, outcome summary, key impact, challenges handled, participants, planning artifact links, bead/commit counts, elapsed calendar time, and active execution time when tracked.
    *   Use the main implementer model for the narrative summary, with deterministic source references to interview, proposal/design/PRD, beads, execution logs, commits, diffs, and harvest output when available.
    *   Render a branded share image suitable for X/Twitter, LinkedIn, Discord, and similar channels; include LoopTroop branding, ticket ID, readable metric badges, and a subtle "Built with LoopTroop" note.
    *   Provide lightweight customization: toggle sections, add a caption/hashtag, choose a visual style (`minimal`, `celebratory`, `technical`), export PNG, and copy a Markdown/text version.
    *   Trigger generation lazily on first Share click or after the `COMPLETED` transition; persist the generated summary/image reference in ticket artifacts for reuse.
    *   Enforce privacy by default: include only public/share-approved fields, never auto-post, and require explicit user action before copying, downloading, or sharing externally.
*   **Structured Commit Evidence + Receipt Contract:**
    *   After each completed bead, enforce a deterministic commit template:
        *   `<ticket-id> <bead-id>: <short title>`
        *   `Why:` 1-2 lines describing the behavior change.
        *   `Caveats:` breaking changes, migration notes, known limitations (`None` if not applicable).
        *   `Verification:` exact commands executed and pass/fail summary.
    *   Persist one machine-readable commit receipt per completed bead at `.looptroop/tickets/<ticket-id>/runs/<run-id>/receipts/<bead-id>.yaml`.
    *   Receipt must include at least: `commit_sha`, changed files, verification commands, gate outcomes, and timestamp.
    *   State transition to bead `done` is blocked if receipt is missing or invalid.
*   **Voice Integration:** Implement Speech-to-Text for user input and Text-to-Speech for AI output (e.g., providing audio summaries).
*   **Expanded Backend Support (provider registry + layered config + capability matrix):** integrate additional CLIs/APIs through a shared provider interface (`resolve_command`, `build_args`, `build_env`, `execute`, `execute_streaming`, `resume_session`, `parse_tool_line`, `capabilities`) and normalize outputs into one runtime event schema (`assistant_text`, `tool_start`, `tool_result`, `status_marker`, `completion_marker`, `blocked_marker`, `decision_marker`, `final_result`, `error`, `abort_marker`) so workflow logic and UI stay provider-agnostic.
    *   **Research ACP (Agent Client Protocol):** Evaluate the Agent Client Protocol as a standardized integration layer for backend providers before committing to adapter implementations.
        *   Review the ACP specification and determine whether its transport, message, and capability contracts align with the LoopTroop provider interface (`resolve_command`, `execute_streaming`, `resume_session`, `parse_tool_line`, `capabilities`).
        *   Identify which ACP features (session management, streaming events, tool invocation, permission modes) map directly to existing LoopTroop runtime events and which require adaptation or extension.
        *   Assess whether ACP can replace or complement the per-provider adapter pattern, and document the trade-offs (standardization vs. flexibility, maturity, ecosystem support).
        *   Produce a short research brief at `.looptroop/research/acp-evaluation.md` with findings, compatibility gaps, and a recommendation (`adopt`, `partial-adopt`, or `defer`) before any ACP-specific implementation work begins.
    *   Add a provider registry manifest at `.looptroop/providers/registry.yaml` with deterministic fields: `provider_id`, `adapter`, `kind` (`local_cli` | `remote_api`), `auth_mode`, `required_capabilities`, `status` (`experimental` | `stable`).
    *   Persist provider capability matrix at `.looptroop/providers/capability-matrix.yaml` with per-provider fields: `streaming`, `resume_session`, `tool_event_parse`, `permission_modes`, `cost_telemetry`, `known_limits`.
    *   Enforce layered provider config precedence: `built-in defaults` -> `user config` -> `project config` -> `ticket override`; merge must be deterministic and schema-validated at every layer.
    *   Persist resolved runtime provider config snapshot at `.looptroop/tickets/<ticket-id>/provider-config.resolved.yaml` so resumes/retries use the same effective settings.
    *   Reject unknown provider keys and incompatible layer overrides with explicit `invalid_provider_config` diagnostics (no silent fallback).
    *   Add per-provider binary override environment variables (example: `LT_CODEX_BINARY`) plus OS-aware command resolution (`.cmd` fallback on Windows).
    *   Add provider prompt-transport contract for local CLIs:
        *   support `argv`, `stdin`, and `temp_file` modes;
        *   default to `stdin` or `temp_file` for multiline prompts on Windows to avoid argument parsing corruption;
        *   if `temp_file` mode is used, create unique per-run files and guarantee cleanup on success/failure.
    *   Add provider instruction-pack + runtime-hook control plane:
        *   Layered merge order: `global_base` -> `provider_base` -> `role` -> `provider+role` -> `ticket_override` (most specific wins).
        *   Keep provider parsing stages: `experimental.chat.messages.transform` -> `tool.execute.before` -> `tool.execute.after` -> `event`.
        *   Add operation-level lifecycle stages for LoopTroop orchestration: `ticket.before_start` -> `bead.before_run` -> `bead.after_run` -> `ticket.pre_finalize` -> `ticket.post_finalize`.
        *   Hook discovery order must be deterministic: per-repo (`.looptroop/hooks`) -> per-user (`~/.config/looptroop/hooks`) -> built-in/plugin hooks; execute hooks in lexicographic filename order in each location.
        *   Hook I/O contract: payload via `stdin` JSON; hook result via `stdout` JSON only; operational logs via `stderr`. Invalid/non-JSON stdout is a failed hook execution.
        *   Define required hook environment payload keys: `ticket_id`, `flow_id`, `run_id`, `project_root`, `workspace_path`, `phase`, `stage`, `timestamp`.
        *   Enforce per-hook timeout budget (default 30s) with deterministic timeout result code `hook_timeout`.
        *   Add hook failure policy per hook (`fail_open`, `fail_closed`); default `fail_open` for non-safety hooks and `fail_closed` for safety hooks.
        *   Persist per-hook telemetry in `.looptroop/tickets/<ticket-id>/hooks/hook-execution.jsonl` with `hook_location`, `hook_name`, `stage`, `status`, `exit_code`, `duration_ms`, and `error`.
        *   Add safe hook creation/bootstrap: `hooks init` generates `.looptroop-hooks/AGENTS.md`, `.looptroop-hooks/README.md`, and executable examples; hook init failures are non-blocking and emit `hook_init_failed`.
        *   Persist resolved instruction snapshot per run at `.looptroop/tickets/<ticket-id>/instructions/resolved-pack.yaml` with `source_layers[]`, `resolved_hash`, and `generated_at`.
        *   Add deterministic tooling: `instructions sync`, `instructions diff`, `instructions init` to regenerate runtime settings and detect drift before execution.
        *   Add `Doctor` check `instructions-sync`; with `--fix`, regenerate out-of-sync runtime settings automatically.
        *   Require semantic parity tests so normalized outcomes (`done`, `blocked`, `needs_input`, `completion_marker`) remain equivalent across providers before promotion to `stable`.
    *   Add provider flag-mapping for permission modes (`allow_all`, `interactive`) so behavior is equivalent across providers.
    *   Require provider-specific tool-output parsers to emit normalized events with parser confidence; low-confidence parsing emits warning events (not hard failure).
    *   Keep session ownership binding to `{ticket_id, flow_id, run_id}` across providers to avoid stale/orphan events.
    *   Add provider/model readiness gating in configuration and ticket creation:
        *   run preflight checks per candidate model (`credentials_present`, `provider_reachable`, `model_available`, `quota_ok`) before allowing selection.
        *   models failing checks are shown as disabled with explicit failure reason and fix action.
        *   expose `Test Connection` action and persist latest readiness snapshot used for gating.
        *   allow optional debug toggle `show_unavailable_models` (default off) for advanced users.
    *   On provider selection per ticket, validate required capabilities against matrix and readiness snapshot before execution starts; missing requirements block start with deterministic remediation.
    *   **Multi-Channel Notifications:** Send status alerts (Finished/Blocked/Waiting user action) via Email, WhatsApp, Discord, Slack, SMS, Telegram, webhooks, etc. ([I1](https://x.com/i/status/2016439624927699190))
    *   Add outbound destination safety contract (especially for webhooks):
        *   allow `https://` by default; `http://` requires explicit opt-in policy;
        *   block localhost, loopback, private/link-local ranges, and cloud metadata endpoints;
        *   validate destination safety both at configuration time and immediately before send;
        *   persist blocked-send diagnostics with reason codes for audit and troubleshooting.
*   **Task Source Ingestion (adapter contract; multi-source normalized + deduplicated):**
    *   Keep manual import of tasks from GitHub Issues or PRs and add local adapters: `markdown_file`, `markdown_folder`, `yaml_file`, `json_file`.
    *   Define adapter interface: `test_connection`, `fetch_items`, `fetch_single`, `normalize_to_ticket_input`, `watch`, `push_status_update`.
    *   For `markdown_folder`, keep deterministic item identity as `<filename>:<line_number>` so completion writes back to the exact source line.
    *   GitHub auth fallback order: use authenticated `gh` CLI first; if unavailable, use configured token.
    *   Add `Preview` (read-only fetch view) and `Test` (auth/connectivity check) actions before first import.
    *   Normalize every imported item to one schema (`ticket_input.v1`) before ticket creation, with stable fields: `source_type`, `source_id`, `title`, `body`, `labels[]`, `priority_hint`, optional `parallel_group`, and `raw_ref`.
    *   Deduplicate imported items using deterministic fingerprint (`source + external_id + normalized_title + normalized_scope_hash`).
    *   Persist import receipts under `.looptroop/tickets/<ticket-id>/imports/`:
        *   `raw-source.json`
        *   `normalized.json`
        *   `import-receipt.yaml` (`source`, `fetched_at`, `dedupe_result`, `created_ticket_ids`)
    *   Add optional source-link mode per ticket: store `external_source`, `external_id`, `sync_mode` in ticket metadata (`metadata.ai_safe`) so AI prompts cannot mutate link identity.
    *   In `sync_mode=mirror_progress`, push deterministic updates back to the linked issue/PR on state transitions (`planning_done`, `bead_done`, `blocked`, `completed`) using checklist/body update or structured status comments.
    *   Outbound sync dedupe/throttle contract:
        *   skip outbound update when `payload_hash` is unchanged from last successful send;
        *   enforce `min_sync_interval_seconds` (default 30) per external item to avoid API spam/rate bursts;
        *   classify sync failures as `transient` vs `fatal_auth_or_scope` and never block local execution for transient failures.
    *   Persist outbound sync receipts at `.looptroop/tickets/<ticket-id>/imports/sync-log.jsonl` with `event`, `external_id`, `payload_hash`, `result`, `failure_class`, `timestamp`.
    *   **Repo Listener:** Link with a repository to monitor new Issues/PRs. ([I1](https://davidfowl.github.io/ralph-experiments/index.html))
        *   Listener mode should support webhook/polling with idempotent dedupe keys so the same item is never imported twice.
*   **Cost Management (step-accurate accounting):** Dashboard for current usage, forecasts, and token limits. Visual indicators will turn the ticket Yellow or Red as limits are approached or reached. Hard spending limits set per ticket.
    *   Aggregate usage from every model step/tool step (not only final responses) and persist totals per iteration, per bead, and per ticket.
    *   Track token classes separately: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`.
    *   Enforce dual hard budgets (`max_cost_usd`, `max_tokens_total`) with deterministic transitions (`warning` -> `NEEDS_INPUT` or `BLOCKED_ERROR`, based on policy).
    *   Add pre-execution estimator before `Approve Blueprint`: compute `estimated_cost_range_usd` + `estimated_runtime_range` from bead count, iteration caps, historical token medians, and configured model pricing; require explicit confirmation when estimate exceeds policy threshold.
    *   Present estimator as a pre-run `Flight Plan` card with: total bead count, runtime range, cost range, and git remote readiness (`configured`/`missing`) before final execution start.
    *   Add live burn-down telemetry panel during execution:
        *   show `spent_usd`, `remaining_usd`, token burn rate (`tokens/min`), elapsed wall-clock, and projected finish range from current slope;
        *   evaluate guardrails continuously and emit early checkpoint at configurable threshold (default 80% budget) with actions `continue_once`, `switch_model_tier`, `pause_at_checkpoint`, `stop`.
        *   in unattended mode, apply policy default at threshold and persist decision source (`user`, `policy`, `auto`) in runtime logs.
    *   Add request-rate limiter contract (provider/model aware, sliding-window):
        *   enforce two rolling windows: `max_calls_per_minute` (default 10) and `max_calls_per_hour` (default 100), configurable globally + per ticket override;
        *   use sliding-window counters (not fixed hour-boundary resets) so burst traffic cannot bypass limits at clock edges;
        *   add warning threshold (default 80% of either window) with deterministic warning state before hard blocking;
        *   when blocked, compute `next_available_at` from the oldest call in the saturated window and follow policy (`wait_for_slot`, `defer_noncritical`, or `NEEDS_INPUT`) while persisting reason/action in runtime logs;
        *   if policy requires user decision, present explicit options: `wait_for_slot`, `switch_model`, `exit_now`;
        *   if in AFK mode and no user response is possible, use configured default decision and log policy source (`user`, `policy`, `auto`).
    *   Persist rate-limit telemetry in ticket/runtime artifacts (`calls_last_minute`, `calls_last_hour`, `warning_state`, `blocked_state`, `next_available_at`, `throttled_events`) for UI + diagnostics.
    *   Add optional `economy_batch_mode` for latency-tolerant phases (for example: council drafting/voting, large analysis/review passes) by submitting asynchronous batched model requests and merging outputs back into artifacts with full trace metadata.
    *   Show batch lifecycle in UI/logs: `queued`, `in_progress`, `ended`, `failed`; batch failures should block only dependent phases, not unrelated tickets.
*   **MCP & Skills System (manifest-driven extensions + safe catalog):** Implement Model Context Protocol integration and a dedicated skills/extension system.
    *   Add LoopTroop MCP Server mode so external MCP clients (Cursor, VS Code, Windsurf, other MCP-compatible tools) can connect to a running instance for headless monitoring/control.
    *   Expose first-party MCP tools with ownership checks: `read_status`, `list_beads`, `get_current_logs`, `pause_execution`, `resume_execution`.
    *   Enforce per-tool auth scope (`read_only` vs `control`) and deny control operations when ownership/session guards fail.
    *   Support standard MCP transports (stdio and streamable HTTP) with explicit session lifecycle events in runtime logs.
    *   Define extension package contract (`extension.yml`) with required fields: schema version, extension metadata (`id`, `name`, `version`, `description`), compatibility range, provided commands, and optional hooks.
    *   Maintain installed-extension registry at `.looptroop/extensions/.registry.json` with `extension_id`, `version`, `source`, `installed_at`, `enabled`, and manifest hash.
    *   Enforce source safety for catalogs/downloads: HTTPS required by default (localhost HTTP only for local development), with warning when non-default catalogs are used.
    *   Add lifecycle commands/API: `extension list`, `add`, `remove`, `search`, `info`, `update`, `enable`, `disable`.
    *   Support layered extension configuration precedence: defaults -> project config -> local (gitignored) config -> environment variables.
    *   Support optional hook events with condition checks; disabled extensions must not run hooks or commands.
    *   Keep smart auto-selection to choose the best MCP tool/skill for the specific bead, but only from enabled and compatible extensions. ([I1](https://x.com/intellectronica/status/2013625824549969964), [I2](https://www.pulumi.com/blog/self-verifying-ai-agents-vercels-agent-browser-in-the-ralph-wiggum-loop/#when-to-use-each))
*   **Subagent Work:** Delegate work like planning, documentation, etc. to subagents so the main loop only receives the absolutely necessary context.
*   **System Info + About (GUI + CLI/API):**
    *   Add `info` command/API and GUI `About` panel with: app version, runtime, OS/arch, config paths/status, active agent/tracker/provider, and template status.
    *   Show app-level storage details in the `About` panel: app DB path, config dir, storage source, and the current number of attached projects.
    *   Add `Copy for bug report` action that emits redacted copyable output.
    *   Support `info` output formats: `human`, `json`, `copyable`.
    *   Link About panel to latest `Doctor` report, latest preflight report, and diagnostics export bundle.
*   **Localization:** Support for multiple interface languages.
*   **Smart Tagging/Labeling for each ticket:** The user will type one (e.g., backend, front-end, infrastructure, marketing, etc.)
    *   AI-suggested based on previous used ones or 3-5 new suggestions.
*   **Execution Ownership Guard (anti-stale sessions/events + receipts + process lock):**
    *   Generate unique `run_id` and `session_id` values when execution starts and persist both in ticket runtime state.
    *   Freeze `run_fingerprint` at execution start (hash of approved planning artifacts, bead graph, resolved config, and prompt contract versions).
    *   Recompute `run_fingerprint` at iteration boundaries; on mismatch emit `run_fingerprint_mismatch` and require explicit action (`accept_new_baseline` or `restore_expected_state`) before continuing.
    *   Maintain global session registry at `~/.config/looptroop/sessions.json` with `schema_version`, `session_id`, `ticket_id`, `flow_id`, `run_id`, `cwd`, `status`, `last_heartbeat`, `lock_owner`, `prompt_hash`, `worktree_path`, `repo_root`, and `last_event_cursor`.
    *   Add ticket-local runtime loop registry at `.looptroop/tickets/<ticket-id>/loops/loops.json` with `loop_id`, `pid`, `started_at`, `prompt_excerpt`, `worktree_path`, and `state` for operator visibility and deterministic reattach.
    *   Registry durability contract: serialize writes behind a lock file with stale-lock timeout recovery, and persist via atomic write (`tmp` -> `fsync` -> `rename`) to prevent partial/corrupt registry state.
    *   Registry file-permission contract: enforce owner-only permissions where OS supports it (for example `0700` config dir and `0600` registry file semantics).
    *   Bind all OpenCode sessions, runtime events, completion markers, and review receipts to `{ticket_id, flow_id, run_id, session_id}`.
    *   Add OS-level lock file per active run at `.looptroop/tickets/<ticket-id>/locks/<flow-id>.lock` with metadata: `run_id`, `session_id`, `pid`, `host`, `started_at`, `workspace_path`, and `prompt_hash`.
    *   Add per-project branch-switch serialization for ticket navigation:
        *   all checkout/switch actions go through a single project-scoped mutex queue;
        *   debounce rapid switch intents (default `250ms`) and keep only the latest pending target ticket;
        *   block ticket read/write operations while switch is in progress, then verify `HEAD` branch matches expected ticket branch before unfreezing.
    *   If lock exists and owner process is alive, reject second orchestrator attach for that ticket/flow with explicit remediation.
    *   If lock exists but owner process is dead/stale, recover lock automatically and emit `stale_execution_lock_recovered`.
    *   Support resume-by-ID from any directory using short session prefix with deterministic commands/paths: `resume`, `resume --list`, `resume --cleanup`.
    *   Resume is allowed only when ownership fields exactly match the active run/session; mismatched sessions are quarantined and ignored.
    *   Add explicit clean-session contract by phase:
        *   planning phases (`interview`, `prd`, `beads`) may use long-lived resumable sessions;
        *   execution (`CODING`) must use per-bead clean context via either `new_session_per_bead` or `same_session_with_explicit_context_reset` policy.
    *   Persist execution session contract fields in runtime state (`execution_session_mode`, `execution_session_id`, `execution_context_reset_receipt`, `session_bead_id`, `session_iteration`) and reject session reuse when bead/iteration ownership does not match.
    *   Add session-expiry policy (default: 24h): expired sessions require explicit user re-attach or fresh session creation with preserved run summary.
    *   Add session-expiry warning schedule (default warnings at `T-15m` and `T-5m`) with notification payload containing ticket/run IDs and recommended actions.
    *   Add activity-based lease refresh contract: only successful validated activity may extend `expires_at`; rejected/stale/orphan events must not refresh session lease.
    *   Expiry behavior split:
        *   active execution -> pause and move to `NEEDS_INPUT` for explicit re-attach/renew decision;
        *   inactive execution -> quarantine expired session metadata and allow clean resume/new-session path.
    *   Accept machine signals, completion markers, and review-based transitions only when ownership fields match the active run.
    *   If ownership mismatch is detected, quarantine that source, log `orphan_run_detected`, and block transitions from that source.
    *   Treat any cross-ticket contamination as a hard error: if an event, artifact, or write targets a different `ticket_id` than the active run, quarantine the offending source and set ticket state to `BLOCKED_ERROR` with remediation.
    *   Add receipt ownership validation: accept a receipt only when `{ticket_id, flow_id, run_id, session_id}` exactly matches the active run.
    *   If receipt ownership mismatch is detected, quarantine receipt source, emit `orphan_receipt_detected`, and force re-review on active run.
    *   If ownership cannot be established for active execution, set `BLOCKED_ERROR` with actionable remediation.
    *   Add machine-readable runtime status command/API (`status --json`) with stable fields: `status`, `iteration`, `tasks.total`, `tasks.completed`, `active_task`, `locked`, `last_updated`.
*   **Error Handling & Recovery:**
    *   **Graceful Shutdown + Resume Safety:**
        *   Handle `SIGINT`/`SIGTERM` with deterministic shutdown phases: `quiesce` (stop new work), `flush` (persist authoritative state + journal cursor), `close` (DB/file handles/providers), then exit.
        *   `flush` must explicitly drain all buffered writer queues before `close` (`flush_state_queue`, `flush_bead_projection_queue`, `flush_progress_queue`, `flush_sync_receipts`).
        *   If any flush step fails, persist `flush_failed` receipt (with impacted files/queues) and block autonomous resume until persistence health checks pass.
        *   Enforce shutdown timeout budget; on timeout, persist `shutdown_forced=true` receipt with the last safe checkpoint so restart recovery can branch correctly.
        *   Persist shutdown receipt at `.looptroop/tickets/<ticket-id>/runs/<run-id>/recovery/shutdown-<timestamp>.json` with `phase`, `active_bead`, `state_version`, `open_processes`, and `completed_steps`.
        *   On startup after unclean termination, mark run `interrupted_unclean_shutdown`, block autonomous resume until recovery checks pass, and surface one-click actions (`resume_safe`, `inspect`, `cancel_run`).
    *   **`BLOCKED_ERROR` Retry Re-entry Contract:**
        *   On transition into `BLOCKED_ERROR`, persist `blocked_origin_state`, `blocked_origin_reason`, and `blocked_bead_id` (if present).
        *   Persist structured blocker payload (`blocked_kind`, `recovery_action`, `retry_policy`, `context`) with stable enums (for example: `council_quorum_failed`, `bead_max_iterations`, `doctor_critical`, `provider_auth_failed`, `git_conflict`, `artifact_corruption`).
        *   `retry` must dispatch via `blocked_kind` + `recovery_action` mapping (not raw previous state) and reject retries when required preconditions remain unresolved.
        *   `retry` target state must be deterministic by reason class:
            *   environment/tooling/preflight failures -> `PRE_FLIGHT_CHECK`,
            *   coding/test gate failures -> `CODING` on the same bead with incremented iteration,
            *   approval/input contract failures -> corresponding `WAITING_*` state.
        *   If origin metadata is missing/inconsistent, fallback to `PRE_FLIGHT_CHECK` and require explicit user confirmation before resuming coding.
    *   **TDD Sub-State Contract (RED -> GREEN -> REFACTOR):**
        *   Each bead execution must persist deterministic sub-states: `RED_PHASE`, `GREEN_PHASE`, `REFACTOR_PHASE`.
        *   `RED_PHASE`: ensure bead-scoped tests exist and fail for the intended reason before implementation; persist `bead_red_commit` snapshot.
        *   `GREEN_PHASE`: implement until required bead-scoped tests pass; persist `bead_green_commit` snapshot when phase passes.
        *   `REFACTOR_PHASE`: improve code quality while preserving passing tests and quality gates; on regression, allow rollback to `bead_green_commit`.
        *   Completion marker is valid only after all three phases complete with recorded evidence.
        *   Persist phase transitions and evidence at `.looptroop/tickets/<ticket-id>/runs/<run-id>/tdd/<bead-id>.json` for resume/recovery parity.
    *   **Ticket-Level Circuit Breaker (execution-state contract):**
        *   Add explicit breaker states at ticket runtime level: `CLOSED` (normal), `HALF_OPEN` (constrained recovery attempt), `OPEN` (autonomous execution halted).
        *   Trigger candidates: repeated no-progress windows, repeated identical error signatures, repeated permission-denied loops, or contradiction between completion claims and failed quality gates.
        *   State transitions must be deterministic and logged with reason + evidence (`from_state`, `to_state`, `trigger`, `loop_window`, `error_hashes`).
        *   In `HALF_OPEN`, allow only one bounded recovery attempt (or policy-defined small number) before promoting back to `CLOSED` or escalating to `OPEN`.
        *   In `OPEN`, require either explicit user reset action or cooldown-elapsed auto-transition to `HALF_OPEN` (policy-controlled).
        *   Persist breaker state in ticket runtime state so restart/resume continues from the same breaker state.
        *   Route `OPEN` to `NEEDS_INPUT` for recoverable cases, or `BLOCKED_ERROR` when policy marks the trigger as hard-blocking.
        *   Breaker signals must consume analyzer outputs from two-stage filtered findings to reduce false-positive trips.
        *   Add multi-line error signature matching:
            *   canonicalize error blocks before comparison (strip timestamps, transient IDs/paths, whitespace variance);
            *   compute deterministic signature hashes from canonicalized multi-line blocks;
            *   use repeated signature windows as primary stuck-loop evidence for breaker/stagnation decisions.
    *   **Per-Bead Bearings Health Gate + Auto Bug Route:**
        *   Before claiming each runnable bead, execute a fast baseline health gate (`targeted tests + lint/typecheck + smoke check of a previously completed core flow`).
        *   If this health gate fails, do not start the current feature bead.
        *   Create a linked `bug` bead with failure evidence (`failing command`, `error output`, `suspected cause`, `timestamp`) and add dependency so the feature bead is blocked by that bug bead.
        *   Return the feature bead to `pending` and continue scheduling other runnable, unrelated beads.
        *   Block ticket only when no runnable beads remain and all open paths are blocked on unresolved bugs.
        *   Persist per-bead bearings reports in `.looptroop/tickets/<ticket-id>/runs/<run-id>/bearings/<bead-id>.yaml`.
    *   **Dynamic Bead Fission (Recursive Sub-Planning) + Continue Strategy (before HITL):**
        *   Allow the Ralph loop executor to reject the current `in_progress` bead as `too_complex` and trigger a local planning event before max retries are exhausted.
        *   Convert the current bead into a non-runnable `parent_split` bead and spawn 2-5 child beads with explicit dependency edges and parent-to-child acceptance-criteria trace mapping.
        *   Require each child bead to include scoped completion checks so recursive decomposition remains bounded and auditable.
        *   If a bead reaches max retries with repeated failure signatures and no prior split, run one automatic decomposition pass as fallback.
        *   If decomposition is not possible, mark bead as `blocked`, persist `block-<bead-id>.md`, and continue with other runnable beads.
        *   Move ticket to `BLOCKED_ERROR` only when no runnable beads remain (or blocked bead is marked critical).
    *   **Conditional HITL:** Automatically request user help (turn ticket Red) only after fallback models + auto-decomposition path is exhausted after configurable retries. ([I1](https://x.com/geoffreylitt/status/2008735715195318397))
    *   **Crash Recovery (design finalized):**
        *   Use `state.yaml` as the fast runtime projection per ticket, with atomic writes (`.tmp` + rename) and `.bak` backup.
        *   Persist authoritative state snapshot in SQLite on every XState transition; on restart, hydrate from SQLite first, then reconcile projection/journal.
        *   Authoritative XState transition persistence must be non-debounced (`SQLite` first); debounce applies only to projection/log fan-out writes.
        *   Add per-bead atomic state-commit sync on successful implementation:
            *   a bead can transition to `done` only when both operations succeed as one logical transaction: (1) git commit for bead changes, and (2) runtime state update (`issues.jsonl`/authoritative state + `state.yaml` projection) that records `commit_sha`.
            *   persist commit-state sync receipt at `.looptroop/tickets/<ticket-id>/runs/<run-id>/receipts/commit-state-sync-<bead-id>.json` with `bead_id`, `commit_sha`, `pre_state_version`, `post_state_version`, `synced_at`, and `result`.
            *   if commit succeeds but state update fails, classify `commit_state_desync`, keep bead non-done, and trigger deterministic recovery (`replay_state_from_commit_receipt` or rollback-to-last-synced state) before allowing resume.
        *   Persist `rehydrating_from_crash` in runtime context during startup recovery so state-entry logic can avoid replaying non-idempotent side effects.
        *   Add startup machine fidelity guard `assertStateMachineMatchesPlan()` that checks runtime transitions against the canonical workflow/state table; if mismatch is detected, block boot with `machine_plan_mismatch` diagnostics.
        *   Add strict snapshot compatibility contract for actor rehydration:
            *   persist compatibility metadata with each authoritative snapshot (`snapshot_schema_version`, `machine_schema_version`, `xstate_version`, `app_version`);
            *   before rehydration, validate snapshot metadata against current runtime versions and run deterministic migration function (`from_version` -> `to_version`) when required;
            *   if migration is missing or fails, quarantine the snapshot, mark ticket `BLOCKED_ERROR` with `snapshot_incompatible`, and offer read-only artifact export/recovery instead of crashing startup.
        *   Add startup reconnect order contract:
            *   recover ownership/lock + active OpenCode session first;
            *   only after ownership/session validation succeeds may runtime actors resume side effects;
            *   if validation fails, create replacement session and persist explicit `session_replaced_on_recovery` receipt before resume.
        *   On resume in `CODING`, read `.looptroop/tickets/<ticket-id>/opencode-sessions.yaml` for the active bead:
            *   if a valid session exists, reconnect/reattach instead of starting a new provider run;
            *   start a new session only when the previous one is missing/invalid and persist explicit replacement receipt.
        *   Publish authoritative ownership matrix to prevent split-brain:
            *   beads graph/notes/checkpoints -> `issues.jsonl`,
            *   workflow phase/state transitions -> SQLite snapshots,
            *   `state.yaml`/UI projections -> derived cache only.
        *   Cross-store transitions must commit authoritative writes first; if any authoritative write fails, do not advance state and emit deterministic `state_persist_failed`.
        *   Add artifact transaction broker for planning/runtime artifact files (`interview.yaml`, `proposal.yaml`, `design.yaml`, `prd.yaml`, `state.yaml`):
            *   enforce single-writer queue with optimistic `artifact_version` checks so TipTap/user edits and AI writes cannot silently overwrite each other;
            *   write path must be transactional (`artifact_tx_begin` -> atomic write via `.tmp` + fsync + rename -> `artifact_tx_commit`/`artifact_tx_abort`) with tx receipts appended to run journal;
            *   on version mismatch, keep both versions by writing conflict copy (`*.conflict-<timestamp>.yaml`), emit `artifact_conflict_detected`, and route ticket to `NEEDS_INPUT` with merge choices.
        *   Enable SQLite durability/concurrency pragmas on startup (`journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout` policy, configured `wal_autocheckpoint`) and report effective values in `Doctor`.
        *   Add SQLite write-hardening contract: wrap multi-write transition updates in explicit transactions, route writes through a single serialized write queue, and run periodic checkpointing so long sessions do not grow WAL unbounded.
        *   Add required SQLite indexes for high-frequency runtime queries:
            *   `idx_tickets_project_status (project_id, status)`,
            *   `idx_tickets_status_updated_at (status, updated_at)`,
            *   `idx_state_snapshots_ticket_saved_at (ticket_id, saved_at DESC)`.
        *   Add snapshot retention/compaction policy for authoritative state tables:
            *   keep all recent snapshots (default 24h), then compact older snapshots by interval while preserving latest per ticket;
            *   run idle-window maintenance (`incremental_vacuum`/`VACUUM` by policy) and persist DB size trend diagnostics.
        *   Maintain monotonic `state_version` in authoritative SQLite state; projection/journal writes must carry the same `state_version` or be rejected as stale.
        *   Treat append-only run journal as canonical replay history for execution recovery (`.looptroop/tickets/<ticket-id>/runs/<run-id>/journal/`).
        *   Define deterministic restart precedence:
            1. SQLite snapshot is canonical for workflow phase/state transitions.
            2. Run journal is canonical for execution event timeline and retry evidence.
            3. `state.yaml` is a rebuildable projection/cache and must be regenerated on conflict.
            4. Provider session history is supplemental context only; it cannot advance local state without matching receipts.
        *   Persist reconciliation report at `.looptroop/tickets/<ticket-id>/runs/<run-id>/recovery/reconcile-<timestamp>.json` with mismatch classes and chosen winner per field.
        *   On startup/hydration, if ticket recovers from a non-terminal execution state, append structured recovery event to run journal/execution log: `{"type":"SYSTEM_RECOVERED_FROM_CRASH","timestamp":"<ISO-8601>","preCrashStatus":"<status>","beadId":"<id-or-empty>","iterationBeforeCrash":<n>}`.
        *   Add drift sentinel between authoritative state and workspace reality:
            *   on each iteration boundary and startup, compare SQLite authoritative state, ticket projection files, and git workspace snapshot (`HEAD`, dirty set, and target-file hashes);
            *   classify drift as `projection_drift`, `workspace_drift`, or `artifact_drift` with explicit reason codes;
            *   auto-rebuild projections for `projection_drift`; for `workspace_drift` and `artifact_drift`, pause execution and require explicit user decision with a dry-run diff preview.
        *   Debounced writes (default 500ms) during high-churn execution; immediate writes on state transitions.
        *   Scope debounce to projection/log fan-out writes; do not debounce authoritative SQLite transition persistence.
        *   Add persistence circuit-breaker: after 3 consecutive save failures, stop execution and mark `BLOCKED_ERROR`.
        *   Add crash-simulation coverage: kill process at critical points (`state.yaml.tmp` before rename, mid-journal append, between transition commit and projection fan-out) and verify deterministic recovery.
        *   Persist per-bead heartbeat fields (`last_activity_at`, `attempt_started_at`, `stale_recoveries`).
        *   On app restart, recover from journal + projection and resume from last safe checkpoint. If projection is corrupted, auto-restore from `.bak` or rebuild from journal and notify user with `rebuild_reason`.
        *   Add explicit repair CLI:
            *   `looptroop run:rebuild-state <ticket-id> <run-id>` rebuilds projection from journal.
            *   `looptroop run:repair-journal <ticket-id> <run-id> --dry-run` reports duplicate/orphan events without mutation.
            *   apply mode writes repaired events to `journal.repaired.<timestamp>/`, moves original journal to `journal.bak.<timestamp>/`, then swaps atomically.
        *   Reconcile ticket-local recovered state with global session registry; stale/missing registry entries are flagged for `resume --cleanup`.
        *   If an active bead is `in_progress` but heartbeat exceeds `stale_seconds`, auto-reopen it to `pending`, log `stale_bead_reopened`, and continue scheduler flow.
        *   If stale reopen count for the same bead exceeds threshold, escalate to `BLOCKED_ERROR` with clear remediation.
        *   Future optimization: if write volume becomes a bottleneck, split into `state.yaml` (transitions only) + `state-inner.yaml` (high-churn counters/timers). ([I1](https://x.com/mattpocockuk/status/2014676492538565085))
        *   **Startup Recovery Console:** on app restart, list interrupted tickets with actions `Resume`, `Cancel`, `Open details` (plus bulk actions: `Resume all safe`, `Cancel all`).
*   **Stale `in_progress` Bead Recovery (explicit scheduler contract):**
    *   A bead in `in_progress` is considered stale when no heartbeat/activity update is received for `stale_seconds`.
    *   On resume/startup, stale beads auto-transition to `pending` so the scheduler can pick them again.
    *   Every stale reopen increments `stale_recoveries` and logs `stale_bead_reopened` for auditability.
    *   If stale reopen count exceeds threshold for the same bead, stop automatic recovery and transition to `BLOCKED_ERROR` with remediation guidance.
*   **Due Dates:** Support for setting deadlines on tickets.
*   **Iterative Learning:** Option to re-run specific phases (Interview, PRD, Implementation) with different mode as implementer, adding previous failures to the context to prevent repeating mistakes. It will create a new ticket automatically, fork of the existing one until then.
*   **Context Calculator + Context Manager Defaults + Artifact Reading Index + Runtime Drift Monitor:**
    *   Before execution starts, estimate token usage (`repo map + selected files + prompt contract + tool/system overhead`) per configured model and show headroom percentage against model limits.
    *   Add deterministic context-manager defaults per run:
        *   `max_context_tokens` per model with reserved output buffer `30%`.
        *   `summarize_threshold_pct=70` and `warning_threshold_pct=90`.
        *   `recent_iterations_to_keep=2` (older iterations summarized).
        *   `max_file_chars=30000`; larger files must be chunked with explicit line ranges.
    *   Add context-aware tool wrappers (`read_file`, `write_file`, `edit_file`) that automatically track touched files and append change-log entries (`decision`, `action`, `error`, `observation`) for next-iteration context injection.
    *   Generate `.looptroop/tickets/<ticket-id>/artifact-read-index.md` that classifies planning artifacts by priority (`critical`, `high`, `medium`, `low`) with file size and one-line summary.
    *   Execution must read `critical` artifacts first and avoid loading large `low` artifacts unless explicitly required by the active bead.
    *   During execution, record actual token usage per bead iteration and compute `drift_pct` versus preflight estimate.
    *   If drift exceeds threshold (default: 25% for 3 consecutive iterations), emit `context_drift_warning` and require a context-reduction action before continuing.
    *   Persist telemetry to `.looptroop/tickets/<ticket-id>/context-metrics.jsonl` with `phase`, `bead_id`, `estimated_tokens`, `actual_tokens`, `drift_pct`, and `model_id`.
    *   Add export profiles for evaluation datasets: `raw_jsonl`, `deepeval_json`, `openai_evals_jsonl`.
    *   Add telemetry privacy tiers:
        *   `anonymous` (default): store metrics and tool parameter keys only (no prompt text, no raw tool arguments, no file contents);
        *   `full` (explicit opt-in): allow prompts/responses, tool arguments, and touched-file paths for private debugging/evals.
    *   Every exported record must include `ticket_id`, `run_id`, `model_id`, `phase`, `success`, `duration_ms`, and `privacy_level` (`anonymous` | `full`).
    *   Telemetry/webhook export delivery must be best-effort, timeout-bounded, and non-blocking for ticket execution.
*   **Extra questions / Extend interview:** At the very end of the interview flow, after the `anything else to add?` form is submitted, provide an `extend interview` action to start another interview phase with a new batch of questions.
    *   The extended phase must run after all standard interview questions and terminal free-form input are completed.
    *   All council members must receive prior interview answers as explicit read-only context for the new phase via rolling summary + recent-answer window by default; full transcript remains in interview artifacts for final coverage checks.
    *   Persist phase linkage/ordering so each extension is traceable (`phase_index`, `parent_phase`, and cumulative context sources).
*   **LLM council optional:** Allow users to disable the council and rely solely on the main implementer for decision-making.
*   **Execution Mode Lock:** During coding phase, implementer can execute approved beads only; design-level changes require explicit approval transition. QA fixes cannot silently expand scope or alter approved design without escalation.
*   **Deterministic Bead Sizing + Complexity Scoring + Dependency-Order Contract (+ scope sentence test):**
    *   Add required sizing classes for planning/approval:
        *   `S`: 1-2 target files, 1-3 acceptance criteria, no architecture change.
        *   `M` (target): 3-5 target files, 3-5 acceptance criteria, reuses existing patterns.
        *   `L`: 6+ target files, cross-cutting architecture change, or unclear scope -> must be split before execution.
    *   Add required post-coverage `Complexity Analysis Pass` before user approval:
        *   score each bead `complexity_score` from 1 to 10 using deterministic signals (estimated files touched, dependency depth, integration surface, logic density, and risk indicators);
        *   produce `decomposition_recommendation` and `suggested_model_tier` (`fast` 1-4, `standard` 5-7, `reasoning` 8-10).
    *   Mandatory fission threshold: beads scoring `>7` are auto-rejected for execution and must be split before approval; if splitting fails, route to `NEEDS_INPUT` with rationale.
    *   Surface complexity in approval and navigator views (color bands + warning icon for `>=8`) and persist analysis artifacts under `.looptroop/tickets/<ticket-id>/planning/complexity/`.
    *   Add `scope_sentence` rule: each bead must be describable in one sentence without using the word `and`; if not, split it.
    *   Add overlap-minimization rule: sibling beads should avoid editing same files; if overlap is required, explicit dependency edges are mandatory.
    *   Add dependency-order normalization before execution:
        *   default plan order: foundations (`schema/contracts/config`) -> backend/domain logic -> integration/adapters -> UI/presentation -> docs/polish;
        *   no bead may depend on a lower-priority bead;
        *   detect and reject priority inversions and missing edges; require split/reorder until graph is valid.
    *   Reject bead plans containing unresolved `L` beads, failing `scope_sentence` checks, dependency cycles, or priority inversions in execution preflight.
*   **App restore + migration assistant (versioned, backup-first + compatibility reader contract):** If app is re-installed or a project with existing `.looptroop` is selected, run deterministic migration checks before import.
    *   Persist migration plan at `.looptroop/migrations/migration-plan.yaml` with `from_version`, `to_version`, actions, and risk flags.
    *   Add compatibility read pipeline per managed artifact:
        *   parser order: `current_schema` -> `legacy_schema_set`;
        *   record detected `source_format` and `parser_version` for every artifact.
    *   On successful legacy read, normalize to current in-memory schema and write back only in current format (one-way migration, no mixed live formats).
    *   Add `migrate --dry-run` report with per-file decisions: `read_ok`, `legacy_read_ok`, `unreadable`, `will_migrate`, `blocked`.
    *   Unreadable artifacts are quarantined at `.looptroop/migrations/quarantine/` with remediation notes; migration continues for other files.
    *   Before any write, classify files as `managed_safe_overwrite`, `managed_merge`, or `user_customized_never_overwrite`.
    *   Create automatic backup (`.looptroop-backup-<timestamp>/`) before any migration write.
    *   Apply migration in transactional phases with rollback on failure and explicit failure report.
    *   Persist `migration-impact-report.md` listing what was updated, what was preserved, and what requires manual merge.
    *   Keep a migration history log at `.looptroop/migrations/history.jsonl`.
    *   Add deterministic **Project Snapshot Export/Import** as part of restore flow (portable backup contract for app reinstall and machine migration).
    *   Snapshot export:
        *   Package project artifacts into `.looptroop/snapshots/<snapshot-id>.zip` plus manifest `.looptroop/snapshots/<snapshot-id>.manifest.yaml`.
        *   Manifest must include: `snapshot_id`, `app_version`, `schema_versions`, `created_at`, `project_id`, `ticket_ids`, `file_list`, and per-file SHA-256 checksums.
        *   Include `.looptroop/` state and non-sensitive ticket artifacts by default; exclude secrets/credentials and transient caches via deterministic allowlist + denylist rules.
    *   Snapshot import:
        *   Add import modes: `verify_only`, `restore_to_new_project`, `merge_safe`.
        *   Validate manifest schema + checksum integrity before any write; any mismatch is a hard block with actionable diagnostics.
        *   Run migration assistant on imported snapshot version before activation (`from_version` -> current).
        *   Preserve previous local state by creating pre-import backup and write an import receipt at `.looptroop/migrations/import-receipt-<timestamp>.yaml`.
    *   Conflict policy for `merge_safe` mode:
        *   Never overwrite runtime-owned active files silently.
        *   Emit per-file decisions (`applied`, `skipped`, `conflict`) with reason and required user action.
    *   Keep snapshot audit trail at `.looptroop/migrations/snapshot-history.jsonl` with export/import lifecycle events and outcomes.
*   **Planning artifact upload (validated import contract):** Allow users to upload planning inputs and skip interview/planning generation only after schema validation + minimum coverage checks pass; otherwise route to correction flow with actionable validation errors. When user uploads a PRD or specs document an option to start a short interview phase to validate and enrich the uploaded content is provided. This will start the normal interview phase (with fewer questions and uploaded document as extra context) and then move to PRD phase and then beads phase as normal.
    *   Accept upload modes:
        *   split mode: `proposal` + `design` inputs,
        *   legacy mode: monolithic `PRD` input (auto-normalized into Proposal + Options Synthesis + Design + derived composite PRD).
    *   Add import pipeline for common formats (`.md`, `.txt`, `.pdf`, `.docx`, `.json`) into normalized `proposal.v1`, `design.v1`, and derived `prd.v1` artifacts.
    *   Persist import artifacts: original source file hash/metadata, extracted intermediate representation, normalized Proposal/Options/Design/PRD outputs, and validation report.
    *   Add import confidence + unresolved-sections report; unresolved critical sections must block execution until user confirms fixes.
    *   Allow iterative correction loop (`edit -> re-validate -> approve`) without regenerating unrelated ticket artifacts.
*   **Progress-safe Regeneration on Manual Edits + Artifact Review/Traceability Contract:**
    *   **Artifact ownership boundaries (authoritative write contract):**
        *   User-editable artifacts (pre-execution): interview results, Proposal, Design, legacy/composite PRD, beads plan.
        *   System-owned artifacts (not user-editable in normal flow): runtime state files, execution logs, doctor/preflight reports, ownership/session lock records.
        *   Enforce API-level runtime control-file denylist: `state.yaml`, OpenCode session trackers, run/lock registries, and recovery receipts are read-only for user-facing write routes.
        *   Runtime control-file writes are allowed only through internal orchestrator paths and must emit audit receipts (`who`, `why`, `run_id`, `timestamp`).
        *   Agent write scope during execution is bounded to project code + active bead attempt metadata (`notes`, attempt-local diagnostics, status evidence fields).
        *   Enforce `write-existing-file-guard`: `write` may create new files only; edits to existing files must use `edit`/`patch` tools to reduce accidental full-file overwrite.
        *   Allow explicit exception paths only for LoopTroop-managed generated artifacts (for example `.looptroop/**` receipts) with audit logging.
        *   Any attempted write outside allowed ownership scope is rejected, logged, and surfaced with actionable remediation.
    *   **Structured artifact review loop (Interview/Proposal/Options/Design/Beads):**
        *   User edits are submitted as `review_notes` (not silent overwrite), with required metadata: `edited_by`, `edited_at`, `change_summary`.
        *   Approval screens for `WAITING_PRD_APPROVAL` and `WAITING_BEADS_APPROVAL` must include `Show Changes`:
            *   diff current candidate vs last approved artifact version with `added`, `modified`, `removed`, and stable anchors;
            *   when no approved baseline exists yet, compare against previous draft iteration and label baseline source explicitly.
        *   After any manual edit, run a bounded Clarification Repair pass before regeneration:
            *   ask at most 5 high-impact clarification questions, one question at a time;
            *   each question must be either multiple-choice (2-5 options) or short free-text answer (max 5 words);
            *   persist Q/A to `.looptroop/tickets/<ticket-id>/clarifications/session-<timestamp>.md`;
            *   persist apply report to `.looptroop/tickets/<ticket-id>/clarifications/apply-report-<timestamp>.md`.
        *   If blocking ambiguities remain after the Clarification Repair pass, move to `NEEDS_INPUT`.
        *   Every approved edit increments `artifact_iteration` and writes a version snapshot:
            *   `.looptroop/tickets/<ticket-id>/history/interview-results.v<artifact_iteration>.yaml`
            *   `.looptroop/tickets/<ticket-id>/history/proposal.v<artifact_iteration>.yaml`
            *   `.looptroop/tickets/<ticket-id>/history/design.v<artifact_iteration>.yaml`
            *   `.looptroop/tickets/<ticket-id>/history/prd.v<artifact_iteration>.yaml`
            *   `.looptroop/tickets/<ticket-id>/history/beads.<flow-id>.v<artifact_iteration>.jsonl`
        *   Re-run matrix is deterministic:
            *   Interview changed -> regenerate Proposal + Options Synthesis + Design + Beads
            *   Proposal changed -> regenerate Design + Beads
            *   Design changed -> regenerate Beads
            *   Legacy/composite PRD changed -> normalize into Proposal + Options Synthesis + Design, then regenerate Beads
            *   Beads changed -> rerun Beads coverage validation only
    *   **Artifact metadata + traceability contract:**
        *   `interview-results`, `interview-decision-log`, `proposal`, `design`, `prd`, and Beads outputs must include: `artifact_type`, `ticket_id`, `flow_id`, `artifact_version`, `artifact_iteration`, `source_hash`, `approved`.
        *   Maintain `.looptroop/tickets/<ticket-id>/traceability.yaml` with required links:
            *   `question_id -> decision_id -> proposal_requirement_id`
            *   `proposal_requirement_id -> design_decision_id`
            *   `design_decision_id -> bead_id`
            *   `bead_id -> verification_command`
        *   Add required Interview-to-PRD integrity sync pass before execution handoff:
            *   run one `planning_sync_pass` after PRD + Beads are approved and before transition to `PRE_FLIGHT_CHECK`.
            *   compare approved `interview-results` against approved `prd` and active Beads graph; detect omissions, contradictions, and out-of-scope complexity drift.
            *   persist report at `.looptroop/tickets/<ticket-id>/planning/sync-pass-<timestamp>.json` with finding severity (`critical|major|minor`), linked artifact IDs, and remediation suggestions.
            *   block execution start on any `critical` finding until artifacts are corrected or user explicitly waives with a signed decision receipt.
        *   Add per-criterion runtime status fields: `pass_state` (`not_started|in_progress|pass|fail`), `last_checked_at`, and `evidence_refs`.
        *   Execution start is blocked if any approved interview decision has no Proposal mapping, any in-scope Proposal acceptance criterion has no Design mapping, or any in-scope requirement has no bead + verification mapping.
        *   Ticket completion is blocked if any in-scope criterion is not `pass`.
    *   When Interview/Proposal/Options/Design/Beads/implementation conflict, run impact analysis and pause for explicit direction before mutating artifacts:
        *   `source_to_downstream` - update downstream artifacts/code to match source artifact.
        *   `downstream_to_source` - promote validated implementation reality back into source artifact.
        *   `manual_resolution` - user resolves directly, then validators re-run.
    *   Never auto-select sync direction when contradictions are present.
    *   Offer explicit modes after direction is chosen: `merge_status` (recommended), `restart_affected_phase`, `full_restart`.
    *   Before applying regeneration, generate `.looptroop/tickets/<ticket-id>/planning-diff-report.md` with `added`, `modified`, `removed`, and `renamed` sections.
    *   Add requirement-level diff contract:
        *   `modified` entries must include previous and new acceptance-criteria checksum;
        *   `renamed` entries must include old ID/title -> new ID/title mapping plus confidence score;
        *   contradictions (same item in multiple operations) are hard validation failures.
    *   If a previously completed item disappears from regenerated artifacts, mark it as `orphaned_completed` and require explicit user decision (`archive_work` or `rebind_work`) before continuing.
    *   If an item appears renumbered (same title + acceptance fingerprint, different ID), mark it as `candidate_rebind`; never auto-mark it completed without confirmation.
    *   Preserve progress only when ID and acceptance-criteria checksum are unchanged; if checksum changed, mark as `pending_revalidation` instead of fully discarding everything.
    *   After each completed bead (opt-in), run downstream sync to patch stale assumptions in `pending`/`blocked` beads without editing `done` beads.
    *   Downstream sync contract (deterministic):
        *   source must be a newly completed bead (`status=done` with valid evidence);
        *   target set is only `pending`/`blocked` beads in the same ticket + flow;
        *   sync may update description/acceptance/dependency metadata only; never modify `done` beads;
        *   each sync run writes `sync-report-<bead-id>.json` with changed fields and rationale;
        *   support `dry_run` mode to preview sync diffs before applying.
    *   Record regeneration/sync decisions in ticket-local logs with `chosen_direction`, `reason`, impacted IDs, and diff summary.
*   **Runtime Discovery Register (bounded scope-change handling):**
    *   During execution, when new information is discovered outside current PRD/Beads, classify impact:
        *   `small` -> log discovery and continue.
        *   `medium` -> create follow-up beads marked `pending_approval`.
        *   `large` -> pause ticket and move to `NEEDS_INPUT`.
    *   Persist discoveries in `.looptroop/tickets/<ticket-id>/discoveries.jsonl` with impact, rationale, and source evidence.
    *   Persist emergent runtime tasks in `.looptroop/tickets/<ticket-id>/runtime-tasks.jsonl` with: `runtime_task_id`, `source_discovery_id`, `linked_bead_id`, `status`, `priority`, `created_at`, `updated_at`, `evidence_refs`.
    *   Runtime task lifecycle: `open` -> `in_progress` -> `resolved` | `blocked` | `rejected`.
    *   Runtime tasks that are approved for scope inclusion must auto-convert into follow-up beads with explicit dependency edges and trace links.
    *   Runtime tasks that remain `blocked` must include deterministic blocker metadata (`blocker_type`, `blocker_reason`, `next_action`).
    *   Discovered work outside approved PRD scope requires explicit user approval before execution.
*   **Triple-Gate Preflight (Execution Readiness):**
    *   Before execution, require three gates:
        *   `Runtime Gate (Doctor)`: OpenCode connectivity, git safety, tool availability, artifact paths, config consistency, beads graph integrity, runtime safety budgets, and VCS baseline integrity.
            *   Expand Runtime Gate resource checks to include CPU saturation and memory headroom thresholds with deterministic reason codes (`cpu_saturation_high`, `memory_headroom_low`) and blocking policy for unattended mode.
            *   Add git identity check: require `user.name` + `user.email` (repo-local or global) with remediation commands when missing.
            *   Add repository validity check: selected project path must be a valid git repository and `HEAD` must resolve to at least one commit.
            *   Add required-tool inventory check: verify required binaries (`git`, provider CLI, runtime/toolchain, and configured test/lint/build commands) exist and are executable before start.
            *   Every Runtime Gate check must emit stable fields: `check_id`, `severity`, `status`, `detail`, `hint`.
            *   Add host keepalive contract for unattended runs:
                *   On transition into `CODING`, request an OS-level `prevent_sleep` token and persist acquisition status in runtime logs.
                *   While active, verify keepalive heartbeat/state periodically; if token acquisition fails or is lost, raise a `warning` with remediation and optionally escalate to blocking based on policy profile.
                *   Release the token deterministically when ticket transitions to `DONE` or `NEEDS_INPUT` (and on crash/restart recovery when no ticket is actively coding).
            *   Add unattended host resource checks in Runtime Gate:
                *   minimum free-disk thresholds for project volume and temp volume;
                *   startup write/delete probe for critical artifact/log directories;
                *   deterministic reason codes (`disk_headroom_low`, `artifact_path_unwritable`) and AFK start block when critical.
            *   Validate selected provider against `.looptroop/providers/capability-matrix.yaml`; required capabilities must be present for active ticket mode/policy.
            *   Validate `persona_topology` routing contract when enabled (no ambiguous routes, valid fallback persona, valid trigger/publish definitions).
            *   Add acceptance-criteria quality checks for runnable beads: every criterion must include clear `precondition`, `action`, and `expected_result` semantics (or structured equivalents) before execution can start.
            *   For UI-impacting beads, require explicit browser-verification contract before execution:
                *   `verification_mode = ui_browser_required`,
                *   step list (`page/route`, `interaction`, `expected visible result`),
                *   evidence requirements (`screenshot` and/or browser-run log artifact paths).
            *   Reject vague acceptance criteria or missing UI verification contract with deterministic remediation output (`what is missing` + `where to fix`).
            *   VCS baseline integrity checks:
                *   required ticket coordination artifacts are tracked in git;
                *   active flow has valid `bead_start_commit` snapshot metadata;
                *   execution ownership lock for `{ticket_id, flow_id}` is valid (including stale-lock recovery when lock owner process is dead).
        *   `Product Readiness Gate`: required external accounts, API keys/secrets presence, webhook/redirect setup, mandatory manual setup steps, declared paid-service dependencies.
        *   `Agent Readiness Gate`: runnable validation commands, environment template, baseline docs/instructions, and deterministic command entrypoints for autonomous runs.
    *   Add phase-triggered Doctor profiles (auto-run contract, not one-time only):
        *   `planning_quick` before `COUNCIL_DELIBERATING`: disk headroom + council model ping checks;
        *   `preflight_full` before `PRE_FLIGHT_CHECK`: full runtime/product/agent readiness;
        *   `bead_start_quick` before each bead start in `CODING`: project/temp disk headroom + main implementer model ping + git worktree/branch sanity + `.gitignore` temp-pattern hygiene.
    *   Add deterministic disk policy for all phase-triggered checks: hard minimum `>= 5 GB`, recommended `>= 15 GB`; if below hard minimum, block with `disk_headroom_low` and exact remediation text.
    *   Persist results in `.looptroop/tickets/<ticket-id>/preflight.yaml` and `.looptroop/tickets/<ticket-id>/preflight.json` with checks, status (`ready` / `not_ready`), timestamp, and blocking reasons.
    *   Policy:
        *   Critical failure in any gate -> `BLOCKED_ERROR`.
        *   Warnings require explicit user confirmation.
        *   Advisory connectivity checks (for example upstream/version checks) are non-blocking and logged as warnings.
        *   For unattended/full-AFK execution, all three gates must be `ready`.
        *   AFK mode cannot bypass blocking quality/backpressure findings from `backpressure-policy.v1`; blocking reason codes must be resolved first.
*   **Deterministic Orchestrator Test Harness (mock CLI + cassette replay + seeded runtime):**
    *   Add a fake provider CLI mode that replays recorded responses from cassette files to test orchestration logic without live model/API cost.
    *   Support two modes: `record` (capture real runs) and `replay` (deterministic playback).
    *   Persist cassettes under `.looptroop/test-cassettes/<scenario>.yaml` with prompt hashes, streamed events, and final outcomes.
    *   Add deterministic seed controls for tests: fixed clock, deterministic ULID/ID generator, and seeded run IDs so journal/event ordering is reproducible.
    *   Add disposable run harness utilities that create a full temporary run directory with initial `RUN_CREATED` event and automatic cleanup.
    *   Capture per-iteration execution logs in tests (`iteration`, `status`, `pending[]`, `executed[]`, `metadata`) to assert scheduler behavior and pause/resume correctness.
    *   Add snapshot helpers to capture journal + derived state after each scenario for stable fixture diffing.
    *   CI baseline should run core workflow suites in `replay` mode for stable pass/fail signals.
    *   Add backend conformance replay suite: run identical scenarios across providers from capability matrix and compare normalized runtime events + state transitions for parity.
    *   Mark providers as `experimental` in capability matrix when conformance parity repeatedly fails; block them from AFK mode by policy.
    *   Add explicit CI/CD GitHub Actions contract:
        *   required jobs: `lint`, `unit`, `integration_replay`, `fixtures_regression`;
        *   required status checks on pull requests before merge;
        *   upload deterministic test artifacts (cassette diffs, validation reports, failing fixture bundles, run snapshots, iteration logs) for triage.
    *   Add CI trigger matrix policy (default: PR + main branch push; optional nightly full replay suite).
    *   Keep strict command allowlist in mock mode so harness cannot execute arbitrary shell commands.
*   **Execution Dry-Run Mode (preview only):** Add an optional execution-phase dry-run that computes planned bead order/dependencies/risk/cost with zero file or git mutations, and always show a disclaimer that real execution will almost certainly drift due to non-deterministic LLM output and other factors.
*   **Ticket Completion Finalization Contract (landing receipt + finalize-safe commit + optional release tag):**
    *   Before marking a ticket `COMPLETED`, persist `.looptroop/tickets/<ticket-id>/landing/landing-receipt.json` with `ticket_id`, `run_id`, `flow_id`, `head_sha`, `dirty_before_finalize`, `auto_commit_sha`, `finalization_mode`, `open_blockers`, and `timestamp`.
    *   If tracked files are dirty at finalize time, create one deterministic safety commit (`looptroop: finalize <ticket-id>`) before squash/land so no tracked work is silently lost.
    *   Persist finalization audit event `ticket_finalized` with links to landing receipt, merge/land result, and cleanup report for post-run investigation.
    *   Optional release tag: if ticket metadata includes `target_version_tag`, create an annotated git tag after manual verification; if the tag already exists, skip creation and log a warning.
*   **Message Steering (deterministic queued control):** During execution, while an active bead is running, user steering messages are accepted in a chat-like panel and queued for deterministic application at safe checkpoints without pausing the run. Another steering direction can be for the rest of the project, not only for next bead or active bead.
    *   Persist steering queue at `.looptroop/tickets/<ticket-id>/steering/queue.jsonl` with `queue_id`, `run_id`, `bead_id`, `created_at`, `status`, `applied_at`, and `result`.
    *   Apply policy: if the agent is mid-iteration, apply on the next checkpoint (after current command/test cycle) unless message is marked `urgent_stop`.
    *   Queue guarantees: FIFO within priority class, max queue size, deterministic dedupe for identical pending messages, and explicit expiration policy.
    *   On reconnect/restart, restore pending steering messages and show applied vs skipped outcomes in the ticket dashboard.
    *   *Context wipe intervention:* while triggering context wipe, optionally open a countdown pause window (default OFF). Messages submitted in this window are stored as `user_steering_note` and attached to the next iteration context.
    *   Add explicit `BLOCKED_ERROR` steering UX: before retrying a blocked bead, show `Provide Steering` input and append accepted steering into bead notes (`source=steering`) for the next iteration.
*   **Ticket Chat & Action Assistant (unified conversational interface):** A single AI-powered chat surface that spans ticket logs, execution progress, and dashboard overview, powered by a separate fast/cheap model. Extends beyond read-only Q&A to support actionable write operations on ticket artifacts, project files, and workflow state.
    *   **Read-only Q&A (conversational analysis):**
        *   **Log-scoped chat (ticket view):** A lightweight chat widget in the ticket view's log panel that lets users ask natural-language questions about execution logs.
            *   **Button placement:** A small chat icon button in the `PhaseLogPanel` toolbar area, alongside the existing entries count, color legend, and copy-button group.
            *   **Chat panel:** Opens a slide-in drawer or expandable panel with a streaming message interface (markdown-rendered AI responses).
            *   **Log scope selector:** A dropdown in the chat panel header to choose between `Current tab` (active filter tab) or `All ticket logs` (full execution history across all phases).
            *   **Context construction:** Selected log entries are collected, formatted with metadata (timestamp, source, phase, bead, audience), and sent as system context along with the user's question to the chat model.
            *   **Example queries:**
                *   "What's happening right now in this phase?"
                *   "Why did bead 7 take so long?"
                *   "Why was model X the winner of the council vote? What was its score?"
                *   "Show me all the errors in this ticket."
                *   "Summarize what happened during the PRD drafting phase."
        *   **Execution-scoped chat:** During execution, the chat model answers questions about what has been done and what is still needed, so the user does not need to read all logs. Context includes active bead progress, recent commits, verification results, and open blockers.
        *   **Dashboard-scoped chat (cross-ticket):** The chat model answers questions about what tickets are doing, projects, statuses, etc., across the entire workspace, so the user does not need to read all logs. Context includes ticket summaries, statuses, recent activity, and project-level metrics.
    *   **Chat model:** Uses a separate configurable model (not the main implementer or council members), intended to be a fast/cheap model like GPT-4o-mini, Claude 3 Haiku, Gemini 2.0 Flash, or similar.
    *   **Backend:** A new lightweight SSE streaming endpoint `/api/chat` that accepts `{ ticketId?, logEntries[], userMessage, scope, actionContext? }`, constructs the prompt, and streams the chat model's response. The `scope` field selects the context source (`log_tab`, `all_ticket_logs`, `execution`, `dashboard`). When `actionContext` is present, the model may propose and execute write actions.
    *   **Ephemeral sessions:** Chat history is volatile — no persistence across page reloads or sessions. Keeps the feature lightweight and stateless. Action audit trails are persisted separately (see below).
    *   **Configuration:** A new **Chat & Analysis** section in the Configuration UI with a model picker for the chat model (and its effort/variant selector where applicable). Stored separately from job-critical model settings.
    *   **AI-Assisted Retry Note Generation:** When the user opens the "Retry with extra note..." dialog (on a live Blocked Error for implementation or workspace setup), an optional "Generate with AI" action lets the configured chat model draft the retry note.
        *   **Prompt input:** A small editable prompt field pre-filled with a sensible default (e.g., "This ticket/workspace keeps blocking. Can you add an extra note that will help an LLM model fix this issue?"). The user can rewrite the prompt before triggering generation.
        *   **Context assembly:** The chat model receives the user's prompt plus relevant ticket context: error diagnostics, ticket details, current bead info (for implementation blocks) or setup report (for workspace setup blocks), prior retry notes, and recent phase logs.
        *   **Output handling:** The generated text is inserted into the existing "Extra note" textarea for the user to review, edit, or discard. Nothing is submitted automatically — the user always confirms the final note before retrying.
        *   **Model:** Reuses the same configurable chat model defined in the "Chat model" bullet above; no separate model picker is needed.
        *   **Availability:** Shown only when the "Retry with extra note..." button is visible (live implementation or workspace setup blocks). Hidden for historical errors and blocks from other phases.
    *   **Actionable Chat (write capabilities):** The chat assistant is not limited to read-only Q&A. It can perform write operations on ticket artifacts, project files, and workflow state through natural-language commands.
        *   **Artifact approval/rejection:** Approve or reject planning artifacts (interview, PRD, beads, execution setup) via natural language (e.g., "Approve the PRD", "Reject the beads plan — the auth bead is missing rate limiting"). Rejection may include a reason that is persisted alongside the rejection receipt.
        *   **Artifact content editing:** Edit artifact content through chat (e.g., "Change the PRD scope to exclude the admin panel", "Add a bead for database migration before the API bead", "Update interview answer 3 to prefer PostgreSQL over MySQL"). Edits are applied to the canonical artifact and trigger the same downstream invalidation rules as manual UI edits.
        *   **Project file editing:** Edit project files related to the active ticket (source code, configs, docs) through chat (e.g., "Add a null check in the user service", "Update the vite config to alias @components"). File edits are scoped to the ticket's relevant files and planning context by default; editing files outside the ticket scope requires explicit user confirmation in the chat.
        *   **Workflow action triggering:** Trigger workflow actions via natural language (e.g., "Retry the failed bead", "Skip the coverage check", "Cancel this ticket", "Re-run the PRD drafting phase", "Retry all the failed ones"). Actions map to the same state-machine transitions and handlers as UI buttons.
        *   **Safety model — full auto-execute with undo/rollback:**
            *   Actions execute immediately upon model interpretation — no separate confirmation dialog.
            *   Every chat-initiated action is journaled in an append-only audit trail at `.looptroop/tickets/<ticket-id>/chat-action-audit.jsonl` with: `action_id`, `timestamp`, `action_type` (`approve`, `reject`, `edit_artifact`, `edit_file`, `workflow_action`), `target` (artifact path, file path, or transition), `before_state` (snapshot or hash of the affected state before the action), `after_state` (snapshot or hash after), `operator` (`chat_assistant`), `model_id`, `user_message` (the natural-language command that triggered the action), `result` (`success`, `failed`, `rolled_back`), and `rollback_of` (links to the original `action_id` when this entry is a rollback).
            *   Every action is individually reversible: the user can say "Undo that" or "Rollback the last action" and the system restores the `before_state` from the audit journal. Rollback itself is journaled as a new entry with `result: rolled_back` linking to the original.
            *   Multi-action rollback: "Undo the last N actions" replays rollbacks in reverse chronological order.
            *   Actions that trigger irreversible external side effects (e.g., git push, PR creation) are flagged as `irreversible: true` in the audit journal; rollback for these restores only the local LoopTroop state and emits a warning that the external side effect cannot be undone.
        *   **Scope guardrails:**
            *   Chat actions are scoped to the active ticket context by default. Cross-ticket actions (e.g., "Retry all failed tickets") require explicit ticket references or a dashboard-scope chat session.
            *   File edits are confined to the ticket's relevant files and planning context unless the user explicitly references a file outside that scope.
            *   Workflow actions must be valid transitions in the ticket state machine; invalid transitions are rejected with a deterministic reason code and suggested alternatives.
        *   **Action feedback:** After executing an action, the chat responds with a concise confirmation including what was changed, the affected artifact/file/transition, and a hint about how to undo if needed.
    *   **Key files (implementation scope):**
        *   `server/routes/chat.ts` — new SSE streaming endpoint with action dispatch
        *   `server/chat/actionExecutor.ts` — chat action interpreter and executor (maps natural-language intents to existing handlers)
        *   `server/chat/actionAudit.ts` — append-only audit journal and rollback engine
        *   `server/db/schema.ts`, `server/db/defaults.ts`, `shared/appConfig.ts` — chat model config fields
        *   `src/components/workspace/LogChatPanel.tsx` — new chat panel component
        *   `src/components/workspace/PhaseLogPanel.tsx` — add chat button in toolbar
        *   `src/components/dashboard/DashboardChatPanel.tsx` — dashboard-scoped chat surface
        *   `src/components/config/ProfileSetup.tsx` — add Chat & Analysis section
        *   `docs/configuration.md` — document the new settings
*   **Different implementer per bead/component:** Manually or automatically assign an implementer per bead or group of beads (e.g., all UI components should be done by Gemini 3 Pro).
*   **Ticket-Scoped Commands & Instructions (testing + workspace setup):** Allow users to attach executable commands and free-form instructions directly to a ticket at creation time, which are then consumed during execution by the appropriate workflow phases.
    *   **Testing commands/instructions:** Users can specify test commands or testing instructions in the ticket description at creation. These are persisted, validated, and injected into the execution loop so the implementing agent can use them when writing and running tests.
        *   Accept both shell commands (e.g., `npm run test:integration`, `pytest tests/api/`) and natural-language instructions (e.g., "Run all unit tests after each bead", "Always test edge cases for null inputs").
        *   Persist testing commands at `.looptroop/tickets/<ticket-id>/testing-commands.yaml` with fields: `id`, `kind` (`command` | `instruction`), `value`, `phase_scope` (`per_bead` | `per_ticket` | `on_demand`), `created_at`, `source` (`user` | `ai_suggested`).
        *   Validate command entries for shell-injection safety (deny `&&`, `||`, `;`, pipe unless explicitly escaped) and path confinement before persistence; invalid entries are rejected with deterministic reason codes.
        *   Inject approved testing commands into execution context at relevant checkpoints: bead-scoped commands before each bead's test gate, ticket-scoped commands before the final verification pass.
        *   If a testing command fails, capture structured failure diagnostics (`command`, `exit_code`, `stderr_summary`, `timestamp`) and route to ticket recovery flow (retry, skip with warning, or block depending on policy).
    *   **Workspace setup commands/instructions:** Users can specify workspace setup commands or instructions in the ticket description at creation. These are executed or followed during workspace initialization/approval before implementation begins.
        *   Accept both shell commands (e.g., `cp .env.example .env && npm install`, `docker compose up -d db`) and natural-language instructions (e.g., "Ensure the Redis container is running before starting", "Create a test database named `test_<ticket_id>`").
        *   Persist workspace setup commands at `.looptroop/tickets/<ticket-id>/workspace-setup.yaml` with fields: `id`, `kind` (`command` | `instruction`), `value`, `execution_order` (explicit sequence number), `created_at`, `source` (`user` | `ai_suggested`).
        *   Execute command-type entries deterministically during workspace setup phase (before first bead starts) with per-command timeout (default 60s) and structured output logging.
        *   Instruction-type entries are injected into the agent's planning context so the implementer follows them during workspace preparation and bead execution.
        *   Workspace setup must complete with explicit user approval before implementation proceeds; persist approval receipt with `approved_by`, `approved_at`, and `command_results` summary.
        *   If a workspace setup command fails, block ticket progression with deterministic diagnostics and offer remediation actions (`retry`, `edit_command`, `skip_with_warning`, `cancel_ticket`).
    *   Both testing and workspace setup entries are editable until the ticket enters active execution; after that, changes require explicit version bump and persist `pre_edit_snapshot` for audit trail.
    *   Expose a `Doctor` check that validates all ticket-scoped commands against the current environment (binary exists, path resolves, permissions sufficient) and reports mismatches before execution starts.















## Low Priority

*   **OSS Kanban Integration:** Containerized integration directly within an existing Open Source Kanban application.
*   **Idle Status Display:** Display tips and informative text (or educational, entertainment, or news content) during long, unattended loops. Can be math, quizzes, trivia, small games, etc.
*   **Analytics:** Dashboard for usage statistics and performance metrics, including execution trends over time, job volume, success rates, team activity, and current/pending jobs.
    *   Add `Director Notes` view: unified timeline across tickets/runs with filters (`AUTO`, `USER`, `ticket`, and `date range`) and one-click jump to source logs/artifacts.
    *   Add optional AI synopsis generation for selectable lookback windows (for example, 1-30 days) with sections for `accomplishments`, `open blockers`, and `next actions`.
    *   Persist synopsis artifacts at `.looptroop/project/director-notes/synopsis-<timestamp>.md` and `.looptroop/project/director-notes/synopsis-<timestamp>.json`.
*   **Laminar (`lmnr`) Value Capture for LoopTroop (trace-first adoption):** Integrate Laminar as an optional observability/evaluation layer focused on measurable execution quality gains, not just extra dashboards.
    *   **Value objective:** reduce failed retries, faster blocker diagnosis, and better model routing decisions using run-level evidence.
    *   Add provider-agnostic tracing adapter in backend (no direct coupling to workflow logic) with feature flag `observability.laminar.enabled`.
    *   Trace required boundaries: council phases, bead iteration start/end, test/lint runs, retry decisions, fallback-model switches, and `BLOCKED_ERROR` transitions.
    *   Standardize span metadata for joins across systems: `ticket_id`, `flow_id`, `bead_id`, `phase`, `iteration`, `model_id`, `provider`, `status`, `latency_ms`, `token_in`, `token_out`, `cost_estimate`.
    *   Persist local-to-remote correlation map at `.looptroop/tickets/<ticket-id>/observability/trace-map.jsonl` (`local_event_id` -> `laminar_trace_id`) so UI logs can deep-link to external traces.
    *   Add privacy contract before export:
        *   redaction profiles (`strict`, `balanced`, `off`) for prompts/artifacts;
        *   default `strict` for production projects;
        *   never export secrets or `.env` values; emit `observability_redaction_applied` receipt with field counts.
    *   Add baseline-first rollout:
        *   Phase 1: tracing only (no eval gates), measure coverage and ingestion reliability;
        *   Phase 2: derive top failure clusters (schema failures, test regressions, timeout loops);
        *   Phase 3: enable targeted eval datasets for high-failure paths and route findings into planning/routing heuristics.
    *   Add operator surfaces:
        *   ticket-level `Open Trace` actions from runtime events;
        *   project diagnostics panel with ingestion health (`events_sent`, `events_failed`, `retry_queue_depth`, `last_success_at`).
    *   Add failure policy:
        *   observability outages are always non-blocking for execution;
        *   persist failed export queue at `.looptroop/project/observability/export-queue.jsonl` with retry/backoff metadata.
    *   Add value scorecard artifact at `.looptroop/project/observability/value-scorecard-<period>.md` including: retry reduction, mean time-to-diagnose blockers, model-switch success lift, and cost impact.
    *   Exit criteria to keep/remove integration:
        *   keep if scorecard shows sustained improvement above configured threshold for 2 consecutive periods;
        *   otherwise auto-downgrade to tracing-only mode and flag for review.
*   **Execution View Toggle (Kanban <-> Timeline <-> Flow Map):** In ticket detail and project dashboard, allow switching between current Kanban status view, a time-based execution timeline, and a dependency-aware flow map.
    *   Keep Kanban simple by design: no extra board columns, no drag/drop behavior changes; timeline and flow map are read-only visualizations only.
    *   Build timeline rows from normalized `runtime.event.v1` events (phase transitions, retries, blockers, approvals, bead start/complete) to avoid ad-hoc parsing drift.
    *   Add timeline summary cards: total runtime, active coding time, waiting-on-user time, retry count, and critical-path bead chain.
    *   Support filtered layers: all events, blockers-only, user-actions-only, and bead lifecycle.
    *   Add execution log intelligence controls:
        *   filter scope: `global` (entire ticket run) and `local` (selected bead/log pane),
        *   filter mode: `include` (show only matches) and `exclude` (hide matches),
        *   match mode: `keyword` and `regex`,
        *   navigation shortcuts: `next_match`, `previous_match`, `clear_filter`,
        *   optional per-ticket presets persisted at `.looptroop/tickets/<ticket-id>/log-filters.yaml`.
    *   Add a flow map topology layer using ticket structure + execution dependencies (`Epic -> Story -> Bead` and `depends_on` edges) so users can see execution order and blockers at a glance.
    *   Make flow map nodes clickable to sync the detail panel (logs, status, linked PRD sections, and related artifacts) to the selected node.
    *   Persist per-user preference (`default_view = kanban | timeline | flow_map`) in profile settings; mobile defaults to compact timeline mode with optional flow map mini-view.
*   **Themes :** Change color scheme and font using preselected themes.
    *   Provide bundled preset themes plus custom theme JSON files.
    *   Define theme schema with validation for core groups: `background`, `foreground`, `status`, `task_state`, `accent`, `border`.
    *   Support partial overrides with deterministic fallback to the active base theme.
    *   Support runtime theme switching with per-user persistence.
    *   Enforce accessibility checks (minimum contrast threshold) and reject invalid theme values with actionable diagnostics.
*   **Codebase Indexing + Tool Profile Loading:** Index the codebase to reduce token usage by avoiding full context re-transmission for every request. [I1](https://github.com/parcadei/llm-tldr) [I2](https://www.tectontide.com/en/blog/context-corruption/)
    *   Add tool-loading profiles to control context footprint:
        *   `core` (minimum required runtime tools),
        *   `standard` (default tools for most tickets),
        *   `all` (full toolset),
        *   `custom` (explicit allowlist).
    *   Persist active profile per ticket/run and include it in runtime receipts and `Doctor` output.
    *   Load MCP tools/skills/extensions only from the active profile; unloaded tools must not appear in model-facing context.
    *   Add profile auto-downgrade policy when context/token budget is near limit, with explicit event log and user override.
    *   **TOON-style Context Compression + Council Payload Compaction:** apply compact formatting to system-generated payloads before model submission to reduce token cost without dropping decision-critical data.
    *   Compression coverage includes council/planning payloads, execution context scaffolding, and verifier/reviewer inputs (user-authored text remains unmodified).
    *   Compression modes: `off` (debug readability), `standard` (scaffolding-only), `aggressive` (full system payload compaction).
    *   Persist compaction receipts at `.looptroop/tickets/<ticket-id>/context/compaction/receipt-<phase>-<timestamp>.json` with `raw_tokens`, `packed_tokens`, `saved_percent`, `mode`, and `fallback_used`.
    *   If compaction fails validation, fallback to the standard context pack path, emit `context_compaction_fallback`, and keep execution non-blocking.
    *   **Context Externalization (RLM-inspired) for Large Runs:** keep large context and loop outputs in a queryable external workspace instead of re-sending everything every iteration.
        *   Persist per-iteration prompt snapshots, assistant last message, and raw logs in `.looptroop/tickets/<ticket-id>/context-trace/`.
        *   Maintain an index file (`index.tsv` or `index.jsonl`) with iteration number, phase, status, and artifact paths for fast lookup.
        *   Add bounded retrieval commands (`search`, `slice`, `summarize`) so agents load only necessary segments.
        *   Enforce hard size limits and eviction policy for traces to prevent unbounded disk growth.
    *   Add unified indexing of external context sources used by execution: selected documentation URLs, configured MCP tools, and installed skills.
    *   Add memory retrieval index for `agents.md`/harvested memory entries with deterministic ranking fields: `priority_class`, `relevance_score`, `freshness_score`, `approval_state`.
    *   Enforce memory retrieval token budget (separate from code context budget) and persist selected/skipped memory IDs with reasons per iteration.
    *   Persist index metadata in `.looptroop/index/index-state.json` with `last_indexed_at`, `source_hashes`, and `staleness_status`.
    *   Add index run modes: `full`, `changed-only`, `dry-run`, `force`.
    *   During Interview/PRD/Beads phases, fetch relevant indexed entries first; fall back to full scan only when index entries are missing or stale.
    *   Show index freshness/confidence in UI and `Doctor` diagnostics.
    *   Add reliability telemetry gates for index/stream changes:
        *   metrics: queue depth, enqueue-to-visible latency, finish latency, retry count, dropped chunk count
        *   SLOs: time-to-first-visible-token and successful-finish rate
        *   rollout policy: feature flag + canary comparison before full rollout
        *   emergency fallback toggle to revert from async/batched path to synchronous path when reliability drops
*   **Mobile apps + secure remote control:** Native mobile apps for Android and iOS.
    *   Keep two connection profiles: `cloud` (future hosted path) and `local` (`ip:port` to local instance).
    *   Local remote-control server should use randomized port plus high-entropy access token in URL; QR pairing must embed the full signed URL.
    *   Add offline mobile action queue (max 50 actions), persisted locally, automatically flushed on reconnect with per-item retry status.
    *   Add deterministic connection lifecycle states: `connecting`, `authenticating`, `online`, `offline`, `reconnecting`.
*   **Native installers:** Easy installers for Windows, macOS, and Linux, so it is easier for novices to just install the app instead of running commands to start it. A modern desktop app should be built, so users do not need to start the app with a command every time. The app should be able to auto-update easily.
    *   **Safe auto-update contract:** check/download only when idle, verify installer checksum (SHA-256), and apply update on next launch with explicit states (`checking`, `downloading`, `verifying`, `ready_to_apply`, `failed`).
    *   **Local customization preservation:** before update, compute a manifest of LoopTroop-managed files; if user-modified files are detected, back them up to `.looptroop/local-patches/` and write `patch-manifest.json`.
    *   **Patch reapply flow:** after update, provide deterministic `reapply_patches` with preview diff and per-file approve/reject actions.
    *   **Dedicated uninstall contract:** provide official uninstall script/flow per OS with `preview` mode and clear retention choices (`remove_binaries`, `remove_caches`, `keep_project_data`).
    *   **Uninstall safety report:** emit uninstall summary (`removed`, `skipped`, `failed`) and never delete user project folders unless explicitly confirmed.
*   **Educational Mode:** Optional summary at the very end of a ticket (when in completed status) explaining the tools used and architectural decisions.
    *   This will be an interactive discussion with an AI, based on the previous version of the app and the diff merged, tailored to the user background.
*   **Remote Backend (hosted provider contract; explicit backend behavior matrix):**
    *   Support connecting tickets to a hosted backend provider without requiring the local app process to stay active.
    *   Add connection profiles (`name`, `base_url`, `provider`, `workspace_id`, `default_model`) with one active profile per ticket.
    *   Add remote registry with alias metadata (`alias`, `host`, `port`, `auth_mode`, `last_connected`, `latency_ms`, `status`).
    *   Add auth lifecycle commands/API (`login`, `status`, `refresh`, `logout`) and store tokens in OS keychain when available; fallback storage must be encrypted-at-rest and permission-restricted.
    *   Add remote instance management commands/API: `add`, `list`, `remove`, `test`, `push_config` (`scope`, `preview`, `force`).
    *   Add remote orchestration control/events contract: `orchestrate:start`, `orchestrate:pause`, `orchestrate:resume`, `orchestrate:stop`, `orchestrate:get_state`.
    *   Add backend operation matrix with deterministic support states (`supported`, `read_only`, `unsupported`) per command family and backend type (`local_file`, `remote_api`).
    *   If an operation is `unsupported` for the active backend, return stable error code `backend_operation_unsupported` plus remediation and nearest supported alternative.
    *   Require remote context binding before task operations (`workspace_id`, `project_alias`, `ticket_scope`); reject ambiguous or missing bindings.
    *   Add deterministic remote health checks before run start (`auth`, `latency`, `quota`, `workspace_access`); failures must block start with actionable remediation.
    *   `push_config` must create remote backup before overwrite, validate schema before apply, and return deterministic diff summary.
    *   Persist resolved backend context snapshot at `.looptroop/tickets/<ticket-id>/remote/context.json` for crash-resume parity.
    *   Persist remote audit trail at `.looptroop/tickets/<ticket-id>/remote/audit.jsonl` with `request_id`, `endpoint`, `status_code`, `duration_ms`, `retry_count`, `timestamp`.
    *   Persist remote instance-management audit events with alias + action + outcome in the same audit trail.
    *   Define outage policy per ticket: `block`, `retry_with_backoff`, or `fallback_to_local` (fallback allowed only if explicitly enabled).
*   **Headless Loop Entry (CLI/API path + autopilot lifecycle):**
    *   Add a non-UI execution entry so tickets can be started/resumed/canceled via CLI/API.
    *   Reuse the exact same workflow engine and safety contracts as UI mode (same state machine, `Doctor` checks, ownership guard, and audit logs).
    *   Add lifecycle commands/API: `autopilot start`, `autopilot next`, `autopilot status`, `autopilot finalize`.
    *   Every headless command must return a normalized action envelope: `result_type` (`success | error | confirm | choice | input | progress | info`), `message`, optional `options[]`, optional `callback_id`, and `next_allowed_actions[]`.
    *   Add callback endpoints for interactive headless flows: `/api/callbacks/confirm/:callback_id`, `/api/callbacks/choice/:callback_id`, `/api/callbacks/input/:callback_id`.
    *   Persist `.looptroop/tickets/<ticket-id>/autopilot/autopilot-state.json` with `run_id`, `session_id`, `current_phase`, `last_step`, `last_result_type`, `pending_callback_id`, `next_allowed_actions[]`, `last_error`.
    *   `autopilot next` must execute exactly one deterministic step and persist state before returning, enabling safe resume after crashes.
    *   `autopilot finalize` must run final checks and publish a machine-readable closure report (`finalize-report.json`) before marking done.
    *   Keep behavior parity tests across sequential UI, parallel UI, and headless paths; include smoke tests that each mode mounts its correct execution bridge (`runWithUi`, `runParallelWithUi`, headless executor) so no mode can run silently without expected state updates.
    *   Publish OpenAPI schema at `/api/openapi.json` and interactive API docs at `/api`.
    *   Generate API docs from route/schema metadata to reduce drift between implementation and docs.
    *   Add CI API-drift gate: OpenAPI diff checks plus required changelog entry for breaking/behavioral API changes.
    *   Position as advanced/automation-focused mode (CI scripts, scheduled runs, operator tooling).
    *   Provide MCP-control parity by mapping headless lifecycle actions to first-party MCP server tools for IDE-driven control flows.
*   **Autonomous Watcher - Full AFK mode:**
    *   Background process to monitor GitHub Issues and PRs and auto-start AFK sessions for fixes.
    *   Integration with messaging apps (e.g., WhatsApp) to automatically trigger feature implementation remotely.
*   **Compounding (gated + license-safe):** Mechanisms for the system to learn and improve performance over time based on accumulated data. ([I1](https://x.com/ryancarson/status/2016520542723924279), [I2](https://x.com/i/status/2020917423273279613))
    *   Extract candidate lessons from completed runs into ticket-local learning candidates with evidence, affected phase, and measured outcome deltas.
    *   Promote a lesson to active rule only after replay validation on fixtures and a measurable improvement threshold is met (for example: success-rate gain or retry-count reduction).
    *   Store promoted rules in a versioned ruleset with rollout modes (`shadow`, `canary`, `enforced`) and a one-click kill switch.
    *   Track per-rule metrics (`fires`, `accepted`, `ignored`, `regressions`) and auto-demote rules that regress quality.
    *   License/source policy: only learn from first-party artifacts or allowlisted external sources with explicit compatible license metadata and attribution.
*   **Model reliability:** Warn if a model set in configuration will be deprecated or price/context change.
*   **Model Performance Analytics + Leaderboard (cross-ticket council quality telemetry):**
    *   Track per-model metrics by phase: win rate, average latency, schema-validation failure rate, timeout rate, and cost-effectiveness score.
    *   Persist leaderboard at `.looptroop/project/model-leaderboard.yaml` and update after each council phase completion.
    *   Use leaderboard insights to suggest role assignment/composition at ticket creation (`architect`, `implementer`, `reviewer`) while preserving explicit user choice.
*   **Ticketing systems integration (deterministic source snapshot + guarded outbound sync):** Import tasks from external boards (GitHub Issues, Linear, Jira) using a per-ticket snapshot contract.
    *   Add optional user-defined `metadata` object on tickets and beads for custom key/value fields (for example: `effort_hours`, `reviewer`, `linked_issue_url`, `custom_tag`).
    *   Add AI-safe metadata namespace (`metadata.ai_safe`) that is excluded from all AI prompt schemas and cannot be read/modified by council, implementer, or verifier models.
    *   Allow writes to `metadata.ai_safe` only via direct user edits and system-managed sync/import operations.
    *   Keep scheduling/execution semantics unchanged unless a field is explicitly mapped by policy (default: metadata is non-scheduling).
    *   Persist imported source snapshot at `.looptroop/tickets/<ticket-id>/task-source-snapshot.yaml` (`source`, `external_id`, `title`, `description_hash`, `labels`, `imported_at`).
    *   Reuse one source-adapter contract for all boards (`github`, `linear`, `jira`) with deterministic operations: `test_connection`, `preview_items`, `import_item`, `push_status_update`.
    *   Require `test_connection` and `preview_items` to pass before first import or first outbound sync on a new source binding; failed checks must block binding with actionable diagnostics.
    *   Add deterministic auth fallback chain per source (no implicit guessing):
        *   GitHub: GitHub App installation token -> authenticated `gh` CLI session -> configured PAT token.
        *   Linear: OAuth token -> configured API key.
        *   Jira: OAuth token -> configured API token.
        *   if all candidates fail, return `source_auth_unavailable` with per-attempt reason codes.
    *   Persist source binding receipts at `.looptroop/tickets/<ticket-id>/imports/source-binding.json` with `source`, `auth_path_used`, `test_result`, `preview_count`, `bound_at`.
    *   Add optional outbound `tasks_to_issues` sync mode with hard target validation: outbound writes are allowed only when configured target owner/repo/project exactly matches linked source metadata.
    *   If target validation fails, block outbound action and emit `target_mismatch` diagnostics; never write to fallback targets.
    *   During execution, do not auto-sync mutable external changes; surface drift as `NEEDS_INPUT` with explicit `accept_remote`, `keep_local`, or `merge` decision.
    *   Keep bi-directional update optional and explicit; never overwrite local planning artifacts silently.
    *   Persist outbound sync receipts at `.looptroop/tickets/<ticket-id>/imports/sync-log.jsonl` including `mode`, `target`, `validated`, `result`, and `timestamp`.
*   **Effort + Bead Complexity Routing:** Extend effort routing from PRD-level labels to bead-level complexity-aware execution (cheap model for simple beads, stronger reasoning models for complex beads). ([I1](https://x.com/ValiNagacevschi/status/2014736018507768235))
    *   Route model tier primarily from bead `complexity_score` and `suggested_model_tier` (from the Complexity Analysis Pass), with PRD-level effort only as fallback.
    *   Persist per-bead routing decision evidence (`score`, `tier`, `selected_model`, `fallback_reason`) in run receipts.
    *   Add cheap-model syntax sweeper path: when failure class is isolated syntax/lint/type errors, run a fast low-cost fixer on only the failing file + error output before escalating back to the main implementer.
    *   Add sweeper limits (`max_sweeper_attempts`, default 2) and fallback escalation receipt (`sweeper_failed -> escalated_to_main`).
*   **Independent Bead Verifier (secondary-model completion gate with explicit verdict actions):**
    *   After implementer reports bead completion, run a second model/verifier to independently re-check quality gates and completion evidence.
    *   Verifier tool policy is read-only by default (`list_files`, `read_file`, `run_verification_command`, optional `take_screenshot` for UI beads); verifier cannot mutate repository files.
    *   Verifier execution order is deterministic: run required verification commands first, then inspect only files/artifacts related to failed checks.
    *   Require per-bead `expected_test_phase` metadata (`red`, `green`, `refactor`) before completion can be evaluated.
    *   Add phase-aware test-result validation contract:
        *   `red`: verifier expects at least one targeted failing test with expected failure signature;
        *   `green` and `refactor`: verifier expects all required targeted tests to pass.
    *   Verifier must end with one structured action: `approve_bead` or `request_changes`; missing/invalid verdict is `verifier_invalid_output` and bead cannot transition to `done`.
    *   Persist verifier `test_result_verdict` plus evidence references; mismatched phase/result blocks transition to `done`.
    *   Verifier must validate evidence authenticity by matching claimed gate results to actual command outputs/artifacts; unverified claims are treated as `fake_evidence`.
    *   On suspected `fake_evidence`, force targeted gate re-run and reject completion until independent evidence passes.
    *   If verifier verdict is missing/invalid/timed out, do not mark bead complete; retry verifier or route to `BLOCKED_ERROR` with remediation.
    *   Add required ticket-level final verification scorecard as the machine-prep stage for the Manual QA Loop:
        *   persist `verification-report.md` and `verification-report.json`;
        *   required sections: `completeness` (all intended work shipped), `correctness` (behavior matches requirements), `coherence` (implementation still follows approved design decisions);
        *   categorize findings as `critical`, `warning`, `suggestion` with file evidence and remediation;
        *   any `critical` finding blocks Manual QA Loop clearance until resolved.
*   **Benchmarks:** Put the app to the test on different benchmarks.
*   **Dynamic Evolution via Tree-Based Strategic Re-Planning (MCTS-inspired for Beads):**
    *   Move beyond simple retry loops when a bead repeatedly fails or a complex epic starts with high uncertainty.
    *   **Expansion:** generate 3 distinct strategies for the blocked task (debug current path, refactor approach, temporary simplification/stub path).
    *   **Simulation:** run a lightweight first-step simulation for each strategy and score expected success/reward.
    *   **Selection + pruning:** switch execution to the highest-scoring path, prune the stuck path, and record why it was abandoned.
    *   Persist strategy-tree artifacts at `.looptroop/tickets/<ticket-id>/planning/strategy-tree-<timestamp>.json` with assumptions, scores, and chosen branch.
*   **Reflexion Loop (memory-based self-correction):**
    *   On each failed bead iteration, require a structured reflection entry in `.looptroop/tickets/<ticket-id>/ticket_memory.md` with `trigger`, `fault`, and `correction`.
    *   The next retry must reference and apply the latest `correction`; retries without a new valid correction are rejected by loop control.
    *   Persist reflection outcomes (`applied`, `not_applied`, `regressed`) so harvest/review phases can measure whether the correction helped.
*   **Global rankings:** Maestro has a global ranking for people who run the longest sessions, with badges and different levels of achievements. E.g., the best level is for those who run for 10 years (which can be achieved faster by running parallel sessions). Rankings are also done by cost. Users should be able to opt into these rankings and see their position in a leaderboard. [I1](https://runmaestro.ai/)
*   **Actual data research:** Integrate with last 30 days, which will research a specific topic on Twitter and Reddit in the last month to give accurate data. [I1](https://github.com/mvanhorn/last30days-skill)
*   **OpenCode v2 Persistent Session Continuation (true resume across restarts):** When OpenCode v2 reaches stable, make the bead "Continue" action a real session continuation instead of a fresh iteration restart.
    *   Persist full OpenCode session state (conversation history, tool-call context, in-progress work) so that a "Continue" resumes the exact session where it left off.
    *   Session continuity must survive PC restarts, app restarts, and backend restarts — the session is picked up from where it remained without restarting the current iteration.
    *   Resuming a persisted session must not consume bead iteration budget; only genuinely new attempts count as iterations.
    *   If the persisted session is corrupted or unrecoverable, fall back to a fresh iteration with explicit `session_unrecoverable` diagnostics and preserve all prior iteration notes/evidence.
    *   Gate behind OpenCode v2 stable release; do not attempt on earlier versions where session persistence APIs are unavailable or unstable.
