import { StringDecoder } from 'node:string_decoder'
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
 * Appends already-decoded command output, stopping at the byte cap.
 *
 * Shared by the two command runners, which had near-identical copies of this
 * and the same character-versus-byte bug. ASCII output is unaffected: the cap,
 * the notice text and the point at which it appears are all unchanged.
 *
 * Takes a string, not a Buffer: decoding is the collector's job below, because
 * it needs state this function cannot have.
 */
export function appendBoundedOutput(current: string, chunk: string): string {
  const currentBytes = Buffer.byteLength(current, 'utf8')
  if (currentBytes >= MAX_COMMAND_OUTPUT_BYTES) {
    // Already full. Anything arriving now is dropped, and dropped output has to
    // say so — but only once, so a run of later chunks does not stack notices.
    if (chunk.length === 0 || current.endsWith(TRUNCATION_NOTICE)) return current
    return `${current}${TRUNCATION_NOTICE}`
  }

  const remaining = MAX_COMMAND_OUTPUT_BYTES - currentBytes
  const { text: appended, truncated } = truncateToBytes(chunk, remaining)
  const next = `${current}${appended}`

  // Two ways to be at the end: the cap was reached exactly, or a code point
  // boundary stopped us a byte or two short of it. Both dropped output, so both
  // have to say so — reporting only the first is what a byte-exact slice
  // happened to get away with on ASCII.
  const reachedCap = currentBytes + Buffer.byteLength(appended, 'utf8') >= MAX_COMMAND_OUTPUT_BYTES
  return reachedCap || truncated ? `${next}${TRUNCATION_NOTICE}` : next
}

export interface BoundedOutputCollector {
  /** Feeds one `data` event. */
  append(chunk: Buffer | string): void
  /** Appends text produced outside the stream, such as a spawn error message. */
  appendText(text: string): void
  /** Flushes the decoder and returns the final text. Safe to call more than once. */
  end(): string
}

/**
 * Collects one stream's output, bounded and correctly decoded.
 *
 * A child process emits bytes, not characters, and a `data` event boundary can
 * land in the middle of a multibyte sequence. Decoding each chunk on its own —
 * which both runners did, and which the caller cannot fix from outside — turns
 * every such character into `U+FFFD`: the bytes of `A文B` arriving as `[41 E6]`
 * and `[96 87 42]` decoded to `A���B`. That corruption happens far below the
 * cap, so no amount of care in the truncation logic addresses it.
 *
 * `StringDecoder` holds the trailing partial sequence back until the bytes that
 * complete it arrive, which is why each stream needs its own collector rather
 * than a shared pure function.
 */
export function createBoundedOutputCollector(): BoundedOutputCollector {
  const decoder = new StringDecoder('utf8')
  let text = ''
  let ended = false

  const push = (value: string) => {
    if (value.length > 0) text = appendBoundedOutput(text, value)
  }

  return {
    append(chunk) {
      push(typeof chunk === 'string' ? chunk : decoder.write(chunk))
    },
    appendText(value) {
      push(value)
    },
    end() {
      if (!ended) {
        ended = true
        // Anything still held back is an incomplete sequence at end of stream.
        // `end()` renders it rather than dropping it, so truncated output is
        // visible as such instead of vanishing.
        push(decoder.end())
      }
      return text
    },
  }
}
