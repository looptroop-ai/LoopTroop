import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The disclosure primitive every artifact view is built from, and the one thing
 * five small components outside this directory import. It used to live in
 * `ArtifactContentViewer.tsx`, so rendering a coverage warning pulled the whole
 * seven-thousand-line viewer and its parsers along with it.
 */
export function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
  className,
  headerActions,
  headerClassName,
  triggerClassName,
  contentClassName,
  scrollOnOpen = true,
}: {
  title: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
  className?: string
  headerActions?: React.ReactNode
  headerClassName?: string
  triggerClassName?: string
  contentClassName?: string
  scrollOnOpen?: boolean
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const sectionRef = useRef<HTMLDivElement>(null)
  const previousOpenRef = useRef(isOpen)

  useEffect(() => {
    if (scrollOnOpen && !previousOpenRef.current && isOpen) {
      sectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    }
    previousOpenRef.current = isOpen
  }, [isOpen, scrollOnOpen])

  return (
    <div
      ref={sectionRef}
      className={cn('border border-border/70 rounded-lg overflow-hidden flex flex-col min-w-0 w-full shadow-2xs', className)}
    >
      <div className={cn('flex flex-wrap items-start gap-2 min-w-0', headerClassName)}>
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((current) => !current)}
          className={cn(
            'flex items-center gap-1.5 flex-1 min-w-0 px-3 py-2 text-xs font-mono font-medium hover:bg-muted/30 transition-all text-left',
            triggerClassName,
          )}
        >
          {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <span className="min-w-0 flex-1 flex items-center">{title}</span>
        </button>
        {headerActions ? <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">{headerActions}</div> : null}
      </div>
      {isOpen && <div className={cn('px-3 pb-3 text-xs overflow-x-auto w-full', contentClassName)}>{children}</div>}
    </div>
  )
}
