import { getLatestPhaseArtifact, getTicketByRef, upsertLatestPhaseArtifact } from '../../storage/tickets'
import { nowIso } from '../../lib/dateUtils'
import { assertExpectedContentSha256 } from '../../lib/artifactApproval'
import { contentSha256 } from '../../lib/contentHash'
import { normalizeExecutionSetupPlanOutput } from '../../structuredOutput'
import type { ExecutionSetupPlan } from './types'
import {
  EXECUTION_SETUP_PLAN_ARTIFACT_TYPE,
  EXECUTION_SETUP_PLAN_RESULT_END,
  EXECUTION_SETUP_PLAN_RESULT_MARKER,
  EXECUTION_SETUP_PLAN_NOTES_ARTIFACT_TYPE,
  EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE,
  parseExecutionSetupPlanNotes,
  serializeExecutionSetupPlan,
  serializeExecutionSetupPlanNotes,
} from './types'

const EXECUTION_SETUP_PLAN_PHASE = 'WAITING_EXECUTION_SETUP_APPROVAL'

function normalizeStoredExecutionSetupPlanContent(
  rawContent: string,
  authoritativeTicketId?: string,
) {
  const content = rawContent.includes(EXECUTION_SETUP_PLAN_RESULT_MARKER)
    ? rawContent
    : `${EXECUTION_SETUP_PLAN_RESULT_MARKER}\n${rawContent}\n${EXECUTION_SETUP_PLAN_RESULT_END}`
  return normalizeExecutionSetupPlanOutput(content, {
    preserveBackendFields: true,
    ...(authoritativeTicketId ? { authoritativeTicketId } : {}),
  })
}

export function readExecutionSetupPlan(ticketId: string, phaseAttempt?: number): {
  artifactId: number | null
  raw: string | null
  contentSha256: string | null
  plan: ExecutionSetupPlan | null
  updatedAt: string | null
} {
  const artifact = getLatestPhaseArtifact(ticketId, EXECUTION_SETUP_PLAN_ARTIFACT_TYPE, EXECUTION_SETUP_PLAN_PHASE, phaseAttempt)
  if (!artifact?.content) {
    return {
      artifactId: null,
      raw: null,
      contentSha256: null,
      plan: null,
      updatedAt: null,
    }
  }

  const authoritativeTicketId = getTicketByRef(ticketId)?.externalId
  const normalized = normalizeStoredExecutionSetupPlanContent(
    artifact.content,
    authoritativeTicketId,
  )
  if (!normalized.ok) {
    throw new Error(normalized.error)
  }

  return {
    artifactId: artifact.id,
    raw: artifact.content,
    contentSha256: contentSha256(artifact.content),
    plan: normalized.value,
    updatedAt: artifact.createdAt,
  }
}

export function saveExecutionSetupPlan(ticketId: string, plan: ExecutionSetupPlan): {
  raw: string
  contentSha256: string
  plan: ExecutionSetupPlan
} {
  const raw = serializeExecutionSetupPlan(plan)
  const normalized = normalizeStoredExecutionSetupPlanContent(raw, plan.ticketId)
  if (!normalized.ok) {
    throw new Error(normalized.error)
  }
  const canonicalRaw = serializeExecutionSetupPlan(normalized.value)
  upsertLatestPhaseArtifact(ticketId, EXECUTION_SETUP_PLAN_ARTIFACT_TYPE, EXECUTION_SETUP_PLAN_PHASE, canonicalRaw)
  return { raw: canonicalRaw, contentSha256: contentSha256(canonicalRaw), plan: normalized.value }
}

export function saveExecutionSetupPlanRawContent(ticketId: string, rawContent: string): {
  raw: string
  contentSha256: string
  plan: ExecutionSetupPlan
} {
  const normalized = normalizeStoredExecutionSetupPlanContent(
    rawContent,
    getTicketByRef(ticketId)?.externalId,
  )
  if (!normalized.ok) {
    throw new Error(normalized.error)
  }

  return saveExecutionSetupPlan(ticketId, normalized.value)
}

export function appendExecutionSetupPlanNotes(ticketId: string, notes: string[]): string[] {
  const existing = getLatestPhaseArtifact(ticketId, EXECUTION_SETUP_PLAN_NOTES_ARTIFACT_TYPE, EXECUTION_SETUP_PLAN_PHASE)
  const merged = [
    ...parseExecutionSetupPlanNotes(existing?.content),
    ...notes.filter((note) => note.trim().length > 0),
  ]
  upsertLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PLAN_NOTES_ARTIFACT_TYPE,
    EXECUTION_SETUP_PLAN_PHASE,
    serializeExecutionSetupPlanNotes(merged),
  )
  return merged
}

export function readExecutionSetupPlanNotes(ticketId: string): string[] {
  const artifact = getLatestPhaseArtifact(ticketId, EXECUTION_SETUP_PLAN_NOTES_ARTIFACT_TYPE, EXECUTION_SETUP_PLAN_PHASE)
  return parseExecutionSetupPlanNotes(artifact?.content)
}

export function writeExecutionSetupPlanReport(ticketId: string, content: string) {
  upsertLatestPhaseArtifact(ticketId, EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE, EXECUTION_SETUP_PLAN_PHASE, content)
}

export function approveExecutionSetupPlan(
  ticketId: string,
  plan: ExecutionSetupPlan,
  raw: string,
  expectedContentSha256: string,
): {
  approvedAt: string
  stepCount: number
  commandCount: number
  workspaceInputCount: number
  contentSha256: string
} {
  const reviewedContentSha256 = assertExpectedContentSha256({
    artifactType: 'execution_setup_plan',
    currentContent: raw,
    expectedContentSha256,
  })
  const approvedAt = nowIso()
  const commandCount = plan.steps.reduce((sum, step) => sum + step.commands.length, 0)
  upsertLatestPhaseArtifact(ticketId, 'approval_receipt', EXECUTION_SETUP_PLAN_PHASE, JSON.stringify({
    approved_by: 'user',
    approved_at: approvedAt,
    artifact_type: 'execution_setup_plan',
    phase: EXECUTION_SETUP_PLAN_PHASE,
    step_count: plan.steps.length,
    command_count: commandCount,
    workspace_input_count: plan.workspaceInputs.length,
    workspace_input_paths: plan.workspaceInputs.map((input) => input.path),
    content_sha256: reviewedContentSha256,
  }))
  return {
    approvedAt,
    stepCount: plan.steps.length,
    commandCount,
    workspaceInputCount: plan.workspaceInputs.length,
    contentSha256: reviewedContentSha256,
  }
}
