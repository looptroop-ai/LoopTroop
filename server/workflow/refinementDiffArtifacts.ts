import type { UiRefinementDiffArtifact, UiRefinementDiffDomain } from '@shared/refinementDiffArtifacts'
import { insertPhaseArtifact, writeTicketFile } from '../storage/tickets'
import type { ArtifactPhase } from '@shared/workflowMeta'

export function buildUiRefinementDiffArtifactType(domain: UiRefinementDiffDomain): string {
  return `ui_refinement_diff:${domain}`
}

export function persistUiRefinementDiffArtifact(
  ticketId: string,
  phase: ArtifactPhase,
  _ticketDir: string,
  artifact: UiRefinementDiffArtifact,
) {
  const content = JSON.stringify(artifact)
  insertPhaseArtifact(ticketId, {
    phase,
    artifactType: buildUiRefinementDiffArtifactType(artifact.domain),
    content,
  })
  writeTicketFile(
    ticketId,
    `ui/refinement-diffs/${artifact.domain}.json`,
    JSON.stringify(artifact, null, 2),
  )
}
