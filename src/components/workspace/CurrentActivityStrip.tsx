import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, Clock3, RefreshCw } from 'lucide-react'
import type { LogEntry } from '@/context/LogContext'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import { cn } from '@/lib/utils'
import { deriveCurrentActivities, formatElapsedDuration, type CurrentActivity } from './currentActivity'

interface CurrentActivityStripProps {
  entries: LogEntry[]
  enabled?: boolean
  activeStatus?: string | null
  className?: string
}

const severityClassName: Record<CurrentActivity['severity'], string> = {
  info: 'border-sky-500/25 bg-sky-500/5 text-sky-700 dark:text-sky-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  error: 'border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300',
}

function ActivityIcon({ activity }: { activity: CurrentActivity }) {
  if (activity.kind === 'provider_retrying') {
    return <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
  }
  if (activity.severity === 'error' || activity.severity === 'warning') {
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 animate-wobble-throb" aria-hidden="true" />
  }
  return <Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
}

function ActivityRow({ activity }: { activity: CurrentActivity }) {
  const elapsedLabel = activity.elapsedMs === undefined
    ? null
    : formatElapsedDuration(activity.elapsedMs)
  const modelLabel = activity.modelId ? getModelDisplayName(activity.modelId) : null

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-black/5 dark:hover:bg-white/5',
        activity.severity === 'error' && 'text-rose-800 dark:text-rose-200',
        activity.severity === 'warning' && 'text-amber-800 dark:text-amber-200',
        activity.severity === 'info' && 'text-sky-800 dark:text-sky-200',
      )}
    >
      <ActivityIcon activity={activity} />
      <span className="min-w-0 font-mono font-medium text-foreground truncate max-w-full sm:max-w-md">
        {activity.label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        {elapsedLabel ? (
          <span>· {elapsedLabel}</span>
        ) : null}
        {modelLabel ? (
          <span title={activity.modelId}>
            · model <strong className="text-foreground/80">{modelLabel}</strong>
          </span>
        ) : null}
        {activity.sessionId ? (
          <span title={activity.sessionId}>
            · session <code className="bg-black/5 dark:bg-white/5 px-1 py-0.5 rounded text-[10px]">{activity.sessionId}</code>
          </span>
        ) : null}
        {activity.beadId ? (
          <span title={activity.beadId}>
            · bead <code className="bg-black/5 dark:bg-white/5 px-1 py-0.5 rounded text-[10px]">{activity.beadId}</code>
          </span>
        ) : null}
      </div>
      {activity.diagnostic ? (
        <span className="ml-auto shrink-0 rounded border border-current/25 px-1.5 py-0.5 font-mono text-[9px] bg-black/5 dark:bg-white/5">
          {activity.diagnostic}
        </span>
      ) : null}
    </div>
  )
}

export function CurrentActivityStrip({ entries, enabled = true, activeStatus, className }: CurrentActivityStripProps) {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    setNowMs(Date.now())
  }, [entries])

  const activities = useMemo(
    () => (enabled ? deriveCurrentActivities(entries, nowMs, { activeStatus }) : []),
    [activeStatus, enabled, entries, nowMs],
  )

  const hasAnyActive = useMemo(() => activities.some((a) => a.active), [activities])

  useEffect(() => {
    if (!hasAnyActive) return
    const UPDATE_INTERVAL_MS = 1000
    const intervalId = window.setInterval(() => setNowMs(Date.now()), UPDATE_INTERVAL_MS)
    return () => window.clearInterval(intervalId)
  }, [hasAnyActive])

  const [isExpanded, setIsExpanded] = useState(() => {
    try {
      if (typeof window === 'undefined') return false
      const saved = localStorage.getItem('looptroop:activity-strip:expanded')
      return saved === 'true' // Collapsed by default (returns false if null or 'false')
    } catch {
      return false
    }
  })

  const toggleExpand = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsExpanded((prev) => {
      const next = !prev
      try {
        localStorage.setItem('looptroop:activity-strip:expanded', String(next))
      } catch {
        // Safe fallback if localStorage is sandboxed or disabled
      }
      return next
    })
  }

  if (activities.length === 0) return null

  const maxSeverity = (() => {
    if (activities.some((a) => a.severity === 'error')) return 'error'
    if (activities.some((a) => a.severity === 'warning')) return 'warning'
    return 'info'
  })()

  const headerIcon = (() => {
    const hasError = activities.some((a) => a.severity === 'error')
    const hasWarning = activities.some((a) => a.severity === 'warning')
    if (hasError) return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400 animate-wobble-throb" />
    if (hasWarning) return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400 animate-wobble-throb" />
    return <Clock3 className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
  })()

  const headerTitle = (() => {
    if (activities.length === 1) {
      const a = activities[0]!
      const modelLabel = a.modelId ? getModelDisplayName(a.modelId) : null
      return (
        <div className="flex items-center gap-1.5 truncate">
          <span className="font-semibold text-foreground truncate">{a.label}</span>
          {modelLabel && (
            <span className="text-muted-foreground truncate">· model {modelLabel}</span>
          )}
        </div>
      )
    }

    return (
      <div className="flex items-center gap-2 truncate">
        <span className="font-semibold text-foreground">AI Activity Status & Warnings</span>
        <span className="inline-flex items-center justify-center bg-foreground/10 text-foreground px-1.5 py-0.5 rounded-full text-[10px] font-bold">
          {activities.length}
        </span>
      </div>
    )
  })()

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Current activity"
      className={cn(
        'mx-1 mb-1 overflow-hidden rounded-lg border text-xs shadow-2xs transition-all duration-300 ease-in-out',
        severityClassName[maxSeverity],
        className,
      )}
    >
      <button
        type="button"
        onClick={toggleExpand}
        className="w-full flex items-center justify-between px-3 py-2 text-left font-mono font-medium select-none hover:bg-black/5 dark:hover:bg-white/5 transition-all cursor-pointer"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center gap-2 truncate min-w-0">
          {headerIcon}
          {headerTitle}
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 opacity-60 transition-transform duration-300',
            isExpanded && 'rotate-180',
          )}
        />
      </button>

      <div
        className={cn(
          'border-t border-current/10 divide-y divide-current/10 transition-all duration-300',
          !isExpanded && 'hidden',
        )}
      >
        {activities.map((activity, idx) => (
          <ActivityRow
            key={`${activity.kind}-${activity.sessionId ?? ''}-${activity.beadId ?? ''}-${idx}`}
            activity={activity}
          />
        ))}
      </div>
    </div>
  )
}
