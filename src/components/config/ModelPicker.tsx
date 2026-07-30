import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Search, Zap, Eye, Wrench, Brain, AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DROPDOWN_MAX_HEIGHT, DROPDOWN_OFFSET, DROPDOWN_PADDING, DROPDOWN_FOCUS_DELAY_MS, DROPDOWN_Z_INDEX } from '@/lib/constants'
import { useOpenCodeModels, useAllOpenCodeModels } from '@/hooks/useOpenCodeModels'
import type { OpenCodeModel } from '@/hooks/useOpenCodeModels'

interface ModelPickerProps {
  value: string
  onChange: (modelFullId: string) => void
  placeholder?: string
  disabledValues?: string[]
}

function costLabel(input: number): { label: string; color: string } {
  if (input === 0) return { label: 'Free', color: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60' }
  if (input < 0.5) return { label: 'Cheap', color: 'text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-950/60' }
  if (input < 2) return { label: '$', color: 'text-amber-800 dark:text-amber-300 bg-yellow-50 dark:bg-amber-950/60' }
  if (input < 8) return { label: '$$', color: 'text-orange-800 dark:text-orange-300 bg-orange-50 dark:bg-orange-950/60' }
  return { label: '$$$', color: 'text-red-800 dark:text-red-300 bg-red-50 dark:bg-red-950/60' }
}

function ctxLabel(ctx: number): string {
  if (!ctx) return ''
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(0)}M`
  if (ctx >= 1_000) return `${(ctx / 1_000).toFixed(0)}K`
  return String(ctx)
}

function getModelQueryErrorCopy(error: unknown): { trigger: string; detail: string } {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('not reachable')) {
    return {
      trigger: 'OpenCode not reachable',
      detail: 'LoopTroop could not reach OpenCode. It starts automatically with npm run dev, so check that the OpenCode process launched successfully.',
    }
  }
  if (message.includes('model discovery failed') || message.includes('catalog')) {
    return {
      trigger: 'OpenCode connected, models unavailable',
      detail: 'LoopTroop reached OpenCode, but could not load its model catalog. Retry after OpenCode finishes starting or check the OpenCode server logs.',
    }
  }
  return {
    trigger: 'OpenCode models unavailable',
    detail: 'LoopTroop could not load models from OpenCode.',
  }
}

function ModelRow({ model, selected, disabled, onSelect }: {
  model: OpenCodeModel
  selected: boolean
  disabled?: boolean
  onSelect: () => void
}) {
  const cost = costLabel(model.costInput)
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        'w-full text-left px-3 py-2.5 flex items-start gap-3 transition-colors',
        'hover:bg-accent focus:bg-accent outline-none',
        selected && 'bg-primary/8',
        disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent focus:bg-transparent',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={cn('text-sm font-medium truncate', selected && 'text-primary')}>
            {model.name}
          </span>
          {selected && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground font-medium shrink-0">
              selected
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded-full', cost.color)}>
            {cost.label}
          </span>
          {model.contextWindow > 0 && (
            <span className="text-[10px] text-muted-foreground font-mono">
              {ctxLabel(model.contextWindow)} ctx
            </span>
          )}
          {model.canReason && (
            <span className="flex items-center gap-0.5 text-[10px] text-purple-600 dark:text-purple-400">
              <Brain className="h-2.5 w-2.5" aria-hidden="true" />reasoning
            </span>
          )}
          {model.canSeeImages && (
            <span className="flex items-center gap-0.5 text-[10px] text-blue-600 dark:text-blue-400">
              <Eye className="h-2.5 w-2.5" aria-hidden="true" />vision
            </span>
          )}
          {model.canUseTools && (
            <span className="flex items-center gap-0.5 text-[10px] text-slate-500 dark:text-slate-400">
              <Wrench className="h-2.5 w-2.5" aria-hidden="true" />tools
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

function ProviderGroup({
  providerName,
  models,
  value,
  disabledValues,
  onChange,
  onClose,
  query
}: {
  providerName: string
  models: OpenCodeModel[]
  value: string
  disabledValues: string[]
  onChange: (id: string) => void
  onClose: () => void
  query: string
}) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const hasQuery = query.trim().length > 0
  const wasSearchingRef = useRef(false)

  useEffect(() => {
    if (hasQuery && !wasSearchingRef.current) {
      setIsCollapsed(false)
    }
    wasSearchingRef.current = hasQuery
  }, [hasQuery])


  return (
    <div>
      <div 
        className="sticky top-0 z-10 bg-popover/95 backdrop-blur-sm px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-muted/50 transition-colors select-none border-b border-border/40"
        onClick={() => setIsCollapsed(c => !c)}
      >
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {providerName}
          <span className="ml-1.5 font-normal normal-case opacity-60">
            {models.length} {models.length === 1 ? 'model' : 'models'}
          </span>
        </div>
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground opacity-70 transition-transform', isCollapsed && '-rotate-90')} aria-hidden="true" />
      </div>
      {!isCollapsed && (
        <div className="flex flex-col">
          {models.map(m => (
            <ModelRow
              key={m.fullId}
              model={m}
              selected={m.fullId === value}
              disabled={m.fullId !== value && disabledValues.includes(m.fullId)}
              onSelect={() => {
                onChange(m.fullId)
                onClose()
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function ModelPicker({ value, onChange, placeholder = 'Search models…', disabledValues = [] }: ModelPickerProps) {
  const [isShowingAll, setIsShowingAll] = useState(false)
  const {
    data: connectedModels,
    isLoading: loadingConnected,
    isError: hasConnectedError,
    error: connectedError,
    isFetching: fetchingConnected,
  } = useOpenCodeModels()
  const {
    data: allModels,
    isLoading: loadingAll,
    isError: hasAllError,
    error: allError,
    isFetching: fetchingAll,
  } = useAllOpenCodeModels(isShowingAll)
  const models = isShowingAll ? allModels : connectedModels
  const isLoading = isShowingAll ? loadingAll : loadingConnected
  const isError = isShowingAll ? hasAllError : hasConnectedError
  const isFetching = isShowingAll ? fetchingAll : fetchingConnected
  const activeError = isShowingAll ? allError : connectedError
  const errorCopy = useMemo(() => getModelQueryErrorCopy(activeError), [activeError])
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [isShowingOnlyFree, setIsShowingOnlyFree] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownNodeRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const applyPosition = useCallback((node: HTMLDivElement) => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    node.style.position = 'fixed'
    node.style.left = `${rect.left}px`
    node.style.width = `${rect.width}px`
    node.style.zIndex = String(DROPDOWN_Z_INDEX)
    if (spaceAbove > spaceBelow) {
      node.style.bottom = `${window.innerHeight - rect.top + DROPDOWN_OFFSET}px`
      node.style.top = ''
      node.style.maxHeight = `${Math.min(DROPDOWN_MAX_HEIGHT, spaceAbove - DROPDOWN_PADDING)}px`
    } else {
      node.style.top = `${rect.bottom + DROPDOWN_OFFSET}px`
      node.style.bottom = ''
      node.style.maxHeight = `${Math.min(DROPDOWN_MAX_HEIGHT, spaceBelow - DROPDOWN_PADDING)}px`
    }
  }, [])

  const dropdownRef = useCallback((node: HTMLDivElement | null) => {
    dropdownNodeRef.current = node
    if (node) {
      applyPosition(node)
      setTimeout(() => inputRef.current?.focus(), DROPDOWN_FOCUS_DELAY_MS)
    }
  }, [applyPosition])

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (
        !containerRef.current?.contains(e.target as Node) &&
        !(e.target as Element)?.closest('[data-model-dropdown]')
      ) setIsOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  // Reposition on scroll/resize
  useEffect(() => {
    if (!isOpen) return
    const handler = () => { if (dropdownNodeRef.current) applyPosition(dropdownNodeRef.current) }
    window.addEventListener('scroll', handler, true)
    window.addEventListener('resize', handler)
    return () => {
      window.removeEventListener('scroll', handler, true)
      window.removeEventListener('resize', handler)
    }
  }, [isOpen, applyPosition])

  const cleanModelId = useCallback((id: string): string => {
    if (id && id.startsWith('openrouter/')) {
      return id.split(':')[0]!
    }
    return id
  }, [])

  const cleanValue = useMemo(() => cleanModelId(value), [value, cleanModelId])
  const cleanDisabledValues = useMemo(() => disabledValues.map(cleanModelId), [disabledValues, cleanModelId])

  const selected = models?.find(m => m.fullId === cleanValue) ?? allModels?.find(m => m.fullId === cleanValue) ?? connectedModels?.find(m => m.fullId === cleanValue)

  const filtered = useMemo(() => {
    if (!models) return []
    let result = models
    if (isShowingOnlyFree) {
      result = result.filter(m => m.costInput === 0)
    }
    const q = query.trim().toLowerCase()
    if (!q) return result
    return result.filter(m =>
      m.name.toLowerCase().includes(q) ||
      m.providerName.toLowerCase().includes(q) ||
      m.providerID.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.family.toLowerCase().includes(q)
    )
  }, [models, query, isShowingOnlyFree])

  // Group by provider
  const grouped = useMemo(() => {
    const groups = new Map<string, { providerName: string; models: OpenCodeModel[] }>()
    for (const m of filtered) {
      if (!groups.has(m.providerID)) {
        groups.set(m.providerID, { providerName: m.providerName, models: [] })
      }
      groups.get(m.providerID)!.models.push(m)
    }
    return Array.from(groups.entries())
  }, [filtered])

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="Pick a model"
        onClick={() => setIsOpen(v => !v)}
        className={cn(
          'w-full flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-2.5',
          'text-sm text-left transition-colors',
          'hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isOpen && 'border-ring ring-2 ring-ring',
        )}
      >
        {(isLoading || (isError && isFetching)) ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" aria-hidden="true" />
        ) : (
          <Zap className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
        )}
        <span className="flex-1 truncate">
          {isError && !isFetching ? (
            <span className="text-destructive text-xs">{errorCopy.trigger}</span>
          ) : isError && isFetching ? (
            <span className="text-muted-foreground text-xs">Connecting to OpenCode…</span>
          ) : selected ? (
            <>
              <span className="font-medium">{selected.name}</span>
              <span className="text-muted-foreground ml-1.5 text-xs">{selected.providerName}</span>
            </>
          ) : value ? (
            <span className="font-mono text-xs">{value}</span>
          ) : (
            <span className="text-muted-foreground">
              {isLoading ? 'Loading models…' : models && models.length === 0 ? 'No models available' : placeholder}
            </span>
          )}
        </span>
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground shrink-0 transition-transform', isOpen && 'rotate-180')} aria-hidden="true" />
      </button>

      {/* Dropdown — portaled to body to escape modal overflow */}
      {isOpen && createPortal(
        <div
          ref={dropdownRef}
          data-model-dropdown
          role="listbox"
          aria-label="Available models"
          className={cn(
            'rounded-lg border border-border bg-popover shadow-xl',
            'flex flex-col overflow-hidden',
          )}
        >
          {/* Search */}
          <div className="flex flex-col border-b border-border shrink-0">
            <div className="flex items-center gap-2 px-3 py-2">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by name, provider, family…"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                aria-label="Search models"
                autoComplete="off"
                spellCheck={false}
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                  className="text-muted-foreground hover:text-foreground text-xs"
                >
                  ✕
                </button>
              )}
            </div>
            <label className="flex items-center gap-2 px-3 pb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isShowingOnlyFree}
                onChange={e => setIsShowingOnlyFree(e.target.checked)}
                className="rounded border-input text-primary focus:ring-primary"
              />
              <span className="text-xs text-muted-foreground">Show free models only</span>
            </label>
          </div>

          {/* Results */}
          <div className="overflow-y-auto flex-1">
            {isError && !isFetching && (
              <div className="flex items-center gap-2 px-4 py-6 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {errorCopy.detail}
              </div>
            )}

            {(isLoading || (isError && isFetching)) && (
              <div className="flex items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {isError ? 'Connecting to OpenCode…' : 'Loading models from OpenCode…'}
              </div>
            )}

            {!isLoading && !isError && grouped.length === 0 && (
              <div className="px-4 py-6 text-sm text-muted-foreground text-center">
                {query
                  ? `No models match "${query}"`
                  : isShowingOnlyFree
                    ? 'No free models match the current filters.'
                    : 'OpenCode is connected, but no models are currently available.'}
              </div>
            )}

            {grouped.map(([providerID, { providerName, models: pModels }]) => (
              <ProviderGroup
                key={providerID}
                providerName={providerName}
                models={pModels}
                value={cleanValue}
                disabledValues={cleanDisabledValues}
                onChange={onChange}
                onClose={() => {
                  setIsOpen(false)
                  setQuery('')
                }}
                query={query}
              />
            ))}
          </div>

          {/* Show all providers toggle */}
          <label className="flex items-center gap-2 px-3 py-2 border-t border-border/40 cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={isShowingAll}
              onChange={e => setIsShowingAll(e.target.checked)}
              className="rounded border-input"
            />
            <span className="text-xs text-muted-foreground">
              Show all providers {allModels ? `(${allModels.length} models)` : ''} — currently showing {connectedModels?.length ?? 0} connected
            </span>
          </label>
        </div>,
        document.body
      )}
    </div>
  )
}
