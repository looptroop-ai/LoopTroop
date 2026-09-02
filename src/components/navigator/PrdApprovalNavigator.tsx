import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useQuery } from '@tanstack/react-query'
import { QUERY_STALE_TIME_5M } from '@/lib/constants'
import { dispatchPrdApprovalFocus, buildPrdApprovalOutline, parsePrdDocument } from '@/lib/prdDocument'
import { apiFilePath } from '@/lib/apiPaths'
import { throwIfNotOk } from '@/lib/fetchError'
import { QueryErrorNotice } from '@/components/shared/QueryErrorNotice'

function focusPrdAnchor(ticketId: string, anchorId: string) {
  dispatchPrdApprovalFocus(ticketId, anchorId)
}

function OutlineCard({
  ticketId,
  anchorId,
  title,
  description,
  children,
}: {
  ticketId: string
  anchorId: string
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <div className="rounded-md border border-border/70 bg-background px-2 py-2 transition-colors hover:bg-accent/30">
      <button
        type="button"
        onClick={() => focusPrdAnchor(ticketId, anchorId)}
        className="min-w-0 w-full text-left"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-foreground">{title}</span>
          {description ? <span className="text-[11px] text-muted-foreground">{description}</span> : null}
        </div>
      </button>
      {children ? <div className="mt-2 space-y-1.5 pl-3">{children}</div> : null}
    </div>
  )
}

export function PrdApprovalNavigator({ ticketId }: { ticketId: string }) {
  const { data: fetchedContent, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['artifact', ticketId, 'prd'],
    queryFn: async ({ signal }) => {
      const response = await fetch(apiFilePath(ticketId, 'prd'), { signal })
      await throwIfNotOk(response, 'Failed to load PRD')
      const payload = await response.json()
      return typeof payload?.content === 'string' ? payload.content : ''
    },
    staleTime: QUERY_STALE_TIME_5M,
  })

  const document = parsePrdDocument(fetchedContent ?? '')
  const outline = document ? buildPrdApprovalOutline(document) : null

  return (
    <div className="p-2">
      <div className="px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        PRD Approval
      </div>
      <ScrollArea className="max-h-[320px]">
        <div className="space-y-2 pr-2">
          {isLoading ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">Loading PRD outline…</div>
          ) : isError ? (
            <QueryErrorNotice
              title="The PRD outline could not be loaded."
              error={error}
              onRetry={() => void refetch()}
            />
          ) : !outline ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">The PRD approval outline will appear once the canonical artifact is ready.</div>
          ) : (
            <>
              <OutlineCard
                ticketId={ticketId}
                anchorId={outline.product.anchorId}
                title={outline.product.label}
                description={outline.product.description}
              />

              <OutlineCard
                ticketId={ticketId}
                anchorId={outline.scope.anchorId}
                title={outline.scope.label}
                description={outline.scope.description}
              />

              <OutlineCard
                ticketId={ticketId}
                anchorId={outline.technicalRequirements.anchorId}
                title={outline.technicalRequirements.label}
                description={outline.technicalRequirements.description}
              />

              <OutlineCard
                ticketId={ticketId}
                anchorId={outline.risks.anchorId}
                title={outline.risks.label}
                description={outline.risks.description}
              />

              <div className="space-y-2 rounded-md border border-border/70 bg-background px-2 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-foreground">Epics</span>
                  <Badge variant="outline" className="h-4 text-[10px]">{outline.epics.length}</Badge>
                </div>

                <div className="space-y-2">
                  {outline.epics.map((epic) => (
                    <OutlineCard
                      key={epic.id}
                      ticketId={ticketId}
                      anchorId={epic.anchorId}
                      title={`${epic.id} · ${epic.label}`}
                      description={epic.description || undefined}
                    >
                      {epic.userStories.map((story) => (
                        <OutlineCard
                          key={story.id}
                          ticketId={ticketId}
                          anchorId={story.anchorId}
                          title={`${story.id} · ${story.title}`}
                        />
                      ))}
                    </OutlineCard>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
