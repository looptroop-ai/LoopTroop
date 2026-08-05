# Operations Guide

> [!IMPORTANT]
> **TL;DR** — Covers startup maintenance, runtime storage, API auth and health surfaces, OpenCode logs, project-local Git hygiene, worktree cleanup, diagnostics, and local troubleshooting.

This guide covers the parts of LoopTroop you deal with after the first run: startup maintenance, runtime storage, project-local Git hygiene, worktree cleanup, diagnostics, and common local service issues.

## 1. Quick Reference

| Task | Start here |
| --- | --- |
| Start the full local stack | `npm run dev` |
| Start once with dependency/audit maintenance | `LOOPTROOP_DEV_MAINTENANCE=1 npm run dev` |
| Skip only the local OpenCode CLI upgrade | `LOOPTROOP_DEV_SKIP_OPENCODE_UPGRADE=1 npm run dev` |
| Inherit your external OpenCode permission mode | `LOOPTROOP_OPENCODE_PERMISSION_MODE=inherit npm run dev` |
| Share the dashboard on a trusted local network | `npm run dev --lan` |
| Print full managed OpenCode DEBUG logs in the terminal | `npm run dev --opencode-logs=all` |
| Force all startup maintenance now | `LOOPTROOP_DEV_FORCE_MAINTENANCE=1 npm run dev` |
| Diagnose slow UI or ticket refresh stalls | `npm run diagnose:stall` |
| Clean tracked LoopTroop runtime paths from a project | `git rm --cached -r .looptroop` inside the attached project |

## 2. Runtime Storage

LoopTroop deliberately separates app-level state from project-level runtime state.

| Location | Contents | Notes |
| --- | --- | --- |
| `~/.config/looptroop/app.sqlite` | App settings, profiles, and attached-project registry | Override with `LOOPTROOP_CONFIG_DIR` or `LOOPTROOP_APP_DB_PATH` |
| `<project>/.looptroop/db.sqlite` | Project tickets, phase artifacts, attempts, sessions, status history, and error occurrences | Project-local operational database |
| `<project>/.looptroop/worktrees/<ticket>/` | Ticket-owned Git worktree and `.ticket/**` runtime artifacts | One worktree per ticket |
| `<ticket-worktree>/.ticket/runtime/` | Execution logs, stream state, locks, session records, temporary files, and state projection | Preserved or cleaned according to ticket outcome and cleanup choice |
| `<repo>/tmp/dev-preflight-report.json` | Last `npm run dev` preflight result: dependency sync, audit remediation, OpenCode upgrade, and install checks | Rebuilt on successful dev preflight; safe to delete |
| `<repo>/tmp/dev-maintenance-state.json` | Daily maintenance timestamps and invalidation bookkeeping for dependency sync, audit remediation, and OpenCode upgrade | Lets normal startup defer already-run daily maintenance until relevant inputs change |
| `~/.local/share/opencode/log/` | Default local OpenCode log directory | Used for managed OpenCode DEBUG logs and generic provider-error enrichment unless `LOOPTROOP_OPENCODE_LOG_DIR` points elsewhere |

LoopTroop adds `/.looptroop/` and `/.ticket/` to the repository-local `.git/info/exclude` file when a project is attached. That keeps project-level runtime state and ticket-local artifacts out of normal Git status without modifying the project's committed `.gitignore`.

The `tmp/*.json` maintenance files are repository-local helpers, not durable source-of-truth data. Removing them only causes LoopTroop to regenerate them on the next relevant run.

## 3. Startup Maintenance

`npm run dev` starts the frontend, backend, docs server, and OpenCode watcher stack.

### Preflight responsibilities

Before those services launch, LoopTroop runs a dev preflight that:

