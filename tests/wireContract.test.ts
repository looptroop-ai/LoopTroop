import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createApp } from '../server/app'
import { doctorCommand } from '../server/cli/doctorCommand'
import type { UpdateStatus } from '../server/lib/updateCheck'
import { SSE_EVENT_TYPES } from '../server/sse/eventTypes'
import { removeTempDir } from '../server/test/tempDir'

/**
 * The three surfaces outside this repository's control.
 *
 * API routes, SSE event names and `doctor --json` check names are read by
 * things that are not this codebase — the frontend, users' scripts, this
 * repository's own installer smokes — and renaming any of them breaks those
 * consumers silently, because a lookup that finds nothing raises no error.
 * `verify:version` was the only tooling enforcing any invariant of this kind;
 * the rest were assumed.
 *
 * So they are written out here by name rather than counted or pattern-matched.
 * Changing one has to be an edit to this file, in the same diff, where a
 * reviewer sees it — the same reason `smokePublished.test.ts` names its matrix
 * legs instead of asserting a length.
 *
 * This is a contract test, not a behaviour test. It says nothing about whether
 * a route works; it says the name is still the name. When a change to one of
 * these is deliberate, update the list and say so in the pull request.
 */

/** Every route the daemon serves, with every optional surface switched on. */
function fullSurfaceApp(): Hono {
  return createApp({
    mode: 'production',
    // Both branches of the auth fork register routes. `credentials` is the one
    // the daemon actually runs, and it is the larger of the two.
    credentials: { apiToken: 'contract-api-token', sessionToken: 'contract-session-token' },
    // Registers `POST /api/daemon/shutdown`, which is otherwise absent.
    onShutdownRequest: () => {},
    clientDir: '/nonexistent-by-design',
  })
}

function registeredRoutes(): string[] {
  const app = fullSurfaceApp() as unknown as { routes: { method: string, path: string }[] }
  // Middleware registers under `ALL` on wildcards and is not part of the
  // contract; only addressable endpoints are.
  const endpoints = app.routes
    .filter((route) => route.method !== 'ALL')
    .map((route) => `${route.method} ${route.path}`)
  return [...new Set(endpoints)].sort()
}

const EXPECTED_ROUTES = [
  'DELETE /api/projects/:id',
  'DELETE /api/projects/:id/worktrees',
  'DELETE /api/tickets/:id',
  'DELETE /api/tickets/:id/manual-qa/versions/:version/evidence/:itemId/:evidenceId',
  'GET /api/files/:ticketId/:file',
  'GET /api/files/:ticketId/logs',
  'GET /api/health',
  'GET /api/health/opencode',
  'GET /api/health/startup',
  'GET /api/health/update',
  'GET /api/models',
  'GET /api/opencode/questions',
  'GET /api/profile',
  'GET /api/projects',
  'GET /api/projects/:id',
  'GET /api/projects/:id/worktrees/size',
  'GET /api/projects/check-git',
  'GET /api/projects/ls',
  'GET /api/prompts',
  'GET /api/prompts/:id',
  'GET /api/stream',
  'GET /api/tickets',
  'GET /api/tickets/:id',
  'GET /api/tickets/:id/ai-details',
  'GET /api/tickets/:id/artifacts',
  'GET /api/tickets/:id/artifacts/:artifactId/content',
  'GET /api/tickets/:id/artifacts/manifest',
  'GET /api/tickets/:id/beads',
  'GET /api/tickets/:id/beads/:beadId/diff',
  'GET /api/tickets/:id/execution-setup-plan',
  'GET /api/tickets/:id/interview',
  'GET /api/tickets/:id/logs',
  'GET /api/tickets/:id/logs/export',
  'GET /api/tickets/:id/manual-qa',
  'GET /api/tickets/:id/manual-qa/versions/:version',
  'GET /api/tickets/:id/manual-qa/versions/:version/evidence/:itemId/:evidenceId',
  'GET /api/tickets/:id/opencode/questions',
  'GET /api/tickets/:id/phases/:phase/attempts',
  'GET /api/tickets/:id/size',
  'GET /api/tickets/:id/skips',
  'GET /api/tickets/:id/ui-state',
  'GET /api/workflow/meta',
  'PATCH /api/profile',
  'PATCH /api/projects/:id',
  'PATCH /api/tickets/:id',
  'PATCH /api/tickets/:id/edit-answer',
  'POST /api/auth/bootstrap',
  'POST /api/auth/bootstrap/status',
  'POST /api/auth/exchange',
  'POST /api/daemon/shutdown',
  'POST /api/files/open-path',
  'POST /api/health/startup/restore-notice/dismiss',
  'POST /api/models/refresh',
  'POST /api/profile',
  'POST /api/projects',
  'POST /api/prompts/:id/preview',
  'POST /api/prompts/:id/revert',
  'POST /api/prompts/reset-all',
  'POST /api/tickets',
  'POST /api/tickets/:id/answer',
  'POST /api/tickets/:id/answer-batch',
  'POST /api/tickets/:id/approve',
  'POST /api/tickets/:id/approve-beads',
  'POST /api/tickets/:id/approve-execution-setup-plan',
  'POST /api/tickets/:id/approve-interview',
  'POST /api/tickets/:id/approve-prd',
  'POST /api/tickets/:id/artifacts/content/batch',
  'POST /api/tickets/:id/cancel',
  'POST /api/tickets/:id/close-unmerged',
  'POST /api/tickets/:id/continue',
  'POST /api/tickets/:id/coverage/fix-gaps',
  'POST /api/tickets/:id/dev-event',
  'POST /api/tickets/:id/edit-execution-setup-plan',
  'POST /api/tickets/:id/manual-qa/skip',
  'POST /api/tickets/:id/manual-qa/submit',
  'POST /api/tickets/:id/manual-qa/workspace-drift/discard',
  'POST /api/tickets/:id/manual-qa/workspace-drift/include',
  'POST /api/tickets/:id/merge',
  'POST /api/tickets/:id/opencode/question-timer/stop',
  'POST /api/tickets/:id/opencode/questions/:requestId/reject',
  'POST /api/tickets/:id/opencode/questions/:requestId/reply',
  'POST /api/tickets/:id/regenerate-execution-setup-plan',
  'POST /api/tickets/:id/retry',
  'POST /api/tickets/:id/skip',
  'POST /api/tickets/:id/start',
  'POST /api/tickets/:id/verify',
  'PUT /api/files/:ticketId/:file',
  'PUT /api/prompts/:id',
  'PUT /api/tickets/:id/beads',
  'PUT /api/tickets/:id/execution-setup-plan',
  'PUT /api/tickets/:id/interview',
  'PUT /api/tickets/:id/interview-answers',
  'PUT /api/tickets/:id/manual-qa/versions/:version/evidence',
  'PUT /api/tickets/:id/ui-state',
]

