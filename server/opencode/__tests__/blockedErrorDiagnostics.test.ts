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

describe('OpenCode blocked error diagnostics', () => {
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
