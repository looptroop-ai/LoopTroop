import { describe, it, expect } from 'vitest'
import { estimateTokens } from '../tokenEstimate'

describe('estimateTokens', () => {
  it('counts four characters per token, rounding up', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('x'.repeat(400_001))).toBe(100_001)
  })
})
