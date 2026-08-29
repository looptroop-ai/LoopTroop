import type { AIQuestionContextValue } from '@/context/aiQuestionContextDef'

/**
 * A quiet AI-question context for tests that only care about something else.
 *
 * The interface grew when questions gained a countdown, and a test that spells
 * out every member has to be edited whenever a new one appears — which is how a
 * card test ends up failing for reasons that have nothing to do with cards.
 */
export function createAiQuestionContextStub(
  overrides: Partial<AIQuestionContextValue> = {},
): AIQuestionContextValue {
  return {
    getPendingCount: () => 0,
    getRequestCount: () => 0,
    getTicketRequests: () => [],
    getTimer: () => null,
    getRemainingMs: () => null,
    answerRequest: () => undefined,
    skipRequest: () => undefined,
    stopTimer: () => undefined,
    ingestSseEvent: () => undefined,
    refreshTicket: () => undefined,
    ...overrides,
  }
}
