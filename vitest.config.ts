import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { availableParallelism } from 'node:os'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getBackendOrigin, getDocsBaseUrl } from './shared/appConfig.ts'

// Never add tests that hard-code ticket/project-specific fixture ids, refs, shortnames, or worktree names.
const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * How many test workers the machine can actually carry.
 *
 * The projects below share `sequence.groupOrder: 0`, which puts them in one
 * scheduling group whose worker count is this number in total — not per project.
 * vitest requires the value to agree across a group and throws otherwise, so it
 * is computed once here rather than written out four times. On Windows
 * `server-integration` leaves that group; see `integrationGroupOrder`.
 *
 * It was a hardcoded 6, which is fine on a developer machine and oversubscribes
 * a 4-vCPU CI runner. Two of these projects use `pool: 'forks'` with
 * `isolate: true`, and the integration bucket drives git worktrees and SQLite,
 * so an oversubscribed runner does not merely run slower — individual tests
 * cross their timeout and the lane fails on whichever test held the CPU when the
 * clock ran out. That reads as a different "broken" test on every run, which is
 * how this presented: three Windows jobs on one commit, three disjoint sets of
 * timeouts, none in the files the commit touched.
 *
 * Leaving one core for the runner keeps the pool from competing with the
 * process supervising it. The floor of 2 keeps a single-core runner making
 * progress, and the ceiling preserves the previous behaviour everywhere that
 * was already comfortable.
 */
const testMaxWorkers = Math.max(2, Math.min(6, availableParallelism() - 1))

const isWindows = process.platform === 'win32'

/**
 * `server-integration` runs alone, and narrower, on Windows.
 *
 * The failure this addresses is not a slow test. It is several unrelated files
 * crossing their ceilings in the same job while the same commit passes in its
 * sibling run — `beadsRefinePhase` at 45 s and `daemonLock`'s hook at 60 s
 * together in one job, `tickets.start` at 45 s in another, and once a whole
 * suite taking 861 s against a sibling's 413 s while every other Windows job in
 * that run was normal. Budgets were already raised from 20 s once for this;
 * raising them again only moves the ceiling, and a bounded budget is what keeps
 * a genuine hang failing instead of holding the job for thirty minutes.
 *
 * Part of that is a runner we do not control — a machine that turns 413 s into
 * 861 s will still miss a deadline with two workers. The part we do control is
 * how much of the contention is self-inflicted: this is the only bucket using
 * `pool: 'forks'` with `isolate: true` against real git worktrees and real
 * SQLite, and on a 4-vCPU `windows-latest` the shared count above puts three of
 * those in flight at once, each doing thousands of individual file operations
 * through Defender.
 *
 * So it gets its own group rather than a smaller share of the existing one:
 * vitest requires a single worker count per group, so a lower cap here is only
 * expressible by leaving the group — and lowering the shared count instead
 * would also throttle the jsdom and pure-logic buckets, which are not what is
 * starving. Groups run in sequence, so this costs wall-clock time — but much
 * less than it first appears. Forcing this branch on locally took the full
 * suite from 132 s to 253 s, on a machine where the integration cap drops from
 * 6 to 2; a 4-vCPU runner drops it from 3 to 2 instead. Measured on CI the
 * Windows lane ran 514 s and 584 s with this change against 414–558 s without
 * it across six runs the same afternoon, so the cost is inside the lane's own
 * run-to-run spread, against a 30-minute job timeout.
 *
 * Windows only, on both axes. An unconditional `groupOrder: 1` would serialise
 * the integration bucket on Linux and macOS too, where none of this happens.
 */
const integrationMaxWorkers = isWindows ? 2 : testMaxWorkers
const integrationGroupOrder = isWindows ? 1 : 0

const sharedResolve = {
  alias: {
    '@': resolve(__dirname, './src'),
    '@server': resolve(__dirname, './server'),
    '@shared': resolve(__dirname, './shared'),
  },
}

const sharedEnv = {
  NODE_ENV: 'test',
  LOOPTROOP_OPENCODE_MODE: 'mock',
  LOOPTROOP_TEST_SILENT: '1',
}

