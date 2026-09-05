import { eq } from 'drizzle-orm'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { InterviewAnswerUpdate, InterviewDocument } from '@shared/interviewArtifact'
import { phaseArtifacts } from '../../db/schema'
import { safeAtomicWrite } from '../../io/atomicWrite'
import { clearContextCache } from '../../opencode/contextBuilder'
import { clearExecutionSetupState } from '../executionSetup/storage'
import { broadcaster } from '../../sse/broadcaster'
import { getActivePhaseAttempt, getTicketByRef, getTicketContext, getTicketPaths } from '../../storage/tickets'
import { upsertLatestPhaseArtifact } from '../../storage/ticketArtifacts'
import { assertExpectedContentSha256 } from '../../lib/artifactApproval'
import { contentSha256 } from '../../lib/contentHash'
import {
  buildApprovedInterviewDocument,
  buildInterviewDocumentYaml,
  normalizeInterviewDocumentOutput,
  toDraftInterviewDocument,
  updateInterviewDocumentAnswers,
} from '../../structuredOutput'
import { phaseIntermediate } from '../../workflow/phases/state'
import { nowIso } from '../../lib/dateUtils'

const DOWNSTREAM_PHASES = new Set([
  'DRAFTING_PRD',
  'COUNCIL_VOTING_PRD',
  'REFINING_PRD',
  'VERIFYING_PRD_COVERAGE',
  'WAITING_PRD_APPROVAL',
  'DRAFTING_BEADS',
  'COUNCIL_VOTING_BEADS',
  'REFINING_BEADS',
  'VERIFYING_BEADS_COVERAGE',
  'EXPANDING_BEADS',
  'WAITING_BEADS_APPROVAL',
])

const DOWNSTREAM_ARTIFACT_TYPES = new Set([
  'ui_state:approval_prd',
  'ui_state:approval_beads',
])

const INTERVIEW_APPROVAL_SNAPSHOT_ARTIFACT = 'approval_snapshot:interview'

function getInterviewPath(ticketId: string): string {
  const paths = getTicketPaths(ticketId)
  if (!paths) {
    throw new Error('Ticket workspace not initialized')
  }
  return resolve(paths.ticketDir, 'interview.yaml')
}

function readInterviewYaml(ticketId: string): string {
  const interviewPath = getInterviewPath(ticketId)
  if (!existsSync(interviewPath)) {
    throw new Error('Interview artifact not found')
  }
  return readFileSync(interviewPath, 'utf-8')
}

function normalizeInterviewDocumentForTicket(ticketId: string, rawContent: string): InterviewDocument {
  const ticket = getTicketByRef(ticketId)
  if (!ticket) {
    throw new Error('Ticket not found')
  }

  const result = normalizeInterviewDocumentOutput(rawContent, {
    ticketId: ticket.externalId,
  })
  if (!result.ok) {
    throw new Error(result.error)
  }

  return {
    ...result.value,
    ticket_id: ticket.externalId,
    artifact: 'interview',
  }
}

function writeInterviewDocument(
  ticketId: string,
  document: InterviewDocument,
  options?: {
    approvalSnapshotRaw?: string
  },
): string {
  const interviewPath = getInterviewPath(ticketId)
  const nextRaw = buildInterviewDocumentYaml(document)
  safeAtomicWrite(interviewPath, nextRaw)
  const snapshotRaw = options?.approvalSnapshotRaw ?? nextRaw
  upsertLatestPhaseArtifact(
    ticketId,
    INTERVIEW_APPROVAL_SNAPSHOT_ARTIFACT,
    'WAITING_INTERVIEW_APPROVAL',
    JSON.stringify({
      raw: snapshotRaw,
      content_sha256: contentSha256(snapshotRaw),
    }),
  )
  return nextRaw
}

export function buildDraftInterviewDocumentFromRawContent(
  ticketId: string,
  rawContent: string,
): InterviewDocument {
  return toDraftInterviewDocument(normalizeInterviewDocumentForTicket(ticketId, rawContent))
}

export function buildDraftInterviewDocumentFromAnswerUpdates(
  ticketId: string,
  updates: InterviewAnswerUpdate[],
): InterviewDocument {
  const current = readInterviewDocument(ticketId)
  return updateInterviewDocumentAnswers(current.document, updates, nowIso())
}

export function readInterviewDocument(ticketId: string): {
  raw: string
  document: InterviewDocument
} {
  const raw = readInterviewYaml(ticketId)
  return {
    raw,
    document: normalizeInterviewDocumentForTicket(ticketId, raw),
  }
}

