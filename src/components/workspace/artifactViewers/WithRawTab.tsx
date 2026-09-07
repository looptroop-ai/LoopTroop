import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import { ModelIcon } from '@/components/shared/ModelBadge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { buildReadableRawDisplayContent } from '../rawDisplayContent'
import { CopyButton, RawDisplayPre, RawDisplayStats } from '../RawTextDisplay'
import {
  buildAggregateRawSource,
  canShowRawSourceSelector,
  findRawSourceSelection,
  getRawSourceFallbackSelection,
  shouldOmitAggregateRawSource,
  type RawContentSource,
} from './rawContentSources'

export function RawAttemptVariantSelector({
  source,
  activeVariantId,
  onSelect,
  ariaLabel,
}: {
  source?: RawContentSource
  activeVariantId?: string
  onSelect: (variantId: string) => void
  ariaLabel: string
}) {
  if (!source?.variants?.length) return null
  const label = source.label || (source.modelId ? getModelDisplayName(source.modelId) : source.id)

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex min-w-0 max-w-full overflow-hidden rounded-lg border border-border/70 bg-background shadow-2xs"
    >
      <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 bg-muted/60 px-2.5 py-1 text-[10px] font-mono font-medium text-foreground">
        {source.modelId ? <ModelIcon modelId={source.modelId} className="h-3 w-3" /> : null}
        <span className="min-w-0 truncate">{label}</span>
      </span>
      {source.variants.map((variant) => {
        const active = activeVariantId === variant.id
        const disabled = Boolean(variant.disabled)
        return (
          <Tooltip key={variant.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-pressed={active}
                aria-label={variant.ariaLabel ?? `${label} ${variant.label}`}
                onClick={() => onSelect(variant.id)}
                className={cn(
                  'inline-flex min-w-0 max-w-full items-center gap-1.5 border-l border-border px-2.5 py-1 text-[10px] font-medium transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                  disabled && 'cursor-not-allowed hover:bg-background hover:text-muted-foreground',
                )}
              >
                <span className={cn('min-w-0 truncate', variant.labelClassName)}>{variant.label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-center text-balance">{variant.title}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

export function WithRawTab({
  content,
  structuredLabel,
  children,
  header,
  notice,
  rawSources,
}: {
  content: string
  structuredLabel: string
  children: React.ReactNode
  header?: React.ReactNode
  notice?: React.ReactNode
  rawSources?: RawContentSource[]
}) {
  const [activeTab, setActiveTab] = useState<'structured' | 'raw'>('structured')
  const [activeRawSourceId, setActiveRawSourceId] = useState('all')
  const rawSourceOptions = useMemo<RawContentSource[]>(() => {
    if (shouldOmitAggregateRawSource(rawSources)) return rawSources ?? []
    const aggregateSource = buildAggregateRawSource(content, rawSources)
    return [aggregateSource, ...(rawSources ?? [])]
  }, [content, rawSources])
  const activeRawSource = findRawSourceSelection(rawSourceOptions, activeRawSourceId)
    ?? getRawSourceFallbackSelection(rawSourceOptions)
    ?? { id: 'all', label: 'All Models', content, parentId: 'all' }
  const activeRawContent = activeRawSource.content ?? ''
  const activeRawDisplayContent = activeRawSource.displayContent ?? buildReadableRawDisplayContent(activeRawContent)
  const shouldShowRawSourceSelector = canShowRawSourceSelector(rawSourceOptions)

  useEffect(() => {
    if (!findRawSourceSelection(rawSourceOptions, activeRawSourceId)) {
      setActiveRawSourceId(getRawSourceFallbackSelection(rawSourceOptions)?.id ?? 'all')
    }
  }, [activeRawSourceId, rawSourceOptions])

  return (
    <div className="min-w-0 max-w-full space-y-3">
      <div className="flex items-center gap-2">
        {header && <div className="flex-1 min-w-0">{header}</div>}
        <div className={`inline-flex items-center gap-1 rounded-md border border-border bg-background p-1 shrink-0 ${!header ? 'ml-auto' : ''}`}>
          <button
            onClick={() => setActiveTab('structured')}
            className={activeTab === 'structured'
              ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
              : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
          >
            {structuredLabel}
          </button>
          <button
            onClick={() => setActiveTab('raw')}
            className={activeTab === 'raw'
              ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
              : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
          >
            Raw
          </button>
          {activeTab === 'raw' && <CopyButton content={activeRawContent} />}
        </div>
      </div>

      {activeTab === 'structured' ? notice : null}

      {activeTab === 'raw' && (
        <>
          {shouldShowRawSourceSelector && (
            <div className="flex min-w-0 max-w-full flex-wrap gap-1.5 overflow-hidden" aria-label="Raw vote source">
              {rawSourceOptions.map((source) => {
                const label = source.label || (source.modelId ? getModelDisplayName(source.modelId) : source.id)
                if (source.variants?.length) {
                  const sourceActive = activeRawSource.parentId === source.id
                  const enabledVariants = source.variants.filter((variant) => !variant.disabled)
                  const disabled = enabledVariants.length === 0
                  return (
                    <div
                      key={source.id}
                      role="group"
                      aria-label={`${label} raw output`}
                      className={cn(
                        'inline-flex min-w-0 max-w-full overflow-hidden rounded-md border bg-background',
                        sourceActive ? 'border-primary' : 'border-border',
                        disabled && 'opacity-45',
                      )}
                    >
                      <span
                        className={cn(
                          'inline-flex min-w-0 max-w-full items-center gap-1.5 px-2.5 py-1 text-[10px] font-medium',
                          sourceActive ? 'bg-muted text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {source.modelId ? <ModelIcon modelId={source.modelId} className="h-3 w-3" /> : null}
                        <span className="min-w-0 truncate">{label}</span>
                      </span>
                      {source.variants.map((variant) => {
                        const active = activeRawSource.id === variant.id
                        const variantDisabled = Boolean(variant.disabled)
                        return (
                          <Tooltip key={variant.id}>
                              <TooltipTrigger asChild>
                                <button
                                                        type="button"
                                                        disabled={variantDisabled}
                                                        aria-pressed={active}
                                                        aria-label={variant.ariaLabel ?? `${label} ${variant.label}`}
                                                        onClick={() => setActiveRawSourceId(variant.id)}
                                                        className={cn(
                                                          'inline-flex min-w-0 max-w-full items-center gap-1.5 px-2.5 py-1 text-[10px] font-medium transition-colors',
                                                          'border-l border-border',
                                                          active
                                                            ? 'bg-primary text-primary-foreground'
                                                            : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                                                          variantDisabled && 'cursor-not-allowed hover:bg-background hover:text-muted-foreground',
                                                        )}
                                                      >
                                                        <span className={cn('min-w-0 truncate', variant.labelClassName)}>{variant.label}</span>
                                                      </button>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs text-center text-balance">{variant.title}</TooltipContent>
                            </Tooltip>
                        )
                      })}
                    </div>
                  )
                }
                const active = activeRawSource.id === source.id
                const disabled = Boolean(source.disabled)
                return (
                  <Tooltip key={source.id}>
                      <TooltipTrigger asChild>
                        <button
                                        type="button"
                                        disabled={disabled}
                                        aria-pressed={active}
                                        onClick={() => setActiveRawSourceId(source.id)}
                                        className={cn(
                                          'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] font-medium transition-colors',
                                          active
                                            ? 'border-primary bg-primary text-primary-foreground'
                                            : 'border-border bg-background text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                                          disabled && 'cursor-not-allowed opacity-45 hover:bg-background hover:text-muted-foreground',
                                        )}
                                      >
                                        {source.modelId ? <ModelIcon modelId={source.modelId} className="h-3 w-3" /> : null}
                                        <span className="min-w-0 truncate">{label}</span>
                                      </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-center text-balance">{source.title}</TooltipContent>
                    </Tooltip>
                )
              })}
            </div>
          )}
          <RawDisplayStats content={activeRawDisplayContent} />
        </>
      )}

      {activeTab === 'structured' ? (
        <>
          {children}
        </>
      ) : (
        <RawDisplayPre content={activeRawDisplayContent} />
      )}
    </div>
  )
}
