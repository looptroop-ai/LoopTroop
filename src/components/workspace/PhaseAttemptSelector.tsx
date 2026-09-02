import type { TicketPhaseAttempt } from '@/hooks/useTicketPhaseAttempts'
import { QueryErrorNotice } from '@/components/shared/QueryErrorNotice'

interface PhaseAttemptSelectorProps {
  attempts: TicketPhaseAttempt[]
  value: number
  onChange: (attemptNumber: number) => void
  className?: string
}

function buildAttemptLabel(attempt: TicketPhaseAttempt): string {
  if (attempt.state === 'active') {
    return `Current version (${attempt.attemptNumber})`
  }
  return `Archived version ${attempt.attemptNumber}`
}

export function PhaseAttemptSelector({
  attempts,
  value,
  onChange,
  className,
}: PhaseAttemptSelectorProps) {
  if (attempts.length <= 1) return null

  return (
    <label className={className ?? 'flex items-center gap-2 text-xs text-muted-foreground'}>
      <span className="shrink-0 font-medium uppercase tracking-wider">Version</span>
      <select
        className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
        value={String(value)}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {attempts.map((attempt) => (
          <option key={`${attempt.phase}:${attempt.attemptNumber}`} value={attempt.attemptNumber}>
            {buildAttemptLabel(attempt)}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * What the selector's slot shows when the attempt list could not be loaded.
 *
 * A failed request used to render as "one attempt", which hides the selector and
 * silently scopes artifacts and logs to the live attempt — the wrong version,
 * with nothing saying so. One sentence, in one place, for every surface that
 * offers the selector.
 */
export function PhaseAttemptsUnavailable({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  return (
    <QueryErrorNotice
      title="The version history for this phase could not be loaded."
      error={error}
      onRetry={onRetry}
    />
  )
}
