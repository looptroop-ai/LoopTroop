import { SunMoon, Moon, Sun, Settings, FolderOpen, Plus, RefreshCw, BookOpen, SlidersHorizontal, MoreHorizontal, MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { useUI } from '@/context/useUI'
import type { UIState } from '@/context/uiContextDef'
import { WORKFLOW_GROUPS, WORKFLOW_PHASE_MAP } from '@/lib/workflowMeta'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useBackendHealth } from '@/hooks/useBackendHealth'
import { DashboardSearch } from './DashboardSearch'
import { cn } from '@/lib/utils'

interface AppShellProps {
  children: React.ReactNode
  onOpenProfile?: () => void
  onOpenPrompts?: () => void
  onOpenProject?: () => void
  onOpenTicket?: () => void
  isModalOpen?: boolean
}

const DEFAULT_SORT = 'updatedAt_desc'

const PRIORITY_FILTER_LABELS: Record<number, string> = {
  1: 'Very High',
  2: 'High',
  3: 'Normal',
  4: 'Low',
  5: 'Very Low',
}

const SORT_FILTER_LABELS: Record<string, string> = {
  updatedAt_asc: 'Last Updated (Oldest first)',
  createdAt_desc: 'Date Created (Newest first)',
  createdAt_asc: 'Date Created (Oldest first)',
  priority_asc: 'Priority (High to Low)',
  priority_desc: 'Priority (Low to High)',
  title_asc: 'Title (A-Z)',
  title_desc: 'Title (Z-A)',
}

function getActiveTriageFilterSummaries(filters: UIState['filters']): string[] {
  const summaries: string[] = []

  if (filters.projectId !== null) summaries.push('Project filter')
  if (filters.priority?.length) {
    summaries.push(`Priority: ${filters.priority.map((priority) => PRIORITY_FILTER_LABELS[priority] ?? `P${priority}`).join(', ')}`)
  }
  if (filters.status?.length) {
    const labels = filters.status.map((s) => WORKFLOW_PHASE_MAP[s]?.label ?? s.replace(/_/g, ' '))
    summaries.push(`Status: ${labels.length <= 3 ? labels.join(', ') : `${labels.length} selected`}`)
  }
  if (filters.phase?.length) {
    const labels = filters.phase.map((p) => WORKFLOW_GROUPS.find((g) => g.id === p)?.label ?? p)
    summaries.push(`Phase: ${labels.join(', ')}`)
  }
  if (filters.stuckDays !== null) {
    summaries.push(filters.stuckDays === 1 ? 'Stale: > 24h inactive' : `Stale: > ${filters.stuckDays} days inactive`)
  }
  if (filters.errorState === 'blocked') summaries.push('Errors: Currently blocked')
  else if (filters.errorState === 'past') summaries.push('Errors: Has errored before')
  if (filters.showMocks === false) summaries.push('Mocks: Hidden')
  if (filters.sortBy !== DEFAULT_SORT) summaries.push(`Sort: ${SORT_FILTER_LABELS[filters.sortBy] ?? filters.sortBy}`)

  return summaries
}

