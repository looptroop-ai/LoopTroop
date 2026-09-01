import { describe, expect, it } from 'vitest'
import { stripTranscriptLinePrefix, stripTranscriptPrefixes } from '../transcriptPrefix'

describe('stripTranscriptLinePrefix', () => {
  it('leaves a line with no prefix alone', () => {
    expect(stripTranscriptLinePrefix('summary: all good')).toBe('summary: all good')
  })

  it('strips a single speaker prefix', () => {
    expect(stripTranscriptLinePrefix('[assistant] summary: all good')).toBe('summary: all good')
  })

  it('strips a speaker prefix carrying a qualifier', () => {
    expect(stripTranscriptLinePrefix('[assistant/gpt-5] summary: all good')).toBe('summary: all good')
  })

  it('strips stacked prefixes to a fixpoint', () => {
    // This is the behaviour the structured-output parser and the prompt-echo
    // detector gain: they previously removed only the first prefix, leaving a
    // line still opening with a bracket that YAML reads as a flow sequence.
    expect(stripTranscriptLinePrefix('[assistant][tool][system] summary: all good'))
      .toBe('summary: all good')
  })

  it('is case-insensitive', () => {
    expect(stripTranscriptLinePrefix('[ASSISTANT] summary')).toBe('summary')
  })

  it('leaves a bracketed value that is not a speaker tag', () => {
    expect(stripTranscriptLinePrefix('[note] summary')).toBe('[note] summary')
  })

  it('leaves a bracket that is not at the start of the line', () => {
    expect(stripTranscriptLinePrefix('summary: [assistant] said so')).toBe('summary: [assistant] said so')
  })
})

describe('stripTranscriptPrefixes', () => {
  it('strips every line independently', () => {
    expect(stripTranscriptPrefixes('[assistant] one\n[tool] two\nthree'))
      .toBe('one\ntwo\nthree')
  })

  it('does not trim the document', () => {
    // Two of the three callers add their own trim; the interview parser relies
    // on the surrounding whitespace surviving.
    expect(stripTranscriptPrefixes('\n[assistant] one\n')).toBe('\none\n')
  })

  it('returns content with no prefixes unchanged', () => {
    const content = 'summary: all good\n  detail: indented\n'
    expect(stripTranscriptPrefixes(content)).toBe(content)
  })
})
