import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getBackendOrigin, getDocsBaseUrl } from './shared/appConfig'

// Never add tests that hard-code ticket/project-specific fixture ids, refs, shortnames, or worktree names.
const __dirname = dirname(fileURLToPath(import.meta.url))

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
          maxWorkers: 6,
          isolate: true,
          sequence: { groupOrder: 0 },
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [...clientNodeTests],
          css: false,
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
          maxWorkers: 6,
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
          maxWorkers: 6,
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
          maxWorkers: 6,
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
