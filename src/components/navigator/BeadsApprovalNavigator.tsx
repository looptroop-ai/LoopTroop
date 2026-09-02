import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useQuery } from '@tanstack/react-query'
import { QUERY_STALE_TIME_5M } from '@/lib/constants'
import { BEADS_APPROVAL_FOCUS_EVENT } from '@/lib/beadsDocument'
import { apiTicketPath } from '@/lib/apiPaths'

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

function parseBeadsOutline(data: unknown[]): BeadOutlineItem[] {
  return data.map((bead, index) => {
    const record = bead as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : `bead-${index}`
    const title = typeof record.title === 'string' ? record.title : `Bead ${index + 1}`
    const deps = record.dependencies as Record<string, unknown> | undefined
    const blockedBy = Array.isArray(deps?.blocked_by) ? deps.blocked_by.length : 0
    return { index, id, title, dependencyCount: blockedBy }
  })
}

export function BeadsApprovalNavigator({ ticketId }: { ticketId: string }) {
  const { data: beadsData, isLoading } = useQuery({
    queryKey: ['artifact', ticketId, 'beads'],
    queryFn: async () => {
      const response = await fetch(apiTicketPath(ticketId, 'beads'))
      if (!response.ok) throw new Error('Failed to load beads')
      return response.json()
    },
    staleTime: QUERY_STALE_TIME_5M,
  })

  const outline = Array.isArray(beadsData) ? parseBeadsOutline(beadsData) : []

  return (
    <div className="p-2">
      <div className="px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
        <span>Beads Blueprint</span>
        {outline.length > 0 && <Badge variant="outline" className="h-4 text-[10px]">{outline.length}</Badge>}
      </div>
      <ScrollArea className="max-h-[320px]">
        <div className="space-y-1 pr-2">
          {isLoading ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">Loading beads outline…</div>
          ) : outline.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">The beads approval outline will appear once the artifact is ready.</div>
          ) : (
            outline.map((bead) => (
              <button
                key={bead.id}
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
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
