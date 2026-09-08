import { Badge } from '@/components/ui/badge'
import { isRecord } from '@shared/typeGuards'
import { useQuery } from '@tanstack/react-query'
import { QUERY_STALE_TIME_5M } from '@/lib/constants'
import { BEADS_APPROVAL_FOCUS_EVENT, type RawBead } from '@/lib/beadsDocument'
import { apiTicketPath } from '@/lib/apiPaths'
import { throwIfNotOk } from '@/lib/fetchError'
import { ApprovalOutlineShell } from './ApprovalOutlineShell'

function focusBeadAnchor(ticketId: string, anchorId: string) {
  window.dispatchEvent(new CustomEvent(BEADS_APPROVAL_FOCUS_EVENT, {
    detail: { ticketId, anchorId },
  }))
}

interface BeadOutlineItem {
  index: number
  id: string
  title: string
  dependencyCount: number
}

// The route hands back whatever each JSONL line parsed to, with no shape check,
// so an entry can be `null` or a bare number. `RawBead` describes the shape but
// asserts nothing at runtime; every field is still read defensively, and
// `blocked_by` is checked for being an array rather than merely having a
// `length` — a string would otherwise report its character count as a
// dependency count.
function parseBeadsOutline(data: unknown[]): BeadOutlineItem[] {
  return data.map((entry, index) => {
    const bead: RawBead = isRecord(entry) ? entry : {}
    const id = typeof bead.id === 'string' ? bead.id : `bead-${index}`
    const title = typeof bead.title === 'string' ? bead.title : `Bead ${index + 1}`
    const blockedBy = isRecord(bead.dependencies) && Array.isArray(bead.dependencies.blocked_by)
      ? bead.dependencies.blocked_by.length
      : 0
    return { index, id, title, dependencyCount: blockedBy }
  })
}

export function BeadsApprovalNavigator({ ticketId }: { ticketId: string }) {
  const { data: beadsData, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['artifact', ticketId, 'beads'],
    queryFn: async ({ signal }) => {
      const response = await fetch(apiTicketPath(ticketId, 'beads'), { signal })
      await throwIfNotOk(response, 'Failed to load beads')
      return response.json()
    },
    staleTime: QUERY_STALE_TIME_5M,
  })

  const outline = Array.isArray(beadsData) ? parseBeadsOutline(beadsData) : []

  return (
    <ApprovalOutlineShell
      title="Beads Blueprint"
      headerBadges={outline.length > 0 ? <Badge variant="outline" className="h-4 text-[10px]">{outline.length}</Badge> : null}
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={() => void refetch()}
      loadingMessage="Loading beads outline…"
      errorTitle="The beads outline could not be loaded."
      emptyMessage={outline.length === 0 ? 'The beads approval outline will appear once the artifact is ready.' : null}
    >
      {outline.map((bead) => (
        <button
          // A stored tracker is not deduplicated, so ids can repeat; the position
          // is what makes the key unique.
          key={`${bead.index}:${bead.id}`}
          type="button"
          onClick={() => focusBeadAnchor(ticketId, `bead-${bead.index}`)}
          className="w-full text-left rounded-md border border-border/70 bg-background px-2 py-1.5 transition-colors hover:bg-accent/30"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0">
              #{bead.index + 1}
            </span>
            <span className="text-xs truncate flex-1">{bead.title}</span>
            {bead.dependencyCount > 0 && (
              <Badge variant="outline" className="h-4 text-[10px] shrink-0">
                {bead.dependencyCount} dep{bead.dependencyCount > 1 ? 's' : ''}
              </Badge>
            )}
          </div>
        </button>
      ))}
    </ApprovalOutlineShell>
  )
}
