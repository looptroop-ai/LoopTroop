import type { DBartifact } from '@/hooks/useTicketArtifacts'
import {
  buildUiArtifactCompanionArtifactType,
  parseUiArtifactCompanionArtifact,
} from '@shared/artifactCompanions'
import { isRecord } from '@shared/typeGuards'

type ArtifactSource = Pick<DBartifact, 'phase' | 'artifactType' | 'content'>

function parseArtifactRecord(content: string | null | undefined): Record<string, unknown> | null {
  if (!content?.trim()) return null
  try {
    const parsed = JSON.parse(content) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeDraftRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function normalizeDraftList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map((entry) => normalizeDraftRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : []
}

function normalizeMemberOutcomes(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'),
  )
}

function isFailedCouncilOutcome(value: unknown): boolean {
  return value === 'invalid_output' || value === 'failed' || value === 'timed_out'
}

function suppressFailedDraftBody<T extends Record<string, unknown>>(draft: T): T {
  if (!isFailedCouncilOutcome(draft.outcome) || !('content' in draft)) return draft
  const rest = { ...draft }
  delete rest.content
  return rest as T
}

function suppressFailedDraftBodies(drafts: Record<string, unknown>[]): Record<string, unknown>[] {
  return drafts.map((draft) => suppressFailedDraftBody(draft))
}

export function findLatestArtifact(
  artifacts: ArtifactSource[],
  predicate: (artifact: ArtifactSource) => boolean,
): ArtifactSource | undefined {
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index]
    if (artifact && predicate(artifact)) return artifact
  }
  return undefined
}

export function findLatestArtifactByType(
  artifacts: ArtifactSource[],
  artifactType: string,
  targetPhases?: string[],
): ArtifactSource | undefined {
  return findLatestArtifact(
    artifacts,
    (artifact) => artifact.artifactType === artifactType && (!targetPhases || targetPhases.includes(artifact.phase)),
  )
}

export function findLatestCompanionArtifact(
  artifacts: ArtifactSource[],
  baseArtifactType: string,
  targetPhases?: string[],
): ArtifactSource | undefined {
  return findLatestArtifactByType(
    artifacts,
    buildUiArtifactCompanionArtifactType(baseArtifactType),
    targetPhases,
  )
}

export function parseArtifactCompanionPayload(
  content: string | null | undefined,
  expectedBaseArtifactType?: string,
): Record<string, unknown> | null {
  if (!content?.trim()) return null
  const parsed = parseUiArtifactCompanionArtifact(content)
  if (!parsed) return null
  if (expectedBaseArtifactType && parsed.baseArtifactType !== expectedBaseArtifactType) return null
  return parsed.payload
}

export function unwrapArtifactCompanionPayloadContent(
  content: string | null | undefined,
  expectedBaseArtifactType?: string,
): string | null {
  const payload = parseArtifactCompanionPayload(content, expectedBaseArtifactType)
  return payload ? JSON.stringify(payload) : null
}

export function mergeDraftArtifactContent(
  coreContent: string | null | undefined,
  companionContent?: string | null | undefined,
): string | null {
  if (!coreContent?.trim()) return null

  const core = parseArtifactRecord(coreContent)
  if (!core) return coreContent

  const companion = parseArtifactCompanionPayload(companionContent)
  if (!companion) return coreContent

  const drafts = normalizeDraftList(core.drafts)
  const draftDetails = normalizeDraftList(companion.draftDetails)
  const detailByMember = new Map<string, Record<string, unknown>>(
    draftDetails
      .map((detail) => [typeof detail.memberId === 'string' ? detail.memberId : '', detail] as const)
      .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[0])),
  )

  const orderedMemberIds = [
    ...drafts.map((draft) => (typeof draft.memberId === 'string' ? draft.memberId : '')).filter(Boolean),
    ...draftDetails.map((detail) => (typeof detail.memberId === 'string' ? detail.memberId : '')).filter(Boolean),
  ].filter((memberId, index, values) => values.indexOf(memberId) === index)

  const mergedDrafts = orderedMemberIds.map((memberId) => {
    const draft = drafts.find((entry) => entry.memberId === memberId) ?? {}
    const detail = detailByMember.get(memberId) ?? {}
    return suppressFailedDraftBody({
      ...detail,
      ...draft,
      memberId,
      outcome: typeof draft.outcome === 'string'
        ? draft.outcome
        : typeof detail.outcome === 'string'
          ? detail.outcome
          : undefined,
    })
  })

  return JSON.stringify({
    ...core,
    drafts: mergedDrafts,
  })
}

