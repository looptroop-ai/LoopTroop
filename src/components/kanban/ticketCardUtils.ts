import { STATUS_ORDER, STATUS_TO_PHASE } from '@/lib/workflowMeta'

export function getStatusColor(status: string): string {
  if (status === 'BLOCKED_ERROR') {
    return 'bg-rose-500/5 text-rose-600/90 dark:text-rose-400/90 border border-rose-500/20 font-mono text-xs font-medium'
  }
  return 'bg-muted/40 text-muted-foreground border-border/70 font-mono text-xs font-medium'
}

export function formatRelativeDateChip(dateStr: string): string {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ''

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  const targetDate = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffTime = today.getTime() - targetDate.getTime()
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))

  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')

  if (diffDays === 0) {
    return `Today ${hours}:${minutes}`
  }
  if (diffDays === 1) {
    return 'Yesterday'
  }
  if (diffDays > 1 && diffDays < 7) {
    return d.toLocaleDateString(undefined, { weekday: 'long' })
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}


export function getStatusProgress(status: string): number | null {
  if (status === 'BLOCKED_ERROR') return null
  if (STATUS_TO_PHASE[status] === 'todo' || STATUS_TO_PHASE[status] === 'done') return null
  const idx = STATUS_ORDER.indexOf(status)
  if (idx === -1) return null
  return Math.round(((idx + 1) / STATUS_ORDER.length) * 100)
}

export function getWorkflowRingProgress(status: string): { percent: number; label: string } | null {
  const phase = getStatusProgress(status)
  if (phase === null) return null
  return { percent: phase, label: 'Workflow progress' }
}

export function getBeadCompletionProgress(
  status: string,
  beadProgress: { totalBeads: number; percentComplete: number },
): { percent: number; label: string } | null {
  if (status === 'CODING' && beadProgress.totalBeads > 0) {
    return { percent: Math.round(beadProgress.percentComplete), label: 'Bead completion' }
  }
  return null
}

export function getStatusRingColor(_status: string): string {
  return 'text-muted-foreground'
}
