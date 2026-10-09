import { describe, expect, it } from 'vitest'
import { buildInitialRawNumeric, getFieldError, hasNumericErrors, numericFields } from '../numericFieldConfig'

describe('numericFieldConfig', () => {
  it.each(['maxIterations', 'opencodeRetryLimit', 'interviewQuestions', 'structuredRetryCount'] as const)('requires numeric text instead of whitespace for %s', key => {
    const rawNumeric = buildInitialRawNumeric({})
    for (const raw of ['', ' ', '\t\n']) {
      rawNumeric[key] = raw
      expect(getFieldError(key, rawNumeric)).toBe(`Required (0 to ${numericFields[key].max})`)
      expect(hasNumericErrors(rawNumeric)).toBe(true)
    }

    rawNumeric[key] = ' 0 '
    expect(getFieldError(key, rawNumeric)).toBeNull()
    expect(hasNumericErrors(rawNumeric)).toBe(false)
  })
})
