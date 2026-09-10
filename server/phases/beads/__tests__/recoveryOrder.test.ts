import { describe, expect, it } from 'vitest'
import { compareBeadRecoveryOrder } from '../recoveryOrder'
import type { Bead } from '../types'

/**
 * The order four recovery entry points resume work in.
 *
 * This existed twice — byte-identical, in `beadsPhase` and `executionPhase` —
 * and the cleanup plan asked for parity cases over both copies. One
 * implementation is the parity; these are its cases, and the two phases each
 * keep a case proving they sort through it.
 */
function bead(id: string, fields: Partial<Bead> = {}): Bead {
  return { id, iteration: 1, updatedAt: '', startedAt: '', completedAt: '', ...fields } as Bead
}

/** The id a recovery would pick: the list sorted, first entry. */
function resumes(beads: Bead[]): string | undefined {
  return [...beads].sort(compareBeadRecoveryOrder)[0]?.id
}

describe('compareBeadRecoveryOrder', () => {
  it('picks nothing out of an empty list', () => {
    expect(resumes([])).toBeUndefined()
  })

  it('takes the most recently updated', () => {
    expect(resumes([
      bead('older', { updatedAt: '2026-01-01T00:00:00.000Z' }),
      bead('newer', { updatedAt: '2026-01-02T00:00:00.000Z' }),
    ])).toBe('newer')
  })

  it('gives the same answer whichever order the beads arrive in', () => {
    // The list comes from a file, whose order is the order beads were written,
    // not the order they ran.
    const beads = [
      bead('a', { updatedAt: '2026-01-01T00:00:00.000Z' }),
      bead('b', { updatedAt: '2026-01-03T00:00:00.000Z' }),
      bead('c', { updatedAt: '2026-01-02T00:00:00.000Z' }),
    ]

    expect(resumes(beads)).toBe('b')
    expect(resumes([...beads].reverse())).toBe('b')
  })

  it.each([
    ['startedAt', { startedAt: '2026-01-03T00:00:00.000Z' }],
    ['completedAt', { completedAt: '2026-01-03T00:00:00.000Z' }],
  ])('falls back to %s for a record with no updatedAt', (_, fields) => {
    expect(resumes([
      bead('dated', { updatedAt: '2026-01-01T00:00:00.000Z' }),
      bead('fallback', fields),
    ])).toBe('fallback')
  })

  it('puts a bead with no usable timestamp behind one that has any', () => {
    // Even against a much higher iteration: a timestamp is the stronger signal.
    expect(resumes([
      bead('undated', { iteration: 9 }),
      bead('dated', { updatedAt: '2026-01-01T00:00:00.000Z', iteration: 1 }),
    ])).toBe('dated')
  })

  it('ignores a timestamp it cannot parse rather than ordering on it', () => {
    expect(resumes([
      bead('garbled', { updatedAt: 'not a date', iteration: 5 }),
      bead('dated', { updatedAt: '2020-01-01T00:00:00.000Z', iteration: 1 }),
    ])).toBe('dated')
  })

  /**
   * A field that cannot be read is not an answer.
   *
   * The chain used to pick the candidate *before* parsing it, so a bead
   * carrying `updatedAt: "not a date"` beside a valid `startedAt` was treated
   * as undated and resumed by iteration count instead of by when the work
   * happened.
   */
  it('falls past an unparsable updatedAt to a startedAt that reads', () => {
    expect(resumes([
      bead('garbled-with-fallback', { updatedAt: 'not a date', startedAt: '2026-01-09T00:00:00.000Z' }),
      bead('dated', { updatedAt: '2020-01-01T00:00:00.000Z' }),
    ])).toBe('garbled-with-fallback')
  })

  it('falls past two unreadable fields to the one that reads', () => {
    expect(resumes([
      bead('third-candidate', {
        updatedAt: 'not a date', startedAt: 'also not', completedAt: '2026-01-09T00:00:00.000Z',
      }),
      bead('dated', { updatedAt: '2020-01-01T00:00:00.000Z' }),
    ])).toBe('third-candidate')
  })

  it('falls back to the highest iteration when no bead carries a timestamp', () => {
    expect(resumes([
      bead('first-attempt', { iteration: 1 }),
      bead('third-attempt', { iteration: 3 }),
    ])).toBe('third-attempt')
  })

  it('leaves two beads that compare equal in the order they arrived', () => {
    const same = { updatedAt: '2026-01-01T00:00:00.000Z', iteration: 1 }

    expect(resumes([bead('a', same), bead('b', same)])).toBe('a')
    expect(resumes([bead('b', same), bead('a', same)])).toBe('b')
  })
})
