import { timingSafeEqual } from 'node:crypto'

/** Header a script may present the API token in, for clients that cannot set Authorization. */
export const API_TOKEN_HEADER = 'x-looptroop-token'

/** Reads the token out of an `Authorization: Bearer …` header, or null. */
export function getBearerToken(value: string | undefined): string | null {
  if (!value) return null
  const match = /^Bearer\s+(.+)$/i.exec(value.trim())
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
