import { describe, expect, it } from 'vitest'
import { EXECUTION_BAND_STATUSES, isExecutionBandStatus } from '../executionBand'

describe('executionBand', () => {
  it('includes setup-plan drafting in the execution lock band', () => {
    expect(EXECUTION_BAND_STATUSES).toEqual(expect.arrayContaining([
      'PRE_FLIGHT_CHECK',
      'GENERATING_EXECUTION_SETUP_PLAN',
      'WAITING_EXECUTION_SETUP_APPROVAL',
      'PREPARING_EXECUTION_ENV',
    ]))
    expect(isExecutionBandStatus('GENERATING_EXECUTION_SETUP_PLAN')).toBe(true)
  })
})