- prints immediate progress for bootstrap checks, daily maintenance, stale-process cleanup, and port availability so startup does not appear stalled during slower checks
- restores missing local tooling with `npm ci` when dependencies need to be restored, then verifies required local dev binaries
- checks direct dependencies against npm publish metadata (only when maintenance is opted in)
- previews stale direct dependencies with npm's normal peer resolver and updates only compatible stable releases that are newer than the current installed version and at least 7 days old
- holds newer releases that are still inside that 7-day delay or conflict with the current peer dependency graph; automatic maintenance never retries with `--force` or `--legacy-peer-deps`
- previews `npm audit fix` lockfile changes with the same peer resolver, recognizes npm's expected exit code when unresolved findings remain, and runs the fix only when the proposal is compatible and every proposed npm package version has passed the same 7-day delay
- retries temporary npm audit transport or malformed-response failures once, then defers that audit without stamping it complete so an external registry outage cannot prevent the application or a boot-enabled service from starting
- upgrades the local `opencode` CLI to the latest available version when the binary is installed (only when maintenance is opted in)
- checks and reclaims only stale LoopTroop-owned processes on configured ports
- refuses to kill unrelated port occupants and reports which process still owns the conflicting port
- writes the last successful preflight snapshot to `tmp/dev-preflight-report.json`
- prints one concise startup summary by default, including package gate notes, updated package names, previous and new versions, held package names, and next eligible times

### OpenCode, auth, and service bootstrap

`npm run dev` also resolves the local OpenCode server endpoint before the dev services launch:

- **Reuse:** if the configured address is already responding to authenticated requests, `npm run dev` reuses that running instance.
- **Explicit base URL guard rail:** if an explicitly configured local `LOOPTROOP_OPENCODE_BASE_URL` is occupied by a non-OpenCode process, startup stops and asks you to choose another URL. Automatic port fallback only applies to the default local address.
- **Port fallback:** if the default OpenCode port (`4096`) is occupied by a non-OpenCode process, `npm run dev` scans for the next free port and starts OpenCode there instead.
- **Permission mode:** when `npm run dev` starts the managed OpenCode server, it sets `OPENCODE_PERMISSION='"allow"'` by default. LoopTroop also applies a complete ordered permission policy to every session before each prompt, explicitly allowing `external_directory` and `doom_loop` for trusted unattended work before applying any phase-specific restrictions. If OpenCode still emits an unexpected permission request, LoopTroop answers it automatically with `always`; a failed reply aborts the session immediately so normal retry or blocked-error handling can proceed instead of leaving the ticket idle. Set `LOOPTROOP_OPENCODE_PERMISSION_MODE=inherit` to leave any existing OpenCode permission environment untouched; session-level policies still apply.
- **LAN sharing:** start with `npm run dev --lan` to expose the frontend and docs servers on a trusted local network. The startup summary prints LAN URLs and a QR code for mobile testing, while backend API and OpenCode remain loopback-only behind the Vite dev proxy. Under WSL, LoopTroop does not start a relay process; it prints a Windows Administrator PowerShell `netsh interface portproxy` + firewall one-liner, matching cleanup commands, and a Windows-side self-test instead. If the matching Windows network profile is Public, LoopTroop also prints the exact `Set-NetConnectionProfile ... -NetworkCategory Private` fix command. Router/AP client isolation still has to be checked manually if Windows-side self-tests pass but other devices cannot connect.
- **Verbose OpenCode logs:** start with `npm run dev --opencode-logs=all` to print full managed OpenCode DEBUG logs in your terminal via `--print-logs --log-level DEBUG`. Managed logs are also written to the normal OpenCode log directory. This only affects servers started by the dev launcher; reused, remote, or mock OpenCode servers keep their own logging configuration. Treat DEBUG output as sensitive local troubleshooting data because it may include request or provider details.
- **Provider error enrichment:** if OpenCode reports only `Provider returned error`, LoopTroop scans the newest local OpenCode logs for the same session and records the exact sanitized provider cause when available. By default it looks in `~/.local/share/opencode/log/`; set `LOOPTROOP_OPENCODE_LOG_DIR` when reusing an external OpenCode server whose logs live elsewhere.
- **Ephemeral auth:** if `OPENCODE_SERVER_PASSWORD` is not set and a new local OpenCode server is about to start, `npm run dev` generates a random credential and sets `OPENCODE_SERVER_USERNAME` to `opencode`. This credential is propagated automatically to all child processes — backend and watcher — for the duration of the session.
- **Ephemeral API token:** if `LOOPTROOP_API_TOKEN` is not set, `npm run dev` generates one for the backend and Vite dev proxy so local same-origin `/api/*` calls are protected without embedding the token in the frontend bundle.

