# Output Normalization

> [!IMPORTANT]
> **TL;DR** — LLM outputs are messy. LoopTroop runs every model response through structured parsers, YAML repair rules, and bounded retry loops to extract valid artifacts — never trusting raw model output as-is.

Every structured artifact that an AI council member produces goes through a normalization pipeline before LoopTroop trusts its content. This page catalogs all automatic repairs, cleanups, and semantic adjustments — what triggers each one and what the pipeline does about it.

Repairs produce `repairWarnings` that are stored on the run record and surfaced in the diagnostics view. A repair being applied never silently discards data; it always records what changed.

If output remains invalid after the bounded repair and retry path, LoopTroop treats the malformed text as diagnostics only. It is kept in raw attempt views and execution logs, but it is not rendered as structured artifact body content.

Normalization is intentionally conservative:

- **Parser repairs** fix syntax, wrappers, and transport noise so LoopTroop can read what the model already emitted.
- **Cleanup normalizations** may fill or restore values only when the source is deterministic, such as runtime context, canonical interview metadata, or arithmetic totals.
- **Anything else fails validation** and stays diagnostic-only rather than being guessed into a saved artifact.

## 1. Retry Classes

LoopTroop uses four distinct retry classes. The names matter because they describe different session and artifact behavior:

| Class | Session behavior | Controlled by `Structured Output Retries` |
| --- | --- | --- |
| Structured repair retry | Sends a targeted correction prompt in a **continued session** after schema/validation failure | yes |
| Fresh structured retry | Starts a **fresh session** after empty output, provider/session/transport failure, output truncation, or a status-specific fresh-session policy | yes |
| Workflow attempt retry | Starts a broader **new attempt**, such as coverage passes, execution setup attempts, final-test attempts, or coding bead iterations | no |
| No auto retry | Does not retry automatically, usually because the status is a user gate, terminal state, cleanup state, or has git/GitHub side effects | no |

`Structured Output Retries` is counted after the first response. With the default of `1`, LoopTroop can make one structured retry after an invalid first response. With `0`, it records the rejected response and follows the status failure path immediately.

Council draft, vote, and refine phases use structured retry prompts but run those retry prompts in fresh sessions by design. That keeps each council response isolated while still preserving rejected and accepted attempts in Raw diagnostics.

When OpenCode reports a step finish reason such as `length`, LoopTroop treats the response as output truncation rather than an ordinary schema mistake. The partial artifact is still preserved in Raw diagnostics, but blocked-error details call out the length stop directly because later parser messages, such as missing sections or fields, are often just symptoms of the response being cut off.

---

## 2. Universal Repairs

These are applied to every structured artifact regardless of type, before any artifact-specific validation runs.

### Candidate Extraction

Raw model output is rarely just the artifact. The pipeline extracts one or more *candidate strings* to try parsing.

#### Transcript prefix stripping

Models that receive a conversation history sometimes echo the `[assistant]` / `[user]` / `[system]` role prefixes onto their output lines.

**Trigger:** Lines starting with `[assistant/…]`, `[user]`, `[system]`, `[sys]`, `[tool]`, `[model]`, `[error]` (with optional sub-segments like `[assistant/gpt-4o]`).

**Repair:** The prefix is stripped from each line before every parse attempt.

#### Candidate collection from surrounding prose

Artifacts are sometimes wrapped in explanation text, markdown headings, or other content.

**Trigger:** The raw output does not parse as a standalone artifact.

**Repair:** The pipeline builds multiple candidate strings from the raw output and tries each in order:
1. The raw output as-is.
2. The output after transcript-prefix stripping.
3. The inner content of any ` ```yaml ` / ` ```yml ` / ` ```json ` / ` ```jsonl ` code fence.
4. The inner content of any `<TAG>…</TAG>` XML envelope specified by the parser.
5. Everything from the first line matching a known top-level key (e.g. `schema_version:`, `beads:`, `epics:`) to the end of the output.
6. Everything from a known top-level key when short same-line prose is glued directly before it, e.g. `Checking the result.status: clean`.

All variants with and without transcript-prefix stripping are tried. The first one that produces a valid artifact wins.

When the winning candidate is not the full raw output, a **Candidate Recovery** warning is recorded:
> *Recovered the structured artifact from surrounding transcript or wrapper text before validation.*

Same-line glued key recovery only removes the wrapper/prose prefix. The recovered candidate must still parse and pass the artifact schema; invalid structured content after the recovered key remains a validation failure.

#### Tagged-candidate extraction (`<TAG>…</TAG>`)

Some artifacts (e.g. `<BEAD_STATUS>`) use an explicit XML envelope rather than a bare YAML block.

**Trigger:** The parser expects a tag-wrapped artifact.

**Repair:** All occurrences of `<TAG>…</TAG>` are extracted. If only an opening tag is found but no closing tag (truncated model output), everything after the last opening tag is used as a fallback candidate.

#### Trailing terminal noise

Model output piped through a terminal or TTY can accumulate ANSI escape sequences or bracketed-paste control codes at the end.

**Trigger:** Trailing bytes consisting solely of ANSI escape sequences (`ESC[…`), bracketed-paste markers (`[200~` / `[201~`), or non-printable control characters (codes 0–8, 11, 12, 14–31, 127).

**Repair:** For JSON candidates, the trailing noise after the balanced root JSON value is stripped. For YAML candidates, trailing lines that consist entirely of noise characters are dropped. An inline suffix of noise is also stripped.

**Warning:** *Trimmed trailing terminal noise after the complete structured artifact.*

#### Orphan closing code fence

**Trigger:** A candidate ends with a lone ` ``` ` line, or a complete coverage YAML artifact is followed by a lone top-level ` ``` ` line and commentary, but has no matching opening ` ```yaml ` / ` ```json ` fence above it.

**Repair:** The orphan closing fence is stripped. For coverage results, LoopTroop may also retain the prefix before that fence when it independently parses as a complete coverage envelope (`status`, `gaps`, and `follow_up_questions`); the following commentary is then removed. This recovery never fills missing fields or changes any parsed artifact value.

**Warnings:**
- *Trimmed orphan trailing closing code fence after the structured artifact.*
- *Trimmed an orphan trailing closing code fence and commentary after the complete coverage artifact.*

