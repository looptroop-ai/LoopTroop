# PR21: UI and log leftovers

All four PR21 items were rechecked against the merged PR20 code. They remain applicable, with the history fixes now owned by the server projection and paginated history hook rather than the plan's older URL helper reference.

## Changes and impact

- AI history reads the normal projection, which already contains AI detail rows and attributed system milestones. Filtering happens before pagination; totals and exports use the same filter. The live context accepts the same attributed rows. Log writes and stored channel formats are unchanged.
- Newest history responses include sorted `modelIds` across the ticket, phase, attempt, and bead scope, independent of the selected view/model and page limit. Older pages and export walks omit the additional aggregate. Phase logs and Full Log retain this catalog across filter loading, reject older cached catalogs, and discard it when scope changes. Unavailable tabs reset their history and export queries. No additional endpoint or request is needed.
- The model picker uses a search combobox and grouped options-only listbox. Provider-collapse controls move above the results. Arrow keys and Enter select models; filtering, disabled choices, mouse selection, Escape, and focus restoration remain available.
- Execution-setup step controls expose `aria-expanded`. Eight previously silent clipboard callers show `Copy failed` until a retry succeeds. Existing phase/full-log export feedback remains in place, and overlapping clipboard attempts preserve the latest result.

The owner approved complete model metadata, moving provider-collapse controls above results, and the wording `Copy failed`. These are four commit groups on one branch; the PR stays unmerged.

## Documentation and verification

The changelog records all four changes. Website `docs/frontend.md` and `docs/api-reference.md` describe them as unreleased; no CLI reference or release pin changes. No workflow status definitions, prompts, parsers, dependencies, or ignore rules need changes.

Regression tests cover restored milestones, paging/export filters, complete model discovery, stale tabs and cached catalogs, scope changes, combobox navigation, disclosures, and clipboard refusal/retry. Local Chromium checks use the real components with isolated fixture responses; they do not start a ticket lifecycle. Full lint, typechecking, unit/integration tests, application build, and package checks run locally. CI completion and PR reviews remain with the owner.

Accessibility follows the [W3C combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/). Conditional render-time state adjustment follows [React's guidance](https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes) so an invalid tab's old query is corrected before the fallback view is committed.
