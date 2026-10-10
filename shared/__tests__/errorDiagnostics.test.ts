import { describe, expect, it } from 'vitest'
import { normalizeBlockedErrorDiagnostics, sanitizeDiagnosticText } from '../errorDiagnostics'

describe('shared blocked error diagnostics', () => {
  it('redacts common credential patterns from diagnostic text', () => {
    const diagnostics = normalizeBlockedErrorDiagnostics({
      summary: [
        'Authorization: Bearer auth-token-123',
        'Authorization Bearer auth-token-456',
        'Bearer standalone-token-456',
        'api key: api-key-789',
        'api key api-key-word-form',
        'access_token=access-token-123',
        'refresh token=refresh-token-123',
        'password=hunter2',
        'secret is secret-token-123',
        'sk-openai-secret-123',
      ].join('\n'),
    })

    expect(diagnostics?.summary).toContain('[redacted]')
    expect(diagnostics?.summary).not.toContain('auth-token-123')
    expect(diagnostics?.summary).not.toContain('auth-token-456')
    expect(diagnostics?.summary).not.toContain('standalone-token-456')
    expect(diagnostics?.summary).not.toContain('api-key-789')
    expect(diagnostics?.summary).not.toContain('api-key-word-form')
    expect(diagnostics?.summary).not.toContain('access-token-123')
    expect(diagnostics?.summary).not.toContain('refresh-token-123')
    expect(diagnostics?.summary).not.toContain('hunter2')
    expect(diagnostics?.summary).not.toContain('secret-token-123')
    expect(diagnostics?.summary).not.toContain('sk-openai-secret-123')
  })

  it.each([
    'token',
    'accessToken',
    'refresh_token',
    'aws_secret_access_key',
    'private_key',
    'client_secret',
    'clientSecret',
    'service_api_key',
  ])('redacts the complete quoted value for %s without changing JSON structure', (key) => {
    const diagnostics = normalizeBlockedErrorDiagnostics({
      summary: 'Provider error',
      responseBodyPreview: JSON.stringify({ [key]: 'private value with "quotes"\nand lines', message: 'Keep this.' }, null, 2),
    })

    expect(JSON.parse(diagnostics?.responseBodyPreview ?? '')).toEqual({
      [key]: '[redacted]',
      message: 'Keep this.',
    })
  })

  it.each([
    'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    'github_pat_1234567890abcdefghijklmnopqrstuvwxyz',
    'xoxb-123456789012-abcdefghijklmnop',
    'xoxp-123456789012-abcdefghijklmnop',
    'AKIA1234567890ABCDEF',
    'AIzaSyA1234567890abcdefghijklmnopqrstu',
  ])('redacts recognizable standalone credentials: %s', (credential) => {
    const diagnostics = normalizeBlockedErrorDiagnostics({
      summary: 'Provider error',
      responseBodyPreview: `Request rejected: ${credential}`,
    })

    expect(diagnostics?.responseBodyPreview).toBe('Request rejected: [redacted]')
  })

  it('cleans formatting before detecting credentials and preserves repeated structured lines', () => {
    const responseBodyPreview = [
      '{',
      '  "api_\u001b[31mkey": "privatevalue123",',
      '  "to\u0007ken": "privatevalue456",',
      '  "responses": [',
      '    {},',
      '    {},',
      '    {}',
      '  ]',
      '}',
    ].join('\r\n')
    const diagnostics = normalizeBlockedErrorDiagnostics({ summary: 'Provider error', responseBodyPreview })

    expect(diagnostics?.responseBodyPreview).toBe(responseBodyPreview
      .replace('\u001b[31m', '')
      .replace('\u0007', '')
      .replace(/\r\n/g, '\n')
      .replace('privatevalue123', '[redacted]')
      .replace('privatevalue456', '[redacted]'))
    expect(JSON.parse(diagnostics?.responseBodyPreview ?? '')).toEqual({
      api_key: '[redacted]',
      token: '[redacted]',
      responses: [{}, {}, {}],
    })
  })

  it('redacts before truncation and remains safe when normalized again', () => {
    const responseBodyPreview = `${' '.repeat(980)}{"token":"${'privatevalue'.repeat(100)}"}`
    const diagnostics = normalizeBlockedErrorDiagnostics({
      summary: 'Provider error',
      responseBodyPreview: `{"message":"${'x'.repeat(970)}","token":"${'privatevalue'.repeat(100)}"}`,
      providerErrorMessage: responseBodyPreview,
    })

    expect(diagnostics?.responseBodyPreview?.length).toBeLessThanOrEqual(1000)
    expect(diagnostics?.responseBodyPreview).not.toContain('privatevalue')
    expect(diagnostics?.providerErrorMessage).toBe('{"token":"[redacted]"}')
    expect(normalizeBlockedErrorDiagnostics(diagnostics)).toEqual(diagnostics)
  })

  it('keeps ordinary provider prose about tokens and authorization readable', () => {
    const summary = 'Your authentication token has been invalidated. Authorization is required. Token limit exceeded.'

    expect(normalizeBlockedErrorDiagnostics({ summary })?.summary).toBe(summary)
  })

  it.each(['Authorization privatevalue123', 'Authorization is privatevalue123'])('redacts legacy authorization word forms: %s', (summary) => {
    expect(normalizeBlockedErrorDiagnostics({ summary })?.summary).not.toContain('privatevalue123')
    expect(normalizeBlockedErrorDiagnostics({ summary })?.summary).toContain('[redacted]')
  })

  it('redacts explicit authorization assignments even when their value resembles prose', () => {
    expect(sanitizeDiagnosticText('Authorization: required.')).toBe('Authorization: [redacted]')
    expect(sanitizeDiagnosticText('Authorization failed. Authorization is not available.')).toBe('Authorization failed. Authorization is not available.')
  })

  it('processes long noncredential field names without retrying at each separator', () => {
    const prefix = 'a-'.repeat(10000)
    const ordinary = `${prefix}ordinary-field: readable`
    const started = performance.now()

    expect(sanitizeDiagnosticText(ordinary)).toBe(ordinary)
    expect(sanitizeDiagnosticText(`${prefix}api-key: privatevalue123`)).toBe(`${prefix}api-key: [redacted]`)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it.each(['{"token":"privatevalue...', "private_key='privatevalue...", '{"token":"privatevalue\\'])('redacts already clipped quoted credentials: %s', (responseBodyPreview) => {
    const diagnostics = normalizeBlockedErrorDiagnostics({ summary: 'Provider error', responseBodyPreview })

    expect(diagnostics?.responseBodyPreview).toContain('[redacted]')
    expect(diagnostics?.responseBodyPreview).not.toContain('privatevalue')
    expect(normalizeBlockedErrorDiagnostics(diagnostics)).toEqual(diagnostics)
  })

  it('normalizes model output truncation diagnostics and token counts', () => {
    const diagnostics = normalizeBlockedErrorDiagnostics({
      kind: 'model_output_truncated',
      source: 'opencode',
      summary: 'The model stopped because OpenCode reported finish reason "length".',
      finishReason: 'length',
      outputTokens: 2923,
      reasoningTokens: 29077,
      inputTokens: 13252,
    })

    expect(diagnostics).toMatchObject({
      kind: 'model_output_truncated',
      source: 'opencode',
      finishReason: 'length',
      outputTokens: 2923,
      reasoningTokens: 29077,
      inputTokens: 13252,
    })
  })

  it('normalizes OpenCode provider identity fields', () => {
    const diagnostics = normalizeBlockedErrorDiagnostics({
      kind: 'opencode_provider',
      source: 'provider',
      summary: 'Low Credit Warning!: Add credits to continue, or switch to a free model (HTTP 402)',
      providerId: 'kilo',
      providerModelId: 'kilo-auto/free',
    })

    expect(diagnostics).toMatchObject({
      providerId: 'kilo',
      providerModelId: 'kilo-auto/free',
    })
  })
})