---

### YAML Structural Repairs

After a candidate is selected, the pipeline tries to parse it. If parsing fails, repairs are applied in the order below and parsing is retried after each group. All repairs are idempotent.

#### 1. Nested mapping children repair

**Trigger:** A parent key (e.g. `generated_by:`) is emitted bare and its known child keys (`winner_model:`, `generated_at:`) appear at the *same* indentation level as the parent rather than indented under it.

**Example:**
```yaml
# Bad — children at parent level
generated_by:
winner_model: gpt-4o
generated_at: 2026-01-01T00:00:00Z

# Fixed
generated_by:
  winner_model: gpt-4o
  generated_at: 2026-01-01T00:00:00Z
```

**Warning:** *Repaired inconsistent YAML indentation for nested mapping children.*

The parent→child relationships are explicitly whitelisted per artifact type (e.g. `generated_by`, `summary`, `approval`, `progress`, `checks`).

#### 2. Inline sequence parent repair

**Trigger:** A collection-valued key has its first sequence item on the same line: `questions: - id: Q01 …`

**Example:**
```yaml
# Bad
questions: - id: Q01
             phase: foundation

# Fixed
questions:
  - id: Q01
    phase: foundation
```

#### 3. Missing mapping-key colon spacing

**Trigger:** A simple mapping key is emitted without the required space after the colon, e.g. `artifact:interview`, `skipped:false`, or `- id:Q01`. YAML can treat these as plain scalar strings instead of mapping entries.

**Repair:** A single space is inserted after the colon for lines that already look like simple mapping entries. The repair is line-scoped, skips block scalar bodies, and avoids one-letter keys such as Windows drive paths.

**Warning:** *Repaired YAML mapping keys missing a space after colon before parsing.*

#### 4. Inline keys repair

**Trigger:** Multiple mapping keys appear on a single line, e.g. `batch_number: 4 progress: current: 4 total: 17`.

**Repair:** Keys are tokenized and split onto separate lines with correct indentation. Nested parent→child relationships defined in the per-artifact whitelist are respected so that `progress: current: 4 total: 17` becomes a proper nested block.

**Warning:** *Repaired inline YAML sequence or mapping syntax before parsing.*

#### 5. Plain scalar colon repair

**Trigger:** A plain (unquoted) YAML scalar value contains `: ` (colon followed by space), which YAML interprets as a nested mapping entry. Example: `rationale: some rules: apply here`.

**Repair:** The value is wrapped in double quotes.

**Warning:** *Quoted YAML plain scalar values containing colon-space before reparsing.*

#### 6. Wrapped plain list scalar repair

**Trigger:** A prose list item contains `: ` and continues on one or more deeper-indented prose lines, such as a long acceptance criterion wrapping after ``writable: false``. YAML otherwise interprets the first line as a mapping and rejects the continuation as bad indentation.

**Repair:** When the list item is not mapping-shaped and every deeper line is also prose-shaped, the existing lines are converted to a folded `>-` block scalar. The emitted words and punctuation are preserved exactly, with YAML supplying the intended spaces between wrapped lines. Mapping-shaped items, structural child fields, blank-line boundaries, already quoted values, and ambiguous continuations are left unchanged for normal validation.

The shared YAML candidate parser applies this repair to PRD, Beads, relevant-files, execution-setup, final-test, Manual QA fix-bead, and pull-request draft artifacts.

**Warning:** *Folded wrapped YAML list scalar text containing colon-space before reparsing.*

#### 7. Structured list primary-key repair

**Trigger:** An opt-in structured artifact list item starts with a bare scalar and is followed by object fields, e.g. `beads: - config-parser title: ...`.

**Repair:** The existing scalar is moved into the configured primary key for that list, such as `id` for beads/PRD items or `path` for relevant files. This repair is only enabled for known structured lists and does not touch scalar-only lists such as `patterns`, `tests`, `testCommands`, or `acceptanceCriteria`.

**Warning:** *Repaired YAML sequence entry under "beads" at line 12: treated bare item "config-parser" as id before parsing.* (Lists the actual parent key, line, emitted scalar, and primary key.)

#### 8. Markdown code fence stripping

**Trigger:** The entire artifact is wrapped in a ` ```yaml ` … ` ``` ` block (or `json` / `yml` / `jsonl`).

**Repair:** The fence delimiters are removed, leaving only the inner content.

**Warning:** *Unwrapped markdown code fence wrapping the YAML payload.*

#### 9. Spurious XML tag stripping

**Trigger:** Lines that consist entirely of a bare XML-style tag (`<tag>`, `</tag>`, `<tag/>`).

**Repair:** Those lines are removed.

**Warning:** *Stripped XML-style tags `<tag>` from the payload before parsing.* (Lists the specific tags that were removed.)

#### 10. Free-text scalar repair

**Trigger:** A `free_text:` field has fragile YAML scalar formatting. Common cases include unquoted one-line values, malformed block scalars whose body starts at the same indentation as `free_text: >-`, and plain multi-line values that spill onto following indented lines. Such values are always strings in LoopTroop's schema but can start with backticks, look like booleans, contain `: `, or otherwise be misread as structure.

**Repair:** One-line values are wrapped in double quotes. Multi-line plain values, malformed block-scalar bodies, and multi-line single-quoted values are converted to YAML block literals while preserving the emitted text. If answer metadata such as `answered_by` or `answered_at` was accidentally indented under the malformed scalar, it is moved back to the answer mapping; no answer text is invented.

**Warning:** *Repaired YAML free_text scalar formatting before parsing.*

#### 11. Missing list-dash space

**Trigger:** A list item starts with `-` immediately followed by a key letter: `-key: value` instead of `- key: value`.

**Repair:** A space is inserted after the dash.

#### 12. Duplicate key removal

**Trigger:** The same mapping key appears more than once with exactly the same line text (key + value).

**Repair:** The exact duplicate is dropped. If the duplicate opens a nested block (e.g. a second `options:` with the same list), the entire duplicate block is skipped. Ambiguous duplicates with *different* values are left for js-yaml to report as an error.

#### 13. Invalid double-quoted escape repair

