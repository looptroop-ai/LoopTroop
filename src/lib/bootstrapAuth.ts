/**
 * Consumes a one-time bootstrap nonce from the URL fragment. The daemon prints
 * a URL containing `#bootstrap=<nonce>`; the browser sends the nonce once to
 * /api/auth/exchange, receives an HttpOnly session cookie in return, and this
 * module strips the fragment so the secret leaves address-bar history.
 *
 * Only a code fragment ever carries the nonce: it is not sent to the server as
 * part of a request line, so it cannot appear in access logs.
 *
 * The `replaceState` below is the one history write outside `App.tsx`, and
 * deliberately so: it runs before React mounts, so there is no route state yet
 * for it to contradict, and it only strips a fragment — the path it writes is
 * the path already showing. `App.tsx` then reads that path as the entry URL.
 */
export async function consumeBootstrapNonce(): Promise<void> {
  const raw = window.location.hash
  const marker = '#bootstrap='
  const index = raw.indexOf(marker)
  if (index === -1) return

  const nonce = raw.slice(index + marker.length)
  // History.replaceState removes the fragment without leaving a history entry.
  window.history.replaceState(null, '', window.location.pathname + window.location.search)

  try {
    const response = await fetch('/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    })
    if (!response.ok) {
      // No reload: a nonce is single-use, so reloading would only spend a second
      // dead one. Whether the browser already holds a working session is settled
      // by the requests that follow, and a session that is refused ends up on the
      // signed-out screen rather than in a shell full of failing queries.
      console.error('[auth] Bootstrap exchange refused; continuing with whatever session this browser has.')
    }
  } catch (error) {
    console.error('[auth] Bootstrap exchange error:', error)
  }
}
