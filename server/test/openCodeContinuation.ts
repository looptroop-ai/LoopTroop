import { expect } from 'vitest'
import type { BlockedErrorDiagnostics } from '@shared/errorDiagnostics'
import { listOpenCodeSessionsForTicket } from '../opencode/sessionManager'
import { patchTicket, recordTicketErrorOccurrence, resolveTicketContinuationCandidate } from '../storage/tickets'

export function recordTimeoutAndExpectContinuation(input: {
  ticketId: string
  previousStatus: string
  sessionId: string
  diagnostics: BlockedErrorDiagnostics | undefined
}): void {
  recordTicketErrorOccurrence(input.ticketId, {
    blockedFromStatus: input.previousStatus,
    errorMessage: 'Timeout',
    diagnostics: input.diagnostics,
  })
  patchTicket(input.ticketId, {
    status: 'BLOCKED_ERROR',
    xstateSnapshot: JSON.stringify({ context: { previousStatus: input.previousStatus } }),
    errorMessage: 'Timeout',
  })

  expect(listOpenCodeSessionsForTicket(input.ticketId, ['active']).map((session) => session.sessionId))
    .toEqual([input.sessionId])
  expect(resolveTicketContinuationCandidate(input.ticketId)).toMatchObject({
    previousStatus: input.previousStatus,
    sessionId: input.sessionId,
  })
}
