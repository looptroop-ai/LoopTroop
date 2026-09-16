import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { useQuery } from '@tanstack/react-query'
import { QUERY_STALE_TIME_5M } from '@/lib/constants'
import { BEADS_APPROVAL_FOCUS_EVENT, describeBeadEntry, filterBeadShaped, readBeadDependencies } from '@/lib/beadsDocument'
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

interface BeadsNavigatorData {
  items: unknown[]
  damaged: boolean
}

function hasDamagedHeader(response: Response): boolean {
  const headers = response.headers
  if (!headers || typeof headers.get !== 'function') return false
  const countHeader = (name: string) => {
    const value = headers.get(name)
    return value !== null && Number(value) > 0
  }
  const listHeader = (name: string) => Boolean(headers.get(name)?.trim())
  return countHeader('X-Malformed-Line-Count')
    || countHeader('X-Unrepresentable-Line-Count')
    || listHeader('X-Malformed-Lines')
    || listHeader('X-Unrepresentable-Lines')
}

function readNavigatorData(value: unknown): BeadsNavigatorData {
  // Keep already-cached array data usable while the query migrates to the
  // damage-aware envelope returned by the route.
  if (Array.isArray(value)) return { items: value, damaged: false }
  if (!value || typeof value !== 'object') return { items: [], damaged: false }
  const candidate = value as { items?: unknown; damaged?: unknown }
  return {
    items: Array.isArray(candidate.items) ? candidate.items : [],
    damaged: candidate.damaged === true,
  }
}

/**
 * The outline rows, taken from the same filtered list the artifact view renders.
 *
 * The focus anchors are positions in that list (`bead-<index>`), so this must
 * filter identically or a click lands on the wrong bead. It briefly did not:
 * filtering was added to the artifact parser alone, which left the outline
 * numbering the unfiltered array.
 */
function parseBeadsOutline(data: unknown[]): BeadOutlineItem[] {
  return filterBeadShaped(data, describeBeadEntry).map((bead, index) => ({
    index,
    id: typeof bead.id === 'string' ? bead.id : `bead-${index}`,
    title: typeof bead.title === 'string' ? bead.title : `Bead ${index + 1}`,
    // Through the shared reader: the outline sits beside the artifact view and
    // the editor, and a bead stored with `blockedBy` counted zero here while
    // both of those showed its dependencies.
    dependencyCount: readBeadDependencies(bead, 'display').blocked_by.length,
  }))
}

export function BeadsApprovalNavigator({ ticketId }: { ticketId: string }) {
  const { data: beadsData, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['artifact', ticketId, 'beads'],
    queryFn: async ({ signal }) => {
      const response = await fetch(apiTicketPath(ticketId, 'beads'), { signal })
      await throwIfNotOk(response, 'Failed to load beads')
      const payload = await response.json()
      const parsed = readNavigatorData(payload)
      return {
        items: parsed.items,
        damaged: parsed.damaged || hasDamagedHeader(response),
      } satisfies BeadsNavigatorData
    },
    staleTime: QUERY_STALE_TIME_5M,
  })

  // Memoised for the same reason as the artifact view: the shared filter warns
  // about every entry it drops, so filtering in the render body repeats those
  // warnings on each re-render.
  const navigatorData = useMemo(() => readNavigatorData(beadsData), [beadsData])
  const outline = useMemo(
    () => navigatorData.damaged ? [] : parseBeadsOutline(navigatorData.items),
    [navigatorData],
  )
  const emptyMessage = navigatorData.damaged
    ? 'The beads tracker has damaged rows. Repair it in the JSONL editor before using the outline.'
    : outline.length === 0
      ? 'The beads approval outline will appear once the artifact is ready.'
      : null

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
      emptyMessage={emptyMessage}
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
