# PR20 review dispositions

Reviewed all six reports in `tmp/pr20`, every issue comment, inline comment and submitted review on PR #157, and the initial CI results for `cb67e9f5`. This continues the existing PR and preserves the owner's approved extraction of only identical repair steps.

Report references below use C = Claude Opus 5, D = DeepSeek V4.1 Flash, F = Gemini 3.8 Flash, G = Grok 4.6, M = MiMo V2.5, and S = Muse Spark.

## CI and bot reviews

| Observation | Assessment and action |
| --- | --- |
| CodeQL alert #159; D1; inline comment 3996550043 | The benchmark intentionally changes only the opening brace; it is not a sanitizer. Replace the flagged string replacement with explicit prefix/slice construction. No security-alert dismissal or suppression is needed. |
| Kilo failure; D1 | Check-run 103570378018 reports: “Review failed: The model output limit was reached.” It has no annotations or code findings. This is an external review failure; fresh CI/review results remain for the owner to verify after the fixes are pushed. |
| CodeRabbit docstring coverage warning | Add concise contract documentation to the changed parser/cache and benchmark helpers. Keep the existing implementation and avoid generating unrelated boilerplate. |
| Sourcery | Its submitted review reports an exhausted review budget. The separate guide is a generated summary, not completed code review evidence. Its diagram incorrectly places schema validation inside the parser and only on misses; callers validate after either path. |
| Amazon Q, Codex, CodeRabbit, Qodo, Greptile, Gitar | No actionable correctness findings. Their generated summaries do not override the reproduced issues from the local reports. |
| Codacy, SonarCloud, Socket and Semgrep | Passed. SonarCloud's zero reported new-code coverage is not a claim that tests were absent; the local suite and CI test jobs ran the regressions. |
| Green CI warnings | All 39 jobs in each initial push/PR CI run passed. Full logs showed the same upstream artifact-download `Buffer()` deprecation, Renovate dependencies/RE2 fallback, postject diagnostics and intentional Node/npm policy fallback already covered by `.github/security-alert-dispositions.md` and `.github/pr19-review-dispositions.md`. No new warning family or action-retirement warning appeared. Current upstream releases do not supply fixes for those accepted warnings. |
| Local verification follow-up | One execution-timeout regression failed under load because its real 25 ms budget included asynchronous owned-session persistence. It now advances a controlled clock only after the stalled prompt is dispatched, preserving its assertions and runtime behavior; its 20-test file passed. Final compilation and frontend/server builds passed separately after combined build invocations received termination signals during bundling. Standalone frontend builds used a 3,072 MiB Node heap limit; runtime configuration is unchanged. |

## Cache findings

| Reports | Assessment and action |
| --- | --- |
| C1: cache failed parses | Correct that failures repeat repair work. Keep them uncached: replacing a `YAMLException` with `Error(message)` loses its `reason`, `mark` and class. Negative caching would require a separate error contract, and cannot improve genuinely unique-input misses. The revised benchmark reports invalid input separately. |
| C3, D3, F2.2: incomplete future option keys | Add a mapped-type completeness check to the keyed options object. A new option now fails compilation until classified; existing default normalization remains intact. |
| S2, S7: key serialization can reject valid JSON | Confirmed for circular/BigInt repair options, although current callers use static valid configurations. If key creation fails, use the uncached parser, preserving its original acceptance and diagnostics. |
| F2.1, M3: sort option keys; S3: preserve order | Sorting is unsafe. Parent names normalize before insertion into a Map; two spellings can collide, and the last configuration wins. A regression uses `PARENT`/`parent` with opposite orders and requires different results. Top-level option insertion order was already irrelevant to the explicit key construction. |
| C4, D4, F2.4, G1, M1, S5: revision location/enforcement | Keep the explicitly requested revision marker and advance it with these repair changes. Clarify that production code changes restart the daemon and empty this process-local cache. Claims that a source edit leaves old entries running under new code are incorrect here. No source hashing, import snapshots, build hooks or persistent-cache design is needed. |
| C5, D6, F2.3, G3, M6/M12, S4: clear/reset/TTL/statistics | Existing occupancy tests pass shuffled runs and deliberately replace/evict prior entries. No current contamination failure was reproduced. Keep the entry/byte bounds; no ticket/workspace teardown hook, counters, TTL, weak references or test-only production API is warranted. Future tests using module mocks must follow the repository's existing isolation rules. |
| G4: deserialization failure becomes parse failure | Confirmed without corrupting private cache state: V8 can serialize a deep object that exceeds its deserialization stack. Evict unreadable snapshots and return a miss. Repeated deep JSON remains parseable; the regression also covers serialization bypass. |
| G5: defensive empty-map reset | Current accounting remains consistent, including the new failed-read eviction. An empty map with a positive byte count requires a separate accounting bug; silently resetting the count would conceal it. Keep the invariants and eviction tests. |
| F3.1: selective caching/two-hit filter | No production hit-rate evidence establishes a better admission policy. Such a filter adds state and loses the first reuse that motivates this cache. Measure realistic large inputs before changing the approved parser-level policy. |
| F3.2: clone on misses too | No isolation defect: serialization snapshots the value before the first caller receives it. The first caller already owns a fresh parse graph. Deserializing again on misses only adds work. |
| M2: lazy deserialization proxy | Speculative and would change how validators access objects. Keep independent eager results; the large-artifact benchmark measures their actual cost. |
| C8, S8: key-byte accounting | The bound includes a conservative two bytes per JavaScript key character, not an exact UTF-8 heap estimate. Retain consistent insert/evict accounting and arbitrary-key unit coverage. |
| C8: binary handling is unreachable; M13: V8 portability | Correct that current js-yaml defaults reject `!!binary` and `!!timestamp`. The cache helper's Date/binary tests cover its serialized-value contract, not current YAML tag support; clarify the documentation. Node/V8 is the daemon runtime, so cross-engine persistence is not required. |

