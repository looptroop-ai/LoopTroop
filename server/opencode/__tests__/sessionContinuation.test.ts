import { describe, expect, it } from 'vitest'
import { OPENCODE_PROVIDER_AUTH_FAILED } from '@shared/errorCodes'
import type { BlockedErrorDiagnostics } from '@shared/errorDiagnostics'
import {
  clearTicketSessionContinuations,
  getPendingSessionContinuationForTicketPhase,
  isContinuableBlockedError,
  requestSessionContinuation,
  shouldPreserveSessionForContinuation,
} from '../sessionContinuation'
import { WorkflowDeadlineTimeoutError } from '../../lib/deadlineErrors'

function diagnostics(input: Partial<BlockedErrorDiagnostics>): BlockedErrorDiagnostics {
  return {
    kind: 'opencode_provider',
    source: 'provider',
    summary: 'temporary provider failure',
    sessionId: 'ses-continue',
    ...input,
  }
}

describe('session continuation eligibility', () => {
  it.each([
    ['usage limit retryable signal', diagnostics({ summary: 'usage limit has been reached', isRetryable: true })],
    ['HTTP 402 Payment Required', diagnostics({ summary: 'Payment Required', statusCode: 402, isRetryable: false })],
    ['HTTP 402 deactivated workspace', diagnostics({
      summary: 'Payment Required: {"detail":{"code":"deactivated_workspace"}} (HTTP 402)',
      statusCode: 402,
      isRetryable: false,
      responseBodyPreview: '{"detail":{"code":"deactivated_workspace"}}',
    })],
    ['HTTP 402 billing error', diagnostics({
      summary: 'billing_error: payment method needs attention',
      statusCode: 402,
      isRetryable: false,
      providerErrorType: 'billing_error',
      providerErrorMessage: 'There is an issue with your billing or payment information.',
    })],
    ['HTTP 429 rate limit', diagnostics({ summary: 'rate limit exceeded', statusCode: 429 })],
    ['HTTP 503 overload', diagnostics({ summary: 'service overloaded', statusCode: 503 })],
    ['HTTP 529 capacity', diagnostics({ summary: 'model is overloaded', statusCode: 529 })],
    ['retryable uncommon 4xx', diagnostics({ summary: 'provider marked this client error retryable', statusCode: 409, isRetryable: true })],
    ['timeout', diagnostics({ kind: 'timeout', source: 'opencode', summary: 'Timeout' })],
    ['transport failure', diagnostics({ kind: 'transport', source: 'opencode', summary: 'fetch failed: connection reset' })],
  ])('accepts %s', (_label, candidate) => {
    expect(isContinuableBlockedError({ diagnostics: candidate, errorCodes: [] })).toBe(true)
  })

  it.each([
    ['auth code', diagnostics({ summary: 'rate limit text but auth failed' }), [OPENCODE_PROVIDER_AUTH_FAILED]],
    ['HTTP 400', diagnostics({ summary: 'bad request', statusCode: 400, isRetryable: true }), []],
    ['HTTP 401', diagnostics({ summary: 'rate limit text but HTTP 401', statusCode: 401 }), []],
    ['HTTP 403', diagnostics({ summary: 'permission_error: forbidden', statusCode: 403, isRetryable: true }), []],
    ['HTTP 404', diagnostics({ summary: 'model_not_found: resource is missing', statusCode: 404, isRetryable: true }), []],
    ['HTTP 413', diagnostics({ summary: 'request_too_large: payload exceeds context window', statusCode: 413, isRetryable: true }), []],
    ['HTTP 422', diagnostics({ summary: 'unprocessable entity', statusCode: 422, isRetryable: true }), []],
    ['uncommon 4xx with transient-looking text but no retryable flag', diagnostics({ summary: 'rate limit text on unsupported client error', statusCode: 418, isRetryable: false }), []],
    ['invalid request', diagnostics({ summary: 'invalid_request: payload is invalid', statusCode: 400 }), []],
    ['billing', diagnostics({ summary: 'billing account disabled', isRetryable: true }), []],
    ['insufficient quota', diagnostics({ summary: 'insufficient_quota: quota exhausted', isRetryable: true }), []],
  ])('rejects %s', (_label, candidate, errorCodes) => {
    expect(isContinuableBlockedError({ diagnostics: candidate, errorCodes })).toBe(false)
  })

  it('rejects retryable diagnostics without a session id', () => {
    expect(isContinuableBlockedError({
      diagnostics: diagnostics({ sessionId: undefined, statusCode: 429 }),
      errorCodes: [],
    })).toBe(false)
  })

  it('does not preserve workflow deadline timeouts as continuable OpenCode sessions', () => {
    expect(shouldPreserveSessionForContinuation({
      error: new WorkflowDeadlineTimeoutError({
        phase: 'CODING',
        beadId: 'bead-1',
        iteration: 1,
        timeoutMs: 25,
      }),
      sessionId: 'ses-workflow-timeout',
      modelId: 'model-a',
      sessionOwnership: {
        ticketId: 'ticket-1',
        phase: 'CODING',
        beadId: 'bead-1',
        iteration: 1,
        keepActive: true,
      },
    })).toBe(false)
  })
})

describe('clearTicketSessionContinuations', () => {
  it('drops every continuation a ticket holds and leaves other tickets alone', () => {
    requestSessionContinuation({ ticketId: 'T-1', phase: 'CODING', sessionId: 'ses-a', additionalRetryAttempts: 2 })
    requestSessionContinuation({ ticketId: 'T-1', phase: 'RUNNING_FINAL_TEST', sessionId: 'ses-b' })
    requestSessionContinuation({ ticketId: 'T-2', phase: 'CODING', sessionId: 'ses-c' })

    expect(clearTicketSessionContinuations('T-1')).toBe(2)

    // A continuation stays valid for thirty minutes, so one left behind by an
    // abort was picked up by the ticket's *next* run and reapplied the
    // abandoned run's extra retry attempts.
    expect(getPendingSessionContinuationForTicketPhase('T-1', 'CODING')).toBeNull()
    expect(getPendingSessionContinuationForTicketPhase('T-1', 'RUNNING_FINAL_TEST')).toBeNull()
    expect(getPendingSessionContinuationForTicketPhase('T-2', 'CODING')).not.toBeNull()
    clearTicketSessionContinuations('T-2')
  })

  it('is a no-op for a ticket with nothing pending', () => {
    expect(clearTicketSessionContinuations('T-nothing')).toBe(0)
  })
})