/**
 * Compared against `SSE_EVENT_TYPES`, which the daemon broadcasts from.
 *
 * A second copy on purpose. Importing the array and asserting it equals itself
 * would pass through any edit; the point is that these names are read by the
 * interface, so changing one has to be typed out twice, here and there.
 */
const EXPECTED_SSE_EVENTS = [
  'ai_metrics',
  'app_error',
  'artifact_change',
  'bead_complete',
  'log',
  'needs_input',
  'progress',
  'state_change',
].sort()

/**
 * The `doctor --json` check names, read back out of a real `--json` document.
 *
 * Not scraped from the source: two of them are passed as arguments
 * (`checkBinary('git', …)`) rather than written as `name:` literals, so a text
 * scan reports a set that is missing exactly the checks nothing else would
 * notice losing. And not taken from `runChecks` either — `version` is prepended
 * by the command itself and appears only when an update probe answered, so a
 * test built on `runChecks` alone would leave that one name unguarded.
 */
const EXPECTED_DOCTOR_CHECKS = [
  'config dir',
  'daemon',
  'gh',
  'gh auth',
  'git',
  'install',
  'last start',
  'node',
  'npm',
  'opencode',
  'opencode cli',
  'port',
  'project ignores',
  'schema',
  'version',
].sort()

/** Enough of an update result to make the command emit its `version` check. */
const STUB_UPDATE: UpdateStatus = {
  currentVersion: '9.9.9',
  latestVersion: '9.9.9',
  updateAvailable: false,
  checkedAt: null,
  installChannel: 'unknown',
  upgradeCommand: 'npm install -g looptroop@latest',
  release: null,
}

describe('wire contract', () => {
  const tempDirs: string[] = []
  const previousConfigDir = process.env.LOOPTROOP_CONFIG_DIR

  afterEach(() => {
    vi.restoreAllMocks()
    // Separate from `restoreAllMocks`, which does not undo `stubGlobal`.
    vi.unstubAllGlobals()
    for (const dir of tempDirs.splice(0)) removeTempDir(dir)
    if (previousConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
    else process.env.LOOPTROOP_CONFIG_DIR = previousConfigDir
  })

  it('serves exactly the documented API routes', () => {
    expect(registeredRoutes()).toEqual(EXPECTED_ROUTES)
  })

  it('broadcasts exactly the documented SSE event names', () => {
    expect([...SSE_EVENT_TYPES].sort()).toEqual(EXPECTED_SSE_EVENTS)
  })

  it('reports exactly the documented doctor check names', async () => {
    // Its own config directory: the check names are the subject, and reading
    // the developer's real one would make the result depend on the machine.
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-wire-'))
    tempDirs.push(dir)
    process.env.LOOPTROOP_CONFIG_DIR = dir

    // An empty config directory means an empty "latest versions" cache, which
    // is what sends `getLatestToolVersions` to npm and GitHub for all five
    // tools. Those answers only decorate a `detail` string and cannot move a
    // check *name*, so live requests here would buy nothing and cost a wait on
    // `AbortSignal.timeout` on any runner without egress. `fetchVersion`
    // swallows the rejection and keeps the name, which is all this asserts.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline by design')))

    let captured = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    })

    await doctorCommand(true, STUB_UPDATE)

    const document = JSON.parse(captured) as { checks: { name: string }[] }
    expect(document.checks.map((check) => check.name).sort()).toEqual(EXPECTED_DOCTOR_CHECKS)
  })

  it('keeps the check name the install smokes key on', () => {
    // Called out separately because it is the one with the most consumers: nine
    // published-install smokes gate on `install` alone.
    expect(EXPECTED_DOCTOR_CHECKS).toContain('install')
  })
})
