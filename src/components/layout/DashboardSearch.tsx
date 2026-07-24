import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useUI } from '@/context/useUI'
import { useProjects } from '@/hooks/useProjects'
import { cn } from '@/lib/utils'

interface DashboardSearchProps {
  isModalOpen?: boolean
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT'
    || target.isContentEditable
    || Boolean(target.closest('[role="textbox"]'))
  )
}

function normalizePrefix(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function focusOnNextFrame(callback: () => void) {
  const frame = window.requestAnimationFrame ?? ((cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0))
  frame(callback)
}

function DashboardSearchInput({
  id,
  value,
  suggestions,
  isDisabled,
  className,
  inputRef,
  onChange,
  onClear,
  onSuggestionSelect,
  onEscapeWithEmptyQuery,
}: {
  id: string
  value: string
  suggestions: string[]
  isDisabled: boolean
  className?: string
  inputRef: RefObject<HTMLInputElement | null>
  onChange: (value: string) => void
  onClear: () => void
  onSuggestionSelect: (value: string) => void
  onEscapeWithEmptyQuery?: () => void
}) {
  const [isFocused, setIsFocused] = useState(false)
  const trimmedValue = value.trim()
  const hasValue = trimmedValue.length > 0
  const shouldShowSuggestions = isFocused && hasValue && suggestions.length > 0

  return (
    <div className={cn('relative min-w-0', className)}>
      <label htmlFor={id} className="sr-only">Search tickets</label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="searchbox"
        value={value}
        disabled={isDisabled}
        placeholder="Search"
        autoComplete="off"
        onFocus={() => setIsFocused(true)}
        onBlur={() => {
          window.setTimeout(() => setIsFocused(false), 100)
        }}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          if (hasValue) {
            onClear()
          } else {
            onEscapeWithEmptyQuery?.()
          }
        }}
        className="h-8.5 w-full rounded-lg border border-border/60 bg-muted/40 py-1.5 pl-3.5 pr-14 text-xs font-medium text-foreground shadow-xs outline-none transition-all placeholder:text-muted-foreground/70 hover:bg-muted/60 hover:border-border focus:border-brand-500/50 focus:bg-background focus-visible:ring-2 focus-visible:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-50"
      />
      {hasValue ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onClear}
              disabled={isDisabled}
              aria-label="Clear ticket search"
              className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Clear search</TooltipContent>
        </Tooltip>
      ) : (
        <div className="pointer-events-none absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center">
          <Search className="h-3.5 w-3.5 text-muted-foreground/70" />
        </div>
      )}
      {shouldShowSuggestions && (
        <div
          role="listbox"
          aria-label="Project search suggestions"
          className="absolute left-0 right-0 top-full z-[80] mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {suggestions.map((projectName) => (
            <button
              key={projectName}
              type="button"
              role="option"
              onMouseDown={(event) => {
                event.preventDefault()
                onSuggestionSelect(projectName)
              }}
              className="flex w-full min-w-0 items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus:bg-accent"
            >
              <span className="min-w-0 truncate">{projectName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function DashboardSearch({ isModalOpen = false }: DashboardSearchProps) {
  const { state, dispatch } = useUI()
  const { data: projects = [] } = useProjects()
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false)
  const desktopInputRef = useRef<HTMLInputElement>(null)
  const mobileInputRef = useRef<HTMLInputElement>(null)
  const query = state.filters?.search ?? ''
  const queryPrefix = normalizePrefix(query)
  const isKanbanView = state.activeView === 'kanban'

  const suggestions = useMemo(() => {
    if (!queryPrefix) return []
    const names = new Set<string>()
    for (const project of projects) {
      const name = project.name.trim()
      if (name && normalizePrefix(name).startsWith(queryPrefix)) {
        names.add(name)
      }
    }
    return [...names].sort((left, right) => left.localeCompare(right)).slice(0, 8)
  }, [projects, queryPrefix])

  const setQuery = useCallback((search: string) => {
    dispatch({ type: 'SET_FILTER', filter: { search } })
  }, [dispatch])

  const clearQuery = useCallback(() => {
    setQuery('')
  }, [setQuery])

  const focusSearch = useCallback(() => {
    if (isModalOpen || !isKanbanView) return
    if (window.matchMedia('(min-width: 768px)').matches) {
      desktopInputRef.current?.focus()
      return
    }

    setIsMobileSearchOpen(true)
    focusOnNextFrame(() => mobileInputRef.current?.focus())
  }, [isKanbanView, isModalOpen])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
      if (isTextEntryTarget(event.target)) return
      if (isModalOpen || !isKanbanView) return

      event.preventDefault()
      focusSearch()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [focusSearch, isKanbanView, isModalOpen])

  const searchInputProps = {
    value: query,
    suggestions,
    isDisabled: isModalOpen,
    onChange: setQuery,
    onClear: clearQuery,
    onSuggestionSelect: setQuery,
  }

  return (
    <>
      <DashboardSearchInput
        {...searchInputProps}
        id="dashboard-ticket-search"
        inputRef={desktopInputRef}
        className="hidden w-[20ch] md:block"
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              setIsMobileSearchOpen((current) => {
                const next = !current
                if (!current) {
                  focusOnNextFrame(() => mobileInputRef.current?.focus())
                }
                return next
              })
            }}
            disabled={isModalOpen}
            aria-label="Open ticket search"
            aria-expanded={isMobileSearchOpen}
            className="md:hidden"
          >
            <Search className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Search tickets</TooltipContent>
      </Tooltip>
      {isMobileSearchOpen && (
        <div className="absolute left-0 right-0 top-14 z-40 border-b border-border bg-background px-3 py-2 shadow-sm md:hidden">
          <DashboardSearchInput
            {...searchInputProps}
            id="dashboard-ticket-search-mobile"
            inputRef={mobileInputRef}
            className="w-full"
            onEscapeWithEmptyQuery={() => setIsMobileSearchOpen(false)}
          />
        </div>
      )}
    </>
  )
}
