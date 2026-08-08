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

function isLoopbackOrigin(origin: string): boolean {
  // A sandboxed iframe and a file:// page both send `null`, and neither is a
  // page this daemon has any reason to answer.
  if (origin === 'null') return false

  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return isLoopbackHost(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * Rejects requests that did not come from this machine's own loopback origin.
 *
 * The daemon binds loopback, but that alone does not make it private to the
 * browser: any page on the internet can point a hostname it controls at
 * 127.0.0.1 and have the browser send same-site requests to this port, which
 * SameSite cookies do nothing about because the browser believes it is talking
 * to that site. Requiring the Host header to name a loopback address makes the
 * rebound name itself the tell. The Origin header is checked the same way, so a
 * page on another origin cannot drive this API even with a credential attached.
 *
 * Binding to a non-loopback address already demands LOOPTROOP_ALLOW_REMOTE_API
 * and a token, so that same variable is what turns this off: a deployment that
 * is deliberately reachable by name would otherwise reject every request.
 */
export function createHostGuardMiddleware() {
  return async (c: Context, next: Next) => {
    if (process.env.LOOPTROOP_ALLOW_REMOTE_API === '1') {
      await next()
      return
    }

    // A request whose authority is not a loopback name did not come from here.
    if (!isLoopbackAuthority(requestAuthority(c))) {
      return c.json({ error: 'Forbidden: this API answers only on loopback.' }, 403)
    }

    const origin = c.req.header('origin')
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return c.json({ error: 'Forbidden: cross-origin requests are not accepted.' }, 403)
    }

    await next()
  }
}