Normal `npm run dev` is verify-only: it never rewrites `package.json`, the lockfile, or a globally installed CLI. Dependency sync, npm audit remediation, and the OpenCode CLI upgrade are opt-in through `LOOPTROOP_DEV_MAINTENANCE=1`, or run explicitly with `npm run deps:sync`, `npm run audit:remediate`, and `npm run opencode:upgrade`. When opted in, that expensive networked maintenance work is daily-gated through `tmp/dev-maintenance-state.json`: each task runs on the first local dev start of the day, then runs again only if its relevant inputs change later that day. Preflight always still runs `npm ci` when the installed tree has drifted from the lockfile, which is deterministic and introduces no new versions.

Audit failure handling distinguishes external availability from local integrity. Registry timeouts, connection errors, rate limits, service errors, and malformed audit responses are retried once and then reported as deferred without blocking normal startup. Because a deferred audit is not recorded as successful, the next eligible startup retries it. Local failures such as an unreadable lockfile, an invalid staged lockfile, or a failed dependency application remain startup-blocking. The standalone `npm run audit:remediate` command remains strict and exits unsuccessfully for either category so explicit maintenance and automation can detect incomplete work.

The 7-day release delay applies to direct npm package updates selected by dependency sync and to all npm package versions proposed by audit remediation. Before changing the live checkout, LoopTroop resolves proposed package and lock files in a temporary directory, then validates the result with `npm ci --dry-run` under npm's normal peer-dependency rules. Incompatible direct releases are held while compatible candidates can still proceed; related candidates are reconsidered together so a supporting package can unlock a previously incompatible update. If npm rejects a registry-hosted tarball as a remote URL during a direct-update preview, LoopTroop holds only the triggering direct update and retries it on the next daily check; it never loosens npm's remote-package policy. A rejected URL from any host other than the configured npm registry remains an error. Audit remediation is all-or-nothing: if npm rejects the proposed graph, or proposes any package version that is too fresh or whose publish time cannot be verified, LoopTroop holds the entire `npm audit fix` attempt. Every held-package detail states its specific cause: an incomplete 7-day release-safety period with the exact eligibility timestamp, unavailable npm metadata, a non-comparable version, an incompatible peer dependency with npm's exact constraint, or a registry-tarball policy hold. Accepted proposals are applied with `npm ci`; if that fails, the previous package files and dependency graph are restored. Automatic maintenance never bypasses npm conflicts with `--force` or `--legacy-peer-deps`. OpenCode is exempt only from the release-age delay: the local OpenCode CLI and direct `@opencode-ai/sdk` package update immediately when their normal maintenance path runs, while npm peer compatibility remains mandatory.

## 4. Maintenance Commands

Run the individual maintenance steps directly when you need tighter control:

```bash
npm run deps:sync
npm run audit:remediate
npm run opencode:upgrade
```

Use one-run startup flags when you want to change `npm run dev` behavior:

```bash
LOOPTROOP_DEV_MAINTENANCE=1 npm run dev
LOOPTROOP_DEV_MAINTENANCE=1 LOOPTROOP_DEV_SKIP_DEPS=1 npm run dev
LOOPTROOP_DEV_MAINTENANCE=1 LOOPTROOP_DEV_SKIP_OPENCODE_UPGRADE=1 npm run dev
LOOPTROOP_DEV_MAINTENANCE=1 LOOPTROOP_DEV_FORCE_MAINTENANCE=1 npm run dev
npm run dev --lan
npm run dev --opencode-logs=all
```

These commands update the same maintenance timestamps used by opted-in startup gating. `deps:sync` and `audit:remediate` still respect `LOOPTROOP_DEV_SKIP_DEPS=1`; `opencode:upgrade` still respects `LOOPTROOP_DEV_SKIP_OPENCODE_UPGRADE=1`. The `LOOPTROOP_DEV_SKIP_*` and `LOOPTROOP_DEV_FORCE_MAINTENANCE` flags only affect `npm run dev` when maintenance is opted in, since it is otherwise skipped entirely.