**Trigger:** A double-quoted YAML scalar contains a backslash sequence that is not valid in YAML (e.g. `\+`, `\p`, `\s` from regex-like text). YAML only permits a specific set of escape sequences (`\n`, `\t`, `\\`, `\"`, `\uXXXX`, etc.).

**Repair:** Invalid escape sequences are doubled: `\+` → `\\+` so the backslash becomes a literal character.

**Warning:** *Escaped invalid YAML double-quoted scalar backslash sequences before reparsing.*

#### 14. Inner double-quote scalar repair

**Trigger:** A one-line double-quoted scalar contains unescaped inner quotes, usually in code-like prose such as `free_text: "Errors include origin: "date" metadata."`.

**Repair:** The first and last unescaped quotes are kept as delimiters and existing unescaped quotes inside the scalar are escaped. The visible scalar text is unchanged, and block scalar bodies are skipped.

**Warning:** *Repaired improperly quoted YAML scalar value.*

#### 15. Unclosed double-quote repair

**Trigger:** A `key: "value` mapping line or a `- "value` list item has an opening `"` with no matching closing `"`, and the next non-blank line is clearly a new YAML structural element (list item, sibling key, code fence, document marker `---`, or end of file).

**Repair:** A closing `"` is appended to the line. This repair only closes the scalar when the boundary is structural and does not add or infer missing text.

**Warning:** *Fixed unbalanced YAML quote before reparsing.*

#### 16. Quoted scalar fragment repair

Two sub-cases:

**a) Quoted fragment + trailing plain text:** Values like `"pink" is accepted` or `'pink' remains supported` where a closed quoted token is immediately followed by plain text on the same line. YAML rejects this.

**Repair:** The full visible scalar is wrapped in double quotes: `"\"pink\" is accepted"`.

**b) Quoted block-scalar indicator:** A block-scalar indicator like `|-` is incorrectly quoted as `"|-"` or `'|-'`.

**Repair:** The quotes are removed — the indicator is unquoted back to `|-` when the following lines clearly form an indented block body.

**Warning:** *Repaired improperly quoted YAML scalar value.*

#### 17. Type-union scalar repair

**Trigger:** Schema-like values such as `type: "epic" | "user_story"` or `- "unit" | "integration"`. YAML interprets the `|` as a block-scalar indicator after a quoted token.

**Repair:** The entire scalar is wrapped in double quotes.

#### 18. Reserved indicator scalar repair

**Trigger:** Plain scalars starting with `` ` `` (backtick) or `@`. YAML reserves these characters and rejects plain scalars that begin with them.

**Example:**
```yaml
# Bad
question: `repo_git_mutex` behavior?
- @trace/span-id

# Fixed
question: "`repo_git_mutex` behavior?"
- "@trace/span-id"
```

**Warning:** *Quoted plain YAML scalars that began with reserved indicator characters (`` ` `` or `@`) before reparsing.*

#### 19. Sequence entry indent drift repair

**Trigger:** After a block scalar (`>-`, `|`), subsequent sibling list items drift by 1–3 spaces relative to the first item in the sequence.

**Repair:** All sibling dashes are normalized to the indent of the first `- ` in each sequence level.

#### 20. Indentation repair

**Trigger:** Property lines inside a list item are indented by the wrong amount (off by 1–2 spaces relative to `dash_indent + 2`).

**Repair:** Property lines that are clearly siblings of the list item (deeper than the dash, within 2 spaces of the expected indent) are re-indented to `dash_indent + 2`.

---

### Wrapper Unwrapping

Models often add a wrapper key around the artifact, e.g. outputting `output: { … }` instead of the artifact directly.

**Trigger:** The parsed root object has a single recognized wrapper key.

**Repair:** The wrapper is stripped and the inner object is promoted to the root. A warning records which key was removed.

**Warning examples:**
- *Removed wrapper key "output" from top level.*
- *Removed wrapper key chain "result -> prd" from top level.*

Common wrapper keys accepted across artifacts: `output`, `result`, `data`, `document`, `artifact`. Artifact-specific wrappers are listed in the per-artifact sections below.

---

### Prompt Echo Detection

Before attempting to parse, the pipeline checks whether the model returned its own prompt instead of an artifact.

**Hard markers** (one of these alone is enough to flag the output, combined with at least one soft marker):
- `CRITICAL OUTPUT RULE:`
- `CONTEXT REFRESH:`

**Soft markers** (need at least 2 total hits including a hard marker):
- `## System Role`
- `## Task`
- `## Instructions`
- `## Expected Output Format`
- `## Context`

If the output starts with a recognized root key (e.g. `schema_version:`) *and* contains a structured prompt schema marker (e.g. `## Expected Output Format`, `### ticket_details`, `# Ticket:`), it is also rejected as a schema echo.

When detected, the run is failed immediately with an explicit error and a retry diagnostic rather than attempting repairs.

---

### Key Aliasing

All field lookups use `getValueByAliases`, which normalizes keys by lowercasing and stripping all non-alphanumeric characters before comparison. This makes field matching case-insensitive and symbol-insensitive.

Every field accepts multiple spelling variants. Common examples:

| Canonical key | Also accepted |
| --- | --- |
| `acceptance_criteria` | `acceptancecriteria` |
| `implementation_steps` | `implementationsteps`, `steps` |
| `prd_refs` | `prdrefs`, `prdreferences`, `prd_references` |
| `context_guidance` | `contextguidance`, `architecturalguidance`, `guidance` |
| `blocked_by` | `blockedby` |
| `test_commands` | `testcommands`, `commands` |
| `anti_patterns` | `antipatterns`, `anti-patterns`, `anti_patterns_list` |
| `problem_statement` | `problemstatement` |
| `target_users` | `targetusers` |
| `in_scope` | `inscope` |
| `out_of_scope` | `outofscope` |
| `architecture_constraints` | `architectureconstraints` |
| `data_model` | `datamodel` |
| `api_contracts` | `apicontracts` |
| `security_constraints` | `securityconstraints` |
| `performance_constraints` | `performanceconstraints` |
| `reliability_constraints` | `reliabilityconstraints` |
| `error_handling_rules` | `errorhandlingrules` |
| `tooling_assumptions` | `toolingassumptions` |
| `required_commands` | `requiredcommands`, `commands` |
| `approved_by` | `approvedby` |
| `approved_at` | `approvedat` |
| `schema_version` | `schemaversion` |
| `ticket_id` | `ticketid` |
| `source_interview` | `sourceinterview` |
| `content_sha256` | `contentsha256` |
| `user_stories` | `userstories`, `stories` |

