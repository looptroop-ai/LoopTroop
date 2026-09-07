import { describe, expect, it } from 'vitest'
import type { TicketPhaseAttempt } from '@/hooks/useTicketPhaseAttempts'
import { selectedAttemptNumber } from '../phaseAttemptSelection'

function attempt(attemptNumber: number): TicketPhaseAttempt {
  return { attemptNumber } as TicketPhaseAttempt
}

/**
 * The reason this is a function rather than four copies of an expression: the
 * four call sites each wrote `selected?.attemptNumber ?? attempts[0]!…`, with
 * the non-null assertion made safe by an `attempts.length > 1` guard a few
 * lines above — true, but for a reason stated somewhere else. The empty case is
 * the one worth pinning down, because it is the one the assertion hid.
 */
describe('selectedAttemptNumber', () => {
  it('prefers an explicit selection', () => {
    expect(selectedAttemptNumber(attempt(2), [attempt(3), attempt(2), attempt(1)])).toBe(2)
  })

  it('falls back to the first attempt when nothing is selected', () => {
    expect(selectedAttemptNumber(null, [attempt(3), attempt(2)])).toBe(3)
    expect(selectedAttemptNumber(undefined, [attempt(3), attempt(2)])).toBe(3)
  })

  it('is undefined when there is nothing to choose between, rather than throwing', () => {
    expect(selectedAttemptNumber(null, [])).toBeUndefined()
  })

  // A selection the list no longer carries is still the answer: the caller asked
  // for that attempt, and the selector shows it as chosen rather than silently
  // jumping to another one.
  it('keeps a selection that is not in the list', () => {
    expect(selectedAttemptNumber(attempt(9), [attempt(2), attempt(1)])).toBe(9)
  })
})
