/**
 * Escapes control characters in a value before it is interpolated into a log
 * message.
 *
 * Console output is line-oriented. A ticket reference or another value that
 * came from an HTTP request can carry a line break, and an unescaped break
 * starts a second line that reads like a genuine log entry. Terminal escape
 * sequences are escaped for the same reason: they can rewrite what a reader
 * sees on the line.
 *
 * Ordinary references are left untouched, so `16:LOOP-1` stays readable. The
 * escape is applied only at the point of logging; the value itself is never
 * changed for routing, storage or lookup.
 */
const NAMED_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\u000b': '\\v',
  '\f': '\\f',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}

function isControlCharacter(codePoint: number): boolean {
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029
}

export function logSafe(value: unknown): string {
  let safe = ''
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0)!
    safe += isControlCharacter(codePoint)
      ? NAMED_ESCAPES[character] ?? `\\u${codePoint.toString(16).padStart(4, '0')}`
      : character
  }
  return safe
}
