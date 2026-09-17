import type { Context, Next } from 'hono'
import { canonicalIpv6Host, isLoopbackHost } from '../../shared/appConfig'
import { SESSION_COOKIE_NAME, readCookie } from './sessionAuth'

/** Parses one authority, sharing host canonicalization and port validation. */
function parseAuthority(authority: string): { hostname: string, port: string | null } | null {
  const trimmed = authority.trim().toLowerCase()
  let hostname: string
  let port: string | null = null
  if (trimmed.startsWith('[')) {
    const match = /^\[([\da-f:.]+)\](?::(\d*))?$/.exec(trimmed)
    if (!match) return null
    hostname = canonicalIpv6Host(match[1] ?? '')?.slice(1, -1) ?? ''
    port = match[2] || null
  } else {
    const colon = trimmed.indexOf(':')
    if (colon === -1) {
      hostname = trimmed
    } else if (trimmed.indexOf(':', colon + 1) !== -1) {
      // A bare IPv6 address names no port; HTTP Host uses brackets.
      hostname = canonicalIpv6Host(trimmed)?.slice(1, -1) ?? ''
    } else {
      hostname = trimmed.slice(0, colon)
      port = trimmed.slice(colon + 1) || null
    }
  }
  if (!hostname || (port !== null && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535))) return null
  return { hostname, port }
}

/** The canonical hostname without brackets or port, or empty for invalid input. */
export function hostnameFromAuthority(authority: string): string {
  return parseAuthority(authority)?.hostname ?? ''
}

export function isLoopbackAuthority(authority: string | undefined): boolean {
  if (!authority) return false
  return isLoopbackHost(hostnameFromAuthority(authority))
}

/** The port of an authority, or null when absent, empty or invalid. */
export function portFromAuthority(authority: string): string | null {
  return parseAuthority(authority)?.port ?? null
}

/**
 * `host:port` for an authority, with the implied port filled in so `127.0.0.1`
 * and `127.0.0.1:80` compare equal. Callers can supply the request scheme's
 * default port; invalid authorities return an empty string.
 */
export function canonicalAuthority(authority: string, defaultPort = '80'): string {
  const parsed = parseAuthority(authority)
  return parsed ? `${parsed.hostname}:${Number(parsed.port ?? defaultPort)}` : ''
}

/**
 * The hostname and canonical authority of an Origin header, or null when it is
 * not an http(s) origin this daemon could have served.
 */
export function parseOrigin(origin: string): { hostname: string, authority: string, scheme: 'http:' | 'https:' } | null {
  // A sandboxed iframe and a file:// page both send `null`, and neither is a
  // page this daemon has any reason to answer.
  if (origin === 'null') return null

  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

    // WHATWG URL accepts alternate IPv4 spellings and rewrites them to dotted
    // decimal. Keep that normalization from making a literal attacker spelling
    // equivalent to a loopback origin; ordinary host case-folding and IPv6
    // canonicalization remain valid.
    const rawHostname = /^https?:\/\/(\[[^\]]+\]|[^/?#:]+)(?::\d*)?(?:[/?#]|$)/i.exec(origin)?.[1]
    if (!rawHostname) return null

    // URL keeps IPv6 brackets in `hostname`; authorities here are compared
    // unbracketed so `[::1]:3000` and `::1:3000` are the same thing.
    const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')
    const port = parsed.port === '' ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port
    if (!rawHostname.startsWith('[') && rawHostname.toLowerCase() !== hostname.toLowerCase()) return null
    if (Number(port) < 1) return null
    const scheme = parsed.protocol === 'https:' ? 'https:' : 'http:'
    return { hostname, authority: `${hostname}:${port}`, scheme }
  } catch {
    return null
  }
}

/**
 * The authority this request claims to have been sent to.
 *
 * The Host header is the real signal — it is what a rebound name lands in, and
 * what the Node server derives the request URL from, so the two agree for any
 * request that arrived over a socket. The URL is the fallback for a caller that
 * sent no Host header at all, which no browser does and which an in-process
 * `app.request()` cannot.
 */
export function requestAuthority(c: Context): string | undefined {
  const header = c.req.header('host')
  if (header) return header

  try {
    return new URL(c.req.url).host
  } catch {
    return undefined
  }
}

/** Uses the actual request URL; forwarded scheme headers are caller-controlled. */
function requestDefaultPort(c: Context): string {
  try {
    return new URL(c.req.url).protocol === 'https:' ? '443' : '80'
  } catch {
    return '80'
  }
}

/** Uses only the actual request URL when comparing an Origin scheme. */
function requestScheme(c: Context): 'http:' | 'https:' | null {
  try {
    const protocol = new URL(c.req.url).protocol
    return protocol === 'http:' || protocol === 'https:' ? protocol : null
  } catch {
    return null
  }
}

