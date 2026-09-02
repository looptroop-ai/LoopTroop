import type { Ticket } from '@/hooks/useTickets'
import { getStatusUserLabel, type StatusLabelOptions } from '@/lib/workflowMeta'
import { normalizeBlockedErrorDiagnostics, type BlockedErrorDiagnostics } from '@shared/errorDiagnostics'

export interface TicketErrorOccurrence {
  id: string
  occurrenceNumber: number
  blockedFromStatus: string
  errorMessage: string
  errorCodes: string[]
  diagnostics?: BlockedErrorDiagnostics | null
  occurredAt: string
  resolvedAt: string | null
  resolutionStatus: 'RETRIED' | 'CONTINUED' | 'CANCELED' | null
  resumedToStatus: string | null
}

type TicketErrorSource = Pick<
  Ticket,
  'id' | 'status' | 'previousStatus' | 'updatedAt' | 'errorOccurrences' | 'activeErrorOccurrenceId'
> & {
  errorMessage?: string | null | undefined
}

type TicketErrorOccurrenceInput = Partial<TicketErrorOccurrence> & {
  id?: string | number
}

function normalizeCodeList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function normalizeErrorOccurrence(
  occurrence: TicketErrorOccurrenceInput,
  fallbackNumber: number,
  fallbackOccurredAt: string,
): TicketErrorOccurrence {
  const occurrenceNumber = typeof occurrence.occurrenceNumber === 'number' && occurrence.occurrenceNumber > 0
    ? occurrence.occurrenceNumber
    : fallbackNumber
  const fallbackId = `error-${fallbackNumber}`
  return {
    id: typeof occurrence.id === 'string'
      ? (occurrence.id.trim().length > 0 ? occurrence.id : fallbackId)
      : typeof occurrence.id === 'number'
        ? String(occurrence.id)
        : fallbackId,
    occurrenceNumber,
    blockedFromStatus: typeof occurrence.blockedFromStatus === 'string' && occurrence.blockedFromStatus.trim().length > 0
      ? occurrence.blockedFromStatus
      : 'BLOCKED_ERROR',
    errorMessage: typeof occurrence.errorMessage === 'string' ? occurrence.errorMessage : '',
    errorCodes: normalizeCodeList(occurrence.errorCodes),
    diagnostics: normalizeBlockedErrorDiagnostics(occurrence.diagnostics),
    // Not `new Date()`: this runs during render, from `ActiveWorkspace` and
    // `ErrorView`, and the list is sorted by this field. A fresh timestamp per
    // render reordered the list and churned the React keys under it. The
    // ticket's `updatedAt` is stable and is the closest thing to the truth.
    occurredAt: typeof occurrence.occurredAt === 'string' && occurrence.occurredAt.length > 0
      ? occurrence.occurredAt
      : fallbackOccurredAt,
    resolvedAt: typeof occurrence.resolvedAt === 'string' && occurrence.resolvedAt.length > 0
      ? occurrence.resolvedAt
      : null,
    resolutionStatus: occurrence.resolutionStatus === 'RETRIED'
      || occurrence.resolutionStatus === 'CONTINUED'
      || occurrence.resolutionStatus === 'CANCELED'
      ? occurrence.resolutionStatus
      : null,
    resumedToStatus: typeof occurrence.resumedToStatus === 'string' && occurrence.resumedToStatus.length > 0
      ? occurrence.resumedToStatus
      : null,
  }
}

function buildSyntheticCurrentOccurrence(ticket: TicketErrorSource): TicketErrorOccurrence {
  const parsedUpdatedAt = Date.parse(ticket.updatedAt)
  const syntheticId = Number.isFinite(parsedUpdatedAt) ? `synthetic-${parsedUpdatedAt}` : 'synthetic-current'

  return {
    id: syntheticId,
    occurrenceNumber: 1,
    blockedFromStatus: ticket.previousStatus && ticket.previousStatus !== 'BLOCKED_ERROR'
      ? ticket.previousStatus
      : 'BLOCKED_ERROR',
    errorMessage: ticket.errorMessage ?? '',
    errorCodes: [],
    diagnostics: null,
    occurredAt: ticket.updatedAt,
    resolvedAt: null,
    resolutionStatus: null,
    resumedToStatus: null,
  }
}

