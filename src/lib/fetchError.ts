/**
 * Turns a failed `Response` into an error that says what actually went wrong.
 *
 * A bare "Failed to fetch tickets" is the same sentence whether the daemon is
 * down, the token is missing or the ticket is gone, so the status code and the
 * server's own `{ error }` body are folded into the message. That is the
 * difference between "the UI is slow" and "HTTP 503: API token not configured".
 *
 * This is the only reader of a failed response body in the client. A body can be
 * read once, so a caller that parses the error itself and then asks for a
 * description here gets an empty one — clone the response if both are needed.
 */
export async function failedResponseError(res: Response, summary: string): Promise<Error> {
  const detail = await readErrorDetail(res)
  return new Error(detail ? `${summary} (HTTP ${res.status}: ${detail})` : `${summary} (HTTP ${res.status})`)
}

/**
 * Throws `failedResponseError` unless the response succeeded.
 *
 * The one-line form of the same rule, for the twenty-odd call sites that only
 * want "not 2xx means throw". Consumes the body on failure and leaves it intact
 * on success.
 */
export async function throwIfNotOk(res: Response, summary: string): Promise<void> {
  if (!res.ok) throw await failedResponseError(res, summary)
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

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * The message inside a JSON error body, in the shapes the API actually uses.
 *
 * `errors` is a validation list, `error` a category, and `message` or `details`
 * the detail; the API sends a category and a detail together and they are
 * different halves of one sentence ("Invalid input: title is required"), so both
 * survive rather than one winning. When they are the same string it is printed
 * once. `details` is only quoted when it is a string — some routes put a Zod
 * field map there, and an object interpolated into a banner reads
 * "[object Object]".
 */
function readJsonDetail(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON. The raw text is still the best available answer.
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const body = parsed as { error?: unknown; message?: unknown; details?: unknown; errors?: unknown }

  if (Array.isArray(body.errors)) {
    const listed = body.errors.map(trimmedString).filter((entry): entry is string => entry !== null)
    if (listed.length > 0) return listed.join('; ')
  }

  const category = trimmedString(body.error)
  const detail = trimmedString(body.message) ?? trimmedString(body.details)
  if (category && detail) return category === detail ? category : `${category}: ${detail}`
  return detail ?? category
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

    const fromJson = readJsonDetail(text)
    if (fromJson) return fromJson

    // An HTML error page from a proxy is noise, so it is capped rather than
    // pasted into the banner whole.
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  } catch {
    return null
  }
}