## 5. Scripts Reference

All scripts are available with `npm run <name>`.

### Development Stack

| Script | Purpose |
| --- | --- |
| `dev` | Full stack: frontend, backend, OpenCode watcher, and dev preflight. **Standard start command.** In-app documentation links point at the hosted docs site; set `LOOPTROOP_DEV_DOCS=1` to also run a local VitePress server. |
| `dev:app` | Frontend and backend only — no docs server, no OpenCode watcher. Use when OpenCode is already running externally and docs are not needed locally. Note: this bypasses the `predev` preflight (the `predev` hook only runs for `dev`), so dependency sync, npm audit, OpenCode upgrade, port-conflict cleanup, and the auto-generated `OPENCODE_SERVER_PASSWORD` / `LOOPTROOP_API_TOKEN` are skipped — set those yourself when needed. |
| `dev:frontend` | Vite dev server only. |
| `dev:backend` | Backend Hono API server only. |
| `dev:opencode` | OpenCode watcher only. |
| `docs:dev` | VitePress docs server only. |

### Build And Preview

| Script | Purpose |
| --- | --- |
| `build` | Type-check and produce a production frontend bundle (`tsc -b && vite build`). |
| `preview` | Serve the last production build locally for inspection. |
| `docs:build` | Build the static VitePress docs site. |
| `docs:preview` | Serve the last static docs build locally. |
| `site:build` | Build the docs site and assemble the static marketing site bundle. |

The frontend dev server pre-optimizes its complete declared browser dependency set before serving the app and disables browser storage of dev resources. This makes a process restart safe even when the browser restores a previously open LoopTroop tab: the restored document cannot retain an old React dependency graph while a lazy ticket workspace loads from the new process. The dependency policy is checked against production imports in the localized Vite configuration test.

### Operational Tools

| Script | Purpose |
| --- | --- |
| `predev` | Automatic dev preflight hook that runs before `npm run dev`. Usually invoked through `npm run dev`, not by hand. |
| `deps:sync` | Preview direct dependency updates with npm peer resolution, apply compatible releases with `npm ci`, hold conflicts, then refresh the daily-maintenance stamp. |
| `audit:remediate` | Preview the gated npm audit remediation in isolation, hold incompatible proposals, and apply accepted lockfiles with `npm ci`. |
| `opencode:upgrade` | Run only the OpenCode CLI upgrade step, then refresh the daily-maintenance stamp. |
| `diagnose:stall` | Generate a runtime diagnostics report under `tmp/diagnostics/`. |

### Tests And Code Quality

| Script | Purpose |
| --- | --- |
| `test` | Run all test projects once and exit. |
| `test:client` | Client tests only (`client-dom` and `client-node` projects). |
| `test:server` | Server tests only (`server-pure` and `server-integration` projects). |
| `test:watch` | Run all tests in watch mode. Useful during active development. |
| `typecheck` | Type-check the full project with `tsc --noEmit`. |
| `lint` | Lint the full project with ESLint. |

`vitest.config.ts` defines four test projects:

- **`client-dom`** — React component tests that require a JSDOM environment
- **`client-node`** — client-side logic tests that do not need a DOM
- **`server-pure`** — server unit tests with no I/O or database
- **`server-integration`** — server integration tests running against a real local SQLite instance

Run `test:client` and `test:server` separately when you only want to validate one layer. Run `test` to validate both together.

### Database Schema Tools

| Script | Purpose |
| --- | --- |
| `db:generate` | Generate app DB migration artifacts for external tooling review. Alias for `db:generate:app`; normal app schema changes still need `server/db/schema.ts` and runtime bootstrap updates in `server/db/init.ts`. |
| `db:generate:app` | Generate app DB migration artifacts from the configured app database target. Verify output against `server/db/schema.ts` before committing. |
| `db:generate:project` | Generate project DB migration artifacts from `LOOPTROOP_PROJECT_DB_PATH`. |
| `db:push` | App DB push command retained for ad-hoc local experiments only; do not use as the normal app schema-change workflow. |
| `db:push:app` | Same as `db:push`; avoid for normal app schema changes because runtime bootstrap owns app DB creation/evolution. |
| `db:push:project` | Push schema changes directly to the project database target from `LOOPTROOP_PROJECT_DB_PATH`. |

