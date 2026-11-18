import { inspect } from 'node:util'

/**
 * Escapes control characters in a value before it is interpolated into a log
 * message.
 *
 * Console output is line-oriented. A ticket reference or another value that
 * came from an HTTP request can carry a line break, and an unescaped break
 * starts a second line that reads like a genuine log entry. Terminal escape
 * sequences are escaped for the same reason: they can rewrite what a reader
 * sees on the line. Bidirectional and zero-width format characters are escaped
 * because they can reorder or hide text without leaving the line.
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

const isControlCharacter = (codePoint: number): boolean =>
  codePoint < 0x20
  || (codePoint >= 0x7f && codePoint <= 0x9f)
  || codePoint === 0x2028
  || codePoint === 0x2029
  || (codePoint >= 0x200b && codePoint <= 0x200f)
  || (codePoint >= 0x202a && codePoint <= 0x202e)
  || (codePoint >= 0x2066 && codePoint <= 0x2069)
  || codePoint === 0x2060
  || codePoint === 0xfeff
  || codePoint === 0x061c

const toText = (value: unknown): string => {
  try {
    return String(value)
  } catch {
    // A null-prototype object or a throwing toString must not hide the
    // original failure this helper was called to report.
    return '[unprintable value]'
  }
}

export const logSafe = (value: unknown): string => {
  let safe = ''
  for (const character of toText(value)) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) {
      safe += character
      continue
    }
    safe += isControlCharacter(codePoint)
      ? NAMED_ESCAPES[character] ?? `\\u${codePoint.toString(16).padStart(4, '0')}`
      : character
  }
  return safe
}

/** Reuses the log policy to reject the same characters at a trust boundary. */
export const containsControlCharacters = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && isControlCharacter(codePoint)) return true
  }
  return false
}

/**
 * Renders an error or rejection value as one escaped log line.
 *
 * `util.inspect` keeps the stack, the `cause` chain within the inspection
 * depth limit and the fields of plain objects, which the previous raw console
 * argument showed. Strings stay unquoted so an ordinary error message reads the
 * same as before.
 */
export const logSafeError = (value: unknown): string => {
  if (typeof value === 'string') return logSafe(value)
  try {
    return logSafe(inspect(value, { depth: 4, breakLength: Infinity, customInspect: false }))
  } catch {
    return logSafe(value)
  }
}
