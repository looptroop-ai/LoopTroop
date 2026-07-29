import { useMemo, useState } from 'react'
import { KanbanColumn } from './KanbanColumn'
import { useTickets } from '@/hooks/useTickets'
import { useProjects } from '@/hooks/useProjects'
import { useUI } from '@/context/useUI'
import { STATUS_TO_PHASE, WORKFLOW_GROUPS, WORKFLOW_PHASES, WORKFLOW_PHASE_MAP } from '@/lib/workflowMeta'
import type { WorkflowGroupMeta, WorkflowPhaseMeta } from '@shared/workflowMeta'
import type { TriagePreset, ErrorStateFilter } from '@/context/uiContextDef'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, X, ChevronDown, FolderOpen } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from '@/components/ui/button'
import { ticketMatchesDashboardSearch } from './kanbanSearch'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'

export type KanbanPhase = 'todo' | 'in_progress' | 'needs_input' | 'done'

export interface KanbanColumnConfig {
  id: KanbanPhase
  title: string
  description: string
  tooltip: string
}

const columns: KanbanColumnConfig[] = [
  {
    id: 'todo',
    title: 'To Do',
    description: 'Backlog',
    tooltip: 'Tickets that have been created but have not started the workflow yet. Use this column for queued work that is ready to review, edit, or start when you are ready.',
  },
  {
    id: 'needs_input',
    title: 'Needs Input',
    description: 'Waiting for user',
    tooltip: 'Tickets paused because LoopTroop needs a human action before it can continue, such as interview answers, artifact approval, execution setup approval, PR review, or a retry/cancel decision after an error.',
  },
  {
    id: 'in_progress',
    title: 'In Progress',
    description: 'Active workflow',
    tooltip: 'Tickets currently moving through automated workflow steps, including discovery, council drafting and voting, coverage checks, setup, coding, final tests, integration, pull request creation, and cleanup.',
  },
  {
    id: 'done',
    title: 'Done',
    description: 'Completed tickets',
    tooltip: 'Terminal tickets that no longer advance automatically. This includes completed work and canceled work, with the ticket history and generated artifacts kept available for review.',
  },
]

const PRIORITY_LABELS: Record<number, string> = {
  1: 'Very High',
  2: 'High',
  3: 'Normal',
  4: 'Low',
  5: 'Very Low',
}

const SORT_LABELS: Record<string, string> = {
  updatedAt_desc: 'Last Updated (Newest first)',
  updatedAt_asc: 'Last Updated (Oldest first)',
  createdAt_desc: 'Date Created (Newest first)',
  createdAt_asc: 'Date Created (Oldest first)',
  priority_asc: 'Priority (High to Low)',
  priority_desc: 'Priority (Low to High)',
  title_asc: 'Title (A-Z)',
  title_desc: 'Title (Z-A)',
}

function formatStaleLabel(stuckDays: number): string {
  if (stuckDays === 1) return '> 24h inactive'
  return `> ${stuckDays} days inactive`
}

function formatPresetDetails(preset: TriagePreset): string {
  const priority = Array.isArray(preset.priority) ? preset.priority : null
  const stuckDays = typeof preset.stuckDays === 'number' ? preset.stuckDays : null
  const status = Array.isArray(preset.status) ? preset.status : null
  const phase = Array.isArray(preset.phase) ? preset.phase : null
  const errorState: ErrorStateFilter =
    preset.errorState === 'past' || preset.errorState === 'blocked' ? preset.errorState : 'none'
  const sortBy = typeof preset.sortBy === 'string' ? preset.sortBy : 'updatedAt_desc'
  const showMocks = preset.showMocks ?? true
  const groupLabel = (id: string) => WORKFLOW_GROUPS.find((g) => g.id === id)?.label ?? id
  const statusLabel = (id: string) => WORKFLOW_PHASE_MAP[id]?.label ?? id.replace(/_/g, ' ')
  const details = [
    priority?.length
      ? `Priority: ${priority.map((priorityValue) => PRIORITY_LABELS[priorityValue] ?? `P${priorityValue}`).join(', ')}`
      : 'Priority: All',
    status?.length
      ? `Status: ${status.map((s) => statusLabel(s)).join(', ')}`
      : 'Status: All',
    phase?.length
      ? `Phase: ${phase.map((p) => groupLabel(p)).join(', ')}`
      : 'Phase: All',
    stuckDays !== null
      ? `Stale: ${formatStaleLabel(stuckDays)} (Needs Input + In Progress only)`
      : 'Stale: Any time',
    errorState === 'blocked'
      ? 'Errors: Currently blocked'
      : errorState === 'past'
        ? 'Errors: Has errored before'
        : 'Errors: All states',
    `Mocks: ${showMocks ? 'Shown' : 'Hidden'}`,
    `Sort: ${SORT_LABELS[sortBy] ?? sortBy}`,
  ]

  return details.join('\n')
}