export function invalidateDownstreamPlanningArtifacts(ticketId: string): {
  removedArtifacts: number
  removedFiles: string[]
  invalidatedPhases: string[]
} {
  const ticketContext = getTicketContext(ticketId)
  if (!ticketContext) {
    throw new Error('Ticket not found')
  }

  const removedFiles: string[] = []
  const ticketPaths = getTicketPaths(ticketId)
  if (ticketPaths) {
    const prdPath = resolve(ticketPaths.ticketDir, 'prd.yaml')
    const beadsDir = resolve(ticketPaths.ticketDir, 'beads')

    if (existsSync(prdPath)) {
      rmSync(prdPath, { force: true })
      removedFiles.push(prdPath)
    }
    if (existsSync(beadsDir)) {
      rmSync(beadsDir, { recursive: true, force: true })
      removedFiles.push(beadsDir)
    }
  }

  const executionSetupInvalidation = clearExecutionSetupState(ticketId)
  removedFiles.push(...executionSetupInvalidation.removedFiles)

  const artifacts = ticketContext.projectDb
    .select()
    .from(phaseArtifacts)
    .where(eq(phaseArtifacts.ticketId, ticketContext.localTicketId))
    .all()

  let removedArtifacts = 0
  for (const artifact of artifacts) {
    const artifactType = artifact.artifactType ?? ''
    if (!DOWNSTREAM_PHASES.has(artifact.phase) && !DOWNSTREAM_ARTIFACT_TYPES.has(artifactType)) {
      continue
    }
    if (DOWNSTREAM_PHASES.has(artifact.phase)) {
      const activeAttempt = getActivePhaseAttempt(ticketId, artifact.phase)
      if (activeAttempt != null && artifact.phaseAttempt !== activeAttempt) {
        continue
      }
    }
    ticketContext.projectDb
      .delete(phaseArtifacts)
      .where(eq(phaseArtifacts.id, artifact.id))
      .run()
    removedArtifacts += 1
  }

  phaseIntermediate.delete(`${ticketId}:prd`)
  phaseIntermediate.delete(`${ticketId}:beads`)
  clearContextCache(ticketId)

  removedArtifacts += executionSetupInvalidation.removedArtifacts

  if (removedArtifacts > 0 || removedFiles.length > 0) {
    broadcaster.broadcast(ticketId, 'artifact_change', {
      ticketId,
      invalidated: true,
      reason: 'interview_edit',
      removedArtifacts,
      removedFiles,
    })
  }

  return {
    removedArtifacts,
    removedFiles,
    invalidatedPhases: [...DOWNSTREAM_PHASES],
  }
}

export function saveInterviewDocument(
  ticketId: string,
  document: InterviewDocument,
): {
  raw: string
  document: InterviewDocument
  invalidation: { removedArtifacts: number; removedFiles: string[]; invalidatedPhases: string[] }
} {
  const raw = writeInterviewDocument(ticketId, document)
  const invalidation = invalidateDownstreamPlanningArtifacts(ticketId)
  return { raw, document, invalidation }
}

export function saveApprovedInterviewDocument(
  ticketId: string,
  document: InterviewDocument,
): {
  raw: string
  document: InterviewDocument
  invalidation: { removedArtifacts: number; removedFiles: string[]; invalidatedPhases: string[] }
} {
  return saveInterviewDocument(ticketId, buildApprovedInterviewDocument(document, nowIso()))
}

export function approveInterviewDocument(ticketId: string, expectedContentSha256: string): {
  raw: string
  document: InterviewDocument
  contentSha256: string
  storedContentSha256: string
} {
  const current = readInterviewDocument(ticketId)
  const reviewedContentSha256 = assertExpectedContentSha256({
    artifactType: 'interview',
    currentContent: current.raw,
    expectedContentSha256,
  })
  const approvedAt = nowIso()
  const document = buildApprovedInterviewDocument(current.document, approvedAt)
  const raw = writeInterviewDocument(ticketId, document, {
    approvalSnapshotRaw: current.raw,
  })
  const storedContentSha256 = contentSha256(raw)
  upsertLatestPhaseArtifact(
    ticketId,
    'approval_receipt',
    'WAITING_INTERVIEW_APPROVAL',
    JSON.stringify({
      approved_by: 'user',
      approved_at: approvedAt,
      artifact_type: 'interview',
      phase: 'WAITING_INTERVIEW_APPROVAL',
      content_sha256: reviewedContentSha256,
      stored_content_sha256: storedContentSha256,
    }),
  )
  return {
    raw,
    document,
    contentSha256: reviewedContentSha256,
    storedContentSha256,
  }
}
