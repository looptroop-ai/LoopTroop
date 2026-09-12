# PR20: structured-output parsing

PR20 covers the two parser items deferred from PR13. PR21 remains separate.

## Changes from the old plan

- Candidate loops still return the first candidate that validates. No selection loop changed.
- The repair cascades are no longer identical. Only their shared inline-sequence, inline-key and colon-spacing prefix was extracted; later repairs, parse attempts, fall-throughs and warning checks retain their existing order. The owner approved this narrower extraction.
- PR14 already unified the exported block-scalar header grammar. Review found one remaining internal omission in nested-mapping repair and a path that still interpreted scalar body text as mappings; both now use the shared grammar and preserve literal content.
- PRD coverage and PRD normalization use different repair options and cannot share those entries. Coverage's record parser and legacy-key cleanup do call the same parser with matching options and can reuse successful candidates.

## Cache and affected callers

Successful candidate parses use a process-local LRU capped at 128 entries and 8 MiB of serialized values, warnings and key bytes. SHA-256 keys include the exact trimmed UTF-16 text, repair options and an explicit repair-pipeline contract revision. The revision advances with repair changes; deploying new code also restarts the daemon with an empty cache. A mapped-type check requires every new repair option to be accounted for in the key. Option order is preserved because normalized parent names can collide and the last configuration wins.

The cache stores serialized snapshots and returns independent objects and warning arrays. This matters because refinement and coverage parsers remove fields from parsed objects. The cache helper preserves dates, binary values, aliases, cycles and undefined values; its binary tests also require independent backing buffers. Current YAML defaults reject `!!binary` and `!!timestamp`, so those helper tests do not imply support for those tags. Oversized results, serialization failures and parse failures bypass storage. Unkeyable options fall back to the uncached parser. Unreadable snapshots are evicted and reparsed, including deep graphs that V8 can serialize but cannot deserialize within its stack limit.

The cache sits below schema validation and covers existing interview, PRD, beads, voting, execution, integration and Manual QA callers. Validation still runs for every caller. Existing warning strings, candidate priority, retry limits, prompts and workflow statuses are unchanged.

## YAML corrections

- Duplicate block removal consumes blank gaps, preserves external comments and leaves retained scalar bodies untouched. A dedented comment ends a scalar; malformed content after it stays invalid. Nested mapping bodies can continue after comments, so those discarded children remain skipped.
- Glued `free_text` values such as `|some prose` and `>some prose` become quoted literals. Valid block headers keep their meaning. The reserved-indicator rule loses a redundant guard without changing its accepted inputs.
- Nested-mapping repair moves literal scalar contents with a repaired header, including headers with explicit indentation indicators, and preserves parent/child-looking text inside retained scalars. Sequence-mapping guards use the actual key column so sibling repairs resume at the right indent.

Published documentation has a clearly marked unreleased subsection in the website repository. It does not describe these changes as available in the stable CLI.

The owner approved complete-entry comparison for duplicate repairs. Only identical entries are removed; differing block bodies, nested values and multiline continuations remain invalid. Existing callers can try their remaining candidates and use their existing correction/retry flow if none succeeds. This can require another model attempt for output previously accepted by discarding a value. Prompts, statuses and retry limits do not change.

Comparison includes scalar whitespace and chomping-sensitive blank lines, and recognizes indentless sequence values. The repair declines duplicate flow entries. Duplicate and nested-mapping repairs also leave the candidate unchanged when tags, anchors, aliases or quoted/flow values make their boundaries uncertain. One-line flow values must parse as JSON to prove their extent; other YAML flow forms are left unchanged. This avoids interpreting literal text as keys without introducing another YAML parser.

## Verification

The cache tests cover LRU and byte eviction, replacement accounting, oversized entries, independent warning arrays and object graphs, binary backing memory, option separation and distinct lone UTF-16 surrogates. Existing parser tests cover repair order and warning selection; YAML fixtures cover both observable corrections and valid block headers.

The benchmark is reproducible with `npx tsx scripts/benchmark-structured-output.ts`. It checks exact parsed values for seven valid fixtures, reports invalid candidates separately, distinguishes distinct drafts from same-draft refinement reuse, and includes a 48,492-byte/64-bead artifact. Unique and repeated inputs have equal lengths. Input construction and assertions are included in the timings; every mode is warmed before measurement.

Measurements below use the same script in separate baseline (`2043085c`) and PR20 processes on the same Linux/x64 machine with Node v26.8.2. Each cell reports **min/median/max milliseconds per pass**, from five samples of 200 passes for small workloads or 20 passes for large artifacts.

| Workload | Before: unique | PR20: unique | Before: repeated | PR20: repeated |
| --- | ---: | ---: | ---: | ---: |
| valid corpus (7 candidates) | 1.464/1.642/1.888 | 2.281/2.468/2.872 | 1.198/1.554/1.653 | 0.121/0.185/0.261 |
| invalid candidate (uncached errors) | 0.617/0.655/0.679 | 0.859/0.934/1.016 | 0.551/0.682/0.759 | 0.793/0.819/0.912 |
| large bead parse (48492 bytes, 64 beads) | 17.071/18.184/22.145 | 23.818/24.020/26.554 | 18.170/20.258/22.015 | 1.580/1.634/1.716 |
| bead refinement (distinct drafts) | 2.779/2.867/3.964 | 3.648/3.689/4.057 | 2.927/3.160/3.550 | 1.753/1.931/2.074 |
| bead refinement (same draft twice) | 2.691/2.915/3.577 | 2.743/2.841/3.159 | 2.598/3.068/3.349 | 1.439/1.818/2.093 |
| large refinement (same draft twice) | 102.449/109.009/110.863 | 95.834/104.653/125.089 | 98.798/115.456/119.987 | 72.995/82.872/86.892 |

Repeated valid workloads improve in these measurements. Unique workloads show a mixed cost, with several slower medians; the uncached-error workload also changes. These runs do not isolate cache overhead from repair changes and host variation, and no timing threshold or universal percentage is claimed. Same-draft refinement can reuse parsing within a unique-input call. Results describe these fixtures, not end-to-end workflow latency.

Local verification exercised all 414 test files: 5,859 tests passed, 10 existing tests were skipped, and one execution-timeout regression failed because its real 25 ms deadline included asynchronous session persistence. That test now advances a controlled clock after prompt dispatch; its entire 20-test file passed afterward. All 323 focused parser/repair tests passed. The test-only follow-up used localized checks under AGENTS.md's minor-change rule.

Lint, both typecheck projects, version verification, type-stripping verification, package contents, native-addon verification, installer synchronization and license checks passed. Final TypeScript compilation, frontend bundling and server bundling passed separately. Combined build invocations received termination signals during frontend bundling; standalone frontend builds passed with a 3,072 MiB Node heap limit. No build configuration or runtime memory limit changed. The website documentation build passed separately. No end-to-end or full lifecycle tests were run, and fresh CI remains for owner verification.