---

## 3. Artifact-Specific Normalizations

After the universal repairs succeed, each artifact type applies additional semantic normalizations.

### Interview Question-List and Interview Document Artifacts

This section covers three closely related shapes that share normalization rules:

- interview batch / question-list outputs produced during live questioning,
- interview refinement question lists used by council refine phases,
- the final durable `interview.yaml` document.

**Question ID normalization**

Question-list artifacts normalize numeric or loosely prefixed IDs to the `Q##` format (zero-padded to 2 digits):

| Raw | Normalized |
| --- | --- |
| `1` | `Q01` |
| `q1` | `Q01` |
| `Q1` | `Q01` |
| `Q01` | `Q01` (unchanged) |
| `Q15` | `Q15` (unchanged) |

The final durable interview document does **not** renumber every valid ID into `Q##`, but exact duplicate IDs are still repaired to the next available `Q##` value so the saved artifact stays unambiguous.

**Duplicate question ID renumbering**

If two question-list entries share the same normalized ID, the duplicate is assigned the next integer above the current maximum ID in the batch.

**Warning examples:**
- *Renumbered duplicate question id Q01 at index 3 to Q05.* (question-list artifacts)
- *Renumbered duplicate question id "Q01" to "Q05".* (durable interview document)

**Malformed structured question collections**

When a response contains a structured `questions` collection, every entry in that collection must be question-shaped. LoopTroop no longer drops malformed entries and continues with the rest; the artifact fails validation with indexed diagnostics so the normal repair/retry path can ask the model for a complete replacement.

**Phase normalization**

The `phase` field is accepted case-insensitively.

- Question-list artifacts normalize phases to `foundation`, `structure`, `assembly`.
- Interview batch payloads surface the display labels `Foundation`, `Structure`, `Assembly`.

**Question reordering**

Questions are sorted by phase (foundation → structure → assembly), preserving relative order within each phase. This matches the expected interview structure regardless of the order the model emitted them.

**Interview document identity cleanup**

The durable `interview.yaml` artifact also applies a few root-level canonicalizations:

- Missing `ticket_id` is filled from runtime context.
- A non-canonical root `artifact` value is normalized to `interview`.
- Status values are reduced to `draft` or `approved`; any other emitted value is normalized to `draft` and logged.

**Coverage gap string list quoting**

When the coverage checker returns a list of gap strings, each item is wrapped in double quotes to prevent YAML from coercing values like `true`, `null`, or values containing `: `. If the checker omits only the `- ` list markers from direct, complete quoted entries under `gaps:` or `issues:`, LoopTroop restores those markers without changing the quoted text. If a complete coverage envelope is followed only by an orphan closing fence and model commentary, LoopTroop keeps the validated envelope and removes that non-artifact suffix. These coverage-only repairs never apply to mappings, plain prose, nested content, or follow-up questions.

Coverage revision metadata must reference each provided gap. PRD and beads coverage accept exact references first; if a model only changes harmless formatting such as quote style, escaped quote/backtick spelling, or whitespace, the reference is canonicalized back to the provided gap text and a repair warning is recorded.

---

### Full Answers Artifact

Full Answers uses the interview document parser plus one additional recovery path. It exists only for PRD Part 1, where a council member fills skipped interview answers before drafting a PRD.

**Answer-only overlay recovery**

**Trigger:** The model returns a `questions:` list that contains only canonical question IDs and answer-shaped fields instead of copying the complete interview question metadata. The question ID set must exactly match the approved interview: same count, no duplicates, and no missing or invented IDs. Question blocks may contain only `id`, `answer`, answer scalar fields, and sibling `answered_by` / `answered_at` metadata.

**Repair:** LoopTroop overlays the returned answers onto the approved interview's canonical question order, prompts, phases, source metadata, answer types, and options. Misplaced sibling `answered_by` and `answered_at` values are hoisted into the nested `answer` object when that nested value is absent.

**Warnings:**
- *Recovered Full Answers answer-only question blocks using canonical question metadata.*
- *Hoisted answered_by into answer for canonical question Q01.*
- *Hoisted answered_at into answer for canonical question Q01.*

This recovery is intentionally not shared by PRD, beads, or generic YAML parsers. Those artifacts do not have a safe canonical-question overlay source, so missing structural content remains a validation failure there.

**Canonical follow-up-round recovery**

**Trigger:** A Full Answers candidate contains malformed or missing `follow_up_rounds` while the approved Interview Results artifact is available.

**Repair:** LoopTroop restores `follow_up_rounds` from the approved Interview Results artifact and ignores the candidate's malformed round metadata. This is safe for Full Answers because PRD Part 1 may fill skipped answers, but it must not invent or rewrite the approved interview's question metadata, follow-up structure, summary, or approval state.

**Warning:** *Canonicalized follow_up_rounds to match the approved Interview Results artifact.*

---

### PRD Artifact

**Status normalization**

Accepted values for `status`: `draft`, `approved`. Any unrecognized value is normalized to `draft` and recorded as a repair warning.

**Warning:** *Normalized unsupported PRD status "pending" to draft.*

**Schema version**

`schema_version` must be a positive integer. Any non-integer or non-positive value is replaced with `1`.

**Warning:** *Normalized invalid schema_version to 1.*

**`ticket_id` canonicalization**

The `ticket_id` in the artifact is compared to the runtime ticket ID.

- If missing: filled from runtime context.
  **Warning:** *Filled missing ticket_id from runtime context.*
- If present but mismatched: replaced with the runtime value.
  **Warning:** *Canonicalized ticket_id from `<old>` to `<new>`.*

**`source_interview.content_sha256` canonicalization**

The hash of the approved Interview Results artifact is computed at runtime. If the emitted hash differs, it is replaced with the correct value.

