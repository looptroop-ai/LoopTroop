/**
 * The durable record of time a ticket spent waiting on a person.
 *
 * `workBudget` holds the same number in memory, exactly, and that is the one the
 * running phase timeouts read. This is the copy that survives a restart and can
 * be asked about a window in the past — which is what reporting needs, because a
 * question does not change the ticket's status and so leaves no trace in
 * `ticket_status_history`. Both exist for different questions: "how much time
 * does this step have left" and "how much of that hour was actually work".
 */

import { and, eq, gt, lt } from 'drizzle-orm'
import { questionWaits } from '../db/schema'
import type { ProjectContext } from './projects'
import { getTicketContext } from './ticketQueries'

type ProjectDb = ProjectContext['projectDb']

/** Records one closed wait. Best-effort: reporting must never block a run. */
export function recordQuestionWait(ticketRef: string, startedAtMs: number, endedAtMs: number): void {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return
  if (endedAtMs <= startedAtMs) return
  try {
    const context = getTicketContext(ticketRef)
    if (!context) return
    context.projectDb.insert(questionWaits).values({
      ticketId: context.localTicketId,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
    }).run()
  } catch {
    // A lost row costs accuracy in a duration, never correctness in a run.
  }
}

/**
 * How much of `[from, to)` this ticket spent waiting on a person.
 *
 * Intervals are clipped to the window and summed. They cannot overlap each other
 * — one is opened when a ticket's first question arrives and closed when its
 * last is resolved — so a plain sum is right and no merge is needed.
 */
export function questionWaitOverlapMs(
  projectDb: ProjectDb,
  localTicketId: number,
  from: number,
  to: number,
): number {
  if (!(to > from)) return 0
  try {
    const rows = projectDb.select({
      startedAt: questionWaits.startedAt,
      endedAt: questionWaits.endedAt,
    })
      .from(questionWaits)
      .where(and(
        eq(questionWaits.ticketId, localTicketId),
        lt(questionWaits.startedAt, new Date(to).toISOString()),
        gt(questionWaits.endedAt, new Date(from).toISOString()),
      ))
      .all()

    let total = 0
    for (const row of rows) {
      const startedAt = Date.parse(row.startedAt)
      const endedAt = Date.parse(row.endedAt)
      if (Number.isNaN(startedAt) || Number.isNaN(endedAt)) continue
      total += Math.max(0, Math.min(endedAt, to) - Math.max(startedAt, from))
    }
    return total
  } catch {
    return 0
  }
}
