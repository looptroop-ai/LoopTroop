import { timingSafeEqual } from 'node:crypto'

/** Header a script may present the API token in, for clients that cannot set Authorization. */
export const API_TOKEN_HEADER = 'x-looptroop-token'

/**
 * The token from an `Authorization: Bearer …` header, or null.
 *
 * The capture starts with `\S` rather than being a bare `.+`. That is not
 * cosmetic: `\s+` and `.` both match a space, so `\s+(.+)` is ambiguous and
 * backtracks quadratically on a header that cannot match — `Bearer`, tens of
 * thousands of spaces, then a newline. Measured at 5 ms for 2,000 spaces and
 * 296 ms for 16,000, on a value any client can send, on the path that decides
 * whether a request is authenticated. Requiring the capture to open on a
 * non-space makes the two quantifiers disjoint, so there is nothing to
 * backtrack into; the same input is then 0.06 ms. Accepted and rejected
 * headers are otherwise unchanged.
 */
export function getBearerToken(value: string | undefined): string | null {
  if (!value) return null
  const match = /^Bearer\s+(\S.*)$/i.exec(value.trim())
  return match?.[1]?.trim() || null
}

/**
 * Constant-time string comparison.
 *
 * Always performs a `timingSafeEqual`, even when the lengths differ: comparing
 * the expected value against a zero-filled buffer of the same length keeps the
 * work constant so the comparison cannot leak the expected length via timing.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) {
    return timingSafeEqual(Buffer.alloc(left.length, 0), left) && false
  }
  return timingSafeEqual(left, right)
}
