import {
  buildUiArtifactCompanionArtifactType,
  buildUiArtifactCompanionArtifact,
  type UiArtifactCompanionArtifact,
} from '@shared/artifactCompanions'
import { getTicketPaths, upsertLatestPhaseArtifact, writeTicketFile } from '../storage/tickets'
import type { ArtifactPhase } from '@shared/workflowMeta'

function buildCompanionMirrorFileName(baseArtifactType: string): string {
  return `${baseArtifactType.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`
}

export function persistUiArtifactCompanionArtifact(
  ticketId: string,
  phase: ArtifactPhase,
  baseArtifactType: string,
  payload: Record<string, unknown>,
): UiArtifactCompanionArtifact<Record<string, unknown>> {
  const artifact = buildUiArtifactCompanionArtifact(baseArtifactType, payload)
  const content = JSON.stringify(artifact)

  upsertLatestPhaseArtifact(
    ticketId,
    buildUiArtifactCompanionArtifactType(baseArtifactType),
    phase,
    content,
  )

  const paths = getTicketPaths(ticketId)
  if (paths?.ticketDir) {
    writeTicketFile(
      ticketId,
      `ui/artifact-companions/${buildCompanionMirrorFileName(baseArtifactType)}`,
      JSON.stringify(artifact, null, 2),
    )
  }

  return artifact
}
