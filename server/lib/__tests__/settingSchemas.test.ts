import { describe, expect, it } from 'vitest'
import { aiQuestionWindowOverrideSchema, aiQuestionWindowSchema } from '../settingSchemas'

describe('AI question wait schemas', () => {
  it.each([60_000, 120_000, 300_000, 3_600_000])('accepts a whole-minute wait of %i ms', value => {
    expect(aiQuestionWindowSchema.parse(value)).toBe(value)
    expect(aiQuestionWindowOverrideSchema.parse(value)).toBe(value)
  })

  it.each([59_999, 60_001, 90_000, 3_600_001, 3_660_000, 120_000.5, '120000', null])('rejects invalid wait %j', value => {
    expect(aiQuestionWindowSchema.safeParse(value).success).toBe(false)
  })

  it('allows omitted and inherited overrides without weakening the numeric contract', () => {
    expect(aiQuestionWindowOverrideSchema.parse(undefined)).toBeUndefined()
    expect(aiQuestionWindowOverrideSchema.parse(null)).toBeNull()
    expect(aiQuestionWindowOverrideSchema.safeParse(90_000).success).toBe(false)
  })
})
