# Consolidated audit documentation packet

This is a documentation coverage ledger for the bounded baseline packet. It is
not final acceptance. The website records the current accepted source where
that source is ahead of the served release; R03 retains an explicit warning
about the currently served installer, and R28 is marked **next release**.

## Findings covered

| Finding | Disposition | Documentation coverage |
| --- | --- | --- |
| R03 | Current source documented with a served-release safety caveat | Installation flags and `.install.lock.claim` are described as next-release behavior from the current installer source. The served `v0.5.9` installer is explicitly not described as supporting them and users are warned not to pass the flags to it. |
| R12 | Implemented in website verification | The website pins its CLI source to immutable app commit `83ae3243…`, checks out that source in CI, accepts a local sibling override, and fails closed when the catalog is missing instead of silently using a reduced fallback. |
| R26 | Documented | The app README now states the Node and npm floors that match the package engines. |
| R27 | Documented by shell | Yarn instructions are explicitly Bash/zsh commands. Yarn is not called Windows-unsupported; Windows users are directed to npm as the recommended documented setup, with no unverified PowerShell PATH command claimed. |
| R28 | Prepared for **next release** | Mock-ticket wording is limited to display-only, non-terminal tickets; `409` during `CLEANING_ENV` and after a verified merge is marked next release. |
| G36 | Documented | Fresh project databases are the supported starting point. No legacy duplicate-receipt migration or deduplication is promised; the documented recovery is backup, remove the named old project database, and attach again. |
| S01–S04 / R01 root | Documented current accepted behavior | Windows extensionless resolution follows `PATHEXT` sibling order before trust checks; verified unmapped-owner handling is noted for containers and sandboxes. |
| U01–U04, U07, U12 | Documented current accepted behavior | Modal route/back synchronization, popup Escape and focus ownership, modal stacking, mobile drawer dialog behavior, focus restoration, breakpoint cleanup, and hidden-ancestor focus handling are summarized for users. |

## R12 source evidence and applied choice

The install catalog was introduced in app commit `68a8a5f3…` and is also present
in `0b782f6c…` and the current app head. No published tag contains it. The
owner-approved website source ref is the immutable current accepted app commit
`83ae324348164c6f4d1c5dedaebcba69359d15c9`. Website CI checks out that ref into
`.source/LoopTroop`, and the verifier uses `LOOPTROOP_SOURCE_ROOT` when set or
the local sibling checkout otherwise. A missing catalog now fails with an
actionable error; there is no reduced two-channel fallback.

## Remaining documentation work

- If root’s final accepted app integration changes the catalog-containing commit,
  update the website’s immutable `CLI_SOURCE_REF` and the matching CI checkout
  together before integration.
- Native Windows Yarn PATH setup is intentionally not claimed as verified; the
  documented Windows recommendation is npm, while the Yarn commands are
  explicitly Bash/zsh commands.
- After a release tag exists, point the website at that tag and regenerate any
  release-pinned pages according to the release process.
- Future not-yet-implemented report packets need their own documentation pass;
  this ledger does not pre-document the rest of the consolidated report.