## YAML and extraction findings

| Reports | Assessment and action |
| --- | --- |
| C2/C8, D2, F1.1, G2, S1/S7: duplicate bodies/comments | Confirmed. The owner approved removing only complete identical entries; conflicting blocks and multiline values remain invalid for the existing correction/retry flow. External comments survive, and invalid scalar continuation after a dedented comment stays invalid. Nested mappings can legally continue after a comment, so comparisons and removal must cover their full bodies. Blank lines inside scalars participate in comparison because they can change the retained value's chomping. |
| New related duplicate-repair finding | Fixed: retained block-scalar bodies no longer lose repeated mapping-looking lines. Coverage includes mapping, sequence and sequence-mapping headers and resuming repair at sibling keys, including multiple spaces after a sequence dash. Both retained-scalar guards end at dedented external comments. |
| New related entry-boundary findings | Complete-entry comparison includes indentless lists and scalar whitespace. Multiline quoted/flow values and annotated scalars can contain apparent keys that an indentation-only repair cannot interpret safely. Duplicate and nested-mapping repairs now bypass candidates with uncertain boundaries; duplicate flow entries remain for YAML to reject. This can decline a repair, but prevents losing literal text. |
| G related leftover: nested-mapping header detector | Confirmed that a moved `|2` header leaves its body at the wrong indent. Use the shared header grammar and preserve all body lines while shifting the header/body together. Also protect retained scalars containing an apparent parent/child pair from nested-mapping repair. |
| C8, S7: weak valid-header assertions | Compare exact loaded values, including indentation and chomping, and cover the additional valid header variants. Keep idempotence and unchanged-input checks. |
| C7: finish/refile the broader extraction; M9: detector cleanup still open | The owner explicitly chose the narrower extraction. Different later branches and their warning bookkeeping stay in place; this is an accepted scope decision, not work automatically assigned to PR21. PR14 already unified the exported header grammar; only the reproduced internal omission above needed repair. |
| G2: share both skip branches | A common skip predicate would retain header-only comparison and comment-boundary errors. Address entry boundaries and equality at the shared repair instead. |
| M7/M8/M10/M11/M14, C verified-correct section | The glued-indicator and reserved-indicator changes are correct. M8 reverses the regex diff in prose, and M11 attributes the trim/dedupe consolidation to an earlier PR; the actual PR20 diff performs it. No additional behavioral change follows from those descriptions. |
| M4: rename `excluded`; M5/S9: always destructure all prefix stages | Keep the typed single-string parameter and only the intermediate values each branch uses. The branches intentionally compute warnings differently, as approved. |
| G related leftover: route `parsesAsPlainYamlOrJson` through cache | This helper deliberately tests whether raw text parses without repair when computing `repairApplied` for relevant-files output. Replacing it with the repairing parser would hide that intervention signal. Leave it unchanged. |
| C8/D6: redundant trim/empty guard | Remove the private uncached function's repeated trim and guard; only the public wrapper calls it with nonempty trimmed input. |
| G6: website follow-up | Keep the explicitly unreleased website section current with the final reviewed behavior and push it to website main in this session. |

## Benchmark findings

| Reports | Assessment and action |
| --- | --- |
| C6, D5, F4.1, S6, M15 | Replace the single headline percentage with workload-specific measurements and sample ranges. Keep unique and repeated inputs equal in length; report failed inputs separately, distinguish same-draft reuse from distinct drafts, and add a roughly 48 KB/64-bead workload. Verify parsed values and refinement success rather than truthiness alone. |
| F4.1 versus C6/M15 | The original same-input refinement row correctly demonstrated within-call reuse, already documented, but did not isolate distinct-draft misses. Retain it with an explicit label and add the distinct-draft row. |
| D5: vary only two copies | Two repeated keys would both become cache hits. Use a fresh fixed-width identifier for each unique input instead. |
| S6: reset/counters for benchmark | Warm each measured workload and report timing spread. Independent baseline/current processes and unique identifiers establish the intended workloads without adding runtime instrumentation. |
| D6: npm benchmark alias | The existing documented command works. Another package script adds no required capability. |

Validation results and refreshed measurements are recorded in `pr20-implementation.md`. No review-report source files were edited, no PR was merged, and no bot was instructed to change code.
