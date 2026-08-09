/**
 * Whether this browser still holds a LoopTroop session.
 *
 * The session cookie is HttpOnly, so no script on the page can read it and ask
 * the question directly. What a client can observe is the daemon's answer: a 401
 * from this origin's API means the cookie is missing, expired or not the one
 * this daemon minted. That is the only signal here, and it is authoritative.
 *
 * Without it the app rendered its whole shell against an API that refused every
 * request — boards that never filled, spinners that never resolved, and nothing
 * anywhere saying the session had simply run out. The 12-hour cookie makes that
 * the ordinary end of a tab left open overnight, not an edge case.
 */

let signedOut = false
let watchInstalled = false
const listeners = new Set<() => void>()

/** Where a bootstrap nonce is spent; see `isOwnApiRequest`. */
const EXCHANGE_PATH = '/api/auth/exchange'

/** Latched: a session cannot come back without a fresh nonce, which means a reload. */
export function reportSignedOut(): void {
  if (signedOut) return
  signedOut = true
  for (const listener of [...listeners]) listener()
}

export function isSignedOut(): boolean {
  return signedOut
}

export function subscribeToSessionState(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Only this origin's own API counts. A 401 from anywhere else says nothing about
 * this daemon's session, and the URL is resolved from the request rather than
 * the response so a redirect cannot move the decision to another host.
 *
 * The nonce exchange is excluded, because a refused exchange is not a refused
 * session: a nonce is single-use, so opening the same sign-in URL twice fails
 * the second exchange while the cookie the first one bought is still perfectly
 * good. Whether that session works is settled by the requests that use it.
 */
function isOwnApiRequest(input: RequestInfo | URL): boolean {
  if (typeof window === 'undefined') return false

  try {
    const url = typeof input === 'string'
      ? new URL(input, window.location.origin)
      : input instanceof URL
        ? input
        : typeof Request !== 'undefined' && input instanceof Request
          ? new URL(input.url, window.location.origin)
          : null

    if (!url) return false
    if (url.origin !== window.location.origin) return false
    if (url.pathname === EXCHANGE_PATH) return false
    return url.pathname === '/api' || url.pathname.startsWith('/api/')
  } catch {
    return false
  }
}

/**
 * Watches every API response for the one status that means "not signed in".
 *
 * A wrapper around fetch rather than a check in each hook: there are twenty-odd
 * query functions and a rule this load-bearing must not depend on each of them
 * remembering it. The response is passed through untouched, so a caller that
 * wants to handle its own 401 still can.
 */
export function installSessionWatch(): void {
  if (watchInstalled) return
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return

  const inner = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await inner(input, init)
    if (response.status === 401 && isOwnApiRequest(input)) reportSignedOut()
    return response
  }

  watchInstalled = true
}

/** Test-only: the store and the fetch wrapper both outlive a single test. */
export const __sessionStateForTests = {
  reset(): void {
    signedOut = false
    watchInstalled = false
    listeners.clear()
  },
}