/**
 * Client tests that touch no DOM, so they do not need the jsdom project.
 *
 * `client-dom` excludes this list, which makes it the only thing deciding where
 * a file runs — and a pure-logic file left off it pays for a jsdom environment,
 * a forked worker and per-file isolation to assert on a string.
 *
 * Membership is by content, not by directory: a sibling that renders belongs in
 * `client-dom` however pure its name looks. `ManualQAView.test.ts` is here;
 * `ManualQAView.render.test.tsx` imports `@testing-library/react` and is not.
 */
const clientNodeTests = [
  'src/components/kanban/__tests__/kanbanSearch.test.ts',
  'src/components/kanban/__tests__/ticketCardUtils.test.ts',
  'src/components/shared/__tests__/modelBadgeUtils.test.ts',
  'src/components/workspace/__tests__/currentActivity.test.ts',
  'src/components/workspace/__tests__/logFormat.test.ts',
  'src/components/workspace/__tests__/ManualQAView.test.ts',
  'src/components/workspace/__tests__/phaseArtifactTypes.test.ts',
  'src/hooks/__tests__/ticketStatusCache.test.ts',
  'src/hooks/__tests__/useTickets.test.ts',
  'src/lib/__tests__/executionSetupPlan.test.ts',
  'src/lib/__tests__/fetchError.test.ts',
  'src/lib/__tests__/recoveryReload.test.ts',
  'src/lib/__tests__/viteDependencyRecovery.test.ts',
  'src/lib/__tests__/workflowMeta.test.ts',
] as const

