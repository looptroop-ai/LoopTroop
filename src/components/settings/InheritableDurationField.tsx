import { useEffect, useRef, useState } from 'react'
import { DurationFieldControls, type InheritableDurationFieldProps } from './DurationFieldControls'
import { MS_PER_MINUTE, clampDurationToRange, getDurationFieldError, toDurationMinutesText, validateDurationMinutes } from './durationFieldUtils'

export const InheritableDurationField = (props: InheritableDurationFieldProps) => {
  const { value, onChange, minMs, maxMs, disabled, onValidationChange } = props
  const minMinutes = Math.round(minMs / MS_PER_MINUTE)
  const maxMinutes = Math.round(maxMs / MS_PER_MINUTE)

  // Keep unfinished text locally until a valid edit is committed.
  const [rawMinutes, setRawMinutes] = useState(() => toDurationMinutesText(value))
  const [syncedValue, setSyncedValue] = useState<number | null>(value)
  const [hasPendingEdit, setHasPendingEdit] = useState(false)
  const pendingEditRef = useRef(false)
  const flushPendingRef = useRef(() => {})
  const isInheriting = value === null && (!hasPendingEdit || disabled === true)

  if (value !== syncedValue) {
    setSyncedValue(value)
    if (!hasPendingEdit) setRawMinutes(toDurationMinutesText(value))
  }

  const emit = (next: number | null) => {
    setSyncedValue(next)
    onChange(next)
  }

  const error = getDurationFieldError(rawMinutes, minMinutes, maxMinutes, isInheriting, disabled)
  useEffect(() => {
    onValidationChange?.(error !== null)
    return () => onValidationChange?.(false)
  }, [error, onValidationChange])

  const commitMinutes = (raw: string) => {
    if (disabled || validateDurationMinutes(raw, minMinutes, maxMinutes)) return
    const next = Number(raw) * MS_PER_MINUTE
    pendingEditRef.current = false
    setHasPendingEdit(false)
    if (next !== syncedValue) emit(next)
  }

  const handleRawChange = (raw: string) => {
    setRawMinutes(raw)
    if (!props.commitOnBlur) {
      commitMinutes(raw)
      return
    }
    pendingEditRef.current = true
    setHasPendingEdit(true)
    flushPendingRef.current = () => {
      if (pendingEditRef.current) commitMinutes(raw)
    }
  }

  const handleModeChange = (inheriting: boolean) => {
    if (inheriting === isInheriting) return
    pendingEditRef.current = false
    setHasPendingEdit(false)
    // Seed Custom from the effective wait and synchronize before emitting.
    const next = inheriting ? null : clampDurationToRange(props.inheritedMs, minMs, maxMs)
    setRawMinutes(toDurationMinutesText(next))
    emit(next)
  }

  useEffect(() => {
    flushPendingRef.current = () => {
      if (props.commitOnBlur && pendingEditRef.current) commitMinutes(rawMinutes)
    }
  })
  useEffect(() => () => flushPendingRef.current(), [])

  return (
    <DurationFieldControls
      {...props}
      inheriting={isInheriting}
      rawMinutes={rawMinutes}
      error={error}
      minMinutes={minMinutes}
      maxMinutes={maxMinutes}
      onModeChange={handleModeChange}
      onRawChange={handleRawChange}
      commitMinutes={commitMinutes}
    />
  )
}
