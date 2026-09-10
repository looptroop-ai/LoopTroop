import type { Bead } from './types'

/**
 * Which of several beads a recovery resumes: the most recently touched.
 *
 * Sorted descending, so `[0]` is the bead to pick up. `updatedAt` is the
 * timestamp a bead writes as it works; `startedAt` and `completedAt` are the
 * fallbacks for a record written before it existed, or by a path that only
 * stamps one of them. A bead carrying no timestamp any of those readings can
 * parse falls to the back, and iteration decides between two of those — the
 * bead that has been retried most is the one that was most recently running.
 *
 * Each candidate is parsed before the next is considered. Choosing the field
 * first and parsing afterwards meant a non-empty `updatedAt` that is not a date
 * hid a `startedAt` that is one, and the bead was treated as undated — so a
 * retry resumed by iteration count instead of by when the work actually
 * happened. A field that cannot be read is not an answer.
 *
 * There were two byte-identical copies of this, in `beadsPhase` and
 * `executionPhase`, feeding four different recovery entry points. The cleanup
 * plan asked for parity tests over both; one implementation is the parity.
 */
function lastTouchedAt(bead: Bead): number {
  for (const candidate of [bead.updatedAt, bead.startedAt, bead.completedAt]) {
    if (!candidate) continue
    const parsed = Date.parse(candidate)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Number.NaN
}

export function compareBeadRecoveryOrder(left: Bead, right: Bead) {
  const leftUpdatedAt = lastTouchedAt(left)
  const rightUpdatedAt = lastTouchedAt(right)

  if (!Number.isNaN(leftUpdatedAt) || !Number.isNaN(rightUpdatedAt)) {
    if (Number.isNaN(leftUpdatedAt)) return 1
    if (Number.isNaN(rightUpdatedAt)) return -1
    return rightUpdatedAt - leftUpdatedAt
  }

  return right.iteration - left.iteration
}
