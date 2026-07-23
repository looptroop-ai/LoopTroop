import { CircleHelp } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { numericFields, getFieldError, type NumericFieldKey } from './numericFieldConfig'
import { ConfigurationDocsLink } from './ConfigurationDocsLink'

export interface NumericFieldProps {
  fieldKey: NumericFieldKey
  rawNumeric: Record<string, string>
  onChange: (key: string, value: string) => void
  hint: string
  tooltip?: string
}

interface DurationParts {
  minutes: number
  seconds: number
}

function toDurationParts(totalSeconds: number): DurationParts {
  return {
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60,
  }
}

export function NumericField({ fieldKey, rawNumeric, onChange, hint, tooltip }: NumericFieldProps) {
  const cfg = numericFields[fieldKey]
  const error = getFieldError(fieldKey, rawNumeric)
  const isDuration = 'unit' in cfg && cfg.unit === 'seconds'
  const unitSuffix = isDuration
    ? ' (s)'
    : fieldKey === 'coverageFollowUpBudgetPercent'
      ? ' (%)'
      : ''
  const totalSeconds = Number(rawNumeric[fieldKey])
  const hasUsableDuration = isDuration
    && rawNumeric[fieldKey] !== ''
    && Number.isInteger(totalSeconds)
    && totalSeconds >= 0
  const duration = hasUsableDuration ? toDurationParts(totalSeconds) : null

  const updateDurationPart = (part: keyof DurationParts, rawValue: string) => {
    if (!duration || rawValue === '') return
    const value = Number(rawValue)
    if (!Number.isInteger(value) || value < 0) return
    if (part === 'seconds' && value > 59) return

    const next = { ...duration, [part]: value }
    onChange(fieldKey, String((next.minutes * 60) + next.seconds))
  }

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <span>{cfg.label}{unitSuffix}</span>
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                aria-label={`${cfg.label} help`}
              >
                <CircleHelp className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs leading-relaxed">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {isDuration ? (
        <div
          className={cn(
            'grid grid-cols-[minmax(0,1fr)_auto] items-center overflow-hidden rounded-md border bg-background',
            error ? 'border-red-500' : 'border-input',
          )}
          aria-label={`${cfg.label} seconds and equivalent duration`}
        >
          <input
            type="number"
            aria-label={cfg.label}
            value={rawNumeric[fieldKey]}
            onChange={e => onChange(fieldKey, e.target.value)}
            className="min-w-0 border-0 bg-transparent px-3 py-2 text-sm outline-none"
          />
          <div className="flex items-center gap-1 border-l border-input bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
            <span aria-hidden="true">(</span>
            {([
              ['minutes', 'min', undefined],
              ['seconds', 'sec', 59],
            ] as const).map(([part, unit, max]) => (
              <span key={part} className="inline-flex items-center gap-0.5">
                <input
                  type="number"
                  min={0}
                  max={max}
                  step={1}
                  aria-label={`${cfg.label} ${part}`}
                  value={duration?.[part] ?? ''}
                  disabled={error !== null}
                  onChange={e => updateDurationPart(part, e.target.value)}
                  className="w-10 rounded border border-transparent bg-transparent px-1 py-1 text-right text-xs text-foreground outline-none transition-colors hover:border-input focus:border-input focus:bg-background disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span>{unit}</span>
              </span>
            ))}
            <span aria-hidden="true">)</span>
          </div>
        </div>
      ) : (
        <input
          type="number"
          aria-label={cfg.label}
          value={rawNumeric[fieldKey]}
          onChange={e => onChange(fieldKey, e.target.value)}
          className={cn('w-full rounded-md border bg-background px-3 py-2 text-sm', error ? 'border-red-500' : 'border-input')}
        />
      )}
      {error ? (
        <p className="text-xs text-red-500 mt-1">{error}</p>
      ) : (
        <div className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
          <p className="min-w-0 flex-1">{hint}</p>
          <ConfigurationDocsLink
            docsPath={cfg.docsPath}
            label={cfg.label}
            description={`${hint} Open the detailed documentation.`}
          />
        </div>
      )}
    </div>
  )
}
