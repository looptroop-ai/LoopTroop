import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { sanitizeErrorForDisplay } from '@shared/errorDisplay'
import type { Ticket } from '@/hooks/useTickets'
import { formatTimestampString } from '@/components/workspace/logFormat'
import { StatusIndicator } from './StatusIndicator'
import type { StatusLabelOptions } from '@/lib/workflowMeta'
import {
  formatErrorOccurrenceLabel,
  formatErrorOccurrenceStatus,
  getActiveErrorOccurrence,
  getTicketErrorOccurrences,
  type TicketErrorOccurrence,
} from '@/lib/errorOccurrences'

interface ErrorOccurrencesPanelProps {
  ticket: Ticket
  selectedErrorOccurrenceId?: string | null
  onSelectErrorOccurrence: (occurrenceId: string | null) => void
}

function getOccurrenceSubtitle(occurrence: TicketErrorOccurrence) {
  const startedAt = formatTimestampString(occurrence.occurredAt, { includeMilliseconds: false })
  if (occurrence.resolvedAt) {
    return `Blocked ${startedAt} · Resolved ${formatTimestampString(occurrence.resolvedAt, { includeMilliseconds: false })}`
  }
  return `Blocked ${startedAt}`
}

function ErrorOccurrenceRow({
  occurrence,
  isSelected,
  labelOptions,
  onSelect,
}: {
  occurrence: TicketErrorOccurrence
  isSelected: boolean
  labelOptions: StatusLabelOptions
  onSelect: () => void
}) {
  const summary = getOccurrenceSubtitle(occurrence)
  const status = formatErrorOccurrenceStatus(occurrence, labelOptions)

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full rounded-md border px-2.5 py-2 text-left transition-colors',
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
          : 'border-border hover:bg-accent/60',
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
        <StatusIndicator status={occurrence.resolvedAt ? 'completed' : 'error'} className="mt-0.5 shrink-0" />
        <div className="min-w-0 space-y-1">
          <span className="block text-xs font-semibold leading-tight break-words">
            {formatErrorOccurrenceLabel(occurrence, occurrence.occurrenceNumber, labelOptions)}
          </span>
          <div className="flex flex-wrap items-start gap-1.5">
            <Badge variant="outline" className="max-w-full text-[10px] leading-tight whitespace-normal break-words">
              {status}
            </Badge>
          </div>
          <p className="text-[11px] text-muted-foreground leading-tight break-words">
            {summary}
          </p>
          {occurrence.errorMessage && (
            <p className="text-[11px] font-mono text-muted-foreground/90 line-clamp-2 [overflow-wrap:anywhere]">
              {sanitizeErrorForDisplay(occurrence.errorMessage)}
            </p>
          )}
        </div>
      </div>
    </button>
  )
}

export function ErrorOccurrencesPanel({
  ticket,
  selectedErrorOccurrenceId,
  onSelectErrorOccurrence,
}: ErrorOccurrencesPanelProps) {
  const occurrences = useMemo(() => getTicketErrorOccurrences(ticket), [ticket])
  const activeOccurrence = useMemo(() => getActiveErrorOccurrence(ticket), [ticket])
  const currentStatusIsBlocked = ticket.status === 'BLOCKED_ERROR'
  const selectedOccurrence = selectedErrorOccurrenceId != null
    ? occurrences.find((occurrence) => occurrence.id === selectedErrorOccurrenceId) ?? null
    : null

  const visibleOccurrences = useMemo(() => {
    if (!currentStatusIsBlocked || !activeOccurrence) return occurrences
    return [
      activeOccurrence,
      ...occurrences.filter((occurrence) => occurrence.id !== activeOccurrence.id),
    ]
  }, [activeOccurrence, currentStatusIsBlocked, occurrences])

  const shouldShowPanel = visibleOccurrences.length > 0 || Boolean(selectedOccurrence)
  const autoExpandKey = currentStatusIsBlocked
    ? `blocked:${activeOccurrence?.id ?? ticket.activeErrorOccurrenceId ?? 'current'}`
    : selectedOccurrence?.resolvedAt
      ? `selected:${selectedOccurrence.id}`
      : null
  const [isUserExpanded, setIsUserExpanded] = useState<boolean | null>(null)
  const lastAutoExpandKeyRef = useRef(autoExpandKey)
  useEffect(() => {
    if (lastAutoExpandKeyRef.current === autoExpandKey) return
    lastAutoExpandKeyRef.current = autoExpandKey
    setIsUserExpanded(null)
  }, [autoExpandKey])
  const expanded = isUserExpanded ?? Boolean(autoExpandKey)
  const statusLabelOptions = useMemo(() => ({
    currentBead: ticket.runtime.currentBead ?? ticket.currentBead,
    totalBeads: ticket.runtime.totalBeads ?? ticket.totalBeads,
  }), [ticket.currentBead, ticket.runtime.currentBead, ticket.runtime.totalBeads, ticket.totalBeads])

  if (!shouldShowPanel) return null

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setIsUserExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')} />
        <AlertTriangle className={cn('h-3.5 w-3.5', currentStatusIsBlocked ? 'text-red-500 animate-wobble-throb' : 'text-amber-500')} />
        <span>Errors</span>
        <Badge variant="outline" className="text-[10px] shrink-0">
          {visibleOccurrences.length}
        </Badge>
        {currentStatusIsBlocked && (
          <Badge variant="destructive" className="text-[10px] shrink-0">
            Active
          </Badge>
        )}
        {!currentStatusIsBlocked && selectedOccurrence?.resolvedAt && (
          <Badge variant="secondary" className="text-[10px] shrink-0">
            Review
          </Badge>
        )}
      </button>

      {expanded && (
        <div className="max-h-[260px] overflow-y-auto pr-1">
          <div className="space-y-1.5">
            {visibleOccurrences.map((occurrence) => (
              <ErrorOccurrenceRow
                key={occurrence.id}
                occurrence={occurrence}
                isSelected={selectedErrorOccurrenceId === occurrence.id}
                labelOptions={statusLabelOptions}
                onSelect={() => onSelectErrorOccurrence(occurrence.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
