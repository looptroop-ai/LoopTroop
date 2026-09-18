# Beads and parser audit dispositions

This ledger records documentation coverage for the reviewed parser and beads
packets. `PASS, final pending` means the bounded packet evidence passed its
review; root still owns final source integration, checks, and acceptance. A row
does not imply that an unreviewed finding is complete.

## Parser foundation

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| P02 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; block scalar bodies, including compact nested sequence bodies and list-item bodies, remain byte-identical through repair even when headers carry comments or chomping indicators. | No E2E or full lifecycle run. |
| P03 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; raw valid YAML has authority and nested sequence entries stay nested during sibling repair. | No E2E or full lifecycle run. |
| P05 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; Double-quoted escape repair recognizes block-scalar headers with trailing comments and preserves their bodies. | No E2E or full lifecycle run. |
| P06 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; uncertain flow, quoted, anchor, and tag nodes remain byte-for-byte unchanged. | No E2E or full lifecycle run. |
| P07 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; CRLF and lone CR normalize before parsing and cache-key creation. | No E2E or full lifecycle run. |
| P08 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; canonical alias precedence is preserved across buckets and payload order, with one conflict warning. | No E2E or full lifecycle run. |
| P09 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; XML-looking lines are stripped only outside literal blocks and warnings name only removed tags. | No E2E or full lifecycle run. |
| P10 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; list-item and compact nested block-scalar indentation uses the owning key/sequence column, quoted sequence keys resume sibling tracking, and duplicate-looking body lines stay inside the scalar. | No E2E or full lifecycle run. |
| P16.1 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; fallback interview batch attempts retain candidate warnings. | No E2E or full lifecycle run. |
| P16.2 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; PRD warnings distinguish reconstructed item changes from document-only changes. | No E2E or full lifecycle run. |
| P17.1 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; YAML and JSON fence labels are case-insensitive. | No E2E or full lifecycle run. |
| P17.2 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; bead iteration accepts only positive integers or numeric strings. | No E2E or full lifecycle run. |
| P17.5 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; duplicate final-test file effects emit one warning per path while retaining merged content. | No E2E or full lifecycle run. |
| P17.6 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; explicit blank status becomes pending with a warning, while absent or null keeps the default. | No E2E or full lifecycle run. |
| P18 | PASS, final pending | `/tmp/looptroop-parser-evidence.md`; parse-cache invalidation fingerprints the complete repair and parser sources without runtime source reads. | No E2E or full lifecycle run. |

## Beads contract packet

The beads packet covers the authoritative JSONL contract, structured command
producers, approval validation, runtime diagnostics, and affected board and
workspace displays.

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| G02 | PASS, final pending | `/tmp/looptroop-beads-evidence.md`; authoritative tracker reads fail closed before mutation or false `ALL_BEADS_DONE`, while valid rows, `runtime.beadsDiagnostics`, and board/workspace repair warnings remain visible. | No E2E or full lifecycle run. |
| W02 | PASS, final pending | `/tmp/looptroop-beads-evidence.md`; bead route, document, and graph tests treat `blocked_by` as authoritative and derive inverse `blocks` edges on approval and save. Explicit stale inverse entries remain an intentional accepted input contract and are not rejected by this PR. | No E2E or full lifecycle run. |
| P01 | PASS, final pending | `/tmp/looptroop-beads-evidence.md`; approval and editor tests validate structured `CommandSpec` entries, do not infer shell commands from bare strings, and show repair reasons for unrepresentable commands or damaged rows. | No E2E or full lifecycle run. |
| P04/P14 | PASS, final pending | `/tmp/looptroop-beads-evidence.md`; the immutable original draft baseline hash survives refetch, edit, autosave, reload, save, restore, and approve; stale writes return a typed `409` conflict. | No E2E or full lifecycle run. |
| P11 | PASS, final pending | `/tmp/looptroop-beads-evidence.md`; unknown top-level and dependency metadata survives canonicalization, and JSONL `sourceLines` metadata in the PUT body remains strictly increasing positive safe integers with the exact item count, alongside original JSONL source lines and field diagnostics. | No E2E or full lifecycle run. |
| P15 | PASS, final pending | `/tmp/looptroop-beads-evidence.md`; damaged or unrepresentable navigator/editor rows disclose their problems and suppress anchors that cannot point to raw editor content. | Native browser and assistive-technology verification remain unclaimed. |
| P17(3) | Partial, final pending | `/tmp/looptroop-beads-evidence.md`; only the accepted alias-precedence subitem is covered here. | P17 interview subitem 4 remains outside this part; do not treat whole P17 as complete. No E2E or full lifecycle run. |
| P19 | PASS, final pending | `/tmp/looptroop-beads-evidence.md`; the reused dependency graph rejects dangling `blocked_by` references before approval or write and reports their ids; it also rejects dependency cycles before approval or write with a cycle diagnostic. | No E2E or full lifecycle run. |
| U06 | PASS, final pending | `/tmp/looptroop-beads-release-docs-evidence.md`; BeadsApprovalEditor tests connect labels and disclosure panels to native controls with programmatic names, `aria-expanded`, and `aria-controls`. | Native browser and assistive-technology verification remain unclaimed. |

