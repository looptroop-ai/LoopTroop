import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const MS_PER_MINUTE = 60_000

const formatMinutes = (minutes: number) => `${minutes} minute${minutes === 1 ? '' : 's'}`

export const defaultDurationFormat = (ms: number): string => formatMinutes(Math.round(ms / MS_PER_MINUTE))

export const toDurationMinutesText = (ms: number | null): string => ms === null ? '' : String(ms / MS_PER_MINUTE)

export const clampDurationToRange = (ms: number, minMs: number, maxMs: number): number => Math.min(maxMs, Math.max(minMs, Math.round(ms / MS_PER_MINUTE) * MS_PER_MINUTE))

export const validateDurationMinutes = (raw: string, minMinutes: number, maxMinutes: number): string | null => {
  if (raw.trim() === '') return `Enter a number of minutes (${minMinutes} to ${maxMinutes}).`
  const minutes = Number(raw)
  if (!Number.isInteger(minutes)) return `Use whole minutes (${minMinutes} to ${maxMinutes}).`
  if (minutes < minMinutes) return `Minimum is ${formatMinutes(minMinutes)}.`
  if (minutes > maxMinutes) return `Maximum is ${maxMinutes} minutes.`
  return null
}

export const getDurationFieldError = (raw: string, minMinutes: number, maxMinutes: number, inheriting: boolean, disabled?: boolean): string | null => {
  if (inheriting || disabled) return null
  return validateDurationMinutes(raw, minMinutes, maxMinutes)
}

export const getDurationDescribedBy = (idPrefix: string, hint: ReactNode, disabledReason: string | undefined, error: string | null): string | undefined => [
  hint ? `${idPrefix}-hint` : null,
  disabledReason ? `${idPrefix}-disabled-reason` : null,
  error ? `${idPrefix}-error` : null,
].filter(Boolean).join(' ') || undefined

export const getDurationDisplayValue = (value: number | null, rawMinutes: string, disabled?: boolean): string => disabled && value !== null ? toDurationMinutesText(value) : rawMinutes

export const getDurationInputClassName = (error: string | null, disabled?: boolean): string => cn(
  'w-20 rounded-md border bg-background px-2 py-1 text-sm',
  error ? 'border-destructive' : 'border-input',
  disabled && 'cursor-not-allowed opacity-60',
)
