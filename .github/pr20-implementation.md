# PR20: structured-output parsing

PR20 covers the two parser items deferred from PR13. PR21 remains separate.

## Changes from the old plan

- Candidate loops still return the first candidate that validates. No selection loop changed.
- The repair cascades are no longer identical. Only their shared inline-sequence, inline-key and colon-spacing prefix was extracted; later repairs, parse attempts, fall-throughs and warning checks retain their existing order. The owner approved this narrower extraction.
- PR14 already unified block-scalar header detection and added coverage across exported repairs. PR20 retains those detectors and tests.
- PRD coverage and PRD normalization use different repair options. They cannot share a cache entry just because their input text matches.

## Cache and affected callers

Successful candidate parses use a process-local LRU capped at 128 entries and 8 MiB of serialized values, warnings and key bytes. SHA-256 keys include the exact trimmed UTF-16 text, repair options and an explicit repair-pipeline revision. Changes to repair rules or ordering must bump that revision.

The cache stores serialized snapshots and returns independent objects and warning arrays. This matters because refinement and coverage parsers remove fields from parsed objects. Binary values also receive independent backing buffers. Dates, aliases, cycles and undefined YAML values keep their types and relationships. Oversized results, serialization failures and parse failures bypass storage.

The cache sits below schema validation and covers existing interview, PRD, beads, voting, execution, integration and Manual QA callers. Validation still runs for every caller. Existing warning strings, candidate priority, retry behavior, prompts and workflow statuses are unchanged.

## YAML corrections

- Duplicate block removal now skips the complete discarded body across blank and comment lines. The old fixture appended the discarded tail to the retained scalar; the regression now requires the original retained text.
- Glued `free_text` values such as `|some prose` and `>some prose` become quoted literals. Valid block headers keep their meaning. The reserved-indicator rule loses a redundant guard without changing its accepted inputs.

Published documentation has a clearly marked unreleased subsection in the website repository. It does not describe these changes as available in the stable CLI.

## Verification

The cache tests cover LRU and byte eviction, replacement accounting, oversized entries, independent warning arrays and object graphs, binary backing memory, option separation and distinct lone UTF-16 surrogates. Existing parser tests cover repair order and warning selection; YAML fixtures cover both observable corrections and valid block headers.

The representative benchmark is reproducible with `npx tsx scripts/benchmark-structured-output.ts`. It uses eight inputs drawn from parser tests and a bead refinement that parses both drafts. Unique-input passes vary comments or an extra JSON field to force misses; repeated-input passes reuse the same text. It reports medians rather than enforcing a timing threshold.

Sequential measurements on the same machine using Node v26.8.2, with five samples of 200 passes per workload:

| Workload (milliseconds per pass) | Before PR20 | PR20 |
| --- | ---: | ---: |
| Eight-candidate corpus, unique inputs | 2.151 | 2.241 |
| Eight-candidate corpus, repeated inputs | 1.786 | 1.042 |
| Bead refinement, unique inputs | 1.928 | 1.596 |
| Bead refinement, repeated inputs | 1.951 | 1.117 |

The baseline used the same benchmark script in a detached checkout of `2043085c`. Repeated workloads took about 42% less time; unique corpus inputs cost about 4% more. Bead refinement can reuse draft parses within a single call, even when each call starts with new text. These measurements describe the fixture workloads, not end-to-end workflow latency.

Local verification passed: 414 test files (5,792 passed tests, 10 existing skips), the targeted cache/parser regressions, lint, both typecheck projects, application build, package contents, native-addon verification, version verification, type-stripping verification, installer synchronization and license checks. The website documentation build passed separately. No end-to-end or full lifecycle tests were run.
