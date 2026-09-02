import { useState, useMemo, useRef, useEffect, useCallback, Fragment, useId, type ReactNode } from 'react'
import { Copy, Check, ArrowUpToLine, ArrowDownToLine, ChartNoAxesCombined, LoaderCircle } from 'lucide-react'
import { LogCollapseToggle } from './LogCollapseToggle'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useLogs } from '@/context/useLogContext'
import type { LogEntry } from '@/context/LogContext'
import { compareTimestamps, getLogEntryIdentity, isDebugLogEntry, mergeEntriesBatch } from '@/context/logUtils'
import { getStatusUserLabel } from '@/lib/workflowMeta'
import { isTerminalWorkflowStatus } from '@shared/workflowMeta'
import { LoadingText } from '@/components/ui/LoadingText'
import { ModelBadge } from '@/components/shared/ModelBadge'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import type { Ticket } from '@/hooks/useTickets'
import { filterEntries, formatLogLine, getEntryFullModelId, MULTI_MODEL_PHASES, isSystem, isCommand } from './logFormat'
import { LogEntryRow } from './LogLine'
import { LogCountLabel, LogCountTooltip } from './LogCountLegend'
import { countLogTextLines } from './logCountUtils'
import { CurrentActivityStrip } from './CurrentActivityStrip'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { BeadDelimiter } from './logGrouping'
import { buildBeadSections } from './logGroupingHelpers'
import { useTicketHistoricalLogs, type HistoricalLogView } from '@/hooks/useTicketHistoricalLogs'
import { QueryErrorNotice } from '@/components/shared/QueryErrorNotice'
import { Virtuoso } from 'react-virtuoso'
import { useVirtualFirstItemIndex } from './logVirtualization'
import { AiDetailsSummary } from './AiDetailsSummary'
import { useTicketAiDetails } from '@/hooks/useTicketAiDetails'
import { LoadingRemainingLogsLine } from './LoadingRemainingLogsLine'
import { formatLogModelEffort, resolveLogModelEffort } from './logModelEffort'

interface PhaseLogPanelProps {
  phase: string
  logs?: LogEntry[]
  ticket?: Ticket
  phaseAttempt?: number
  logMode?: 'live' | 'snapshot'
  hideHeader?: boolean
  toolbarPrefix?: ReactNode
  onNaturalHeightChange?: (height: number) => void
  defaultTab?: string
}

type LogTab = 'ALL' | 'SYS' | 'AI' | 'ERROR' | 'DEBUG'

const FIXED_TABS: LogTab[] = ['ALL', 'SYS', 'AI', 'ERROR', 'DEBUG']
const BOTTOM_THRESHOLD = 50

function isAiLogTab(tab: string): boolean {
  return tab === 'AI' || (!FIXED_TABS.includes(tab as LogTab) && tab !== 'CMD')
}

const TAB_TOOLTIPS: Record<string, string> = {
  ALL: 'Shows system milestones, prompts, errors, and canonical AI outputs. This does not include absolutely all logs; check the other tabs for more details.',
  SYS: 'System background events and milestones for the orchestrator.',
  AI: 'Raw inputs (prompts), outputs, reasoning, and tool executions from AI models.',
  CMD: 'Shell commands executed during the phase, including git operations and build tools.',
  ERROR: 'Errors and exceptions encountered during execution.',
  DEBUG: 'Verbose internal debugging events and data.',
}

