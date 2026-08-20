import {
  getLatestPhaseArtifact,
  getPhaseArtifactById,
  getTicketByRef,
  upsertLatestPhaseArtifact,
} from '../../storage/tickets'
import { nowIso } from '../../lib/dateUtils'
import { assertExpectedContentSha256 } from '../../lib/artifactApproval'
import { contentSha256 } from '../../lib/contentHash'
import { normalizeExecutionSetupPlanOutput } from '../../structuredOutput'
import type { ExecutionSetupPlan } from './types'
import { lockExecutionSetupPlanDetectedHooks } from './hookEvidence'
import {
  EXECUTION_SETUP_PLAN_ARTIFACT_TYPE,
  EXECUTION_SETUP_PLAN_RESULT_END,
  EXECUTION_SETUP_PLAN_RESULT_MARKER,
  EXECUTION_SETUP_PLAN_NOTES_ARTIFACT_TYPE,
  EXECUTION_SETUP_PLAN_REGENERATION_REQUEST_ARTIFACT_TYPE,
  EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE,
  type ExecutionSetupPlanRegenerationRequest,
  type ExecutionSetupPlanReport,
  parseExecutionSetupPlanNotes,
  serializeExecutionSetupPlan,
  serializeExecutionSetupPlanNotes,
} from './types'

export const EXECUTION_SETUP_PLAN_GENERATION_PHASE = 'GENERATING_EXECUTION_SETUP_PLAN'
export const EXECUTION_SETUP_PLAN_APPROVAL_PHASE = 'WAITING_EXECUTION_SETUP_APPROVAL'

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
  const artifact = getLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PLAN_ARTIFACT_TYPE,
    EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
    phaseAttempt,
  )
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
  const authoritativePlan = lockExecutionSetupPlanDetectedHooks(ticketId, {
    ...plan,
    ticketId: getTicketByRef(ticketId)?.externalId ?? plan.ticketId,
  })
  const raw = serializeExecutionSetupPlan(authoritativePlan)
  const normalized = normalizeStoredExecutionSetupPlanContent(raw, authoritativePlan.ticketId)
  if (!normalized.ok) {
    throw new Error(normalized.error)
  }
  const canonicalRaw = serializeExecutionSetupPlan(normalized.value)
  upsertLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PLAN_ARTIFACT_TYPE,
    EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
    canonicalRaw,
  )
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
  const existing = getLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PLAN_NOTES_ARTIFACT_TYPE,
    EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
  )
  const merged = [
    ...parseExecutionSetupPlanNotes(existing?.content),
    ...notes.filter((note) => note.trim().length > 0),
  ]
  upsertLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PLAN_NOTES_ARTIFACT_TYPE,
    EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
    serializeExecutionSetupPlanNotes(merged),
  )
  return merged
}

export function readExecutionSetupPlanNotes(ticketId: string): string[] {
  const artifact = getLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PLAN_NOTES_ARTIFACT_TYPE,
    EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
  )
  return parseExecutionSetupPlanNotes(artifact?.content)
}

export function writeExecutionSetupPlanReport(ticketId: string, content: string) {
  upsertLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE,
    EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
    content,
  )
}

export function saveGeneratedExecutionSetupPlan(ticketId: string, plan: ExecutionSetupPlan): {
  raw: string
  contentSha256: string
  plan: ExecutionSetupPlan
} {
  const authoritativePlan = lockExecutionSetupPlanDetectedHooks(ticketId, {
    ...plan,
    ticketId: getTicketByRef(ticketId)?.externalId ?? plan.ticketId,
  })
  const raw = serializeExecutionSetupPlan(authoritativePlan)
  const normalized = normalizeStoredExecutionSetupPlanContent(raw, authoritativePlan.ticketId)
  if (!normalized.ok) {
    throw new Error(normalized.error)
  }
  const canonicalRaw = serializeExecutionSetupPlan(normalized.value)
  upsertLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PLAN_ARTIFACT_TYPE,
    EXECUTION_SETUP_PLAN_GENERATION_PHASE,
    canonicalRaw,
  )
  return { raw: canonicalRaw, contentSha256: contentSha256(canonicalRaw), plan: normalized.value }
}

