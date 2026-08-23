import { describe, expect, it } from 'vitest'
import {
  buildExecutionBandConflictMessage,
  EXECUTION_BAND_CONCURRENCY_LIMIT_MESSAGE,
  EXECUTION_BAND_STATUSES,
  getExecutionBandStatusLabel,
  isExecutionBandStatus,
} from '../executionBand'

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

  it.each([...EXECUTION_BAND_STATUSES])('explains a conflict for %s with the configured alpha limit', (status) => {
    const message = buildExecutionBandConflictMessage(
      { externalId: 'TEST-4' },
      { externalId: 'TEST-2', status },
    )

    expect(message).toContain('TEST-4 can’t enter execution yet because TEST-2 is still running')
    expect(message).toContain(`currently at ${getExecutionBandStatusLabel(status)}.`)
    expect(message).toContain(EXECUTION_BAND_CONCURRENCY_LIMIT_MESSAGE)
    expect(message).toContain('Finish or cancel TEST-2, then try again.')
    expect(message).not.toContain('?/?')
  })
})
