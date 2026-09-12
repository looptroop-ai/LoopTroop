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

- Duplicate block removal consumes scalar blank gaps, preserves external comments and leaves retained scalar bodies untouched. Ordinary separator blanks stay outside entries. A dedented comment ends a scalar; malformed content after it stays invalid. Nested mapping bodies can continue after comments, so those discarded children remain skipped.
- Glued `free_text` values such as `|some prose` and `>some prose` become quoted literals. Valid block headers keep their meaning. The reserved-indicator rule loses a redundant guard without changing its accepted inputs.
- Nested-mapping repair moves literal scalar contents with a repaired header, including headers with explicit indentation indicators, and preserves parent/child-looking text inside retained scalars. Sequence-mapping guards use the actual key column so sibling repairs resume at the right indent.

Published documentation has a clearly marked unreleased subsection in the website repository. It does not describe these changes as available in the stable CLI.

The owner approved complete-entry comparison for duplicate repairs. Only identical entries are removed; differing block bodies, nested values and multiline continuations remain invalid. Existing callers can try their remaining candidates and use their existing correction/retry flow if none succeeds. This can require another model attempt for output previously accepted by discarding a value. Prompts, statuses and retry limits do not change.

Comparison includes scalar whitespace and chomping-sensitive blank lines, and recognizes indentless sequence values. Ordinary trailing blank separators remain outside entries. The repair declines duplicate flow entries. Closed flow collections are recognized by matching delimiters outside quoted text, so valid YAML values such as `[EPIC-1]` can coexist with unrelated repairs. Duplicate and nested-mapping repairs leave the candidate unchanged when tags, anchors, aliases or multiline quoted/flow values make their boundaries uncertain. This protects literal content while preserving the existing correction/retry flow.

## Verification

The cache tests cover LRU and byte eviction, replacement accounting, oversized entries, independent warning arrays and object graphs, binary backing memory, option separation and distinct lone UTF-16 surrogates. Existing parser tests cover repair order and warning selection; YAML fixtures cover both observable corrections and valid block headers.

The benchmark is reproducible with `npx tsx scripts/benchmark-structured-output.ts`. It checks exact parsed values for seven valid fixtures, reports invalid candidates separately, distinguishes distinct drafts from same-draft refinement reuse, and includes two 64-bead artifacts: a 48,492-byte clean document and a 44,377-byte hand-written document with YAML flow lists, an identical duplicate and a blank separator. The latter reproduces the second-round repair regression on the reviewed head. Unique and repeated inputs have equal lengths. Full-value assertions run before timing; input construction and cheap success checks remain timed. Every mode is warmed before measurement.

Measurements below use the same script in separate baseline (`2043085c`) and PR20 processes on the same Linux/x64 machine with Node v26.8.2. Each cell reports **min/median/max milliseconds per pass**, from five samples of 200 passes for small workloads or 20 passes for large artifacts.

| Workload | Before: unique | PR20: unique | Before: repeated | PR20: repeated |
| --- | ---: | ---: | ---: | ---: |
| valid corpus (7 candidates) | 1.552/1.850/1.999 | 1.716/1.925/2.345 | 1.555/1.682/1.737 | 0.129/0.137/0.150 |
| invalid candidate (uncached errors) | 0.756/0.816/0.911 | 0.790/0.842/0.921 | 0.739/0.788/0.847 | 0.642/0.726/0.900 |
| large clean bead parse (48492 bytes, 64 beads) | 16.185/17.633/18.910 | 16.608/18.993/20.479 | 18.832/19.677/21.662 | 0.810/1.033/1.084 |
| large model-shaped bead parse (44377 bytes, 64 beads) | 22.768/24.058/29.350 | 23.610/27.255/29.616 | 21.406/24.304/27.487 | 0.638/0.682/1.066 |
| bead refinement (distinct drafts) | 3.514/3.667/3.767 | 2.529/2.796/3.552 | 3.127/3.399/3.885 | 1.181/1.253/1.379 |
| bead refinement (same draft twice) | 2.507/2.824/3.377 | 1.906/2.105/2.328 | 2.761/2.958/3.171 | 1.384/1.440/1.527 |
| large refinement (same draft twice) | 100.283/109.927/116.303 | 87.436/94.691/106.929 | 89.818/93.638/104.245 | 56.844/67.151/87.326 |

Repeated valid workloads improve in these measurements. Unique workloads show a mixed cost, with several slower medians; the uncached-error workload also changes. These runs do not isolate cache overhead from repair changes and host variation, and no timing threshold or universal percentage is claimed. Same-draft refinement can reuse parsing within a unique-input call. Results describe these fixtures, not end-to-end workflow latency.

Final local verification passed all 414 test files: 5,896 tests passed and 10 existing tests were skipped. All 350 focused parser/repair tests also passed. The first review's execution-timeout regression now advances a controlled clock after prompt dispatch rather than racing a real 25 ms deadline during asynchronous session persistence; it passes in the full suite and in the reviewed CI runs.

Lint, both typecheck projects, version verification, type-stripping verification, package contents, native-addon verification, installer synchronization and license checks passed. TypeScript compilation, frontend bundling and server bundling passed as separate build steps; the frontend used a 3,072 MiB Node heap limit. No build configuration or runtime memory limit changed. The website documentation build passed separately. No end-to-end or full lifecycle tests were run, and fresh CI remains for owner verification.
