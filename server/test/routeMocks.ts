import { vi } from 'vitest'

/**
 * The module doubles the ticket-route suites all install.
 *
 * Four of them carried the same twenty-five lines of `vi.mock` factories, so
 * teaching the router to call one more function meant editing four identical
 * blocks — and SonarCloud counted the whole preamble as duplicated new code the
 * moment one line of it changed.
 *
 * Each factory is called from inside a `vi.mock` factory, which runs after
 * hoisting, so the import has to be dynamic:
 *
 * ```ts
 * vi.mock('../../workflow/runner', async () => (await import('../../test/routeMocks')).workflowRunnerMock())
 * ```
 *
 * They are deliberately whole-module doubles rather than partial ones: a route
 * reaching an export nobody stubbed should fail loudly in the suite that added
 * the call, not reach the real implementation.
 */

/** `server/workflow/runner`. */
export function workflowRunnerMock() {
  return {
    cancelTicket: vi.fn(),
    // Both answer-batch submission paths take the claim, so the double offers it.
    claimInterviewBatch: vi.fn(() => true),
    releaseInterviewBatch: vi.fn(),
    handleInterviewQABatch: vi.fn(),
    // Returns a promise, like the real one: the route races it against a timeout.
    processInterviewBatchAsync: vi.fn(async () => undefined),
    skipAllInterviewQuestionsToApproval: vi.fn(),
  }
}

/** `server/opencode/sessionManager`. */
export function sessionManagerMock() {
  return {
    abortTicketSessions: vi.fn(async () => undefined),
  }
}

/** `server/opencode/contextBuilder`. */
export function contextBuilderMock() {
  return {
    clearContextCache: vi.fn(),
  }
}

/** `server/machines/persistence`. */
export function machinesPersistenceMock() {
  return {
    createTicketActor: vi.fn(),
    ensureActorForTicket: vi.fn(() => ({ id: 'mock-actor' })),
    revertTicketToApprovalStatus: vi.fn(),
    sendTicketEvent: vi.fn(),
    getTicketState: vi.fn(() => null),
    stopActor: vi.fn(() => true),
  }
}
