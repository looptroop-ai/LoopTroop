import { afterEach, describe, expect, it } from 'vitest'
import { createWorkBudget, resetAllWorkBudgets } from '../workBudget'

afterEach(() => {
  resetAllWorkBudgets()
})

describe('work budget with a deadline that has already passed', () => {
  it('keeps an expired budget expired instead of reporting no budget at all', () => {
    const budget = createWorkBudget({ ticketId: 'expired-ticket', totalMs: 0, scope: 'prompt' })

    // Collapsing a non-positive total into `undefined` said "no budget", which
    // is how a prompt started after its deadline got an apparently unbounded
    // clock and no deadline controller.
    expect(budget.totalMs).toBe(0)
    expect(budget.deadlineAt()).toBeDefined()
    expect(budget.remainingMs()).toBeLessThanOrEqual(0)
    expect(budget.expired()).toBe(true)
  })

  it('treats a negative total the same way', () => {
    const budget = createWorkBudget({ ticketId: 'expired-ticket', totalMs: -5_000, scope: 'prompt' })
    expect(budget.expired()).toBe(true)
    expect(budget.remainingMs()).toBeLessThanOrEqual(0)
  })

  it('still means "no budget" when no total is given', () => {
    const budget = createWorkBudget({ ticketId: 'unbounded-ticket', scope: 'prompt' })
    expect(budget.totalMs).toBeUndefined()
    expect(budget.deadlineAt()).toBeUndefined()
    expect(budget.remainingMs()).toBeUndefined()
    expect(budget.expired()).toBe(false)
  })

  it('leaves a live budget alone', () => {
    const budget = createWorkBudget({ ticketId: 'live-ticket', totalMs: 60_000, scope: 'prompt' })
    expect(budget.expired()).toBe(false)
    expect(budget.remainingMs()).toBeGreaterThan(0)
  })
})
