import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { availableParallelism } from 'node:os'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getBackendOrigin, getDocsBaseUrl } from './shared/appConfig'

// Never add tests that hard-code ticket/project-specific fixture ids, refs, shortnames, or worktree names.
const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * How many test workers the machine can actually carry.
 *
 * Every project below shares `sequence.groupOrder: 0`, which puts them in one
 * scheduling group whose worker count is this number in total — not per project.
 * vitest requires the value to agree across a group and throws otherwise, so it
 * is computed once here rather than written out four times.
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

const clientNodeTests = [
  'src/components/workspace/__tests__/phaseArtifactTypes.test.ts',
  'src/hooks/__tests__/ticketStatusCache.test.ts',
  'src/hooks/__tests__/useTickets.test.ts',
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
  'tests/cleanCommand.test.ts',
  // Reads the real database module, which siblings replace with a mock.
  'tests/doctorCommand.test.ts',
  // Rebuilds the OpenCode adapter singleton, which siblings share and mock.
  'tests/opencodeRuntimeConfig.test.ts',
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
          maxWorkers: testMaxWorkers,
          isolate: true,
          sequence: { groupOrder: 0 },
          setupFiles: ['./server/test/setup.ts'],
          include: [...serverIntegrationTests],
          testTimeout: 20000,
          hookTimeout: 30000,
          env: sharedEnv,
        },
      },
    ],
  },
})