**Warning:** *Canonicalized source_interview.content_sha256 from the approved Interview Results artifact.*

**Missing or duplicate epic IDs**

- Missing ID → generated as `EPIC-{n}` (1-indexed).
  **Warning:** *Epic at index 0 was missing id. Filled with EPIC-1.*
- Duplicate ID → the duplicate is renamed to the next available `EPIC-{n}` above the current ceiling.
  **Warning:** *Renumbered duplicate epic id EPIC-1 to EPIC-3.*

**Missing or duplicate user story IDs**

- Missing ID → generated as `US-{epic_index}-{story_index}` (1-indexed).
  **Warning:** *User story at epic 1, index 0 was missing id. Filled with US-1-1.*
- Duplicate ID → renamed deterministically.
  **Warning:** *Renumbered duplicate user story id US-1-1 to US-1-3.*

**Nested artifact wrapper**

The model sometimes wraps the PRD inside `artifact: { prd: { … } }`. The inner `prd` object is promoted to the root and `artifact: prd` is set as a flat key.

**Accepted wrapper keys:** `prd`, `document`, `output`, `result`, `data`.

---

### Beads (Blueprint) Artifact

**Missing bead ID**

If a bead entry has no `id`, `beadid`, or `bead_id` key, the ID is generated as `bead-{index+1}`.

**Duplicate bead ID renumbering**

If two beads share an ID, the second is renamed by appending `-2`, `-3`, etc. until unique.

**Warning:** *Renumbered duplicate bead id "auth-module" to "auth-module-2".*

**Context guidance string → object conversion**

`context_guidance` must be an object with `patterns` and `anti_patterns` arrays. Models sometimes emit it as a plain string.

*Multi-line format:*
```
Patterns:
- Use X
Anti-patterns:
- Avoid Y
```
→ converted to `{ patterns: ["Use X"], anti_patterns: ["Avoid Y"] }`

*Inline format:*
```
Patterns: Use X Anti-patterns: Avoid Y
```
→ converted to `{ patterns: ["Use X"], anti_patterns: ["Avoid Y"] }`

**Warning:** *Canonicalized string context guidance at index 0 into patterns/anti_patterns object.*

**Empty `prdRefs` warning**

A bead with no PRD references is valid but unusual.

**Warning:** *Bead "auth-module" has no PRD references (prdRefs is empty).*

**Accepted wrapper keys:** `beads`, `tasks`, `items`, `issues`, `workitems`, `work_items`.

---

### Expanded Beads JSONL Artifact

The Part 2 expanded bead list (`normalizeBeadsJsonlOutput`) is stricter than the council blueprint subset, but it still performs a few compatibility repairs:

- **Legacy status normalization** — `completed` and `skipped` become `done`; `failed` becomes `error`.
- **Legacy dependency array handling** — a flat dependency list is treated as `blocked_by`.
- **Notes array normalization** — `notes` may be emitted as a string array and is collapsed into a newline-joined string.

Unlike the council blueprint normalizer, duplicate bead IDs or unknown/self dependencies fail validation here instead of being silently reshaped.

---

### Bead Completion Marker Artifact

The completion marker is extracted from a `<BEAD_STATUS>…</BEAD_STATUS>` XML envelope.

**Status normalization**

| Raw value | Normalized |
| --- | --- |
| `done` | `done` |
| `completed`, `complete`, `success`, `succeeded` | `done` |
| `failed`, `fail`, `error` | `error` |

**Check value normalization**

Each quality gate (`tests`, `lint`, `typecheck`, `qualitative`) accepts multiple representations:

| Raw value | Normalized |
| --- | --- |
| `"pass"`, `"passed"`, `"ok"`, `"success"`, `"complete"`, `"completed"`, `true`, `1` | `pass` |
| `"fail"`, `"failed"`, `"error"`, `"timeout"`, `"timedout"`, `"notrun"`, `"skipped"`, `"pending"`, `false`, `0` | `fail` |

Any other string value is kept as-is (lowercased).

Normalization decides whether the response is a valid completion candidate; local Git finalization still determines whether the bead can become `done`. The coding agent owns bead-scoped verification, may adapt planned `testCommands` when repository evidence contradicts them, and must return passing test, lint, typecheck, and qualitative values. LoopTroop does not independently rerun the frozen bead commands after this marker; the later Final Testing phase remains a mandatory backend-executed gate.

**Accepted wrapper keys:** `beadstatus`, `bead_status`, `statusmarker`, `marker`, `result`, `output`, `data`.

**Key aliases for quality gates:**

| Canonical | Also accepted |
| --- | --- |
| `tests` | `test` |
| `lint` | `linter` |
| `typecheck` | `type_check`, `type-check`, `typechecks`, `typescript` |
| `qualitative` | `quality`, `qualitativereview`, `qualitative_review`, `review` |

---

### Vote Scorecard Artifact

Vote scorecards accept wrapper keys such as `draft_scores`, `scores`, or `scorecard`, then normalize the per-draft score map.

**Draft label normalization**

Draft labels like `draft1`, `Draft 01`, or `draft 2` are normalized to the canonical `Draft N` form before validation.

**Wrapper indentation repair**

Models sometimes emit a wrapper key correctly but indent the draft scorecards or rubric rows one level too shallow beneath it. LoopTroop repairs that indentation before parsing.

**Warning:** *Normalized vote scorecard indentation under the wrapper key.*

**`total_score` recovery**

- Missing `total_score` is filled from the rubric dimension totals.
- Incorrect `total_score` is recomputed from the rubric dimension totals.

**Warning examples:**
- *Filled missing total_score for Draft 2 from rubric category totals.*
- *Recomputed total_score for Draft 1: expected 54, received 57.*

---

### Relevant Files Artifact

Relevant-files output prefers a `<RELEVANT_FILES_RESULT>…</RELEVANT_FILES_RESULT>` envelope, but the normalizer also accepts plain YAML/JSON payloads and wrapper keys such as `relevant_files_result`, `relevant_files`, `payload`, `result`, `output`, `data`, or `artifact`.

**Incomplete trailing file-entry recovery**

If the last `files:` entry is truncated and breaks YAML parsing, LoopTroop drops only that incomplete final entry and retries parsing the remainder.