The app database is runtime-bootstrapped by `server/db/init.ts`. The committed migration directory is not the source of truth for live app startup. Project DB work should use the explicit project scripts.

## 6. Environment Variables

| Variable | Purpose |
| --- | --- |
| `LOOPTROOP_FRONTEND_PORT` | Override frontend port; also drives the default frontend origin when `LOOPTROOP_FRONTEND_ORIGIN` is unset |
| `LOOPTROOP_FRONTEND_ORIGIN` | Override full frontend origin URL, for example `http://my-server:5173`; a valid explicit origin takes precedence over `LOOPTROOP_FRONTEND_PORT`, while an invalid value falls back to the default origin |
| `LOOPTROOP_BACKEND_HOST` | Backend bind host; defaults to `127.0.0.1` |
| `LOOPTROOP_BACKEND_PORT` | Override backend port |
| `LOOPTROOP_ALLOW_REMOTE_API=1` | Required before binding the backend to a non-loopback host; remote binds still require `LOOPTROOP_API_TOKEN` |
| `LOOPTROOP_ALLOW_UNAUTHENTICATED=1` | Permit unauthenticated `/api/*` access only when no `LOOPTROOP_API_TOKEN` is configured; intended for local-only troubleshooting, never for use together with `LOOPTROOP_ALLOW_REMOTE_API=1` |
| `LOOPTROOP_API_TOKEN` | Optional token required by `/api/*`; `npm run dev` generates an ephemeral value when unset and the Vite dev proxy forwards it server-side |
| `LOOPTROOP_TRUST_PROXY=1` | Trust `x-forwarded-for` / `x-real-ip` for rate-limit buckets; leave unset unless a trusted proxy owns those headers |
| `LOOPTROOP_ENABLE_DEV_EVENT=1` | Enable the development-only ticket event injection route when paired with `LOOPTROOP_DEV_EVENT_TOKEN` |
| `LOOPTROOP_DEV_EVENT_TOKEN` | Required secret for the dev-event route when it is enabled |
| `LOOPTROOP_DEV_DOCS=1` | Run a local VitePress docs server as part of `npm run dev`; omitted by default so in-app links use the hosted docs site |
| `LOOPTROOP_DOCS_PORT` | Override the local docs port; only relevant with `LOOPTROOP_DEV_DOCS=1` |
| `LOOPTROOP_DOCS_ORIGIN` | Override full docs origin URL, for example `http://localhost:5174`; defaults to the hosted documentation site |
| `LOOPTROOP_DEV_HOST` | Direct watcher fallback for LAN sharing; set to `1`, `true`, `0.0.0.0`, or a specific host/IP when not launching through `npm run dev --lan` |
| `LOOPTROOP_OPENCODE_BASE_URL` | Point LoopTroop at a specific OpenCode server |
| `LOOPTROOP_CONFIG_DIR` | Override the app config directory |
| `LOOPTROOP_APP_DB_PATH` | Override the app database path directly |
| `LOOPTROOP_PROJECT_DB_PATH` | Project database target for explicit Drizzle project DB commands |
| `LOOPTROOP_DEV_MAINTENANCE=1` | Opt in to the daily dependency sync, npm audit remediation and OpenCode CLI upgrade during `npm run dev`; these are skipped by default because they rewrite `package.json`, the lockfile, or a globally installed CLI |
| `LOOPTROOP_DEV_SKIP_DEPS=1` | Skip automatic dependency sync and audit remediation during `npm run dev` |
| `LOOPTROOP_DEV_SKIP_OPENCODE_UPGRADE=1` | Skip the automatic local OpenCode CLI upgrade during `npm run dev` |
| `LOOPTROOP_DEV_FORCE_MAINTENANCE=1` | Bypass the once-per-day maintenance gate and force all startup maintenance checks now |
| `LOOPTROOP_OPENCODE_MODE` | Set to `mock` to use the mock adapter instead of the real SDK adapter |
| `LOOPTROOP_OPENCODE_PERMISSION_MODE` | Set to `inherit` to skip setting `OPENCODE_PERMISSION='"allow"'` when `npm run dev` starts a managed OpenCode server; by default LoopTroop sets permissive mode automatically for local trusted sessions |
| `LOOPTROOP_OPENCODE_LOGS=all` | Direct watcher fallback for `npm run dev:opencode`; starts a managed OpenCode server with `--print-logs --log-level DEBUG` when the watcher actually launches OpenCode |
| `LOOPTROOP_OPENCODE_LOG_DIR` | Optional OpenCode log directory used to enrich generic provider errors from an external or nonstandard OpenCode server; default lookup is `~/.local/share/opencode/log/` |
| `CHOKIDAR_USEPOLLING` | Governs both the frontend (Vite) and backend file watchers. Leave unset for auto-detection (native watching everywhere except WSL on a Windows-mounted drive). Set to `1` to force polling or `0` to force native watching |
| `OPENCODE_SERVER_USERNAME` | Basic auth username for the local OpenCode dev server; defaults to `opencode` when `OPENCODE_SERVER_PASSWORD` is also set |
| `OPENCODE_SERVER_PASSWORD` | Basic auth password for the local OpenCode dev server; auto-generated as an ephemeral random credential by `npm run dev` if not set and a new local OpenCode server is about to start |

