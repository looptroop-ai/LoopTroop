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
 * There were two byte-identical copies of this, in `beadsPhase` and
 * `executionPhase`, feeding four different recovery entry points. The cleanup
 * plan asked for parity tests over both; one implementation is the parity.
 */
export function compareBeadRecoveryOrder(left: Bead, right: Bead) {
  const leftUpdatedAt = Date.parse(left.updatedAt || left.startedAt || left.completedAt || '')
  const rightUpdatedAt = Date.parse(right.updatedAt || right.startedAt || right.completedAt || '')

  if (!Number.isNaN(leftUpdatedAt) || !Number.isNaN(rightUpdatedAt)) {
    if (Number.isNaN(leftUpdatedAt)) return 1
    if (Number.isNaN(rightUpdatedAt)) return -1
    return rightUpdatedAt - leftUpdatedAt
  }

  return right.iteration - left.iteration
}
