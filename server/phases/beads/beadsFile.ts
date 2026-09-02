import { readJsonl } from '../../io/jsonl'
import type { Bead, BeadStatus } from './types'
import { BEAD_STATUSES, BEAD_STATUS_LEGACY_ALIASES, isBeadStatus } from './types'

/**
 * Reconciles a status read back from `beads.jsonl`.
 *
 * Guarding the parser only protects new output. A record written by an earlier
 * release can still hold a status the scheduler does not recognise, and the
 * scheduler stalls silently on one: it runs `pending` and finishes on `done`, so
 * anything else is a bead that never starts and a ticket that never completes.
 * Coercing to `pending` re-runs the bead at worst; leaving it stalls the ticket.
 */
export function reconcileStoredBeadStatus(
  value: unknown,
  beadId: string,
): { status: BeadStatus; warning?: string } {
  if (isBeadStatus(value)) return { status: value }

  const raw = typeof value === 'string' ? value.trim() : ''
  const folded = raw.toLowerCase()
  const mapped: BeadStatus | undefined = BEAD_STATUS_LEGACY_ALIASES[folded]
    ?? (isBeadStatus(folded) ? folded : undefined)
  if (mapped) {
    return { status: mapped, warning: `Bead "${beadId}" had stored status "${raw}"; read as "${mapped}".` }
  }

  return {
    status: 'pending',
    warning: `Bead "${beadId}" had unrecognised stored status ${JSON.stringify(value)}; read as "pending" (expected one of ${BEAD_STATUSES.join(', ')}).`,
  }
}

/**
 * Reads a ticket's bead tracker. Every caller used to `readJsonl<Bead>(path)`,
 * which asserts the shape rather than checking it.
 */
export function readBeadsFile(path: string): Bead[] {
  return readJsonl<Bead>(path).map((bead) => {
    const reconciled = reconcileStoredBeadStatus(bead.status, bead.id)
    if (!reconciled.warning) return bead
    console.warn(`[beads] ${reconciled.warning}`)
    return { ...bead, status: reconciled.status }
  })
}
