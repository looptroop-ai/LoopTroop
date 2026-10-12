import { describe, expect, it } from 'vitest'
import { normalizeBlockedErrorDiagnostics, sanitizeDiagnosticText, sanitizeDiagnosticValue } from '../errorDiagnostics'

describe('shared blocked error diagnostics', () => {
  it('preserves full structured log evidence and repeated lines while redacting nested credentials', () => {
    const value = {
      message: `Your authentication token has expired.\n${'diagnostic line\n'.repeat(1000)}`,
      data: {
        error: { statusCode: 401, isRetryable: false, message: 'Reconnect the provider.' },
        headers: { '\u001b[31mAuthorization\u001b[0m': 'opaque-value', 'x-api-key': ['opaque-key'] },
        auth: { access: 'opaque-access', refresh: 'opaque-refresh' },
        credentials: { password: 'opaque-password' },
        parts: [{ sessionId: 'ses-real', inputTokens: 10 }, { sessionId: 'ses-real', inputTokens: 10 }],
        output: 'Connect https://user:pass@example.com/api?key=opaque-query#private',
      },
    }
    const clean = sanitizeDiagnosticValue(value)
    expect(clean).toEqual({
      message: value.message,
      data: {
        error: value.data.error,
        headers: { Authorization: '[redacted]', 'x-api-key': '[redacted]' },
        auth: '[redacted]',
        credentials: '[redacted]',
        parts: value.data.parts,
        output: 'Connect https://example.com/api',
      },
    })
    expect(sanitizeDiagnosticValue(clean)).toEqual(clean)
    expect(value.data.headers['x-api-key']).toEqual(['opaque-key'])
  })

  it('stops cyclic or excessive nesting with an explicit evidence marker', () => {
    const value: { cause?: unknown } = {}
    value.cause = value
    const clean = JSON.stringify(sanitizeDiagnosticValue(value))
    expect(clean).toContain('[details omitted: nesting limit]')
  })

  it.each([1, 2, 3])('redacts credentials in raw native records encoded %s extra times without changing evidence', (depth) => {
    const original = {
      apiKey: 'opaque-test-secret "embedded quote" \\ path\nmore evidence',
      refreshToken: 'opaque-test-refresh',
      headers: { authorization: 'opaque-test-auth', cookie: 'opaque-test-cookie' },
      sessionId: 'ses-test',
      modelId: 'model-test',
      statusCode: 401,
      evidence: ['repeated line', 'repeated line'],
    }
    let encoded = JSON.stringify(original, null, 2)
    let redacted = JSON.stringify({
      ...original,
      apiKey: '[redacted]',
      refreshToken: '[redacted]',
      headers: { authorization: '[redacted]', cookie: '[redacted]' },
    }, null, 2)
    for (let layer = 0; layer < depth; layer += 1) {
      encoded = JSON.stringify(encoded)
      redacted = JSON.stringify(redacted)
    }
    const prefix = 'ERROR sessionID=ses-test modelID=model-test marker=last-5 error='
    const suffix = '\nRepeated evidence\nRepeated evidence'
    const record = { data: { rawLine: `${prefix}${encoded}${suffix}` } }

    const clean = sanitizeDiagnosticValue(record)
    expect(clean).toEqual({ data: { rawLine: `${prefix}${redacted}${suffix}` } })
    expect(sanitizeDiagnosticValue(clean)).toEqual(clean)
    expect(record.data.rawLine).toContain('opaque-test-secret')
  })

  it.each([
    String.raw`apiKey=\"opaque-test-secret\" statusCode=401`,
    String.raw`{\"apiKey\":\"opaque-test-secret`,
    String.raw`{\"authorization\":\"opaque-test-secret` + '\\',
  ])('redacts escaped credentials with unquoted keys or clipped values: %s', (rawLine) => {
    const clean = sanitizeDiagnosticText(rawLine)
    expect(clean).not.toContain('opaque-test-secret')
    expect(clean).toContain('[redacted]')
    expect(sanitizeDiagnosticText(clean)).toBe(clean)
    if (rawLine.includes('statusCode')) expect(clean).toContain('statusCode=401')
  })

  it.each(['secretKey', 'secret_key', 'secret-key', 'client-secret', 'set-cookie', 'credentials', 'ssh_key', 'signing_key', 'passphrase', 'jwt', 'bearer'])('redacts %s consistently in structured and repeatedly encoded evidence', (key) => {
    const original = { [key]: 'opaque-review-secret', statusCode: 401, message: 'Keep this.' }
    const expected = { ...original, [key]: '[redacted]' }
    expect(sanitizeDiagnosticValue(original)).toEqual(expected)
    let encoded = JSON.stringify(original)
    let redacted = JSON.stringify(expected)
    for (let depth = 0; depth < 4; depth += 1) {
      expect(sanitizeDiagnosticText(encoded)).toBe(redacted)
      expect(sanitizeDiagnosticText(redacted)).toBe(redacted)
      encoded = JSON.stringify(encoded)
      redacted = JSON.stringify(redacted)
    }
    expect(sanitizeDiagnosticText(`${key}=opaque-review-secret statusCode=401`)).toBe(`${key}=[redacted] statusCode=401`)
  })

  it.each([1, 2, 3])('retains neighboring evidence when encoded secrets end in backslashes at depth %s', (depth) => {
    const original = { apiKey: 'opaque-secret\\', password: 'other-secret\\\\', next: 'KEEP' }
    const expected = { ...original, apiKey: '[redacted]', password: '[redacted]' }
    let encoded = JSON.stringify(original)
    let redacted = JSON.stringify(expected)
    for (let layer = 0; layer < depth; layer += 1) {
      encoded = JSON.stringify(encoded)
      redacted = JSON.stringify(redacted)
    }
    expect(sanitizeDiagnosticText(encoded)).toBe(redacted)
    expect(sanitizeDiagnosticText(redacted)).toBe(redacted)
  })

  it('stops an unclosed escaped credential at its native record boundary', () => {
    const first = String.raw`ERROR error={\"apiKey\":\"opaque-review-secret`
    const remaining = '\nERROR sessionID=ses-next statusCode=401 evidence=KEEP\nRepeated evidence\nRepeated evidence'
    expect(sanitizeDiagnosticText(`${first}${remaining}`)).toBe(`${String.raw`ERROR error={\"apiKey\":\"`}[redacted]${remaining}`)
  })

  it.each([0, 1, 2, 3])('keeps encoded JSON delimiters when removing URL credentials at depth %s', (depth) => {
    const original = {
      requestUrl: 'https://user:opaque-password@host.example/path?api_key=opaque-secret#opaque-fragment',
      backslashQuery: 'https://host.example/path?api_key=opaque-secret\\',
      statusCode: 401,
      evidence: 'Keep this.',
    }
    const expected = { ...original, requestUrl: 'https://host.example/path', backslashQuery: 'https://host.example/path' }
    let encoded = JSON.stringify(original)
    let redacted = JSON.stringify(expected)
    for (let layer = 0; layer < depth; layer += 1) {
      encoded = JSON.stringify(encoded)
      redacted = JSON.stringify(redacted)
    }
    expect(sanitizeDiagnosticText(`ERROR error=${encoded}\nKeep this record.`)).toBe(`ERROR error=${redacted}\nKeep this record.`)
    expect(sanitizeDiagnosticText(redacted)).toBe(redacted)
  })

  it('removes URL query credentials with a long internal backslash run and preserves closing delimiters', () => {
    const record = {
      requestUrl: `https://host.example/path?api_key=opaque-secret${'\\'.repeat(2000)}tail`,
      statusCode: 401,
      message: 'Keep this.',
    }
    const expected = { ...record, requestUrl: 'https://host.example/path' }
    expect(JSON.parse(sanitizeDiagnosticText(JSON.stringify(record)))).toEqual(expected)
    const encoded = JSON.stringify(JSON.stringify(record))
    expect(JSON.parse(JSON.parse(sanitizeDiagnosticText(encoded)))).toEqual(expected)
  })

  it.each(['credentials=opaque-review-secret statusCode=401', 'credentials: opaque-review-secret', 'credentials provided: opaque-review-secret'])('redacts plain credential containers: %s', (value) => {
    expect(sanitizeDiagnosticText(value)).not.toContain('opaque-review-secret')
    expect(sanitizeDiagnosticText(value)).toContain('[redacted]')
  })

  it('preserves pagination, process identity, credential flags and token usage metadata', () => {
    const value = {
      nextPageToken: 'opaque-pagination-cursor',
      startToken: 'opaque-process-identity',
      hasCredentials: false,
      isToken: true,
      tokenUsage: { inputTokens: 12, outputTokens: 14 },
      inputToken: 12,
      outputToken: 14,
      reasoningToken: 6,
      cacheReadToken: 8,
      cacheWriteToken: 9,
      sessionToken: 'opaque-review-secret',
      hasPassword: 'opaque-review-password',
    }
    const expected = { ...value, sessionToken: '[redacted]', hasPassword: '[redacted]' }
    expect(sanitizeDiagnosticValue(value)).toEqual(expected)
    expect(JSON.parse(sanitizeDiagnosticText(JSON.stringify(value)))).toEqual(expected)
    expect(sanitizeDiagnosticText('nextPageToken=cursor startToken=identity hasCredentials=false hasCookie=false input_tokens=12')).toBe('nextPageToken=cursor startToken=identity hasCredentials=false hasCookie=false input_tokens=12')
    expect(sanitizeDiagnosticText('inputToken=12 outputToken=14 reasoningToken=6 cacheReadToken=8 cacheWriteToken=9')).toBe('inputToken=12 outputToken=14 reasoningToken=6 cacheReadToken=8 cacheWriteToken=9')
    expect(sanitizeDiagnosticValue({ inputToken: 'opaque-review-secret', outputToken: '14', accessToken: 12 })).toEqual({ inputToken: '[redacted]', outputToken: '[redacted]', accessToken: '[redacted]' })
  })

  it('retains sanitized stack traces and all named doctor failures through repeated normalization', () => {
    const value = {
      summary: 'Readiness failed.',
      errorName: 'ProviderError',
      stackTrace: `ProviderError: access_token=opaque-secret\n${'    at probe (doctor.ts:1)\n'.repeat(1000)}`,
      failedChecks: [
        { name: 'OpenCode Execution Capability', category: 'connectivity', message: 'Your authentication token has expired.' },
        { name: 'GitHub Auth', category: 'git', message: 'Authorization: Bearer opaque-auth', details: 'refresh_token=opaque-refresh' },
        null,
        { name: 'invalid' },
      ],
    }
    const clean = normalizeBlockedErrorDiagnostics(value)
    expect(clean).toMatchObject({
      errorName: 'ProviderError',
      failedChecks: [
        value.failedChecks[0],
        { name: 'GitHub Auth', category: 'git', message: 'Authorization: [redacted]', details: 'refresh_token=[redacted]' },
      ],
    })
    expect(clean?.stackTrace).not.toContain('opaque-secret')
    expect(clean?.stackTrace?.length).toBeLessThanOrEqual(12000)
    expect(normalizeBlockedErrorDiagnostics(clean)).toEqual(clean)
  })

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

  it('retains rejected-password prose beside an explicit credential value', () => {
    expect(JSON.parse(sanitizeDiagnosticText(JSON.stringify({ apiKey: 'opaque-secret', reason: 'Server password rejected' })))).toEqual({ apiKey: '[redacted]', reason: 'Server password rejected' })
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

  it('keeps neighboring logfmt fields after an unquoted cookie field', () => {
    expect(sanitizeDiagnosticText('cookie=session=opaque-review-secret statusCode=401 sessionID=ses-real duration=22ms')).toBe('cookie=[redacted] statusCode=401 sessionID=ses-real duration=22ms')
    expect(sanitizeDiagnosticText('Cookie: session=opaque-review-secret; other=opaque-review-other\nKeep evidence.')).toBe('Cookie: [redacted]\nKeep evidence.')
  })

  it.each([
    ['set-cookie: session=opaque-review-secret session.id=ses-real model=gpt status=401 message=failed', 'set-cookie: [redacted] session.id=ses-real model=gpt status=401 message=failed'],
    ['cookie=opaque-review-secret,status=401 session=ses-real model=gpt message=failed', 'cookie=[redacted],status=401 session=ses-real model=gpt message=failed'],
    ['level=ERROR service=llm session.id=ses-real model=gpt status=401 set-cookie: opaque-review-secret message="failed"', 'level=ERROR service=llm session.id=ses-real model=gpt status=401 set-cookie: [redacted] message="failed"'],
    ['cookie=first-review-secret status=401 Cookie: first=second-review-secret; arbitrary=third-review-secret', 'cookie=[redacted] status=401 Cookie: [redacted]'],
    ['Cookie: first="first review secret"; arbitrary.name="second review secret"; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly; extension=third-review-secret', 'Cookie: [redacted]'],
    ["Cookie: arbitrary'name=first-review-secret'suffix; other=second-review-secret", 'Cookie: [redacted]'],
    ['Set-Cookie: first=first-review-secret,other=second-review-secret; Path=/; SameSite=Lax; Secure', 'Set-Cookie: [redacted]'],
    ['cookie provided: first-review-secret; arbitraryName=second-review-secret', 'cookie provided: [redacted]'],
  ])('keeps cookie evidence parseable without revealing header pairs: %s', (rawLine, expectedLine) => {
    const record = { rawLine, statusCode: 401, message: 'Keep this.', sessionId: 'ses-real' }
    const expected = { ...record, rawLine: expectedLine }
    expect(sanitizeDiagnosticText(rawLine)).toBe(expectedLine)
    expect(sanitizeDiagnosticValue(record)).toEqual(expected)
    let encoded = JSON.stringify(record, null, 2)
    let redacted = JSON.stringify(expected, null, 2)
    for (let depth = 0; depth < 4; depth += 1) {
      const cleaned = sanitizeDiagnosticText(encoded)
      expect(cleaned).toBe(redacted)
      expect(sanitizeDiagnosticText(cleaned)).toBe(cleaned)
      let decoded: unknown = cleaned
      for (let layer = 0; layer <= depth; layer += 1) decoded = JSON.parse(decoded as string)
      expect(decoded).toEqual(expected)
      encoded = JSON.stringify(encoded)
      redacted = JSON.stringify(redacted)
    }
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