## Part limits

- Parser and beads evidence is recorded in `/tmp/looptroop-parser-evidence.md`, `/tmp/looptroop-beads-evidence.md`, and `/tmp/looptroop-beads-release-docs-evidence.md`.
- Parser repairs format existing text only. Damaged structured saves block and preserve the malformed bytes; explicit JSONL repair is required.
- This part does not claim whole P17 completion. Interview subitem 4 remains pending.
- Linux and Node execution only. Native Windows and macOS, real-browser accessibility, E2E, full lifecycle, CI, and live external operations remain unverified.
- Full isolated checks have completed; see `/tmp/looptroop-beads-parser-part-evidence.md` for 6070 passed, 10 skipped across 422 files and all required checks. Root still owns fresh aggregate review of the actual integrated diff and final acceptance.

## Post-review corrections

The PR review pass also covered defects outside the original packet. These are
kept here so the bounded evidence and the permanent review ledger point at the
same behaviour:

- Runtime-only `failedIterationNotes`, `userRetryNotes`, and
  `finalizationFailureNotes` aliases are canonicalised alongside the editable
  bead fields; `server/phases/beads/__tests__/beadsFile.test.ts` covers each
  snake_case spelling.
- An unreadable tracker path is isolated to that ticket's runtime diagnostics;
  healthy tickets remain visible, while authoritative reads and Manual QA
  checklist generation retain fail-closed behaviour. The generator therefore
  does not opt into malformed-entry skipping.
- The approval request uses the current fetched content hash and does not make
  optional UI-state failure a prerequisite. `sourceLines` remains body
  metadata with strict count/order validation; it is not an HTTP header.
- Persisted Manual QA candidates use schema version 2; version 1 is discarded
  for regeneration rather than read as a current checklist.
- `CommandSpecListEditor` edits one argument per literal textarea. It does not
  split shell text and accepts spaces, newlines, empty strings, and
  temporarily incomplete JSON-looking values. The focused editor regression
  exercises sequential changes.
- Parser repairs keep the prior tag grammar and dash-list whitespace while
  using bounded/linear scans; selective `free_text` repair changes only
  non-string values and leaves valid prose untouched.

Round 3 implementation follow-up: compact nested headers now enter the shared
block-scalar guard before list fast paths, structural dashes are found without
confusing a chomping `-` or comment hyphen, quoted sequence keys retain their
body boundary, and reserved-indicator repairs continue through nested-mapping
and non-string `free_text` handling while preserving valid folded strings.
Approval requires a recognized status and present priority; malformed PUT JSON
returns `{ error: "Invalid JSON body" }` with HTTP 400. Client readers and alias
stripping use canonical non-nullish values, including explicit empty strings,
lists, and records. The submitted `blocked_by`/derived `blocks` contract is
unchanged: stale explicit inverse data is tolerated intentionally. Website
documentation for the JSONL-only 422 repair gate and edit-surface header is
owned by the root integrator.
