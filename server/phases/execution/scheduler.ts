import type { Bead } from '../beads/types'

export function getRunnable(beads: Bead[]): Bead[] {
  const doneIds = new Set(beads.filter((b) => b.status === 'done').map((b) => b.id))

  return beads
    .filter((b) => b.status === 'pending')
    // Defaulted even though `readBeadsFile` normalises it: this takes a
    // `Bead[]` from whoever calls it, and the runtime projection still reads
    // the file with the raw `readJsonl`.
    .filter((b) => (b.dependencies?.blocked_by ?? []).every((dep) => doneIds.has(dep)))
    .sort((a, b) => a.priority - b.priority)
}

export function getNextBead(beads: Bead[]): Bead | null {
  const runnable = getRunnable(beads)
  return runnable[0] ?? null
}

export function isAllComplete(beads: Bead[]): boolean {
  return beads.length > 0 && beads.every((b) => b.status === 'done')
}
