import { describe, expect, it } from 'vitest'
import {
  OPENCODE_PROVIDER_AUTH_FAILED,
  OPENCODE_PROVIDER_ERROR,
} from '@shared/errorCodes'
import {
  appendBlockedErrorDiagnosticsSummary,
  attachOpenCodeBlockedErrorDiagnostics,
  buildOpenCodeBlockedErrorDiagnostics,
} from '../blockedErrorDiagnostics'
import { isContinuableBlockedError } from '../sessionContinuation'
import { V2OpenCodeHttpError } from '../v2Transport'

describe('OpenCode blocked error diagnostics', () => {
  it.each(['Error', 'Unauthorized', 'UnauthorizedError', 'Forbidden', 'ForbiddenError'])('keeps the generic prompt response type %s neutral without losing its details', (type) => {
    const body = { error: { type, message: 'Forbidden' } }
    const error = new V2OpenCodeHttpError(403, body, 'opencode_prompt')
    const result = buildOpenCodeBlockedErrorDiagnostics({ error: new Error('Failed to prompt OpenCode session', { cause: error }), modelId: 'openai/model-a', sessionId: 'ses-ambiguous' })

    expect(result.errorCodes).toEqual([])
    expect(result.diagnostics).toMatchObject({ kind: 'runtime', statusCode: 403, providerErrorType: type, providerErrorMessage: 'Forbidden', responseBodyPreview: JSON.stringify(body), modelId: 'openai/model-a', sessionId: 'ses-ambiguous' })
    expect(result.diagnostics?.providerId).toBeUndefined()
    expect(result.diagnostics?.providerModelId).toBeUndefined()
    expect(isContinuableBlockedError(result)).toBe(false)
  })

  it.each([
    { name: 'ProviderAuthError' }, { type: 'authentication_error' }, { type: 'provider.auth' },
  ])('keeps explicit provider-auth response identity $name$type authoritative', (identity) => {
    const error = new V2OpenCodeHttpError(401, { error: { ...identity, message: 'Provider credentials rejected' } }, 'opencode_prompt')
    const result = buildOpenCodeBlockedErrorDiagnostics({ error, modelId: 'openai/model-a', sessionId: 'ses-provider' })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_AUTH_FAILED])
    expect(result.diagnostics).toMatchObject({ kind: 'opencode_provider', providerId: 'openai', statusCode: 401 })
    expect(isContinuableBlockedError(result)).toBe(false)
  })

  it.each([
    { type: 'provider.internal', status: 500, message: 'Internal server error', code: OPENCODE_PROVIDER_ERROR, continuable: true },
    { type: 'provider.internal', status: 502, message: 'Bad gateway', code: OPENCODE_PROVIDER_ERROR, continuable: true },
    { type: 'provider.auth', status: 401, message: 'Request blocked by upstream provider.', code: OPENCODE_PROVIDER_AUTH_FAILED, continuable: false },
  ])('retains actual v2 $type step errors and HTTP $status continuation policy', ({ type, status, message, code, continuable }) => {
    const result = buildOpenCodeBlockedErrorDiagnostics({
      modelId: 'openai/model-a', sessionId: 'ses-v2-provider',
      attemptMeta: { errorSource: 'session_error', error: message, errorDetails: { type, status, message } },
    })

    expect(result.errorCodes).toEqual([code])
    expect(result.diagnostics).toMatchObject({ kind: 'opencode_provider', source: 'provider', statusCode: status, providerErrorType: type, providerErrorMessage: message, providerId: 'openai' })
    expect(isContinuableBlockedError(result)).toBe(continuable)
  })

  it.each(['tool.execution', 'permission.rejected', 'unknown'])('does not turn the v2 %s step error into a provider failure', (type) => {
    const result = buildOpenCodeBlockedErrorDiagnostics({
      sessionId: 'ses-nonprovider',
      attemptMeta: { errorSource: 'session_error', error: 'Authentication failed in a tool', errorDetails: { type, message: 'Authentication failed in a tool', status: 401 } },
    })

    expect(result.errorCodes).toEqual([])
    expect(result.diagnostics).toMatchObject({ kind: 'runtime', statusCode: 401, errorName: type })
    expect(isContinuableBlockedError(result)).toBe(false)
  })

  it('keeps a reviewed v2 CreditsError as a provider failure without refresh-login guidance', () => {
    const responseBody = JSON.stringify({ error: { type: 'CreditsError', message: 'No payment method' } })
    const result = buildOpenCodeBlockedErrorDiagnostics({
      sessionId: 'ses-billing', modelId: 'openai/model-a',
      attemptMeta: { errorSource: 'session_error', error: 'No payment method. Add a payment method...', errorDetails: {
        type: 'provider.auth', status: 401, message: 'No payment method. Add a payment method...', response: { body: responseBody },
      } },
    })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_ERROR])
    expect(result.errorCodes).not.toContain(OPENCODE_PROVIDER_AUTH_FAILED)
    expect(result.diagnostics).toMatchObject({ kind: 'opencode_provider', statusCode: 401, providerErrorType: 'provider.auth', providerErrorMessage: 'No payment method', responseBodyPreview: responseBody })
    expect(result.diagnostics?.summary).toBe('provider.auth: No payment method (HTTP 401)')
    expect(isContinuableBlockedError(result)).toBe(false)
  })

  it.each(['billing_error: account disabled', 'Missing payment method', 'Insufficient credits', 'Credits exhausted'])('does not recommend refreshing credentials for explicit payment evidence: %s', (message) => {
    const result = buildOpenCodeBlockedErrorDiagnostics({
      sessionId: 'ses-billing', attemptMeta: { errorSource: 'session_error', error: message, errorDetails: { type: 'provider.auth', status: 401, message } },
    })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_ERROR])
    expect(isContinuableBlockedError(result)).toBe(false)
  })

  it('captures the error type and sanitized stack for runtime failures', () => {
    const error = new TypeError('Unexpected response shape')
    error.stack = 'TypeError: Unexpected response shape\n    at decode (https://user:password@example.test/decoder?token=private-token:10:2)\napiKey=sk-private-diagnostic-key'

    const result = buildOpenCodeBlockedErrorDiagnostics({ error })

    expect(result.diagnostics).toMatchObject({
      kind: 'runtime',
      errorName: 'TypeError',
      stackTrace: expect.stringContaining('at decode (https://example.test/decoder'),
    })
    expect(result.diagnostics?.stackTrace).not.toContain('private-token')
    expect(result.diagnostics?.stackTrace).not.toContain('sk-private-diagnostic-key')
    expect(result.diagnostics?.stackTrace).toContain('[redacted]')
    expect(result.errorCodes).toEqual([])
  })

  it('recovers structured provider evidence through multiple wrappers without replacing the reported operation', () => {
    const providerError = Object.assign(new Error('Provider request failed'), {
      name: 'APIError',
      data: {
        statusCode: 401,
        isRetryable: false,
        responseBody: JSON.stringify({ error: {
          type: 'invalid_request_error',
          message: 'Your authentication token has expired. Please try refreshing it.',
        } }),
      },
    })
    const sessionError = Object.assign(new Error('Failed to create OpenCode session', { cause: providerError }), {
      openCodeOperation: 'creating an OpenCode session',
    })
    const error = new Error('Failed after two attempts', { cause: sessionError })

    const result = buildOpenCodeBlockedErrorDiagnostics({ error, modelId: 'openai/model-a' })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_AUTH_FAILED])
    expect(result.diagnostics).toMatchObject({
      kind: 'opencode_provider',
      source: 'provider',
      operation: 'creating an OpenCode session',
      modelId: 'openai/model-a',
      statusCode: 401,
      isRetryable: false,
      providerErrorType: 'invalid_request_error',
      providerErrorMessage: 'Your authentication token has expired. Please try refreshing it.',
      responseBodyPreview: expect.stringContaining('invalid_request_error'),
      errorName: 'Error',
      stackTrace: expect.stringContaining('Caused by: APIError: Provider request failed'),
    })
    expect(result.diagnostics?.summary).toContain('Your authentication token has expired')
    expect(result.diagnostics?.sessionId).toBeUndefined()
  })

  it('preserves attached diagnostics and codes through a wrapper while adding its captured stack', () => {
    const cause = attachOpenCodeBlockedErrorDiagnostics(new Error('actual failure'), {
      diagnostics: {
        kind: 'opencode_provider', source: 'provider', summary: 'Account exhausted',
        modelId: 'actual/model', sessionId: 'failed-session', operation: 'waiting for the accepted prompt to finish',
        statusCode: 429,
      },
      errorCodes: [OPENCODE_PROVIDER_ERROR],
    })
    const error = Object.assign(new Error('workflow wrapper', { cause }), {
      blockedErrorCodes: [OPENCODE_PROVIDER_ERROR, 'PHASE_FAILED'],
    })

    const result = buildOpenCodeBlockedErrorDiagnostics({ error, modelId: 'fallback/model', sessionId: 'older-session' })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_ERROR, 'PHASE_FAILED'])
    expect(result.diagnostics).toMatchObject({
      summary: 'Account exhausted', modelId: 'actual/model', sessionId: 'failed-session', statusCode: 429,
      operation: 'waiting for the accepted prompt to finish', errorName: 'Error',
      stackTrace: expect.stringContaining('Caused by: Error: actual failure'),
    })
  })

  it('keeps a server re-attribution authoritative through production-shaped retry wrappers', () => {
    const responseError = Object.assign(new Error('OpenCode rejected the configured credentials (HTTP 401)'), {
      statusCode: 401,
    })
    const adapterError = attachOpenCodeBlockedErrorDiagnostics(new Error('Failed to create OpenCode session', { cause: responseError }),
      buildOpenCodeBlockedErrorDiagnostics({ error: responseError }))
    const retryError = new Error('Could not create OpenCode session after two attempts', { cause: adapterError })
    const serverResult = buildOpenCodeBlockedErrorDiagnostics({ error: retryError, modelId: 'openai/model-a', errorSource: 'opencode_server' })
    const doctorError = attachOpenCodeBlockedErrorDiagnostics(retryError, serverResult)
    const result = buildOpenCodeBlockedErrorDiagnostics({ error: new Error('Capability check failed', { cause: doctorError }), modelId: 'openai/model-a' })

    expect(result.errorCodes).toEqual([])
    expect(result.diagnostics).toMatchObject({ kind: 'opencode_session', source: 'opencode', modelId: 'openai/model-a', statusCode: 401 })
    expect(result.diagnostics?.providerId).toBeUndefined()
    expect(result.diagnostics?.providerModelId).toBeUndefined()
  })

  it('does not resurrect provider codes or identities from inner errors when attached server diagnostics were rewritten', () => {
    const cause = attachOpenCodeBlockedErrorDiagnostics(new Error('Authentication failed'), {
      diagnostics: { kind: 'opencode_provider', source: 'provider', summary: 'Authentication failed', providerId: 'openai' },
      errorCodes: [OPENCODE_PROVIDER_AUTH_FAILED, OPENCODE_PROVIDER_ERROR],
    })
    const error = attachOpenCodeBlockedErrorDiagnostics(new Error('Probe failed', { cause }), {
      diagnostics: { kind: 'opencode_session', source: 'opencode', summary: 'Server password rejected', modelId: 'openai/model-a' },
      errorCodes: ['PREFLIGHT_FAILED'],
    })

    const result = buildOpenCodeBlockedErrorDiagnostics({ error })

    expect(result.errorCodes).toEqual(['PREFLIGHT_FAILED'])
    expect(result.diagnostics?.providerId).toBeUndefined()
    expect(result.diagnostics?.providerModelId).toBeUndefined()
  })

  it('keeps explicit error codes even when no diagnostics were captured', () => {
    const error = attachOpenCodeBlockedErrorDiagnostics(new Error('Failure without details'), { diagnostics: null, errorCodes: [' CHECK_FAILED ', 'CHECK_FAILED'] })

    expect(error).toMatchObject({ blockedErrorCodes: ['CHECK_FAILED'] })
    expect(buildOpenCodeBlockedErrorDiagnostics({ error }).errorCodes).toEqual(['CHECK_FAILED'])
  })

  it('recovers inner provider status and authentication evidence instead of selecting outer generic details', () => {
    const cause = Object.assign(new Error('Provider request failed'), { details: {
      statusCode: 401, responseErrorMessage: 'Authentication token expired', responseErrorType: 'authentication_error',
    } })
    const error = Object.assign(new Error('Workflow failed', { cause }), { modelErrorDetails: { message: 'generic' } })

    const result = buildOpenCodeBlockedErrorDiagnostics({ error, modelId: 'openai/model-a' })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_AUTH_FAILED])
    expect(result.diagnostics).toMatchObject({ kind: 'opencode_provider', statusCode: 401, providerErrorMessage: 'Authentication token expired' })
    expect(result.diagnostics?.summary).not.toBe('generic')
  })

  it('keeps stack and cause capture bounded when causes are circular', () => {
    const error = new Error('Unexpected response shape')
    const cause = new TypeError('decoder failed', { cause: error })
    error.cause = cause

    const result = buildOpenCodeBlockedErrorDiagnostics({ error })

    expect(result.errorCodes).toEqual([])
    expect(result.diagnostics).toMatchObject({ kind: 'runtime', errorName: 'Error' })
    expect(result.diagnostics?.stackTrace?.match(/Caused by:/g)).toHaveLength(1)
  })

  it('limits provider discovery and stack capture to eight cause-chain entries', () => {
    let error: Error = Object.assign(new Error('Deep provider failure'), { statusCode: 401 })
    for (let depth = 0; depth < 8; depth += 1) error = new Error('Unexpected response shape', { cause: error })

    const result = buildOpenCodeBlockedErrorDiagnostics({ error })

    expect(result.errorCodes).toEqual([])
    expect(result.diagnostics?.kind).toBe('runtime')
    expect(result.diagnostics?.statusCode).toBeUndefined()
    expect(result.diagnostics?.stackTrace?.match(/Caused by:/g)).toHaveLength(7)
  })

  it('explains an unreported connection cause without inventing a timeout or retry policy', () => {
    const result = buildOpenCodeBlockedErrorDiagnostics({
      error: Object.assign(new Error('Failed to prompt OpenCode session: fetch failed', {
        cause: new TypeError('fetch failed'),
      }), { openCodeOperation: 'waiting for the session to become idle before sending the prompt' }),
      modelId: 'provider/model',
      sessionId: 'session-1',
    })

    expect(result.errorCodes).toEqual([])
    expect(result.diagnostics).toMatchObject({
      kind: 'transport',
      source: 'opencode',
      operation: 'waiting for the session to become idle before sending the prompt',
      modelId: 'provider/model',
      sessionId: 'session-1',
    })
    expect(result.diagnostics?.summary).toContain('LoopTroop could not communicate with OpenCode')
    expect(result.diagnostics?.summary).toContain('fetch failed')
    expect(result.diagnostics?.summary).toContain('The exact connection cause was not reported.')
    expect(result.diagnostics?.isRetryable).toBeUndefined()
  })

  it('keeps arbitrary cause prose out of connection classification and continuation decisions', () => {
    const cause = Object.assign(new Error('Authorization: Bearer abc.def.ghi; token permission billing note'), { code: 'ECONNRESET' })
    const result = buildOpenCodeBlockedErrorDiagnostics({
      error: Object.assign(new TypeError('fetch failed', { cause }), { openCodeOperation: 'waiting for the accepted prompt to finish' }),
      sessionId: 'session-1',
    })

    expect(result.errorCodes).toEqual([])
    expect(result.diagnostics).toMatchObject({
      kind: 'transport',
      transportCode: 'ECONNRESET',
      causeMessage: expect.stringContaining('[redacted]'),
    })
    expect(result.diagnostics?.causeMessage).not.toContain('abc.def.ghi')
    expect(result.diagnostics?.summary).toContain('Captured connection details are available in Technical details.')
    expect(result.diagnostics?.summary).not.toContain('Authorization')
    expect(isContinuableBlockedError(result)).toBe(true)
  })

  it.each(['Connection error.', 'OpenCode is unreachable', 'Failed to connect to OpenCode'])('explains explicitly reported communication failures: %s', (message) => {
    const result = buildOpenCodeBlockedErrorDiagnostics({
      error: Object.assign(new Error(message, { cause: { message: 'socket closed', code: 'ECONNRESET' } }), {
        openCodeOperation: 'checking the OpenCode session',
      }),
    })

    expect(result.diagnostics).toMatchObject({ kind: 'transport', transportCode: 'ECONNRESET' })
    expect(result.diagnostics?.summary).toContain('LoopTroop could not communicate with OpenCode while checking the OpenCode session.')
    expect(result.diagnostics?.summary).toContain('Captured connection details are available in Technical details.')
    expect(result.diagnostics?.summary).not.toContain('..')
  })

  it('retains connection details reported by the selected AI SDK retry record', () => {
    const result = buildOpenCodeBlockedErrorDiagnostics({ error: {
      name: 'AI_RetryError',
      errors: [{ message: 'fetch failed', cause: { code: 'ECONNRESET' } }],
    } })

    expect(result.diagnostics).toMatchObject({ kind: 'transport', transportCode: 'ECONNRESET' })
    expect(result.diagnostics?.summary).toContain('Captured connection details are available in Technical details.')
    expect(result.diagnostics?.summary).not.toContain('The exact connection cause was not reported.')
  })

  it('preserves provider details and timeout classification when causes are available', () => {
    const cause = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })
    const provider = buildOpenCodeBlockedErrorDiagnostics({ error: Object.assign(new Error('Provider returned error', { cause }), {
      openCodeOperation: 'sending the prompt or waiting for its response',
      modelErrorDetails: { statusCode: 429, responseErrorMessage: 'Provider usage limit reached' },
    }) })
    const timeout = buildOpenCodeBlockedErrorDiagnostics({ error: Object.assign(new Error('OpenCode request timed out', { cause }), {
      openCodeOperation: 'checking the OpenCode session',
    }) })

    expect(provider.errorCodes).toEqual([OPENCODE_PROVIDER_ERROR])
    expect(provider.diagnostics).toMatchObject({ kind: 'opencode_provider', statusCode: 429, transportCode: 'ECONNRESET', causeMessage: 'socket closed' })
    expect(provider.diagnostics?.summary).not.toContain('could not communicate')
    expect(timeout.diagnostics).toMatchObject({ kind: 'timeout', operation: 'checking the OpenCode session', summary: 'OpenCode request timed out' })
  })

  it.each(['invalid output shape', 'missing network field', 'missing unreachable field'])('does not invent a connection failure for a validation wrapper mentioning %s', (message) => {
    const result = buildOpenCodeBlockedErrorDiagnostics({ error: Object.assign(new Error(`Failed to prompt OpenCode session: ${message}`), {
      openCodeOperation: 'collecting the completed response',
    }) })

    expect(result.diagnostics?.summary).toBe(`Failed to prompt OpenCode session: ${message}`)
  })

  it('fills only missing identities when a higher-level caller supplies diagnostics context', () => {
    const error = attachOpenCodeBlockedErrorDiagnostics(new Error('wrapped connection failure'), {
      diagnostics: { kind: 'transport', source: 'opencode', summary: 'fetch failed', sessionId: 'actual-failed-session' },
      errorCodes: [],
    })
    const result = buildOpenCodeBlockedErrorDiagnostics({ error, modelId: 'winner/model', sessionId: 'older-session' })

    expect(result.diagnostics).toMatchObject({ modelId: 'winner/model', sessionId: 'actual-failed-session' })
    if (result.diagnostics) result.diagnostics.modelId = 'actual-failed-model'
    const modelError = attachOpenCodeBlockedErrorDiagnostics(error, result)
    expect(buildOpenCodeBlockedErrorDiagnostics({ error: modelError, modelId: 'other/model' }).diagnostics?.modelId)
      .toBe('actual-failed-model')
  })

  it('keeps available response metrics when the adapter attached diagnostics before the caller collected metadata', () => {
    const error = attachOpenCodeBlockedErrorDiagnostics(new Error('fetch failed'), {
      diagnostics: { kind: 'transport', source: 'opencode', summary: 'fetch failed', outputTokens: 0 },
      errorCodes: [],
    })
    const result = buildOpenCodeBlockedErrorDiagnostics({ error, responseMeta: {
      hasAssistantMessage: true, latestAssistantWasEmpty: false, latestAssistantHasError: false,
      latestAssistantWasStale: false, sessionErrored: false, latestStepFinishReason: 'stop',
      latestStepFinishTokens: { input: 100, output: 200, reasoning: 50, cache: { read: 20, write: 0 } },
    } })

    expect(result.diagnostics).toMatchObject({
      kind: 'transport', finishReason: 'stop', inputTokens: 100, outputTokens: 0,
      reasoningTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 0,
    })
  })

  it.each([
    { message: 'Output failed validation', reason: 'stop', kind: 'runtime', errorCodes: [] },
    { message: 'HTTP 429 provider rate limit', reason: 'stop', kind: 'opencode_provider', errorCodes: [OPENCODE_PROVIDER_ERROR] },
    { message: 'HTTP 429 provider rate limit', reason: 'length', kind: 'opencode_provider', errorCodes: [OPENCODE_PROVIDER_ERROR] },
  ])('retains reported $reason metrics without changing $kind classification', ({ message, reason, kind, errorCodes }) => {
    const result = buildOpenCodeBlockedErrorDiagnostics({
      error: new Error(message),
      modelId: 'provider/model-a',
      sessionId: 'session-a',
      responseMeta: {
        hasAssistantMessage: true,
        latestAssistantWasEmpty: false,
        latestAssistantHasError: false,
        latestAssistantWasStale: false,
        sessionErrored: false,
        latestStepFinishReason: reason,
        latestStepFinishTokens: { input: 100, output: 200, reasoning: 50, cache: { read: 20, write: 0 } },
      },
    })

    expect(result.errorCodes).toEqual(errorCodes)
    expect(result.diagnostics).toMatchObject({
      kind,
      modelId: 'provider/model-a',
      sessionId: 'session-a',
      finishReason: reason,
      inputTokens: 100,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
    })
  })

  it('does not treat token metrics on a successful response as an error', () => {
    expect(buildOpenCodeBlockedErrorDiagnostics({ responseMeta: {
      hasAssistantMessage: true,
      latestAssistantWasEmpty: false,
      latestAssistantHasError: false,
      latestAssistantWasStale: false,
      sessionErrored: false,
      latestStepFinishReason: 'stop',
      latestStepFinishTokens: { output: 100 },
    } })).toEqual({ diagnostics: null, errorCodes: [] })
  })

  it.each([
    'Input token limit exceeded',
    'Output token limit exceeded',
    'Maximum token capacity exceeded',
    'Invalid token count in model response',
    'Invalid token limit',
    'Invalid token capacity',
    'Invalid token usage',
  ])('does not misdiagnose a token usage or validation failure as authentication: %s', (message) => {
    const plain = buildOpenCodeBlockedErrorDiagnostics({ error: new Error(message) })
    const provider = buildOpenCodeBlockedErrorDiagnostics({ error: {
      statusCode: 400, responseErrorMessage: message,
    } })

    expect(plain.errorCodes).not.toContain(OPENCODE_PROVIDER_AUTH_FAILED)
    expect(provider.errorCodes).toEqual([OPENCODE_PROVIDER_ERROR])
    expect(provider.diagnostics).toMatchObject({ kind: 'opencode_provider', providerErrorMessage: message })
  })

  it.each([
    'Token has expired',
    'Token has been invalidated',
    'Token was revoked',
    'expired_token',
    'token_invalidated',
    'revoked_token',
    'Credentials rejected',
    'invalid_api_key',
    'API-key is invalid',
    'Request failed (HTTP 401)',
    'Your authentication token has expired (HTTP 403)',
    'invalid token',
    'token_invalid',
    'Unauthenticated',
  ])('retains explicit authentication failures: %s', (message) => {
    const result = buildOpenCodeBlockedErrorDiagnostics({ error: new Error(message) })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_AUTH_FAILED])
    expect(result.diagnostics?.kind).toBe('opencode_provider')
  })

  it.each(['Request failed (HTTP 403)', 'HTTP 403: content policy blocked this request', 'HTTP 403: Forbidden'])('does not assume a denied provider request means credentials expired: %s', (message) => {
    const result = buildOpenCodeBlockedErrorDiagnostics({ error: new Error(message) })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_ERROR])
    expect(result.diagnostics).toMatchObject({ kind: 'opencode_provider', statusCode: 403 })
  })

  it('identifies the configured provider when an expired-login event has only a message', () => {
    const message = 'Your authentication token has expired. Please try refreshing it.'
    const result = buildOpenCodeBlockedErrorDiagnostics({
      modelId: 'openai/gpt-6-luna-fast',
      sessionId: 'ses-readiness',
      attemptMeta: { errorSource: 'session_error', error: message, errorDetails: { message } },
    })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_AUTH_FAILED])
    expect(result.diagnostics).toMatchObject({
      modelId: 'openai/gpt-6-luna-fast', providerId: 'openai', providerModelId: 'gpt-6-luna-fast',
      sessionId: 'ses-readiness', summary: message,
    })
  })

  it('fills missing attached provider identities from the actual failed model rather than caller fallback', () => {
    const error = attachOpenCodeBlockedErrorDiagnostics(new Error('Provider login expired'), {
      diagnostics: { kind: 'opencode_provider', source: 'provider', summary: 'Token expired', modelId: 'openai/actual-model' },
      errorCodes: [OPENCODE_PROVIDER_AUTH_FAILED],
    })
    const result = buildOpenCodeBlockedErrorDiagnostics({ error, modelId: 'fallback/other-model' })

    expect(result.diagnostics).toMatchObject({ modelId: 'openai/actual-model', providerId: 'openai', providerModelId: 'actual-model' })
  })

  it('does not invent provider identity from an unqualified model alias', () => {
    const result = buildOpenCodeBlockedErrorDiagnostics({ error: new Error('Token expired'), modelId: 'model-alias' })

    expect(result.diagnostics?.providerId).toBeUndefined()
    expect(result.diagnostics?.providerModelId).toBeUndefined()
  })

  it('does not fill a reported provider model from a different configured provider', () => {
    const error = attachOpenCodeBlockedErrorDiagnostics(new Error('Provider failure'), {
      diagnostics: { kind: 'opencode_provider', source: 'provider', summary: 'Provider failure', providerId: 'actual-provider' },
      errorCodes: [OPENCODE_PROVIDER_ERROR],
    })
    const result = buildOpenCodeBlockedErrorDiagnostics({ error, modelId: 'fallback/other-model' })

    expect(result.diagnostics?.providerId).toBe('actual-provider')
    expect(result.diagnostics?.providerModelId).toBeUndefined()
  })

  it('classifies provider auth failures from structured OpenCode error details', () => {
    const result = buildOpenCodeBlockedErrorDiagnostics({
      modelId: 'openai/gpt-5.3-codex',
      sessionId: 'ses-auth',
      responseMeta: {
        hasAssistantMessage: false,
        latestAssistantWasEmpty: true,
        latestAssistantHasError: false,
        latestAssistantWasStale: false,
        sessionErrored: true,
        sessionError: 'Provider request failed',
        sessionErrorDetails: {
          name: 'APIError',
          data: {
            message: 'Your authentication token has been invalidated. Please try signing in again.',
            statusCode: 401,
            isRetryable: false,
            responseBody: JSON.stringify({
              error: {
                type: 'invalid_request_error',
                code: 'token_invalidated',
                message: 'Your authentication token has been invalidated. Please try signing in again.',
              },
            }),
          },
        },
      },
    })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_AUTH_FAILED])
    expect(result.diagnostics).toMatchObject({
      kind: 'opencode_provider',
      source: 'provider',
      modelId: 'openai/gpt-5.3-codex',
      sessionId: 'ses-auth',
      statusCode: 401,
      isRetryable: false,
      providerErrorType: 'invalid_request_error',
      providerErrorMessage: 'Your authentication token has been invalidated. Please try signing in again.',
    })
    expect(result.diagnostics?.summary).toContain('HTTP 401')
  })

  it('classifies non-auth provider failures generically', () => {
    const result = buildOpenCodeBlockedErrorDiagnostics({
      responseMeta: {
        hasAssistantMessage: true,
        latestAssistantWasEmpty: true,
        latestAssistantHasError: true,
        latestAssistantWasStale: false,
        latestAssistantError: 'Model usage limit reached',
        latestAssistantErrorInfo: {
          name: 'AI_APICallError',
          statusCode: 429,
          isRetryable: true,
          responseErrorType: 'rate_limit_error',
          responseErrorMessage: 'Model usage limit reached',
        },
      },
    })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_ERROR])
    expect(result.diagnostics).toMatchObject({
      kind: 'opencode_provider',
      source: 'provider',
      statusCode: 429,
      isRetryable: true,
      providerErrorType: 'rate_limit_error',
      providerErrorMessage: 'Model usage limit reached',
    })
  })

  it('carries OpenCode log-correlated provider identity into blocked diagnostics', () => {
    const result = buildOpenCodeBlockedErrorDiagnostics({
      modelId: 'configured/model-alias',
      error: Object.assign(new Error('Provider returned error'), {
        modelErrorDetails: {
          name: 'AI_APICallError',
          providerId: 'kilo',
          providerModelId: 'kilo-auto/free',
          requestModel: 'anthropic/claude-haiku-4.5',
          statusCode: 402,
          responseErrorType: 'usage_limit_exceeded',
          responseErrorTitle: 'Low Credit Warning!',
          responseErrorMessage: 'Add credits to continue, or switch to a free model',
        },
      }),
    })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_ERROR])
    expect(result.diagnostics).toMatchObject({
      kind: 'opencode_provider',
      source: 'provider',
      providerId: 'kilo',
      providerModelId: 'kilo-auto/free',
      requestModel: 'anthropic/claude-haiku-4.5',
      statusCode: 402,
      providerErrorType: 'usage_limit_exceeded',
      providerErrorTitle: 'Low Credit Warning!',
      providerErrorMessage: 'Add credits to continue, or switch to a free model',
    })
  })

  it('classifies plain OpenCode/provider error messages without structured metadata', () => {
    const result = buildOpenCodeBlockedErrorDiagnostics({
      error: new Error('rate_limit_error: Model usage limit reached (HTTP 429)'),
    })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_ERROR])
    expect(result.diagnostics).toMatchObject({
      kind: 'opencode_provider',
      source: 'provider',
      statusCode: 429,
      summary: 'rate_limit_error: Model usage limit reached (HTTP 429)',
    })
  })

  it('redacts sensitive raw values before diagnostics can be persisted', () => {
    const result = buildOpenCodeBlockedErrorDiagnostics({
      error: {
        name: 'APIError',
        data: {
          message: 'Provider failed',
          statusCode: 500,
          requestBodyValues: {
            apiKey: 'sk-secret-request-key',
          },
          responseBody: JSON.stringify({
            error: {
              type: 'server_error',
              message: 'token=sk-secret-response-token caused a provider failure',
            },
          }),
        },
      },
    })
    const serialized = JSON.stringify(result.diagnostics)

    expect(serialized).not.toContain('sk-secret-request-key')
    expect(serialized).not.toContain('sk-secret-response-token')
    expect(serialized).toContain('[redacted]')
  })

  it('appends an underlying error summary when it adds useful context', () => {
    const message = appendBlockedErrorDiagnosticsSummary('Relevant files scan failed validation after 1 structured retry attempt(s): empty', {
      kind: 'opencode_provider',
      source: 'provider',
      summary: 'rate_limit_error: Model usage limit reached (HTTP 429)',
    })

    expect(message).toContain('Relevant files scan failed validation')
    expect(message).toContain('Underlying OpenCode error: rate_limit_error')
  })

  it('classifies usage-limit retry messages captured from OpenCode session status events', () => {
    const result = buildOpenCodeBlockedErrorDiagnostics({
      modelId: 'openai/gpt-5.2',
      sessionId: 'ses-usage-limit',
      fallbackMessage: 'The usage limit has been reached',
    })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_ERROR])
    expect(result.diagnostics).toMatchObject({
      kind: 'opencode_provider',
      source: 'provider',
      summary: 'The usage limit has been reached',
      modelId: 'openai/gpt-5.2',
      sessionId: 'ses-usage-limit',
    })
  })

  it('explains OpenCode length-finished model output as a truncation limit', () => {
    const result = buildOpenCodeBlockedErrorDiagnostics({
      modelId: 'opencode-go/deepseek-v4-flash',
      sessionId: 'ses-length',
      responseMeta: {
        hasAssistantMessage: true,
        latestAssistantWasEmpty: false,
        latestAssistantHasError: false,
        latestAssistantWasStale: false,
        sessionErrored: false,
        latestStepFinishReason: 'length',
        latestStepFinishTokens: {
          input: 13252,
          output: 2923,
          reasoning: 29077,
        },
      },
    })

    expect(result.errorCodes).toEqual(['OPENCODE_OUTPUT_TRUNCATED'])
    expect(result.diagnostics).toMatchObject({
      kind: 'model_output_truncated',
      source: 'opencode',
      modelId: 'opencode-go/deepseek-v4-flash',
      providerId: 'opencode-go',
      providerModelId: 'deepseek-v4-flash',
      sessionId: 'ses-length',
      finishReason: 'length',
      inputTokens: 13252,
      outputTokens: 2923,
      reasoningTokens: 29077,
      isRetryable: false,
    })
    expect(result.diagnostics?.summary).toContain('output length limit')
    expect(result.diagnostics?.summary).toContain('missing sections')
  })

  it('preserves attached diagnostics when a higher-level wrapper error is normalized later', () => {
    const wrapper = attachOpenCodeBlockedErrorDiagnostics(
      new Error('Coverage output failed validation after 1 structured retry attempt(s): empty'),
      {
        diagnostics: {
          kind: 'opencode_provider',
          source: 'provider',
          summary: 'The usage limit has been reached',
          modelId: 'openai/gpt-5.2',
          sessionId: 'ses-usage-limit',
        },
        errorCodes: [OPENCODE_PROVIDER_ERROR],
      },
    )

    const result = buildOpenCodeBlockedErrorDiagnostics({
      error: wrapper,
      fallbackMessage: wrapper.message,
    })

    expect(result.errorCodes).toEqual([OPENCODE_PROVIDER_ERROR])
    expect(result.diagnostics).toMatchObject({
      kind: 'opencode_provider',
      source: 'provider',
      summary: 'The usage limit has been reached',
      modelId: 'openai/gpt-5.2',
      sessionId: 'ses-usage-limit',
    })
  })
})
