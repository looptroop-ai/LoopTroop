import { MAX_COMMAND_OUTPUT_BYTES } from './constants'

const TRUNCATION_NOTICE = `\n[LoopTroop truncated command output at ${MAX_COMMAND_OUTPUT_BYTES} bytes]`

/**
 * Truncates a string to at most `maxBytes` of UTF-8 without splitting a code
 * point.
 *
 * `String.prototype.slice` counts UTF-16 code units, so slicing by a byte
 * budget is only correct for ASCII. A build log carrying box-drawing
 * characters, a CJK path or an emoji could therefore return up to four times
 * the advertised cap — and a naive byte slice would end mid-sequence and
 * produce a replacement character. `TextEncoder`/`TextDecoder` with
 * `stream: true` stops at the last whole code point instead.
 */
function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 }
  const encoded = new TextEncoder().encode(text)
  if (encoded.length <= maxBytes) return { text, truncated: false }
  // `stream: true` makes the decoder hold back a trailing partial sequence
  // rather than emitting U+FFFD for it.
  return {
    text: new TextDecoder('utf-8').decode(encoded.subarray(0, maxBytes), { stream: true }),
    truncated: true,
  }
}

/**
 * Appends a chunk of command output, stopping at the byte cap.
 *
 * Shared by the two command runners, which had near-identical copies of this
 * and the same character-versus-byte bug. ASCII output is unaffected: the cap,
 * the notice text and the point at which it appears are all unchanged.
 */
export function appendBoundedOutput(current: string, chunk: Buffer | string): string {
  const currentBytes = Buffer.byteLength(current, 'utf8')
  if (currentBytes >= MAX_COMMAND_OUTPUT_BYTES) return current

  const remaining = MAX_COMMAND_OUTPUT_BYTES - currentBytes
  const { text: appended, truncated } = truncateToBytes(chunk.toString(), remaining)
  const next = `${current}${appended}`

  // Two ways to be at the end: the cap was reached exactly, or a code point
  // boundary stopped us a byte or two short of it. Both dropped output, so both
  // have to say so — reporting only the first is what a byte-exact slice
  // happened to get away with on ASCII.
  const reachedCap = currentBytes + Buffer.byteLength(appended, 'utf8') >= MAX_COMMAND_OUTPUT_BYTES
  return reachedCap || truncated ? `${next}${TRUNCATION_NOTICE}` : next
}
