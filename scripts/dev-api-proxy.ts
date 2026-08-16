export interface DevProxyOriginInput {
  origin: string | undefined
  host: string | undefined
  secFetchSite: string | undefined
  backendOrigin: string
}

function parseHttpOrigin(value: string): URL | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed
  } catch {
    return null
  }
}

function hostMatchesOrigin(host: string, origin: URL): boolean {
  const trimmed = host.trim()
  if (!trimmed || /[\s/@]/.test(trimmed)) return false

  try {
    // Parsing the Host header under the browser-visible scheme gives both sides
    // the same default-port rules while retaining explicit non-default ports.
    return new URL(`${origin.protocol}//${trimmed}`).host === origin.host
  } catch {
    return false
  }
}

/**
 * Returns the Origin Vite should present on its loopback API hop, or null when
 * the browser request must reach the backend unchanged.
 *
 * A remote browser still makes a same-origin request to Vite, but a reverse
 * proxy such as Tailscale Serve terminates that public origin before Vite sends
 * the request to LoopTroop's loopback backend. The browser-controlled Origin
 * therefore no longer matches the rewritten Host unless this trusted proxy hop
 * normalizes it.
 *
 * Both checks are required. `Sec-Fetch-Site` is a browser-forbidden header that
 * vouches for same-origin, while matching Origin to the incoming Host prevents
 * an unrelated page from having its cross-origin request normalized. Requests
 * that fail either check keep their real Origin so the backend host guard can
 * reject them.
 */
export function getDevProxyOriginOverride(input: DevProxyOriginInput): string | null {
  if (input.secFetchSite?.trim().toLowerCase() !== 'same-origin') return null
  if (!input.origin || !input.host) return null

  const origin = parseHttpOrigin(input.origin)
  if (origin === null || !hostMatchesOrigin(input.host, origin)) return null

  return parseHttpOrigin(input.backendOrigin)?.origin ?? null
}
