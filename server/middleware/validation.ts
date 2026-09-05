import type { Context, Next } from 'hono'

export const MAX_API_JSON_BODY_BYTES = 2 * 1024 * 1024

class RequestBodyTooLargeError extends Error {}

async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new RequestBodyTooLargeError('Request body too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(bytes)
}

export async function validateJson(c: Context, next: Next) {
  if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
    // Manual QA evidence is intentionally streamed and may be any file type up
    // to its route-owned 250 MiB limit. Do not buffer it in the JSON middleware.
    if (/\/tickets\/[^/]+\/manual-qa\/versions\/\d+\/evidence\/?$/.test(new URL(c.req.url).pathname)) {
      await next()
      return
    }
    const contentType = c.req.header('content-type')
    // `text/event-stream` used to be allowed through here. No route sends it as
    // a *request* type — it is a response type — and letting it past skipped
    // both the 415 and the size limit, so a handler calling `c.req.json()` read
    // an uncapped body. A route that genuinely needs a non-JSON stream is
    // exempted by path, as Manual QA evidence is above.
    if (contentType && !contentType.includes('application/json')) {
      return c.json({ error: 'Content-Type must be application/json' }, 415)
    }

    const contentLength = c.req.header('content-length')
    if (contentLength) {
      const length = Number(contentLength)
      if (!Number.isFinite(length) || length < 0) {
        return c.json({ error: 'Invalid Content-Length header' }, 400)
      }
      if (length > MAX_API_JSON_BODY_BYTES) {
        return c.json({ error: `Request body exceeds ${MAX_API_JSON_BODY_BYTES} bytes` }, 413)
      }
    }

    // For requests without Content-Length (e.g., chunked transfer-encoding),
    // parse the body and validate it's valid JSON within the size limit.
    // This also catches malformed JSON early before route handlers.
    if (contentType?.includes('application/json') || (!contentType && c.req.method !== 'OPTIONS')) {
      try {
        const hadBodyStream = c.req.raw.body !== null
        const raw = await readBodyWithinLimit(c.req.raw, MAX_API_JSON_BODY_BYTES)
        if (raw.length > 0) {
          JSON.parse(raw)
        }
        if (hadBodyStream) {
          // Re-attach even an empty body stream so downstream handlers do not
          // attempt to read the stream consumed by the size-limit check.
          c.req.raw = new Request(c.req.raw, { body: raw })
        }
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return c.json({ error: `Request body exceeds ${MAX_API_JSON_BODY_BYTES} bytes` }, 413)
        }
        return c.json({ error: 'Invalid JSON in request body' }, 400)
      }
    }
  }
  await next()
}
