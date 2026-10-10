import { describe, expect, it } from 'vitest'
import { normalizeBlockedErrorDiagnostics, sanitizeDiagnosticText } from '../errorDiagnostics'

describe('shared blocked error diagnostics', () => {
  it('keeps bounded, sanitized connection context through repeated normalization', () => {
    const diagnostics = normalizeBlockedErrorDiagnostics({
      kind: 'transport',
      source: 'opencode',
      summary: 'Communication with OpenCode failed.',
      operation: '\u001b[31mWaiting for the session to become idle\u001b[0m',
      transportCode: 'ECONNRESET',
      causeMessage: `socket closed; Authorization: Bearer privatevalue123 ${'x'.repeat(1200)}`,
    })

    expect(diagnostics).toMatchObject({
      operation: 'Waiting for the session to become idle',
      transportCode: 'ECONNRESET',
    })
    expect(diagnostics?.causeMessage).toContain('socket closed; Authorization: [redacted]')
    expect(diagnostics?.causeMessage).not.toContain('privatevalue123')
    expect(diagnostics?.causeMessage?.length).toBeLessThanOrEqual(1000)
    expect(normalizeBlockedErrorDiagnostics(diagnostics)).toEqual(diagnostics)
  })

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
    'openaiApiKey',
    'dbPassword',
    'userPassword',
    'awsSecretAccessKey',
    'sessionToken',
    'authToken',
    'idToken',
    'csrfToken',
    'bearerToken',
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

  it.each(['\n', '\r\n', '\t\n ', ' \r\n\t'])('redacts quoted JSON credentials across whitespace %j', (whitespace) => {
    const responseBodyPreview = `{"api_key"${whitespace}:${whitespace}"opaque-private-value","authorization"${whitespace}:${whitespace}"Token opaque-auth-value","cookie"${whitespace}:${whitespace}"a=opaque-cookie-value; sessionid=opaque-session-value","message":"Keep this."}`
    const diagnostics = normalizeBlockedErrorDiagnostics({ summary: 'Provider error', responseBodyPreview })

    expect(JSON.parse(diagnostics?.responseBodyPreview ?? '')).toEqual({
      api_key: '[redacted]',
      authorization: '[redacted]',
      cookie: '[redacted]',
      message: 'Keep this.',
    })
    expect(normalizeBlockedErrorDiagnostics(diagnostics)).toEqual(diagnostics)
  })

  it.each([
    'api_key=\nopaque-private-value',
    'password\r\n=\r\nopaque-private-value',
    'Authorization header:\nToken opaque-private-value',
    'Authorization:\nBearer\nopaque-private-value',
    'Authorization:\r\nBasic\r\nopaque-private-value',
    'Authorization Bearer\nopaque-private-value',
    'Bearer\nopaque-private-value',
    'Basic\r\nopaque-private-value',
    'Cookie header:\r\na=opaque-private-value; sessionid=opaque-session-value',
    'API key provided:\nopaque-private-value',
  ])('redacts explicit credentials with line breaks: %j', (value) => {
    const diagnostics = normalizeBlockedErrorDiagnostics({ summary: value, causeMessage: value, responseBodyPreview: value })

    expect(diagnostics?.summary).toContain('[redacted]')
    expect(diagnostics?.summary).not.toContain('opaque-private-value')
    expect(diagnostics?.summary).not.toContain('opaque-session-value')
    expect(diagnostics?.causeMessage).toBe(diagnostics?.summary)
    expect(diagnostics?.responseBodyPreview).toBe(diagnostics?.summary)
    expect(normalizeBlockedErrorDiagnostics(diagnostics)).toEqual(diagnostics)
  })

  it('preserves unrelated lines after ordinary credential prose', () => {
    const value = 'API key not valid.\nPlease pass a valid API key.\nMissing Authorization header.\nThe password\nhas expired.\nCookie\nbanner unavailable.'

    expect(sanitizeDiagnosticText(value)).toBe(value)
  })

  it.each([
    'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz',
    'github_pat_1234567890abcdefghijklmnopqrstuvwxyz',
    'xoxb-123456789012-abcdefghijklmnop',
    'xoxp-123456789012-abcdefghijklmnop',
    'AKIA' + '1234567890ABCDEF',
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
    const summary = 'Your authentication token has been invalidated. Authorization is required. Missing Authorization header. Cookie banner unavailable. Set-Cookie headers are missing. Token limit exceeded.'

    expect(normalizeBlockedErrorDiagnostics({ summary })?.summary).toBe(summary)
  })

  it.each(['Authorization privatevalue123', 'Authorization is privatevalue123'])('redacts legacy authorization word forms: %s', (summary) => {
    expect(normalizeBlockedErrorDiagnostics({ summary })?.summary).not.toContain('privatevalue123')
    expect(normalizeBlockedErrorDiagnostics({ summary })?.summary).toContain('[redacted]')
  })

  it.each(['Authorization: Basic', 'Authorization=Basic', 'Authorization Basic', 'authorization: basic'])('redacts the complete unquoted Basic credential: %s', (prefix) => {
    const value = `${prefix} Zm9vOmJhcg==`
    const diagnostics = normalizeBlockedErrorDiagnostics({ summary: value, responseBodyPreview: value })

    expect(diagnostics?.summary).toContain('[redacted]')
    expect(diagnostics?.summary).not.toContain('Zm9vOmJhcg==')
    expect(diagnostics?.responseBodyPreview).not.toContain('Zm9vOmJhcg==')
  })

  it('redacts explicit authorization assignments even when their value resembles prose', () => {
    expect(sanitizeDiagnosticText('Authorization: required.')).toBe('Authorization: [redacted]')
    expect(sanitizeDiagnosticText('Authorization failed. Authorization is not available.')).toBe('Authorization failed. Authorization is not available.')
  })

  it.each([
    'Authorization header: Basic Zm9vOmJhcg==',
    'Authorization header value: Token privatevalue123',
    'Authorization header = Basic Zm9vOmJhcg==',
    'Authorization header is Basic Zm9vOmJhcg==',
    'Authorization: Token privatevalue123',
    'Authorization has privatevalue123',
    'Authorization is not privatevalue123',
    'Basic Zm9vOmJhcg== rejected by proxy',
    'x-api-key header: privatevalue123',
    'Incorrect API key provided: privatevalue123',
    'Authorization code: privatevalue123',
    'Cookie banner unavailable. Cookie session=privatevalue123',
  ])('redacts complete credentials after header labels and schemes: %s', (value) => {
    const diagnostics = normalizeBlockedErrorDiagnostics({ summary: value, causeMessage: value, responseBodyPreview: value })

    expect(diagnostics?.summary).toContain('[redacted]')
    expect(diagnostics?.summary).not.toContain('privatevalue123')
    expect(diagnostics?.summary).not.toContain('Zm9vOmJhcg==')
    expect(diagnostics?.causeMessage).toBe(diagnostics?.summary)
    expect(diagnostics?.responseBodyPreview).toBe(diagnostics?.summary)
    expect(normalizeBlockedErrorDiagnostics(diagnostics)).toEqual(diagnostics)
  })

  it.each([
    'Cookie: a=privatevalue123; sessionid=privatevalue456',
    'Cookie header: a=privatevalue123; sessionid=privatevalue456',
    'Cookie header value: a=privatevalue123; sessionid=privatevalue456',
    'Cookie header is a=privatevalue123; sessionid=privatevalue456',
    'Set-Cookie: a=privatevalue123; HttpOnly; sessionid=privatevalue456',
  ])('redacts the entire cookie header line: %s', (value) => {
    expect(sanitizeDiagnosticText(`${value}\nKeep this line.`)).toMatch(/\[redacted\]\nKeep this line\.$/)
    expect(sanitizeDiagnosticText(value)).not.toContain('privatevalue')
  })

  it('keeps quoted cookie JSON structure and neighboring diagnostics intact', () => {
    const diagnostics = normalizeBlockedErrorDiagnostics({
      summary: 'Provider rejected the request.',
      responseBodyPreview: JSON.stringify({ cookie: 'a=privatevalue123; sessionid=privatevalue456', message: 'Keep this.' }),
    })

    expect(JSON.parse(diagnostics?.responseBodyPreview ?? '')).toEqual({ cookie: '[redacted]', message: 'Keep this.' })
  })

  it.each([
    'API key not valid. Please pass a valid API key.',
    'The secret has been rotated.',
    'The password has expired.',
    'The cookie is stale.',
    'Authorization header is required.',
    'Authorization header value is invalid.',
    'Cookie header value is stale.',
    'Authorization is not available.',
    'Missing Authorization header.',
    'max_tokens=12 input_tokens=13 prompt_token_count=14 tokens=15 passwordHint=readable',
  ])('preserves ordinary credential-related prose and metrics: %s', (value) => {
    expect(sanitizeDiagnosticText(value)).toBe(value)
  })

  it.each([
    ['https://user:password123@host.example/api?api_key=privatevalue123#privatevalue456', 'https://host.example/api'],
    ['https://user:password123@host.example:99999/api?opaque=privatevalue123', 'https://host.example:99999/api'],
    ['https://user:private?value@host.example/path', 'https://host.example/path'],
    ['https://user:private#value@host.example/path', 'https://host.example/path'],
    ['https://user:password123@', 'https://'],
    ['wss://user:password123@host.example/socket?opaque=privatevalue123', 'wss://host.example/socket'],
    ['https://host.example/user@path', 'https://host.example/user@path'],
    ['https://host.example?email=user@other.example', 'https://host.example'],
    ['https://user:password123@host.example?email=user@other.example', 'https://host.example'],
  ])('removes URL credentials and parameters before persistence: %s', (url, sanitizedUrl) => {
    const diagnostics = normalizeBlockedErrorDiagnostics({ summary: `Failed to fetch ${url}`, causeMessage: url, responseBodyPreview: JSON.stringify({ url }) })

    expect(diagnostics?.summary).toBe(`Failed to fetch ${sanitizedUrl}`)
    expect(diagnostics?.causeMessage).toBe(sanitizedUrl)
    expect(JSON.parse(diagnostics?.responseBodyPreview ?? '')).toEqual({ url: sanitizedUrl })
    expect(normalizeBlockedErrorDiagnostics(diagnostics)).toEqual(diagnostics)
  })

  it('processes long noncredential field names without retrying at each separator', () => {
    const prefix = 'a-'.repeat(100000)
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
