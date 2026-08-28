import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

const MS_PER_MINUTE = 60_000

interface InheritableDurationFieldProps {
  /** Human name of the setting. Also drives the accessible names of the controls. */
  label: string
  idPrefix: string
  /** Milliseconds, or `null` to inherit. */
  value: number | null
  onChange: (value: number | null) => void
  /** What applies while this field inherits, in milliseconds. */
  inheritedMs: number
  /** Where the inherited value comes from, e.g. "Project". */
  inheritedSourceLabel?: string
  minMs: number
  maxMs: number
  hint?: ReactNode
  disabled?: boolean
  /** How a resolved duration reads. Defaults to whole minutes. */
  formatValue?: (ms: number) => string
}

function defaultFormat(ms: number): string {
  const minutes = Math.round(ms / MS_PER_MINUTE)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

function toMinutesText(ms: number): string {
  return String(Math.round(ms / MS_PER_MINUTE))
}

export function InheritableDurationField({
  label,
  idPrefix,
  value,
  onChange,
  inheritedMs,
  inheritedSourceLabel,
  minMs,
  maxMs,
  hint,
  disabled = false,
  formatValue = defaultFormat,
}: InheritableDurationFieldProps) {
  const minMinutes = Math.round(minMs / MS_PER_MINUTE)
  const maxMinutes = Math.round(maxMs / MS_PER_MINUTE)
  const isInheriting = value === null

  // The typed text is kept locally so an out-of-range edit can be shown and
  // explained without being pushed up to whoever owns the setting.
  const [rawMinutes, setRawMinutes] = useState(() => (value === null ? '' : toMinutesText(value)))
  const lastEmittedRef = useRef<number | null>(value)

  useEffect(() => {
    if (value === lastEmittedRef.current) return
    lastEmittedRef.current = value
    setRawMinutes(value === null ? '' : toMinutesText(value))
  }, [value])

  const emit = (next: number | null) => {
    lastEmittedRef.current = next
    onChange(next)
  }

  const error = isInheriting ? null : validate(rawMinutes, minMinutes, maxMinutes)

  const inputId = `${idPrefix}-minutes`
  const hintId = `${idPrefix}-hint`
  const errorId = `${idPrefix}-error`
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ')

  const handleMinutesChange = (raw: string) => {
    setRawMinutes(raw)
    const minutes = Number(raw)
    if (raw === '' || !Number.isInteger(minutes)) return
    if (minutes < minMinutes || minutes > maxMinutes) return
    emit(minutes * MS_PER_MINUTE)
  }

  return (
    <div>
      <label htmlFor={inputId} className="text-sm font-medium">{label}</label>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <div
          className="inline-flex rounded-md border border-input bg-muted/30 p-0.5"
          role="radiogroup"
          aria-label={`${label} source`}
        >
          {([
            { inherit: true, text: 'Inherit', ariaLabel: `Inherit ${label.toLowerCase()}` },
            { inherit: false, text: 'Custom', ariaLabel: `Set a custom ${label.toLowerCase()}` },
          ] as const).map((mode) => {
            const selected = mode.inherit === isInheriting
            return (
              <button
                key={mode.text}
                id={`${idPrefix}-${mode.text.toLowerCase()}`}
                type="button"
                role="radio"
                aria-label={mode.ariaLabel}
                aria-checked={selected}
                data-state={selected ? 'checked' : 'unchecked'}
                disabled={disabled}
                // Switching to Custom starts from what already applies, so the
                // override does not silently change the wait as it is created.
                //
                // The text is set here as well as emitted. The effect below
                // syncs it from `value`, but skips when `value` already matches
                // what this component last emitted — which is exactly the case
                // after this click. Leaving it to the effect left the box empty
                // and complaining "enter a number of minutes" while a perfectly
                // good override was already saved.
                onClick={() => {
                  const next = mode.inherit ? null : clampToRange(inheritedMs, minMs, maxMs)
                  setRawMinutes(next === null ? '' : toMinutesText(next))
                  emit(next)
                }}
                className={cn(
                  'rounded px-2.5 py-1 text-xs transition-colors',
                  selected
                    ? 'bg-primary font-semibold text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-background hover:text-foreground',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
              >
                {mode.text}
              </button>
            )
          })}
        </div>

        {isInheriting ? (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{formatValue(inheritedMs)}</span>
            {inheritedSourceLabel ? ` from ${inheritedSourceLabel}` : ''}
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <input
                id={inputId}
                type="number"
                inputMode="numeric"
                min={minMinutes}
                max={maxMinutes}
                step={1}
                value={rawMinutes}
                disabled={disabled}
                aria-describedby={describedBy || undefined}
                aria-invalid={error ? true : undefined}
                onChange={(event) => handleMinutesChange(event.target.value)}
                className={cn(
                  'w-20 rounded-md border bg-background px-2 py-1 text-sm',
                  error ? 'border-red-500' : 'border-input',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
              />
              <span className="text-xs text-muted-foreground">minutes</span>
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => emit(null)}
              className="text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              Clear override
            </button>
          </div>
        )}
      </div>

      {error && <p id={errorId} role="alert" className="mt-1 text-xs text-red-500">{error}</p>}
      {hint && <p id={hintId} className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function clampToRange(ms: number, minMs: number, maxMs: number): number {
  return Math.min(maxMs, Math.max(minMs, Math.round(ms / MS_PER_MINUTE) * MS_PER_MINUTE))
}

function validate(raw: string, minMinutes: number, maxMinutes: number): string | null {
  if (raw.trim() === '') return `Enter a number of minutes (${minMinutes}–${maxMinutes}).`
  const minutes = Number(raw)
  if (!Number.isInteger(minutes)) return `Use whole minutes (${minMinutes}–${maxMinutes}).`
  if (minutes < minMinutes) return `Minimum is ${minMinutes} minute${minMinutes === 1 ? '' : 's'}.`
  if (minutes > maxMinutes) return `Maximum is ${maxMinutes} minutes.`
  return null
}
