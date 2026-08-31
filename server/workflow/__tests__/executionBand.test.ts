import { describe, expect, it } from 'vitest'
import { WORKFLOW_PHASE_IDS } from '@shared/workflowMeta'
import {
  buildExecutionBandConflictMessage,
  EXECUTION_BAND_CONCURRENCY_LIMIT_MESSAGE,
  EXECUTION_BAND_STATUSES,
  getExecutionBandStatusLabel,
  isExecutionBandStatus,
} from '../executionBand'

describe('executionBand', () => {
  it('is exactly the twelve statuses that hold the execution slot', () => {
    // Derived from the shared phase table rather than listed here, so this is
    // the assertion that says which statuses that derivation must produce.
    expect([...EXECUTION_BAND_STATUSES].sort()).toEqual([
      'CLEANING_ENV',
      'CODING',
      'CREATING_PULL_REQUEST',
      'GENERATING_EXECUTION_SETUP_PLAN',
      'GENERATING_QA_CHECKLIST',
      'INTEGRATING_CHANGES',
      'PREPARING_EXECUTION_ENV',
      'PRE_FLIGHT_CHECK',
      'RUNNING_FINAL_TEST',
      'WAITING_EXECUTION_SETUP_APPROVAL',
      'WAITING_MANUAL_QA',
      'WAITING_PR_REVIEW',
    ])
  })

  it('includes setup-plan drafting in the execution lock band', () => {
    expect(EXECUTION_BAND_STATUSES).toEqual(expect.arrayContaining([
      'PRE_FLIGHT_CHECK',
      'GENERATING_EXECUTION_SETUP_PLAN',
      'WAITING_EXECUTION_SETUP_APPROVAL',
      'PREPARING_EXECUTION_ENV',
    ]))
    expect(isExecutionBandStatus('GENERATING_EXECUTION_SETUP_PLAN')).toBe(true)
  })

  it('answers for every status the same way the list does', () => {
    for (const status of EXECUTION_BAND_STATUSES) {
      expect(isExecutionBandStatus(status), status).toBe(true)
    }
    for (const status of WORKFLOW_PHASE_IDS.filter((id) => !EXECUTION_BAND_STATUSES.includes(id))) {
      expect(isExecutionBandStatus(status), status).toBe(false)
    }
  })

  it('keeps planning, terminal and unknown statuses out of the band', () => {
    expect(isExecutionBandStatus('DRAFT')).toBe(false)
    expect(isExecutionBandStatus('WAITING_BEADS_APPROVAL')).toBe(false)
    expect(isExecutionBandStatus('COMPLETED')).toBe(false)
    expect(isExecutionBandStatus('BLOCKED_ERROR')).toBe(false)
    expect(isExecutionBandStatus('NOT_A_STATUS')).toBe(false)
    expect(isExecutionBandStatus(null)).toBe(false)
    expect(isExecutionBandStatus(undefined)).toBe(false)
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
