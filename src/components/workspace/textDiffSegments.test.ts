import { describe, expect, it } from 'vitest'
import { buildTextDiffSegments } from './textDiffSegments'

describe('buildTextDiffSegments', () => {
  it('keeps equal small text as one unchanged segment', () => {
    expect(buildTextDiffSegments('one two', 'one two')).toEqual({
      before: [{ text: 'one two', changed: false }],
      after: [{ text: 'one two', changed: false }],
    })
  })

  it('uses a bounded replacement for oversized token streams', () => {
    const before = Array.from({ length: 2_001 }, (_, index) => `before${index}`).join(' ')
    const after = Array.from({ length: 2_001 }, (_, index) => `after${index}`).join(' ')

    expect(buildTextDiffSegments(before, after)).toEqual({
      before: [{ text: before, changed: true }],
      after: [{ text: after, changed: true }],
    })
  })
})
