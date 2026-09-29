import { describe, expect, it } from 'vitest'
import { buildTextDiffSegments } from './textDiffSegments'

const unchanged = (text: string) => ({ text, changed: false })
const changed = (text: string) => ({ text, changed: true })

describe('buildTextDiffSegments', () => {
  it('keeps equal small text as one unchanged segment', () => {
    expect(buildTextDiffSegments('one two', 'one two')).toEqual({
      before: [unchanged('one two')],
      after: [unchanged('one two')],
    })
  })

  it('marks only the changed span', () => {
    expect(buildTextDiffSegments('The quick brown fox', 'The quick red fox')).toEqual({
      before: [
        unchanged('The quick '),
        changed('brown'),
        unchanged(' fox'),
      ],
      after: [
        unchanged('The quick '),
        changed('red'),
        unchanged(' fox'),
      ],
    })
  })

  it.each([
    { direction: 'inserted span', before: 'alpha omega', after: 'alpha beta omega', changedOn: 'after' },
    { direction: 'deleted span', before: 'alpha beta omega', after: 'alpha omega', changedOn: 'before' },
  ])('marks only the side containing the $direction', ({ before, after, changedOn }) => {
    const unchangedSpan = [unchanged('alpha omega')]
    const changedSpan = [
      unchanged('alpha '),
      changed('beta '),
      unchanged('omega'),
    ]
    const expected = changedOn === 'before'
      ? { before: changedSpan, after: unchangedSpan }
      : { before: unchangedSpan, after: changedSpan }

    expect(buildTextDiffSegments(before, after)).toEqual(expected)
  })

  it.each([
    {
      direction: 'insertion',
      before: 'stable',
      after: 'stable added',
      expected: {
        before: [unchanged('stable')],
        after: [unchanged('stable'), changed(' added')],
      },
    },
    {
      direction: 'deletion',
      before: 'stable removed',
      after: 'stable',
      expected: {
        before: [unchanged('stable'), changed(' removed')],
        after: [unchanged('stable')],
      },
    },
  ])('keeps a trailing $direction in its changed span', ({ before, after, expected }) => {
    expect(buildTextDiffSegments(before, after)).toEqual(expected)
  })

  it('coalesces adjacent changed word and punctuation tokens into one span', () => {
    expect(buildTextDiffSegments('keep old! tail', 'keep new? tail')).toEqual({
      before: [
        unchanged('keep '),
        changed('old!'),
        unchanged(' tail'),
      ],
      after: [
        unchanged('keep '),
        changed('new?'),
        unchanged(' tail'),
      ],
    })
  })

  it('returns empty segments for empty inputs', () => {
    expect(buildTextDiffSegments('', '')).toEqual({ before: [], after: [] })
    expect(buildTextDiffSegments(undefined, '')).toEqual({ before: [], after: [] })
  })

  it.each([
    { direction: 'inserted', before: '', after: 'new text', expected: { before: [], after: [changed('new text')] } },
    { direction: 'deleted', before: 'old text', after: '', expected: { before: [changed('old text')], after: [] } },
  ])('marks full-text $direction as changed', ({ before, after, expected }) => {
    expect(buildTextDiffSegments(before, after)).toEqual(expected)
  })

  it('uses a bounded replacement when the token limit is exceeded below the cell limit', () => {
    const before = `${'same '.repeat(1_000)}old`
    const after = 'same new'

    expect(buildTextDiffSegments(before, after)).toEqual({
      before: [changed(before)],
      after: [changed(after)],
    })
  })

  it('keeps a token diff at the exact cell limit', () => {
    const unchangedPrefix = 'same '.repeat(249)
    const before = `${unchangedPrefix}old `
    const after = `${unchangedPrefix}new `

    expect(buildTextDiffSegments(before, after)).toEqual({
      before: [
        unchanged(unchangedPrefix),
        changed('old'),
        unchanged(' '),
      ],
      after: [
        unchanged(unchangedPrefix),
        changed('new'),
        unchanged(' '),
      ],
    })
  })

  it('uses a bounded replacement when the token matrix exceeds the cell limit', () => {
    const sharedPrefix = 'same '.repeat(250)
    const before = `${sharedPrefix}old`
    const after = `${sharedPrefix}new`

    expect(buildTextDiffSegments(before, after)).toEqual({
      before: [changed(before)],
      after: [changed(after)],
    })
  })
})
