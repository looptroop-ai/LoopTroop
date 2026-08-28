import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  clearTicketWorkBudget,
  createWorkBudget,
  getTicketWaitingMs,
  isTicketWorkSuspended,
  resetAllWorkBudgets,
  resumeTicketWork,
  suspendTicketWork,
} from '../workBudget'

describe('workBudget', () => {
  beforeEach(() => {
    resetAllWorkBudgets()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    resetAllWorkBudgets()
  })

  it('counts down like a plain deadline when nothing suspends it', () => {
    const budget = createWorkBudget({ ticketId: 'T-1', totalMs: 60_000, scope: 'phase_attempt' })
    expect(budget.remainingMs()).toBe(60_000)
    vi.advanceTimersByTime(20_000)
    expect(budget.remainingMs()).toBe(40_000)
    expect(budget.expired()).toBe(false)
    vi.advanceTimersByTime(40_000)
    expect(budget.expired()).toBe(true)
  })

  it('is unbounded when no window was given', () => {
    const budget = createWorkBudget({ ticketId: 'T-1', scope: 'prompt' })
    expect(budget.remainingMs()).toBeUndefined()
    expect(budget.deadlineAt()).toBeUndefined()
    expect(budget.expired()).toBe(false)
  })

  it('does not charge a question wait to the model, however long it lasts', () => {
    const budget = createWorkBudget({ ticketId: 'T-1', totalMs: 60_000, scope: 'phase_attempt' })
    vi.advanceTimersByTime(50_000)
    expect(budget.remainingMs()).toBe(10_000)

    suspendTicketWork('T-1')
    vi.advanceTimersByTime(600_000)
    // Ten minutes of a person thinking, and the model still has its ten seconds.
    expect(budget.remainingMs()).toBe(10_000)
    expect(budget.expired()).toBe(false)

    resumeTicketWork('T-1')
    expect(budget.remainingMs()).toBe(10_000)
    vi.advanceTimersByTime(10_001)
    expect(budget.expired()).toBe(true)
  })

  it('resumes only when the last of several waits ends', () => {
    const budget = createWorkBudget({ ticketId: 'T-1', totalMs: 60_000, scope: 'phase_attempt' })
    suspendTicketWork('T-1')
    suspendTicketWork('T-1')
    vi.advanceTimersByTime(30_000)

    resumeTicketWork('T-1')
    expect(isTicketWorkSuspended('T-1')).toBe(true)
    vi.advanceTimersByTime(30_000)
    expect(budget.remainingMs()).toBe(60_000)

    resumeTicketWork('T-1')
    expect(isTicketWorkSuspended('T-1')).toBe(false)
    expect(getTicketWaitingMs('T-1')).toBe(60_000)
  })

  it('credits a budget created mid-wait only for the part it lived through', () => {
    suspendTicketWork('T-1')
    vi.advanceTimersByTime(20_000)
    const late = createWorkBudget({ ticketId: 'T-1', totalMs: 60_000, scope: 'council_member' })
    vi.advanceTimersByTime(20_000)
    resumeTicketWork('T-1')
    // It was created 20s into the wait, so only the remaining 20s is its credit.
    expect(late.remainingMs()).toBe(60_000)
    vi.advanceTimersByTime(10_000)
    expect(late.remainingMs()).toBe(50_000)
  })

  it('notifies listeners on both suspend and resume so timers can re-arm', () => {
    const budget = createWorkBudget({ ticketId: 'T-1', totalMs: 60_000, scope: 'phase_attempt' })
    const changes: boolean[] = []
    budget.onChange(() => changes.push(budget.suspended()))

    suspendTicketWork('T-1')
    resumeTicketWork('T-1')
    expect(changes).toEqual([true, false])
  })

  it('stops notifying a released budget', () => {
    const budget = createWorkBudget({ ticketId: 'T-1', totalMs: 60_000, scope: 'phase_attempt' })
    const listener = vi.fn()
    budget.onChange(listener)
    budget.release()
    suspendTicketWork('T-1')
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps one ticket’s wait out of another ticket’s clock', () => {
    const mine = createWorkBudget({ ticketId: 'T-1', totalMs: 60_000, scope: 'phase_attempt' })
    const theirs = createWorkBudget({ ticketId: 'T-2', totalMs: 60_000, scope: 'phase_attempt' })
    suspendTicketWork('T-1')
    vi.advanceTimersByTime(30_000)
    expect(mine.remainingMs()).toBe(60_000)
    expect(theirs.remainingMs()).toBe(30_000)
  })

  it('releases a stuck suspension when the ticket is torn down', () => {
    const budget = createWorkBudget({ ticketId: 'T-1', totalMs: 60_000, scope: 'phase_attempt' })
    suspendTicketWork('T-1')
    expect(budget.suspended()).toBe(true)
    clearTicketWorkBudget('T-1')
    expect(isTicketWorkSuspended('T-1')).toBe(false)
    expect(budget.suspended()).toBe(false)
  })

  it('ignores a resume that was never matched by a suspend', () => {
    const budget = createWorkBudget({ ticketId: 'T-1', totalMs: 60_000, scope: 'phase_attempt' })
    resumeTicketWork('T-1')
    vi.advanceTimersByTime(10_000)
    expect(budget.remainingMs()).toBe(50_000)
  })
})