function ProjectIcon({
  icon,
  imageClassName,
  emojiClassName,
}: {
  icon?: string | null
  imageClassName: string
  emojiClassName: string
}) {
  if (!icon) return null
  return icon.startsWith('data:')
    ? <img src={icon} className={`${imageClassName} rounded`} alt="" />
    : <span className={emojiClassName} aria-hidden="true">{icon}</span>
}

export function KanbanBoard() {
  const { state, dispatch } = useUI()
  const { data: tickets, isLoading: isLoadingTickets } = useTickets()
  const { data: projects = [] } = useProjects()

  const selectedProjectId = state.filters?.projectId ?? null
  const selectedProject = useMemo(() => {
    if (selectedProjectId === null) return null
    return projects.find(p => p.id === selectedProjectId) || null
  }, [projects, selectedProjectId])
  
  const searchQuery = state.filters?.search ?? ''
  const isSearchActive = searchQuery.trim().length > 0
  const selectedPriority = state.filters?.priority ?? null
  const selectedStatus = state.filters?.status ?? null
  const selectedPhase = state.filters?.phase ?? null
  const selectedStuckDays = state.filters?.stuckDays ?? null
  const errorState: ErrorStateFilter = state.filters?.errorState ?? 'none'
  const sortBy = state.filters?.sortBy ?? 'updatedAt_desc'
  const showMocks = state.filters?.showMocks ?? true
  const [presetName, setPresetName] = useState('')
  const [presetSaveMessage, setPresetSaveMessage] = useState('')

  // Presets are persisted via UI state (looptroop-ui-state), scoped per project.
  const presetKey = selectedProjectId !== null ? `looptroop-presets-${selectedProjectId}` : 'looptroop-presets-global'
  const presets = state.presetsByProject?.[presetKey] ?? {}

  const savePreset = (name: string) => {
    const trimmedName = name.trim()
    if (!trimmedName) return false
    const newPresets: Record<string, TriagePreset> = {
      ...presets,
      [trimmedName]: {
        priority: selectedPriority,
        stuckDays: selectedStuckDays,
        status: selectedStatus,
        phase: selectedPhase,
        errorState,
        sortBy,
        showMocks,
      }
    }
    dispatch({ type: 'SET_PRESETS', presetKey, presets: newPresets })
    setPresetName('')
    setPresetSaveMessage(`Saved "${trimmedName}"`)
    return true
  }

  const deletePreset = (name: string) => {
    const newPresets = { ...presets }
    delete newPresets[name]
    dispatch({ type: 'SET_PRESETS', presetKey, presets: newPresets })
  }

  const applyPreset = (presetValue: TriagePreset) => {
    dispatch({
      type: 'SET_FILTER',
      filter: {
        priority: Array.isArray(presetValue.priority) ? presetValue.priority : null,
        status: Array.isArray(presetValue.status) ? presetValue.status : null,
        phase: Array.isArray(presetValue.phase) ? presetValue.phase : null,
        stuckDays: typeof presetValue.stuckDays === 'number' ? presetValue.stuckDays : null,
        errorState:
          presetValue.errorState === 'past' || presetValue.errorState === 'blocked'
            ? presetValue.errorState
            : 'none',
        sortBy: typeof presetValue.sortBy === 'string' ? presetValue.sortBy : 'updatedAt_desc',
        showMocks: typeof presetValue.showMocks === 'boolean' ? presetValue.showMocks : true,
      }
    })
  }

  const projectMap = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects])

  // Workflow statuses grouped by their phase/group, for the Status multi-select dropdown.
  const statusGroups = useMemo<{ group: WorkflowGroupMeta; statuses: WorkflowPhaseMeta[] }[]>(() => {
    return WORKFLOW_GROUPS.map((group) => ({
      group,
      statuses: WORKFLOW_PHASES.filter((phase) => phase.groupId === group.id),
    })).filter((entry) => entry.statuses.length > 0)
  }, [])

  const filteredTickets = useMemo(() => {
    let result = tickets ?? []

    // 1. Project Filter
    if (selectedProjectId !== null) {
      result = result.filter(t => t.projectId === selectedProjectId)
    }

    // 2. Search Query (matching external ID, title, description, project name, or project shortname)
    if (searchQuery.trim().length > 0) {
      result = result.filter(t => ticketMatchesDashboardSearch(t, projectMap.get(t.projectId), searchQuery))
    }

    // 3. Priority Filter
    if (selectedPriority !== null && selectedPriority.length > 0) {
      result = result.filter(t => selectedPriority.includes(t.priority))
    }

    // 4. Status Filter (multi-select of exact workflow status IDs)
    if (selectedStatus !== null && selectedStatus.length > 0) {
      result = result.filter(t => selectedStatus.includes(t.status))
    }

    // 5. Phase Filter (multi-select of workflow group IDs)
    if (selectedPhase !== null && selectedPhase.length > 0) {
      result = result.filter((t) => {
        const groupId = WORKFLOW_PHASE_MAP[t.status]?.groupId
        return groupId ? selectedPhase.includes(groupId) : false
      })
    }

    // 6. Stuck Days Filter (evaluates inactivity only for active columns: in_progress and needs_input)
    if (selectedStuckDays !== null) {
      const threshold = selectedStuckDays * 24 * 60 * 60 * 1000
      const now = Date.now()
      result = result.filter(t => {
        const phase = STATUS_TO_PHASE[t.status] ?? 'todo'
        if (phase === 'in_progress' || phase === 'needs_input') {
          return (now - new Date(t.updatedAt).getTime()) > threshold
        }
        return false
      })
    }

    // 7. Error State Filter (tri-state: none | past | blocked)
    if (errorState === 'blocked') {
      result = result.filter(t => t.status === 'BLOCKED_ERROR')
    } else if (errorState === 'past') {
      // Includes currently-blocked tickets, since blocked implies past errors.
      result = result.filter(t => t.status === 'BLOCKED_ERROR' || t.hasPastErrors === true)
    }

    // 8. Mock Tickets Filter
    if (!showMocks) {
      result = result.filter(t => !t.isDisplayOnlyMock)
    }

    return result
  }, [tickets, selectedProjectId, searchQuery, selectedPriority, selectedStatus, selectedPhase, selectedStuckDays, errorState, showMocks, projectMap])

  const ticketsByPhase = useMemo(() => columns.map(col => ({
    ...col,
    tickets: filteredTickets.filter(t => (STATUS_TO_PHASE[t.status] ?? 'todo') === col.id),
  })), [filteredTickets])

  const hasLoadedTickets = Array.isArray(tickets)
  const isAnyFilterActive = isSearchActive || selectedProjectId !== null || selectedPriority !== null || selectedStatus !== null || selectedPhase !== null || selectedStuckDays !== null || errorState !== 'none' || showMocks === false
  const hasNoSearchResults = hasLoadedTickets && isAnyFilterActive && filteredTickets.length === 0

  const resetFiltersKey = `${searchQuery}-${selectedProjectId}-${selectedPriority?.join(',')}-${selectedStatus?.join(',')}-${selectedPhase?.join(',')}-${selectedStuckDays}-${errorState}-${showMocks}-${sortBy}`

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Triage & Filter Control Bar */}
      {/* Triage & Filter Control Bar */}
      <div
        className={cn(
          "bg-card/45 backdrop-blur-md border-b border-border/40 transition-all duration-350 ease-in-out overflow-hidden flex flex-wrap items-center justify-between gap-3 shrink-0 shadow-[inset_0_-1px_0_0_rgba(0,0,0,0.03)]",
          state.showTriageBar
            ? "max-h-24 opacity-100 py-3 px-6"
            : "max-h-0 opacity-0 py-0 px-6 border-b-0 pointer-events-none"
        )}
        aria-hidden={!state.showTriageBar}
      >
        {state.showTriageBar && (
          <>
        <div className="flex flex-wrap items-center gap-4">
          {/* Project Filter */}
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <span>Project</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 border border-border/80 bg-background/40 hover:bg-background/80 text-xs rounded-lg transition-colors font-medium cursor-pointer px-2.5 flex items-center gap-1.5 text-foreground shadow-sm"
                >
                  {selectedProject ? (
                    <>
                      <ProjectIcon icon={selectedProject.icon} imageClassName="h-4 w-4" emojiClassName="text-xs" />
                      <span className="max-w-[120px] truncate">{selectedProject.name}</span>
                    </>
                  ) : (
                    <>
                      <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span>All Projects</span>
                    </>
                  )}
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/80 shrink-0 ml-0.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56 rounded-lg bg-popover/95 backdrop-blur-md">
                <DropdownMenuItem
                  onClick={() => dispatch({ type: 'SET_FILTER', filter: { projectId: null } })}
                  className="text-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span>All Projects</span>
                </DropdownMenuItem>
                {projects.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() => dispatch({ type: 'SET_FILTER', filter: { projectId: p.id } })}
                    className="text-xs flex items-center gap-1.5 cursor-pointer"
                  >
                    <ProjectIcon icon={p.icon} imageClassName="h-3.5 w-3.5" emojiClassName="text-xs" />
                    <span className="truncate">{p.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="h-4 w-px bg-border/50 hidden sm:block" />

          {/* Status multi-select (grouped by workflow phase) */}
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <span>Status</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 border border-border/80 bg-background/40 hover:bg-background/80 text-xs rounded-lg transition-colors font-medium cursor-pointer px-2.5 flex items-center gap-1.5 text-foreground shadow-sm"
                >
                  <span>{selectedStatus?.length ? `${selectedStatus.length} selected` : 'All steps'}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/80 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64 max-h-80 overflow-y-auto rounded-lg bg-popover/95 backdrop-blur-md">
                {statusGroups.map(({ group, statuses }) => (
                  <div key={group.id}>
                    <div className="px-2 py-1 text-[9px] font-bold text-muted-foreground uppercase tracking-widest">
                      {group.label}
                    </div>
                    {statuses.map((phase) => {
                      const checked = selectedStatus?.includes(phase.id) ?? false
                      return (
                        <DropdownMenuItem
                          key={phase.id}
                          onClick={() => {
                            const current = selectedStatus ?? []
                            const next = checked ? current.filter((s) => s !== phase.id) : [...current, phase.id]
                            dispatch({ type: 'SET_FILTER', filter: { status: next.length ? next : null } })
                          }}
                          className="text-xs flex items-center gap-2 cursor-pointer"
                        >
                          <span className="w-3 text-foreground">{checked ? '✓' : ''}</span>
                          <span>{phase.label}</span>
                        </DropdownMenuItem>
                      )
                    })}
                  </div>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="h-4 w-px bg-border/50 hidden sm:block" />

          {/* Phase multi-select (workflow groups) */}
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <span>Phase</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 border border-border/80 bg-background/40 hover:bg-background/80 text-xs rounded-lg transition-colors font-medium cursor-pointer px-2.5 flex items-center gap-1.5 text-foreground shadow-sm"
                >
                  <span>{selectedPhase?.length ? `${selectedPhase.length} selected` : 'All phases'}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/80 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56 rounded-lg bg-popover/95 backdrop-blur-md">
                {WORKFLOW_GROUPS.map((group) => {
                  const checked = selectedPhase?.includes(group.id) ?? false
                  return (
                    <DropdownMenuItem
                      key={group.id}
                      onClick={() => {
                        const current = selectedPhase ?? []
                        const next = checked ? current.filter((p) => p !== group.id) : [...current, group.id]
                        dispatch({ type: 'SET_FILTER', filter: { phase: next.length ? next : null } })
                      }}
                      className="text-xs flex items-center gap-2 cursor-pointer"
                    >
                      <span className="w-3 text-foreground">{checked ? '✓' : ''}</span>
                      <span>{group.label}</span>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="h-4 w-px bg-border/50 hidden sm:block" />

          {/* Priority Toggles */}
          <div className="flex items-center gap-1">
            <span className="text-xs font-semibold text-muted-foreground mr-1.5">Priority</span>
            {[
              { label: 'VH', val: 1, text: 'Very High', activeColor: 'border-zinc-800 bg-zinc-900 text-zinc-100 dark:border-zinc-200 dark:bg-zinc-100 dark:text-zinc-900 font-bold' },
              { label: 'H', val: 2, text: 'High', activeColor: 'border-zinc-500/50 bg-zinc-500/30 text-zinc-900 dark:text-zinc-100 font-bold' },
              { label: 'N', val: 3, text: 'Normal', activeColor: 'border-zinc-500/40 bg-zinc-500/20 text-zinc-700 dark:text-zinc-300 font-semibold' },
              { label: 'L', val: 4, text: 'Low', activeColor: 'border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-400 font-medium' },
              { label: 'VL', val: 5, text: 'Very Low', activeColor: 'border-zinc-500/20 bg-zinc-500/7 text-zinc-500 dark:text-zinc-400/80 font-medium' },
            ].map(({ label, val, text, activeColor }) => {
              const active = selectedPriority?.includes(val) ?? false
              return (
                <Tooltip key={val}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        const current = selectedPriority ?? []
                        const next = current.includes(val)
                          ? current.filter(v => v !== val)
                          : [...current, val]
                        dispatch({
                          type: 'SET_FILTER',
                          filter: { priority: next.length === 0 ? null : next }
                        })
                      }}
                      className={cn(
                        "h-8 px-2.5 text-[10px] font-bold rounded-lg border transition-all cursor-pointer",
                        active
                          ? activeColor
                          : "border-border bg-background/40 hover:bg-muted text-muted-foreground"
                      )}
                    >
                      {label}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">{text}</TooltipContent>
                </Tooltip>
              )
            })}
          </div>

          <div className="h-4 w-px bg-border/50 hidden sm:block" />

          {/* Stuck / Stale days filter */}
          <label className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            Stale
            <select
              className="h-8 rounded-lg border border-border/80 bg-background/40 hover:bg-background/80 px-2.5 text-xs text-foreground outline-none transition-colors focus:ring-1 focus:ring-ring cursor-pointer font-medium"
              value={selectedStuckDays !== null ? String(selectedStuckDays) : 'all'}
              onChange={(e) => {
                const val = e.target.value
                dispatch({
                  type: 'SET_FILTER',
                  filter: { stuckDays: val === 'all' ? null : Number(val) }
                })
              }}
            >
              <option value="all">Any time</option>
              <option value="1">&gt; 24h inactive</option>
              <option value="3">&gt; 3 days inactive</option>
              <option value="7">&gt; 7 days inactive</option>
            </select>
          </label>

          <div className="h-4 w-px bg-border/50 hidden sm:block" />

          {/* Errors tri-state filter */}
          <label className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <span>Errors</span>
            <select
              value={errorState}
              onChange={(e) => dispatch({ type: 'SET_FILTER', filter: { errorState: e.target.value as ErrorStateFilter } })}
              className={cn(
                "h-8 rounded-lg border border-border/80 bg-background/40 hover:bg-background/80 px-2.5 text-xs text-foreground outline-none transition-colors focus:ring-1 focus:ring-ring cursor-pointer font-medium",
                errorState === 'blocked' && "border-red-500/80 bg-red-500/10 text-red-600 dark:text-red-400 dark:bg-red-500/5 shadow-[0_0_8px_rgba(239,68,68,0.12)]",
                errorState === 'past' && "border-amber-500/80 bg-amber-500/10 text-amber-600 dark:text-amber-400 dark:bg-amber-500/5 shadow-[0_0_8px_rgba(245,158,11,0.12)]"
              )}
            >
              <option value="none">All states</option>
              <option value="past">Has errored before</option>
              <option value="blocked">Currently blocked</option>
            </select>
          </label>

          <div className="h-4 w-px bg-border/50 hidden sm:block" />

          {/* Mock tickets filter */}
          <label className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <span>Mocks</span>
            <select
              value={showMocks ? "show" : "hide"}
              onChange={(e) => dispatch({ type: 'SET_FILTER', filter: { showMocks: e.target.value === 'show' } })}
              className={cn(
                "h-8 rounded-lg border border-border/80 bg-background/40 hover:bg-background/80 px-2.5 text-xs text-foreground outline-none transition-colors focus:ring-1 focus:ring-ring cursor-pointer font-medium",
                !showMocks && "border-amber-500/80 bg-amber-500/10 text-amber-600 dark:text-amber-400 dark:bg-amber-500/5 shadow-[0_0_8px_rgba(245,158,11,0.12)]"
              )}
            >
              <option value="show">Show mocks</option>
              <option value="hide">Hide mocks</option>
            </select>
          </label>
        </div>

        <div className="flex items-center gap-3">
          {/* Presets manager dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 text-xs cursor-pointer rounded-lg border-border/80 bg-background/40 hover:bg-accent font-medium">
                Presets
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56 rounded-lg" align="end">
              <div className="p-2 border-b border-border text-[9px] font-bold text-muted-foreground uppercase tracking-widest">
                Load Preset
              </div>
              {Object.keys(presets).length === 0 ? (
                <div className="p-3 text-xs text-muted-foreground italic text-center">No presets saved</div>
              ) : (
                Object.entries(presets).map(([name, val]) => (
                  <div key={name} className="flex items-center justify-between px-2 py-1 text-xs hover:bg-accent rounded-sm">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => applyPreset(val)}
                          className="flex-1 text-left hover:text-foreground cursor-pointer text-xs font-medium"
                        >
                          {name}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs whitespace-pre-line text-left text-xs">
                        {formatPresetDetails(val)}
                      </TooltipContent>
                    </Tooltip>
                    <button
                      type="button"
                      onClick={() => deletePreset(name)}
                      className="text-muted-foreground hover:text-destructive font-semibold ml-2 cursor-pointer text-sm px-1.5 py-0.5 rounded hover:bg-muted"
                      title="Delete preset"
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
              <div className="p-2 border-t border-border mt-1">
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    savePreset(presetName)
                  }}
                  className="flex gap-1"
                >
                  <input
                    type="text"
                    name="name"
                    placeholder="New preset..."
                    required
                    value={presetName}
                    onChange={(event) => {
                      setPresetName(event.target.value)
                      setPresetSaveMessage('')
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    className="flex-1 h-7 border border-border/80 rounded-md bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                  />
                  <Button type="submit" size="sm" className="h-7 px-2 text-xs rounded-md" disabled={!presetName.trim()}>
                    Save
                  </Button>
                </form>
                {presetSaveMessage && (
                  <div
                    className={cn(
                      "mt-1 text-[10px]",
                      presetSaveMessage.startsWith('Could not') ? "text-destructive" : "text-muted-foreground"
                    )}
                    role="status"
                    aria-live="polite"
                  >
                    {presetSaveMessage}
                  </div>
                )}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Sort Selector */}
          <label className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            Sort
            <select
              className="h-8 rounded-lg border border-border/80 bg-background/40 hover:bg-background/80 px-2.5 text-xs text-foreground outline-none transition-colors focus:ring-1 focus:ring-ring cursor-pointer font-medium"
              value={sortBy}
              onChange={(e) => dispatch({ type: 'SET_FILTER', filter: { sortBy: e.target.value } })}
            >
              <option value="updatedAt_desc">Last Updated (Newest first)</option>
              <option value="updatedAt_asc">Last Updated (Oldest first)</option>
              <option value="createdAt_desc">Date Created (Newest first)</option>
              <option value="createdAt_asc">Date Created (Oldest first)</option>
              <option value="priority_asc">Priority (High to Low)</option>
              <option value="priority_desc">Priority (Low to High)</option>
              <option value="title_asc">Title (A-Z)</option>
              <option value="title_desc">Title (Z-A)</option>
            </select>
          </label>

          {/* Reset Filters button */}
          {(selectedProjectId !== null ||
            selectedPriority !== null ||
            selectedStatus !== null ||
            selectedPhase !== null ||
            selectedStuckDays !== null ||
            errorState !== 'none' ||
            sortBy !== 'updatedAt_desc') && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                dispatch({
                  type: 'SET_FILTER',
                  filter: {
                    projectId: null,
                    priority: null,
                    status: null,
                    phase: null,
                    stuckDays: null,
                    errorState: 'none',
                    sortBy: 'updatedAt_desc',
                    showMocks: true,
                  }
                })
              }}
              className="h-8 text-xs px-2 text-muted-foreground hover:text-foreground font-semibold cursor-pointer rounded-lg hover:bg-accent/40"
            >
              Reset
            </Button>
          )}
        </div>
          </>
        )}
      </div>

      {isLoadingTickets && (
        <div
          className="border-b border-amber-200 bg-amber-50/90 px-4 py-2 dark:border-amber-900/60 dark:bg-amber-950/40 shrink-0"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-col gap-1">
            <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                                    variant="outline"
                                    className="w-fit gap-1.5 border-amber-300 bg-amber-100/80 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                                  >
                                    <RefreshCw className="h-3 w-3 animate-spin" />
                                    Loading tickets...
                                  </Badge>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-center text-balance">Waiting for ticket data from the server.</TooltipContent>
                      </Tooltip>
            <p className="text-xs leading-5 text-amber-900/75 dark:text-amber-200/80">
              LoopTroop is fetching the tickets. This might take a few seconds on initial load.
            </p>
          </div>
        </div>
      )}
      {hasNoSearchResults && (
        <div
          className="border-b border-border bg-muted/30 px-4 py-3 shrink-0"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {isSearchActive && !selectedProjectId && !selectedPriority && !selectedStatus && !selectedPhase && !selectedStuckDays && errorState === 'none'
                ? 'No tickets match this search.'
                : 'No tickets match active search or filters.'}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (isSearchActive && !selectedProjectId && !selectedPriority && !selectedStatus && !selectedPhase && !selectedStuckDays && errorState === 'none' && showMocks === true) {
                  dispatch({ type: 'SET_FILTER', filter: { search: '' } })
                } else {
                  dispatch({
                    type: 'SET_FILTER',
                    filter: {
                      search: '',
                      projectId: null,
                      priority: null,
                      status: null,
                      phase: null,
                      stuckDays: null,
                      errorState: 'none',
                      sortBy: 'updatedAt_desc',
                      showMocks: true,
                    }
                  })
                }
              }}
              className="w-fit"
            >
              <X className="mr-1 h-4 w-4" />
              {isSearchActive && !selectedProjectId && !selectedPriority && !selectedStatus && !selectedPhase && !selectedStuckDays && errorState === 'none'
                ? 'Clear search'
                : 'Reset filters & search'}
            </Button>
          </div>
        </div>
      )}
      <div className="grid flex-1 grid-cols-1 gap-4 p-4 md:p-5 md:grid-cols-2 lg:grid-cols-[1fr_2.2fr_2.2fr_1fr] overflow-hidden bg-background/50 relative">
        {ticketsByPhase.map((col) => (
          <KanbanColumn
            key={col.id}
            column={col}
            tickets={col.tickets}
            projectMap={projectMap}
            emptyLabel={isSearchActive ? 'No matching tickets' : 'No tickets'}
            resetKey={resetFiltersKey}
            sortBy={sortBy}
            searchQuery={searchQuery}
          />
        ))}
      </div>
    </div>
  )
}