export function mergeVoteArtifactContent(
  voteContent: string | null | undefined,
  voteCompanionContent?: string | null | undefined,
  draftContent?: string | null | undefined,
): string | null {
  if (!voteContent?.trim()) return null

  const core = parseArtifactRecord(voteContent)
  if (!core) return voteContent

  const companion = parseArtifactCompanionPayload(voteCompanionContent)
  const mergedDraftArtifact = mergeDraftArtifactContent(draftContent)
  const draftRecord = mergedDraftArtifact ? parseArtifactRecord(mergedDraftArtifact) : null

  if (!companion && !draftRecord) return voteContent

  const resolvedDrafts = suppressFailedDraftBodies(normalizeDraftList(draftRecord?.drafts ?? companion?.drafts ?? core.drafts))
  const resolvedMemberOutcomes = normalizeMemberOutcomes(
    draftRecord?.memberOutcomes ?? core.memberOutcomes,
  )
  const resolvedVoterOutcomes = normalizeMemberOutcomes(companion?.voterOutcomes ?? core.voterOutcomes)
  const resolvedPresentationOrders = isRecord(companion?.presentationOrders)
    ? companion.presentationOrders
    : isRecord(core.presentationOrders)
      ? core.presentationOrders
      : undefined
  const resolvedVotes = Array.isArray(companion?.votes)
    ? companion.votes
    : Array.isArray(core.votes)
      ? core.votes
      : undefined
  const resolvedVoterDetails = Array.isArray(companion?.voterDetails)
    ? companion.voterDetails
    : Array.isArray(core.voterDetails)
      ? core.voterDetails
      : undefined

  return JSON.stringify({
    ...core,
    ...(resolvedDrafts.length > 0 ? { drafts: resolvedDrafts } : {}),
    ...(resolvedVotes ? { votes: resolvedVotes } : {}),
    ...(resolvedMemberOutcomes ? { memberOutcomes: resolvedMemberOutcomes } : {}),
    ...(resolvedVoterOutcomes ? { voterOutcomes: resolvedVoterOutcomes } : {}),
    ...(resolvedVoterDetails ? { voterDetails: resolvedVoterDetails } : {}),
    ...(resolvedPresentationOrders ? { presentationOrders: resolvedPresentationOrders } : {}),
    ...(typeof companion?.winnerId === 'string' && companion.winnerId.trim()
      ? { winnerId: companion.winnerId }
      : {}),
    ...(typeof companion?.totalScore === 'number' ? { totalScore: companion.totalScore } : {}),
  })
}

export function mergeCoverageArtifactContent(
  coverageContent: string | null | undefined,
  companionContent?: string | null | undefined,
): string | null {
  if (!coverageContent?.trim()) return null

  const core = parseArtifactRecord(coverageContent)
  if (!core) return coverageContent

  const companion = parseArtifactCompanionPayload(companionContent)
  if (!companion) return coverageContent

  return JSON.stringify({
    ...core,
    ...companion,
  })
}

/**
 * Folds the Manual QA checklist's processing metadata into its artifact.
 *
 * Generation records its repair trail in a companion row, the way every other
 * artifact-processing path does — and the checklist view read only the
 * checklist, so an operator saw the result and never learned a repair had
 * happened. Merging here keeps the viewer reading one string.
 *
 * The metadata is returned on its own when there is no checklist: generation
 * that gave up writes the companion and no artifact, which is the case an
 * operator most needs to see.
 */
export function mergeManualQaChecklistArtifactContent(
  checklistContent: string | null | undefined,
  companionContent?: string | null | undefined,
): string | null {
  const companion = parseArtifactCompanionPayload(companionContent, 'manual_qa_checklist')
  const metadata: Record<string, unknown> = {}
  if (companion?.structuredOutput !== undefined) metadata.structuredOutput = companion.structuredOutput
  if (typeof companion?.validationError === 'string') metadata.validationError = companion.validationError
  const hasMetadata = Object.keys(metadata).length > 0

  if (!checklistContent?.trim()) return hasMetadata ? JSON.stringify(metadata) : null
  if (!hasMetadata) return checklistContent

  const core = parseArtifactRecord(checklistContent)
  // The artifact is normally the `{ version, checklist }` envelope, but it can
  // also be the canonical YAML document. Wrapping rather than rewriting keeps
  // the viewer's existing unwrap working on both.
  return JSON.stringify(core ? { ...core, ...metadata } : { checklist: checklistContent, ...metadata })
}

export function readWinnerIdFromArtifactContent(content: string | null | undefined): string | undefined {
  const parsed = parseArtifactRecord(content)
  const winnerId = typeof parsed?.winnerId === 'string' ? parsed.winnerId.trim() : ''
  return winnerId || undefined
}