export function getTicketErrorOccurrences(ticket: TicketErrorSource): TicketErrorOccurrence[] {
  const rawOccurrences = Array.isArray(ticket.errorOccurrences) ? ticket.errorOccurrences : []
  const normalized = rawOccurrences
    .map((occurrence, index) => normalizeErrorOccurrence(
      occurrence && typeof occurrence === 'object'
        ? occurrence as TicketErrorOccurrenceInput
        : { id: `error-${index + 1}` },
      index + 1,
      ticket.updatedAt,
    ))
    .sort((left, right) => {
      const leftTime = Date.parse(left.occurredAt)
      const rightTime = Date.parse(right.occurredAt)
      if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return right.occurrenceNumber - left.occurrenceNumber
      if (Number.isNaN(leftTime)) return 1
      if (Number.isNaN(rightTime)) return -1
      if (leftTime !== rightTime) return rightTime - leftTime
      return right.occurrenceNumber - left.occurrenceNumber
    })

  if (normalized.length > 0) return normalized
  if (ticket.status !== 'BLOCKED_ERROR') return []
  return [buildSyntheticCurrentOccurrence(ticket)]
}

export function getActiveErrorOccurrence(ticket: TicketErrorSource): TicketErrorOccurrence | null {
  const occurrences = getTicketErrorOccurrences(ticket)
  if (occurrences.length === 0) return null

  if (ticket.activeErrorOccurrenceId != null) {
    // `String(...)` although the type is now `string`: this is a lookup against a
    // value that came off the wire, and the boundary is the only thing making it
    // a string. A payload that reaches here another way must still match rather
    // than silently find nothing.
    const activeOccurrenceId = String(ticket.activeErrorOccurrenceId)
    const matched = occurrences.find((occurrence) => occurrence.id === activeOccurrenceId)
    // A resolved occurrence is history. While the ticket is blocked, the id is
    // for reviewing that history — the *active* error is the one still open, and
    // returning a resolved occurrence here offered recovery actions against an
    // error that had already been dealt with.
    if (matched && (matched.resolvedAt === null || ticket.status !== 'BLOCKED_ERROR')) return matched
  }

  if (ticket.status !== 'BLOCKED_ERROR') return null

  // Newest-first, so `find` is already the most recent unresolved error and
  // `[0]` the most recent of any kind. Reversing first picked the *oldest* open
  // one and offered Retry and Continue against it — reachable now that an active
  // id naming a resolved occurrence falls through to here.
  const openOccurrence = occurrences.find((occurrence) => occurrence.resolvedAt === null)
  return openOccurrence ?? occurrences[0] ?? null
}

export function formatErrorOccurrenceLabel(
  occurrence: TicketErrorOccurrence,
  fallbackIndex: number,
  labelOptions: StatusLabelOptions = {},
): string {
  const occurrenceLabel = Number.isInteger(occurrence.occurrenceNumber) && occurrence.occurrenceNumber > 0
    ? occurrence.occurrenceNumber
    : fallbackIndex
  const phaseLabel = getStatusUserLabel(occurrence.blockedFromStatus, labelOptions)
  return `Error ${occurrenceLabel} — ${phaseLabel}`
}

export function formatErrorOccurrenceStatus(
  occurrence: TicketErrorOccurrence,
  labelOptions: StatusLabelOptions = {},
): string {
  if (occurrence.resolutionStatus === 'RETRIED') {
    return occurrence.resumedToStatus ? `Retried to ${getStatusUserLabel(occurrence.resumedToStatus, labelOptions)}` : 'Retried'
  }
  if (occurrence.resolutionStatus === 'CONTINUED') {
    return occurrence.resumedToStatus ? `Continued to ${getStatusUserLabel(occurrence.resumedToStatus, labelOptions)}` : 'Continued'
  }
  if (occurrence.resolutionStatus === 'CANCELED') return 'Canceled'
  if (occurrence.resolvedAt) return 'Resolved'
  return 'Active error'
}
