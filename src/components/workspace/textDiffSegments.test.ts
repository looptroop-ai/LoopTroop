import { describe, expect, it } from 'vitest'
import { buildTextDiffSegments } from './textDiffSegments'

describe('buildTextDiffSegments', () => {
  it('keeps equal small text as one unchanged segment', () => {
    expect(buildTextDiffSegments('one two', 'one two')).toEqual({
      before: [{ text: 'one two', changed: false }],
      after: [{ text: 'one two', changed: false }],
    })
  })

  it('marks only the changed span', () => {
    expect(buildTextDiffSegments('The quick brown fox', 'The quick red fox')).toEqual({
      before: [
        { text: 'The quick ', changed: false },
        { text: 'brown', changed: true },
        { text: ' fox', changed: false },
      ],
      after: [
        { text: 'The quick ', changed: false },
        { text: 'red', changed: true },
        { text: ' fox', changed: false },
      ],
    })
  })

  it('marks inserted and deleted spans on only the side that contains them', () => {
    expect(buildTextDiffSegments('alpha omega', 'alpha beta omega')).toEqual({
      before: [{ text: 'alpha omega', changed: false }],
      after: [
        { text: 'alpha ', changed: false },
        { text: 'beta ', changed: true },
        { text: 'omega', changed: false },
      ],
    })
    expect(buildTextDiffSegments('alpha beta omega', 'alpha omega')).toEqual({
      before: [
        { text: 'alpha ', changed: false },
        { text: 'beta ', changed: true },
        { text: 'omega', changed: false },
      ],
      after: [{ text: 'alpha omega', changed: false }],
    })
  })

  it('coalesces adjacent changed tokens into one span', () => {
    expect(buildTextDiffSegments('keep -old tail', 'keep +new tail')).toEqual({
      before: [
        { text: 'keep ', changed: false },
        { text: '-old', changed: true },
        { text: ' tail', changed: false },
      ],
      after: [
        { text: 'keep ', changed: false },
        { text: '+new', changed: true },
        { text: ' tail', changed: false },
      ],
    })
  })

  it('returns empty segments for empty inputs', () => {
    expect(buildTextDiffSegments('', '')).toEqual({ before: [], after: [] })
    expect(buildTextDiffSegments(undefined, '')).toEqual({ before: [], after: [] })
  })

  it('uses a bounded replacement for oversized token streams', () => {
    const before = Array.from({ length: 2_001 }, (_, index) => `before${index}`).join(' ')
    const after = Array.from({ length: 2_001 }, (_, index) => `after${index}`).join(' ')

    expect(buildTextDiffSegments(before, after)).toEqual({
      before: [{ text: before, changed: true }],
      after: [{ text: after, changed: true }],
    })
  })

  it('uses a bounded replacement when the token matrix exceeds the cell limit', () => {
    const before = Array.from({ length: 251 }, (_, index) => `before${index}`).join(' ')
    const after = Array.from({ length: 251 }, (_, index) => `after${index}`).join(' ')

    expect(buildTextDiffSegments(before, after)).toEqual({
      before: [{ text: before, changed: true }],
      after: [{ text: after, changed: true }],
    })
  })
})