// Keep the fast server bucket focused on pure logic. The integration bucket
// also carries a small set of isolation-sensitive tests that historically
// depended on per-file module state.
const serverIntegrationTests = [
  'server/__tests__/startupSessions.test.ts',
  'server/git/__tests__/github.test.ts',
  'server/io/__tests__/atomicIO.test.ts',
  'server/log/__tests__/executionLog.test.ts',
  'server/opencode/__tests__/sessionManager.test.ts',
  'server/phases/execution/__tests__/executor.test.ts',
  'server/phases/execution/__tests__/gitOps.test.ts',
  'server/phases/executionSetup/__tests__/storage.test.ts',
  'server/phases/finalTest/__tests__/generator.test.ts',
  'server/phases/integration/__tests__/squash.test.ts',
  'server/phases/interview/__tests__/qa.test.ts',
  'server/routes/__tests__/*.test.ts',
  'server/storage/__tests__/ticketRuntimeProjection.test.ts',
  'server/storage/__tests__/tickets.test.ts',
  'server/ticket/__tests__/initialize.test.ts',
  'server/workflow/__tests__/beadsDraftPhase.test.ts',
  'server/workflow/__tests__/beadsRefinePhase.test.ts',
  'server/workflow/__tests__/beadsVotePhase.test.ts',
  'server/workflow/__tests__/executionPhase.test.ts',
  'server/workflow/__tests__/integrationPhase.test.ts',
  'server/workflow/__tests__/interviewCompilePhase.test.ts',
  'server/workflow/__tests__/openCodeLogCanonicalization.test.ts',
  'server/workflow/__tests__/phaseIntermediateRecovery.test.ts',
  'server/workflow/__tests__/pullRequestPhase.test.ts',
  'server/workflow/__tests__/prdDraftPhase.test.ts',
  'server/workflow/__tests__/prdRefinePhase.test.ts',
  'server/workflow/__tests__/relevantFilesScan.test.ts',
  'server/workflow/__tests__/runOpenCodePrompt.test.ts',
  'server/workflow/__tests__/runner.test.ts',
  'server/workflow/__tests__/skipAllInterviewQuestionsToApproval.test.ts',
  'server/workflow/__tests__/verificationFinalTestPhase.test.ts',
  // Mocks the OpenCode session layer, which the daemon tests load for real.
  'server/phases/prd/__tests__/draft.test.ts',
  // Asserts on real module state (timers, signal handlers, sockets), so it
  // cannot share a worker with files that vi.mock the same modules.
  'tests/createRuntime.test.ts',
  // Builds the whole app, which loads the real providerCatalog and would
  // defeat the vi.mock in a sibling sharing the non-isolated worker.
  'tests/staticServing.test.ts',
  'tests/sessionAuth.test.ts',
  // Binds two real loopback ports to replay a captured cookie between them.
  'tests/loopbackCookieTheft.test.ts',
  // Start a real daemon: sockets, locks and the database must not be shared.
  'tests/startDaemon.test.ts',
  'tests/daemonLock.test.ts',
  'tests/opencodeSupervisor.test.ts',
  // Spawns real child processes and signals them, so it needs its own worker.
  'tests/stopCommand.test.ts',
  'tests/startCommandAbandon.test.ts',
  'tests/openCommand.test.ts',
  'tests/cleanCommand.test.ts',
  // Reads the real database module, which siblings replace with a mock.
  'tests/doctorCommand.test.ts',
  // Spawns the channel push driver as a child process against a stubbed `gh`.
  'tests/channelPush.test.ts',
  // Starts an HTTP server and spawns the installer as a child process.
  'tests/installer.test.ts',
  // Rebuilds the OpenCode adapter singleton, which siblings share and mock.
  'tests/opencodeRuntimeConfig.test.ts',
  // Same reason, arrived at the hard way. `questionWindows.ts` is imported by
  // `workflow/phases/helpers.ts`, so any phase test loads it — and with
  // `isolate: false` whichever file loads it *first* is the one whose factory
  // mock it binds. This file then asserted on a `MockOpenCodeAdapter` the
  // rejections never reached, which read as "expiry did not fire" on every CI
  // runner and passed locally, where more workers kept the files apart. Every
  // other test that mocks the factory is already in this list.
  'server/workflow/__tests__/questionWindows.test.ts',

  // Below: integration-grade work that had been filed into `server-pure`, the
  // bucket documented as "no DB, no global state". They drive the real database
  // and real git worktrees, and `createInitializedTestTicket` alone spends nine
  // synchronous `git` spawns per ticket before a single assertion runs.
  //
  // Two things made that placement fail specifically on Windows. `server-pure`
  // is a `threads` pool, so a synchronous child-process spawn blocks the whole
  // worker — and with `isolate: false` one worker carries many files, so the
  // files queued behind it stall too. And `server-pure` carries the tightest
  // budget in the suite, which these are the least able to afford: process
  // creation on Windows has no fork() to lean on. Measured on a windows-latest
  // runner, four of the five slowest files in `server-pure` were these, led by
  // manualQa/operations at 47.8s against a 15s per-test timeout. Both Windows
  // stall victims observed on this branch came from this set.
  //
  // In `server-integration` each gets its own process, so a blocking spawn
  // stalls only itself, and the 20s/30s budgets are the ones written for
  // exactly this workload. Anything new that opens the database or shells out
  // to git belongs here too, however pure its unit under test looks.
  // Both spawn real child processes, and `hookValidation` does it with
  // `spawnSync` — which blocks the whole worker, so with `isolate: false` every
  // file queued behind it stalls too. On Windows, where there is no fork() to
  // lean on, that is enough to push unrelated files past the 15s budget: the two
  // of them timed out together on one run of a SHA whose sibling run passed.
  // Same reason as the group below, found the same way.
  'server/lib/__tests__/commandExecutor.test.ts',
  'server/phases/executionSetup/__tests__/hookValidation.test.ts',
  // Same reason: it runs `doctor`'s real checks to read their names back, and
  // those probe `git`, `gh` and `npm` with `execFileSync`.
  'tests/wireContract.test.ts',

  'server/db/__tests__/sqliteContract.test.ts',
  'server/machines/__tests__/persistence.test.ts',
  'server/phases/executionSetup/__tests__/workspaceInputs.test.ts',
  'server/phases/executionSetupPlan/__tests__/generator.test.ts',
  'server/phases/manualQa/__tests__/checkpoint.test.ts',
  'server/phases/manualQa/__tests__/operations.test.ts',
  'server/storage/__tests__/ticketQueries.test.ts',
  'server/workflow/__tests__/executionSetupPhase.test.ts',
  'server/workflow/__tests__/interviewVotePhase.test.ts',
] as const

