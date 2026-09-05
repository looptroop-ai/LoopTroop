import { randomBytes } from 'node:crypto'
import type { Context, Next } from 'hono'
import { API_TOKEN_HEADER, constantTimeEquals, getBearerToken } from './authUtils'

export const SESSION_COOKIE_NAME = 'looptroop_session'

export { API_TOKEN_HEADER, constantTimeEquals }

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

/** Minimal cookie parsing: avoids a dependency for one header. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      // Bad percent-encoding threw here, before authentication could return
      // its ordinary 401 — so a malformed Cookie header answered 500 and told
      // an unauthenticated caller that something had broken. An undecodable
      // cookie is a cookie we do not have.
      return null
    }
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

  /**
   * Whether this nonce is still waiting to be spent.
   *
   * How `looptroop open` finds out whether the browser it launched ever arrived.
   * A nonce that is no longer outstanding was either exchanged or has expired,
   * and the caller does not have to tell those apart: it asks for seconds, and
   * the lifetime is five minutes, so within that window only an exchange can
   * have removed it.
   *
   * Compared the same way `consume` compares, for the same reason, though the
   * route in front of this one already requires the API token.
   */
  isOutstanding(candidate: string): boolean {
    this.prune()

    let matched = false
    for (const value of this.live.keys()) {
      if (constantTimeEquals(candidate, value)) matched = true
    }
    return matched
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
