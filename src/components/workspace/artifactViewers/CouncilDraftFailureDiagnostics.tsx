import { cn } from '@/lib/utils'
import type { CouncilDraftData, CouncilOutcome } from '../phaseArtifactTypes'
import { getCouncilStatusLabel } from '../councilArtifacts'
import { isFailedCouncilOutcome } from '../artifactCompanionUtils'
import { ArtifactListSection } from './MetadataCard'

const FAILURE_SUMMARY: Record<Exclude<CouncilOutcome, 'pending' | 'completed'>, string> = {
  timed_out: 'No accepted draft was received before the timeout.',
  failed: 'The draft run failed before producing an accepted artifact.',
  invalid_output: 'The draft response did not pass strict artifact validation.',
  stopped: 'You stopped this model before it returned a usable draft.',
}

export function CouncilDraftFailureDiagnostics({ draft }: { draft: CouncilDraftData }) {
  const stopped = draft.outcome === 'stopped'
  const diagnostics = [
    // A stopped draft's error is only "Stopped by you", which the summary already says.
    stopped ? undefined : draft.error,
    draft.structuredOutput?.validationError,
    ...(draft.structuredOutput?.retryDiagnostics ?? []).flatMap((diagnostic) => [
      diagnostic.validationError,
      diagnostic.excerpt ? `Retry ${diagnostic.attempt} excerpt: ${diagnostic.excerpt}` : undefined,
    ]),
  ].filter((message): message is string => typeof message === 'string' && message.trim().length > 0)

  return (
    <div className="space-y-3">
      <div className={cn(
        'rounded-md border px-3 py-3',
        stopped ? 'border-border bg-muted/40' : 'border-destructive/30 bg-destructive/5',
      )}>
        <div className="text-sm font-semibold">{getCouncilStatusLabel(draft.outcome, 'drafting')}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {isFailedCouncilOutcome(draft.outcome) ? FAILURE_SUMMARY[draft.outcome] : FAILURE_SUMMARY.invalid_output}
        </div>
      </div>
      {diagnostics.length > 0 ? (
        <ArtifactListSection
          title="Diagnostics"
          items={diagnostics}
          emptyLabel="No validation diagnostics were recorded."
          tone="error"
        />
      ) : null}
    </div>
  )
}