export function writeGeneratedExecutionSetupPlanReport(
  ticketId: string,
  report: ExecutionSetupPlanReport,
) {
  upsertLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE,
    EXECUTION_SETUP_PLAN_GENERATION_PHASE,
    JSON.stringify(report),
  )
}

export function readGeneratedExecutionSetupPlanReport(
  ticketId: string,
): ExecutionSetupPlanReport | null {
  const artifact = getLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PLAN_REPORT_ARTIFACT_TYPE,
    EXECUTION_SETUP_PLAN_GENERATION_PHASE,
  )
  if (!artifact?.content) return null
  try {
    const parsed = JSON.parse(artifact.content) as ExecutionSetupPlanReport
    if (
      (parsed.status !== 'draft' && parsed.status !== 'failed')
      || typeof parsed.ready !== 'boolean'
      || (parsed.source !== 'auto' && parsed.source !== 'regenerate')
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function publishExecutionSetupPlanGeneration(
  ticketId: string,
  report: ExecutionSetupPlanReport,
  notes: string[],
) {
  if (report.plan) {
    saveExecutionSetupPlan(ticketId, report.plan)
  }
  writeExecutionSetupPlanReport(ticketId, JSON.stringify(report))
  upsertLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PLAN_NOTES_ARTIFACT_TYPE,
    EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
    serializeExecutionSetupPlanNotes(notes),
  )
}

export function writeExecutionSetupPlanRegenerationRequest(
  ticketId: string,
  input: {
    commentary: string
    currentPlan: ExecutionSetupPlan | null
    notes: string[]
  },
): number {
  const request: ExecutionSetupPlanRegenerationRequest = {
    commentary: input.commentary,
    currentPlanRaw: input.currentPlan ? serializeExecutionSetupPlan(input.currentPlan) : null,
    notes: input.notes,
    createdAt: nowIso(),
  }
  upsertLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PLAN_REGENERATION_REQUEST_ARTIFACT_TYPE,
    EXECUTION_SETUP_PLAN_GENERATION_PHASE,
    JSON.stringify(request),
  )
  const artifact = getLatestPhaseArtifact(
    ticketId,
    EXECUTION_SETUP_PLAN_REGENERATION_REQUEST_ARTIFACT_TYPE,
    EXECUTION_SETUP_PLAN_GENERATION_PHASE,
  )
  if (!artifact) {
    throw new Error('Failed to persist execution setup plan regeneration request')
  }
  return artifact.id
}

export function readExecutionSetupPlanRegenerationRequest(
  ticketId: string,
  artifactId: number,
): {
  commentary: string
  currentPlan: ExecutionSetupPlan | null
  notes: string[]
} {
  const artifact = getPhaseArtifactById(ticketId, artifactId)
  if (
    !artifact
    || artifact.phase !== EXECUTION_SETUP_PLAN_GENERATION_PHASE
    || artifact.artifactType !== EXECUTION_SETUP_PLAN_REGENERATION_REQUEST_ARTIFACT_TYPE
  ) {
    throw new Error('Execution setup plan regeneration request is unavailable')
  }
  const parsed = JSON.parse(artifact.content) as Partial<ExecutionSetupPlanRegenerationRequest>
  if (typeof parsed.commentary !== 'string' || parsed.commentary.trim().length === 0) {
    throw new Error('Execution setup plan regeneration request commentary is invalid')
  }

  let currentPlan: ExecutionSetupPlan | null = null
  if (typeof parsed.currentPlanRaw === 'string') {
    const normalized = normalizeStoredExecutionSetupPlanContent(
      parsed.currentPlanRaw,
      getTicketByRef(ticketId)?.externalId,
    )
    if (!normalized.ok) throw new Error(normalized.error)
    currentPlan = normalized.value
  }

  return {
    commentary: parsed.commentary,
    currentPlan,
    notes: Array.isArray(parsed.notes)
      ? parsed.notes.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [],
  }
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
  upsertLatestPhaseArtifact(ticketId, 'approval_receipt', EXECUTION_SETUP_PLAN_APPROVAL_PHASE, JSON.stringify({
    approved_by: 'user',
    approved_at: approvedAt,
    artifact_type: 'execution_setup_plan',
    phase: EXECUTION_SETUP_PLAN_APPROVAL_PHASE,
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