export default defineConfig({
  resolve: sharedResolve,
  cacheDir: './.vitest-cache',
  define: {
    __LOOPTROOP_DEV_BACKEND_ORIGIN__: JSON.stringify(getBackendOrigin()),
    __LOOPTROOP_DOCS_ORIGIN__: JSON.stringify(getDocsBaseUrl()),
  },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        plugins: [react()],
        test: {
          // jsdom tests need isolation (DOM/localStorage state must not leak between files).
          name: 'client-dom',
          environment: 'jsdom',
          pool: 'forks',
          fileParallelism: true,
          maxWorkers: testMaxWorkers,
          isolate: true,
          sequence: { groupOrder: 0 },
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [...clientNodeTests],
          css: false,
          // The other three projects declare a budget; without one this project
          // silently took vitest's 5000ms default — the tightest budget in the
          // suite on its heaviest workload (jsdom + forks + isolate). On a
          // 3-vCPU macOS runner these renders take just over 5s while the other
          // projects run alongside, so the lane failed on whichever test held
          // the CPU when the clock ran out rather than on any one defect.
          // Matching server-pure absorbs the contention; a hung render still fails.
          testTimeout: 15000,
          hookTimeout: 20000,
          env: sharedEnv,
        },
      },
      {
        extends: true,
        test: {
          // Pure client logic tests (no DOM) — safe to share module graph within each worker.
          name: 'client-node',
          environment: 'node',
          pool: 'threads',
          fileParallelism: true,
          maxWorkers: testMaxWorkers,
          isolate: false,
          sequence: { groupOrder: 0 },
          include: [...clientNodeTests],
          env: sharedEnv,
        },
      },
      {
        extends: true,
        test: {
          // Pure server logic tests — safe to share module graph (no DB, no global state).
          // isolate: false dramatically reduces per-file import overhead (was 28s aggregate).
          // That sharing is what makes this bucket fast and also what makes it the
          // wrong home for anything touching the DB, git, or a child process: see
          // the note above the tail of `serverIntegrationTests`.
          name: 'server-pure',
          environment: 'node',
          pool: 'threads',
          fileParallelism: true,
          maxWorkers: testMaxWorkers,
          isolate: false,
          sequence: { groupOrder: 0 },
          setupFiles: ['./server/test/setup.ts'],
          include: ['server/**/*.test.ts', 'tests/**/*.test.ts', 'shared/**/*.test.ts'],
          exclude: [...serverIntegrationTests],
          testTimeout: 15000,
          hookTimeout: 20000,
          env: sharedEnv,
        },
      },
      {
        extends: true,
        test: {
          // Integration tests touch the DB and git filesystem — keep forks + isolation.
          name: 'server-integration',
          environment: 'node',
          pool: 'forks',
          fileParallelism: true,
          maxWorkers: integrationMaxWorkers,
          isolate: true,
          sequence: { groupOrder: integrationGroupOrder },
          setupFiles: ['./server/test/setup.ts'],
          include: [...serverIntegrationTests],
          // Longer on Windows, and only there. These tests drive real git
          // worktrees and real SQLite files, and the Windows runners do that
          // several times slower than the other two — creating a worktree means
          // thousands of individual file operations against a filesystem with
          // far higher per-call overhead, made worse by Defender.
          //
          // This is not a retry and does not hide a race. Three separate runs
          // on 2026-08-13 failed with *different* tests each time, every one at
          // 25–28 s against a 20 s limit: the shape of work that is too slow,
          // not work that is wrong. A retry would have hidden exactly that.
          //
          // Bounded rather than removed, so a genuine hang still fails the run
          // instead of holding the job open until the 30-minute job timeout.
          testTimeout: process.platform === 'win32' ? 45000 : 20000,
          hookTimeout: process.platform === 'win32' ? 60000 : 30000,
          env: sharedEnv,
        },
      },
    ],
  },
})
