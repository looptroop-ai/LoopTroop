import type { CouncilDraftData } from '../phaseArtifactTypes'
import { getCouncilStatusLabel } from '../councilArtifacts'
import { ArtifactListSection } from './MetadataCard'

export function CouncilDraftFailureDiagnostics({ draft }: { draft: CouncilDraftData }) {
  const diagnostics = [
    draft.error,
    draft.structuredOutput?.validationError,
    ...(draft.structuredOutput?.retryDiagnostics ?? []).flatMap((diagnostic) => [
      diagnostic.validationError,
      diagnostic.excerpt ? `Retry ${diagnostic.attempt} excerpt: ${diagnostic.excerpt}` : undefined,
    ]),
  ].filter((message): message is string => typeof message === 'string' && message.trim().length > 0)

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3">
        <div className="text-sm font-semibold">{getCouncilStatusLabel(draft.outcome, 'drafting')}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {draft.outcome === 'timed_out'
            ? 'No accepted draft was received before the timeout.'
            : draft.outcome === 'failed'
              ? 'The draft run failed before producing an accepted artifact.'
              : 'The draft response did not pass strict artifact validation.'}
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
