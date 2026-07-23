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
  hours: number
  minutes: number
  seconds: number
}

function toDurationParts(totalSeconds: number): DurationParts {
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
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
    if ((part === 'minutes' || part === 'seconds') && value > 59) return

    const next = { ...duration, [part]: value }
    onChange(fieldKey, String((next.hours * 3600) + (next.minutes * 60) + next.seconds))
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
      <input
        type="number"
        aria-label={cfg.label}
        value={rawNumeric[fieldKey]}
        onChange={e => onChange(fieldKey, e.target.value)}
        className={cn("w-full rounded-md border bg-background px-3 py-2 text-sm", error ? 'border-red-500' : 'border-input')}
      />
      {isDuration ? (
        <div
          className="mt-2 grid grid-cols-3 gap-2"
          aria-label={`${cfg.label} duration breakdown`}
        >
          {([
            ['hours', 'Hours', undefined],
            ['minutes', 'Minutes', 59],
            ['seconds', 'Seconds', 59],
          ] as const).map(([part, label, max]) => (
            <label key={part} className="text-xs text-muted-foreground">
              <span className="mb-1 block">{label}</span>
              <input
                type="number"
                min={0}
                max={max}
                step={1}
                aria-label={`${cfg.label} ${part}`}
                value={duration?.[part] ?? ''}
                disabled={error !== null}
                onChange={e => updateDurationPart(part, e.target.value)}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
          ))}
        </div>
      ) : null}
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
