import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { FolderOpen, Copy, Check as CheckIcon, Pencil, HardDrive, RotateCw, ChevronDown, ChevronRight, File, Folder, ExternalLink, CircleHelp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useUI } from '@/context/useUI'
import { useTicketAction, useUpdateTicket } from '@/hooks/useTickets'
import type { Ticket } from '@/hooks/useTickets'
import { useProfile } from '@/hooks/useProfile'
import { getProfileCouncil } from '@/lib/profileCouncil'
import { throwIfNotOk } from '@/lib/fetchError'
import { useProjects } from '@/hooks/useProjects'
import { getStatusUserLabel } from '@/lib/workflowMeta'
import { isTerminalWorkflowStatus } from '@shared/workflowMeta'
import { getWorkflowRingProgress, getStatusRingColor } from '@/components/kanban/ticketCardUtils'
import { ProgressRing } from '@/components/kanban/ProgressRing'
import { BeadCompletionChip } from '@/components/kanban/BeadCompletionChip'
import { EtaRange } from '@/components/navigator/EtaRange'
import { EffortBadge } from '@/components/shared/EffortBadge'
import { TicketActions } from './TicketActions'
import { ErrorBanner } from './ErrorBanner'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TicketDescriptionViewer } from './TicketDescriptionViewer'
import { TicketExternalId } from './TicketExternalId'
import { CancelTicketDialog } from './CancelTicketDialog'
import { describeSettingSource } from '@/lib/aiQuestionSetting'
import { formatAiQuestionWindow } from '@shared/aiQuestions'
import { apiTicketPath } from '@/lib/apiPaths'

