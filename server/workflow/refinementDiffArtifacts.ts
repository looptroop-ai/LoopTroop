import { resolve } from 'node:path'
import type { UiRefinementDiffArtifact, UiRefinementDiffDomain } from '@shared/refinementDiffArtifacts'
import { safeAtomicWrite } from '../io/atomicWrite'
import { insertPhaseArtifact } from '../storage/tickets'
import type { ArtifactPhase } from '@shared/workflowMeta'

export function buildUiRefinementDiffArtifactType(domain: UiRefinementDiffDomain): string {
  return `ui_refinement_diff:${domain}`
}

export function persistUiRefinementDiffArtifact(
  ticketId: string,
  phase: ArtifactPhase,
  ticketDir: string,
  artifact: UiRefinementDiffArtifact,
) {
  const content = JSON.stringify(artifact)
  insertPhaseArtifact(ticketId, {
    phase,
    artifactType: buildUiRefinementDiffArtifactType(artifact.domain),
    content,
  })
  safeAtomicWrite(
    resolve(ticketDir, 'ui', 'refinement-diffs', `${artifact.domain}.json`),
    JSON.stringify(artifact, null, 2),
  )
}