export function PhaseLogPanel({
  phase,
  logs: propLogs,
  ticket,
  phaseAttempt,
  logMode = 'live',
  hideHeader = false,
  toolbarPrefix,
  onNaturalHeightChange,
  defaultTab,
}: PhaseLogPanelProps) {
  const logCtx = useLogs()
  // Destructured so the load effects below depend on the one stable callback rather than
  // the context object, which is a new value on every streamed line: listing the context
  // made each arriving line re-request the page that line belongs to.
  const loadLogsForPhase = logCtx?.loadLogsForPhase
  const getLogsForPhase = logCtx?.getLogsForPhase
  const [activeTab, setActiveTab] = useState<string>(defaultTab ?? 'ALL')
  const [isAiDetailsOpen, setIsAiDetailsOpen] = useState(false)
  const aiDetailsPanelId = useId()
  const liveLogOptions = useMemo(
    () => (typeof phaseAttempt === 'number' && phaseAttempt > 0 ? { phaseAttempt } : undefined),
    [phaseAttempt],
  )
  const liveDebugLogOptions = useMemo(
    () => (typeof phaseAttempt === 'number' && phaseAttempt > 0
      ? { channel: 'debug' as const, phaseAttempt }
      : { channel: 'debug' as const }),
    [phaseAttempt],
  )
  const liveAiLogOptions = useMemo(
    () => (typeof phaseAttempt === 'number' && phaseAttempt > 0
      ? { channel: 'ai' as const, phaseAttempt }
      : { channel: 'ai' as const }),
    [phaseAttempt],
  )
  const liveNormalScope = useMemo(
    () => ({
      status: phase,
      ...(typeof phaseAttempt === 'number' && phaseAttempt > 0 ? { phaseAttempt } : {}),
    }),
    [phase, phaseAttempt],
  )
  const liveDebugScope = useMemo(
    () => ({
      status: phase,
      channel: 'debug' as const,
      ...(typeof phaseAttempt === 'number' && phaseAttempt > 0 ? { phaseAttempt } : {}),
    }),
    [phase, phaseAttempt],
  )
  const liveAiScope = useMemo(
    () => ({
      status: phase,
      channel: 'ai' as const,
      ...(typeof phaseAttempt === 'number' && phaseAttempt > 0 ? { phaseAttempt } : {}),
    }),
    [phase, phaseAttempt],
  )
  const shouldLoadHistoricalLogs = !propLogs && Boolean(ticket?.id)
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
    scope: 'phase',
    phase,
    phaseAttempt,
    view: historicalView,
    modelId: isAiLogTab(activeTab) && activeTab !== 'AI' ? activeTab : undefined,
  }, shouldLoadHistoricalLogs)

  useEffect(() => {
    if (propLogs || shouldLoadHistoricalLogs) return
    if (liveLogOptions) {
      loadLogsForPhase?.(phase, liveLogOptions)
    } else {
      loadLogsForPhase?.(phase)
    }
  }, [liveLogOptions, loadLogsForPhase, phase, propLogs, shouldLoadHistoricalLogs])

  useEffect(() => {
    if (shouldLoadHistoricalLogs || activeTab !== 'DEBUG') return
    loadLogsForPhase?.(phase, liveDebugLogOptions)
  }, [activeTab, liveDebugLogOptions, loadLogsForPhase, phase, shouldLoadHistoricalLogs])

  useEffect(() => {
    if (shouldLoadHistoricalLogs || !isAiLogTab(activeTab)) return
    loadLogsForPhase?.(phase, liveAiLogOptions)
  }, [activeTab, liveAiLogOptions, loadLogsForPhase, phase, shouldLoadHistoricalLogs])

  const isLoadingLogs = propLogs
    ? false
    : shouldLoadHistoricalLogs
      ? historicalLogs.isLoading
      : activeTab === 'DEBUG'
        ? (logCtx?.isLoadingLogScope?.(liveDebugScope) ?? false)
        : isAiLogTab(activeTab)
          ? ((logCtx?.isLoadingLogScope?.(liveNormalScope) ?? false) || (logCtx?.isLoadingLogScope?.(liveAiScope) ?? false))
          : (logCtx?.isLoadingLogScope?.(liveNormalScope) ?? (logCtx?.isLoadingLogs ?? false))
  const phaseLogs: LogEntry[] = useMemo(
    () => {
      if (propLogs) {
        if (activeTab !== 'DEBUG') return propLogs
        const debugEntries = (getLogsForPhase?.(phase, liveLogOptions) ?? []).filter((entry) => isDebugLogEntry(entry))
        const seenIdentities = new Set(propLogs.map(getLogEntryIdentity))
        return [
          ...propLogs,
          ...debugEntries.filter((entry) => !seenIdentities.has(getLogEntryIdentity(entry))),
        ].sort((a, b) => compareTimestamps(a.timestamp, b.timestamp))
      }
      if (shouldLoadHistoricalLogs) {
        if (logMode === 'snapshot') return historicalLogs.entries
        return mergeEntriesBatch(
          historicalLogs.entries,
          getLogsForPhase?.(phase, liveLogOptions) ?? [],
        )
      }
      return getLogsForPhase?.(phase, liveLogOptions) ?? []
    },
    [activeTab, getLogsForPhase, historicalLogs.entries, liveLogOptions, logMode, phase, propLogs, shouldLoadHistoricalLogs],
  )
  // A ticket that has finished is not running anything, so its last phase is not live
  // even though the panel's phase still matches its status — otherwise a cancelled or
  // completed ticket keeps a current-activity strip ticking over a run that ended.
  const isTerminalTicketStatus = isTerminalWorkflowStatus(ticket?.status)
  const isLiveTicketPhase = !ticket || (ticket.status === phase && !isTerminalTicketStatus)
  const currentActivityEnabled = logMode !== 'snapshot' && isLiveTicketPhase
  const hasToolbarPrefix = toolbarPrefix != null
  const [isModelsCollapsed, setIsModelsCollapsed] = useState(true)
  const [isSysCollapsed, setIsSysCollapsed] = useState(true)
  const isKnownMultiModelPhase = MULTI_MODEL_PHASES.has(phase)
  const lockedCouncilMembers = useMemo(
    () => ticket?.lockedCouncilMembers ?? [],
    [ticket?.lockedCouncilMembers],
  )

  const hasCmdLogs = useMemo(() => {
    return shouldLoadHistoricalLogs || phaseLogs.some((entry) => isSystem(entry) && isCommand(entry))
  }, [phaseLogs, shouldLoadHistoricalLogs])

  // ── Smart auto-scroll ──────────────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement>(null)
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null)
  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node
    setScrollParent(node)
  }, [])
  const contentRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const autoScrollEnabledRef = useRef(true)
  const previousViewRef = useRef<string | null>(null)
  const previousVisibleTailRef = useRef<string | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const olderPageAnchorRef = useRef<{ height: number; top: number } | null>(null)

  const scheduleScrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const scroll = () => {
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

  // Attach scroll listener directly on the viewport (scroll events don't bubble)
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
      if (allowPagination && atTop && shouldLoadHistoricalLogs && historicalLogs.hasOlder && !historicalLogs.isFetchingOlder) {
        if (phaseLogs.length <= 200) olderPageAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop }
        void historicalLogs.fetchOlder()
      }
    }
    // initialize on mount
    updateScrollState(false)
    const onScroll = () => updateScrollState(true)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [historicalLogs, phaseLogs.length, shouldLoadHistoricalLogs])

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

  const reportNaturalHeight = useCallback(() => {
    if (!onNaturalHeightChange) return

    const contentHeight = contentRef.current?.scrollHeight ?? 0
    const toolbarHeight = toolbarRef.current?.offsetHeight ?? 0
    const headerHeight = !hideHeader && !hasToolbarPrefix ? (headerRef.current?.offsetHeight ?? 0) : 0

    onNaturalHeightChange(contentHeight + toolbarHeight + headerHeight)
  }, [hasToolbarPrefix, hideHeader, onNaturalHeightChange])

  useEffect(() => {
    if (!onNaturalHeightChange) return

    reportNaturalHeight()

    const observer = new ResizeObserver(() => {
      reportNaturalHeight()
    })

    if (headerRef.current) observer.observe(headerRef.current)
    if (toolbarRef.current) observer.observe(toolbarRef.current)
    if (contentRef.current) observer.observe(contentRef.current)

    return () => observer.disconnect()
  }, [onNaturalHeightChange, reportNaturalHeight])

  const configuredModelIds = useMemo(() => {
    return lockedCouncilMembers.filter((memberId) => memberId.trim().length > 0)
  }, [lockedCouncilMembers])

  // Detect model IDs through the same identity the tab filter uses, so every tab this
  // builds has rows behind it.
  const detectedModelIds = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of phaseLogs) {
      const modelId = getEntryFullModelId(entry)
      if (modelId) ids.add(modelId)
    }
    return Array.from(ids)
  }, [phaseLogs])
  const observedModelVariants = useMemo(() => {
    const variants = new Map<string, string>()
    for (const entry of phaseLogs) {
      const modelId = getEntryFullModelId(entry)
      if (modelId && entry.variant) variants.set(modelId, entry.variant)
    }
    return variants
  }, [phaseLogs])
  const getModelEffort = useCallback(
    (modelId: string) => resolveLogModelEffort(ticket, modelId, observedModelVariants.get(modelId)),
    [observedModelVariants, ticket],
  )

  const modelTabs = useMemo(() => {
    const enableModelTabs = isKnownMultiModelPhase || detectedModelIds.length > 0
    if (!enableModelTabs) return []

    const seen = new Set<string>()
    const tabs: string[] = []
    const add = (id: string) => {
      if (!id || seen.has(id)) return
      seen.add(id)
      tabs.push(id)
    }

    if (isKnownMultiModelPhase) configuredModelIds.forEach(add)
    detectedModelIds.forEach(add)

    return tabs
  }, [isKnownMultiModelPhase, configuredModelIds, detectedModelIds])

  const singleModelTabId = !isKnownMultiModelPhase && modelTabs.length === 1 ? modelTabs[0]! : null
  const aiTabLabel = singleModelTabId ? `AI > ${getModelDisplayName(singleModelTabId)}` : 'AI'
  const hasModelTabs = modelTabs.length > 0 && !singleModelTabId
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
  const filteredLogs = filterEntries(phaseLogs, effectiveTab)
  const shouldShowModelNameInLogTags = effectiveTab === 'ALL' || effectiveTab === 'AI'
  const aiDetailsModelId = isAiLogTab(effectiveTab) && effectiveTab !== 'AI' ? effectiveTab : undefined
  const showAiDetails = Boolean(ticket?.id) && isAiLogTab(effectiveTab)
  const aiDetailsRequest = useMemo(() => ({
    scope: 'phase' as const,
    phase,
    ...(typeof phaseAttempt === 'number' ? { phaseAttempt } : {}),
    ...(aiDetailsModelId ? { modelId: aiDetailsModelId } : {}),
  }), [aiDetailsModelId, phase, phaseAttempt])
  const aiDetails = useTicketAiDetails(ticket?.id, aiDetailsRequest, showAiDetails && isAiDetailsOpen)

  // Keyed by attempt-scoped identity, not the bare entry id: a retried phase re-emits
  // its milestones under the same id, and this panel loads every attempt when it is not
  // given one, so bare ids alias two rows onto a single key, index and set entry.
  const visibleEntryIds = useMemo(
    () => new Set(filteredLogs.map(getLogEntryIdentity)),
    [filteredLogs],
  )

  const beadSectionsResult = useMemo(() => {
    if (phase !== 'CODING') return null
    return buildBeadSections(phaseLogs, visibleEntryIds, ticket)
  }, [phase, phaseLogs, visibleEntryIds, ticket])

  const hasBeadSections = beadSectionsResult !== null && beadSectionsResult.beadSections.length > 0
  const hasLogs = filteredLogs.length > 0
  const loadedTextLines = useMemo(() => countLogTextLines(filteredLogs), [filteredLogs])
  const totalTextLines = shouldLoadHistoricalLogs
    ? Math.max(loadedTextLines, historicalLogs.totalTextLines ?? loadedTextLines)
    : loadedTextLines
  const filteredIndexMap = useMemo(
    () => new Map(filteredLogs.map((entry, index) => [getLogEntryIdentity(entry), index])),
    [filteredLogs],
  )
  const virtualItems = useMemo(() => {
    const items: Array<
      | { type: 'entry'; key: string; entry: LogEntry }
      | { type: 'bead'; key: string; ordinal: number; total: number; title: string }
    > = []
    if (phase === 'CODING' && hasBeadSections && beadSectionsResult) {
      for (const entry of beadSectionsResult.preambleEntries) items.push({ type: 'entry', key: getLogEntryIdentity(entry), entry })
      for (const section of beadSectionsResult.beadSections) {
        items.push({ type: 'bead', key: `${section.beadId}-${section.ordinal}`, ordinal: section.ordinal, total: section.total, title: section.title })
        for (const entry of section.entries) items.push({ type: 'entry', key: getLogEntryIdentity(entry), entry })
      }
    } else {
      for (const entry of filteredLogs) items.push({ type: 'entry', key: getLogEntryIdentity(entry), entry })
    }
    return items
  }, [beadSectionsResult, filteredLogs, hasBeadSections, phase])
  const shouldVirtualize = virtualItems.length > 200
  const virtualFirstItemIndex = useVirtualFirstItemIndex(
    virtualItems.map(item => item.key),
    virtualItems.find(item => item.type === 'entry')?.key,
    `${phase}:${phaseAttempt ?? 'active'}:${effectiveTab}`,
  )
  const [copied, copyToClipboard] = useCopyToClipboard()
  const [isCopyingLogs, setIsCopyingLogs] = useState(false)
  const [copyLogsFailed, setCopyLogsFailed] = useState(false)
  const handleCopyLogs = useCallback(async () => {
    if (isCopyingLogs) return
    setIsCopyingLogs(true)
    setCopyLogsFailed(false)
    try {
      const textToCopy = shouldLoadHistoricalLogs
        ? await historicalLogs.exportLogs()
        : filteredLogs.map((entry) => {
            const ts = entry.timestamp ? `[${entry.timestamp}] ` : ''
            return `${ts}${formatLogLine(entry, shouldShowModelNameInLogTags).copyText}`
          }).join('\n')
      if (!textToCopy) return
      // The clipboard write reports refusal by returning false rather than throwing,
      // so the failure branch below covers the export only — both have to be checked
      // or a denied clipboard reads as a successful copy.
      if (!await copyToClipboard(textToCopy)) setCopyLogsFailed(true)
    } catch {
      setCopyLogsFailed(true)
    } finally {
      setIsCopyingLogs(false)
    }
  }, [copyToClipboard, filteredLogs, historicalLogs, isCopyingLogs, shouldLoadHistoricalLogs, shouldShowModelNameInLogTags])

  const visibleLogTail = useMemo(() => {
    const lastEntry = filteredLogs.at(-1)
    if (!lastEntry) return null
    return [
      filteredLogs.length,
      lastEntry.entryId,
      lastEntry.timestamp ?? '',
      lastEntry.line.length,
      lastEntry.streaming ? 'streaming' : 'static',
      lastEntry.op,
    ].join('|')
  }, [filteredLogs])
  // Pin the latest visible logs on mount/view changes, then keep following
  // the tail until the user scrolls away from the bottom.
  useEffect(() => {
    // A panel instance can be retained while the dashboard switches tickets.
    // Include the ticket identity so its first durable page is always revealed
    // instead of inheriting the prior ticket's manual scroll position.
    const currentView = `${ticket?.id ?? 'live'}:${phase}:${effectiveTab}`
    const viewChanged = previousViewRef.current !== currentView
    const visibleTailChanged = previousVisibleTailRef.current !== visibleLogTail
    const hadVisibleLogs = previousVisibleTailRef.current !== null

    if (viewChanged) {
      autoScrollEnabledRef.current = true
      queueMicrotask(() => setIsAutoScroll(true))
    }

    // An initially empty panel should always reveal its first durable/live
    // batch. After content exists, respect the user's scroll position.
    if (hasLogs && (viewChanged || !hadVisibleLogs || (visibleTailChanged && autoScrollEnabledRef.current))) {
      const behavior: ScrollBehavior = viewChanged || !hadVisibleLogs ? 'auto' : 'smooth'
      scheduleScrollToBottom(behavior)
    }

    previousViewRef.current = currentView
    previousVisibleTailRef.current = visibleLogTail
  }, [ticket?.id, phase, effectiveTab, hasLogs, visibleLogTail, scheduleScrollToBottom])

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      {!hideHeader && !hasToolbarPrefix && (
        <div ref={headerRef} className="px-1 py-1.5 flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Log — {getStatusUserLabel(phase, {
              currentBead: ticket?.runtime?.currentBead,
              totalBeads: ticket?.runtime?.totalBeads,
            })}
          </span>
        </div>
      )}
      <div ref={toolbarRef} className={cn(
        'flex px-1 py-1.5 items-center flex-wrap border-b border-border/30',
        hasToolbarPrefix ? 'gap-2' : 'gap-1',
      )}>
        {toolbarPrefix ? (
          <>
            {toolbarPrefix}
            <span className="text-xs text-muted-foreground shrink-0">—</span>
          </>
        ) : null}
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
                {!isModelsCollapsed && modelTabs.map(mTab => (
                  <ModelBadge
                    key={mTab}
                    modelId={mTab}
                    effort={getModelEffort(mTab)}
                    active={effectiveTab === mTab}
                    onClick={() => setActiveTab(mTab)}
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
                  loadedEntries={filteredLogs.length}
                  totalEntries={shouldLoadHistoricalLogs ? historicalLogs.totalEntries : filteredLogs.length}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" align="end" className="flex flex-col gap-1.5 p-2 bg-popover text-popover-foreground border border-border font-medium shadow-md">
              <LogCountTooltip
                loadedEntries={filteredLogs.length}
                totalEntries={shouldLoadHistoricalLogs ? historicalLogs.totalEntries : filteredLogs.length}
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
                              disabled={isCopyingLogs || (!shouldLoadHistoricalLogs && !hasLogs)}
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
      <CurrentActivityStrip
        entries={phaseLogs}
        enabled={currentActivityEnabled}
        activeStatus={ticket?.status ?? phase}
      />
      <div className="relative flex-1 min-h-0 flex flex-col">
        <ScrollArea className="flex-1 min-h-0 h-full" viewportRef={setViewportRef}>
          <div ref={contentRef} className="font-mono text-xs bg-muted/60 rounded-lg border border-border/30 p-3 min-h-[100px] w-full max-w-full">
            {showAiDetails && isAiDetailsOpen ? (
              <div id={aiDetailsPanelId} className="sticky top-0 z-20 bg-muted">
                <AiDetailsSummary
                  details={aiDetails.data}
                  isLoading={aiDetails.isLoading}
                  isError={aiDetails.isError}
                  isFetching={aiDetails.isFetching}
                  modelId={aiDetailsModelId}
                  scope="phase"
                  onRetry={() => void aiDetails.refetch()}
                />
              </div>
            ) : null}
            {historicalLogs.isFetchingOlder ? <LoadingRemainingLogsLine /> : null}
            {hasLogs ? (
              shouldVirtualize && scrollParent ? (
                <Virtuoso
                  data={virtualItems}
                  customScrollParent={scrollParent}
                  data-testid="virtualized-log-list"
                  firstItemIndex={virtualFirstItemIndex}
                  initialTopMostItemIndex={virtualItems.length - 1}
                  followOutput={isAutoScroll ? 'smooth' : false}
                  itemContent={(_, item) => item.type === 'bead'
                    ? <BeadDelimiter ordinal={item.ordinal} total={item.total} title={item.title} />
                    : (
                        <LogEntryRow
                          entry={item.entry}
                          index={filteredIndexMap.get(getLogEntryIdentity(item.entry)) ?? 0}
                          showModelName={shouldShowModelNameInLogTags}
                        />
                      )}
                />
              ) : phase === 'CODING' && hasBeadSections && beadSectionsResult ? (
                <>
                  {beadSectionsResult.preambleEntries.map((entry) => (
                    <LogEntryRow
                      key={getLogEntryIdentity(entry)}
                      entry={entry}
                      index={filteredIndexMap.get(getLogEntryIdentity(entry)) ?? 0}
                      showModelName={shouldShowModelNameInLogTags}
                    />
                  ))}
                  {beadSectionsResult.beadSections.map((section) => (
                    <Fragment key={`bead-${section.beadId}-${section.ordinal}`}>
                      <BeadDelimiter ordinal={section.ordinal} total={section.total} title={section.title} />
                      {section.entries.map((entry) => (
                        <LogEntryRow
                          key={getLogEntryIdentity(entry)}
                          entry={entry}
                          index={filteredIndexMap.get(getLogEntryIdentity(entry)) ?? 0}
                          showModelName={shouldShowModelNameInLogTags}
                        />
                      ))}
                    </Fragment>
                  ))}
                </>
              ) : (
                filteredLogs.map((entry, i) => (
                  <LogEntryRow key={getLogEntryIdentity(entry)} entry={entry} index={i} showModelName={shouldShowModelNameInLogTags} />
                ))
              )
            ) : isLoadingLogs ? (
              <span className="text-muted-foreground/50 italic">
                <LoadingText text="Loading logs" />
              </span>
            ) : historicalLogs.isError ? (
              <QueryErrorNotice
                title="The log history could not be loaded."
                error={historicalLogs.error}
                onRetry={() => void historicalLogs.refetch()}
              />
            ) : (
              <span className="text-muted-foreground/50 italic">
                {phaseLogs.length > 0 ? 'No entries match current filter.' : 'No log entries yet. Logs will stream here during execution.'}
              </span>
            )}
          </div>
        </ScrollArea>
        {hasLogs && !isAtTop && (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => viewportRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                className="absolute top-4 right-6 p-2 bg-background/30 hover:bg-background/90 backdrop-blur-md border border-border/50 hover:border-border rounded-full shadow-2xs hover:shadow-sm pointer-events-auto text-muted-foreground hover:text-foreground transition-all z-10 opacity-50 hover:opacity-100"
              >
                <ArrowUpToLine className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">Go to top</TooltipContent>
          </Tooltip>
        )}
        {hasLogs && !isAutoScroll && (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  autoScrollEnabledRef.current = true
                  setIsAutoScroll(true)
                  scheduleScrollToBottom('smooth')
                }}
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