export function AppShell({ children, onOpenProfile, onOpenPrompts, onOpenProject, onOpenTicket, isModalOpen = false }: AppShellProps) {
  const { state, dispatch } = useUI()
  const theme = state.theme
  const queryClient = useQueryClient()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const docsOrigin = `${__LOOPTROOP_DOCS_ORIGIN__}/`
  const { isOffline } = useBackendHealth()
  const activeTriageFilterSummaries = getActiveTriageFilterSummaries(state.filters)
  const activeTriageFilterCount = activeTriageFilterSummaries.length

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await queryClient.refetchQueries()
    setIsRefreshing(false)
  }

  return (
    <div className="min-h-screen bg-background text-foreground antialiased selection:bg-brand-500/20 selection:text-brand-500">
      <header className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-border/80 bg-background/80 px-2 sm:px-4 md:px-6 backdrop-blur-md supports-[backdrop-filter]:bg-background/60 shadow-xs transition-all">
        <button
          className="group flex items-center gap-2.5 cursor-pointer outline-none rounded-lg p-1 -ml-1 transition-all hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            dispatch({ type: 'SELECT_TICKET', ticketId: null })
            window.history.pushState({}, '', '/')
          }}
        >
          <img src="/trans-logo.png" alt="LoopTroop" className="h-7 w-auto transition-transform duration-200 group-hover:scale-105" />
          <div className="hidden items-baseline gap-2 sm:flex">
            <span className="text-xl font-bold tracking-tight text-foreground group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">
              LoopTroop
            </span>
            <span className="hidden sm:inline-block text-[10px] font-mono font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/60">
              v0.4.1
            </span>
          </div>
        </button>
        <div className="flex min-w-0 items-center gap-1 sm:gap-2">
          <DashboardSearch isModalOpen={isModalOpen} />
          {state.activeView === 'kanban' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={state.showTriageBar ? 'secondary' : 'ghost'}
                  size="icon"
                  onClick={() => dispatch({ type: 'TOGGLE_TRIAGE_BAR' })}
                  aria-label={`${state.showTriageBar ? 'Hide filters' : 'Show filters'}${activeTriageFilterCount > 0 ? `, ${activeTriageFilterCount} active` : ''}`}
                  className={cn(
                    "relative h-9 w-9 shrink-0 cursor-pointer transition-all border border-transparent rounded-lg",
                    state.showTriageBar
                      ? "bg-brand-500/10 text-brand-600 dark:text-brand-400 border-brand-500/30 shadow-xs"
                      : "hover:bg-accent/60 text-muted-foreground hover:text-foreground"
                  )}
                  disabled={isModalOpen}
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  {activeTriageFilterCount > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 dark:bg-brand-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-background">
                      {activeTriageFilterCount}
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs whitespace-pre-line text-xs">
                {activeTriageFilterCount > 0
                  ? `${state.showTriageBar ? 'Hide filters' : 'Show filters'}\n${activeTriageFilterCount} active: ${activeTriageFilterSummaries.join(', ')}`
                  : state.showTriageBar ? 'Hide filters' : 'Show filters'}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenTicket}
                disabled={isModalOpen}
                className="group relative inline-flex items-center gap-1.5 rounded-lg bg-foreground text-background px-3 py-1.5 text-sm font-medium transition-all hover:opacity-95 active:scale-[0.98] disabled:opacity-50 shadow-xs cursor-pointer"
              >
                <Plus className="h-4 w-4 transition-transform group-hover:rotate-90 duration-200" />
                <span className="hidden sm:inline">New Ticket</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>Create new ticket</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={onOpenProject} disabled={isModalOpen} className="hidden rounded-lg px-2 lg:inline-flex lg:px-3">
                <FolderOpen className="h-4 w-4 sm:mr-1.5" />
                <span className="hidden sm:inline">Projects</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Manage Projects</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={onOpenProfile} disabled={isModalOpen} className="hidden rounded-lg px-2 lg:inline-flex lg:px-3">
                <Settings className="h-4 w-4 md:mr-1.5" />
                <span className="hidden md:inline">Configuration</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Configuration</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={onOpenPrompts} disabled={isModalOpen} className="hidden rounded-lg px-2 lg:inline-flex lg:px-3">
                <MessageSquareText className="h-4 w-4 md:mr-1.5" />
                <span className="hidden md:inline">Prompts</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit workflow prompts</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" asChild className="hidden rounded-lg px-2 lg:inline-flex lg:px-3">
                <a href={docsOrigin} target="_blank" rel="noreferrer noopener">
                  <BookOpen className="h-4 w-4 md:mr-1.5" />
                  <span className="hidden md:inline">Docs</span>
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open docs in a new tab</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost" 
                size="icon" 
                onClick={handleRefresh} 
                disabled={isModalOpen || isRefreshing} 
                aria-label="Refresh Dashboard"
                className="hidden lg:inline-flex"
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="More navigation actions" className="lg:hidden">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>More</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onOpenProject} disabled={isModalOpen}>
                <FolderOpen className="mr-2 h-4 w-4" />
                Projects
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenProfile} disabled={isModalOpen}>
                <Settings className="mr-2 h-4 w-4" />
                Configuration
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenPrompts} disabled={isModalOpen}>
                <MessageSquareText className="mr-2 h-4 w-4" />
                Prompts
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={docsOrigin} target="_blank" rel="noreferrer noopener">
                  <BookOpen className="mr-2 h-4 w-4" />
                  Docs
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void handleRefresh()} disabled={isModalOpen || isRefreshing}>
                <RefreshCw className={cn("mr-2 h-4 w-4", isRefreshing && "animate-spin")} />
                Refresh
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Toggle theme">
                    {theme === 'light' && <Sun className="h-4 w-4 text-amber-400" fill="currentColor" />}
                    {theme === 'dark' && <Moon className="h-4 w-4 text-blue-300" fill="currentColor" />}
                    {theme === 'system' && <SunMoon className="h-4 w-4" />}
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Theme</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => dispatch({ type: 'SET_THEME', theme: 'system' })}>
                <SunMoon className="h-4 w-4 mr-2" />
                System
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => dispatch({ type: 'SET_THEME', theme: 'light' })}>
                <Sun className="h-4 w-4 mr-2" />
                Light
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => dispatch({ type: 'SET_THEME', theme: 'dark' })}>
                <Moon className="h-4 w-4 mr-2" />
                Dark
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {isOffline && (
        <div
          className="border-b border-amber-200 bg-amber-50/90 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/40"
          role="status"
          aria-live="polite"
          data-testid="backend-reconnecting-banner"
        >
          <div className="flex flex-col gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="w-fit gap-1.5 border-amber-300 bg-amber-100/80 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                >
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  Reconnecting to server...
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-center text-balance">Backend is unreachable. LoopTroop is reconnecting automatically.</TooltipContent>
            </Tooltip>
            <p className="text-xs leading-5 text-amber-900/75 dark:text-amber-200/80">
              The server is not responding. LoopTroop will reconnect automatically when it becomes available.
            </p>
          </div>
        </div>
      )}
      <main className="flex-1">
        {children}
      </main>
    </div>
  )
}
