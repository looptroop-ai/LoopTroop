import { describe, it, expect } from 'vitest'
import {
  slugify,
  toNonBlankStringEntries,
  toStringEntries,
  toStringValue,
  toTrimmedStringEntries,
} from '../stringNormalization'

describe('toStringValue', () => {
  it('passes strings through and turns everything else into the empty string', () => {
    expect(toStringValue('  spaced  ')).toBe('  spaced  ')
    expect(toStringValue(7)).toBe('')
    expect(toStringValue(null)).toBe('')
    expect(toStringValue(undefined)).toBe('')
    expect(toStringValue({ toString: () => 'nope' })).toBe('')
  })
})

// The three array helpers replace copies that did not agree with each other.
// These cases are the exact inputs on which they disagree, so a later attempt to
// collapse them into one implementation fails here rather than in production.
const MIXED = ['  keep  ', '', '   ', 'plain', 42, null, undefined, {}]

describe('the three array normalisers stay distinct', () => {
  it('toStringEntries keeps every string, blanks and whitespace included', () => {
    expect(toStringEntries(MIXED)).toEqual(['  keep  ', '', '   ', 'plain'])
  })

  it('toNonBlankStringEntries drops blanks but does not trim what it keeps', () => {
    expect(toNonBlankStringEntries(MIXED)).toEqual(['  keep  ', 'plain'])
  })

  it('toTrimmedStringEntries trims first, then drops what became empty', () => {
    expect(toTrimmedStringEntries(MIXED)).toEqual(['keep', 'plain'])
  })

  it('all three return an empty array for a non-array', () => {
    for (const value of [undefined, null, 'string', 3, {}]) {
      expect(toStringEntries(value)).toEqual([])
      expect(toNonBlankStringEntries(value)).toEqual([])
      expect(toTrimmedStringEntries(value)).toEqual([])
    }
  })
})

describe('slugify', () => {
  it('lowercases, collapses runs of non-alphanumerics, and strips the edges', () => {
    expect(slugify('  Error Handling Rules!  ')).toBe('error-handling-rules')
    expect(slugify('API/Contracts — v2')).toBe('api-contracts-v2')
    expect(slugify('EPIC_01')).toBe('epic-01')
  })

  it('returns an empty string when nothing survives, so callers can fall back', () => {
    expect(slugify('///')).toBe('')
    expect(slugify('   ')).toBe('')
  })
})
