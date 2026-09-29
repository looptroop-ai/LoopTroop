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

  it.each([
    { direction: 'inserted span', before: 'alpha omega', after: 'alpha beta omega', changedOn: 'after' },
    { direction: 'deleted span', before: 'alpha beta omega', after: 'alpha omega', changedOn: 'before' },
  ])('marks only the side containing the $direction', ({ before, after, changedOn }) => {
    const unchanged = [{ text: 'alpha omega', changed: false }]
    const changed = [
      { text: 'alpha ', changed: false },
      { text: 'beta ', changed: true },
      { text: 'omega', changed: false },
    ]
    const expected = changedOn === 'before'
      ? { before: changed, after: unchanged }
      : { before: unchanged, after: changed }

    expect(buildTextDiffSegments(before, after)).toEqual(expected)
  })

  it.each([
    {
      direction: 'insertion',
      before: 'stable',
      after: 'stable added',
      expected: {
        before: [{ text: 'stable', changed: false }],
        after: [{ text: 'stable', changed: false }, { text: ' added', changed: true }],
      },
    },
    {
      direction: 'deletion',
      before: 'stable removed',
      after: 'stable',
      expected: {
        before: [{ text: 'stable', changed: false }, { text: ' removed', changed: true }],
        after: [{ text: 'stable', changed: false }],
      },
    },
  ])('keeps a trailing $direction in its changed span', ({ before, after, expected }) => {
    expect(buildTextDiffSegments(before, after)).toEqual(expected)
  })

  it('coalesces adjacent changed word and punctuation tokens into one span', () => {
    expect(buildTextDiffSegments('keep old! tail', 'keep new? tail')).toEqual({
      before: [
        { text: 'keep ', changed: false },
        { text: 'old!', changed: true },
        { text: ' tail', changed: false },
      ],
      after: [
        { text: 'keep ', changed: false },
        { text: 'new?', changed: true },
        { text: ' tail', changed: false },
      ],
    })
  })

  it('returns empty segments for empty inputs', () => {
    expect(buildTextDiffSegments('', '')).toEqual({ before: [], after: [] })
    expect(buildTextDiffSegments(undefined, '')).toEqual({ before: [], after: [] })
  })

  it.each([
    { direction: 'inserted', before: '', after: 'new text', expected: { before: [], after: [{ text: 'new text', changed: true }] } },
    { direction: 'deleted', before: 'old text', after: '', expected: { before: [{ text: 'old text', changed: true }], after: [] } },
  ])('marks full-text $direction as changed', ({ before, after, expected }) => {
    expect(buildTextDiffSegments(before, after)).toEqual(expected)
  })

  it('uses a bounded replacement for oversized token streams', () => {
    const before = Array.from({ length: 2_001 }, (_, index) => `before${index}`).join(' ')
    const after = Array.from({ length: 2_001 }, (_, index) => `after${index}`).join(' ')

    expect(buildTextDiffSegments(before, after)).toEqual({
      before: [{ text: before, changed: true }],
      after: [{ text: after, changed: true }],
    })
  })

  it('uses a bounded replacement when the token limit is exceeded below the cell limit', () => {
    const before = `${'before '.repeat(1_000)}last`
    const after = 'after'

    expect(buildTextDiffSegments(before, after)).toEqual({
      before: [{ text: before, changed: true }],
      after: [{ text: after, changed: true }],
    })
  })

  it('keeps a token diff at the exact cell limit', () => {
    const unchangedPrefix = 'same '.repeat(249)
    const before = `${unchangedPrefix}old `
    const after = `${unchangedPrefix}new `

    expect(buildTextDiffSegments(before, after)).toEqual({
      before: [
        { text: unchangedPrefix, changed: false },
        { text: 'old', changed: true },
        { text: ' ', changed: false },
      ],
      after: [
        { text: unchangedPrefix, changed: false },
        { text: 'new', changed: true },
        { text: ' ', changed: false },
      ],
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