Default local service addresses:

| Service | Address |
| --- | --- |
| Frontend | `http://localhost:5173` |
| Backend | `http://127.0.0.1:3000` |
| Docs | `https://www.looptroop.ovh/docs/` (hosted; `LOOPTROOP_DEV_DOCS=1` serves `http://localhost:5174/docs/` locally) |
| OpenCode | `http://127.0.0.1:4096` |

Default port resolution and origin building are implemented in `shared/appConfig.ts`, which validates environment variables and provides fallback defaults for all four services.

When `LOOPTROOP_FRONTEND_ORIGIN` is not explicitly set, LoopTroop derives the frontend origin from `LOOPTROOP_FRONTEND_PORT`, defaulting to `http://localhost:5173`. If `LOOPTROOP_FRONTEND_ORIGIN` is set but cannot be parsed as a URL origin, LoopTroop ignores it and falls back to that derived default.

LoopTroop accepts API tokens through either `x-looptroop-token` or `Authorization: Bearer <token>`. For `/api/stream` only, the browser `EventSource` fallback may also send `?apiToken=...` because native `EventSource` requests cannot attach custom headers.

### Useful Health Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Backend availability, timestamp, and uptime |
| `GET /api/health/opencode` | OpenCode availability, version, and currently visible model list |
| `GET /api/health/startup` | Startup storage/runtime snapshot used by the UI restore popup and mounted-drive warning surfaces |
| `POST /api/health/startup/restore-notice/dismiss` | Persist dismissal of the one-time startup restore popup |

## 7. API Rate Limits

The backend applies a global per-client rate limit to API routes. Read requests, normal write actions, and UI-state autosaves use separate buckets so frequent draft saves do not exhaust the workflow-action budget. Defaults are 200 reads/minute, 120 normal writes/minute, and 300 autosaves/minute per client. The lightweight `GET /api/health` liveness probe is exempt from the read bucket so the UI can distinguish rate limiting from an unreachable backend; authentication still applies. If a client exceeds another limit, the API returns `429` with a `Retry-After` response header in seconds. Wait for that interval before retrying requests or refreshing aggressively.

Forwarded client IP headers are ignored unless `LOOPTROOP_TRUST_PROXY=1` is set. This keeps local clients from bypassing limits by spoofing `x-forwarded-for`.

## 8. Project Git Hygiene