**Warning:** *Truncated incomplete last file entry to recover from malformed YAML.*

**List entry and field defaults**

- `file_count` is always canonicalized to the actual saved list length.
- Missing `relevance` defaults to `medium`.
- Missing `likely_action` defaults to `read`.
- Missing `content_preview` falls back to the emitted `content`.

---

### Final Test Command Artifact

Final test command plans use a `<FINAL_TEST_COMMANDS>…</FINAL_TEST_COMMANDS>` envelope and may be wrapped in keys such as `final_test_commands`, `command_plan`, `plan`, `result`, `output`, or `data`.

**Array coercions**

- A single string `commands` value is coerced into a one-item array.
- String `test_files` and `modified_files` values are likewise coerced into arrays.
- `modified_files` falls back to the deduped `test_files` list when omitted.

**Warning examples:**
- *Coerced commands from string to array*
- *Coerced test_files from string to array*
- *Coerced modified_files from string to array*

**File effect normalization**

`file_effects` entries may be emitted as either bare paths or objects. Bare paths are treated as `{ path, intent: "candidate" }`. Object intents are normalized into three canonical buckets:

| Raw intent | Normalized |
| --- | --- |
| `candidate`, `include`, `commit`, `keep`, `permanent` | `candidate` |
| `temporary`, `temp`, `scratch`, `artifact`, `generated`, `exclude` | `temporary` |
| `unexpected`, `unknown`, `unintended`, `accidental` | `unexpected` |

At execution time, explicit candidate intent overrides generated-looking or ignored paths. Existing tracked or staged changes are also preserved. Undeclared untracked files in Git-ignored, setup-temporary, dependency, cache, or output locations remain on disk as local-only and are excluded from change totals and delivery. Other unknown untracked files receive one same-session classification retry; if still undeclared, they continue as local-only with a warning. Unresolved tracked changes remain candidates for the final PR audit.

---

### Manual QA Checklist Artifact

Manual QA generation requires exactly one complete `<MANUAL_QA_CHECKLIST>…</MANUAL_QA_CHECKLIST>` envelope. Missing, duplicate, or incomplete envelopes fail validation. The model owns only `summary` and item content; LoopTroop assigns `schemaVersion`, ticket/version metadata, timestamps, and deterministic item IDs such as `qa-v2-001`.

The parser applies the shared YAML/JSON formatting repairs and a deliberately small alias map:

| Alias | Canonical key |
| --- | --- |
| `lineage_id` | `lineageId` |
| `prior_item_ids` | `priorItemIds` |
| `recheck_state` | `recheckState` |
| `expected_result` | `expectedResult` |
| `watch_notes` | `watchNotes` |
| `bead_refs` | `beadRefs` |
| `prd_refs` | `prdRefs` |
| `not_applicable_prd_refs` | `notApplicablePrdRefs` |

Alias collisions fail instead of choosing one value. Repairs may restore YAML structure, normalize the strict envelope, or rename these fields, but may never invent a checklist summary, behavior, action, observation, prerequisite, or expected result. The strict item contract accepts only `prd | bead | previous_qa | implementation_diff` sources, `required | optional` severity, and `new | pending_recheck | previously_passed` recheck state; there is no duplicate requiredness boolean. The result still must satisfy the versioned schema, unique active IDs/lineages, at least one action per item, and all other constraints.

PRD criterion refs are validated against the frozen approved PRD after parsing. The canonical form is `<epic-id>/<story-id>/AC-<1-based-index>`, with a required `full | partial` level. `notApplicablePrdRefs` is a unique list of `{ ref, reason }`; reasons must be nonempty, and a ref cannot appear both there and on an item. After validation, coverage is deterministic code: any valid full reference means covered, partial-only means partially covered, an explicit reasoned exclusion means `not_applicable`, and all remaining refs are uncovered. Gaps remain advisory and no second model response is requested.

Application-owned checklist/results YAML is loaded directly with `js-yaml` and validated against its schema; model-output repair is not applied to canonical files. Shared inline-key repair recognizes a mapping colon only when followed by whitespace or end-of-line, preserving scalar IDs such as `manual-qa-submit:<uuid>` and URLs. During model checklist parsing, a narrow context-aware repair may quote YAML-sensitive hex-color text in known prose fields and records a warning; it never invents lost words.

### Manual QA Fix-Bead Candidate

Failed submissions require exactly one complete `<MANUAL_QA_FIX_BEADS>…</MANUAL_QA_FIX_BEADS>` envelope. Its candidate keys must exactly match the application-provided merge-group keys, with one complete bead definition per key. Validation requires meaningful title/description/context, PRD refs, acceptance criteria, tests, test commands, labels, dependencies, and safe project-relative target files. At least one successful focused read-only repository inspection tool call is part of the generation contract.

LoopTroop assigns bead IDs, priority/order, pending lifecycle state, `qa-fix` issue type, external references, reverse dependency links, timestamps, and `qaOrigin`; the model may not override these fields. The complete validated batch is written to `fix-beads.yaml` before any Improvement ticket or bead is created. There is no lower-quality repair/fallback bead: exhausted model/tool/parser validation routes the submission to recoverable `BLOCKED_ERROR` with zero child records.

Later rounds reuse stable `lineageId` values and may reference prior item IDs. Code rejects unknown/duplicate prior references, changed lineage, `previously_passed` items whose prior result did not pass, retained waivers not marked for recheck, and any failed prior item omitted from the next checklist. First-round and newly introduced items must be `new`; referenced affected items must be `pending_recheck`. The version reservation is allocated before generation, so structured retries/restarts reuse the same `vN`; a valid existing checklist plus coverage advances idempotently without normalization or another model call.

---

### Execution Setup Plan and Result Artifacts

Execution setup artifacts use explicit XML envelopes:

- `<EXECUTION_SETUP_PLAN>…</EXECUTION_SETUP_PLAN>`
- `<EXECUTION_SETUP_RESULT>…</EXECUTION_SETUP_RESULT>`

The plan normalizer accepts wrapper keys such as `execution_setup_plan`, `plan`, `data`, and `result`. The result normalizer accepts `execution_setup_result`, `result`, `output`, and `data`.

