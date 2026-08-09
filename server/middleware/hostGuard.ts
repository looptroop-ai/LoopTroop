import type { Context, Next } from 'hono'
import { isLoopbackHost } from '../../shared/appConfig'

/**
 * Strips the port and any IPv6 brackets from a Host or Origin authority, so
 * `[::1]:3000` and `127.0.0.1:3000` both reduce to the hostname alone.
 */
export function hostnameFromAuthority(authority: string): string {
  const trimmed = authority.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)
  }
  // An IPv6 address without brackets has several colons; only a host:port pair
  // has exactly one, and only that trailing part is a port.
  const colon = trimmed.indexOf(':')
  if (colon === -1 || trimmed.indexOf(':', colon + 1) !== -1) return trimmed
  return trimmed.slice(0, colon)
}

export function isLoopbackAuthority(authority: string | undefined): boolean {
  if (!authority) return false
  return isLoopbackHost(hostnameFromAuthority(authority))
}

/** The port of an authority, or null when it names none. */
export function portFromAuthority(authority: string): string | null {
  const trimmed = authority.trim().toLowerCase()

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end === -1) return null
    const rest = trimmed.slice(end + 1)
    return rest.startsWith(':') && /^\d+$/.test(rest.slice(1)) ? rest.slice(1) : null
  }

  const colon = trimmed.indexOf(':')
  // Several colons is an unbracketed IPv6 address, which names no port.
  if (colon === -1 || trimmed.indexOf(':', colon + 1) !== -1) return null
  const port = trimmed.slice(colon + 1)
  return /^\d+$/.test(port) ? port : null
}

/**
 * `host:port` for an authority, with the implied port filled in so `127.0.0.1`
 * and `127.0.0.1:80` compare equal. The daemon speaks http, so a Host header
 * with no port means 80.
 */
export function canonicalAuthority(authority: string, defaultPort = '80'): string {
  return `${hostnameFromAuthority(authority)}:${portFromAuthority(authority) ?? defaultPort}`
}

/**
 * The hostname and canonical authority of an Origin header, or null when it is
 * not an http(s) origin this daemon could have served.
 */
export function parseOrigin(origin: string): { hostname: string, authority: string } | null {
  // A sandboxed iframe and a file:// page both send `null`, and neither is a
  // page this daemon has any reason to answer.
  if (origin === 'null') return null

  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

    // URL keeps IPv6 brackets in `hostname`; authorities here are compared
    // unbracketed so `[::1]:3000` and `::1:3000` are the same thing.
    const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')
    const port = parsed.port === '' ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port
    return { hostname, authority: `${hostname}:${port}` }
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
 * Binding to a non-loopback address already demands LOOPTROOP_ALLOW_REMOTE_API
 * and a token, so that same variable is what turns this off: a deployment that
 * is deliberately reachable by name would otherwise reject every request.
 */
export function createHostGuardMiddleware(options: HostGuardOptions = {}) {
  const extraAuthorities = new Set(
    (options.additionalOrigins ?? [])
      .map((origin) => parseOrigin(origin)?.authority)
      .filter((authority): authority is string => authority !== undefined),
  )

  return async (c: Context, next: Next) => {
    if (process.env.LOOPTROOP_ALLOW_REMOTE_API === '1') {
      await next()
      return
    }

    const authority = requestAuthority(c)
    // A request whose authority is not a loopback name did not come from here.
    if (!isLoopbackAuthority(authority)) {
      return c.json({ error: 'Forbidden: this API answers only on loopback.' }, 403)
    }

    const origin = c.req.header('origin')
    if (origin !== undefined) {
      const parsed = parseOrigin(origin)
      // Same authority as the request itself: no knowledge of the bound port is
      // needed, because the Host header is the port the browser connected to.
      const permitted = parsed !== null
        && isLoopbackHost(parsed.hostname)
        && (parsed.authority === canonicalAuthority(authority ?? '')
          || extraAuthorities.has(parsed.authority))

      if (!permitted) {
        return c.json({ error: 'Forbidden: cross-origin requests are not accepted.' }, 403)
      }
    }

    await next()
  }
}
