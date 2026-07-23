import { LogColorLegend } from './LogColorLegend'

interface LogCountLegendProps {
  loadedEntries: number
  totalEntries?: number | null
  totalTextLines?: number | null
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function formatEntries(value: number): string {
  return `${formatCount(value)} ${value === 1 ? 'entry' : 'entries'}`
}

function resolveTotalEntries(loadedEntries: number, totalEntries?: number | null): number {
  return Math.max(loadedEntries, totalEntries ?? loadedEntries)
}

export function LogCountLabel({
  loadedEntries,
  totalEntries,
}: Omit<LogCountLegendProps, 'totalTextLines'>) {
  return <span>{formatEntries(resolveTotalEntries(loadedEntries, totalEntries))}</span>
}

export function LogCountTooltip({
  loadedEntries,
  totalEntries,
  totalTextLines,
}: LogCountLegendProps) {
  const resolvedTotalEntries = resolveTotalEntries(loadedEntries, totalEntries)
  const isPartiallyLoaded = loadedEntries < resolvedTotalEntries

  return (
    <div className="space-y-2">
      <div className="space-y-1 border-b border-border pb-2 text-[11px]">
        <div>
          {isPartiallyLoaded
            ? `${formatCount(loadedEntries)} loaded · ${formatCount(resolvedTotalEntries - loadedEntries)} remaining`
            : 'All entries loaded'}
        </div>
        {typeof totalTextLines === 'number' ? (
          <div>{formatCount(totalTextLines)} {totalTextLines === 1 ? 'text line' : 'text lines'}</div>
        ) : null}
      </div>
      <LogColorLegend />
    </div>
  )
}
