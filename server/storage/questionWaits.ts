/**
 * The durable record of time a ticket spent waiting on a person.
 *
 * `workBudget` holds the same number in memory, exactly, and that is the one the
 * running phase timeouts read. This is the copy that survives a restart and can
 * be asked about a window in the past — which is what reporting needs, because a
 * question does not change the ticket's status and so leaves no trace in
 * `ticket_status_history`. Both exist for different questions: "how much time
 * does this step have left" and "how much of that hour was actually work".
 *
 * A wait is written when it *starts*, not when it finishes. Assembling the row
 * on resolution meant a question open right now counted as coding until somebody
 * answered it, and a daemon restart mid-wait lost everything before the restart.
 */

import { and, eq, isNull, lt, or, gt } from 'drizzle-orm'
import { questionWaits } from '../db/schema'
import type { ProjectContext } from './projects'
import { getTicketContext } from './ticketQueries'

type ProjectDb = ProjectContext['projectDb']

/** Opens a wait. Best-effort: reporting must never block a run. */
export function openQuestionWait(ticketRef: string, startedAtMs: number): void {
  if (!Number.isFinite(startedAtMs)) return
  try {
    const context = getTicketContext(ticketRef)
    if (!context) return
    // An interval already open means a question is still outstanding and this
    // one joined it. Overlapping waits are one stretch of wall time; opening a
    // second row would subtract the same minutes twice.
    const open = context.projectDb.select({ id: questionWaits.id })
      .from(questionWaits)
      .where(and(eq(questionWaits.ticketId, context.localTicketId), isNull(questionWaits.endedAt)))
      .get()
    if (open) return
    context.projectDb.insert(questionWaits).values({
      ticketId: context.localTicketId,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: null,
    }).run()
  } catch {
    // A lost row costs accuracy in a duration, never correctness in a run.
  }
}

/**
 * Local ticket ids that still have a wait open in this project.
 *
 * A wait is opened by the process that saw the question and closed by the
 * process that saw it resolved. When those are not the same process — a daemon
 * restart lands in the middle of one — nothing in the new process knows the row
 * is there, and an interval left open reads as "waiting up to now" for the rest
 * of the ticket's life, quietly subtracting all of it from active duration.
 * Startup uses this to find them and close the ones nothing is waiting on.
 */
export function listOpenQuestionWaitTicketIds(projectDb: ProjectDb): number[] {
  try {
    return projectDb.select({ ticketId: questionWaits.ticketId })
      .from(questionWaits)
      .where(isNull(questionWaits.endedAt))
      .all()
      .map((row) => row.ticketId)
  } catch {
    return []
  }
}

/** Closes whatever wait this ticket has open. Idempotent. */
export function closeQuestionWait(ticketRef: string, endedAtMs: number): void {
  if (!Number.isFinite(endedAtMs)) return
  try {
    const context = getTicketContext(ticketRef)
    if (!context) return
    context.projectDb.update(questionWaits)
      .set({ endedAt: new Date(endedAtMs).toISOString() })
      .where(and(eq(questionWaits.ticketId, context.localTicketId), isNull(questionWaits.endedAt)))
      .run()
  } catch {
    // Same trade as opening it.
  }
}

/**
 * How much of `[from, to)` this ticket spent waiting on a person.
 *
 * Intervals are clipped to the window and summed. They cannot overlap each other
 * — one is opened when a ticket's first question arrives and closed when its
 * last is resolved — so a plain sum is right and no merge is needed. A row still
 * open is treated as running up to now, so the wait counts while it happens
 * rather than appearing all at once when it ends.
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
        or(isNull(questionWaits.endedAt), gt(questionWaits.endedAt, new Date(from).toISOString())),
      ))
      .all()

    const now = Date.now()
    let total = 0
    for (const row of rows) {
      const startedAt = Date.parse(row.startedAt)
      const endedAt = row.endedAt === null ? now : Date.parse(row.endedAt)
      if (Number.isNaN(startedAt) || Number.isNaN(endedAt)) continue
      total += Math.max(0, Math.min(endedAt, to) - Math.max(startedAt, from))
    }
    return total
  } catch {
    return 0
  }
}
