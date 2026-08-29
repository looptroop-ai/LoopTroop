import { and, desc, eq, ne, type SQL } from 'drizzle-orm'
import { beadExecutionMetrics, ticketStatusHistory } from '../db/schema'
import { getTicketContext } from './ticketQueries'
import { questionWaitOverlapMs } from './questionWaits'
import type { ProjectContext } from './projects'
import type { Bead } from '../phases/beads/types'
import type { BeadSample } from '../workflow/eta/computeEta'
import { MIN_HISTORY_SAMPLES } from '../workflow/eta/computeEta'

type ProjectDb = ProjectContext['projectDb']

/** Max rows read per throughput query — recent history is enough and keeps reads cheap. */
const THROUGHPUT_SAMPLE_LIMIT = 200

/** Classifies a ticket into a size bucket by its total bead count. */
export function bucketForBeadCount(totalBeads: number): 'S' | 'M' | 'L' {
  if (totalBeads <= 5) return 'S'
  if (totalBeads <= 12) return 'M'
  return 'L'
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * User-facing bead throughput: bead wall-clock minus any window the ticket spent outside CODING
 * (approvals, interviews, PR review, etc.). This includes local finalization, because ETA should
 * forecast time until the bead is actually complete from the user's perspective.
 */
function wallClockMinusWaitingMs(
  projectDb: ProjectDb,
  ticketId: number,
  windowStart: number,
  windowEnd: number,
): number {
  const wallClock = Math.max(0, windowEnd - windowStart)
  if (wallClock === 0) return 0

  const rows = projectDb.select({
    newStatus: ticketStatusHistory.newStatus,
    changedAt: ticketStatusHistory.changedAt,
  })
    .from(ticketStatusHistory)
    .where(eq(ticketStatusHistory.ticketId, ticketId))
    .orderBy(ticketStatusHistory.changedAt)
    .all()

  let waiting = 0
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (!row) continue
    const status = row.newStatus
    const from = parseMs(row.changedAt)
    const to = parseMs(rows[i + 1]?.changedAt) ?? windowEnd
    if (from === null) continue
    if (status === 'CODING') continue
    const overlap = Math.min(to, windowEnd) - Math.max(from, windowStart)
    if (overlap > 0) waiting += overlap
  }

  // A question wait happens *inside* CODING, so the status walk above cannot see
  // it — the ticket never left the status. Left in, every minute spent waiting
  // on a person would be trained into the ETA as a minute of model throughput,
  // and the forecast would drift further out the more questions a project asks.
  waiting += questionWaitOverlapMs(projectDb, ticketId, windowStart, windowEnd)

  return Math.max(0, wallClock - waiting)
}

/**
 * Records one metric row for a just-completed bead. Best-effort: any failure is swallowed so
 * telemetry can never break an execution run.
 */
export function recordBeadMetric(ticketRef: string, bead: Bead, allBeads: Bead[]): void {
  try {
    const context = getTicketContext(ticketRef)
    if (!context) return

    const startedMs = parseMs(bead.startedAt)
    const completedMs = parseMs(bead.completedAt) ?? Date.now()
    const wallClockMs = startedMs !== null ? Math.max(0, completedMs - startedMs) : null

    const activeDurationMs = startedMs !== null
      ? wallClockMinusWaitingMs(context.projectDb, context.localTicketId, startedMs, completedMs)
      : 0

    // Skip degenerate rows (no usable timing) so they don't poison future medians.
    if (activeDurationMs <= 0) return

    context.projectDb.insert(beadExecutionMetrics).values({
      ticketId: context.localTicketId,
      beadId: bead.id,
      sizeBucket: bucketForBeadCount(allBeads.length),
      effortTier: context.localTicket.lockedMainImplementerVariant || 'medium',
      iterations: Math.max(1, bead.iteration ?? 1),
      activeDurationMs,
      wallClockMs,
      completedAt: bead.completedAt || new Date().toISOString(),
      schemaVersion: 1,
    }).run()
  } catch {
    // Telemetry is best-effort; never surface to the execution loop.
  }
}

function selectSamples(projectDb: ProjectDb, where: SQL | undefined): BeadSample[] {
  return projectDb.select({
    activeDurationMs: beadExecutionMetrics.activeDurationMs,
    iterations: beadExecutionMetrics.iterations,
  })
    .from(beadExecutionMetrics)
    .where(where)
    .orderBy(desc(beadExecutionMetrics.completedAt))
    .limit(THROUGHPUT_SAMPLE_LIMIT)
    .all()
}

/**
 * Historical throughput samples for the ETA fallback hierarchy:
 * (size + effort) -> (effort only) -> (any prior bead), always excluding the current ticket.
 * Returns the first tier that has enough samples; otherwise the broadest available set.
 */
export function getThroughputSamples(
  projectDb: ProjectDb,
  options: { effortTier: string; sizeBucket: 'S' | 'M' | 'L'; excludeTicketId: number },
): BeadSample[] {
  const { effortTier, sizeBucket, excludeTicketId } = options

  const bucketAndEffort = selectSamples(projectDb, and(
    ne(beadExecutionMetrics.ticketId, excludeTicketId),
    eq(beadExecutionMetrics.sizeBucket, sizeBucket),
    eq(beadExecutionMetrics.effortTier, effortTier),
  ))
  if (bucketAndEffort.length >= MIN_HISTORY_SAMPLES) return bucketAndEffort

  const effortOnly = selectSamples(projectDb, and(
    ne(beadExecutionMetrics.ticketId, excludeTicketId),
    eq(beadExecutionMetrics.effortTier, effortTier),
  ))
  if (effortOnly.length >= MIN_HISTORY_SAMPLES) return effortOnly

  const anyPrior = selectSamples(projectDb, ne(beadExecutionMetrics.ticketId, excludeTicketId))
  // Return the richest set we found so computeEtaRange can still decide the basis.
  return [anyPrior, effortOnly, bucketAndEffort].reduce((best, current) =>
    current.length > best.length ? current : best, [] as BeadSample[])
}

/** This ticket's completed-bead samples, ordered oldest -> newest for EMA smoothing. */
export function getTicketBeadSamples(projectDb: ProjectDb, ticketId: number): BeadSample[] {
  return projectDb.select({
    activeDurationMs: beadExecutionMetrics.activeDurationMs,
    iterations: beadExecutionMetrics.iterations,
  })
    .from(beadExecutionMetrics)
    .where(eq(beadExecutionMetrics.ticketId, ticketId))
    .orderBy(beadExecutionMetrics.completedAt)
    .all()
}
