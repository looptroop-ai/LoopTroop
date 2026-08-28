import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearNeedsInputSeen,
  getNeedsInputSignature,
  markNeedsInputSeen,
  readNeedsInputSeen,
} from '@/lib/needsInputSeen'

const baseSnapshot = {
  id: '1:TEST-1',
  status: 'WAITING_PRD_APPROVAL',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

interface PendingQuestions {
  requestCount: number
  questionCount: number
  deadlineAt: string | null
  stoppedAt: string | null
}

function makePendingQuestions(overrides: Partial<PendingQuestions> = {}): PendingQuestions {
  return { requestCount: 1, questionCount: 2, deadlineAt: null, stoppedAt: null, ...overrides }
}

const oneRequest = makePendingQuestions()

describe('getNeedsInputSignature', () => {
  it('returns a status|updatedAt|requests signature for needs_input statuses', () => {
    expect(getNeedsInputSignature(baseSnapshot)).toBe('WAITING_PRD_APPROVAL|2026-01-01T00:00:00.000Z|0')
  })

  it('returns null for BLOCKED_ERROR (red error owns that status)', () => {
    expect(getNeedsInputSignature({ ...baseSnapshot, status: 'BLOCKED_ERROR' })).toBeNull()
    expect(getNeedsInputSignature({ ...baseSnapshot, status: 'BLOCKED_ERROR', pendingQuestions: oneRequest })).toBeNull()
  })

  it('returns null for non-needs-input statuses', () => {
    expect(getNeedsInputSignature({ ...baseSnapshot, status: 'DRAFT' })).toBeNull()
    expect(getNeedsInputSignature({ ...baseSnapshot, status: 'CODING' })).toBeNull()
    expect(getNeedsInputSignature({ ...baseSnapshot, status: 'COMPLETED' })).toBeNull()
  })

  it('signs a pending question on a working ticket, which has no needs_input status', () => {
    expect(getNeedsInputSignature({ ...baseSnapshot, status: 'CODING', pendingQuestions: oneRequest }))
      .toBe('CODING|2026-01-01T00:00:00.000Z|1')
  })

  it('does not sign a question on a todo or done ticket, which has no live model', () => {
    expect(getNeedsInputSignature({ ...baseSnapshot, status: 'DRAFT', pendingQuestions: oneRequest })).toBeNull()
    expect(getNeedsInputSignature({ ...baseSnapshot, status: 'COMPLETED', pendingQuestions: oneRequest })).toBeNull()
  })

  it('produces a different signature when the wait reason changes (different status)', () => {
    const prd = getNeedsInputSignature(baseSnapshot)
    const beads = getNeedsInputSignature({ ...baseSnapshot, status: 'WAITING_BEADS_APPROVAL' })
    expect(prd).not.toBe(beads)
  })

  it('produces a different signature on re-entry with a fresh updatedAt', () => {
    const first = getNeedsInputSignature(baseSnapshot)
    const reentered = getNeedsInputSignature({ ...baseSnapshot, updatedAt: '2026-01-02T00:00:00.000Z' })
    expect(first).not.toBe(reentered)
  })

  it('produces a different signature when the blocker changes kind', () => {
    // Same wait, same timestamp — a model has interrupted it with a question.
    const interviewWait = getNeedsInputSignature({ ...baseSnapshot, status: 'WAITING_INTERVIEW_ANSWERS' })
    const alsoAsked = getNeedsInputSignature({
      ...baseSnapshot,
      status: 'WAITING_INTERVIEW_ANSWERS',
      pendingQuestions: oneRequest,
    })
    expect(interviewWait).not.toBe(alsoAsked)
  })

  it('holds steady when only the shared countdown moves', () => {
    // Every model joining the step resets the deadline; that is not a new question.
    const asked = getNeedsInputSignature({ ...baseSnapshot, status: 'CODING', pendingQuestions: oneRequest })
    const clockReset = getNeedsInputSignature({
      ...baseSnapshot,
      status: 'CODING',
      pendingQuestions: makePendingQuestions({ deadlineAt: '2026-01-01T00:05:00.000Z' }),
    })
    expect(asked).toBe(clockReset)
  })

  it('re-signs when another model joins the same step', () => {
    const one = getNeedsInputSignature({ ...baseSnapshot, status: 'CODING', pendingQuestions: oneRequest })
    const two = getNeedsInputSignature({
      ...baseSnapshot,
      status: 'CODING',
      pendingQuestions: makePendingQuestions({ requestCount: 2, questionCount: 4 }),
    })
    expect(one).not.toBe(two)
  })
})

describe('readNeedsInputSeen / markNeedsInputSeen / clearNeedsInputSeen', () => {
  beforeEach(() => {
    clearNeedsInputSeen(baseSnapshot.id)
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns false for a null signature', () => {
    expect(readNeedsInputSeen(baseSnapshot.id, null)).toBe(false)
  })

  it('returns false before marking and true after marking', () => {
    const sig = getNeedsInputSignature(baseSnapshot)!
    expect(readNeedsInputSeen(baseSnapshot.id, sig)).toBe(false)
    markNeedsInputSeen(baseSnapshot.id, sig)
    expect(readNeedsInputSeen(baseSnapshot.id, sig)).toBe(true)
  })

  it('honors a persisted signature from the server (cross-tab recovery)', () => {
    const sig = getNeedsInputSignature(baseSnapshot)!
    expect(readNeedsInputSeen(baseSnapshot.id, sig, sig)).toBe(true)
  })

  it('clears the seen state', () => {
    const sig = getNeedsInputSignature(baseSnapshot)!
    markNeedsInputSeen(baseSnapshot.id, sig)
    expect(readNeedsInputSeen(baseSnapshot.id, sig)).toBe(true)
    clearNeedsInputSeen(baseSnapshot.id)
    expect(readNeedsInputSeen(baseSnapshot.id, sig)).toBe(false)
  })

  it('a new wait signature is unseen again after a prior one was acknowledged', () => {
    const first = getNeedsInputSignature(baseSnapshot)!
    markNeedsInputSeen(baseSnapshot.id, first)
    expect(readNeedsInputSeen(baseSnapshot.id, first)).toBe(true)
    const second = getNeedsInputSignature({
      ...baseSnapshot,
      status: 'WAITING_BEADS_APPROVAL',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })!
    expect(readNeedsInputSeen(baseSnapshot.id, second)).toBe(false)
  })

  it('treats a persisted null signature as not seen', () => {
    const sig = getNeedsInputSignature(baseSnapshot)!
    markNeedsInputSeen(baseSnapshot.id, sig)
    expect(readNeedsInputSeen(baseSnapshot.id, sig, null)).toBe(true)
  })
})
