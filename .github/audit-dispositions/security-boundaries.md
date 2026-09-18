# Security boundaries

Status: PASS for the accepted security source and this ledger's bounded scope.
This file is the security slice of the audit ledger; it does not make a global
UI, cache, workflow, or release claim.

## Source and scope

The accepted source checkpoint is 154/154 findings. The implementation is
represented by the tracked request, child-environment, static-boundary, SSE,
and action-ID source files in this repository. Session-local manifests,
temporary evidence files, and bare tree object IDs are intake material rather
than permanent proof; the per-comment ledger in
`.github/pr168-review-dispositions.md` names the durable source and test evidence.

## Dispositions

| Finding | Status | Evidence and permanent coverage | Limits |
| --- | --- | --- | --- |
| S01–S04 | CROSS-PART | Executable-path overflow-UID, PATHEXT, quote-parity, and percent-pair work belongs to PR163; PR168 does not duplicate it. See the PR163 source and disposition ledger. | No PR168 code claim. |
| S05 | PASS | Local mode recognizes only loopback Host authorities; Origin parsing rejects non-canonical hostname spellings, wildcard public hosts, and explicit port `0`, and same-authority Origins must match the actual scheme, hostname, and effective port. One explicit HTTPS `publicOrigin` comes only from `LOOPTROOP_PUBLIC_ORIGIN` or `config.json`; remote browser access still requires `LOOPTROOP_ALLOW_REMOTE_API=1`, and no-Origin cookie requests require same-origin Fetch Metadata plus the preserved public Host. | No E2E or full lifecycle run. |
| S06 | PASS | Project, Git, hook, managed and development OpenCode, and doctor-probe children remove only `LOOPTROOP_API_TOKEN` and `LOOPTROOP_DEV_EVENT_TOKEN` after merged overrides. Provider and Git credentials and the trusted CLI daemon handoff remain intentional. | Child-environment filtering is not a process sandbox. |
| S07/S08/S09 remaining/G26 | PASS | Static launch and filesystem rules cover namespace destructuring, static template/CommonJS loaders, computed string-literal launch methods and shell keys, `getBuiltinModule`, re-exports, nested `fs.promises`, `opendir`, and exact filename-plus-operation boundaries. Existing contained, no-follow, managed-root, and ticket-root helpers remain the runtime contract; the project browser is metadata-only. | No whole-program alias or dataflow analysis is claimed; ANSI helper consolidation is PR163-owned. |
| S10 | PASS | SSE admission reserves before asynchronous setup, preserves six per-ticket and 100 global slots, cleans reservations idempotently across abort, open, write, replay, and ticket-cleanup paths, aborts pending opening writes before ticket cleanup releases admission, and observes rejected initial writes when activation loses its reservation. | No E2E or full lifecycle run. |
| S11 | PASS | Origin parsing rejects alternate IPv4 spellings while retaining valid canonical IPv6 and hostname behavior; Host loopback validation applies in local mode only. | No native Windows or macOS run. |
| S12(1) | PASS | Manual QA action IDs use the published character set and 160-character maximum at the real schema boundary. | This row covers action IDs only. |
| S12(2) | CROSS-PART | The earlier G14/S12 row remains the source of truth for contained project and ticket paths, opaque legal names, Windows ADS rejection, and final-symlink containment; those changes belong to PR164. | This row is referenced here; it does not absorb the earlier path ledger. |
| S12(3) | PASS | Authority parsing rejects explicit port `0`, including zero-padded forms, before remote request handling. | No E2E or full lifecycle run. |

S09 here covers the security static-boundary subset. Release-maintenance S09
rows remain in the release ledger. S12(1) and S12(3) are request-boundary
rows; S12(2) remains the earlier contained-path disposition.

## Evidence and verification limits

Focused evidence is recorded permanently in:

- `tests/eslintAmbientProgram.test.ts`
- `tests/eslintArtifactIo.test.ts`
- `tests/doctorCommand.test.ts`
- `server/routes/__tests__/stream.test.ts`
- `server/middleware/__tests__/hostGuard.test.ts`
- `.github/pr168-review-dispositions.md`

Focused unit and integration checks for this branch are recorded in the
permanent PR168 ledger. No E2E, lifecycle, live provider, CI, publish, or
native Windows/macOS completion result is claimed here. Root owns aggregate
full checks, stack propagation, and final integration review.

The 154/154 number means the source findings are accepted. It does not mean
that every delivery PR is merged or that the final aggregate tree has passed
its checks.
