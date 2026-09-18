# PR168 review dispositions

## Third review

- Greptile `4046573568` identified a valid P1 race: a stale cancellation cleanup
  could await an OpenCode question rejection while a CODING Retry opened a new
  question, then delete the shared timer map. `clearTicketWindows` now accepts
  an ownership predicate, checks it around every await, and refuses to delete
  newer timer state; the runner binds that predicate to the cancellation actor
  and marker. A regression in the question-window suite covers the hand-off.

- PR164's shutdown admission fence also applies to reserved SSE slots: a refused
  client registration now makes reservation fail immediately. The merge retains
  PR168's transport abort and admission cleanup, plus the public-origin startup
  guard. Runtime, stream, broadcaster, process-tree and Git staging regressions
  pass together (134 tests); touched-file ESLint passes.
- `5726616385` and `5726685710` are correct. Following the owner's choice,
  daemon startup rejects a public HTTPS origin without remote API opt-in before
  taking its lock. Embedded runtime startup applies the same check before
  acquiring resources. `tests/startDaemon.test.ts` and
  `tests/createRuntime.test.ts` cover rejection and supported remote mode.
- `5727031386` is correct. The static launcher rule now recognizes computed
  literal properties for both `promisify` and its child-process argument.
  `tests/eslintAmbientProgram.test.ts` exercises both separately and together.
- The bearer/CORS observation is a documentation clarification, not permission
  to weaken the origin guard. Token-only scripts without an Origin remain
  supported; a browser's unconfigured Origin remains forbidden even with a
  bearer token. README, CONTRIBUTING, host-guard comments and environment
  examples now make that distinction explicit.
- Late-command runtime shutdown and the Windows trailing-space fixture remain
  shared PR164 fixes, propagated through PR166. No duplicate implementation or
  native Windows pass is claimed here. Review-service limits and upstream
  deprecation warnings are recorded in the root CI review, not source failures.

## Refreshed review results

`5713686595` is a skipped-review notice. Updated `5713715366` confirms the filesystem-loader fix and identifies the final-symlink issue fixed in the shared helper and merged from PR164 through PR166. `5713735152` reports no new finding; `5717638852` reports no Codacy findings. Sonar `5717809363` identified duplicated selector objects, now consolidated with identical selectors and regression coverage. Updated inline `4036384881` confirms that synchronous handshake/replay queuing prevents the claimed interleaving; failed activation cleanup is covered separately. The explicit product decision now configures one canonical HTTPS public origin for remote browser sessions; plain-HTTP remote access stays bearer-only, forwarded headers remain untrusted, and the reverse-proxy Host requirement for no-Origin requests is tested below.

This ledger records every captured PR comment and review for the security-boundaries
change. “Held” means the comment depends on the explicit remote-origin product
choice; it is not silently treated as permission to trust forwarded headers or to
weaken cookie checks. Cross-part items name the owning PR so the same fix is not
implemented twice.

## Comment dispositions