interface DashboardHeaderProps {
  ticket: Ticket
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

function getPriorityLabel(priority: number): string {
  const labels: Record<number, string> = { 1: 'Very High', 2: 'High', 3: 'Normal', 4: 'Low', 5: 'Very Low' }
  return labels[priority] ?? 'Normal'
}

function formatDuration(durationMs: number): string {
  const minutes = Math.max(0, Math.floor(durationMs / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function getStatusBadgeClasses(status: string): string {
  if (status === 'BLOCKED_ERROR') return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800'
  if (isTerminalWorkflowStatus(status)) return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700'
  if (status.startsWith('WAITING_')) return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800'
  return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800'
}

function CopyablePathRow({ label, path }: { label: string; path: string }) {
  const [copied, handleCopy] = useCopyToClipboard()
  const [isOpening, setIsOpening] = useState(false)

  const handleOpenPath = async () => {
    setIsOpening(true)
    try {
      const response = await fetch('/api/files/open-path', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path }),
      })
      await throwIfNotOk(response, 'Failed to open path')
    } catch (err) {
      console.error('Error opening path:', err)
    } finally {
      setIsOpening(false)
    }
  }

  return (
    <div className="col-span-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="mt-0.5 flex items-center gap-1.5 group">
        <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <Tooltip>
                <TooltipTrigger asChild>
                  <code className="text-xs font-mono text-muted-foreground truncate flex-1">{path}</code>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-center text-balance">{path}</TooltipContent>
              </Tooltip>
        <Tooltip>
                <TooltipTrigger asChild>
                  <button
                        type="button"
                        onClick={handleOpenPath}
                        disabled={isOpening}
                        className="shrink-0 p-0.5 rounded hover:bg-muted disabled:opacity-50 transition-colors"
                      >
                        <ExternalLink className={`h-3 w-3 text-muted-foreground ${isOpening ? 'animate-pulse' : ''}`} />
                      </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-center text-balance">
                  {isOpening ? 'Opening folder...' : 'Reveal in File Explorer'}
                </TooltipContent>
              </Tooltip>
        <Tooltip>
                <TooltipTrigger asChild>
                  <button
                        type="button"
                        onClick={() => handleCopy(path)}
                        className="shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
                      >
                        {copied ? <CheckIcon className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                      </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-center text-balance">Copy path</TooltipContent>
              </Tooltip>
      </div>
    </div>
  )
}


function CopyableDescription({ description }: { description: string }) {
  const [copied, handleCopy] = useCopyToClipboard()

  return (
    <div className="col-span-2 border-t-[2px] border-border/70 pt-2 mt-1">
      <div className="flex items-center justify-between group">
        <span className="text-xs font-medium text-muted-foreground">Description</span>
        <Tooltip>
                <TooltipTrigger asChild>
                  <button
                        type="button"
                        onClick={() => handleCopy(description)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-0.5 rounded hover:bg-muted"
                      >
                        {copied ? <CheckIcon className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                      </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-center text-balance">Copy description</TooltipContent>
              </Tooltip>
      </div>
      <div className="mt-1 rounded-md border border-border/50 bg-muted/30 p-3 max-h-[300px] overflow-y-auto">
        <TicketDescriptionViewer description={description} />
      </div>
    </div>
  )
}

function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

interface SizeItem {
  name: string
  size: number
  isDirectory: boolean
  children?: SizeItem[]
}

interface BreakdownCategory {
  total: number
  children: SizeItem[]
}

interface SizeBreakdown {
  logs: BreakdownCategory
  artifacts: BreakdownCategory
  source: BreakdownCategory
}

function FileTreeNode({ node, depth = 0 }: { node: SizeItem; depth?: number }) {
  const [isOpen, setIsOpen] = useState(false)
  const hasChildren = node.isDirectory && node.children && node.children.length > 0

  // A row that expands is a disclosure and gets a real button; a leaf row is text,
  // and giving it a button would put a control in the tab order that does nothing.
  const RowTag = hasChildren ? 'button' : 'div'

  return (
    <div className="flex flex-col select-none">
      <RowTag
        {...(hasChildren
          ? { type: 'button' as const, 'aria-expanded': isOpen, onClick: () => setIsOpen(!isOpen) }
          : {})}
        className={`flex w-full items-center justify-between text-left text-[11px] hover:bg-muted/40 px-2 py-0.5 rounded transition-colors group ${
          hasChildren ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset' : ''
        }`}
        style={{ paddingLeft: `${depth * 8 + 8}px` }}
      >
        <span className="flex items-center gap-1.5 min-w-0 text-muted-foreground">
          {node.isDirectory ? (
            <>
              {hasChildren ? (
                isOpen ? (
                  <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                )
              ) : (
                <span className="w-3 h-3 shrink-0" />
              )}
              <Folder className="h-3.5 w-3.5 text-foreground/75 shrink-0" />
            </>
          ) : (
            <>
              <span className="w-3 h-3 shrink-0" />
              <File className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
            </>
          )}
          <span className="truncate text-foreground font-mono" title={node.name}>
            {node.name}
          </span>
        </span>
        <span className="text-[10px] font-mono text-muted-foreground ml-2 shrink-0 group-hover:text-foreground transition-colors">
          {formatBytes(node.size)}
        </span>
      </RowTag>

      {isOpen && hasChildren && (
        <div className="flex flex-col gap-0.5 border-l border-border/10 ml-3.5 mt-0.5 pl-1">
          {node.children!.map((child, idx) => (
            <FileTreeNode key={idx} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}


export function DashboardHeader({ ticket }: DashboardHeaderProps) {
  const { dispatch } = useUI()
  const { isPending } = useTicketAction()
  const { mutateAsync: updateTicket } = useUpdateTicket()
  const { data: profile } = useProfile()
  // Parsed here rather than inside the panel's render: these are JSON strings on
  // the profile, and parsing them where they are read meant doing it on every
  // render and asserting the result instead of checking it.
  const profileCouncil = useMemo(() => getProfileCouncil(profile), [profile])
  const [isDetailsOpen, setIsDetailsOpen] = useState(false)
  const [isCancelConfirmOpen, setIsCancelConfirmOpen] = useState(false)
  const [isBottomFadeVisible, setIsBottomFadeVisible] = useState(false)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(ticket.title)
  const inputRef = useRef<HTMLInputElement>(null)
  const manualQaOrigin = ticket.manualQaOrigin ?? null

  const [isCalculatingSize, setIsCalculatingSize] = useState(false)
  const [ticketSize, setTicketSize] = useState<number | null>(null)
  const [sizeBreakdown, setSizeBreakdown] = useState<SizeBreakdown | null>(null)
  const [sizeError, setSizeError] = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({})

  const handleCalculateSize = async () => {
    setIsCalculatingSize(true)
    setSizeError(null)
    try {
      const res = await fetch(apiTicketPath(ticket.id, 'size'))
      await throwIfNotOk(res, 'Failed to calculate size')
      const data = await res.json()
      setTicketSize(data.size)
      setSizeBreakdown(data.breakdown || null)
    } catch (err) {
      setSizeError(err instanceof Error ? err.message : 'Error calculating size')
    } finally {
      setIsCalculatingSize(false)
    }
  }

  useEffect(() => {
    setTitleDraft(ticket.title)
  }, [ticket.title])

  useEffect(() => {
    setTicketSize(null)
    setSizeBreakdown(null)
    setSizeError(null)
    setExpandedSections({})
  }, [ticket.id])

  useEffect(() => {
    if (isEditingTitle && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isEditingTitle])

  const handleSaveTitle = async () => {
    if (titleDraft.trim() && titleDraft !== ticket.title) {
      try {
        await updateTicket({ id: ticket.id, title: titleDraft.trim() })
      } catch {
        setTitleDraft(ticket.title)
      }
    } else {
      setTitleDraft(ticket.title)
    }
    setIsEditingTitle(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSaveTitle()
    if (e.key === 'Escape') {
      setTitleDraft(ticket.title)
      setIsEditingTitle(false)
    }
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setIsBottomFadeVisible(el.scrollHeight - el.scrollTop - el.clientHeight > 8)
  }, [])
  const detailsScrollInit = useCallback(() => {
    setIsBottomFadeVisible(true)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => handleScroll())
    })
  }, [handleScroll])
  const runtime = ticket.runtime
  const availableActions = ticket.availableActions
  const lockedCouncilMembers = ticket.lockedCouncilMembers
  const canCancel = availableActions.includes('cancel')
  const canDelete = isTerminalWorkflowStatus(ticket.status)
  const isActionPending = isPending
  const { data: projects = [] } = useProjects()
  const project = projects.find(p => p.id === ticket.projectId)
  const statusLabel = getStatusUserLabel(ticket.status, {
    currentBead: runtime.currentBead,
    totalBeads: runtime.totalBeads,
    errorMessage: ticket.errorMessage,
  })
  const workflowRingProgress = getWorkflowRingProgress(ticket.status)
  const ringColor = getStatusRingColor(ticket.status)
  return (
    <div className="border-b border-border bg-background">
      <div className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 px-3 sm:px-4 py-2">
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 min-w-0 flex-1">
          <div className="flex items-center gap-1.5 shrink-0">
            <ProjectIcon icon={project?.icon} imageClassName="h-4 w-4" emojiClassName="text-sm" />
            <TicketExternalId
              externalId={ticket.externalId}
              isDisplayOnlyMock={ticket.isDisplayOnlyMock}
              className="font-mono text-sm font-semibold"
              style={{ color: project?.color ?? undefined }}
            />
          </div>
          {isEditingTitle ? (
            <input
              ref={inputRef}
              className="text-base font-semibold truncate w-full max-w-[200px] sm:max-w-[300px] md:max-w-[400px] bg-transparent border-b border-primary outline-none focus:ring-0 px-0.5 py-0"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleSaveTitle}
            />
          ) : (
            <div className="flex items-center gap-1.5 group min-w-0">
              <h2 className="text-base font-semibold truncate max-w-[180px] sm:max-w-[300px] md:max-w-[400px]">{ticket.title}</h2>
              {ticket.status === 'DRAFT' && (
                <Tooltip>
                                    <TooltipTrigger asChild>
                                      <button
                                                    type="button"
                                                    onClick={() => setIsEditingTitle(true)}
                                                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-muted rounded shrink-0"
                                                    aria-label="Edit title"
                                                  >
                                                    <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                                                  </button>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-xs text-center text-balance">Edit Title</TooltipContent>
                                  </Tooltip>
              )}
            </div>
          )}
          <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className={`text-xs shrink-0 ${getStatusBadgeClasses(ticket.status)}`}>
                              {statusLabel}
                            </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-center text-balance">Current workflow phase</TooltipContent>
                  </Tooltip>
          {ticket.status === 'CODING' && runtime.totalBeads > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
              <BeadCompletionChip
                completedBeads={runtime.completedBeads}
                totalBeads={runtime.totalBeads}
                percent={runtime.percentComplete}
                showCount
              />
              {runtime.eta && <EtaRange eta={runtime.eta} />}
            </span>
          )}
        </div>
        <TicketActions
          ticket={ticket}
          canCancel={canCancel}
          canDelete={canDelete}
          isPending={isActionPending}
          cancelLabel="Cancel…"
          onShowDetails={() => setIsDetailsOpen(true)}
          onCancelConfirm={() => setIsCancelConfirmOpen(true)}
          onClose={() => dispatch({ type: 'CLOSE_TICKET' })}
        />
      </div>

      <Dialog open={isDetailsOpen} onOpenChange={(open) => { setIsDetailsOpen(open); if (open) detailsScrollInit() }}>
        <DialogContent
          closeButtonVariant="dashboard"
          className="max-w-2xl max-h-[80vh] flex flex-col"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">Ticket Details</DialogTitle>
            <DialogDescription className="sr-only">
              Review ticket metadata, project details, file locations, and the current description.
            </DialogDescription>
          </DialogHeader>
          <div className="relative flex-1 min-h-0 overflow-hidden">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm overflow-y-auto pr-1 max-h-[calc(80vh-6rem)] [scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:var(--border)_transparent]"
          >
            <div className={project ? '' : 'sm:col-span-2'}>
              <span className="text-xs font-medium text-muted-foreground">Title</span>
              <p className="mt-0.5 font-medium [overflow-wrap:anywhere]">{ticket.title}</p>
            </div>
            {project && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Project</span>
                <div className="mt-0.5 flex items-center gap-2 min-w-0">
                  <ProjectIcon icon={project.icon} imageClassName="h-4 w-4" emojiClassName="text-sm leading-none" />
                  <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span className="truncate font-medium">{project.name}</span>
                                        </TooltipTrigger>
                                        <TooltipContent className="max-w-xs text-center text-balance">{project.name}</TooltipContent>
                                      </Tooltip>
                </div>
              </div>
            )}
            <div>
              <span className="text-xs font-medium text-muted-foreground">External ID</span>
              <p className="font-mono mt-0.5">
                <TicketExternalId
                  externalId={ticket.externalId}
                  isDisplayOnlyMock={ticket.isDisplayOnlyMock}
                />
              </p>
            </div>
            <div>
              <span className="text-xs font-medium text-muted-foreground">Priority</span>
              <p className="mt-0.5">P{ticket.priority} — {getPriorityLabel(ticket.priority)}</p>
            </div>
            <div>
              <span className="text-xs font-medium text-muted-foreground">Created</span>
              <p className="mt-0.5">{new Date(ticket.createdAt).toLocaleString()}</p>
            </div>
            {ticket.status !== 'DRAFT' ? (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Last Updated</span>
                <p className="mt-0.5">{ticket.updatedAt ? new Date(ticket.updatedAt).toLocaleString() : 'N/A'}</p>
              </div>
            ) : <div />}
            {ticket.status !== 'DRAFT' && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Started At</span>
                <p className="mt-0.5">{ticket.startedAt ? new Date(ticket.startedAt).toLocaleString() : '—'}</p>
              </div>
            )}
            {ticket.startedAt && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Duration</span>
                <p className="mt-0.5">{(() => {
                  const start = new Date(ticket.startedAt).getTime()
                  // Blocked tickets stop the clock too: nothing is running while
                  // the ticket waits for a recovery decision.
                  const end = isTerminalWorkflowStatus(ticket.status) || ticket.status === 'BLOCKED_ERROR'
                    ? new Date(ticket.updatedAt).getTime()
                    : Date.now()
                  const diffMs = end - start
                  const mins = Math.floor(diffMs / 60000)
                  if (mins < 60) return `${mins}m`
                  const hrs = Math.floor(mins / 60)
                  return `${hrs}h ${mins % 60}m`
                })()}</p>
              </div>
            )}
            {ticket.implementationTiming.startedAt && (
              <div>
                <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <span>Actual implementation time</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        aria-label="About actual implementation time"
                      >
                        <CircleHelp className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm space-y-1.5 p-3 text-left text-xs leading-relaxed">
                      <p>Time actively spent running the originally planned beads. Time while the ticket was blocked and waiting for a retry or continue action is not included, and neither is time spent waiting for you to answer a question.</p>
                      <div className="border-t border-border/60 pt-1.5">
                        <p><span className="font-medium">Bead execution started:</span> {new Date(ticket.implementationTiming.startedAt).toLocaleString()}</p>
                        <p><span className="font-medium">Last planned bead finished:</span> {ticket.implementationTiming.lastPlannedBeadFinishedAt ? new Date(ticket.implementationTiming.lastPlannedBeadFinishedAt).toLocaleString() : 'N/A'}</p>
                      </div>
                      <div className="border-t border-border/60 pt-1.5">
                        <p><span className="font-medium">Workspace preparation:</span> {ticket.implementationTiming.workspacePreparationStartedAt ? formatDuration(ticket.implementationTiming.workspacePreparationDurationMs) : 'N/A'}</p>
                        <p><span className="font-medium">Final testing:</span> {ticket.implementationTiming.finalTestingStartedAt ? formatDuration(ticket.implementationTiming.finalTestingDurationMs) : 'N/A'}</p>
                        <p><span className="font-medium">Manual QA fix beads:</span> {ticket.implementationTiming.manualQaFixStartedAt ? formatDuration(ticket.implementationTiming.manualQaFixDurationMs) : 'N/A'}</p>
                        {ticket.implementationTiming.questionWaitingMs > 0 && (
                          <p><span className="font-medium">Waiting on your answers:</span> {formatDuration(ticket.implementationTiming.questionWaitingMs)}</p>
                        )}
                        <p className="text-muted-foreground">Including these stages, implementation delivery time is {formatDuration(
                          ticket.implementationTiming.activeDurationMs
                          + ticket.implementationTiming.workspacePreparationDurationMs
                          + ticket.implementationTiming.finalTestingDurationMs
                          + ticket.implementationTiming.manualQaFixDurationMs,
                        )}.</p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <p className="mt-0.5">{formatDuration(ticket.implementationTiming.activeDurationMs)}</p>
              </div>
            )}
            <div className="col-span-2">
              <span className="text-xs font-medium text-muted-foreground">Status</span>
              <div className="mt-0.5 flex items-center gap-2">
                <span className={ticket.status !== 'DRAFT' ? getStatusBadgeClasses(ticket.status).replace('bg-', 'text-').split(' ').filter(c => c.startsWith('text-')).join(' ') : ''}>
                  {statusLabel}
                </span>
                {ticket.status !== 'DRAFT' && workflowRingProgress !== null && (
                  <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                                                          <ProgressRing percent={workflowRingProgress.percent} colorClass={ringColor} />
                                                          <span className={ringColor}>{workflowRingProgress.percent}%</span>
                                                        </span>
                                        </TooltipTrigger>
                                        <TooltipContent className="max-w-xs text-center text-balance">{workflowRingProgress.label}</TooltipContent>
                                      </Tooltip>
                )}
              </div>
            </div>
            {(() => {
              const isDraft = ticket.status === 'DRAFT'
              const mainModel = isDraft ? profile?.mainImplementer ?? null : ticket.lockedMainImplementer
              const mainVariant = isDraft ? (profile?.mainImplementerVariant ?? null) : ticket.lockedMainImplementerVariant
              const rawCouncilVariants = isDraft
                ? profileCouncil.variants
                : (ticket.lockedCouncilMemberVariants ?? {})
              const rawMembers: string[] = isDraft ? profileCouncil.members : lockedCouncilMembers
              const otherMembers = (rawMembers.length > 0 && rawMembers[0] === mainModel) ? rawMembers.slice(1) : rawMembers
              if (!mainModel && otherMembers.length === 0) return null
              return (
                <div className="col-span-2 border-t-[4px] border-border pt-2 mt-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {isDraft ? 'Current Council' : 'Models Selected'}
                  </span>
                  <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                    {mainModel && (
                      <div className="flex justify-between items-center">
                        <div className="flex flex-col space-y-1">
                          <span>Main Implementer</span>
                          <span>Council Member A</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {mainVariant && <EffortBadge variant={mainVariant} />}
                          <span className="font-mono text-right">{mainModel}</span>
                        </div>
                      </div>
                    )}
                    {otherMembers.length > 0 && (
                      <>
                        <div className="my-2 border-t-[2px] border-border/70" />
                        {otherMembers.map((member, index) => (
                          <div key={member} className="flex justify-between">
                            <span>Council Member {String.fromCharCode(66 + index)}</span>
                            <div className="flex items-center gap-2">
                              {rawCouncilVariants[member] && <EffortBadge variant={rawCouncilVariants[member]} />}
                              <span className="font-mono">{member}</span>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              )
            })()}
            <div className="col-span-2 border-t-[2px] border-border/70 pt-2 mt-1">
              <span className="text-xs font-medium text-muted-foreground">Advanced Settings</span>
              <div className="mt-1 space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span>Manual QA checkpoint</span>
                  <Badge variant="outline" className="h-5 px-2 text-[10px] font-medium">
                    {ticket.effectiveManualQaEnabled === true ? 'Enabled' : 'Disabled'}
                  </Badge>
                </div>
                {/* Frozen once the ticket starts, so the source is worth naming. */}
                {typeof ticket.effectiveAiQuestionsEnabled === 'boolean' && (
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span>AI questions</span>
                    <span className="flex items-center gap-1.5">
                      <Badge variant="outline" className="h-5 px-2 text-[10px] font-medium">
                        {ticket.effectiveAiQuestionsEnabled ? 'On' : 'Off'}
                      </Badge>
                      {ticket.effectiveAiQuestionsSource && (
                        <span className="text-muted-foreground">from {describeSettingSource(ticket.effectiveAiQuestionsSource)}</span>
                      )}
                    </span>
                  </div>
                )}
                {typeof ticket.effectiveAiQuestionWindow === 'number' && (
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span>AI question wait</span>
                    <span className="flex items-center gap-1.5">
                      <Badge variant="outline" className="h-5 px-2 text-[10px] font-medium">
                        {formatAiQuestionWindow(ticket.effectiveAiQuestionWindow)}
                      </Badge>
                      {ticket.effectiveAiQuestionWindowSource && (
                        <span className="text-muted-foreground">from {describeSettingSource(ticket.effectiveAiQuestionWindowSource)}</span>
                      )}
                    </span>
                  </div>
                )}
              </div>
            </div>
            {ticket.branchName && (
              <div className="col-span-2 border-t-[4px] border-border pt-2 mt-1 flex items-start justify-between gap-6">
                <div className="min-w-0">
                  <span className="text-xs font-medium text-muted-foreground">Branch / Worktree</span>
                  <p className="font-mono mt-0.5 break-all">{ticket.branchName}</p>
                </div>
                <div className="shrink-0 text-right">
                  <span className="text-xs font-medium text-muted-foreground">Base Branch</span>
                  <p className="font-mono mt-0.5">{runtime.baseBranch}</p>
                </div>
              </div>
            )}
            {runtime.totalBeads > 0 && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Beads</span>
                <p className="mt-0.5">{runtime.completedBeads} / {runtime.totalBeads}</p>
              </div>
            )}
            {runtime.totalBeads > 0 && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Completion</span>
                <p className="mt-0.5">{Math.round(runtime.percentComplete)}%</p>
              </div>
            )}
            {runtime.eta && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Est. Remaining</span>
                <div className="mt-0.5"><EtaRange eta={runtime.eta} /></div>
              </div>
            )}
            {runtime.activeBeadIteration && runtime.activeBeadIteration > 0 && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Active Iteration</span>
                <p className="mt-0.5">
                  {runtime.activeBeadIteration}
                  {runtime.maxIterationsPerBead && runtime.maxIterationsPerBead > 0 ? ` / ${runtime.maxIterationsPerBead}` : ''}
                  {runtime.activeBeadId ? ` (${runtime.activeBeadId})` : ''}
                </p>
              </div>
            )}
            {!ticket.branchName && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Base Branch</span>
                <p className="font-mono mt-0.5">{runtime.baseBranch}</p>
              </div>
            )}
            {runtime.candidateCommitSha && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Candidate Commit</span>
                <p className="font-mono mt-0.5">{runtime.candidateCommitSha}</p>
              </div>
            )}
            {ticket.cleanup?.status && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">Cleanup</span>
                <div className="mt-1 flex items-center gap-2">
                  {ticket.cleanup.status === 'warning' && ticket.cleanup.errors && ticket.cleanup.errors.length > 0 ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex items-center gap-2 cursor-help select-none">
                          <Badge variant="destructive" className="capitalize">
                            {ticket.cleanup.status}
                          </Badge>
                          <span className="text-xs text-muted-foreground underline decoration-dotted">
                            {ticket.cleanup.errorCount} warning{ticket.cleanup.errorCount === 1 ? '' : 's'}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-md p-3 text-left">
                        <p className="font-semibold text-xs mb-1 text-foreground">Cleanup Warnings:</p>
                        <ul className="list-disc pl-4 space-y-1 text-xs font-mono max-h-48 overflow-y-auto">
                          {ticket.cleanup.errors.map((err, idx) => (
                            <li key={idx} className="break-all">{err}</li>
                          ))}
                        </ul>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <>
                      <Badge variant={ticket.cleanup.status === 'warning' ? 'destructive' : 'outline'} className="capitalize">
                        {ticket.cleanup.status}
                      </Badge>
                      {ticket.cleanup.status === 'warning' ? (
                        <span className="text-xs text-muted-foreground">
                          {ticket.cleanup.errorCount} warning{ticket.cleanup.errorCount === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            )}
            {ticket.errorMessage && (
              <ErrorBanner errorMessage={ticket.errorMessage} />
            )}
            {project && ticket.status !== 'DRAFT' && (
              <div className="col-span-2 border-t-[2px] border-border/70 pt-2 mt-1 flex flex-col gap-2.5">
                <CopyablePathRow label="Artifacts Location" path={runtime.artifactRoot || `${project.folderPath}/.looptroop/worktrees/${ticket.externalId}`} />
                <div className="bg-muted/30 border border-border/50 rounded-lg p-3 mt-1 shadow-inner relative overflow-hidden group">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                      Ticket Disk Space
                    </span>
                    {ticketSize !== null && (
                      <button
                        type="button"
                        onClick={handleCalculateSize}
                        disabled={isCalculatingSize}
                        className="text-xs text-muted-foreground hover:text-foreground font-medium transition-colors flex items-center gap-1.5 focus:outline-none"
                      >
                        <RotateCw className={`h-3 w-3 ${isCalculatingSize ? 'animate-spin' : ''}`} />
                        Recalculate
                      </button>
                    )}
                  </div>

                  {ticketSize === null ? (
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-[11px] text-muted-foreground leading-normal max-w-[340px]">
                        Calculate the exact size occupied on disk by this ticket's isolated git worktree, branches, artifacts, and execution logs.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        disabled={isCalculatingSize}
                        onClick={handleCalculateSize}
                        className="bg-primary text-primary-foreground hover:bg-primary/90 font-medium active:scale-[0.98] transition-all flex items-center gap-1.5 h-8 px-3.5 rounded-md text-xs shrink-0"
                      >
                        {isCalculatingSize ? (
                          <>
                            <RotateCw className="h-3.5 w-3.5 animate-spin" />
                            Calculating...
                          </>
                        ) : (
                          <>
                            <HardDrive className="h-3.5 w-3.5" />
                            Calculate Size
                          </>
                        )}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 py-0.5 animate-in fade-in slide-in-from-top-2 duration-300">
                      <div className="flex items-center gap-4">
                        <div className="p-2.5 bg-muted border border-border/80 rounded-lg shrink-0 flex items-center justify-center shadow-sm">
                          <HardDrive className="h-5 w-5 text-foreground animate-pulse" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-xl font-extrabold text-foreground font-mono leading-none tracking-tight">
                              {formatBytes(ticketSize)}
                            </span>
                            <span className="text-[9px] text-foreground bg-primary/10 border border-border px-1.5 py-0.5 rounded uppercase font-bold tracking-wider leading-none">
                              Occupied
                            </span>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-1 truncate">
                            Disk space occupied by worktree files, artifacts, and execution logs.
                          </p>
                        </div>
                      </div>

                      {sizeBreakdown && (
                        <div className="flex flex-col gap-2.5 mt-1 border-t border-border/40 pt-2.5">
                          {/* Segmented Disk Allocation Bar. A ticket that has written
                              nothing yet has a total of zero, and every segment divided
                              by it used to render `width: NaN%`. */}
                          <div className="h-2 w-full rounded-full bg-muted/60 overflow-hidden flex">
                            <div
                              style={{ width: `${ticketSize > 0 ? Math.max(0.5, (sizeBreakdown.source.total / ticketSize) * 100) : 0}%` }}
                              className="bg-primary h-full transition-all duration-500"
                              title={`Source Code: ${formatBytes(sizeBreakdown.source.total)}`}
                            />
                            <div
                              style={{ width: `${ticketSize > 0 ? Math.max(0.5, (sizeBreakdown.artifacts.total / ticketSize) * 100) : 0}%` }}
                              className="bg-muted-foreground/60 h-full transition-all duration-500"
                              title={`Phase Artifacts: ${formatBytes(sizeBreakdown.artifacts.total)}`}
                            />
                            <div
                              style={{ width: `${ticketSize > 0 ? Math.max(0.5, (sizeBreakdown.logs.total / ticketSize) * 100) : 0}%` }}
                              className="bg-muted-foreground/25 h-full transition-all duration-500"
                              title={`Execution Logs: ${formatBytes(sizeBreakdown.logs.total)}`}
                            />
                          </div>

                          {/* Legend & Stat Breakdown - Clickable to expand */}
                          <div className="grid grid-cols-3 gap-2 mt-1">
                            <button
                              type="button"
                              onClick={() => setExpandedSections(prev => ({ ...prev, source: !prev.source }))}
                              className={`flex flex-col text-left p-1.5 rounded border transition-all focus:outline-none ${
                                expandedSections['source']
                                  ? 'bg-primary/5 border-primary/50 ring-1 ring-primary/20 shadow-sm'
                                  : 'bg-muted/10 border-border/30 hover:bg-muted/40 hover:border-border/60'
                              }`}
                            >
                              <span className="text-[9px] font-semibold text-muted-foreground flex items-center gap-1">
                                <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                                Source Code
                              </span>
                              <span className="text-xs font-extrabold font-mono text-foreground mt-0.5 flex items-center gap-1 justify-between w-full">
                                {formatBytes(sizeBreakdown.source.total)}
                                {expandedSections['source'] ? (
                                  <ChevronDown className="h-3 w-3 text-primary shrink-0 transition-transform duration-200" />
                                ) : (
                                  <ChevronRight className="h-3 w-3 text-muted-foreground/60 shrink-0 transition-transform duration-200" />
                                )}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setExpandedSections(prev => ({ ...prev, artifacts: !prev.artifacts }))}
                              className={`flex flex-col text-left p-1.5 rounded border transition-all focus:outline-none ${
                                expandedSections['artifacts']
                                  ? 'bg-muted-foreground/5 border-muted-foreground/50 ring-1 ring-muted-foreground/20 shadow-sm'
                                  : 'bg-muted/10 border-border/30 hover:bg-muted/40 hover:border-border/60'
                              }`}
                            >
                              <span className="text-[9px] font-semibold text-muted-foreground flex items-center gap-1">
                                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 shrink-0" />
                                Phase Artifacts
                              </span>
                              <span className="text-xs font-extrabold font-mono text-foreground mt-0.5 flex items-center gap-1 justify-between w-full">
                                {formatBytes(sizeBreakdown.artifacts.total)}
                                {expandedSections['artifacts'] ? (
                                  <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0 transition-transform duration-200" />
                                ) : (
                                  <ChevronRight className="h-3 w-3 text-muted-foreground/60 shrink-0 transition-transform duration-200" />
                                )}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setExpandedSections(prev => ({ ...prev, logs: !prev.logs }))}
                              className={`flex flex-col text-left p-1.5 rounded border transition-all focus:outline-none ${
                                expandedSections['logs']
                                  ? 'bg-muted-foreground/5 border-muted-foreground/30 ring-1 ring-muted-foreground/10 shadow-sm'
                                  : 'bg-muted/10 border-border/30 hover:bg-muted/40 hover:border-border/60'
                              }`}
                            >
                              <span className="text-[9px] font-semibold text-muted-foreground flex items-center gap-1">
                                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/25 shrink-0" />
                                Execution Logs
                              </span>
                              <span className="text-xs font-extrabold font-mono text-foreground mt-0.5 flex items-center gap-1 justify-between w-full">
                                {formatBytes(sizeBreakdown.logs.total)}
                                {expandedSections['logs'] ? (
                                  <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0 transition-transform duration-200" />
                                ) : (
                                  <ChevronRight className="h-3 w-3 text-muted-foreground/60 shrink-0 transition-transform duration-200" />
                                )}
                              </span>
                            </button>
                          </div>

                          {/* Expanded breakdown list */}
                          {(expandedSections['source'] || expandedSections['artifacts'] || expandedSections['logs']) && (
                            <div className="mt-1.5 border border-border/40 rounded bg-muted/15 p-2 flex flex-col gap-2.5 max-h-[220px] overflow-y-auto divide-y divide-border/20 shadow-inner">
                              {expandedSections['source'] && (
                                <div className="flex flex-col gap-1.5 pb-2 last:pb-0 animate-in fade-in slide-in-from-top-1 duration-200">
                                  <div className="flex items-center gap-1.5 text-[9px] font-bold text-muted-foreground uppercase tracking-wider">
                                    <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                                    Source Code Files ({sizeBreakdown.source.children.length})
                                  </div>
                                  <div className="flex flex-col gap-0.5 pl-1.5">
                                    {sizeBreakdown.source.children.length === 0 ? (
                                      <div className="text-[10px] text-muted-foreground italic pl-1.5 py-1">No source files found</div>
                                    ) : (
                                      sizeBreakdown.source.children.map((child, index) => (
                                        <FileTreeNode key={index} node={child} />
                                      ))
                                    )}
                                  </div>
                                </div>
                              )}

                              {expandedSections['artifacts'] && (
                                <div className="flex flex-col gap-1.5 py-2 first:pt-0 last:pb-0 animate-in fade-in slide-in-from-top-1 duration-200">
                                  <div className="flex items-center gap-1.5 text-[9px] font-bold text-muted-foreground uppercase tracking-wider">
                                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 shrink-0" />
                                    Phase Artifacts ({sizeBreakdown.artifacts.children.length})
                                  </div>
                                  <div className="flex flex-col gap-0.5 pl-1.5">
                                    {sizeBreakdown.artifacts.children.length === 0 ? (
                                      <div className="text-[10px] text-muted-foreground italic pl-1.5 py-1">No artifacts found</div>
                                    ) : (
                                      sizeBreakdown.artifacts.children.map((child, index) => (
                                        <FileTreeNode key={index} node={child} />
                                      ))
                                    )}
                                  </div>
                                </div>
                              )}

                              {expandedSections['logs'] && (
                                <div className="flex flex-col gap-1.5 pt-2 last:pb-0 animate-in fade-in slide-in-from-top-1 duration-200">
                                  <div className="flex items-center gap-1.5 text-[9px] font-bold text-muted-foreground uppercase tracking-wider">
                                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/25 shrink-0" />
                                    Execution Logs ({sizeBreakdown.logs.children.length})
                                  </div>
                                  <div className="flex flex-col gap-0.5 pl-1.5">
                                    {sizeBreakdown.logs.children.length === 0 ? (
                                      <div className="text-[10px] text-muted-foreground italic pl-1.5 py-1">No logs found</div>
                                    ) : (
                                      sizeBreakdown.logs.children.map((child, index) => (
                                        <div key={index} className="flex items-center justify-between text-[11px] hover:bg-muted/40 px-2 py-0.5 rounded transition-colors group">
                                          <div className="flex items-center gap-1.5 min-w-0 text-muted-foreground">
                                            {child.isDirectory ? (
                                              <Folder className="h-3.5 w-3.5 text-foreground/75 shrink-0" />
                                            ) : (
                                              <File className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                                            )}
                                            <span className="truncate text-foreground font-mono" title={child.name}>
                                              {child.name}
                                            </span>
                                          </div>
                                          <span className="text-[10px] font-mono text-muted-foreground ml-2 shrink-0 group-hover:text-foreground transition-colors">
                                            {formatBytes(child.size)}
                                          </span>
                                        </div>
                                      ))
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {sizeError && (
                    <div className="mt-2 text-xs text-red-500 border-t border-red-500/20 pt-1.5 flex items-center gap-1.5 animate-in fade-in duration-200">
                      <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                      {sizeError}
                    </div>
                  )}
                </div>
              </div>
            )}
            {manualQaOrigin && (
              <div className="col-span-2 rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-blue-500/15 text-blue-700 hover:bg-blue-500/20 dark:text-blue-300">Manual QA Improvement</Badge>
                  <span className="text-xs text-muted-foreground">Round v{manualQaOrigin.sourceVersion}</span>
                </div>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Source ticket</dt><dd className="font-mono">{manualQaOrigin.sourceTicketExternalId ?? manualQaOrigin.sourceTicketId ?? 'Unknown'}</dd>
                  <dt className="text-muted-foreground">Checklist item{manualQaOrigin.sourceItemTitles.length > 1 ? 's' : ''}</dt><dd>{manualQaOrigin.sourceItemTitles.join(', ')}</dd>
                  <dt className="text-muted-foreground">Evidence</dt><dd>{manualQaOrigin.evidenceRefs.length} copied reference(s){manualQaOrigin.omittedEvidence.length > 0 ? `, ${manualQaOrigin.omittedEvidence.length} omitted` : ''}</dd>
                </dl>
                <p className="mt-2 text-[11px] text-muted-foreground">This provenance is shown for audit only. Future implementation prompts use this ticket&apos;s saved title and description.</p>
              </div>
            )}
            {ticket.description && (
              <CopyableDescription description={ticket.description} />
            )}
          </div>
          {isBottomFadeVisible && (
            <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-background to-transparent pointer-events-none" />
          )}
          </div>
        </DialogContent>
      </Dialog>

      <CancelTicketDialog ticketId={ticket.id} open={isCancelConfirmOpen} onOpenChange={setIsCancelConfirmOpen} />
    </div>
  )
}
