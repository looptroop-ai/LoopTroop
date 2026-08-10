import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Context, Next } from 'hono'

export const SESSION_COOKIE_NAME = 'looptroop_session'

/** Header a script may present the API token in, for clients that cannot set Authorization. */
export const API_TOKEN_HEADER = 'x-looptroop-token'

/** Bootstrap nonces are single-use and short-lived by design. */
export const BOOTSTRAP_NONCE_TTL_MS = 5 * 60_000

export interface SessionCredentials {
  /** Long-lived secret for scripted access, sent as a bearer token. */
  apiToken: string
  /** Set as an HttpOnly cookie once a bootstrap nonce is exchanged. */
  sessionToken: string
}

export function createSessionCredentials(): SessionCredentials {
  return {
    apiToken: randomBytes(32).toString('base64url'),
    sessionToken: randomBytes(32).toString('base64url'),
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
  // Path=/api keeps the cookie off requests for the static bundle, which need
  // no credential: a secret is not attached to traffic that cannot use it.
  //
  // SameSite=Strict stops another *site* from driving the control API through
  // the browser. It does not stop another loopback port: a site is a scheme and
  // a registrable domain, so 127.0.0.1:9999 and 127.0.0.1:3000 are the same
  // site, and cookies carry no port scope of their own. Every other local
  // service therefore shares this cookie jar, which is why the host guard makes
  // the browser prove same-origin before this cookie authenticates anything.
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/api',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ')
}

/**
 * Mints single-use bootstrap nonces on demand.
 *
 * One nonce fixed at startup could not survive its own design: it is spent by
 * the first browser that uses it and expires five minutes in, so every later
 * `looptroop open` would hand out a dead secret. Issuing per request keeps each
 * nonce single-use and short-lived while `open` stays useful for the whole life
 * of the daemon.
 */
export class BootstrapNonceStore {
  private readonly live = new Map<string, number>()

  constructor(
    private readonly ttlMs = BOOTSTRAP_NONCE_TTL_MS,
    /** Caps memory if something calls `issue` in a loop. Oldest is dropped. */
    private readonly maxOutstanding = 16,
  ) {}

  issue(): string {
    this.prune()
    while (this.live.size >= this.maxOutstanding) {
      const oldest = this.live.keys().next()
      if (oldest.done) break
      this.live.delete(oldest.value)
    }

    const value = randomBytes(32).toString('base64url')
    this.live.set(value, Date.now() + this.ttlMs)
    return value
  }

  /**
   * Consuming invalidates the nonce, so one that leaks into shell history
   * cannot be replayed to mint a second session. Every live nonce is compared
   * even after a match, so the time taken cannot reveal which one matched.
   */
  consume(candidate: string): boolean {
    this.prune()

    let matched: string | null = null
    for (const value of this.live.keys()) {
      if (constantTimeEquals(candidate, value)) matched = value
    }

    if (matched === null) return false
    this.live.delete(matched)
    return true
  }

  get outstanding(): number {
    this.prune()
    return this.live.size
  }

  private prune(): void {
    const now = Date.now()
    for (const [value, expiresAt] of this.live) {
      if (expiresAt <= now) this.live.delete(value)
    }
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
  const tokenHeader = options.tokenHeader ?? API_TOKEN_HEADER

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
