import { cn } from '@/lib/utils'
import { CollapsibleSection } from './CollapsibleSection'

/** A labelled value tile. Roughly fifty artifact views place these in a grid. */
export function MetadataCard({
  label,
  value,
  hint,
  mono = false,
  tone = 'default',
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  mono?: boolean
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info'
}) {
  const toneClassName = tone === 'success'
    ? 'border-green-300/70 bg-green-50/70 dark:border-green-900/60 dark:bg-green-950/20'
    : tone === 'warning'
      ? 'border-amber-300/70 bg-amber-50/70 dark:border-amber-900/60 dark:bg-amber-950/20'
      : tone === 'danger'
        ? 'border-red-300/70 bg-red-50/70 dark:border-red-900/60 dark:bg-red-950/20'
        : tone === 'info'
          ? 'border-blue-300/70 bg-blue-50/70 dark:border-blue-900/60 dark:bg-blue-950/20'
          : 'border-border bg-background'

  return (
    <div className={cn('rounded-md border px-3 py-2 min-w-0', toneClassName)}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-sm font-semibold text-foreground break-all', mono && 'font-mono text-[11px] leading-5')}>
        {value}
      </div>
      {hint ? <div className="mt-1 text-[10px] text-muted-foreground leading-4">{hint}</div> : null}
    </div>
  )
}

/** A collapsible list of strings with a count and an empty state. */
export function ArtifactListSection({
  title,
  items,
  emptyLabel,
  tone = 'default',
}: {
  title: string
  items: string[]
  emptyLabel: string
  tone?: 'default' | 'removed' | 'preserved' | 'warning' | 'error'
}) {
  const itemClassName = tone === 'removed'
    ? 'border-red-200 bg-red-50/70 text-red-950 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-100'
    : tone === 'preserved'
      ? 'border-blue-200 bg-blue-50/70 text-blue-950 dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-blue-100'
      : tone === 'warning' || tone === 'error'
        ? 'border-amber-200 bg-amber-50/80 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100'
        : 'border-border bg-background text-foreground'

  return (
    <CollapsibleSection
      title={(
        <span className="flex items-center gap-2">
          <span>{title}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {items.length}
          </span>
        </span>
      )}
      defaultOpen={items.length > 0}
    >
      {items.length > 0 ? (
        <div className="space-y-2">
          {items.map((item, index) => (
            <div
              key={`${title}:${item}:${index}`}
              className={cn('rounded-md border px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all', itemClassName)}
            >
              {item}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">{emptyLabel}</div>
      )}
    </CollapsibleSection>
  )
}
