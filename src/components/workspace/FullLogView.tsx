import { useState, useMemo, useRef, useEffect, useCallback, Fragment, useId } from 'react'
import { Copy, Check, ScrollText, ArrowUpToLine, ArrowDownToLine, ChartNoAxesCombined, LoaderCircle } from 'lucide-react'
import { LogCollapseToggle } from './LogCollapseToggle'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useLogs } from '@/context/useLogContext'
import type { LogEntry } from '@/context/LogContext'
import { getStatusUserLabel, type StatusLabelOptions } from '@/lib/workflowMeta'
import { LoadingText } from '@/components/ui/LoadingText'
import type { Ticket } from '@/hooks/useTickets'
import { filterEntries, formatLogLine, isSystem, isCommand } from './logFormat'
import { LogEntryRow } from './LogLine'
import { LogCountLabel, LogCountTooltip } from './LogCountLegend'
import { countLogTextLines } from './logCountUtils'
import { ModelBadge } from '@/components/shared/ModelBadge'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { CurrentActivityStrip } from './CurrentActivityStrip'
import { BeadDelimiter } from './logGrouping'
import { buildBeadSections, type RenderedBeadSection } from './logGroupingHelpers'
import { useTicketHistoricalLogs, type HistoricalLogView } from '@/hooks/useTicketHistoricalLogs'
import { mergeEntriesBatch } from '@/context/logUtils'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useVirtualFirstItemIndex } from './logVirtualization'
import { AiDetailsSummary } from './AiDetailsSummary'
import { useTicketAiDetails } from '@/hooks/useTicketAiDetails'
import { LoadingRemainingLogsLine } from './LoadingRemainingLogsLine'
import { formatLogModelEffort, resolveLogModelEffort } from './logModelEffort'

type LogTab = 'ALL' | 'SYS' | 'AI' | 'ERROR' | 'DEBUG'

const FIXED_TABS: LogTab[] = ['ALL', 'SYS', 'AI', 'ERROR', 'DEBUG']
const BOTTOM_THRESHOLD = 50

function isAiLogTab(tab: string): boolean {
  return tab === 'AI' || (!FIXED_TABS.includes(tab as LogTab) && tab !== 'CMD')
}

const TAB_TOOLTIPS: Record<string, string> = {
  ALL: 'Shows system milestones, prompts, errors, and canonical AI outputs across all phases.',
  SYS: 'System background events and milestones for the orchestrator.',
  AI: 'Raw inputs (prompts), outputs, reasoning, and tool executions from AI models.',
  CMD: 'Shell commands executed during the ticket lifecycle, including git operations and build tools.',
  ERROR: 'Errors and exceptions encountered during execution.',
  DEBUG: 'Every log line from LoopTroop and OpenCode — system, AI, debug, and native OpenCode server logs. Loaded on demand.',
}

interface PhaseGroup {
  phase: string
  entries: LogEntry[]
}

interface RenderedPhaseGroup {
  phase: string
  entries: LogEntry[]
  preambleEntries?: LogEntry[]
  beadSections?: RenderedBeadSection[]
}

function groupByPhaseRuns(entries: LogEntry[]): PhaseGroup[] {
  if (entries.length === 0) return []

  const groups: PhaseGroup[] = []
  let currentPhase = entries[0]!.status
  let currentEntries: LogEntry[] = [entries[0]!]

  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.status !== currentPhase) {
      groups.push({ phase: currentPhase, entries: currentEntries })
      currentPhase = entry.status
      currentEntries = [entry]
    } else {
      currentEntries.push(entry)
    }
  }

  groups.push({ phase: currentPhase, entries: currentEntries })
  return groups
}

function PhaseDelimiter({ phase, labelOptions, label }: { phase: string; labelOptions?: StatusLabelOptions; label?: string }) {
  const resolvedLabel = label ?? getStatusUserLabel(phase, labelOptions)
  return (
    <div className="flex items-center gap-3 py-2 select-none" aria-label={`Phase: ${resolvedLabel}`}>
      <div className="flex-1 border-t border-border/60" />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 whitespace-nowrap">
        {resolvedLabel}
      </span>
      <div className="flex-1 border-t border-border/60" />
    </div>
  )
}

