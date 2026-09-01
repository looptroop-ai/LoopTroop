import type { Context, Next } from 'hono'
import { API_TOKEN_HEADER, constantTimeEquals, getBearerToken } from './authUtils'

export { API_TOKEN_HEADER }

export interface ApiAuthOptions {
  token?: string
}

/**
 * The token this request carries, from a header only.
 *
 * A query string is not a private channel: it lands in access logs, in proxy
 * logs, in `Referer` on any outbound link, and in the browser's own history —
 * all places that outlive the session and are far more readable than the
 * daemon's owner-only files. There was a query fallback here for EventSource,
 * which cannot set headers, but it is not needed: the stream is same-origin, so
 * the browser attaches the session cookie on its own, and the dev server
 * injects the header on the way through.
 */
function getRequestToken(c: Context): string | null {
  return c.req.header(API_TOKEN_HEADER)?.trim()
    || getBearerToken(c.req.header('authorization'))
}

export function createApiAuthMiddleware(options: ApiAuthOptions = {}) {
  const configuredToken = options.token ?? process.env.LOOPTROOP_API_TOKEN?.trim()
  const allowUnauthenticated = process.env.LOOPTROOP_ALLOW_UNAUTHENTICATED === '1'

  if (!configuredToken && allowUnauthenticated && process.env.LOOPTROOP_ALLOW_REMOTE_API === '1') {
    console.error(
      '[apiAuth] CRITICAL: LOOPTROOP_ALLOW_UNAUTHENTICATED=1 with LOOPTROOP_ALLOW_REMOTE_API=1. ' +
      'The API is completely open to the network. This should NEVER be used in production.',
    )
  } else if (!configuredToken && allowUnauthenticated) {
    console.warn('[apiAuth] Running without API token authentication. Set LOOPTROOP_API_TOKEN to secure the API.')
  }

  return async (c: Context, next: Next) => {
    if (c.req.method === 'OPTIONS') {
      await next()
      return
    }

    if (!configuredToken) {
      if (allowUnauthenticated) {
        await next()
        return
      }
      return c.json({ error: 'API token not configured' }, 503)
    }

    const requestToken = getRequestToken(c)
    if (!requestToken || !constantTimeEquals(requestToken, configuredToken)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  }
}
