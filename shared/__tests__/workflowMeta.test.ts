import { describe, expect, it } from 'vitest'
import {
  getAvailableWorkflowActions,
  getWorkflowPhaseMeta,
  isTerminalWorkflowStatus,
  isWorkflowPhaseId,
  TERMINAL_WORKFLOW_STATUSES,
  WORKFLOW_PHASES,
  WORKFLOW_PHASE_IDS,
} from '../workflowMeta'

/**
 * The phase table is the only place that says which statuses are terminal and
 * which hold the execution slot. These tests pin today's answers so a change to
 * either set has to be deliberate — before this, both facts were also written
 * out by hand in half a dozen other files, and the copies could drift silently.
 */
describe('workflow phase identity', () => {
  it('recognises every declared status and nothing else', () => {
    for (const id of WORKFLOW_PHASE_IDS) {
      expect(isWorkflowPhaseId(id), `${id} should be a known status`).toBe(true)
    }

    expect(isWorkflowPhaseId('NOT_A_STATUS')).toBe(false)
    expect(isWorkflowPhaseId('')).toBe(false)
    expect(isWorkflowPhaseId('completed')).toBe(false)
  })

  it('does not mistake inherited object properties for statuses', () => {
    // The lookup is a plain object, so a bare `map[key]` check would accept
    // these and hand back a function instead of phase metadata.
    expect(isWorkflowPhaseId('toString')).toBe(false)
    expect(isWorkflowPhaseId('constructor')).toBe(false)
    expect(isWorkflowPhaseId('__proto__')).toBe(false)
  })

  it('returns no metadata for an inherited property name', () => {
    // Callers check the result for truthiness and then read into it, so handing
    // back `Object.prototype.toString` for a status named `toString` throws one
    // property access later.
    expect(getWorkflowPhaseMeta('toString')).toBeUndefined()
    expect(getWorkflowPhaseMeta('constructor')).toBeUndefined()
    expect(getWorkflowPhaseMeta('__proto__')).toBeUndefined()
    expect(getWorkflowPhaseMeta('NOT_A_STATUS')).toBeUndefined()
    expect(getWorkflowPhaseMeta('DRAFT')?.id).toBe('DRAFT')
  })

  it('gives every status exactly one board column', () => {
    for (const phase of WORKFLOW_PHASES) {
      expect(['todo', 'in_progress', 'needs_input', 'done'], `${phase.id}`)
        .toContain(phase.kanbanPhase)
    }
  })
})

describe('isTerminalWorkflowStatus', () => {
  it('covers exactly the two finished statuses', () => {
    expect([...TERMINAL_WORKFLOW_STATUSES].sort()).toEqual(['CANCELED', 'COMPLETED'])
  })

  it('agrees with the phase table it is derived from', () => {
    const flagged = WORKFLOW_PHASES.filter((phase) => phase.terminal).map((phase) => phase.id)
    expect([...TERMINAL_WORKFLOW_STATUSES].sort()).toEqual([...flagged].sort())

    for (const phase of WORKFLOW_PHASES) {
      expect(isTerminalWorkflowStatus(phase.id), `${phase.id}`).toBe(phase.terminal === true)
    }
  })

  it('leaves a blocked or waiting ticket cancelable', () => {
    // Blocked and waiting tickets look inert but are not finished: the workflow
    // resumes from them, so Cancel has to stay available and polling has to
    // continue.
    expect(isTerminalWorkflowStatus('BLOCKED_ERROR')).toBe(false)
    expect(isTerminalWorkflowStatus('WAITING_PR_REVIEW')).toBe(false)
    expect(isTerminalWorkflowStatus('DRAFT')).toBe(false)
    expect(isTerminalWorkflowStatus('CLEANING_ENV')).toBe(false)
  })

  it('treats an unknown or missing status as not finished', () => {
    // A status that cannot be read is the wrong reason to let someone delete a
    // ticket, so anything unrecognised has to answer "no".
    expect(isTerminalWorkflowStatus('NOT_A_STATUS')).toBe(false)
    expect(isTerminalWorkflowStatus(null)).toBe(false)
    expect(isTerminalWorkflowStatus(undefined)).toBe(false)
    expect(isTerminalWorkflowStatus('')).toBe(false)
  })

  it('offers no workflow actions on a finished ticket', () => {
    for (const status of TERMINAL_WORKFLOW_STATUSES) {
      expect(getAvailableWorkflowActions(status), status).toEqual([])
    }

    // And the reverse, so the check that produces the empty list cannot quietly
    // widen: every status that is still running keeps at least Cancel.
    for (const phase of WORKFLOW_PHASES.filter((p) => p.terminal !== true)) {
      expect(getAvailableWorkflowActions(phase.id), phase.id).not.toEqual([])
    }
  })

  it('requires every status in the Done column to carry the flag itself', () => {
    // Terminality is its own flag, so a status can be filed under Done for
    // display and still not be marked finished — and then Delete, Cancel and the
    // polling would disagree with the board. This catches that authoring
    // mistake. It does not prove the two are independent: while the sets agree, a
    // predicate reading `kanbanPhase === 'done'` would pass this too.
    const doneColumn = WORKFLOW_PHASES.filter((phase) => phase.kanbanPhase === 'done')
    expect(doneColumn.length).toBeGreaterThan(0)
    for (const phase of doneColumn) {
      expect(phase.terminal, `${phase.id} must say so itself`).toBe(true)
    }
  })
})

describe('execution band metadata', () => {
  it('marks the twelve statuses that hold a project execution slot', () => {
    const band = WORKFLOW_PHASES.filter((phase) => phase.executionBand).map((phase) => phase.id)

    expect([...band].sort()).toEqual([
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

  it('cannot be replaced by a board column or a group', () => {
    // Recorded as its own flag because neither of the other groupings describes
    // it: the band spans three board columns, and most working statuses sit
    // outside it. A future refactor that tries to derive it will fail here.
    const band = WORKFLOW_PHASES.filter((phase) => phase.executionBand)
    const columns = new Set(band.map((phase) => phase.kanbanPhase))
    expect(columns.size).toBeGreaterThan(1)

    const workingOutsideBand = WORKFLOW_PHASES.filter(
      (phase) => phase.kanbanPhase === 'in_progress' && !phase.executionBand,
    )
    expect(workingOutsideBand.length).toBeGreaterThan(0)
  })

  it('keeps the band contiguous in workflow order', () => {
    // The band is one unbroken run from the first readiness check to cleanup. A
    // gap would mean a ticket leaves the band mid-execution and a second ticket
    // could take the slot while the first is still running: the slot check is
    // membership in a set (`findProjectExecutionBandConflict`, server/storage/
    // ticketQueries.ts), so it cannot tell "before the band" from "in the middle
    // of it". Nothing reads the order itself — this pins the shape the set check
    // relies on.
    const indexes = WORKFLOW_PHASES
      .map((phase, index) => (phase.executionBand ? index : -1))
      .filter((index) => index >= 0)
    const first = indexes[0] ?? -1
    expect(first).toBeGreaterThanOrEqual(0)
    expect(indexes).toEqual(indexes.map((_, offset) => first + offset))
  })
})
