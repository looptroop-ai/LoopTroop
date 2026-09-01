import { describe, expect, it } from 'vitest'
import { appendBoundedOutput, createBoundedOutputCollector } from '../commandOutput'
import { MAX_COMMAND_OUTPUT_BYTES } from '../constants'

const TRUNCATION_NOTICE = `\n[LoopTroop truncated command output at ${MAX_COMMAND_OUTPUT_BYTES} bytes]`

/** The text kept, with the notice removed if one was appended. */
function keptText(result: string): string {
  return result.endsWith(TRUNCATION_NOTICE) ? result.slice(0, -TRUNCATION_NOTICE.length) : result
}

describe('appendBoundedOutput', () => {
  it('appends without a notice while under the cap', () => {
    expect(appendBoundedOutput('one', ' two')).toBe('one two')
  })

  it('caps ASCII output at the advertised byte count', () => {
    const result = appendBoundedOutput('', 'a'.repeat(MAX_COMMAND_OUTPUT_BYTES + 500))
    expect(result.endsWith(TRUNCATION_NOTICE)).toBe(true)
    expect(Buffer.byteLength(keptText(result), 'utf8')).toBe(MAX_COMMAND_OUTPUT_BYTES)
  })

  it('caps multibyte output on a code-point boundary below the cap', () => {
    // Three bytes per character and the cap is not a multiple of three, so the
    // last whole character ends short of it. Slicing by JavaScript characters
    // against a byte budget kept three times the cap instead.
    const result = appendBoundedOutput('', '文'.repeat(MAX_COMMAND_OUTPUT_BYTES))
    const kept = keptText(result)

    expect(result.endsWith(TRUNCATION_NOTICE)).toBe(true)
    expect(Buffer.byteLength(kept, 'utf8')).toBe(Math.floor(MAX_COMMAND_OUTPUT_BYTES / 3) * 3)
    expect(kept).not.toContain('�')
  })

  it('reports truncation even when the boundary lands short of the cap', () => {
    // One byte of room and a three-byte character: nothing fits, so nothing is
    // appended and the cap is never technically reached. It still dropped
    // output and still has to say so.
    const existing = 'x'.repeat(MAX_COMMAND_OUTPUT_BYTES - 1)
    const result = appendBoundedOutput(existing, '文')

    expect(result.endsWith(TRUNCATION_NOTICE)).toBe(true)
    expect(keptText(result)).toBe(existing)
  })

  it('counts what is already there before deciding how much fits', () => {
    const existing = 'x'.repeat(MAX_COMMAND_OUTPUT_BYTES - 10)
    const result = appendBoundedOutput(existing, 'y'.repeat(100))
    expect(Buffer.byteLength(keptText(result), 'utf8')).toBe(MAX_COMMAND_OUTPUT_BYTES)
  })

  it('reports output dropped after the cap was already reached', () => {
    const full = 'x'.repeat(MAX_COMMAND_OUTPUT_BYTES)
    const result = appendBoundedOutput(full, 'more')

    expect(keptText(result)).toBe(full)
    expect(result.endsWith(TRUNCATION_NOTICE)).toBe(true)
  })

  it('does not stack notices across repeated dropped chunks', () => {
    const full = 'x'.repeat(MAX_COMMAND_OUTPUT_BYTES)
    const once = appendBoundedOutput(full, 'more')

    expect(appendBoundedOutput(once, 'and more')).toBe(once)
  })

  it('says nothing when an empty chunk arrives after the cap', () => {
    const full = 'x'.repeat(MAX_COMMAND_OUTPUT_BYTES)
    expect(appendBoundedOutput(full, '')).toBe(full)
  })
})

describe('createBoundedOutputCollector', () => {
  it('joins string chunks', () => {
    const collector = createBoundedOutputCollector()
    collector.append('one')
    collector.append(' two')
    expect(collector.end()).toBe('one two')
  })

  it('keeps a multibyte character split across two chunks intact', () => {
    // The bytes of 'A文B', cut inside the three-byte character. Decoding each
    // chunk on its own produced 'A���B'.
    const collector = createBoundedOutputCollector()
    collector.append(Buffer.from([0x41, 0xE6]))
    collector.append(Buffer.from([0x96, 0x87, 0x42]))

    expect(collector.end()).toBe('A文B')
  })

  it('keeps a character split across three chunks intact', () => {
    const collector = createBoundedOutputCollector()
    collector.append(Buffer.from([0xE6]))
    collector.append(Buffer.from([0x96]))
    collector.append(Buffer.from([0x87]))

    expect(collector.end()).toBe('文')
  })

  it('renders an incomplete sequence at end of stream rather than dropping it', () => {
    const collector = createBoundedOutputCollector()
    collector.append(Buffer.from([0x41, 0xE6]))

    // The truncated character becomes a replacement character, but the 'A'
    // before it survives — the alternative is losing the whole tail silently.
    const result = collector.end()
    expect(result.startsWith('A')).toBe(true)
    expect(result.length).toBeGreaterThan(1)
  })

  it('is safe to end more than once', () => {
    const collector = createBoundedOutputCollector()
    collector.append('one')
    expect(collector.end()).toBe('one')
    expect(collector.end()).toBe('one')
  })

  it('bounds text appended outside the stream', () => {
    const collector = createBoundedOutputCollector()
    collector.append('x'.repeat(MAX_COMMAND_OUTPUT_BYTES))
    collector.appendText('spawn failed')

    expect(Buffer.byteLength(keptText(collector.end()), 'utf8')).toBe(MAX_COMMAND_OUTPUT_BYTES)
  })

  it('still bounds output that arrives in many chunks', () => {
    const collector = createBoundedOutputCollector()
    for (let index = 0; index < 12; index += 1) {
      collector.append('a'.repeat(100_000))
    }

    const result = collector.end()
    expect(result.endsWith(TRUNCATION_NOTICE)).toBe(true)
    expect(Buffer.byteLength(keptText(result), 'utf8')).toBe(MAX_COMMAND_OUTPUT_BYTES)
  })
})
