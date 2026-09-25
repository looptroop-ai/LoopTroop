import { createHash } from 'node:crypto'
import { getOpenCodeBasicAuthHeader, getOpenCodeV2BasicAuthHeader } from '../../shared/opencodeAuth'

export type OpenCodeProtocol = 'v1' | 'v2'
export type OpenCodeFailureKind = 'authentication' | 'unsupported_protocol' | 'network'

export interface OpenCodeConnection {
  protocol: OpenCodeProtocol
  version: string
  headers: Record<string, string>
}

export class OpenCodeConnectionError extends Error {
  constructor(
    readonly failureKind: OpenCodeFailureKind,
    message: string,
    readonly status?: number,
    readonly canStartManagedServer = false,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'OpenCodeConnectionError'
  }
}

const CONNECTION_TIMEOUT_MS = 2_000
const connectionCache = new Map<string, { origin: string; value: OpenCodeConnection }>()

function credentials(env: NodeJS.ProcessEnv = process.env) {
  return {
    v2: getOpenCodeV2BasicAuthHeader(env),
    v1: getOpenCodeBasicAuthHeader(env),
  }
}

function cacheIdentity(baseUrl: string, auth: ReturnType<typeof credentials>) {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch (cause) {
    throw new OpenCodeConnectionError('unsupported_protocol', 'OpenCode base URL is invalid.', undefined, false, { cause })
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new OpenCodeConnectionError('unsupported_protocol', 'OpenCode base URL must use HTTP or HTTPS.')
  }
  const origin = parsed.origin
  let pathEnd = parsed.pathname.length
  while (pathEnd > 0 && parsed.pathname[pathEnd - 1] === '/') pathEnd -= 1
  const base = `${origin}${parsed.pathname.slice(0, pathEnd)}`
  // Hash the exact wire credentials so cache identity follows protocol-specific
  // normalization (including v2 passwords that intentionally preserve spaces).
  const fingerprint = createHash('sha256').update(JSON.stringify({ v1: auth.v1, v2: auth.v2 })).digest('hex')
  return { origin, base, key: `${base}\u0000${fingerprint}` }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CONNECTION_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if ('code' in error && typeof error.code === 'string') return error.code
  if ('cause' in error) return errorCode(error.cause)
  return undefined
}

async function request(
  url: string,
  authorization: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Response> {
  try {
    return await fetch(url, {
      redirect: 'manual',
      ...(authorization ? { headers: { Authorization: authorization } } : {}),
      signal: requestSignal(signal),
    })
  } catch (cause) {
    if (signal?.aborted) throw signal.reason
    const code = errorCode(cause)
    throw new OpenCodeConnectionError(
      'network',
      'Could not reach the OpenCode server.',
      undefined,
      code === 'ECONNREFUSED',
      { cause },
    )
  }
}

function responseError(response: Response, kind: OpenCodeFailureKind, description: string): OpenCodeConnectionError {
  return new OpenCodeConnectionError(kind, `${description} (HTTP ${response.status}).`, response.status)
}

async function jsonResponse(response: Response, description: string): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw responseError(response, 'unsupported_protocol', `${description} did not return JSON`)
  }
  let value: unknown
  try {
    value = await response.json()
  } catch (cause) {
    throw new OpenCodeConnectionError(
      'unsupported_protocol',
      `${description} returned invalid JSON (HTTP ${response.status}).`,
      response.status,
      false,
      { cause },
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw responseError(response, 'unsupported_protocol', `${description} returned an unexpected response`)
  }
  return value as Record<string, unknown>
}

function majorVersion(value: unknown, major: 1 | 2): value is string {
  return typeof value === 'string' && new RegExp(`^v?${major}\\.\\d+\\.\\d+(?:[-+].*)?$`).test(value.trim())
}

function authFailure(response: Response): OpenCodeConnectionError {
  return responseError(response, 'authentication', 'OpenCode rejected the configured credentials')
}