function buildRenderedPhaseGroups(
  phaseGroups: PhaseGroup[],
  visibleEntryIds: Set<string>,
  ticket?: Ticket,
): RenderedPhaseGroup[] {
  return phaseGroups.flatMap((group) => {
    if (group.phase !== 'CODING') {
      const entries = group.entries.filter((entry) => visibleEntryIds.has(entry.entryId))
      return entries.length > 0 ? [{ phase: group.phase, entries }] : []
    }

    const beadResult = buildBeadSections(group.entries, visibleEntryIds, ticket)
    if (!beadResult) {
      const entries = group.entries.filter((entry) => visibleEntryIds.has(entry.entryId))
      return entries.length > 0 ? [{ phase: group.phase, entries }] : []
    }

    const { preambleEntries, beadSections } = beadResult
    if (preambleEntries.length === 0 && beadSections.length === 0) {
      return []
    }

    return [{
      phase: group.phase,
      entries: [...preambleEntries, ...beadSections.flatMap((section) => section.entries)],
      preambleEntries,
      beadSections,
    }]
  })
}

interface FullLogViewProps {
  ticket?: Ticket
}

export function FullLogView({ ticket }: FullLogViewProps) {
  const logCtx = useLogs()
  const loadAllLogs = logCtx?.loadAllLogs
  const isLoadingLogScope = logCtx?.isLoadingLogScope

  const allLogs: LogEntry[] = useMemo(
    () => logCtx?.getAllLogs() ?? [],
    [logCtx],
  )

  const [activeTab, setActiveTab] = useState<string>('ALL')
  const [isAiDetailsOpen, setIsAiDetailsOpen] = useState(false)
  const aiDetailsPanelId = useId()
  const [isModelsCollapsed, setIsModelsCollapsed] = useState(true)
  const [isSysCollapsed, setIsSysCollapsed] = useState(true)
  const historicalView: HistoricalLogView = activeTab === 'ALL'
    ? 'overview'
    : activeTab === 'SYS'
      ? 'system'
      : activeTab === 'CMD'
        ? 'command'
        : activeTab === 'ERROR'
          ? 'error'
          : activeTab === 'DEBUG'
            ? 'debug'
            : 'ai'
  const historicalLogs = useTicketHistoricalLogs(ticket?.id, {
    scope: 'lifecycle',
    view: historicalView,
    modelId: isAiLogTab(activeTab) && activeTab !== 'AI' ? activeTab : undefined,
  }, Boolean(ticket?.id))
  const combinedLogs = useMemo(
    () => ticket?.id ? mergeEntriesBatch(historicalLogs.entries, allLogs) : allLogs,
    [allLogs, historicalLogs.entries, ticket?.id],
  )

  useEffect(() => {
    if (ticket?.id) return
    loadAllLogs?.()
  }, [loadAllLogs, ticket?.id])

  useEffect(() => {
    if (ticket?.id || activeTab !== 'DEBUG') return
    loadAllLogs?.({ channel: 'all' })
  }, [activeTab, loadAllLogs, ticket?.id])

  const hasCmdLogs = useMemo(() => {
    return Boolean(ticket?.id) || combinedLogs.some((entry) => isSystem(entry) && isCommand(entry))
  }, [combinedLogs, ticket?.id])

  const configuredModelIds = useMemo(() => {
    return (ticket?.lockedCouncilMembers ?? []).filter((memberId) => memberId.trim().length > 0)
  }, [ticket?.lockedCouncilMembers])

  const detectedModelIds = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of combinedLogs) {
      if (entry.modelId) {
        ids.add(entry.modelId)
        continue
      }
      if (entry.source.startsWith('model:')) {
        ids.add(entry.source.slice('model:'.length))
      }
    }
    return Array.from(ids)
  }, [combinedLogs])
  const observedModelVariants = useMemo(() => {
    const variants = new Map<string, string>()
    for (const entry of combinedLogs) {
      const modelId = entry.modelId ?? (entry.source.startsWith('model:') ? entry.source.slice('model:'.length) : undefined)
      if (modelId && entry.variant) variants.set(modelId, entry.variant)
    }
    return variants
  }, [combinedLogs])
  const getModelEffort = useCallback(
    (modelId: string) => resolveLogModelEffort(ticket, modelId, observedModelVariants.get(modelId)),
    [observedModelVariants, ticket],
  )

  const modelTabs = useMemo(() => {
    const seen = new Set<string>()
    const tabs: string[] = []
    const add = (id: string) => {
      if (!id || seen.has(id)) return
      seen.add(id)
      tabs.push(id)
    }

    configuredModelIds.forEach(add)
    detectedModelIds.forEach(add)

    return tabs
  }, [configuredModelIds, detectedModelIds])

  const singleModelTabId = modelTabs.length === 1 ? modelTabs[0]! : null
  const aiTabLabel = singleModelTabId ? `AI > ${getModelDisplayName(singleModelTabId)}` : 'AI'
  const hasModelTabs = modelTabs.length > 1
  const availableTabs: string[] = useMemo(() => {
    const tabs: string[] = [...FIXED_TABS]
    if (hasModelTabs) tabs.push(...modelTabs)
    if (hasCmdLogs) tabs.push('CMD')
    return tabs
  }, [hasModelTabs, modelTabs, hasCmdLogs])
  const effectiveTab = availableTabs.includes(activeTab)
    ? activeTab
    : singleModelTabId && activeTab === singleModelTabId
      ? 'AI'
      : 'ALL'
  const aiDetailsModelId = isAiLogTab(effectiveTab) && effectiveTab !== 'AI' ? effectiveTab : undefined
  const showAiDetails = Boolean(ticket?.id) && isAiLogTab(effectiveTab)
  const aiDetailsRequest = useMemo(() => ({
    scope: 'lifecycle' as const,
    ...(aiDetailsModelId ? { modelId: aiDetailsModelId } : {}),
  }), [aiDetailsModelId])
  const aiDetails = useTicketAiDetails(ticket?.id, aiDetailsRequest, showAiDetails && isAiDetailsOpen)

  useEffect(() => {
    if (ticket?.id || !isAiLogTab(effectiveTab)) return
    loadAllLogs?.({ channel: 'ai' })
  }, [effectiveTab, loadAllLogs, ticket?.id])

  const isLoadingLogs = ticket?.id ? historicalLogs.isLoading : effectiveTab === 'DEBUG'
    ? (isLoadingLogScope?.({ lifecycle: true, channel: 'all' }) ?? false)
    : isAiLogTab(effectiveTab)
      ? ((isLoadingLogScope?.({ lifecycle: true }) ?? false) || (isLoadingLogScope?.({ lifecycle: true, channel: 'ai' }) ?? false))
      : (isLoadingLogScope?.({ lifecycle: true }) ?? (logCtx?.isLoadingLogs ?? false))

  const filteredLogs = useMemo(
    () => filterEntries(combinedLogs, effectiveTab),
    [combinedLogs, effectiveTab],
  )

  const rawPhaseGroups = useMemo(
    () => groupByPhaseRuns(combinedLogs),
    [combinedLogs],
  )

  const visibleEntryIds = useMemo(
    () => new Set(filteredLogs.map((entry) => entry.entryId)),
    [filteredLogs],
  )

  const phaseGroups = useMemo(
    () => buildRenderedPhaseGroups(rawPhaseGroups, visibleEntryIds, ticket),
    [rawPhaseGroups, visibleEntryIds, ticket],
  )

  const renderedEntries = useMemo(
    () => phaseGroups.flatMap((group) => group.entries),
    [phaseGroups],
  )

  const hasLogs = renderedEntries.length > 0
  const loadedTextLines = useMemo(() => countLogTextLines(renderedEntries), [renderedEntries])
  const totalTextLines = ticket?.id
    ? Math.max(loadedTextLines, historicalLogs.totalTextLines ?? loadedTextLines)
    : loadedTextLines
  const isTerminalTicket = ticket?.status === 'COMPLETED' || ticket?.status === 'CANCELED'

  const beadLabelOptions: StatusLabelOptions | undefined = useMemo(() => {
    if (!ticket) return undefined
    return {
      currentBead: ticket.runtime.currentBead,
      totalBeads: ticket.runtime.totalBeads,
      errorMessage: ticket.errorMessage,
    }
  }, [ticket])

  // ── Smart auto-scroll ──────────────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement>(null)
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null)
  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node
    setScrollParent(node)
  }, [])
  const contentRef = useRef<HTMLDivElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const virtualItemCountRef = useRef(0)
  const autoScrollEnabledRef = useRef(true)
  const previousVisibleTailRef = useRef<string | null>(null)
  const previousViewRef = useRef<string | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const olderPageAnchorRef = useRef<{ height: number; top: number } | null>(null)
  const explicitTopNavigationRef = useRef(false)

  const scheduleScrollToBottom = useCallback((behavior: 'auto' | 'smooth') => {
    const scroll = () => {
      const virtualItemCount = virtualItemCountRef.current
      if (virtuosoRef.current && virtualItemCount > 0) {
        virtuosoRef.current.scrollToIndex({
          index: virtualItemCount - 1,
          align: 'end',
          behavior,
        })
        return
      }
      const el = viewportRef.current
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior })
    }

    if (behavior === 'auto') {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
      scroll()
      return
    }

    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      scroll()
    })
  }, [])

  const [isAutoScroll, setIsAutoScroll] = useState(true)
  const [isAtTop, setIsAtTop] = useState(true)

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const updateScrollState = (allowPagination: boolean) => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      const atBottom = distanceFromBottom <= BOTTOM_THRESHOLD
      autoScrollEnabledRef.current = atBottom
      setIsAutoScroll((prev) => (prev !== atBottom ? atBottom : prev))
      const atTop = el.scrollTop <= 50
      setIsAtTop((prev) => (prev !== atTop ? atTop : prev))
      if (allowPagination && atTop && historicalLogs.hasOlder && !historicalLogs.isFetchingOlder) {
        if (!explicitTopNavigationRef.current && renderedEntries.length <= 200) {
          olderPageAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop }
        }
        void historicalLogs.fetchOlder()
      }
    }
    updateScrollState(false)
    const onScroll = () => updateScrollState(true)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [historicalLogs, renderedEntries.length])

  useEffect(() => {
    const anchor = olderPageAnchorRef.current
    const el = viewportRef.current
    if (!anchor || !el || historicalLogs.isFetchingOlder) return
    // Older entries are prepended in chronological order. Keep the first row
    // that was already visible at the same screen position after the resize.
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height)
    olderPageAnchorRef.current = null
  }, [historicalLogs.entries.length, historicalLogs.isFetchingOlder])

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
    }
  }, [])

  useEffect(() => {
    const contentEl = contentRef.current
    if (!contentEl) return

    const observer = new ResizeObserver(() => {
      if (!autoScrollEnabledRef.current) return
      scheduleScrollToBottom('auto')
    })

    observer.observe(contentEl)
    return () => observer.disconnect()
  }, [scheduleScrollToBottom])

  const visibleLogTail = useMemo(() => {
    const lastEntry = renderedEntries.at(-1)
    if (!lastEntry) return null
    return [
      renderedEntries.length,
      lastEntry.entryId,
      lastEntry.timestamp ?? '',
      lastEntry.line.length,
      lastEntry.streaming ? 'streaming' : 'static',
      lastEntry.op,
    ].join('|')
  }, [renderedEntries])

  useEffect(() => {
    // Full Log remains mounted across ticket navigation. Treating a new ticket
    // as a new view resets tail-following for its initial durable log page.
    const currentView = `full-log:${ticket?.id ?? 'live'}:${effectiveTab}`
    const viewChanged = previousViewRef.current !== currentView
    const visibleTailChanged = previousVisibleTailRef.current !== visibleLogTail
    const hadVisibleLogs = previousVisibleTailRef.current !== null

    if (viewChanged) {
      autoScrollEnabledRef.current = true
      queueMicrotask(() => setIsAutoScroll(true))
    }

    if (hasLogs && (viewChanged || (visibleTailChanged && autoScrollEnabledRef.current))) {
      const behavior: 'auto' | 'smooth' = viewChanged || !hadVisibleLogs ? 'auto' : 'smooth'
      scheduleScrollToBottom(behavior)
    }

    previousViewRef.current = currentView
    previousVisibleTailRef.current = visibleLogTail
  }, [ticket?.id, effectiveTab, hasLogs, visibleLogTail, scheduleScrollToBottom])

  // ── Copy all logs ──────────────────────────────────────────────
  const [copied, copyToClipboard] = useCopyToClipboard()
  const [isCopyingLogs, setIsCopyingLogs] = useState(false)
  const [copyLogsFailed, setCopyLogsFailed] = useState(false)
  const handleCopyLogs = useCallback(async () => {
    if (isCopyingLogs) return
    setIsCopyingLogs(true)
    setCopyLogsFailed(false)
    try {
      const textToCopy = ticket?.id
        ? await historicalLogs.exportLogs()
        : renderedEntries.map((entry) => {
            const ts = entry.timestamp ? `[${entry.timestamp}] ` : ''
            return `${ts}[${entry.status}] ${formatLogLine(entry, true).copyText}`
          }).join('\n')
      if (!textToCopy) return
      await copyToClipboard(textToCopy)
    } catch {
      setCopyLogsFailed(true)
    } finally {
      setIsCopyingLogs(false)
    }
  }, [renderedEntries, copyToClipboard, historicalLogs, isCopyingLogs, ticket?.id])

  // ── Global entry index counter ──────────────────────────────────
  const globalIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    let idx = 0
    for (const entry of renderedEntries) {
      map.set(entry.entryId, idx++)
    }
    return map
  }, [renderedEntries])
  const virtualItems = useMemo(() => phaseGroups.flatMap((group, groupIndex) => {
    const items: Array<
      | { type: 'phase'; key: string; group: RenderedPhaseGroup }
      | { type: 'bead'; key: string; section: RenderedBeadSection }
      | { type: 'entry'; key: string; entry: LogEntry }
    > = [{ type: 'phase', key: `${group.phase}-${groupIndex}`, group }]
    if (group.phase === 'CODING' && group.beadSections !== undefined) {
      for (const entry of group.preambleEntries ?? []) items.push({ type: 'entry', key: entry.entryId, entry })
      for (const section of group.beadSections) {
        items.push({ type: 'bead', key: `${group.phase}-${groupIndex}-${section.beadId}-${section.ordinal}`, section })
        for (const entry of section.entries) items.push({ type: 'entry', key: entry.entryId, entry })
      }
    } else {
      for (const entry of group.entries) items.push({ type: 'entry', key: entry.entryId, entry })
    }
    return items
  }), [phaseGroups])
  const shouldVirtualize = virtualItems.length > 200
  virtualItemCountRef.current = virtualItems.length
  const virtualFirstItemIndex = useVirtualFirstItemIndex(
    virtualItems.map(item => item.key),
    virtualItems.find(item => item.type === 'entry')?.key,
    `full-log:${effectiveTab}`,
  )
  const [isNavigatingToTop, setIsNavigatingToTop] = useState(false)
  const handleGoToTop = useCallback(async () => {
    if (isNavigatingToTop) return
    explicitTopNavigationRef.current = true
    olderPageAnchorRef.current = null
    autoScrollEnabledRef.current = false
    setIsAutoScroll(false)
    setIsNavigatingToTop(true)
    try {
      await historicalLogs.fetchAllOlder()
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      if (virtuosoRef.current && virtualItemCountRef.current > 0) {
        virtuosoRef.current.scrollToIndex({ index: 0, align: 'start', behavior: 'auto' })
      } else {
        viewportRef.current?.scrollTo({ top: 0, behavior: 'auto' })
      }
    } finally {
      explicitTopNavigationRef.current = false
      setIsNavigatingToTop(false)
    }
  }, [historicalLogs, isNavigatingToTop])
  const handleGoToBottom = useCallback(() => {
    autoScrollEnabledRef.current = true
    setIsAutoScroll(true)
    const viewport = viewportRef.current
    if (!virtuosoRef.current && viewport) {
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    }
    scheduleScrollToBottom('auto')
    requestAnimationFrame(() => scheduleScrollToBottom('auto'))
  }, [scheduleScrollToBottom])

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-3">
        <div className="flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-mono font-medium text-foreground">Full Log</span>
          <span className="text-[11px] text-muted-foreground">— Complete ticket lifecycle</span>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex px-1 py-1.5 items-center flex-wrap gap-1 shrink-0 border-b border-border/30">
        {FIXED_TABS.map(tab => {
          const tooltipContent = TAB_TOOLTIPS[tab]

          if (tab === 'AI' && singleModelTabId) {
            const effort = getModelEffort(singleModelTabId)
            return (
              <Tooltip key={tab} delayDuration={300}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    title={`${singleModelTabId} · Effort: ${formatLogModelEffort(effort)}`}
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      'px-2 py-0.5 rounded-md text-xs font-mono font-medium shrink-0 transition-all',
                      effectiveTab === tab ? 'bg-muted/60 text-foreground border border-border/70 shadow-2xs' : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                    )}
                  >
                    {aiTabLabel}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs bg-popover text-popover-foreground border border-border shadow-md font-medium max-w-[200px] text-center">
                  <div>{tooltipContent}</div>
                  <div className="mt-1">{singleModelTabId} · Effort: {formatLogModelEffort(effort)}</div>
                </TooltipContent>
              </Tooltip>
            )
          }

          if (tab === 'AI' && hasModelTabs) {
            const isActive = effectiveTab === tab
            return (
              <Fragment key={tab}>
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <div
                      className={cn(
                        'flex items-center rounded-md text-xs font-mono font-medium shrink-0 transition-all',
                        isActive ? 'bg-muted/60 text-foreground border border-border/70 shadow-2xs' : 'text-muted-foreground hover:bg-muted/30'
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setActiveTab(tab)}
                        className="pl-2 pr-0.5 py-0.5 hover:text-foreground transition-colors"
                      >
                        {tab}
                      </button>
                      <LogCollapseToggle
                        isCollapsed={isModelsCollapsed}
                        onToggle={() => setIsModelsCollapsed(!isModelsCollapsed)}
                        showLabel="Show models"
                        hideLabel="Hide models"
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs bg-popover text-popover-foreground border border-border shadow-md font-medium max-w-[200px] text-center">
                    {tooltipContent}
                  </TooltipContent>
                </Tooltip>
                {!isModelsCollapsed && modelTabs.map((modelTab) => (
                  <ModelBadge
                    key={modelTab}
                    modelId={modelTab}
                    effort={getModelEffort(modelTab)}
                    active={effectiveTab === modelTab}
                    onClick={() => setActiveTab(modelTab)}
                    showIcon={false}
                  />
                ))}
              </Fragment>
            )
          }

          if (tab === 'SYS' && hasCmdLogs) {
            const isActive = effectiveTab === tab
            return (
              <Fragment key={tab}>
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <div
                      className={cn(
                        'flex items-center rounded-md text-xs font-mono font-medium shrink-0 transition-all',
                        isActive ? 'bg-muted/60 text-foreground border border-border/70 shadow-2xs' : 'text-muted-foreground hover:bg-muted/30'
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setActiveTab(tab)}
                        className="pl-2 pr-0.5 py-0.5 hover:text-foreground transition-colors"
                      >
                        {tab}
                      </button>
                      <LogCollapseToggle
                        isCollapsed={isSysCollapsed}
                        onToggle={() => setIsSysCollapsed(!isSysCollapsed)}
                        showLabel="Show commands"
                        hideLabel="Hide commands"
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs bg-popover text-popover-foreground border border-border shadow-md font-medium max-w-[200px] text-center">
                    {tooltipContent}
                  </TooltipContent>
                </Tooltip>
                {!isSysCollapsed && (
                  <Tooltip key="CMD" delayDuration={300}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setActiveTab('CMD')}
                        className="p-0 border-0 bg-transparent m-0 inline-flex"
                      >
                        <ModelBadge
                          modelId="CMD"
                          showIcon={false}
                          active={effectiveTab === 'CMD'}
                        >
                          CMD
                        </ModelBadge>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs bg-popover text-popover-foreground border border-border shadow-md font-medium max-w-[200px] text-center">
                      {TAB_TOOLTIPS.CMD}
                    </TooltipContent>
                  </Tooltip>
                )}
              </Fragment>
            )
          }

          return (
            <Tooltip key={tab} delayDuration={300}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    'px-2 py-0.5 rounded-md text-xs font-mono font-medium shrink-0 transition-all',
                    effectiveTab === tab ? 'bg-muted/60 text-foreground border border-border/70 shadow-2xs' : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                  )}
                >
                  {tab}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs bg-popover text-popover-foreground border border-border shadow-md font-medium max-w-[200px] text-center">
                {tooltipContent}
              </TooltipContent>
            </Tooltip>
          )
        })}
        <div className="ml-auto flex items-center pl-2 gap-2 text-xs text-muted-foreground">
          {showAiDetails ? (
            <button
              type="button"
              aria-expanded={isAiDetailsOpen}
              aria-controls={aiDetailsPanelId}
              onClick={() => setIsAiDetailsOpen(open => !open)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono transition-all',
                isAiDetailsOpen ? 'bg-muted/60 text-foreground border border-border/70 shadow-2xs' : 'hover:bg-muted/30 hover:text-foreground',
              )}
            >
              <ChartNoAxesCombined className="h-3.5 w-3.5" />
              {aiDetailsModelId ? 'Model details' : 'AI details'}
            </button>
          ) : null}
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex items-center cursor-help px-1 py-0.5 rounded-md hover:bg-muted/70 transition-all border-none bg-transparent m-0 focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <LogCountLabel
                  loadedEntries={renderedEntries.length}
                  totalEntries={ticket?.id ? historicalLogs.totalEntries : renderedEntries.length}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" align="end" className="flex flex-col gap-1.5 p-2 bg-popover text-popover-foreground border border-border font-medium shadow-md">
              <LogCountTooltip
                loadedEntries={renderedEntries.length}
                totalEntries={ticket?.id ? historicalLogs.totalEntries : renderedEntries.length}
                totalTextLines={totalTextLines}
              />
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex" tabIndex={isCopyingLogs ? 0 : undefined}>
                      <button
                              type="button"
                              aria-label="Copy all logs"
                              onClick={() => void handleCopyLogs()}
                              disabled={isCopyingLogs || (!ticket?.id && !hasLogs)}
                              className={cn(
                                'flex items-center justify-center p-1 rounded-md hover:bg-muted/70 hover:text-foreground transition-all disabled:opacity-50 disabled:cursor-not-allowed',
                                isCopyingLogs && 'pointer-events-none',
                              )}
                            >
                              {isCopyingLogs
                                ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
                                : copied
                                  ? <Check className="w-3.5 h-3.5 text-emerald-500" />
                                  : <Copy className="w-3.5 h-3.5" />}
                            </button>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-center text-balance">
              {isCopyingLogs
                ? 'Preparing complete log history…'
                : copyLogsFailed
                  ? 'Could not copy complete logs. Click to retry.'
                  : 'Copy all logs'}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Log content */}
      <CurrentActivityStrip
        entries={allLogs}
        enabled={!isTerminalTicket}
        activeStatus={ticket?.status ?? null}
      />
      <div className="relative flex-1 min-h-0 flex flex-col">
        <ScrollArea className="h-full flex-1 min-h-0" viewportRef={setViewportRef} type="always">
          <div ref={contentRef} className="font-mono text-xs bg-muted/60 rounded-lg border border-border/30 p-3 min-h-[100px] w-full max-w-full">
            {showAiDetails && isAiDetailsOpen ? (
              <div id={aiDetailsPanelId} className="sticky top-0 z-20 bg-muted">
                <AiDetailsSummary
                  details={aiDetails.data}
                  isLoading={aiDetails.isLoading}
                  isError={aiDetails.isError}
                  isFetching={aiDetails.isFetching}
                  modelId={aiDetailsModelId}
                  scope="lifecycle"
                  onRetry={() => void aiDetails.refetch()}
                />
              </div>
            ) : null}
            {historicalLogs.isFetchingOlder || isNavigatingToTop ? <LoadingRemainingLogsLine /> : null}
            {hasLogs ? (
              shouldVirtualize && scrollParent ? (
                <Virtuoso
                  ref={virtuosoRef}
                  data={virtualItems}
                  customScrollParent={scrollParent}
                  data-testid="virtualized-log-list"
                  firstItemIndex={virtualFirstItemIndex}
                  initialTopMostItemIndex={virtualItems.length - 1}
                  followOutput={isAutoScroll ? 'smooth' : false}
                  itemContent={(_, item) => item.type === 'phase'
                    ? (
                        <PhaseDelimiter
                          phase={item.group.phase}
                          label={item.group.phase === 'CODING' ? 'Implementing' : undefined}
                          labelOptions={item.group.phase === 'BLOCKED_ERROR' ? beadLabelOptions : undefined}
                        />
                      )
                    : item.type === 'bead'
                      ? <BeadDelimiter ordinal={item.section.ordinal} total={item.section.total} title={item.section.title} qaOrigin={item.section.qaOrigin} />
                      : <LogEntryRow entry={item.entry} index={globalIndexMap.get(item.entry.entryId) ?? 0} showModelName />}
                />
              ) : phaseGroups.map((group, groupIdx) => (
                <Fragment key={`${group.phase}-${groupIdx}`}>
                  <PhaseDelimiter
                    phase={group.phase}
                    label={group.phase === 'CODING' ? 'Implementing' : undefined}
                    labelOptions={group.phase === 'BLOCKED_ERROR' ? beadLabelOptions : undefined}
                  />
                  {group.phase === 'CODING' && group.beadSections !== undefined ? (
                    <>
                      {(group.preambleEntries ?? []).map((entry) => (
                        <LogEntryRow
                          key={entry.entryId}
                          entry={entry}
                          index={globalIndexMap.get(entry.entryId) ?? 0}
                          showModelName={true}
                        />
                      ))}
                      {group.beadSections.map((section) => (
                        <Fragment key={`${group.phase}-${groupIdx}-${section.beadId}-${section.ordinal}`}>
                          <BeadDelimiter ordinal={section.ordinal} total={section.total} title={section.title} qaOrigin={section.qaOrigin} />
                          {section.entries.map((entry) => (
                            <LogEntryRow
                              key={entry.entryId}
                              entry={entry}
                              index={globalIndexMap.get(entry.entryId) ?? 0}
                              showModelName={true}
                            />
                          ))}
                        </Fragment>
                      ))}
                    </>
                  ) : (
                    group.entries.map((entry) => (
                      <LogEntryRow
                        key={entry.entryId}
                        entry={entry}
                        index={globalIndexMap.get(entry.entryId) ?? 0}
                        showModelName={true}
                      />
                    ))
                  )}
                </Fragment>
              ))
            ) : isLoadingLogs ? (
              <span className="text-muted-foreground/50 italic">
                <LoadingText text="Loading logs" />
              </span>
            ) : (
              <span className="text-muted-foreground/50 italic">
                No log entries yet. Logs will appear here as the ticket progresses through its lifecycle.
              </span>
            )}
          </div>
        </ScrollArea>
        {hasLogs && !isAtTop && (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Go to top"
                onClick={() => void handleGoToTop()}
                disabled={isNavigatingToTop}
                className="absolute top-4 right-6 p-2 bg-background/30 hover:bg-background/90 backdrop-blur-md border border-border/50 hover:border-border rounded-full shadow-2xs hover:shadow-sm pointer-events-auto text-muted-foreground hover:text-foreground transition-all z-10 opacity-50 hover:opacity-100"
              >
                {isNavigatingToTop
                  ? <LoaderCircle className="w-4 h-4 animate-spin" />
                  : <ArrowUpToLine className="w-4 h-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">
              {isNavigatingToTop ? 'Loading complete history…' : 'Go to top'}
            </TooltipContent>
          </Tooltip>
        )}
        {hasLogs && !isAutoScroll && (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Back to bottom"
                onClick={handleGoToBottom}
                className="absolute bottom-4 right-6 p-2 bg-background/30 hover:bg-background/90 backdrop-blur-md border border-border/50 hover:border-border rounded-full shadow-2xs hover:shadow-sm pointer-events-auto text-muted-foreground hover:text-foreground transition-all z-10 opacity-50 hover:opacity-100"
              >
                <ArrowDownToLine className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">Back to bottom</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