/**
 * Whether this request carries the ambient session cookie. Authentication checks
 * the cookie before bearer credentials, so a cookie must prove same-origin even
 * when a caller also supplies an invalid or unrelated token header.
 */
function usesAmbientCookie(c: Context): boolean {
  return readCookie(c.req.header('cookie'), SESSION_COOKIE_NAME) !== null
}

export interface HostGuardOptions {
  /**
   * Origins accepted in addition to the daemon's own. The dev server on another
   * port is the only real case, and production passes none.
   */
  additionalOrigins?: string[]
}

/**
 * Rejects requests that did not come from this daemon's own origin.
 *
 * The daemon binds loopback, but that alone does not make it private to the
 * browser: any page on the internet can point a hostname it controls at
 * 127.0.0.1 and have the browser send same-site requests to this port, which
 * SameSite cookies do nothing about because the browser believes it is talking
 * to that site. Requiring the Host header to name a loopback address makes the
 * rebound name itself the tell.
 *
 * The Origin header is then required to name the *same* authority, port
 * included. "Some loopback address" is not enough, because cookies are not
 * scoped by port: a page on any other localhost port — another dev server, a
 * local tool with an XSS, anything a user was talked into running — is a
 * different origin that the browser will nonetheless send this daemon's session
 * cookie to. Pinning the port is what makes that page's requests fail.
 *
 * A request with no Origin used to pass unconditionally, which left the same
 * cross-port page a way in: `<img src="http://127.0.0.1:3000/api/...">`, a
 * no-cors fetch, a `window.open` — none of them send Origin, and all of them
 * send this daemon's cookie, because cookies have no port scope. Such a request
 * is now required to carry `Sec-Fetch-Site: same-origin` whenever the cookie is
 * the only credential it has. Scripts without a cookie are unaffected: they
 * present a token and never needed the browser's word for anything.
 *
 * That closes the browser-driven half. A local process that already reads the
 * cookie out of the browser's store can still forge every header, so the cookie
 * being shared across loopback ports remains a real exposure — one that only a
 * distinct hostname or a non-ambient credential can remove.
 *
 * Binding to a non-loopback address already demands LOOPTROOP_ALLOW_REMOTE_API
 * and a token, so that same variable turns off only the loopback check: a
 * deployment that is deliberately reachable by name still keeps its origin and
 * cookie protections.
 */
export function createHostGuardMiddleware(options: HostGuardOptions = {}) {
  const extraOrigins = new Set(
    (options.additionalOrigins ?? [])
      .map((origin) => {
        const parsed = parseOrigin(origin)
        return parsed ? `${parsed.scheme}//${parsed.authority}` : null
      })
      .filter((origin): origin is string => origin !== null),
  )

  return async (c: Context, next: Next) => {
    const remoteApi = process.env.LOOPTROOP_ALLOW_REMOTE_API === '1'
    const authority = requestAuthority(c)
    // Local mode requires a loopback authority; remote mode opts out of only
    // that binding check and keeps the origin and cookie checks below.
    const requestAuthorityCanonical = canonicalAuthority(authority ?? '', requestDefaultPort(c))
    if (!requestAuthorityCanonical || (!remoteApi && !isLoopbackAuthority(authority))) {
      return c.json({ error: 'Forbidden: this API answers only on loopback.' }, 403)
    }

    const origin = c.req.header('origin')
    if (origin !== undefined) {
      const parsed = parseOrigin(origin)
      const scheme = requestScheme(c)
      // Same authority as the request itself: no knowledge of the bound port is
      // needed, because the Host header is the port the browser connected to.
      const permitted = parsed !== null
        && ((parsed.authority === requestAuthorityCanonical
          && parsed.scheme === scheme)
          || extraOrigins.has(`${parsed.scheme}//${parsed.authority}`))
        && (remoteApi || isLoopbackHost(parsed.hostname))

      if (!permitted) {
        return c.json({ error: 'Forbidden: cross-origin requests are not accepted.' }, 403)
      }

      await next()
      return
    }

    // No Origin at all. Fine for a script holding the API token, and the only
    // shape a same-origin GET has ever had — but on its own it is also exactly
    // what a page on another loopback port produces, cookie included, via an
    // `<img>` tag or a no-cors fetch. Sec-Fetch-Site is what separates the two:
    // the browser sets it, page script cannot (it is a forbidden header name),
    // and unlike a site it counts the port, so another localhost port gets
    // `same-site` rather than `same-origin`.
    if (usesAmbientCookie(c) && c.req.header('sec-fetch-site') !== 'same-origin') {
      return c.json(
        { error: 'Forbidden: the session cookie is accepted only on same-origin requests.' },
        403,
      )
    }

    await next()
  }
}
