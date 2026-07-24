import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { TicketCard } from './TicketCard'
import type { KanbanColumnConfig } from './KanbanBoard'
import { getDashboardSearchMatch } from './kanbanSearch'
import type { Ticket } from '@/hooks/useTickets'
import type { Project } from '@/hooks/useProjects'

const PAGE_SIZE = 15

interface KanbanColumnProps {
  column: KanbanColumnConfig
  tickets: Ticket[]
  projectMap: Map<number, Project>
  emptyLabel?: string
  resetKey?: string
  sortBy?: string
  searchQuery?: string
}

export function KanbanColumn({
  column,
  tickets,
  projectMap,
  emptyLabel = 'No tickets',
  resetKey = '',
  sortBy = 'updatedAt_desc',
  searchQuery = '',
}: KanbanColumnProps) {
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')

  useEffect(() => {
    setCurrentPage(1)
    setPageInput('1')
  }, [resetKey, tickets.length])

  useEffect(() => {
    setPageInput(String(currentPage))
  }, [currentPage])

  const totalPages = Math.max(1, Math.ceil(tickets.length / PAGE_SIZE))
  const sortedTickets = useMemo(() => {
    const list = [...tickets]
    switch (sortBy) {
      case 'updatedAt_asc':
        return list.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
      case 'createdAt_desc':
        return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      case 'createdAt_asc':
        return list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      case 'priority_asc':
        return list.sort((a, b) => {
          if (a.priority !== b.priority) {
            return a.priority - b.priority
          }
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        })
      case 'priority_desc':
        return list.sort((a, b) => {
          if (a.priority !== b.priority) {
            return b.priority - a.priority
          }
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        })
      case 'title_asc':
        return list.sort((a, b) => a.title.localeCompare(b.title))
      case 'title_desc':
        return list.sort((a, b) => b.title.localeCompare(a.title))
      case 'updatedAt_desc':
      default:
        return list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    }
  }, [tickets, sortBy])
  const paginatedTickets = sortedTickets.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  const setPage = (nextPage: number) => {
    const clampedPage = Math.min(totalPages, Math.max(1, nextPage))
    setCurrentPage(clampedPage)
    setPageInput(String(clampedPage))
  }

  const commitPageInput = (value: string) => {
    if (!value) {
      setPageInput(String(currentPage))
      return
    }

    setPage(Number.parseInt(value, 10))
  }

  return (
    <Card className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-card/60 backdrop-blur-xs shadow-xs transition-all">
      <CardHeader className="min-w-0 flex-shrink-0 pb-2.5 pt-3.5 px-3.5 border-b border-border/40">
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              tabIndex={0}
              className="min-w-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <CardTitle className="min-w-0 text-sm font-semibold tracking-tight text-foreground">{column.title}</CardTitle>
                <Badge variant="secondary" className="shrink-0 text-xs font-mono font-medium rounded-full bg-muted/80 text-muted-foreground border border-border/40 px-2 py-0.5">
                  {tickets.length}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">{column.description}</p>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-center text-balance text-xs">{column.tooltip}</TooltipContent>
        </Tooltip>
      </CardHeader>
      <CardContent className="min-w-0 flex-1 overflow-hidden p-2.5">
        <ScrollArea className="h-full min-w-0" contentLayout="block">
          {tickets.length === 0 ? (
            <div className="flex h-36 flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/20 p-4 text-center">
              <div className="h-8 w-8 rounded-full bg-muted/60 flex items-center justify-center text-muted-foreground mb-2">
                <span className="text-xs font-mono font-bold">0</span>
              </div>
              <p className="text-xs font-medium text-muted-foreground">{emptyLabel}</p>
            </div>
          ) : (
            <div className="min-w-0 space-y-2">
              {paginatedTickets.map((ticket) => {
                const project = projectMap.get(ticket.projectId)
                const searchMatch = getDashboardSearchMatch(ticket, project, searchQuery)
                return (
                  <TicketCard
                    key={ticket.id}
                    ticket={ticket}
                    projectColor={project?.color}
                    projectIcon={project?.icon}
                    projectName={project?.name}
                    searchMatchLabel={searchMatch?.label}
                  />
                )
              })}
            </div>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <button
                onClick={() => setPage(currentPage - 1)}
                disabled={currentPage === 1}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>Page</span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  aria-label={`${column.title} current page`}
                  value={pageInput}
                  onChange={(event) => {
                    setPageInput(event.target.value.replace(/\D/g, ''))
                  }}
                  onBlur={() => commitPageInput(pageInput)}
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      event.currentTarget.blur()
                    }

                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setPageInput(String(currentPage))
                      event.currentTarget.blur()
                    }
                  }}
                  className="h-6 rounded border border-input bg-background px-1 text-center text-xs text-foreground tabular-nums"
                  style={{ width: `${Math.max(2, String(totalPages).length) + 1}ch` }}
                />
                <span>of {totalPages}</span>
              </div>
              <button
                onClick={() => setPage(currentPage + 1)}
                disabled={currentPage === totalPages}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
