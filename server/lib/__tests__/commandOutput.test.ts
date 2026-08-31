import { describe, expect, it } from 'vitest'
import { appendBoundedOutput } from '../commandOutput'
import { MAX_COMMAND_OUTPUT_BYTES } from '../constants'

const TRUNCATION_NOTICE = `\n[LoopTroop truncated command output at ${MAX_COMMAND_OUTPUT_BYTES} bytes]`

describe('appendBoundedOutput', () => {
  it('appends without a notice while under the cap', () => {
    expect(appendBoundedOutput('one', ' two')).toBe('one two')
  })

  it('accepts a Buffer chunk', () => {
    expect(appendBoundedOutput('one', Buffer.from(' two'))).toBe('one two')
  })

  it('caps ASCII output at the advertised byte count', () => {
    const result = appendBoundedOutput('', 'a'.repeat(MAX_COMMAND_OUTPUT_BYTES + 500))
    expect(result.endsWith(TRUNCATION_NOTICE)).toBe(true)
    const kept = result.slice(0, -TRUNCATION_NOTICE.length)
    expect(Buffer.byteLength(kept, 'utf8')).toBe(MAX_COMMAND_OUTPUT_BYTES)
  })

  it('caps multibyte output at the advertised byte count, not the character count', () => {
    // Three bytes per character: slicing by characters against a byte budget
    // kept three times the cap.
    const chunk = '文'.repeat(MAX_COMMAND_OUTPUT_BYTES)
    const result = appendBoundedOutput('', chunk)

    expect(result.endsWith(TRUNCATION_NOTICE)).toBe(true)
    const kept = result.slice(0, -TRUNCATION_NOTICE.length)
    expect(Buffer.byteLength(kept, 'utf8')).toBeLessThanOrEqual(MAX_COMMAND_OUTPUT_BYTES)
  })

  it('never splits a code point at the boundary', () => {
    // The cap is not a multiple of 3, so a byte-exact slice would land inside a
    // character and decode to U+FFFD.
    const result = appendBoundedOutput('', '文'.repeat(MAX_COMMAND_OUTPUT_BYTES))
    expect(result).not.toContain('�')
  })

  it('counts what is already there before deciding how much fits', () => {
    const existing = 'x'.repeat(MAX_COMMAND_OUTPUT_BYTES - 10)
    const result = appendBoundedOutput(existing, 'y'.repeat(100))
    const kept = result.slice(0, -TRUNCATION_NOTICE.length)
    expect(Buffer.byteLength(kept, 'utf8')).toBe(MAX_COMMAND_OUTPUT_BYTES)
  })

  it('returns the existing output untouched once the cap is reached', () => {
    const full = 'x'.repeat(MAX_COMMAND_OUTPUT_BYTES)
    expect(appendBoundedOutput(full, 'more')).toBe(full)
  })
})
