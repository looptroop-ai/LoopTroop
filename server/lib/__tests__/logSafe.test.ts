import { describe, expect, it } from 'vitest'
import { containsControlCharacters, logSafe, logSafeError } from '../logSafe'

describe('logSafe', () => {
  it('leaves an ordinary ticket reference readable', () => {
    expect(logSafe('16:LOOP-1')).toBe('16:LOOP-1')
  })

  it.each([
    ['newline', '\n', '\\n'],
    ['carriage return', '\r', '\\r'],
    ['tab', '\t', '\\t'],
    ['vertical tab', '\u000b', '\\v'],
    ['form feed', '\f', '\\f'],
    ['null', '\u0000', '\\u0000'],
    ['DEL', '\u007f', '\\u007f'],
    ['NEL', '\u0085', '\\u0085'],
    ['C1 end', '\u009f', '\\u009f'],
    ['line separator', '\u2028', '\\u2028'],
    ['paragraph separator', '\u2029', '\\u2029'],
    ['zero-width space', '\u200b', '\\u200b'],
    ['right-to-left override', '\u202e', '\\u202e'],
    ['left-to-right isolate', '\u2066', '\\u2066'],
    ['Arabic letter mark', '\u061c', '\\u061c'],
  ])('escapes %s', (_name, input, escaped) => {
    expect(logSafe(`a${input}b`)).toBe(`a${escaped}b`)
  })

  it('escapes terminal control sequences', () => {
    expect(logSafe('a\u001b[31mb')).toBe('a\\u001b[31mb')
  })

  it('stringifies values that are not strings', () => {
    expect(logSafe(42)).toBe('42')
    const absent: unknown = undefined
    expect(logSafe(absent)).toBe('undefined')
  })

  it('survives values that cannot be converted to text', () => {
    expect(logSafe(Object.create(null))).toBe('[unprintable value]')
    expect(logSafe({ toString: () => { throw new Error('no text') } })).toBe('[unprintable value]')
  })
})

describe('logSafeError', () => {
  it('renders an error message and stack as one escaped line', () => {
    const error = new Error('boom\n[INFO] forged')
    const rendered = logSafeError(error)

    expect(rendered).toContain('boom\\n[INFO] forged')
    expect(rendered).not.toContain('\n')
  })

  it('escapes a thrown string', () => {
    expect(logSafeError('plain\nline')).toBe('plain\\nline')
  })
})

describe('containsControlCharacters', () => {
  it('accepts an ordinary ticket reference', () => {
    expect(containsControlCharacters('16:LOOP-1')).toBe(false)
  })

  it.each(['a\nb', 'a\rb', 'a\u0085b', 'a\u2028b', 'a\u202eb', 'a\u2066b'])(
    'rejects a value containing a control character: %j',
    (value) => {
      expect(containsControlCharacters(value)).toBe(true)
    },
  )
})
