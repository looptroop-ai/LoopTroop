import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { VerticalResizeHandle } from './VerticalResizeHandle'
import { PhaseLogPanel } from './PhaseLogPanel'
import { getFillDrawerAvailableHeight, resolveStickyFillNaturalHeight, type StickyFillNaturalHeight } from './logDrawerSizing'
import type { LogEntry } from '@/context/LogContext'
import type { Ticket } from '@/hooks/useTickets'

interface CollapsiblePhaseLogSectionProps {
  phase: string
  logs?: LogEntry[]
  ticket?: Ticket
  phaseAttempt?: number
  logMode?: 'live' | 'snapshot'
  defaultExpanded?: boolean
  variant?: 'fill' | 'bottom'
  className?: string
  resizeContainerRef?: RefObject<HTMLElement | null>
  defaultHeight?: number
}

export function CollapsiblePhaseLogSection({
  phase,
  logs,
  ticket,
  phaseAttempt,
  logMode = 'live',
  defaultExpanded = true,
  variant = 'fill',
  className,
  resizeContainerRef,
  defaultHeight = 200,
}: CollapsiblePhaseLogSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [height, setHeight] = useState(defaultHeight)
  const [fillNaturalHeight, setFillNaturalHeight] = useState<StickyFillNaturalHeight | null>(null)
  const [fillAvailableHeight, setFillAvailableHeight] = useState<number | null>(null)
  const panelId = useId()
  const rootRef = useRef<HTMLDivElement>(null)

  const hasResizeHandle = variant === 'bottom' && isExpanded && Boolean(resizeContainerRef)

  const rootClassName = cn(
    'min-w-0 flex flex-col',
    !hasResizeHandle && 'border-t border-border/30 pt-1.5',
    variant === 'fill' ? 'mt-auto shrink-0' : 'shrink-0',
    className,
  )

  const handleToggleExpanded = useCallback(() => {
    setIsExpanded((value) => {
      const nextValue = !value
      if (variant === 'fill') {
        if (nextValue) {
          setFillNaturalHeight(null)
        } else {
          setFillAvailableHeight(null)
        }
      }
      return nextValue
    })
  }, [variant])

  const effectiveFillNaturalHeight = fillNaturalHeight?.phase === phase
    ? fillNaturalHeight.height
    : null

  const measureFillAvailableHeight = useCallback(() => {
    if (variant !== 'fill' || !isExpanded) {
      setFillAvailableHeight(null)
      return
    }

    const rootEl = rootRef.current
    const parentEl = rootEl?.parentElement
    if (!rootEl || !parentEl) {
      setFillAvailableHeight(null)
      return
    }
    setFillAvailableHeight(getFillDrawerAvailableHeight(parentEl, rootEl))
  }, [isExpanded, variant])

  useEffect(() => {
    if (variant !== 'fill' || !isExpanded) return

    const rootEl = rootRef.current
    const parentEl = rootEl?.parentElement
    if (!rootEl || !parentEl) return
    const frame = requestAnimationFrame(() => {
      measureFillAvailableHeight()
    })

    const observer = new ResizeObserver(() => {
      measureFillAvailableHeight()
    })

    observer.observe(parentEl)
    Array.from(parentEl.children).forEach((child) => {
      if (child !== rootEl) observer.observe(child)
    })

    window.addEventListener('resize', measureFillAvailableHeight)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', measureFillAvailableHeight)
    }
  }, [isExpanded, measureFillAvailableHeight, variant])

  const rootStyle = (() => {
    if (!isExpanded) return undefined
    if (variant === 'bottom') return { height, minHeight: 0, maxHeight: '100%' }
    if (variant !== 'fill' || fillAvailableHeight === null) return undefined

    return {
      height: effectiveFillNaturalHeight === null ? fillAvailableHeight : Math.min(effectiveFillNaturalHeight, fillAvailableHeight),
      minHeight: 0,
      maxHeight: '100%',
    }
  })()

  const handleFillNaturalHeightChange = useCallback((nextHeight: number) => {
    setFillNaturalHeight((current) => resolveStickyFillNaturalHeight(current, phase, nextHeight))
  }, [phase])

  const logToggleButton = (
    <button
      type="button"
      onClick={handleToggleExpanded}
      aria-expanded={isExpanded}
      aria-controls={panelId}
      className="flex items-center gap-1 py-1 text-xs font-mono font-medium text-muted-foreground uppercase tracking-wider transition-all hover:text-foreground shrink-0"
    >
      <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-90')} />
      <span>Log</span>
    </button>
  )

  return (
    <>
      {variant === 'bottom' && isExpanded && resizeContainerRef ? (
        <VerticalResizeHandle onResize={setHeight} containerRef={resizeContainerRef} />
      ) : null}
      <div ref={rootRef} className={rootClassName} style={rootStyle}>
        {!isExpanded ? logToggleButton : null}
        {isExpanded ? (
          <div id={panelId} className="flex-1 min-h-0 flex flex-col">
            <PhaseLogPanel
              phase={phase}
              logs={logs}
              ticket={ticket}
              phaseAttempt={phaseAttempt}
              logMode={logMode}
              hideHeader
              toolbarPrefix={logToggleButton}
              onNaturalHeightChange={variant === 'fill' ? handleFillNaturalHeightChange : undefined}
            />
          </div>
        ) : null}
      </div>
    </>
  )
}