async function probeV1(
  base: string,
  authorization: string | undefined,
  signal?: AbortSignal,
  priorResponse?: Response,
): Promise<OpenCodeConnection> {
  let response: Response
  try {
    response = await request(`${base}/global/health`, authorization, signal)
  } catch (error) {
    if (priorResponse && error instanceof OpenCodeConnectionError) {
      if (priorResponse.status === 401 || priorResponse.status === 403) throw authFailure(priorResponse)
      throw new OpenCodeConnectionError(error.failureKind, error.message, error.status, false, { cause: error })
    }
    throw error
  }

  if (response.status === 401 || response.status === 403) {
    throw authFailure(priorResponse && (priorResponse.status === 401 || priorResponse.status === 403)
      ? priorResponse
      : response)
  }
  if (response.status >= 300 && response.status < 400) {
    throw responseError(response, 'unsupported_protocol', 'OpenCode health probe redirected')
  }
  if (!response.ok) {
    const kind = response.status >= 500 ? 'network' : 'unsupported_protocol'
    throw responseError(response, kind, 'OpenCode v1 health probe failed')
  }
  const value = await jsonResponse(response, 'OpenCode v1 health probe')
  if (!majorVersion(value.version, 1)) {
    throw responseError(response, 'unsupported_protocol', 'OpenCode v1 health probe returned an unrecognized response')
  }
  if (value.healthy !== true) {
    throw responseError(response, 'network', 'OpenCode v1 server is not healthy')
  }
  return {
    protocol: 'v1',
    version: value.version,
    headers: authorization ? { Authorization: authorization } : {},
  }
}

async function probe(base: string, auth: ReturnType<typeof credentials>, signal?: AbortSignal): Promise<OpenCodeConnection> {
  const v2 = await request(`${base}/api/info`, auth.v2, signal)
  if (v2.status === 401 || v2.status === 403) {
    // A v1 server may authenticate before routing and reject v2's fixed-user
    // attempt. Probe its health route even when both protocol headers match.
    if (auth.v1) {
      try {
        return await probeV1(base, auth.v1, signal, v2)
      } catch (error) {
        if (error instanceof OpenCodeConnectionError && error.failureKind === 'unsupported_protocol') {
          throw authFailure(v2)
        }
        throw error
      }
    }
    throw authFailure(v2)
  }
  if (v2.status >= 300 && v2.status < 400) {
    throw responseError(v2, 'unsupported_protocol', 'OpenCode v2 info probe redirected')
  }
  if (v2.status === 404 || v2.status === 405) {
    return probeV1(base, auth.v1, signal, v2)
  }
  if (v2.status >= 500) {
    throw responseError(v2, 'network', 'OpenCode v2 info probe failed')
  }
  if (!v2.ok) {
    throw responseError(v2, 'unsupported_protocol', 'OpenCode v2 info probe failed')
  }
  let value: Record<string, unknown>
  try {
    value = await jsonResponse(v2, 'OpenCode v2 info probe')
  } catch (error) {
    if (!(error instanceof OpenCodeConnectionError) || error.failureKind !== 'unsupported_protocol') throw error
    return probeV1(base, auth.v1, signal, v2)
  }
  if (!majorVersion(value.version, 2) || typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) {
    return probeV1(base, auth.v1, signal, v2)
  }
  return {
    protocol: 'v2',
    version: value.version,
    headers: auth.v2 ? { Authorization: auth.v2 } : {},
  }
}

/** Resolves the server protocol once per origin and credential set. */
export async function getOpenCodeConnection(baseUrl: string, signal?: AbortSignal): Promise<OpenCodeConnection> {
  if (signal?.aborted) throw signal.reason
  const auth = credentials()
  const identity = cacheIdentity(baseUrl, auth)
  const cached = connectionCache.get(identity.key)
  if (cached) return { ...cached.value, headers: { ...cached.value.headers } }
  const value = await probe(identity.base, auth, signal)
  connectionCache.set(identity.key, { origin: identity.origin, value })
  return { ...value, headers: { ...value.headers } }
}

/** A live probe that must not mistake a cached protocol selection for current health. */
export async function probeOpenCodeConnection(baseUrl: string, signal?: AbortSignal): Promise<OpenCodeConnection> {
  invalidateOpenCodeConnection(baseUrl)
  return getOpenCodeConnection(baseUrl, signal)
}

/** Forget a resolved protocol when settings change or an owned server restarts. */
export function invalidateOpenCodeConnection(baseUrl?: string): void {
  if (baseUrl === undefined) {
    connectionCache.clear()
    return
  }
  let origin: string
  try {
    origin = new URL(baseUrl).origin
  } catch {
    return
  }
  for (const [key, value] of connectionCache) {
    if (value.origin === origin) connectionCache.delete(key)
  }
}
