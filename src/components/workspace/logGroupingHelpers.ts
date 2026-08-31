import type { LogEntry } from '@/context/LogContext'
import { getLogEntryIdentity } from '@/context/logUtils'
import type { ManualQaBeadOrigin, Ticket } from '@/hooks/useTickets'
import { isSystem } from './logFormat'

export interface RenderedBeadSection {
  beadId: string
  ordinal: number
  total: number
  title: string
  qaOrigin?: ManualQaBeadOrigin | null
  entries: LogEntry[]
}

export interface BeadSectionsResult {
  preambleEntries: LogEntry[]
  beadSections: RenderedBeadSection[]
}

const COMPLETED_BEAD_STATUSES = new Set(['done', 'completed', 'skipped'])
const EXECUTING_BEAD_PATTERN = /^(?:\[[A-Z_]+\]\s+)?Executing bead\s+([^:]+):\s+(.+?)\s*$/

function parseExecutingBead(entry: LogEntry): { beadId: string; title: string } | null {
  if (!isSystem(entry)) return null
  const match = entry.line.match(EXECUTING_BEAD_PATTERN)
  if (!match) return null
  return {
    beadId: match[1]!.trim(),
    title: match[2]!.trim(),
  }
}

function isCompletedBeadStatus(status?: string | null): boolean {
  return status ? COMPLETED_BEAD_STATUSES.has(status.toLowerCase()) : false
}

/**
 * Splits a single phase's log entries into preamble + bead sections.
 * Returns `null` when no beads are detected (caller should fall back to flat list).
 */
export function buildBeadSections(
  entries: LogEntry[],
  /** Attempt-scoped identities, as produced by `getLogEntryIdentity` — not bare entry ids. */
  visibleEntryIds: Set<string>,
  ticket?: Ticket,
): BeadSectionsResult | null {
  const runtimeBeads = ticket?.runtime.beads ?? []
  const runtimeBeadMap = new Map(
    runtimeBeads.map((bead, index) => [
      bead.id,
      {
        ordinal: index + 1,
        title: bead.title,
        status: bead.status,
        qaOrigin: bead.qaOrigin,
      },
    ]),
  )
  const activeBeadId = ticket?.runtime.activeBeadId ?? null
  const runtimeTotal = ticket?.runtime.totalBeads ?? 0

  const preambleEntries: LogEntry[] = []
  const discoveredBeadIds: string[] = []
  const discoveredBeadIdSet = new Set<string>()
  const beadSegments: Array<{ beadId: string; title: string; entries: LogEntry[] }> = []
  let currentSegment: { beadId: string; title: string; entries: LogEntry[] } | null = null

  for (const entry of entries) {
    const beadStart = parseExecutingBead(entry)
    if (beadStart) {
      if (currentSegment) {
        beadSegments.push(currentSegment)
      }
      currentSegment = {
        beadId: beadStart.beadId,
        title: beadStart.title,
        entries: [entry],
      }
      if (!discoveredBeadIdSet.has(beadStart.beadId)) {
        discoveredBeadIdSet.add(beadStart.beadId)
        discoveredBeadIds.push(beadStart.beadId)
      }
      continue
    }

    if (currentSegment) {
      currentSegment.entries.push(entry)
    } else {
      preambleEntries.push(entry)
    }
  }

  if (currentSegment) {
    beadSegments.push(currentSegment)
  }

  if (beadSegments.length === 0) {
    return null
  }

  const discoveryOrdinalMap = new Map(discoveredBeadIds.map((beadId, index) => [beadId, index + 1]))
  const total = runtimeTotal > 0 ? runtimeTotal : discoveredBeadIds.length
  const shouldFilterByRuntimeStatus = runtimeBeadMap.size > 0

  const visiblePreambleEntries = preambleEntries.filter((entry) => visibleEntryIds.has(getLogEntryIdentity(entry)))
  const beadSections = beadSegments
    .map((segment, segmentIndex): RenderedBeadSection | null => {
      const visibleEntries = segment.entries.filter((entry) => visibleEntryIds.has(getLogEntryIdentity(entry)))
      if (visibleEntries.length === 0) return null

      const runtimeBead = runtimeBeadMap.get(segment.beadId)
      if (
        shouldFilterByRuntimeStatus
        && segment.beadId !== activeBeadId
        && !isCompletedBeadStatus(runtimeBead?.status)
      ) {
        return null
      }

      const ordinal = runtimeBead?.ordinal ?? discoveryOrdinalMap.get(segment.beadId) ?? segmentIndex + 1
      return {
        beadId: segment.beadId,
        ordinal,
        total: total > 0 ? total : ordinal,
        title: runtimeBead?.title?.trim() || segment.title,
        qaOrigin: runtimeBead?.qaOrigin,
        entries: visibleEntries,
      }
    })
    .filter((section): section is RenderedBeadSection => section !== null)

  if (visiblePreambleEntries.length === 0 && beadSections.length === 0) {
    return null
  }

  return {
    preambleEntries: visiblePreambleEntries,
    beadSections,
  }
}
