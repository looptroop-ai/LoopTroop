import { describe, expect, it } from 'vitest'
import { isAiRetryPhase, supportsRetryNote } from '../aiRetry'
import { BEAD_FINALIZATION_FAILED } from '../errorCodes'

describe('AI retry note eligibility', () => {
  it.each([
    'SCANNING_RELEVANT_FILES', 'COUNCIL_DELIBERATING', 'COUNCIL_VOTING_INTERVIEW',
    'COMPILING_INTERVIEW', 'WAITING_INTERVIEW_ANSWERS', 'VERIFYING_INTERVIEW_COVERAGE',
    'DRAFTING_PRD', 'COUNCIL_VOTING_PRD', 'REFINING_PRD', 'VERIFYING_PRD_COVERAGE',
    'DRAFTING_BEADS', 'COUNCIL_VOTING_BEADS', 'REFINING_BEADS', 'VERIFYING_BEADS_COVERAGE',
    'EXPANDING_BEADS', 'GENERATING_EXECUTION_SETUP_PLAN',
    'PREPARING_EXECUTION_ENV', 'CODING', 'RUNNING_FINAL_TEST', 'GENERATING_QA_CHECKLIST',
  ])('allows instructions for retried AI work in %s', phase => {
    expect(isAiRetryPhase(phase)).toBe(true)
    expect(supportsRetryNote(phase)).toBe(true)
  })

  it.each([null, undefined, '', 'unknown', 'DRAFT', 'WAITING_PRD_APPROVAL', 'WAITING_BEADS_APPROVAL',
    'WAITING_EXECUTION_SETUP_APPROVAL', 'INTEGRATING_CHANGES',
    'WAITING_PR_REVIEW', 'CLEANING_ENV', 'COMPLETED', 'CANCELED', 'BLOCKED_ERROR'])(
    'does not offer an AI instruction for %s', phase => {
    expect(isAiRetryPhase(phase)).toBe(false)
    expect(supportsRetryNote(phase)).toBe(false)
    },
  )

  it('keeps a successful implementation on its finalization recovery path', () => {
    expect(supportsRetryNote('CODING', [BEAD_FINALIZATION_FAILED])).toBe(false)
    expect(supportsRetryNote('CODING', ['BEAD_EXECUTION_FAILED'])).toBe(true)
  })

  it.each(['PRE_FLIGHT_CHECK', 'CREATING_PULL_REQUEST'])('offers notes only for AI failures within %s', phase => {
    expect(supportsRetryNote(phase)).toBe(false)
    expect(supportsRetryNote(phase, [], { kind: 'runtime', source: 'system', summary: 'Git failed' })).toBe(false)
    expect(supportsRetryNote(phase, [], { kind: 'transport', source: 'opencode', summary: 'Model request failed' })).toBe(true)
    expect(supportsRetryNote(phase, [], { kind: 'opencode_provider', source: 'provider', summary: 'Provider unavailable' })).toBe(true)
  })

  it('offers notes for failed Manual QA fix-bead generation, not the human review itself', () => {
    expect(supportsRetryNote('WAITING_MANUAL_QA')).toBe(false)
    expect(supportsRetryNote('WAITING_MANUAL_QA', ['MANUAL_QA_FIX_BEADS_FAILED'])).toBe(true)
  })
  it.each(['MAIN_IMPLEMENTER_MISSING', 'PROM4_NO_WINNER', 'PROM4_NO_COMPILED_INTERVIEW', 'PROM4_INVALID_COMPILED_INTERVIEW', 'FINAL_TEST_FAILED'])(
    'does not offer instructions to repair a deterministic prerequisite: %s', code => {
      expect(supportsRetryNote('WAITING_INTERVIEW_ANSWERS', [code])).toBe(false)
    },
  )

  it('excludes deterministic failures in phases which also use AI', () => {
    for (const phase of ['RUNNING_FINAL_TEST', 'GENERATING_QA_CHECKLIST']) {
      expect(supportsRetryNote(phase, [], { kind: 'runtime', source: 'system', summary: 'Workspace missing' })).toBe(false)
    }
  })

})
