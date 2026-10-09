import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { handleRadioGroupKeyDown } from './radioGroupNavigation'
import { defaultDurationFormat, getDurationDescribedBy, getDurationDisplayValue, getDurationInputClassName } from './durationFieldUtils'

export interface InheritableDurationFieldProps {
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
  /** The configuration uses the built-in default rather than another level. */
  inheritLabel?: string
  minMs: number
  maxMs: number
  hint?: ReactNode
  help?: ReactNode
  onValidationChange?: (hasError: boolean) => void
  disabled?: boolean
  disabledReason?: string
  /** Saved drafts commit a complete edit when focus leaves the input or Enter is pressed. */
  commitOnBlur?: boolean
  /** How a resolved duration reads. Defaults to whole minutes. */
  formatValue?: (ms: number) => string
}

interface DurationFieldControlsProps extends InheritableDurationFieldProps {
  rawMinutes: string
  error: string | null
  minMinutes: number
  maxMinutes: number
  onModeChange: (inheriting: boolean) => void
  onRawChange: (raw: string) => void
  commitMinutes: (raw: string) => void
}

interface DurationFieldLabelProps {
  label: string
  inputId: string
  idPrefix: string
  inheriting: boolean
  hint?: ReactNode
  help?: ReactNode
  disabledReason?: string
}

const DurationFieldLabel = ({ label, inputId, idPrefix, inheriting, hint, help, disabledReason }: DurationFieldLabelProps) => (
  <div className="min-w-0 flex-1">
    <div className="flex items-center gap-1.5">
      <label htmlFor={inheriting ? undefined : inputId} className="text-sm font-medium">{label}</label>
      {help}
    </div>
    {hint && <p id={`${idPrefix}-hint`} className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    {disabledReason && <p id={`${idPrefix}-disabled-reason`} className="mt-1 text-xs text-muted-foreground">{disabledReason}</p>}
  </div>
)

interface DurationSourceRadioProps {
  id: string
  text: string
  ariaLabel: string
  inheriting: boolean
  selected: boolean
  disabled?: boolean
  onModeChange: (inheriting: boolean) => void
}

const DurationSourceRadio = ({ id, text, ariaLabel, inheriting, selected, disabled, onModeChange }: DurationSourceRadioProps) => (
  <button
    id={id}
    type="button"
    role="radio"
    aria-label={ariaLabel}
    aria-checked={selected}
    tabIndex={selected ? 0 : -1}
    data-state={selected ? 'checked' : 'unchecked'}
    disabled={disabled}
    onClick={() => onModeChange(inheriting)}
    className={cn(
      'rounded px-2.5 py-1 text-xs transition-colors',
      selected
        ? 'bg-primary font-semibold text-primary-foreground shadow-sm'
        : 'text-muted-foreground hover:bg-background hover:text-foreground',
      disabled && 'cursor-not-allowed opacity-60',
    )}
  >
    {text}
  </button>
)

interface DurationSourcePickerProps {
  label: string
  idPrefix: string
  inheritLabel?: string
  inheriting: boolean
  disabled?: boolean
  describedBy?: string
  onModeChange: (inheriting: boolean) => void
}

const DurationSourcePicker = ({ label, idPrefix, inheritLabel = 'Inherit', inheriting, disabled, describedBy, onModeChange }: DurationSourcePickerProps) => (
  <div
    className="inline-flex rounded-md border border-input bg-muted/30 p-0.5"
    role="radiogroup"
    aria-label={`${label} source`}
    aria-describedby={describedBy}
    onKeyDown={handleRadioGroupKeyDown}
  >
    {([
      { inherit: true, text: inheritLabel, ariaLabel: `${inheritLabel} ${label}` },
      { inherit: false, text: 'Custom', ariaLabel: `Set a custom ${label}` },
    ] as const).map(mode => (
      <DurationSourceRadio
        key={mode.text}
        id={`${idPrefix}-${mode.inherit ? 'inherit' : 'custom'}`}
        text={mode.text}
        ariaLabel={mode.ariaLabel}
        inheriting={mode.inherit}
        selected={mode.inherit === inheriting}
        disabled={disabled}
        onModeChange={onModeChange}
      />
    ))}
  </div>
)

const InheritedDurationValue = ({ inheritedMs, inheritedSourceLabel, formatValue = defaultDurationFormat }: Pick<InheritableDurationFieldProps, 'inheritedMs' | 'inheritedSourceLabel' | 'formatValue'>) => (
  <p className="text-right text-xs text-muted-foreground">
    <span className="font-medium text-foreground">{formatValue(inheritedMs)}</span>
    {inheritedSourceLabel ? ` from ${inheritedSourceLabel}` : ''}
  </p>
)

interface DurationMinutesInputProps {
  inputId: string
  value: number | null
  rawMinutes: string
  minMinutes: number
  maxMinutes: number
  error: string | null
  disabled?: boolean
  describedBy?: string
  commitOnBlur?: boolean
  onRawChange: (raw: string) => void
  commitMinutes: (raw: string) => void
}

const DurationMinutesInput = ({ inputId, value, rawMinutes, minMinutes, maxMinutes, error, disabled, describedBy, commitOnBlur, onRawChange, commitMinutes }: DurationMinutesInputProps) => {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commitMinutes(event.currentTarget.value)
  }
  return (
    <div className="flex items-center gap-1.5">
      <input
        id={inputId}
        type="number"
        inputMode="numeric"
        min={minMinutes}
        max={maxMinutes}
        step={1}
        value={getDurationDisplayValue(value, rawMinutes, disabled)}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        onChange={event => onRawChange(event.target.value)}
        onBlur={commitOnBlur ? event => commitMinutes(event.target.value) : undefined}
        onKeyDown={commitOnBlur ? handleKeyDown : undefined}
        className={getDurationInputClassName(error, disabled)}
      />
      <span className="text-xs text-muted-foreground">minutes</span>
    </div>
  )
}

export const DurationFieldControls = (props: DurationFieldControlsProps) => {
  const { label, idPrefix, value, hint, help, disabledReason, error } = props
  const inputId = `${idPrefix}-minutes`
  const inheriting = value === null
  const describedBy = getDurationDescribedBy(idPrefix, hint, disabledReason, error)
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <DurationFieldLabel label={label} inputId={inputId} idPrefix={idPrefix} inheriting={inheriting} hint={hint} help={help} disabledReason={disabledReason} />
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <DurationSourcePicker {...props} inheriting={inheriting} describedBy={describedBy} />
        {inheriting ? <InheritedDurationValue {...props} /> : <DurationMinutesInput {...props} inputId={inputId} describedBy={describedBy} />}
        {error && <p id={`${idPrefix}-error`} role="alert" className="text-right text-xs text-destructive">{error}</p>}
      </div>
    </div>
  )
}