If `.looptroop` was already tracked before the project was attached, ticket startup is blocked with `INIT_LOOPTROOP_TRACKED`. This prevents nested or stale LoopTroop worktree data from being checked out into every new ticket worktree.

Clean that repository from the attached project root:

```bash
git rm --cached -r .looptroop
git commit -m "Stop tracking LoopTroop runtime data"
```

This removes LoopTroop runtime paths from the Git index without deleting the local runtime files from disk.

After cleanup, `git status --short .looptroop` should not show tracked `.looptroop` entries. Runtime files may still exist locally, but they should be ignored by the repo-local exclude. Ticket worktree artifacts under `.ticket/**` are also ignored locally and excluded from future bead commits; they remain available to LoopTroop but are not intended for target repository branches.

Other ticket initialization errors from the Git hygiene check:

- `INIT_LOOPTROOP_EXCLUDE_FAILED` — LoopTroop could not write the `.looptroop/` exclusion to `.git/info/exclude`. Check that the project's `.git` directory is writable.
- `INIT_LOOPTROOP_TRACKED_CHECK_FAILED` — The `git ls-files` check itself failed. Verify that the attached project path is a valid, accessible Git repository.

## 9. Worktree Disk Cleanup

Over time `.looptroop/worktrees/` can grow large as completed and canceled tickets leave behind code checkouts, execution logs, and generated file artifacts.

Use the UI cleanup flow:

1. Open **Settings -> Projects** and click **Edit** on the project you want to clean up.
2. Click **Free Disk Space...** at the bottom-left, next to **Delete Project**.
3. Click **Calculate Size** to see how much space can be freed.
4. Click **Delete Worktrees** to remove worktrees for completed and canceled tickets.

**Deleted:** temporary directories at `.looptroop/worktrees/<ticket>/` for tickets in the Completed or Canceled column, including code checkouts, execution logs, and AI-generated file artifacts.

LoopTroop restores owner removal permissions before deleting each eligible worktree. This handles project-agnostic read-only outputs such as dependency caches, downloaded toolchains, generated directories, and language package caches without requiring ecosystem-specific cleanup settings. Symlinks are removed without changing or traversing their external targets. Files owned by another operating-system user or protected by ACLs, immutable flags, or equivalent platform controls may still require the underlying ownership or protection to be corrected.

**Preserved:**

- project source code and normal repository files
- active, queued, and draft ticket worktrees
- ticket records in the dashboard, including title, description, and status

## 10. Diagnostics

If the UI feels slow, tickets disappear after refresh, or the app appears to stall, run the diagnostic command while `npm run dev` is still running:

```bash
npm run diagnose:stall
```

The report is saved as `tmp/diagnostics/runtime-stall-<timestamp>.log` and includes endpoint latency, backend/frontend/OpenCode activity, trend-wide whole-system CPU/RSS/I/O consumers, pressure-stall metrics, SQLite/WAL state, attached project health, active sessions, Git responsiveness, and optional focused ticket runtime artifact sizing.

Useful options:

```bash
npm run diagnose:stall -- --sample-ms 5000
npm run diagnose:stall -- --timeout-ms 8000
npm run diagnose:stall -- --trend-ms 0
npm run diagnose:stall -- --trend-ms 120000 --trend-interval-ms 1000
npm run diagnose:stall -- --ticket-path /path/to/worktree/.ticket
```

For the full diagnostics guide, including the runtime report plus blocked-error and structured-retry surfaces, see [Runtime Diagnostics](diagnostics.md).

## 11. OpenCode Reachability

Symptoms:

- the model list in the UI is empty
- ticket logs show connection errors
- phases that need a model block before drafting, setup, or execution

Checks:

When using `npm run dev`, port resolution and basic auth are handled automatically. The checks below apply when OpenCode is still unreachable after startup or when running the backend outside of `npm run dev`.