Plans carry `workspace_inputs` entries with a repository-relative `path`, `kind` (`file` or `directory`), `source_status` (`ignored` or `untracked`), and a concrete `reason`. The planning prompt compares the original checkout with the ticket worktree and proposes an entry only when repository evidence or a prior setup failure connects that missing input to readiness. It never includes file contents or shell copy commands. It also forbids paths outside the checkout and Git or LoopTroop internal paths.

Both artifacts carry ordered `workspace_probes` entries with required `id`, `command`, and `purpose`. Their `git_hooks` object contains a strict policy enum, read-only detected-hook records (`name`, normalized `path`, `source`, `executable`, optional `manager_hint`), and ordered validation commands (`id`, `hook`, `command`, `purpose`). An empty validation-command list is valid and preserved exactly; the parser never synthesizes a command for an unknown hook.

Parsing preserves project commands as declared rather than restricting them to a built-in ecosystem list. Runtime setup still checks launcher availability, executes the approved tooling and workspace probes, and requires those probes to succeed before coding begins. A short markerless progress reply is treated as unfinished work rather than a malformed final artifact: LoopTroop sends up to two same-session continuation instructions without consuming a setup attempt or structured-output retry. Completed but malformed results retain the normal structured repair path.

The canonical executable `.ticket/runtime/execution-setup/run` may be recovered from disk when a valid setup result omitted its reusable-artifact declaration. This backend repair upgrades or adds one `command-wrapper` artifact without duplicates and records a caution. Independent command receipts may include `setupWrapperApplied` and `effectiveCommand` so the UI can distinguish the approved bare command from the actual routed command.

**Status normalization**

- Execution setup plan status accepts `draft`, `planned`, `plan`, `review` and normalizes to `draft`.
- Execution setup result/profile status accepts success aliases and normalizes them to `ready`; `blocked`, `failed`, `fail`, `failure`, and `error` normalize to `blocked`. The top-level and profile statuses must match. Ready requires every check to pass, while Blocked requires at least one explicit failed check.
- Readiness status accepts `ready`, `partial`, and `missing` plus close aliases such as `needsSetup`, `incomplete`, `notReady`, and `uninitialized`.

**Path normalization**

`temp_roots`, `workspace_inputs`, and reusable artifact paths are normalized to forward-slash form and drop a leading `./`, so path comparisons stay stable across providers and host shells. Workspace input entries keep only the strict `file|directory` kind and `ignored|untracked` source status. Filesystem and Git validation happen before materialization, so parser normalization never invents an input or changes its classification.

**Missing setup-step field fill**

Execution setup plan steps may safely inherit a few values from local context:

- missing `id` → `setup-step-{ordinal}`
- missing `title` → copied from `purpose`
- missing `rationale` → copied from `purpose`

**Warning examples:**
- *Filled missing execution setup plan step id at index 0 from list position.*
- *Filled missing execution setup plan step title at index 0 from existing purpose text.*
- *Filled missing execution setup plan step rationale at index 0 from existing purpose text.*

**Tool requirement status normalization**

Within execution setup profiles, tool requirements normalize these status buckets:

| Raw value | Normalized |
| --- | --- |
| `available` | `available` |
| `provisioned`, `prepared` | `provisioned` |
| `failed`, `fail`, `error` | `failed` |
| `notProvisionable`, `notPossible`, `noSafePath`, `unsupported` | `not_provisionable` |

---

### Refinement Changes (PRD, Beads, Interview)

When a council member proposes changes to an existing artifact draft, it emits a `changes:` list alongside the artifact. The changes are extracted before the artifact is validated (to avoid schema conflicts) and normalized separately.

**Invalid entries skipped**

- Non-object list entries: skipped.
  **Warning:** *Skipped non-object refinement change at index 2.*
- Entries with an unrecognized `type`: skipped.
  **Warning:** *Skipped refinement change at index 1 with invalid type.*

Valid `type` values: `modified`, `added`, `removed` (case-insensitive).

**Stable identifier repair**

PRD and Beads refinements require a `modified` item to preserve its winning-artifact ID. If a model gives a genuinely new item that ID and shifts the surviving item to an otherwise unused ID, LoopTroop can restore the two identifiers. The repair is applied only when the winning artifact, final artifact, one mismatched `modified` entry, and one explicit `added` entry establish a unique two-item mapping. It updates identifiers and their change records only; it never creates or rewrites item text. Ambiguous mappings remain validation failures.

Repeated PRD `modified` entries that resolve to the same canonical before/after item are collapsed into one change. If their inspiration metadata conflicts, attribution is cleared instead of guessed.

**Warning:** *Restored PRD refinement ID stability at change index 8: reassigned surviving user_story "Documentation" from US-16 to US-15 and reassigned newly added user_story "Performance safeguards" from US-15 to US-16.*

**Inspiration item lenient parsing**

The `inspiration` field (pointing to the losing draft that inspired the change) is parsed leniently:
- A bare string is accepted as the inspiration `label`, with `id` left empty.
- Partial objects (missing `id` or `label`) are accepted.
- The `alternative_draft` field accepts either a model ID string (matched against the losing draft roster) or an ordinal integer (1-indexed position in the roster).

Entries where `inspiration` is present but cannot be resolved are recorded with `attributionStatus: "invalid_unattributed"` rather than being dropped.

---

## 4. Structured Interventions

LoopTroop automatically translates low-level parser warnings, schema repairs, and normalization adjustments into rich **Structured Interventions**. Rather than silently modifying generated data or failing with obscure syntax errors, the pipeline captures every correction and exposes it as a human-readable diagnostic in the UI.

Structured Interventions are stored alongside the validated artifact metadata and displayed on the primary artifact tabs.

### 4.1 Intervention Categories

Interventions are classified into six categories, determining their purpose and how they are presented:

