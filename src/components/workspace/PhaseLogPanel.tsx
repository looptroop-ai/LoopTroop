import { useState, useMemo, useRef, useEffect, useCallback, Fragment, type ReactNode } from 'react'
import { Copy, Check, ArrowUpToLine, ArrowDownToLine } from 'lucide-react'
import { LogCollapseToggle } from './LogCollapseToggle'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useLogs } from '@/context/useLogContext'
import type { LogEntry } from '@/context/LogContext'
import { compareTimestamps, isDebugLogEntry } from '@/context/logUtils'
import { getStatusUserLabel } from '@/lib/workflowMeta'
import { LoadingText } from '@/components/ui/LoadingText'
import { ModelBadge } from '@/components/shared/ModelBadge'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import type { Ticket } from '@/hooks/useTickets'
import { filterEntries, formatLogLine, MULTI_MODEL_PHASES, isSystem, isCommand } from './logFormat'
import { LogEntryRow } from './LogLine'
import { LogColorLegend } from './LogColorLegend'
import { CurrentActivityStrip } from './CurrentActivityStrip'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { BeadDelimiter } from './logGrouping'
import { buildBeadSections } from './logGroupingHelpers'
import { useTicketHistoricalLogs, type HistoricalLogView } from '@/hooks/useTicketHistoricalLogs'

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
  const [activeTab, setActiveTab] = useState<string>(defaultTab ?? 'ALL')
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
  const shouldLoadArchivedLogs = logMode === 'snapshot' && Boolean(ticket?.id) && typeof phaseAttempt === 'number' && phaseAttempt > 0
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
  }, shouldLoadArchivedLogs)

  useEffect(() => {
    if (propLogs || shouldLoadArchivedLogs) return
    if (liveLogOptions) {
      logCtx?.loadLogsForPhase?.(phase, liveLogOptions)
    } else {
      logCtx?.loadLogsForPhase?.(phase)
    }
  }, [liveLogOptions, logCtx, phase, propLogs, shouldLoadArchivedLogs])

  useEffect(() => {
    if (shouldLoadArchivedLogs || activeTab !== 'DEBUG') return
    logCtx?.loadLogsForPhase?.(phase, liveDebugLogOptions)
  }, [activeTab, liveDebugLogOptions, logCtx, phase, shouldLoadArchivedLogs])

  useEffect(() => {
    if (shouldLoadArchivedLogs || !isAiLogTab(activeTab)) return
    logCtx?.loadLogsForPhase?.(phase, liveAiLogOptions)
  }, [activeTab, liveAiLogOptions, logCtx, phase, shouldLoadArchivedLogs])

  const isLoadingLogs = propLogs
    ? false
    : shouldLoadArchivedLogs
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
        const debugEntries = (logCtx?.getLogsForPhase(phase, liveLogOptions) ?? []).filter((entry) => isDebugLogEntry(entry))
        const seenEntryIds = new Set(propLogs.map((entry) => entry.entryId))
        return [
          ...propLogs,
          ...debugEntries.filter((entry) => !seenEntryIds.has(entry.entryId)),
        ].sort((a, b) => compareTimestamps(a.timestamp, b.timestamp))
      }
      if (shouldLoadArchivedLogs) {
        return historicalLogs.entries
      }
      return logCtx?.getLogsForPhase(phase, liveLogOptions) ?? []
    },
    [activeTab, historicalLogs.entries, liveLogOptions, logCtx, phase, propLogs, shouldLoadArchivedLogs],
  )
  const isLiveTicketPhase = !ticket || ticket.status === phase
  const currentActivityEnabled = !shouldLoadArchivedLogs && isLiveTicketPhase
  const hasToolbarPrefix = toolbarPrefix != null
  const [isModelsCollapsed, setIsModelsCollapsed] = useState(true)
  const [isSysCollapsed, setIsSysCollapsed] = useState(true)
  const isKnownMultiModelPhase = MULTI_MODEL_PHASES.has(phase)
  const lockedCouncilMembers = useMemo(
    () => ticket?.lockedCouncilMembers ?? [],
    [ticket?.lockedCouncilMembers],
  )

  const hasCmdLogs = useMemo(() => {
    return phaseLogs.some((entry) => isSystem(entry) && isCommand(entry))
  }, [phaseLogs])

  // ── Smart auto-scroll ──────────────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const autoScrollEnabledRef = useRef(true)
  const previousViewRef = useRef<string | null>(null)
  const previousVisibleTailRef = useRef<string | null>(null)
  const scrollFrameRef = useRef<number | null>(null)

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
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      const atBottom = distanceFromBottom <= BOTTOM_THRESHOLD
      autoScrollEnabledRef.current = atBottom
      setIsAutoScroll((prev) => (prev !== atBottom ? atBottom : prev))
      const atTop = el.scrollTop <= 50
      setIsAtTop((prev) => (prev !== atTop ? atTop : prev))
      if (atTop && shouldLoadArchivedLogs && historicalLogs.hasOlder && !historicalLogs.isFetchingOlder) {
        // React Query prepends the older page and the browser keeps the
        // viewport anchored to the already rendered content.
        void historicalLogs.fetchOlder()
      }
    }
    // initialize on mount
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [historicalLogs, shouldLoadArchivedLogs])

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

  // Detect model IDs from structured source field
  const detectedModelIds = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of phaseLogs) {
      if (entry.modelId) {
        ids.add(entry.modelId)
        continue
      }
      if (entry.source.startsWith('model:')) {
        ids.add(entry.source.slice('model:'.length))
      }
    }
    return Array.from(ids)
  }, [phaseLogs])

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

  const visibleEntryIds = useMemo(
    () => new Set(filteredLogs.map((entry) => entry.entryId)),
    [filteredLogs],
  )

  const beadSectionsResult = useMemo(() => {
    if (phase !== 'CODING') return null
    return buildBeadSections(phaseLogs, visibleEntryIds, ticket)
  }, [phase, phaseLogs, visibleEntryIds, ticket])

  const hasBeadSections = beadSectionsResult !== null && beadSectionsResult.beadSections.length > 0
  const hasLogs = filteredLogs.length > 0
  const [copied, copyToClipboard] = useCopyToClipboard()
  const handleCopyLogs = useCallback(() => {
    if (shouldLoadArchivedLogs) {
      void historicalLogs.exportLogs().then(copyToClipboard).catch(() => undefined)
      return
    }
    if (!filteredLogs.length) return
    const textToCopy = filteredLogs.map((entry) => {
      const ts = entry.timestamp ? `[${entry.timestamp}] ` : ''
      return `${ts}${formatLogLine(entry, shouldShowModelNameInLogTags).copyText}`
    }).join('\n')
    copyToClipboard(textToCopy)
  }, [copyToClipboard, filteredLogs, historicalLogs, shouldLoadArchivedLogs, shouldShowModelNameInLogTags])

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
    const currentView = `${phase}:${effectiveTab}`
    const viewChanged = previousViewRef.current !== currentView
    const visibleTailChanged = previousVisibleTailRef.current !== visibleLogTail
    const hadVisibleLogs = previousVisibleTailRef.current !== null

    if (viewChanged) {
      autoScrollEnabledRef.current = true
      queueMicrotask(() => setIsAutoScroll(true))
    }

    if (hasLogs && (viewChanged || (visibleTailChanged && autoScrollEnabledRef.current))) {
      const behavior: ScrollBehavior = viewChanged || !hadVisibleLogs ? 'auto' : 'smooth'
      scheduleScrollToBottom(behavior)
    }

    previousViewRef.current = currentView
    previousVisibleTailRef.current = visibleLogTail
  }, [phase, effectiveTab, hasLogs, visibleLogTail, scheduleScrollToBottom])

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
        'flex px-1 py-1 items-center flex-wrap',
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
            return (
              <Tooltip key={tab} delayDuration={300}>
                <TooltipTrigger asChild>
                  <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                                            type="button"
                                            onClick={() => setActiveTab(tab)}
                                            className={cn(
                                              'px-2 py-0.5 rounded text-xs font-medium shrink-0',
                                              effectiveTab === tab ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
                                            )}
                                          >
                                            {aiTabLabel}
                                          </button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-center text-balance">{singleModelTabId}</TooltipContent>
                        </Tooltip>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs bg-popover text-popover-foreground border border-border shadow-md font-medium max-w-[200px] text-center">
                  {tooltipContent}
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
                        'flex items-center rounded text-xs font-medium shrink-0 transition-colors',
                        isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
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
                        'flex items-center rounded text-xs font-medium shrink-0 transition-colors',
                        isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
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
                    'px-2 py-0.5 rounded text-xs font-medium shrink-0',
                    effectiveTab === tab ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
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
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex items-center cursor-help px-1 py-0.5 rounded hover:bg-muted transition-colors border-none bg-transparent m-0 focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <span>{filteredLogs.length} entries</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" align="end" className="flex flex-col gap-1.5 p-2 bg-popover text-popover-foreground border border-border font-medium shadow-md">
              <LogColorLegend />
            </TooltipContent>
          </Tooltip>
          <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                              type="button"
                              aria-label="Copy all logs"
                              onClick={handleCopyLogs}
                              disabled={!hasLogs}
                              className="flex items-center justify-center p-1 rounded hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs text-center text-balance">Copy all logs</TooltipContent>
                  </Tooltip>
        </div>
      </div>
      <CurrentActivityStrip
        entries={phaseLogs}
        enabled={currentActivityEnabled}
        activeStatus={ticket?.status ?? phase}
      />
      <div className="relative flex-1 min-h-0 flex flex-col">
        <ScrollArea className="flex-1 min-h-0 h-full" viewportRef={viewportRef}>
          <div ref={contentRef} className="font-mono text-xs bg-muted rounded-md p-3 min-h-[100px] w-full max-w-full">
            {hasLogs ? (
              phase === 'CODING' && hasBeadSections && beadSectionsResult ? (
                <>
                  {beadSectionsResult.preambleEntries.map((entry) => (
                    <LogEntryRow
                      key={entry.entryId}
                      entry={entry}
                      index={filteredLogs.findIndex((e) => e.entryId === entry.entryId)}
                      showModelName={shouldShowModelNameInLogTags}
                    />
                  ))}
                  {beadSectionsResult.beadSections.map((section) => (
                    <Fragment key={`bead-${section.beadId}-${section.ordinal}`}>
                      <BeadDelimiter ordinal={section.ordinal} total={section.total} title={section.title} />
                      {section.entries.map((entry) => (
                        <LogEntryRow
                          key={entry.entryId}
                          entry={entry}
                          index={filteredLogs.findIndex((e) => e.entryId === entry.entryId)}
                          showModelName={shouldShowModelNameInLogTags}
                        />
                      ))}
                    </Fragment>
                  ))}
                </>
              ) : (
                filteredLogs.map((entry, i) => (
                  <LogEntryRow key={entry.entryId} entry={entry} index={i} showModelName={shouldShowModelNameInLogTags} />
                ))
              )
            ) : isLoadingLogs ? (
              <span className="text-muted-foreground/50 italic">
                <LoadingText text="Loading logs" />
              </span>
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
                className="absolute top-4 right-6 p-2 bg-background/20 hover:bg-background backdrop-blur-sm border border-border/40 hover:border-border rounded-full shadow-sm hover:shadow pointer-events-auto text-muted-foreground hover:text-foreground transition-all z-10 opacity-40 hover:opacity-100"
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
                className="absolute bottom-4 right-6 p-2 bg-background/20 hover:bg-background backdrop-blur-sm border border-border/40 hover:border-border rounded-full shadow-sm hover:shadow pointer-events-auto text-muted-foreground hover:text-foreground transition-all z-10 opacity-40 hover:opacity-100"
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
