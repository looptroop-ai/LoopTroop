import { describe, expect, it } from 'vitest'
import { sanitizeErrorForDisplay } from '../errorDisplay'

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