| Category | Meaning | Example Rule / Action |
| --- | --- | --- |
| `parser_fix` | Syntax adjustments required to parse raw YAML/JSON | Stripping terminal noise, balancing quotes, unwrapping code fences |
| `cleanup` | Schema-level normalizations to standardize values | Renumbering duplicate IDs, setting defaults, normalizing status casing |
| `synthesized` | Reconstructing omitted elements from adjacent context | Inferring missing fields, synthesizing undeclared refinement changes |
| `dropped` | Pruning invalid or incompatible elements | Removing malformed refinement entries, dropping no-op changes |
| `attribution` | Correcting or clearing source draft references | Resolving or clearing out-of-range inspiration IDs |
| `retry` | Recording automatic validation-prompt attempts | Retrying structured requests after validation failures |

### 4.2 Intervention Stages

The system tracks which stage in the parsing lifecycle triggered the intervention:

- **`parse`** — Applied before or during the raw parse attempt (e.g., prefix stripping, ANSI code trimming).
- **`normalize`** — Applied during key-value normalization and type alignment (e.g., zero-padding question IDs to `Q##`).
- **`semantic_validation`** — Applied when comparing contents against external reference sources or schemas (e.g., verifying expanded beads against a refined blueprint).
- **`retry`** — Applied when a structured request is repeated following validation failure.

### 4.3 UI and Interactive Details

In the UI, interventions are represented as compact badges on the primary artifact review screens:
- **Amber Indicators:** Surfacer notices appear on the main tab to alert the user that repairs were applied.
- **Detailed Breakdowns:** Expanding an intervention notice exposes its technical details, including the specific **rule** applied, the **exact correction** performed, target fields or keys, and **before/after examples** showing exactly how the raw model output was repaired.
- **Vote scorecard consolidation:** Voting scorecard repairs are consolidated into a single collapsed notification per voter to keep the results screen clean.

---

## 5. Diagnostics and Observability

Every repair produces one or more entries in `repairWarnings`. These are stored on the run record and shown in the **Diagnostics** panel (see [Diagnostics](diagnostics.md)).

A `repairApplied: true` flag is set on any result where at least one repair warning was generated or where the winning candidate was not the raw output verbatim. This flag drives the amber repair indicator shown in the council log.

Repairs never silently drop required fields — if a required field cannot be recovered after all repairs, the parse fails and the run may be retried with a structured retry prompt that explains the specific validation error, up to the locked `Structured Output Retries` count.

Structured retry loops store `rawAttempts` next to the artifact/report detail when model text is available. Each attempt records the attempt number, stage, outcome (`rejected` or `accepted`), raw response, and any validation error or failure class. If a failure happens before any model text exists, the attempt is still recorded diagnostically but without invented output text.

This currently covers council drafts and votes, PRD/interview/beads refinement, relevant-files scans, coverage audit/revision, execution setup plan/runtime, final-test generation, and PR draft generation.

The UI then presents that retry history conservatively:

- Raw/Diff tabs focus on attempt inspection, not on pretending rejected output became canonical.
- Duplicate Raw variants are collapsed by rendered payload, while attempt numbering stays stable and ordered.
- Single-model Raw views group attempts under the model/mode label; aggregate selectors only appear for genuinely multi-source views.
- When a draft is later reused by voting or refinement, its Raw view falls back to the validated canonical body because that is the only content downstream phases consume.

Automatic structured retries are still **one phase run**. They create attempt history inside the artifact, not a new canonical artifact version. User-triggered Retry from `BLOCKED_ERROR` is different: for every non-implementation status, LoopTroop archives the failed active phase attempt and creates a fresh active attempt before rerunning, so earlier reruns are inspected through the previous-version selector. `CODING` remains bead-scoped and uses bead reset/retry history instead of phase versions.

Invalid, failed, or timed-out outputs stay diagnostic-only. The structured artifact body shows the failure context and short excerpts, while the full malformed model text lives only in Raw attempt views and execution logs.

## 6. UI Artifact Companions

Artifacts produced by council phases (drafts, votes, refinements) carry companion metadata that enables rich UI rendering without modifying the base artifact schema. The system is defined in `shared/artifactCompanions.ts`.

### 6.1 What A Companion Is

A `UiArtifactCompanionArtifact<T>` wraps a base artifact with UI-oriented metadata:

| Field | Description |
| --- | --- |
| `baseArtifactType` | The type of the wrapped artifact (e.g., `prd`, `beads`, `interview`) |
| `generatedAt` | ISO timestamp of when the companion was generated |
| `payload` | Arbitrary typed data specific to the artifact domain |

### 6.2 Companion Type Convention

Companion artifacts use a naming convention: `ui_artifact_companion:{baseArtifactType}`. For example, a companion wrapping a PRD draft has the artifact type `ui_artifact_companion:prd`. This allows the frontend to discover companions by type prefix without knowing the exact artifact IDs in advance.

### 6.3 Where Companions Are Used

Companions are attached to council draft and vote artifacts. They carry UI display hints, rendering metadata, and cross-references that the base artifact schema does not define. The companion is parsed and validated at read time — if the JSON payload is malformed, parsing returns `null` rather than failing the base artifact read.

### 6.4 Companion Lifecycle

Companions are generated when the council phase produces its primary artifact. They are stored alongside the base artifact in the `phase_artifacts` table. When a new phase attempt archives the previous one, the companion is archived with the base artifact. Companions are never edited independently — they are replaced when the phase runs again.

## 7. Structured Output Schemas

The canonical definitions for all parsers and validators are defined as Zod schemas under `server/structuredOutput/*`:

- `voteOutput.ts` — Validates council voting scorecards.
- `completionOutput.ts` — Validates bead completion markers, final-test command plans, and execution setup plan/result payloads.
- `prdOutput.ts` — Validates the PRD layout, epics, user stories, and acceptance criteria.
- `interviewDocument.ts` — Validates durable interview documents and Full Answers overlays.
- `beadsOutput.ts` — Validates bead blueprints, expanded beads JSONL, relevant-files payloads, and bead refinement outputs.
- `refinementChanges.ts` — Validates proposed modification overlays during planning refine phases.
- `interviewOutput.ts` — Validates interview batches, coverage results, and interview refinement outputs.

These modules define the boundary between raw text generation and durable backend state, powering the normalizations detailed above.

## Related Docs

- [Prompt Inventory](prompts.md)
- [Context Engineering](context-engineering.md)
- [Runtime Diagnostics](diagnostics.md)
