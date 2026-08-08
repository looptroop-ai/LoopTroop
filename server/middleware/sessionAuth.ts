import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context, Next } from 'hono'

export const SESSION_COOKIE_NAME = 'looptroop_session'

/** Bootstrap nonces are single-use and short-lived by design. */
export const BOOTSTRAP_NONCE_TTL_MS = 5 * 60_000

export interface SessionCredentials {
  /** Long-lived secret for scripted access, sent as a bearer token. */
  apiToken: string
  /** Set as an HttpOnly cookie once a bootstrap nonce is exchanged. */
  sessionToken: string
  /** Handed to the browser once, in a URL fragment, to obtain the cookie. */
  bootstrapNonce: string
}

export function createSessionCredentials(): SessionCredentials {
  return {
    apiToken: randomBytes(32).toString('base64url'),
    sessionToken: randomBytes(32).toString('base64url'),
    bootstrapNonce: randomBytes(32).toString('base64url'),
  }
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // Compare against a same-length buffer when lengths differ so the comparison
  // still takes constant time and cannot leak the expected length.
  if (left.length !== right.length) {
    return timingSafeEqual(Buffer.alloc(left.length, 0), left) && false
  }
  return timingSafeEqual(left, right)
}

/** Minimal cookie parsing: avoids a dependency for one header. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(part.slice(separator + 1).trim())
  }
  return null
}

export function serializeSessionCookie(value: string, maxAgeSeconds: number): string {
  // HttpOnly keeps the value out of reach of any script on the page.
  // SameSite=Strict stops another site from driving the control API through
  // the browser, which is the one real risk of cookie auth on loopback.
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ')
}

/**
 * Single-use bootstrap nonce. Consuming it invalidates it, so a nonce that
 * leaks into shell history cannot be replayed to mint a second session.
 */
export class BootstrapNonce {
  private consumed = false
  private readonly expiresAt: number

  constructor(private readonly value: string, ttlMs = BOOTSTRAP_NONCE_TTL_MS) {
    this.expiresAt = Date.now() + ttlMs
  }

  consume(candidate: string): boolean {
    if (this.consumed || Date.now() > this.expiresAt) return false
    if (!constantTimeEquals(candidate, this.value)) return false
    this.consumed = true
    return true
  }

  get isSpent(): boolean {
    return this.consumed || Date.now() > this.expiresAt
  }
}

function getBearerToken(value: string | undefined): string | null {
  if (!value) return null
  const match = /^Bearer\s+(.+)$/i.exec(value.trim())
  return match?.[1]?.trim() || null
}

export interface SessionAuthOptions {
  credentials: SessionCredentials
  /** Extra header name accepted for the API token, for older clients. */
  tokenHeader?: string
}

/**
 * Accepts either a session cookie (browser) or a bearer token (scripts).
 * There is deliberately no query-parameter path: query strings reach access
 * logs, proxies and browser history, and same-origin EventSource sends cookies
 * on its own, so the one case that needed it no longer does.
 */
export function createSessionAuthMiddleware(options: SessionAuthOptions) {
  const { credentials } = options
  const tokenHeader = options.tokenHeader ?? 'x-looptroop-token'

  return async (c: Context, next: Next) => {
    if (c.req.method === 'OPTIONS') {
      await next()
      return
    }

    const cookie = readCookie(c.req.header('cookie'), SESSION_COOKIE_NAME)
    if (cookie && constantTimeEquals(cookie, credentials.sessionToken)) {
      await next()
      return
    }

    const bearer = getBearerToken(c.req.header('authorization')) ?? c.req.header(tokenHeader)?.trim()
    if (bearer && constantTimeEquals(bearer, credentials.apiToken)) {
      await next()
      return
    }

    return c.json({ error: 'Unauthorized' }, 401)
  }
}