| Comment ID | Disposition | Evidence or decision |
| --- | --- | --- |
| 5713686303 | Informational | Sourcery’s guide contained no finding; no code action was required. |
| 5713686595 | Informational | CodeRabbit skipped review; no finding or requested behavior was supplied. |
| 5713687388 | Informational | Codex’s summary is represented by the individual rows below; it introduced no separate issue. |
| 5713695328 | Informational | Qodo’s summary introduced no actionable finding beyond its later bug report. |
| 5713697837 | Correct | Codacy reported zero issues; no additional change was indicated. |
| 5713715366 | Mixed | Its raw-`require` filesystem concern is fixed by the static selectors and permanent probes. The final-symlink concern is owned by PR164’s shared reject-final-symlink fix. Reverse-proxy browser access is fixed through the explicit public-origin contract, with forwarded headers still untrusted. |
| 5713717172 | Correct observation, stack-owned remediation | The Windows failures were real path/error-message assertions in atomicIO, hook validation, and final-test areas. Their fixes belong to the filesystem/CLI stack; this branch does not suppress the tests or duplicate those changes. |
| 5713728007 | Correct | Sonar reported a passed quality gate with zero new issues and zero new duplication. |
| 5713735152 | Fixed | `opendir` and `opendirSync` are now in the raw filesystem denylist; `tests/eslintArtifactIo.test.ts` keeps the operation set covered. |
| 5714159520 | Mixed | Namespace destructuring is rejected and probed in `tests/eslintAmbientProgram.test.ts`; doctor probes now use `createChildEnvironment`; the abort-during-handshake and zero-port mutation cases are permanent tests; the evidence ledger no longer relies on session-local paths. Reverse-proxy HTTPS behavior is fixed through the configured public-origin contract. |
| 5714180530 | Mixed | Template loaders, `getBuiltinModule`, nested `fs.promises`, raw requires, re-exports, and TypeScript import-equals forms are covered by selectors and probes. The two maintenance-script `stripAnsi` copies belong to PR163. Empty trailing authority ports are an intentional existing default-port contract, covered by host-guard tests. Artifact directory traversal is metadata-only and does not read or follow file content; it remains within its documented boundary. Token-only scripts remain supported, but bearer authentication does not exempt a browser's supplied Origin from validation; cookie access uses the explicit public-origin contract. |
| 5714233396 | Correct | Copilot reported no confirmed finding. |
| 5714283924 | Mixed | The S01–S04 “missing” observation is stale: those executable-path changes are implemented and covered by PR163, so PR168 cross-references them rather than duplicating them. S12(2) is owned by PR164. The `usesAmbientCookie` broadening is intentional cookie protection and remains documented. The claimed SSE event-drop window is not reachable between synchronous reservation, replay collection, and activation; the existing replay-before-live test proves ordering, while this branch fixes the separate early-activation promise rejection path. IPv6 zone IDs fail closed, and metadata-only `lstat` traversal is intentional. |
| 5714287130 | Fixed | The product decision is now explicit: `LOOPTROOP_PUBLIC_ORIGIN`/`publicOrigin` accepts one canonical HTTPS origin, remote mode without it rejects ambient cookies and browser exchange, and bearer-token callers remain supported. Secure cookies and Fetch Metadata checks remain enabled. |
| 5714330835 | Fixed | `process.getBuiltinModule` for `child_process` and `module` is rejected for literal and static-template arguments and covered by ambient probes. |
| 5714615014 | Mixed | Built-in loading, ordinary alias/re-export forms, and early SSE write settlement are fixed with regression coverage. Variable-source `import(value)` and arbitrary data-flow aliases remain outside the deliberately static rule’s contract. |
| 5714879636 | Fixed with bounded scope | Static template imports, raw filesystem loaders, `getBuiltinModule`, and renamed module loading are rejected and tested. Variable-source loaders remain an explicit non-goal rather than a speculative data-flow framework. |
| 5714893417 | Mixed | Child-process namespace destructuring is rejected and tested. The maintenance-script ANSI duplication is owned by PR163 and is cross-referenced there. |
| 5719159024 | Mixed | Ticket cleanup now aborts the underlying SSE transport before removing admission, and the exported runtime forwards pre-resolved `settings.publicOrigin` while an explicit top-level `null` still wins; wildcard public hosts are rejected. The review's built-in `glob`/`globSync` observation remains a bounded static-policy follow-up because this PR's operation list has no production glob caller and the focused guard intentionally avoids dataflow analysis. |
| 5235076720 | Informational | Amazon Q’s positive review confirmed the request, credential, SSE, and action-ID changes; its claims are supported by the focused tests and rows above. |
| 5235083585 | Mixed | Sourcery’s proposed live-event buffering change is not applicable: reservation, replay collection, and activation are synchronous, and `stream.test.ts` proves replay precedes live delivery. Its real early-activation rejection concern is fixed by observing `initialWrites` with `Promise.allSettled` without delaying cleanup. |
| 5235094413 | Informational | Qodo submitted an empty review; no finding was supplied. |
| 5235109207 | Informational | Greptile submitted an empty review; its separate opendir finding is recorded under comment 5713735152. |
| 4036384881 | Mixed | The asserted general event-drop race is not reachable in the current synchronous reservation/replay/activation sequence; the existing replay-order regression is permanent. The distinct rejected-write-on-activation-loss race is fixed and tested. |
| 4036393833 | Fixed | Raw filesystem `require`, template `require`, `getBuiltinModule`, re-export, and TypeScript import-equals forms are rejected in every scoped boundary; `tests/eslintArtifactIo.test.ts` asserts the exact lines. |
| 4036393840 | Fixed | Reverse-proxy HTTPS support uses the configured public origin without trusting `X-Forwarded-*`. Cookie-bearing Origins must match it exactly; no-Origin cookie requests require the proxy to preserve the public Host, and the backend may remain HTTP internally. |
| 4036393847 | Stack-owned | PR164’s shared contained atomic-write helper now rejects a final symlink without following it; this branch does not add a competing caller-specific mode. |
| 4036406743 | Fixed | `opendir` and `opendirSync` are in the denylist and covered by the filesystem lint boundary’s shared operation list. |

## Cross-part decisions and permanent evidence

- R23’s `ghCredentialEnv` hardening was already present in the initial PR168
  branch (`server/git/push.ts`) with behavioral coverage in
  `server/git/__tests__/push.test.ts`; it is not duplicated here.
- S01–S04 and the maintenance-script ANSI helper consolidation belong to PR163;
  S12(2), final-symlink containment, and related filesystem recovery belong to
  PR164. Their source and tests remain part of the stacked aggregate.
- The static guard evidence is permanent in
  `tests/eslintAmbientProgram.test.ts` and `tests/eslintArtifactIo.test.ts`.
  Runtime evidence is permanent in `tests/doctorCommand.test.ts`,
  `server/routes/__tests__/stream.test.ts`, and
  `server/middleware/__tests__/hostGuard.test.ts`.
- No E2E, full lifecycle, live-provider, or native-platform run is claimed by
  this ledger. Root owns the aggregate full checks and stack propagation.
- The combined local suite exposed a cold ESLint-configuration load exceeding
  the ordinary test budget. Both lint-probe files now initialize their shared
  configuration in bounded setup; assertions retain their normal timeout.
  All twelve boundary probes and touched-file lint pass.
- Cross-PR lint checks cover the reviewed Git-index and quarantine operations:
  exact-index reads use the no-follow opener; quarantine reads use bounded
  descriptor buffers. Their per-file exceptions permit only those operations,
  with regressions retaining unrelated raw-operation bans.
- Remote browser origin behavior is covered by `tests/appSettings.test.ts`,
  `server/middleware/__tests__/hostGuard.test.ts`,
  `tests/sessionAuth.test.ts`, `tests/startDaemon.test.ts`,
  `tests/openCommand.test.ts`, and `server/lib/__tests__/daemonPaths.test.ts`.
  The setting does not publish a loopback daemon by itself; remote browser
  access still requires the existing remote opt-in and API token.
- Sonar's later duplication failure came from repeated selector/message
  objects. The same loader selectors now share one diagnostic mapping; all
  fourteen static-boundary probes pass without excluding source from analysis.
