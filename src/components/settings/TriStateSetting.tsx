import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * One button in the row. `value` is what the setting becomes when it is picked:
 * `null` is the explicit "inherit" choice, which not every setting offers.
 */
export interface TriStateOption {
  value: boolean | null
  label: string
  tooltip: string
}

interface TriStateSettingProps {
  value: boolean | null
  onChange: (value: boolean | null) => void
  options: readonly TriStateOption[]
  /** Names the radio group for screen readers, e.g. "Manual QA setting". */
  groupLabel: string
  idPrefix: string
  /**
   * What to show as picked when `value` matches no option. Only reached by a
   * setting that has no inherit button: there, `null` means "not chosen yet"
   * and the row shows the value that would apply instead of nothing at all.
   */
  fallbackValue?: boolean
  /** Shown under the row unless `compact`. */
  footer?: ReactNode
  disabled?: boolean
  compact?: boolean
}

export function TriStateSetting({
  value,
  onChange,
  options,
  groupLabel,
  idPrefix,
  fallbackValue,
  footer,
  disabled = false,
  compact = false,
}: TriStateSettingProps) {
  const hasMatchingOption = options.some((option) => option.value === value)
  const selectedValue = hasMatchingOption ? value : fallbackValue

  return (
    <div>
      <div className="inline-flex rounded-md border border-input bg-muted/30 p-0.5" role="radiogroup" aria-label={groupLabel}>
        {options.map((option) => {
          const selected = option.value === selectedValue
          return (
            <Tooltip key={option.label}>
              <TooltipTrigger asChild>
                <button
                  id={`${idPrefix}-${option.label.toLowerCase()}`}
                  type="button"
                  role="radio"
                  aria-label={option.label}
                  aria-checked={selected}
                  data-state={selected ? 'checked' : 'unchecked'}
                  disabled={disabled}
                  onClick={() => onChange(option.value)}
                  className={cn(
                    'rounded px-2.5 py-1 text-xs transition-colors',
                    selected
                      ? 'bg-primary font-semibold text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-background hover:text-foreground',
                    disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  {option.label}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm text-xs leading-relaxed">
                {option.tooltip}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      {!compact && footer}
    </div>
  )
}
