import { describe, expect, it } from 'vitest'
import { extractModelErrorInfo, summarizeModelErrorForLog } from '../errorDetails'

describe('OpenCode model error details', () => {
  it('keeps only sanitized messages and error codes from nested causes', () => {
    const error = new Error('wrapper', { cause: new TypeError('fetch failed', {
      cause: Object.assign(new Error('Authorization: Bearer abc.def.ghi failed for https://private-user:private-password@example.com/path?token=secret#fragment'), {
        code: 'ECONNRESET',
        headers: { authorization: 'private-header' },
        requestBody: 'private-prompt',
      }),
    }) })
    const info = extractModelErrorInfo(error)

    expect(info).toMatchObject({
      transportCode: 'ECONNRESET',
      causeMessage: 'Authorization: [redacted] failed for https://example.com/path',
    })
    const serialized = JSON.stringify(info)
    expect(serialized).not.toContain('abc.def.ghi')
    expect(serialized).not.toContain('?token')
    expect(serialized).not.toContain('private-header')
    expect(serialized).not.toContain('private-prompt')
    expect(serialized).not.toContain('private-user')
    expect(serialized).not.toContain('private-password')
  })

  it('bounds cyclic and long cause chains', () => {
    const cyclic = Object.assign(new Error('socket closed'), { code: 'ECONNRESET', cause: undefined as unknown })
    cyclic.cause = cyclic
    expect(extractModelErrorInfo(new TypeError('fetch failed', { cause: cyclic }))).toMatchObject({
      transportCode: 'ECONNRESET',
      causeMessage: 'socket closed',
    })

    let chain = new Error('outside the inspection bound')
    for (let index = 0; index < 20; index += 1) chain = new Error(`cause ${index}`, { cause: chain })
    expect(extractModelErrorInfo(chain)?.causeMessage).not.toBe('outside the inspection bound')
    const aggregate = new AggregateError([], 'socket failures')
    aggregate.errors.push(aggregate)
    expect(extractModelErrorInfo(aggregate)?.message).toBe('socket failures')
  })

  it('extracts reported socket errors from a bounded aggregate cause', () => {
    const error = new TypeError('fetch failed', { cause: new AggregateError([
      Object.assign(new Error('first address refused'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('second address unreachable'), { code: 'ENETUNREACH' }),
    ], 'multiple addresses failed') })

    expect(extractModelErrorInfo(error)).toMatchObject({
      transportCode: 'ENETUNREACH',
      causeMessage: 'second address unreachable',
    })
  })

  it('redacts a complete cause message before clipping it', () => {
    const credential = ['ghp', '1234567890abcdefghijklmnopqrstuvwxyz'].join('_')
    const error = new TypeError('fetch failed', { cause: new Error(`${'x'.repeat(270)} ${credential}`) })
    const info = extractModelErrorInfo(error)

    expect(info?.causeMessage).toHaveLength(280)
    expect(info?.causeMessage).not.toContain(credential.slice(0, 6))
  })

  it('extracts top-level provider error_type with nested title and message', () => {
    const info = extractModelErrorInfo({
      name: 'AI_APICallError',
      statusCode: 402,
      requestBodyValues: {
        model: 'anthropic/claude-haiku-4.5',
        messages: [{ role: 'user', content: 'do not persist this prompt' }],
      },
      responseBody: JSON.stringify({
        error: {
          title: 'Low Credit Warning!',
          message: 'Add credits to continue, or switch to a free model',
        },
        error_type: 'usage_limit_exceeded',
      }),
    })

    expect(info).toMatchObject({
      requestModel: 'anthropic/claude-haiku-4.5',
      statusCode: 402,
      responseErrorType: 'usage_limit_exceeded',
      responseErrorTitle: 'Low Credit Warning!',
      responseErrorMessage: 'Add credits to continue, or switch to a free model',
    })
    expect(JSON.stringify(info)).not.toContain('do not persist this prompt')
  })

  it('uses detail.code when provider body has no explicit message', () => {
    expect(extractModelErrorInfo({
      name: 'AI_APICallError',
      statusCode: 402,
      responseBody: JSON.stringify({
        detail: {
          code: 'deactivated_workspace',
        },
      }),
    })).toMatchObject({
      responseErrorMessage: 'deactivated_workspace',
    })
  })

  it('extracts the final nested AI_RetryError API call error', () => {
    const info = extractModelErrorInfo({
      name: 'AI_RetryError',
      reason: 'maxRetriesExceeded',
      errors: [
        {
          name: 'AI_APICallError',
          statusCode: 429,
          isRetryable: true,
          responseBody: JSON.stringify({
            error: {
              type: 'usage_limit_reached',
              message: 'The usage limit has been reached',
            },
          }),
        },
      ],
    })

    expect(info).toMatchObject({
      name: 'AI_APICallError',
      statusCode: 429,
      isRetryable: true,
      responseErrorType: 'usage_limit_reached',
      responseErrorMessage: 'The usage limit has been reached',
    })
  })

  it('redacts credentials and strips URL query strings from persisted previews', () => {
    const info = extractModelErrorInfo({
      name: 'AI_APICallError',
      url: 'https://api.example.com/v1/chat?api_key=sk-url-secret#frag',
      responseBody: JSON.stringify({
        error: {
          type: 'server_error',
          message: 'Authorization: Bearer abc.def.ghi failed for https://example.com/path?token=sk-query-secret',
        },
      }),
    })
    const summary = summarizeModelErrorForLog(info)
    const serialized = JSON.stringify({ info, summary })

    expect(info?.url).toBe('https://api.example.com/v1/chat')
    expect(serialized).not.toContain('sk-url-secret')
    expect(serialized).not.toContain('abc.def.ghi')
    expect(serialized).not.toContain('sk-query-secret')
    expect(serialized).toContain('[redacted]')
    expect(serialized).toContain('https://example.com/path')
  })

  it.each([
    ['ghp', '1234567890abcdefghijklmnopqrstuvwxyz'].join('_'),
    ['AKIA', '1234567890ABCDEF'].join(''),
    'AIzaSyA1234567890abcdefghijklmnopqrstu',
  ])('redacts credentials crossing the preview boundary before shortening: %s', (credential) => {
    const responseBody = `${'x'.repeat(270)} ${credential}`
    const info = extractModelErrorInfo({ name: 'AI_APICallError', responseBody })

    expect(info?.responseBodyPreview).toHaveLength(280)
    expect(info?.responseBodyPreview).not.toContain(credential.slice(0, 6))
  })

  it('cleans obfuscated credential fields at source and keeps provider prose readable', () => {
    const message = 'Your authentication token has been invalidated. Authorization is required.'
    const info = extractModelErrorInfo({
      name: 'AI_APICallError',
      message,
      responseBody: '{"api_\u001b[31mkey":"privatevalue123","token":"privatevalue456","cookie":"session123"}',
    })

    expect(info?.message).toBe(message)
    expect(info?.responseBodyPreview).toBe('{"api_key":"[redacted]","token":"[redacted]","cookie":"[redacted]"}')
  })
})
