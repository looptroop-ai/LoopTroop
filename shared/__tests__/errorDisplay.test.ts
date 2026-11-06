import { describe, expect, it } from 'vitest'
import { sanitizeErrorForDisplay, stripTerminalFormatting } from '../errorDisplay'

describe('stripTerminalFormatting', () => {
  it('keeps indentation, repeated lines, and punctuation in structured text', () => {
    const raw = '\u001b[31m{\r\n  "items": [\r\n    {},\r\n    {},\r\n    {}\r\n  ]\r\n}\u001b[0m\u0007'

    expect(stripTerminalFormatting(raw)).toBe('{\n  "items": [\n    {},\n    {},\n    {}\n  ]\n}')
  })

  it('removes C0, DEL and C1 controls but keeps tabs, newlines and astral characters', () => {
    const controls = [0x00, 0x08, 0x0b, 0x0c, 0x1f, 0x7f, 0x80, 0x9f].map((code) => String.fromCharCode(code)).join('')

    // Just above the C1 range: a no-break space and an inverted exclamation mark stay.
    const aboveC1 = String.fromCharCode(0xa0, 0xa1)
    expect(stripTerminalFormatting(`a\tb${controls}\nc é 😀 ${aboveC1}`)).toBe(`a\tb\nc é 😀 ${aboveC1}`)
  })
})

describe('sanitizeErrorForDisplay', () => {
  it('removes terminal escapes, control characters, decoration lines, and consecutive duplicate warnings', () => {
    const warning = "Testing types with tsc and vue-tsc is an experimental feature."
    const raw = [
      `\u001b[33m${warning}\u001b[39m`,
      `\u001b[33m${warning}\u001b[39m`,
      '\u001b[31m──────\u001b[39m',
      '\u001b[41m FAIL \u001b[49m src/example.test.ts\u0007',
      'Cannot resolve package/example',
    ].join('\r\n')

    expect(sanitizeErrorForDisplay(raw)).toBe([
      warning,
      ' FAIL  src/example.test.ts',
      'Cannot resolve package/example',
    ].join('\n'))
  })

  it('preserves distinct actionable lines and normal line breaks', () => {
    expect(sanitizeErrorForDisplay('Command failed (1): test\nTimed out after 30s\nCommand failed (1): test')).toBe(
      'Command failed (1): test\nTimed out after 30s\nCommand failed (1): test',
    )
  })

  it('deduplicates a repeated terminal warning even when output collapsed onto one line', () => {
    expect(sanitizeErrorForDisplay('Experimental warning. Experimental warning. FAIL src/example.test.ts')).toBe(
      'Experimental warning. FAIL src/example.test.ts',
    )
  })

  it('deduplicates repeated multiline warning blocks', () => {
    const raw = [
      'Experimental type testing.',
      'Pin the current Vitest version.',
      'Experimental type testing.',
      'Pin the current Vitest version.',
      'Experimental type testing.',
      'Pin the current Vitest version.',
      'FAIL src/example.test.ts',
    ].join('\n')

    expect(sanitizeErrorForDisplay(raw)).toBe([
      'Experimental type testing.',
      'Pin the current Vitest version.',
      'FAIL src/example.test.ts',
    ].join('\n'))
  })
})