1. Ensure OpenCode is running: `opencode serve`.
2. Ping the backend health endpoint: `curl http://127.0.0.1:3000/api/health/opencode`. If you configured `LOOPTROOP_API_TOKEN`, include `-H "X-LoopTroop-Token: $LOOPTROOP_API_TOKEN"`.
3. If OpenCode is on a non-default port, set `LOOPTROOP_OPENCODE_BASE_URL`, for example `export LOOPTROOP_OPENCODE_BASE_URL=http://127.0.0.1:4097`.
4. If you started OpenCode outside of `npm run dev`, ensure `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME` match the values LoopTroop is using. A credential mismatch causes silently failed requests.
5. If LoopTroop only records generic provider failures, inspect the newest files under `~/.local/share/opencode/log/` or point `LOOPTROOP_OPENCODE_LOG_DIR` at the external server's log directory so LoopTroop can enrich those errors.

## 12. Watcher and WSL Performance Notes

Both the frontend (Vite) and backend watchers prefer native file watching on normal local filesystems — Linux (including a remote VPS), macOS, and native Windows all use fast native OS file-system events by default. Polling is only enabled automatically when it is genuinely required: a WSL runtime whose workspace lives on a Windows-mounted drive such as `/mnt/c/...`, where native watching is unreliable.

> [!NOTE]
> Earlier versions forced polling for the frontend on every platform, which wasted CPU and added refresh latency on native Linux/macOS/Windows (most noticeable on remote hosts). Both watchers now share a single OS-agnostic decision (`resolveWatchPollingDecision()` in `shared/wslPerformance.ts`) so native watching is used everywhere unless polling is actually needed.

If your environment still misses file changes, force polling for the run (applies to both watchers):

```bash
CHOKIDAR_USEPOLLING=1 npm run dev
```

You can also force native watching off a mounted drive with `CHOKIDAR_USEPOLLING=0`; an explicit value always overrides the auto-detection in either direction.

### Windows-Mounted Drive Warning (WSL Users Only)

If you run LoopTroop inside Windows Subsystem for Linux (WSL), ensure that both the LoopTroop installation directory and your attached target projects reside on the native Linux file system (e.g., under `/home/username/...` or another path in `\wsl$`).

> [!WARNING]
> **Avoid Windows-mounted drives (like `/mnt/c/...` or `/mnt/d/...`) in WSL.**
>
> Keeping the LoopTroop codebase or attached projects on Windows-mounted drives severely degrades disk I/O performance. This slows down Git operations, codebase scanning, and test execution. It also disables native file-watching, forcing a fallback to chokidar polling (`CHOKIDAR_USEPOLLING=1`). For optimal performance, always store your workspaces and repositories inside the Linux home directory.

The path detection logic is implemented in `shared/wslPerformance.ts`, which exports `isWslWindowsMountPath()` to identify Windows-mounted paths, `resolveWatchPollingDecision()` to choose native watching vs. polling for both the frontend and backend watchers, and `buildWslAppMountedDriveWarning()` / `buildWslProjectMountedDriveWarning()` to generate targeted performance warnings.

When LoopTroop detects these mounted-drive paths, it surfaces the warning in two places: the startup UI warns when the LoopTroop app itself lives on a Windows-mounted drive, and project attachment warns when the target repository is mounted there.

## 13. Audit Warnings

`npm audit --omit=dev` should be clean. A full `npm audit` can still report dev-only moderate findings through transitive dev-server tooling:

- `drizzle-kit` stable still depends on deprecated `@esbuild-kit/*`, which brings an older `esbuild`. The upstream issue is tracked here: [drizzle-team/drizzle-orm#3067](https://github.com/drizzle-team/drizzle-orm/issues/3067).
- `vitepress` stable still ships its own older Vite line. The current tracked upstream-stable advisory is [GHSA-p9ff-h696-f583](https://github.com/advisories/GHSA-p9ff-h696-f583).
- `mermaid` stable still pulls `uuid <14`; the current tracked upstream-stable advisory is [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

Do not run `npm audit fix --force` as routine maintenance for these warnings. The current forced fix path proposes a breaking `drizzle-kit` downgrade and does not represent a safe application hardening change.

## Related Docs

- [Getting Started](getting-started.md)
- [System Architecture](system-architecture.md)
- [Runtime Diagnostics](diagnostics.md)
- [OpenCode Integration](opencode-integration.md)
