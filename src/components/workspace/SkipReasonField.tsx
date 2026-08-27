import { useId } from 'react'
import { SKIP_REASON_MAX_LENGTH } from '@shared/skipReceipt'

interface SkipReasonFieldProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  /** Shown above the box. "Waiver reason" and "Skip reason" are different things. */
  label?: string
  /** One line under the box saying who will read this. */
  help?: string
  placeholder?: string
  autoFocus?: boolean
}

/**
 * The one reason box, shared by every surface that can skip something.
 *
 * Lifted out of the Manual QA skip dialog, which had the only working version
 * of it. Everything here is deliberate: the reason is always optional, it is
 * never validated for content, and the counter only appears once you are close
 * enough to the limit for it to matter.
 */
export function SkipReasonField({
  value,
  onChange,
  disabled,
  label = 'Reason',
  help,
  placeholder,
  autoFocus,
}: SkipReasonFieldProps) {
  const fieldId = useId()
  const helpId = `${fieldId}-help`
  const remaining = SKIP_REASON_MAX_LENGTH - value.length
  const showCounter = remaining <= 500

  return (
    <div>
      <label htmlFor={fieldId} className="text-sm font-medium">
        {label} <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      <textarea
        id={fieldId}
        value={value}
        onChange={(event) => onChange(event.target.value.slice(0, SKIP_REASON_MAX_LENGTH))}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        maxLength={SKIP_REASON_MAX_LENGTH}
        aria-describedby={help ? helpId : undefined}
        className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-60"
      />
      {(help || showCounter) && (
        <div className="mt-1 flex items-start justify-between gap-3 text-xs text-muted-foreground">
          {help ? <p id={helpId}>{help}</p> : <span />}
          {showCounter && (
            <p className={remaining < 0 ? 'text-destructive' : undefined}>
              {remaining.toLocaleString()} left
            </p>
          )}
        </div>
      )}
    </div>
  )
}
