/**
 * Turns a failed `Response` into an error that says what actually went wrong.
 *
 * A bare "Failed to fetch tickets" is the same sentence whether the daemon is
 * down, the token is missing or the ticket is gone, so the status code and the
 * server's own `{ error }` body are folded into the message. That is the
 * difference between "the UI is slow" and "HTTP 503: API token not configured".
 */
export async function failedResponseError(res: Response, summary: string): Promise<Error> {
  const detail = await readErrorDetail(res)
  return new Error(detail ? `${summary} (HTTP ${res.status}: ${detail})` : `${summary} (HTTP ${res.status})`)
}

/**
 * Reads whatever a failed query threw and returns a line worth showing.
 *
 * The fetchers throw `Error`, but a query can also reject with a string or a
 * `TypeError` from `fetch` itself when the connection is refused, so anything
 * that is not an `Error` is stringified rather than dropped.
 */
export function describeQueryError(error: unknown): string | null {
  if (error instanceof Error) return error.message.trim() || null
  if (typeof error === 'string') return error.trim() || null
  return null
}

/**
 * Body of an error response, when it carries one worth quoting.
 *
 * The body is read defensively: an aborted or already-consumed response throws
 * here, and a failure to describe an error must never replace it.
 */
async function readErrorDetail(res: Response): Promise<string | null> {
  try {
    const text = (await res.text()).trim()
    if (!text) return null

    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const { error } = parsed as { error: unknown }
        if (typeof error === 'string' && error.trim()) return error.trim()
      }
    } catch {
      // Not JSON. The raw text is still the best available answer.
    }

    // An HTML error page from a proxy is noise, so it is capped rather than
    // pasted into the banner whole.
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  } catch {
    return null
  }
}
