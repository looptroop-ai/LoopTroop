import { cn } from '@/lib/utils'
import type { ManualQaOverride } from '@/lib/manualQaSetting'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface ManualQaSettingProps {
  value: ManualQaOverride
  onChange: (value: ManualQaOverride) => void
  disabled?: boolean
  idPrefix: string
  inheritedEnabled?: boolean
  compact?: boolean
}

const OPTIONS: Array<{ value: boolean; label: string; tooltip: string }> = [
  {
    value: true,
    label: 'Enabled',
    tooltip: 'After final tests pass, LoopTroop generates a checklist and pauses the ticket for your review. You run and control the application; LoopTroop never launches it. Passing, waiving, or skipping continues to integration, while failures can create QA-fix work. The effective choice is frozen when the ticket starts.',
  },
  {
    value: false,
    label: 'Disabled',
    tooltip: 'After final tests pass, the ticket proceeds directly to integration without a Manual QA checkpoint. No checklist or evidence round is created. Automated tests and the normal integration checks still run. The effective choice is frozen when the ticket starts.',
  },
]

export function ManualQaSetting({
  value,
  onChange,
  disabled = false,
  idPrefix,
  inheritedEnabled,
  compact = false,
}: ManualQaSettingProps) {
  const selectedValue = value ?? inheritedEnabled ?? false

  return (
    <div>
      <div className="inline-flex rounded-md border border-input bg-muted/30 p-0.5" role="radiogroup" aria-label="Manual QA setting">
        {OPTIONS.map((option) => {
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
      {!compact && value === null && typeof inheritedEnabled === 'boolean' && (
        <p className="mt-1 text-xs text-muted-foreground">
          Current default: <span className="font-medium text-foreground">{inheritedEnabled ? 'Enabled' : 'Disabled'}</span>. Choose an option to set this explicitly.
        </p>
      )}
    </div>
  )
}
